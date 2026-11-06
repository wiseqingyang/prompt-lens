package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Exercise real HTTP parsing on a persistent connection. A body without a valid
// length/chunk terminator hangs here even when all application bytes arrived.
func TestMITMResponseFraming(t *testing.T) {
	for _, name := range []string{"sse", "gzip", "fixed-length", "close-delimited"} {
		t.Run(name, func(t *testing.T) {
			body := []byte("data: {\"text\":\"hello\"}\n\ndata: [DONE]\n\n")
			headers := make(http.Header)
			headers.Set("Content-Type", "text/event-stream")
			if name == "gzip" {
				var b bytes.Buffer
				z := gzip.NewWriter(&b)
				_, _ = z.Write(body)
				_ = z.Close()
				body = b.Bytes()
				headers.Set("Content-Encoding", "gzip")
			}
			p, _ := NewProxyServer("", "", "", nil)
			p.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				length := int64(-1)
				encoding := []string{"chunked"}
				if name == "fixed-length" {
					length, encoding = int64(len(body)), nil
				}
				if name == "close-delimited" {
					encoding = nil
				}
				return &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1,
					Header: headers.Clone(), Body: io.NopCloser(bytes.NewReader(body)),
					ContentLength: length, TransferEncoding: encoding, Request: r}, nil
			})
			server, client := net.Pipe()
			defer server.Close()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(2 * time.Second))
			go func() {
				for i := 0; i < 2; i++ {
					r := httptest.NewRequest("POST", "/v1:streamGenerateContent?alt=sse", strings.NewReader("{}"))
					p.processDecryptedRequest(server, r, "daily-cloudcode-pa.googleapis.com:443")
				}
			}()
			reader := bufio.NewReader(client)
			for i := 0; i < 2; i++ {
				resp, err := http.ReadResponse(reader, &http.Request{Method: "POST"})
				if err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(resp.Body)
				_ = resp.Body.Close()
				if err != nil {
					t.Fatalf("response %d failed to finish: %v", i, err)
				}
				if !bytes.Equal(got, body) {
					t.Fatalf("response %d body corrupted", i)
				}
			}
		})
	}
}

