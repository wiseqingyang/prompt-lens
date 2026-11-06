package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBackgroundAuditScope(t *testing.T) {
	p := &ProxyServer{}
	for _, c := range []struct {
		method, address string
		audit           bool
	}{
		{"GET", "https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxes?page_size=10", false},
		{"GET", "https://daily-cloudcode-pa.googleapis.com:443/v1internal/cascadeNuxes", false},
		{"POST", "https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxes", true},
		{"GET", "https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxes/", true},
		{"GET", "https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxesExtra", true},
		{"GET", "https://daily-cloudcode-pa.googleapis.com/v1internal/%63ascadeNuxes", true},
		{"GET", "https://daily-cloudcode-pa.googleapis.com/x/../v1internal/cascadeNuxes", true},
		{"GET", "https://cloudcode-pa.googleapis.com/v1internal/cascadeNuxes", true},
		{"POST", "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", true},
	} {
		req := httptest.NewRequest(c.method, c.address, nil)
		if got := p.shouldAuditHTTP(req); got != c.audit {
			t.Errorf("%s %s: audit=%v", c.method, c.address, got)
		}
	}
}

func TestBackgroundForwardingPreservesResponsesWithoutAuditing(t *testing.T) {
	const body = `{"error":{"code":503,"message":"synthetic unavailable","status":"UNAVAILABLE"}}`
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "daily-cloudcode-pa.googleapis.com" || r.Header.Get("Authorization") != "Bearer synthetic-only" || r.URL.RawQuery != "page_size=10" {
			t.Error("business request changed")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Synthetic", "preserved")
		if r.Header.Get("X-Status") == "503" {
			w.WriteHeader(503)
		}
		_, _ = io.WriteString(w, body)
	}))
	defer origin.Close()
	// No delivery workers; inspect this test's queue without touching disk or a real callback.
	p := &ProxyServer{client: origin.Client(), callbackURL: "synthetic-only", eventQueue: make(chan CapturePayload, 10)}
	for _, status := range []int{200, 503} {
		req := httptest.NewRequest("GET", origin.URL+"/v1internal/cascadeNuxes?page_size=10", nil)
		req.Host = "daily-cloudcode-pa.googleapis.com"
		req.Header.Set("Authorization", "Bearer synthetic-only")
		if status == 503 {
			req.Header.Set("X-Status", "503")
		}
		p.forwardHTTP(req, "", "http", func(resp *http.Response) error {
			data, err := io.ReadAll(resp.Body)
			if resp.StatusCode != status || string(data) != body || resp.Header.Get("X-Synthetic") != "preserved" {
				t.Error("business response changed")
			}
			return err
		}, func(int, http.Header) error { return nil }, nil)
	}
	// The same failure on an actual model endpoint must still produce an audit event.
	req := httptest.NewRequest("POST", origin.URL+"/v1internal:streamGenerateContent?page_size=10", nil)
	req.Host = "daily-cloudcode-pa.googleapis.com"
	req.Header.Set("Authorization", "Bearer synthetic-only")
	req.Header.Set("X-Status", "503")
	p.forwardHTTP(req, "", "http", func(resp *http.Response) error { _, err := io.Copy(io.Discard, resp.Body); return err }, func(int, http.Header) error { return nil }, nil)
	select {
	case event := <-p.eventQueue:
		if event.Method != "POST" || event.StatusCode != 503 || event.ResponseBody != body {
			t.Fatalf("unexpected capture: %s %d", event.Method, event.StatusCode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("missing model error capture")
	}
	select {
	case <-p.eventQueue:
		t.Fatal("background endpoint was audited")
	case <-time.After(50 * time.Millisecond):
	}
}
