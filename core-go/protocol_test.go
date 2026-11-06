package main

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Note: roundTripFunc is already declared in proxy_test.go

func TestProtocolCancellationPropagated(t *testing.T) {
	p, _ := NewProxyServer("", "", "", nil)
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	var upstreamCancelled atomic.Bool

	p.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(entered)
		select {
		case <-r.Context().Done():
			upstreamCancelled.Store(true)
		case <-release:
		}
		return nil, fmt.Errorf("synthetic end")
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req := httptest.NewRequest("POST", "/v1:generateContent", nil).WithContext(ctx)
	server, client := net.Pipe()
	defer server.Close()

	go func() {
		p.processDecryptedRequest(server, req, "daily-cloudcode-pa.googleapis.com:443")
		close(done)
	}()

	<-entered
	cancel() // cancel the downstream request context
	client.Close()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
	}
	close(release)
	<-done

	if !upstreamCancelled.Load() {
		t.Fatal("expected upstream context to be cancelled when client request context was cancelled")
	}
}

func TestProtocol100ContinueHandled(t *testing.T) {
	p, _ := NewProxyServer("", "", "", nil)
	p.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Expect") != "100-continue" {
			t.Error("Expect header was changed")
		}
		trace := httptrace.ContextClientTrace(r.Context())
		if err := trace.Got1xxResponse(100, nil); err != nil {
			return nil, err
		}

		body, _ := io.ReadAll(r.Body)
		if string(body) != "ok" {
			return nil, fmt.Errorf("unexpected body: %s", string(body))
		}
		return &http.Response{
			StatusCode: 200,
			ProtoMajor: 1,
			ProtoMinor: 1,
			Header:     make(http.Header),
			Body:       io.NopCloser(bytes.NewReader([]byte("success"))),
		}, nil
	})

	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	client.SetDeadline(time.Now().Add(1 * time.Second))

	go func() {
		request, err := http.ReadRequest(bufio.NewReader(server))
		if err == nil {
			p.processDecryptedRequest(server, request, "daily-cloudcode-pa.googleapis.com:443")
		}
	}()

	fmt.Fprint(client, "POST /v1:generateContent HTTP/1.1\r\nHost: daily-cloudcode-pa.googleapis.com\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n")

	// 1. Client should receive 100 Continue first
	reader := bufio.NewReader(client)
	resp100, err := http.ReadResponse(reader, &http.Request{Method: "POST"})
	if err != nil {
		t.Fatalf("failed to read 100 Continue: %v", err)
	}
	if resp100.StatusCode != 100 {
		t.Fatalf("expected 100 Continue, got %d", resp100.StatusCode)
	}

	// 2. Now send the body
	client.Write([]byte("ok"))

	// 3. Client receives final 200 OK
	resp200, err := http.ReadResponse(reader, &http.Request{Method: "POST"})
	if err != nil {
		t.Fatalf("failed to read final response: %v", err)
	}
	if resp200.StatusCode != 200 {
		t.Fatalf("expected 200 OK, got %d", resp200.StatusCode)
	}
}

func TestProtocolDeflateZlibDecoded(t *testing.T) {
	var b bytes.Buffer
	w := zlib.NewWriter(&b)
	expectedJSON := `{"usageMetadata":{"totalTokenCount":12}}`
	w.Write([]byte(expectedJSON))
	w.Close()

	result := decodeBody(b.Bytes(), "deflate")
	if result != expectedJSON {
		t.Fatalf("expected zlib payload to decode to %q, got %q", expectedJSON, result)
	}
}

func TestProtocolTransportFailuresCaptured(t *testing.T) {
	var captures atomic.Int32
	var capturedCode atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captures.Add(1)
		var p CapturePayload
		_ = json.NewDecoder(r.Body).Decode(&p)
		capturedCode.Store(int32(p.StatusCode))
		w.WriteHeader(200)
	}))
	defer receiver.Close()

	p, _ := NewProxyServer("", "", receiver.URL, nil)
	p.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("synthetic upstream failure")
	})

	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	client.SetDeadline(time.Now().Add(time.Second))

	done := make(chan struct{})
	go func() {
		p.processDecryptedRequest(server, httptest.NewRequest("POST", "/v1:generateContent", nil), "daily-cloudcode-pa.googleapis.com:443")
		server.Close()
		close(done)
	}()

	response, err := http.ReadResponse(bufio.NewReader(client), &http.Request{Method: "POST"})
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	<-done

	if response.StatusCode != 502 {
		t.Fatalf("expected client 502, got %d", response.StatusCode)
	}

	// Give async event goroutine a moment to deliver to receiver
	time.Sleep(100 * time.Millisecond)

	if captures.Load() != 1 {
		t.Fatalf("expected 1 capture event for 502 failure, got %d", captures.Load())
	}
	if capturedCode.Load() != 502 {
		t.Fatalf("expected captured event status code 502, got %d", capturedCode.Load())
	}
}

