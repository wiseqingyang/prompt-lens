package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/textproto"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// All origins, callbacks and proxy listeners are local and use ephemeral ports.
func transparencyFixture(t *testing.T, useTLS bool, handler http.Handler) (*http.Client, string, <-chan []byte) {
	t.Helper()
	origin := httptest.NewUnstartedServer(handler)
	if useTLS {
		origin.EnableHTTP2 = true
		origin.StartTLS()
	} else {
		origin.Start()
	}
	t.Cleanup(origin.Close)
	cm, err := newCertManagerAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	captures := make(chan []byte, 4)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Delivery ends when the full audit body arrives. Validate JSON in the test:
		// race-instrumented decoding of a 16 MiB copy must not consume the delivery
		// deadline or provoke callback retries after the bytes already arrived.
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read audit callback: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		captures <- data
	}))
	t.Cleanup(receiver.Close)
	p, err := NewProxyServer("", "", receiver.URL, cm)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Shutdown(context.Background()) })
	upstream := p.client.Transport.(*http.Transport)
	if useTLS {
		roots := x509.NewCertPool()
		roots.AddCert(origin.Certificate())
		upstream.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com"}
	}
	originalDial := upstream.DialContext
	upstream.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return originalDial(ctx, network, strings.TrimPrefix(strings.TrimPrefix(origin.URL, "https://"), "http://"))
	}
	t.Cleanup(upstream.CloseIdleConnections)
	proxy := httptest.NewServer(p)
	t.Cleanup(proxy.Close)
	proxyURL, _ := url.Parse(proxy.URL)
	roots := x509.NewCertPool()
	roots.AddCert(cm.caCert)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), DisableCompression: true, ExpectContinueTimeout: 5 * time.Second, TLSClientConfig: &tls.Config{RootCAs: roots}}
	t.Cleanup(transport.CloseIdleConnections)
	base := origin.URL
	if useTLS {
		base = "https://api.openai.com:8443"
	}
	return &http.Client{Transport: transport, Timeout: 10 * time.Second}, base, captures
}

func decodeCapturedPayload(t *testing.T, data []byte) CapturePayload {
	t.Helper()
	var payload CapturePayload
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("invalid audit callback JSON: %v", err)
	}
	return payload
}

