package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Account initialization reuses one TLS tunnel for POST and GET requests.
// A disconnect watcher must never consume bytes from the next request.
func TestMITMKeepAlivePreservesRequestMethods(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cm, err := newCertManagerAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewProxyServer("", "", "", cm)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Shutdown(context.Background())
	p.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		result := fmt.Sprintf("%s %s %s", r.Method, r.URL.Path, body)
		return &http.Response{StatusCode: 200, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(result)), ContentLength: int64(len(result))}, nil
	})
	proxy := httptest.NewServer(p)
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	roots := x509.NewCertPool()
	roots.AddCert(cm.caCert)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: roots}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	for i := 0; i < 12; i++ {
		method, body := "POST", `{}`
		if i%3 == 2 {
			method, body = "GET", ""
		}
		path := fmt.Sprintf("/account-check/%d", i)
		req, _ := http.NewRequest(method, "https://daily-cloudcode-pa.googleapis.com"+path, strings.NewReader(body))
		var reused bool
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
			GotConn: func(info httptrace.GotConnInfo) { reused = info.Reused },
		}))
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		want := fmt.Sprintf("%s %s %s", method, path, body)
		if string(got) != want {
			t.Fatalf("request %d corrupted: got %q, want %q", i, got, want)
		}
		if i > 0 && !reused {
			t.Fatalf("request %d did not reuse its TLS tunnel", i)
		}
	}
}
