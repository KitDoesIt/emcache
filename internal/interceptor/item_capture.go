package interceptor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"encache/internal/logging"
	"encache/internal/store"

	"github.com/fereidani/httpdecompressor"
)

var (
	playbackInfoPath = regexp.MustCompile(`^/emby/Items/([0-9]+)/PlaybackInfo/?$`)
	userItemPath     = regexp.MustCompile(`^/emby/Users/[^/]+/Items/([0-9]+)/?$`)
)

type ItemCapture struct {
	Base
	Store *store.Store
}

type embyItem struct {
	MediaSources []embyMediaSource `json:"MediaSources"`
}

type embyMediaSource struct {
	ID        string `json:"Id"`
	ItemID    string `json:"ItemId"`
	Name      string `json:"Name"`
	Path      string `json:"Path"`
	Size      int64  `json:"Size"`
	Container string `json:"Container"`
	Bitrate   int64  `json:"Bitrate"`
}

func (i ItemCapture) OnResponse(ctx *Context, response *http.Response) (*http.Response, error) {
	if i.Store == nil || response.Body == nil {
		return response, nil
	}
	matches := playbackInfoPath.FindStringSubmatch(ctx.Request.URL.Path)
	if matches == nil {
		matches = userItemPath.FindStringSubmatch(ctx.Request.URL.Path)
		if matches == nil {
			return response, nil
		}
	}
	itemID := matches[1]
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "application/json") {
		return response, nil
	}

	response.Body = &teeCaptureCloser{
		rc:       response.Body,
		store:    i.Store,
		itemID:   itemID,
		encoding: response.Header.Get("Content-Encoding"),
		path:     ctx.Request.URL.Path,
	}

	return response, nil
}

type teeCaptureCloser struct {
	rc       io.ReadCloser
	buf      bytes.Buffer
	store    *store.Store
	itemID   string
	encoding string
	path     string
	once     sync.Once
}

func (t *teeCaptureCloser) Read(p []byte) (int, error) {
	n, err := t.rc.Read(p)
	if n > 0 {
		t.buf.Write(p[:n])
	}
	if err == io.EOF {
		t.once.Do(t.process)
	}
	return n, err
}

func (t *teeCaptureCloser) Close() error {
	return t.rc.Close()
}

func (t *teeCaptureCloser) process() {
	go func() {
		body := t.buf.Bytes()
		decodedBody, err := decodeBodyForInspection(body, t.encoding)
		if err != nil {
			logging.Verbosef("[ItemCapture] decode failed %s: %v\n", t.path, err)
			return
		}

		var item embyItem
		if err := json.Unmarshal(decodedBody, &item); err != nil {
			logging.Verbosef("[ItemCapture] parse failed %s: %v\n", t.path, err)
			return
		}
		logInterceptedMediaSources(t.path, item.MediaSources)

		inserted := 0
		for _, mediaSource := range item.MediaSources {
			mediaItemID := mediaSourceItemID(mediaSource, t.itemID)
			ok, err := t.store.InsertMediaSource(context.Background(), store.MediaSource{
				MediaSourceID: mediaSource.ID,
				ItemID:        mediaItemID,
				ItemName:      store.SanitizeFilename(mediaSourceItemName(mediaSource, mediaItemID)),
				SourceName:    store.SanitizeFilename(mediaSourceName(mediaSource)),
				Size:          mediaSource.Size,
				Container:     mediaSource.Container,
				Bitrate:       mediaSource.Bitrate,
			})
			if err != nil {
				fmt.Printf("[ItemCapture] insert error item=%s: %v\n", t.itemID, err)
				return
			}
			if ok {
				inserted++
			}
		}

		fmt.Printf(
			"[ItemCapture] item=%s mediaSources=%d inserted=%d\n",
			t.itemID,
			len(item.MediaSources),
			inserted,
		)
	}()
}

func mediaSourceItemID(mediaSource embyMediaSource, fallback string) string {
	if mediaSource.ItemID != "" {
		return mediaSource.ItemID
	}
	return fallback
}

func mediaSourceItemName(mediaSource embyMediaSource, fallback string) string {
	if mediaSource.Path != "" {
		name := strings.TrimSuffix(filepath.Base(mediaSource.Path), filepath.Ext(mediaSource.Path))
		if name != "" && name != "." {
			return name
		}
	}
	return fallback
}

func mediaSourceName(mediaSource embyMediaSource) string {
	if mediaSource.Name != "" {
		return mediaSource.Name
	}
	if mediaSource.Path != "" {
		return mediaSource.Path
	}
	return mediaSource.ID
}

func decodeBodyForInspection(body []byte, contentEncoding string) ([]byte, error) {
	reader, err := httpdecompressor.ReaderFromReader(
		io.NopCloser(bytes.NewReader(body)),
		strings.ToLower(strings.TrimSpace(contentEncoding)),
	)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func logInterceptedMediaSources(path string, mediaSources []embyMediaSource) {
	fmt.Printf("[ItemCapture] playbackinfo %s mediaSources=%d\n", path, len(mediaSources))
	for _, mediaSource := range mediaSources {
		fmt.Printf(
			"[ItemCapture] source id=%s itemId=%s name=%q container=%s size=%d bitrate=%d path=%q\n",
			mediaSource.ID,
			mediaSource.ItemID,
			mediaSource.Name,
			mediaSource.Container,
			mediaSource.Size,
			mediaSource.Bitrate,
			mediaSource.Path,
		)
	}
}