func TestTLSProxyStreamsAndCapturesThroughUpstream(t *testing.T) {
	cm, err := newCertManagerAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	finishStream := make(chan struct{})
	defer close(finishStream)
	const firstEvent = "data: {\"text\":\"first\"}\n\n"
	const lastEvent = "data: [DONE]\n\n"
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", "/must-not-follow")
			w.WriteHeader(302)
			return
		}
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credentials leaked to origin")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Trailer", "X-Stream-End")
		_, _ = io.WriteString(w, firstEvent)
		w.(http.Flusher).Flush()
		select {
		case <-finishStream:
		case <-r.Context().Done():
			return
		case <-time.After(4 * time.Second):
			return
		}
		_, _ = io.WriteString(w, lastEvent)
		w.Header().Set("X-Stream-End", "done")
	}))
	defer origin.Close()
	var connectCount atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" {
			t.Errorf("expected CONNECT, got %s", r.Method)
			return
		}
		connectCount.Add(1)
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
	captured := make(chan CapturePayload, 4)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload CapturePayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		captured <- payload
		w.WriteHeader(200)
	}))
	defer receiver.Close()
	p, err := NewProxyServer("", upstream.URL, receiver.URL, cm)
	if err != nil {
		t.Fatal(err)
	}
	transport := p.client.Transport.(*http.Transport)
	// Only the local fixture's certificate is trusted, no external requests.
	transport.TLSClientConfig = origin.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "example.com"
	defer transport.CloseIdleConnections()
	proxy := httptest.NewServer(p)
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	roots := x509.NewCertPool()
	roots.AddCert(cm.caCert)
	clientTransport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: roots}}
	defer clientTransport.CloseIdleConnections()
	client := &http.Client{Transport: clientTransport, Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Post("https://daily-cloudcode-pa.googleapis.com/v1:streamGenerateContent?alt=sse", "application/json", strings.NewReader("{\"contents\":[]}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	first := make([]byte, len(firstEvent))
	if _, err := io.ReadFull(resp.Body, first); err != nil {
		t.Fatalf("first event was buffered: %v", err)
	}
	if string(first) != firstEvent {
		t.Fatalf("unexpected event %q", first)
	}
	finishStream <- struct{}{}
	rest, err := io.ReadAll(resp.Body)
	if err != nil || string(rest) != lastEvent {
		t.Fatalf("stream did not finish: %q %v", rest, err)
	}
	if resp.Trailer.Get("X-Stream-End") != "done" {
		t.Fatal("response trailer lost")
	}
	select {
	case payload := <-captured:
		if payload.ResponseBody != firstEvent+lastEvent || payload.RequestBody != "{\"contents\":[]}" || payload.StatusCode != 200 {
			t.Fatalf("capture mismatch: %+v", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("capture was not delivered")
	}
	resp, err = client.Get("https://daily-cloudcode-pa.googleapis.com/redirect")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 302 || resp.Header.Get("Location") != "/must-not-follow" {
		t.Fatal("proxy followed upstream redirect")
	}
	if connectCount.Load() == 0 {
		t.Fatal("upstream was bypassed")
	}
}

func TestOpaqueTunnelPreservesBufferedBytes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Host != "oauth2.googleapis.com:443" {
			t.Errorf("bad tunnel target: %s %s", r.Method, r.Host)
		}
		if r.Header.Get("Proxy-Authorization") != "Basic dXNlcjpwYXNz" {
			t.Error("missing upstream proxy auth")
		}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\nready")
		_, _ = io.Copy(conn, rw)
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)
	upstreamURL.User = url.UserPassword("user", "pass")
	p, _ := NewProxyServer("", upstreamURL.String(), "", nil)
	proxy := httptest.NewServer(p)
	defer proxy.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.WriteString(conn, "CONNECT oauth2.googleapis.com:443 HTTP/1.1\r\nHost: oauth2.googleapis.com:443\r\n\r\nping")
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("CONNECT status %d", resp.StatusCode)
	}
	data := make([]byte, len("readyping"))
	if _, err := io.ReadFull(reader, data); err != nil {
		t.Fatal(err)
	}
	if string(data) != "readyping" {
		t.Fatalf("tunnel bytes lost: %q", data)
	}
}

func TestHostPolicy(t *testing.T) {
	for _, host := range []string{"[::1]:443", "127.0.0.2:443", "localhost:443", "test.local:443", "oauth2.googleapis.com:443", "auth.openai.com:443", "auth.chatgpt.com:443", "ws.chatgpt.com:443", "ab.chatgpt.com:443", "chatgpt.com.attacker.test:443", "cloudcode-pa.googleapis.com.attacker.test:443"} {
		if shouldInterceptHost(host) {
			t.Errorf("must bypass %s", host)
		}
	}
	if !shouldInterceptHost("api.openai.com:443") {
		t.Fatal("api.openai.com must be intercepted")
	}
	if !shouldInterceptHost("chatgpt.com:443") {
		t.Fatal("official Codex model traffic must be intercepted")
	}
	if !shouldInterceptHost("daily-cloudcode-pa.googleapis.com:443") {
		t.Fatal("CloudCode must be intercepted")
	}
	if !isLocalHost("[::1]:1234") || !isLocalHost("127.0.0.2:1234") {
		t.Fatal("loopback detection failed")
	}
}

func TestExistingCAResyncsExport(t *testing.T) {
	dir := t.TempDir()
	first, err := newCertManagerAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ca.crt"), []byte("stale"), 0644); err != nil {
		t.Fatal(err)
	}
	second, err := newCertManagerAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.caCert.Raw, second.caCert.Raw) {
		t.Fatal("existing CA was rotated")
	}
	exported, _ := os.ReadFile(filepath.Join(dir, "ca.crt"))
	signing, _ := os.ReadFile(filepath.Join(dir, "ssl", "certs", "ca.pem"))
	if !bytes.Equal(exported, signing) {
		t.Fatal("exported CA differs from signing CA")
	}
}