func TestForwardingPreservesBusinessContentAndCaptureIsACopy(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		name := "http"
		if useTLS {
			name = "tls-connect"
		}
		t.Run(name, func(t *testing.T) {
			// Beyond the old request buffer and the independent capture budget.
			requestBody := bytes.Repeat([]byte("request-0123456789"), 1100000)
			responseBody := bytes.Repeat([]byte("response-0123456789"), 550000)
			expectedHash := sha256.Sum256(requestBody)
			const requestURI = "/v1/responses/a%2Fb?token=fixture%2Fsecret&x=1+2&x=%2B"
			client, base, captures := transparencyFixture(t, useTLS, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got, err := io.ReadAll(r.Body)
				if err != nil || sha256.Sum256(got) != expectedHash {
					t.Errorf("request body changed: length=%d, error=%v", len(got), err)
				}
				if r.Host != "API.OPENAI.COM:9443" || r.RequestURI != requestURI || r.Method != "PATCH" {
					t.Errorf("request target changed: %s %s %s", r.Method, r.Host, r.RequestURI)
				}
				if _, present := r.Header["User-Agent"]; present {
					t.Error("proxy added a User-Agent")
				}
				if r.Header.Get("Authorization") != "Bearer fixture-secret" || r.Header.Get("Cookie") != "session=fixture-secret" || !reflect.DeepEqual(r.Header.Values("X-Opaque"), []string{"first", "second"}) {
					t.Error("business headers changed")
				}
				if r.Trailer.Get("X-Request-Proof") != "request-proof" {
					t.Error("request trailer lost")
				}
				w.Header()["Content-Type"] = nil
				w.Header()["Date"] = nil
				w.Header().Add("Set-Cookie", "one=fixture; HttpOnly")
				w.Header().Add("Set-Cookie", "two=fixture; Secure")
				w.Header().Set("Trailer", "X-Response-Proof")
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write(responseBody)
				w.(http.Flusher).Flush()
				w.Header().Set("X-Response-Proof", "response-proof")
				w.Header().Set(http.TrailerPrefix+"X-Unannounced-Proof", "late-proof")
			}))
			req, _ := http.NewRequest("PATCH", base+requestURI, bytes.NewReader(requestBody))
			req.Host = "API.OPENAI.COM:9443"
			req.Header["User-Agent"] = nil
			req.Header.Set("Authorization", "Bearer fixture-secret")
			req.Header.Set("Cookie", "session=fixture-secret")
			req.Header["X-Opaque"] = []string{"first", "second"}
			req.ContentLength = -1
			req.Trailer = http.Header{"X-Request-Proof": []string{"request-proof"}}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil || !bytes.Equal(got, responseBody) {
				t.Fatalf("response body changed: length=%d, error=%v", len(got), err)
			}
			if resp.StatusCode != http.StatusCreated || resp.Trailer.Get("X-Response-Proof") != "response-proof" {
				t.Error("response status or trailer changed")
			}
			if resp.Trailer.Get("X-Unannounced-Proof") != "late-proof" {
				t.Error("unannounced response trailer lost")
			}
			for _, key := range []string{"Content-Type", "Date"} {
				if _, present := resp.Header[key]; present {
					t.Errorf("proxy added %s", key)
				}
			}
			if !reflect.DeepEqual(resp.Header.Values("Set-Cookie"), []string{"one=fixture; HttpOnly", "two=fixture; Secure"}) {
				t.Error("response cookies changed")
			}
			select {
			case data := <-captures:
				capture := decodeCapturedPayload(t, data)
				if capture.CaptureStatus != "truncated" || len(capture.RequestBody) != 8*1024*1024 || len(capture.ResponseBody) != 8*1024*1024 {
					t.Errorf("capture budget incorrect: status=%s, request=%d, response=%d", capture.CaptureStatus, len(capture.RequestBody), len(capture.ResponseBody))
				}
				if capture.BytesWire != int64(len(requestBody)+len(responseBody)) {
					t.Errorf("forwarded byte count incorrect: %d", capture.BytesWire)
				}
				if capture.RequestHeaders["authorization"] != "Bearer [REDACTED]" || capture.ResponseHeaders["set-cookie"] != "[REDACTED]" || strings.Contains(capture.URLPath, "fixture%2Fsecret") {
					t.Error("audit copy was not sanitized")
				}
			case <-time.After(5 * time.Second):
				t.Error("complete audit callback body not received before delivery deadline")
			}
		})
	}
}

func TestRequestBodyStreamsBeforeUploadCompletes(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		name := "http"
		if useTLS {
			name = "tls-connect"
		}
		t.Run(name, func(t *testing.T) {
			received := make(chan struct{})
			client, base, captures := transparencyFixture(t, useTLS, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				first := make([]byte, 32)
				if _, err := io.ReadFull(r.Body, first); err != nil {
					return
				}
				close(received)
				_, _ = io.Copy(io.Discard, r.Body)
				_, _ = w.Write([]byte("done"))
			}))
			reader, writer := io.Pipe()
			req, _ := http.NewRequest("POST", base+"/v1/responses", reader)
			done := make(chan error, 1)
			go func() {
				resp, err := client.Do(req)
				if err == nil {
					_, err = io.Copy(io.Discard, resp.Body)
					_ = resp.Body.Close()
				}
				done <- err
			}()
			_, _ = writer.Write(bytes.Repeat([]byte("x"), 32))
			select {
			case <-received:
			case <-time.After(time.Second):
				t.Error("proxy buffered the upload before forwarding its first bytes")
			}
			_, _ = writer.Write([]byte("remaining-upload"))
			_ = writer.Close()
			if err := <-done; err != nil {
				t.Error(err)
			}
			select {
			case data := <-captures:
				capture := decodeCapturedPayload(t, data)
				if capture.RequestBody != strings.Repeat("x", 32)+"remaining-upload" || capture.ResponseBody != "done" || capture.CaptureStatus != "complete" {
					t.Error("streaming audit copy differs from forwarded content")
				}
			case <-time.After(2 * time.Second):
				t.Error("complete audit callback body not received before delivery deadline")
			}
		})
	}
}

