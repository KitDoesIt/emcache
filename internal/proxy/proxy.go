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
	"time"

	"encache/internal/interceptor"
	"encache/internal/upstream"
)

const (
	copyBufferSize = 64 * 1024
)

type Proxy struct {
	upstream     *upstream.Upstream
	interceptors []interceptor.Interceptor
}

func New(primaryURL *url.URL, interceptors []interceptor.Interceptor) *Proxy {
	return &Proxy{
		upstream:     upstream.New(primaryURL, nil, upstream.NewClient(), 0),
		interceptors: interceptors,
	}
}

func NewWithUpstream(up *upstream.Upstream, interceptors []interceptor.Interceptor) *Proxy {
	return &Proxy{
		upstream:     up,
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

	upstreamURL := p.upstream.BuildURL(r.URL, false)
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
		response, err = p.forward(ctx.Request, false)
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

func (p *Proxy) forward(r *http.Request, isFallback bool) (*http.Response, error) {
	req := &upstream.Request{
		Method:        r.Method,
		URL:           r.URL,
		Body:          r.Body,
		GetBody:       r.GetBody,
		Header:        r.Header,
		ContentLength: r.ContentLength,
	}
	if isFallback {
		return p.upstream.DoFallback(r.Context(), req)
	}
	return p.upstream.Do(r.Context(), req)
}

func (p *Proxy) writeResponse(w http.ResponseWriter, r *http.Request, response *http.Response) {
	copyResponseHeaders(w.Header(), response.Header)
	flushHeaders := shouldFlushHeaders(response)
	w.Header().Del("X-Emby-Proxy-Flush-Headers")
	w.WriteHeader(response.StatusCode)
	if flushHeaders {
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}

	if response.Body == nil {
		return
	}

	isStream := isStreamResponse(response)
	if !isStream {
		buf := make([]byte, copyBufferSize)
		written, err := io.CopyBuffer(w, response.Body, buf)
		if err != nil && !isClientGone(err) && !errors.Is(r.Context().Err(), context.Canceled) {
			fmt.Printf("[HTTP] write error %s after=%dB: %v\n", r.URL.Path, written, err)
		}
		return
	}

	// Video/octet-stream response — track progress for logging
	buf := make([]byte, copyBufferSize)
	started := time.Now()
	nextLog := int64(16 * 1024 * 1024)

	reader := &progressReader{
		reader: response.Body,
		onProgress: func(total int64) {
			if total >= nextLog {
				interceptor.LogStreamProgress(r.URL.Path, total, total, 0, started)
				nextLog += 32 * 1024 * 1024
			}
		},
	}

	written, err := io.CopyBuffer(w, reader, buf)
	if err != nil && !isClientGone(err) && !errors.Is(r.Context().Err(), context.Canceled) {
		fmt.Printf("[HTTP] stream error %s after=%dB: %v\n", r.URL.Path, written, err)
	}

	fmt.Printf(
		"[HTTP] stream done %s pushed=%dB wrote=%dB in %.2fs%s\n",
		r.URL.Path,
		reader.total,
		written,
		time.Since(started).Seconds(),
		finishNote(r.Context().Err()),
	)
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		switch key {
		case "Connection", "Transfer-Encoding", "Keep-Alive",
			"Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Upgrade":
			continue
		}
		dst[key] = append(dst[key], values...)
	}
}

func isStreamResponse(response *http.Response) bool {
	contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
	contentType, _, _ = strings.Cut(contentType, ";")
	return strings.HasPrefix(contentType, "video/") ||
		contentType == "application/octet-stream"
}

func shouldFlushHeaders(response *http.Response) bool {
	return response.Header.Get("X-Emby-Proxy-Flush-Headers") == "1"
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

func finishNote(err error) string {
	if err == nil {
		return ""
	}
	return " canceled"
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