func TestForwardHTTPAndLoopbackBypass(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "local IPC ok")
	}))
	defer origin.Close()
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		http.Error(w, "loopback must not reach upstream", 502)
	}))
	defer upstream.Close()
	p, _ := NewProxyServer("", upstream.URL, "", nil)
	proxy := httptest.NewServer(p)
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	resp, err := client.Get(origin.URL + "/bridge")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "local IPC ok" {
		t.Errorf("HTTP IPC failed: status=%d body=%s", resp.StatusCode, body)
	}
	conn, err := net.Dial("tcp", proxyURL.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	target := strings.TrimPrefix(origin.URL, "http://")
	// Put tunneled bytes in the same packet to detect discarded hijack buffers.
	_, _ = io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\nGET /bridge HTTP/1.1\r\nHost: "+target+"\r\nConnection: close\r\n\r\n")
	reader := bufio.NewReader(conn)
	tunnel, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if err != nil {
		t.Fatal(err)
	}
	if tunnel.StatusCode != 200 {
		t.Fatalf("CONNECT IPC failed: %d", tunnel.StatusCode)
	}
	resp, err = http.ReadResponse(reader, &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	body, err = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil || string(body) != "local IPC ok" {
		t.Fatalf("tunneled IPC failed: %q %v", body, err)
	}
	if upstreamCalls.Load() != 0 {
		t.Fatal("local IPC was forwarded to upstream")
	}
}

func TestCustomDomainsInterception(t *testing.T) {
	ps := &ProxyServer{}
	ps.SetCustomDomains([]string{"api.siliconflow.cn", "custom-model.internal.net"})

	// Built-in should match
	if !ps.shouldInterceptHost("api.openai.com:443") {
		t.Error("expected api.openai.com to be intercepted")
	}

	// Custom domain should match
	if !ps.shouldInterceptHost("api.siliconflow.cn:443") {
		t.Error("expected api.siliconflow.cn to be intercepted")
	}
	if !ps.shouldInterceptHost("sub.custom-model.internal.net:8443") {
		t.Error("expected sub.custom-model.internal.net to be intercepted")
	}

	// Unrelated domain should NOT match
	if ps.shouldInterceptHost("github.com:443") {
		t.Error("expected github.com not to be intercepted")
	}
	if ps.shouldInterceptHost("127.0.0.1:8080") {
		t.Error("expected loopback not to be intercepted")
	}
}

func TestLocalhostHTTPAuditAndStreaming(t *testing.T) {
	// Mock local reverse proxy (like CC Switch on 127.0.0.1:15721)
	localLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"text\":\"streamed from local reverse proxy\"}\n\n")
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer localLLM.Close()

	captured := make(chan CapturePayload, 2)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload CapturePayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		captured <- payload
		w.WriteHeader(200)
	}))
	defer receiver.Close()

	p, err := NewProxyServer("", "", receiver.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(p)
	defer proxy.Close()

	proxyURL, _ := url.Parse(proxy.URL)
	client := &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)},
		Timeout:   2 * time.Second,
	}

	reqBody := strings.NewReader("{\"model\":\"ag/gemini-3.8-flash-high\",\"input\":\"hello\"}")
	req, err := http.NewRequest("POST", localLLM.URL+"/v1/responses", reqBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("User-Agent", "CodexBrowser/1.0")
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(respBytes), "streamed from local reverse proxy") {
		t.Fatalf("unexpected response body: %s", string(respBytes))
	}

	select {
	case payload := <-captured:
		if payload.Method != "POST" {
			t.Errorf("expected POST method, got %s", payload.Method)
		}
		if !strings.Contains(payload.RequestBody, "ag/gemini-3.8-flash-high") {
			t.Errorf("expected request body to contain model, got: %s", payload.RequestBody)
		}
		if !strings.Contains(payload.ResponseBody, "streamed from local reverse proxy") {
			t.Errorf("expected response body to contain streamed content, got: %s", payload.ResponseBody)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for HTTP capture payload to be delivered to receiver")
	}
}

func TestLocalConnectPlainHTTPAudit(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"local-connect-ok","output":[]}`)
	}))
	defer origin.Close()

	captured := make(chan CapturePayload, 1)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload CapturePayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		captured <- payload
		w.WriteHeader(http.StatusOK)
	}))
	defer receiver.Close()

	p, err := NewProxyServer("", "", receiver.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(p)
	defer proxy.Close()

	target := strings.TrimPrefix(origin.URL, "http://")
	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	reader := bufio.NewReader(conn)

	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		t.Fatal(err)
	}
	connectResp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if connectResp.StatusCode != http.StatusOK {
		t.Fatalf("expected CONNECT 200, got %d", connectResp.StatusCode)
	}

	body := `{"model":"local-connect-model","input":"hello"}`
	if _, err := fmt.Fprintf(conn, "POST /v1/responses HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", target, len(body), body); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatal(err)
	}
	responseBody, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || string(responseBody) != `{"id":"local-connect-ok","output":[]}` {
		t.Fatalf("unexpected local CONNECT response: %q (%v)", responseBody, err)
	}

	select {
	case payload := <-captured:
		if payload.URLPath != "/v1/responses" || payload.RequestBody != body || payload.StatusCode != http.StatusOK {
			t.Fatalf("capture mismatch: %+v", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("plaintext CONNECT request was not captured")
	}
}

func TestDecodedAuditPayloadBudgetIsExplicit(t *testing.T) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write(bytes.Repeat([]byte("x"), decompressionCaptureLimit+1))
	_ = writer.Close()
	text, reason := decodeBodyAudit(compressed.Bytes(), "gzip")
	if len(text) != decompressionCaptureLimit || reason != "decoded_payload_exceeded_budget" {
		t.Fatal("decompression limit was silent")
	}
	if text, reason = decodeBodyAudit([]byte("encoded"), "br"); text != "" || reason != "unsupported_or_invalid_content_encoding" {
		t.Fatal("unsupported encoding masqueraded as raw text")
	}
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	zstdData := encoder.EncodeAll(bytes.Repeat([]byte("x"), decompressionCaptureLimit+1), nil)
	text, reason = decodeBodyAudit(zstdData, "zstd")
	if len(text) != decompressionCaptureLimit || reason != "decoded_payload_exceeded_budget" {
		t.Fatalf("zstd limit: length=%d reason=%s", len(text), reason)
	}
	text, reason = decodeBodyAudit([]byte("not a zstd frame"), "zstd")
	if text != "" || reason == "" {
		t.Fatal("invalid zstd data was accepted as text")
	}
}
