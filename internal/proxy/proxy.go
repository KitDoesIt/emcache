package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"emby-proxy-cache/internal/interceptor"
	"emby-proxy-cache/internal/upstream"
)

const (
	copyBufferSize = 64 * 1024
	flushBytes     = 1024 * 1024
	flushInterval  = 250 * time.Millisecond
	writeStall     = 3 * time.Second
)

type Proxy struct {
	upstream     *url.URL
	client       *http.Client
	interceptors []interceptor.Interceptor
}

func New(upstreamURL *url.URL, interceptors []interceptor.Interceptor) *Proxy {
	return NewWithClient(upstreamURL, upstream.NewClient(), interceptors)
}

func NewWithClient(upstreamURL *url.URL, client *http.Client, interceptors []interceptor.Interceptor) *Proxy {
	if client == nil {
		client = upstream.NewClient()
	}
	return &Proxy{
		upstream:     upstreamURL,
		client:       client,
		interceptors: interceptors,
	}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
		return
	}

	upstreamURL := p.buildUpstreamURL(r.URL)
	ctx := &interceptor.Context{
		Request:     r,
		UpstreamURL: upstreamURL.String(),
	}

	response, handled, err := interceptor.RunRequest(p.interceptors, ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if !handled {
		request := ctx.Request
		upstreamURL = p.buildUpstreamURL(request.URL)
		ctx.UpstreamURL = upstreamURL.String()
		response, err = p.forward(request, upstreamURL)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return
			}
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	if response == nil {
		http.Error(w, "interceptor returned nil response", http.StatusBadGateway)
		return
	}

	response, err = interceptor.RunResponse(p.interceptors, ctx, response)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if response == nil {
		http.Error(w, "interceptor returned nil response", http.StatusBadGateway)
		return
	}
	if response.Body != nil {
		defer response.Body.Close()
	}

	p.writeResponse(w, r, response)
}

func (p *Proxy) buildUpstreamURL(requestURL *url.URL) *url.URL {
	upstreamURL := *p.upstream
	upstreamURL.Path = joinPath(p.upstream.Path, requestURL.Path)
	upstreamURL.RawPath = ""
	upstreamURL.RawQuery = requestURL.RawQuery
	upstreamURL.Fragment = ""
	return &upstreamURL
}

func (p *Proxy) forward(r *http.Request, upstreamURL *url.URL) (*http.Response, error) {
	request, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL.String(), r.Body)
	if err != nil {
		return nil, err
	}
	copyRequestHeaders(request.Header, r.Header)
	request.Host = upstreamURL.Host
	request.ContentLength = r.ContentLength
	return p.client.Do(request)
}

func (p *Proxy) writeResponse(w http.ResponseWriter, r *http.Request, response *http.Response) {
	copyResponseHeaders(w.Header(), response.Header)
	w.WriteHeader(response.StatusCode)

	if response.Body == nil {
		return
	}

	buf := make([]byte, copyBufferSize)
	started := time.Now()
	lastLog := int64(0)
	nextLog := int64(16 * 1024 * 1024)
	isStream := isStreamResponse(response)
	counter := newCountingWriter(w, r.URL.Path, isStream)

	reader := &progressReader{
		reader: response.Body,
		onProgress: func(total int64) {
			if isStream && total >= nextLog {
				interceptor.LogStreamProgress(r.URL.Path, total, counter.written, 0, started)
				lastLog = total
				nextLog += 32 * 1024 * 1024
			}
		},
	}

	_, err := io.CopyBuffer(counter, reader, buf)
	counter.Flush()
	if err != nil && !isClientGone(err) && !errors.Is(r.Context().Err(), context.Canceled) {
		fmt.Printf("[HTTP] stream error %s after=%dB: %v\n", r.URL.Path, counter.written, err)
	}

	if isStream {
		fmt.Printf(
			"[HTTP] stream done %s pushed=%dB wrote=%dB in %.2fs%s\n",
			r.URL.Path,
			reader.total,
			counter.written,
			time.Since(started).Seconds(),
			finishNote(r.Context().Err(), lastLog),
		)
	}
}

func copyRequestHeaders(dst, src http.Header) {
	for key, values := range src {
		if isHopHeader(key) {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		if isHopHeader(key) {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func isHopHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "transfer-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade":
		return true
	default:
		return false
	}
}

func joinPath(base, path string) string {
	if base == "" || base == "/" {
		return path
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

type countingWriter struct {
	writer    io.Writer
	flusher   http.Flusher
	path      string
	isStream  bool
	written   int64
	unflushed int64
	lastFlush time.Time
}

func newCountingWriter(writer io.Writer, path string, isStream bool) *countingWriter {
	flusher, _ := writer.(http.Flusher)
	return &countingWriter{writer: writer, flusher: flusher, path: path, isStream: isStream, lastFlush: time.Now()}
}

func (w *countingWriter) Write(p []byte) (int, error) {
	started := time.Now()
	var stalled atomic.Bool
	timer := time.AfterFunc(writeStall, func() {
		stalled.Store(true)
		if w.isStream {
			fmt.Printf("[HTTP] stream write stalled %s wrote=%dB pending=%dB stall=%s\n", w.path, w.written, len(p), writeStall)
		}
	})
	n, err := w.writer.Write(p)
	if !timer.Stop() && stalled.Load() && w.isStream {
		fmt.Printf("[HTTP] stream write resumed %s wrote=%dB after=%s err=%v\n", w.path, w.written+int64(n), time.Since(started).Round(time.Millisecond), err)
	}
	w.written += int64(n)
	w.unflushed += int64(n)
	if w.flusher != nil && (w.unflushed >= flushBytes || time.Since(w.lastFlush) >= flushInterval) {
		w.Flush()
	}
	return n, err
}

func (w *countingWriter) Flush() {
	if w.flusher == nil || w.unflushed == 0 {
		return
	}
	w.flusher.Flush()
	w.unflushed = 0
	w.lastFlush = time.Now()
}

type progressReader struct {
	reader     io.Reader
	total      int64
	onProgress func(int64)
}

func (r *progressReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 {
		r.total += int64(n)
		r.onProgress(r.total)
	}
	return n, err
}

func isStreamResponse(response *http.Response) bool {
	contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
	contentType, _, _ = strings.Cut(contentType, ";")
	return strings.HasPrefix(contentType, "video/") ||
		contentType == "application/octet-stream"
}

func isClientGone(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "broken pipe") ||
		strings.Contains(message, "connection reset by peer") ||
		strings.Contains(message, "client disconnected")
}

func finishNote(err error, lastLog int64) string {
	if err == nil {
		return ""
	}
	return " canceled"
}