func TestCompressedAuditOperatesOnCopies(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		name := "http"
		if useTLS {
			name = "tls-connect"
		}
		t.Run(name, func(t *testing.T) {
			const body = `{"input":"unchanged compressed payload"}`
			var compressed bytes.Buffer
			compressor := gzip.NewWriter(&compressed)
			_, _ = io.WriteString(compressor, body)
			_ = compressor.Close()
			wire := compressed.Bytes()
			client, base, captures := transparencyFixture(t, useTLS, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got, err := io.ReadAll(r.Body)
				if err != nil || !bytes.Equal(got, wire) || r.Header.Get("Content-Encoding") != "gzip" {
					t.Error("compressed request changed")
				}
				w.Header().Set("Content-Encoding", "gzip")
				_, _ = w.Write(wire)
			}))
			req, _ := http.NewRequest("POST", base+"/v1/responses", bytes.NewReader(wire))
			req.Header.Set("Content-Encoding", "gzip")
			req.Header.Set("Accept-Encoding", "gzip")
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil || !bytes.Equal(got, wire) || resp.Header.Get("Content-Encoding") != "gzip" {
				t.Fatal("compressed response changed")
			}
			select {
			case data := <-captures:
				capture := decodeCapturedPayload(t, data)
				if capture.RequestBody != body || capture.ResponseBody != body || capture.CaptureStatus != "complete" {
					t.Error("audit copy was not decoded independently")
				}
			case <-time.After(2 * time.Second):
				t.Error("complete audit callback body not received before delivery deadline")
			}
		})
	}
}

func TestZstdAuditOperatesOnCopies(t *testing.T) {
	const body = `{"model":"synthetic-model","input":"test"}`
	wire, err := base64.StdEncoding.DecodeString("KLUv/QRYUQEAeyJtb2RlbCI6InN5bnRoZXRpYy1tb2RlbCIsImlucHV0IjoidGVzdCJ9JBP7Tg==")
	if err != nil {
		t.Fatal(err)
	}
	for _, useTLS := range []bool{false, true} {
		t.Run(fmt.Sprintf("tls=%v", useTLS), func(t *testing.T) {
			client, base, captures := transparencyFixture(t, useTLS, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got, err := io.ReadAll(r.Body)
				if err != nil || !bytes.Equal(got, wire) || r.Header.Get("Content-Encoding") != "zstd" {
					t.Error("compressed request changed")
				}
				w.Header().Set("Content-Encoding", "zstd")
				_, _ = w.Write(wire)
			}))
			req, _ := http.NewRequest("POST", base+"/v1/responses", bytes.NewReader(wire))
			req.Header.Set("Content-Encoding", "zstd")
			req.Header.Set("Accept-Encoding", "zstd")
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil || !bytes.Equal(got, wire) || resp.Header.Get("Content-Encoding") != "zstd" {
				t.Fatal("compressed response changed")
			}
			select {
			case data := <-captures:
				capture := decodeCapturedPayload(t, data)
				if capture.RequestBody != body || capture.ResponseBody != body || capture.CaptureStatus != "complete" {
					t.Errorf("audit copy was not decoded independently: status=%s", capture.CaptureStatus)
				}
			case <-time.After(2 * time.Second):
				t.Error("audit callback not received")
			}
		})
	}
}

type countedUpload struct {
	read atomic.Int64
	body *strings.Reader
}

func (r *countedUpload) Read(data []byte) (int, error) {
	n, err := r.body.Read(data)
	r.read.Add(int64(n))
	return n, err
}

