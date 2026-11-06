package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Exercise protocol negotiation through both proxy hops using only local TLS.
func TestAccountValidationNegotiatesHTTP2ThroughUpstream(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cm, err := newCertManagerAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	origin := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			http.Error(w, "fixture requires HTTP/2", http.StatusBadGateway)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/v1internal:loadCodeAssist" || string(body) != `{}` || r.Header.Get("Authorization") != "Bearer fixture-only" {
			t.Error("account validation request changed in transit")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	origin.EnableHTTP2 = true
	origin.StartTLS()
	defer origin.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != "daily-cloudcode-pa.googleapis.com:443" {
			t.Error("unexpected upstream CONNECT")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		dest, err := net.Dial("tcp", strings.TrimPrefix(origin.URL, "https://"))
		if err != nil {
			t.Error(err)
			return
		}
		defer dest.Close()
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go func() { _, _ = io.Copy(dest, rw) }()
		_, _ = io.Copy(conn, dest)
	}))
	defer upstream.Close()
	p, err := NewProxyServer("", upstream.URL, "", cm)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Shutdown(context.Background())
	transport := p.client.Transport.(*http.Transport)
	roots := x509.NewCertPool()
	roots.AddCert(origin.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com"}
	defer transport.CloseIdleConnections()
	proxy := httptest.NewServer(p)
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	clientRoots := x509.NewCertPool()
	clientRoots.AddCert(cm.caCert)
	clientTransport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: clientRoots}}
	defer clientTransport.CloseIdleConnections()
	client := &http.Client{Transport: clientTransport, Timeout: 3 * time.Second}
	req, _ := http.NewRequest(http.MethodPost, "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer fixture-only")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK || string(body) != `{"ok":true}` {
		t.Fatalf("validation response: status=%d body=%q error=%v", resp.StatusCode, body, err)
	}
}