func TestRealClientSocketDisconnectCancelsUpstream(t *testing.T) {
	p, _ := NewProxyServer("", "", "", nil)
	entered := make(chan struct{})
	var upstreamCancelled atomic.Bool

	p.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		// A real transport consumes the upload before waiting for the response.
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			return nil, err
		}
		_ = r.Body.Close()

		close(entered)
		select {
		case <-r.Context().Done():
			upstreamCancelled.Store(true)
			return nil, r.Context().Err()
		case <-time.After(3 * time.Second):
			return nil, fmt.Errorf("timeout waiting for cancellation")
		}
	})

	// 1. Establish a real local TCP socket pair
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	clientConnChan := make(chan net.Conn, 1)
	go func() {
		c, err := net.Dial("tcp", l.Addr().String())
		if err == nil {
			clientConnChan <- c
		}
	}()

	serverConn, err := l.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer serverConn.Close()

	clientConn := <-clientConnChan
	defer clientConn.Close()

	// 2. Client sends a POST request with body
	go func() {
		fmt.Fprintf(clientConn, "POST /v1:generateContent HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\n\r\nhello")
	}()

	stream := &mitmClientConn{Conn: serverConn, reader: bufio.NewReader(serverConn)}
	req, err := stream.readRequest()
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		p.processDecryptedRequest(stream, req, "example.com:443")
		close(done)
	}()

	// 3. Wait until upstream RoundTrip has entered
	<-entered

	// 4. Abruptly close the physical client TCP connection!
	_ = clientConn.Close()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("processDecryptedRequest took too long to abort on client disconnect")
	}

	if !upstreamCancelled.Load() {
		t.Fatal("expected upstream context to be cancelled when client TCP socket was closed")
	}
}

func TestEventQueueRetryAndSpoolRecovery(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "prompt-lens-spool-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	spoolPath := filepath.Join(tmpDir, "spool.jsonl")

	var received atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p CapturePayload
		_ = json.NewDecoder(r.Body).Decode(&p)
		if p.EventID == "evt-spool-1" {
			received.Add(1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer receiver.Close()

	p, err := NewProxyServer("", "", receiver.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Shutdown(context.Background())
	p.SetSpoolFilePath(spoolPath)

	payload := CapturePayload{
		SchemaVersion:  "2.0.0",
		EventID:        "evt-spool-1",
		RequestID:      "req-spool-1",
		Sequence:       1,
		CoreInstanceID: "inst-1",
		CaptureStatus:  "complete",
		URLPath:        "/test",
		Method:         "POST",
		StatusCode:     200,
	}

	// 1. spoolEvent persists payload to disk
	p.spoolEvent(payload)

	// Verify file was created
	content, err := os.ReadFile(spoolPath)
	if err != nil {
		t.Fatalf("expected spool file to be written: %v", err)
	}
	if !bytes.Contains(content, []byte("evt-spool-1")) {
		t.Fatalf("spool file does not contain event ID: %s", string(content))
	}

	// 2. replaySpool reads from disk and re-enqueues to eventQueue
	p.replaySpool()

	// Spool file should have been removed after reading
	if _, err := os.Stat(spoolPath); !os.IsNotExist(err) {
		t.Fatal("expected spool file to be deleted after replay")
	}

	// Worker will consume from eventQueue and deliver to receiver
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if received.Load() > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if received.Load() == 0 {
		t.Fatal("expected replayed event to be delivered to receiver")
	}
}

func TestHostNormalizationAndHeadersPreserved(t *testing.T) {
	p, _ := NewProxyServer("", "", "", nil)

	var recordedHost string
	var recordedAcceptEncoding string
	var recordedTE string

	p.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		recordedHost = r.Host
		recordedAcceptEncoding = r.Header.Get("Accept-Encoding")
		recordedTE = r.Header.Get("TE")
		return &http.Response{
			StatusCode: 200,
			ProtoMajor: 1,
			ProtoMinor: 1,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("ok")),
		}, nil
	})

	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	clientReq := httptest.NewRequest("POST", "/v1internal:loadCodeAssist", strings.NewReader("{}"))
	clientReq.Host = "daily-cloudcode-pa.googleapis.com"
	clientReq.Header.Set("Accept-Encoding", "gzip")
	clientReq.Header.Set("TE", "trailers")
	clientReq.Close = true

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.processDecryptedRequest(server, clientReq, "daily-cloudcode-pa.googleapis.com:443")
	}()

	// Drain response on client side
	go func() {
		_, _ = io.ReadAll(client)
	}()
	<-done

	if recordedHost != "daily-cloudcode-pa.googleapis.com" {
		t.Fatalf("expected pure Host 'daily-cloudcode-pa.googleapis.com', got %q", recordedHost)
	}
	if recordedAcceptEncoding != "gzip" {
		t.Fatalf("expected Accept-Encoding 'gzip' to be preserved, got %q", recordedAcceptEncoding)
	}
	if recordedTE != "trailers" {
		t.Fatalf("expected TE 'trailers' to be preserved, got %q", recordedTE)
	}
}
