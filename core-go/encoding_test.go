package main

import (
	"bytes"
	"compress/gzip"
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

// Model and account clients may intentionally have no decompression support.
// A proxy cannot advertise compression on their behalf, even if its own HTTP
// client can decode it. Exercise the real transport, not a RoundTripper mock.
func TestProxyPreservesClientEncodingContract(t *testing.T) {
	const requestJSON = `{"refresh_token":"fixture-only"}`
	const responseJSON = `{"access_token":"fixture-new","expires_in":3600}`
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	_, _ = zw.Write([]byte(responseJSON))
	_ = zw.Close()
	encodings := make(chan string, 8)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") != "Bearer fixture-only" || r.Header.Get("Cookie") != "session=fixture" || string(body) != requestJSON {
			t.Error("authentication headers or request body changed in transit")
		}
		encoding := r.Header.Get("Accept-Encoding")
		encodings <- encoding
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "session=refreshed; Secure; HttpOnly")
		if strings.Contains(encoding, "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(compressed.Bytes())
		} else {
			_, _ = io.WriteString(w, responseJSON)
		}
	})
	tlsOrigin := httptest.NewUnstartedServer(handler)
	tlsOrigin.EnableHTTP2 = true
	tlsOrigin.StartTLS()
	defer tlsOrigin.Close()
	httpOrigin := httptest.NewServer(handler)
	defer httpOrigin.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			t.Error("unexpected upstream method")
			w.WriteHeader(400)
			return
		}
		dest, err := net.Dial("tcp", strings.TrimPrefix(tlsOrigin.URL, "https://"))
		if err != nil {
			t.Error(err)
			return
		}
		defer dest.Close()
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go func() { _, _ = io.Copy(dest, rw) }()
		_, _ = io.Copy(conn, dest)
	}))
	defer upstream.Close()
	cm, err := newCertManagerAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewProxyServer("", upstream.URL, "", cm)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Shutdown(context.Background())
	roots := x509.NewCertPool()
	roots.AddCert(tlsOrigin.Certificate())
	transport := p.client.Transport.(*http.Transport)
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com"}
	defer transport.CloseIdleConnections()
	proxy := httptest.NewServer(p)
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	clientRoots := x509.NewCertPool()
	clientRoots.AddCert(cm.caCert)
	clientTransport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: clientRoots}, DisableCompression: true}
	defer clientTransport.CloseIdleConnections()
	client := &http.Client{Transport: clientTransport, Timeout: 3 * time.Second}
	for _, target := range []struct{ name, url string }{
		{"https-account-refresh", "https://chatgpt.com/backend-api/wham/remote/control/server/refresh"},
		{"http-local-gateway", httpOrigin.URL + "/v1/responses"},
	} {
		for _, encoding := range []string{"", "identity", "gzip"} {
			name := encoding
			if name == "" {
				name = "absent"
			}
			t.Run(target.name+"/"+name, func(t *testing.T) {
				req, _ := http.NewRequest("POST", target.url, strings.NewReader(requestJSON))
				req.Header.Set("Authorization", "Bearer fixture-only")
				req.Header.Set("Cookie", "session=fixture")
				req.Header.Set("Content-Type", "application/json")
				if encoding != "" {
					req.Header.Set("Accept-Encoding", encoding)
				}
				resp, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(resp.Body)
				_ = resp.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				// Verify what reached the origin, and what the undecoding client received.
				select {
				case gotEncoding := <-encodings:
					if gotEncoding != encoding {
						t.Errorf("Accept-Encoding changed: want %q, got %q", encoding, gotEncoding)
					}
				case <-time.After(time.Second):
					t.Fatal("request did not reach origin")
				}
				want := []byte(responseJSON)
				wantContentEncoding := ""
				if encoding == "gzip" {
					want = compressed.Bytes()
					wantContentEncoding = "gzip"
				}
				if !bytes.Equal(got, want) || resp.Header.Get("Content-Encoding") != wantContentEncoding {
					t.Errorf("response encoding changed: header=%q, gzip_bytes=%v", resp.Header.Get("Content-Encoding"), bytes.HasPrefix(got, []byte{0x1f, 0x8b}))
				}
				if resp.StatusCode != 200 || resp.Header.Get("Set-Cookie") != "session=refreshed; Secure; HttpOnly" {
					t.Fatal("authentication response status or cookie changed")
				}
			})
		}
	}
}
