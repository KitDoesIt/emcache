package interceptor

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Logger struct {
	Base
}

func (Logger) OnRequest(ctx *Context) (*http.Response, bool, error) {
	req := ctx.Request
	rangeHeader := req.Header.Get("Range")
	if rangeHeader != "" {
		fmt.Printf("[HTTP] %s %s range=%s\n", req.Method, req.URL.RequestURI(), rangeHeader)
	} else {
		fmt.Printf("[HTTP] %s %s\n", req.Method, req.URL.RequestURI())
	}
	return nil, false, nil
}

func (Logger) OnResponse(ctx *Context, response *http.Response) (*http.Response, error) {
	if isStreamResponse(response) {
		fmt.Printf(
			"[HTTP] -> %d %s content-range=%s content-length=%d content-type=%s\n",
			response.StatusCode,
			ctx.Request.URL.Path,
			response.Header.Get("Content-Range"),
			response.ContentLength,
			response.Header.Get("Content-Type"),
		)
	}
	return response, nil
}

func LogStreamProgress(path string, pushed int64, socketWritten int64, drains int, started time.Time) {
	secs := time.Since(started).Seconds()
	if secs <= 0 {
		secs = 0.001
	}
	mb := float64(pushed) / 1024 / 1024
	mbps := mb / secs
	fmt.Printf(
		"[HTTP] stream %s pushed=%.1fMB socketWrote=%.1fMB @ %.2fMB/s drains=%d\n",
		path,
		mb,
		float64(socketWritten)/1024/1024,
		mbps,
		drains,
	)
}

func isStreamResponse(response *http.Response) bool {
	contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
	contentType, _, _ = strings.Cut(contentType, ";")
	return strings.HasPrefix(contentType, "video/") ||
		contentType == "application/octet-stream"
}
