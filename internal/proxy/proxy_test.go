package proxy

import (
	"net/http"
	"testing"
)

func TestCountingWriterBatchesFlushes(t *testing.T) {
	writer := &flushRecorder{}
	counter := newCountingWriter(writer, "/video", true)

	for i := 0; i < int(flushBytes/copyBufferSize)-1; i++ {
		if _, err := counter.Write(make([]byte, copyBufferSize)); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if writer.flushes != 0 {
		t.Fatalf("flushes before threshold = %d, want 0", writer.flushes)
	}

	if _, err := counter.Write(make([]byte, copyBufferSize)); err != nil {
		t.Fatalf("write threshold: %v", err)
	}
	if writer.flushes != 1 {
		t.Fatalf("flushes at threshold = %d, want 1", writer.flushes)
	}
}

func TestCountingWriterFinalFlush(t *testing.T) {
	writer := &flushRecorder{}
	counter := newCountingWriter(writer, "/video", true)

	if _, err := counter.Write([]byte("partial")); err != nil {
		t.Fatalf("write: %v", err)
	}
	counter.Flush()
	if writer.flushes != 1 {
		t.Fatalf("flushes = %d, want 1", writer.flushes)
	}
	counter.Flush()
	if writer.flushes != 1 {
		t.Fatalf("empty flush changed count to %d, want 1", writer.flushes)
	}
}

func TestIsStreamResponseIgnoresSubtitleRanges(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusPartialContent,
		Header: http.Header{
			"Content-Type": []string{"text/x-ssa"},
		},
	}

	if isStreamResponse(response) {
		t.Fatal("subtitle range was classified as stream")
	}
}

func TestIsStreamResponseMatchesVideoWithParameters(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusPartialContent,
		Header: http.Header{
			"Content-Type": []string{"video/x-matroska; charset=binary"},
		},
	}

	if !isStreamResponse(response) {
		t.Fatal("video response was not classified as stream")
	}
}

type flushRecorder struct {
	flushes int
}

func (w *flushRecorder) Header() map[string][]string {
	return nil
}

func (w *flushRecorder) Write(data []byte) (int, error) {
	return len(data), nil
}

func (w *flushRecorder) WriteHeader(int) {}

func (w *flushRecorder) Flush() {
	w.flushes++
}