func TestContinueAndEarlyRejectionPreserveUpstreamDecision(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		name := "http"
		if useTLS {
			name = "tls-connect"
		}
		t.Run(name, func(t *testing.T) {
			const body = "fixture-upload"
			client, base, captures := transparencyFixture(t, useTLS, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Go's HTTP/2 server consumes Expect internally to implement 100 Continue.
				if r.ProtoMajor == 1 && r.Header.Get("Expect") != "100-continue" {
					t.Error("Expect header changed")
				}
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, "reject") {
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = io.WriteString(w, `{"error":"fixture-rejection"}`)
					return
				}
				got, err := io.ReadAll(r.Body)
				if err != nil || string(got) != body {
					t.Error("continued upload changed")
				}
				w.Header().Set("Link", "</fixture>; rel=preload")
				w.WriteHeader(http.StatusEarlyHints)
				_, _ = io.WriteString(w, `{"ok":true}`)
			}))
			for _, path := range []string{"accept", "reject", "accept"} {
				upload := &countedUpload{body: strings.NewReader(body)}
				req, _ := http.NewRequest("POST", base+"/v1/responses/"+path, upload)
				req.ContentLength = int64(len(body))
				req.Header.Set("Expect", "100-continue")
				var continues, hints atomic.Int32
				req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{Got1xxResponse: func(code int, header textproto.MIMEHeader) error {
					if code == 100 {
						continues.Add(1)
					}
					if code == 103 && header.Get("Link") == "</fixture>; rel=preload" {
						hints.Add(1)
					}
					return nil
				}}))
				resp, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(resp.Body)
				_ = resp.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				if path == "accept" {
					if resp.StatusCode != 200 || string(got) != `{"ok":true}` || continues.Load() != 1 || hints.Load() != 1 {
						t.Error("upstream informational responses changed")
					}
				} else if resp.StatusCode != 401 || string(got) != `{"error":"fixture-rejection"}` || upload.read.Load() != 0 || continues.Load() != 0 {
					t.Error("proxy changed rejection or triggered an unwanted upload")
				}
				select {
				case data := <-captures:
					capture := decodeCapturedPayload(t, data)
					if capture.StatusCode != resp.StatusCode || capture.ResponseBody != string(got) {
						t.Error("audit copy changed the upstream decision")
					}
				case <-time.After(2 * time.Second):
					t.Error("complete audit callback body not received before delivery deadline")
				}
			}
		})
	}
}

func TestUpstreamTruncationRemainsVisibleToClient(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		name := "http"
		if useTLS {
			name = "tls-connect"
		}
		t.Run(name, func(t *testing.T) {
			const partial = "data: {\"partial\":true}\n\n"
			client, base, captures := transparencyFixture(t, useTLS, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, partial)
				w.(http.Flusher).Flush()
				panic(http.ErrAbortHandler)
			}))
			resp, err := client.Get(base + "/v1/responses")
			if err != nil {
				t.Fatal(err)
			}
			got, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if string(got) != partial || readErr == nil {
				t.Error("proxy hid an upstream stream failure")
			}
			select {
			case data := <-captures:
				capture := decodeCapturedPayload(t, data)
				if capture.CaptureStatus != "error" || capture.ResponseBody != partial {
					t.Error("audit recorded a broken stream as complete")
				}
			case <-time.After(2 * time.Second):
				t.Error("complete audit callback body not received before delivery deadline")
			}
		})
	}
}

func TestOtherHTTPUpgradePreservesHeadersAndBufferedBytes(t *testing.T) {
	for _, viaUpstream := range []bool{false, true} {
		name := "direct"
		if viaUpstream {
			name = "upstream"
		}
		t.Run(name, func(t *testing.T) {
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("User-Agent") != "" || r.Header.Get("Authorization") != "Bearer fixture-only" || r.Header.Get("Upgrade") != "fixture-protocol" {
					t.Error("upgrade business headers changed")
				}
				if viaUpstream && !r.URL.IsAbs() {
					t.Error("upstream proxy did not receive an absolute request target")
				}
				if r.URL.RawQuery != "value=a%2Fb" {
					t.Error("upgrade query changed")
				}
				conn, rw, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer conn.Close()
				_, _ = io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture-protocol\r\nSet-Cookie: session=fixture; HttpOnly\r\n\r\nready")
				_, _ = io.Copy(conn, rw)
			}))
			defer origin.Close()
			target := strings.TrimPrefix(origin.URL, "http://")
			upstreamURL := ""
			if viaUpstream {
				target = "upgrade.fixture.invalid:80"
				upstreamURL = origin.URL
			}
			p, err := NewProxyServer("", upstreamURL, "", nil)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Shutdown(context.Background())
			proxy := httptest.NewServer(p)
			defer proxy.Close()
			conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
			_, _ = fmt.Fprintf(conn, "GET http://%s/v1/upgrade?value=a%%2Fb HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer fixture-only\r\nConnection: Upgrade\r\nUpgrade: fixture-protocol\r\n\r\nping", target, target)
			reader := bufio.NewReader(conn)
			resp, err := http.ReadResponse(reader, &http.Request{Method: "GET"})
			if err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != 101 || resp.Header.Get("Set-Cookie") != "session=fixture; HttpOnly" {
				t.Fatal("upgrade response changed")
			}
			data := make([]byte, len("readyping"))
			if _, err := io.ReadFull(reader, data); err != nil || string(data) != "readyping" {
				t.Fatalf("upgrade bytes lost: %q, %v", data, err)
			}
		})
	}
}
