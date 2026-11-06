package main

import (
	"bytes"
	"context"
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
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestOfficialCodexWebSocketThroughTLSProxy(t *testing.T) {
	cm, err := newCertManagerAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	origin := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/backend-api/accounts/check" {
			if r.ProtoMajor != 2 || r.Header.Get("Authorization") != "Bearer fixture-only" || r.Header.Get("Cookie") != "session=fixture" {
				t.Error("account validation protocol or credentials changed")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Set-Cookie", "session=refreshed; Secure; HttpOnly")
			_, _ = io.WriteString(w, `{"authenticated":true}`)
			return
		}
		if r.URL.Path == "/backend-api/codex/models" {
			if r.ProtoMajor != 2 {
				t.Error("model discovery must retain HTTP/2")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"models":[]}`)
			return
		}
		if r.Method == "POST" {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, `data: {"type":"response.completed","response":{"id":"sse-fixture","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`+"\n\n")
			return
		}
		if r.URL.Path == "/backend-api/codex/responses" && r.Header.Get("X-Reject") == "yes" {
			w.Header().Set("Retry-After", "7")
			http.Error(w, "fixture rejection", 429)
			return
		}
		controlSocket := r.URL.Path == "/backend-api/wham/remote/control/server"
		if (!controlSocket && r.URL.Path != "/backend-api/codex/responses") || r.Header.Get("Authorization") != "Bearer fixture-only" {
			t.Error("request changed")
		}
		up := websocket.Upgrader{Subprotocols: []string{"fixture"}, CheckOrigin: func(*http.Request) bool { return true }}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer c.Close()
		if controlSocket {
			if r.Header.Get("X-No-User-Agent") == "yes" && r.Header.Get("User-Agent") != "" {
				t.Error("proxy added a WebSocket User-Agent")
			}
			if r.Header.Get("Cookie") != "session=fixture" || r.ProtoMajor != 1 {
				t.Error("control socket authentication or protocol changed")
			}
			_ = c.WriteJSON(map[string]string{"type": "control.ready"})
			return
		}
		for {
			var request map[string]any
			if err := c.ReadJSON(&request); err != nil {
				return
			}
			if request["type"] != "response.create" {
				t.Error("request event changed")
			}
			_ = c.WriteControl(websocket.PingMessage, []byte("health"), time.Now().Add(time.Second))
			text := fmt.Sprintf(`{"type":"response.completed","response":{"id":"resp-%v","output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}`, request["input"])
			// Fragment one message across frames to exercise protocol reassembly.
			writer, err := c.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			_, _ = writer.Write([]byte(text[:20]))
			_, _ = writer.Write([]byte(text[20:]))
			_ = writer.Close()
		}
	}))
	origin.EnableHTTP2 = true
	origin.StartTLS()
	defer origin.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Host != "chatgpt.com:443" {
			t.Error("wrong CONNECT target")
			w.WriteHeader(400)
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
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go func() { _, _ = io.Copy(dest, rw) }()
		_, _ = io.Copy(conn, dest)
	}))
	defer upstream.Close()
	captures := make(chan CapturePayload, 4)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var event CapturePayload
		_ = json.NewDecoder(r.Body).Decode(&event)
		captures <- event
	}))
	defer receiver.Close()
	p, err := NewProxyServer("", upstream.URL, receiver.URL, cm)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Shutdown(context.Background())
	transport := p.client.Transport.(*http.Transport)
	roots := x509.NewCertPool()
	roots.AddCert(origin.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com"}
	p.websocketDialer.TLSClientConfig.RootCAs = roots
	p.websocketDialer.TLSClientConfig.ServerName = "example.com"
	// A real desktop starts with normal HTTPS discovery before opening sockets.
	// net/http initializes ALPN on this transport on first use.
	discovery, err := p.client.Get("https://chatgpt.com/backend-api/codex/models")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, discovery.Body)
	_ = discovery.Body.Close()
	if discovery.ProtoMajor != 2 {
		t.Fatal("discovery did not negotiate HTTP/2")
	}
	proxy := httptest.NewServer(p)
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	clientRoots := x509.NewCertPool()
	clientRoots.AddCert(cm.caCert)
	dialer := websocket.Dialer{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: clientRoots}, Subprotocols: []string{"fixture"}, HandshakeTimeout: 3 * time.Second}
	headers := http.Header{"Authorization": []string{"Bearer fixture-only"}, "Thread-Id": []string{"fixture-thread"}, "User-Agent": []string{"codex/fixture"}}
	// Startup/account traffic and model traffic share the same host and proxy.
	// Exercise both after HTTPS has initialized the HTTP/2 transport.
	controlHeaders := headers.Clone()
	controlHeaders.Set("Cookie", "session=fixture")
	accountReq, _ := http.NewRequest("GET", "https://chatgpt.com/backend-api/accounts/check", nil)
	accountReq.Header = controlHeaders.Clone()
	httpClient := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: clientRoots}}, Timeout: 3 * time.Second}
	defer httpClient.CloseIdleConnections()
	account, err := httpClient.Do(accountReq)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, account.Body)
	_ = account.Body.Close()
	if account.StatusCode != 200 || account.Header.Get("Set-Cookie") != "session=refreshed; Secure; HttpOnly" {
		t.Fatal("account validation response changed")
	}
	control, _, err := dialer.Dial("wss://chatgpt.com/backend-api/wham/remote/control/server", controlHeaders)
	if err != nil {
		t.Fatal(err)
	}
	_ = control.SetReadDeadline(time.Now().Add(3 * time.Second))
	var controlReady map[string]string
	if err := control.ReadJSON(&controlReady); err != nil {
		t.Fatal(err)
	}
	_ = control.Close()
	if controlReady["type"] != "control.ready" || len(captures) != 0 {
		t.Fatal("startup socket failed or was audited as model traffic")
	}
	noUserAgent := controlHeaders.Clone()
	noUserAgent["User-Agent"] = nil
	noUserAgent.Set("X-No-User-Agent", "yes")
	control, _, err = dialer.Dial("wss://chatgpt.com/backend-api/wham/remote/control/server", noUserAgent)
	if err != nil {
		t.Fatal(err)
	}
	_ = control.SetReadDeadline(time.Now().Add(3 * time.Second))
	if err := control.ReadJSON(&controlReady); err != nil {
		t.Fatal(err)
	}
	_ = control.Close()
	c, _, err := dialer.Dial("wss://chatgpt.com/backend-api/codex/responses", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Subprotocol() != "fixture" {
		t.Fatal("subprotocol lost")
	}
	for i := 0; i < 2; i++ {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		err = c.WriteJSON(map[string]any{"type": "response.create", "model": "fixture-model", "input": fmt.Sprintf("question-%d", i)})
		if err != nil {
			t.Fatal(err)
		}
		var reply map[string]any
		if err = c.ReadJSON(&reply); err != nil {
			t.Fatal(err)
		}
		if reply["type"] != "response.completed" {
			t.Fatal("response changed")
		}
		select {
		case event := <-captures:
			if event.StatusCode != 101 || event.CaptureStatus != "complete" || !strings.Contains(event.RequestBody, fmt.Sprintf("question-%d", i)) || !strings.Contains(event.ResponseBody, "total_tokens") {
				t.Fatalf("bad capture: %+v", event)
			}
			address, addressErr := url.Parse(event.Address)
			if event.Transport != "wss" || event.BodyFormat != "ws-messages-v1" || addressErr != nil || address.Scheme != "wss" || address.Hostname() != "chatgpt.com" || address.Path != "/backend-api/codex/responses" {
				t.Fatalf("WSS metadata lost: %s %s %s", event.Transport, event.BodyFormat, event.Address)
			}
			if event.RequestHeaders["authorization"] != "Bearer [REDACTED]" {
				t.Fatal("credential leaked")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("must capture each response without waiting for socket close")
		}
	}
	_ = c.Close()

	sse, err := httpClient.Post("https://chatgpt.com/backend-api/codex/responses", "application/json", bytes.NewBufferString(`{"model":"fixture-model","input":"sse-question"}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(io.Discard, sse.Body)
	_ = sse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-captures:
		if event.Transport != "https" || event.BodyFormat != "sse" || event.StatusCode != 200 || !strings.Contains(event.RequestBody, "sse-question") || !strings.Contains(event.ResponseBody, "sse-fixture") {
			t.Fatal("HTTPS/SSE capture lost")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("missing HTTPS/SSE capture")
	}
	rejected := headers.Clone()
	rejected.Set("X-Reject", "yes")
	_, resp, err := dialer.Dial("wss://chatgpt.com/backend-api/codex/responses", rejected)
	if err == nil || resp == nil || resp.StatusCode != 429 || resp.Header.Get("Retry-After") != "7" {
		t.Fatalf("rejected upgrade changed: %v %v", resp, err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(body), "fixture rejection") {
		t.Fatal("rejection body lost")
	}
}

func TestWebSocketCaptureInterleavedStreamsAndDisconnect(t *testing.T) {
	p := &ProxyServer{callbackURL: "fixture", eventQueue: make(chan CapturePayload, 10)}
	req := httptest.NewRequest("GET", "http://localhost/v1/responses", nil)
	c := &responsesSocketCapture{proxy: p, request: req, responseHeaders: make(http.Header), pending: make(map[string][]*socketResponse)}
	c.observe([]byte(`{"type":"response.create","stream_id":"a","input":"first"}`), true)
	c.observe([]byte(`{"type":"response.create","stream_id":"b","input":"second"}`), true)
	c.observe([]byte(`{"type":"response.completed","stream_id":"b","response":{"id":"b"}}`), false)
	c.observe([]byte(`{"type":"response.completed","stream_id":"a","response":{"id":"a"}}`), false)
	for _, prompt := range []string{"second", "first"} {
		select {
		case e := <-p.eventQueue:
			if !strings.Contains(e.RequestBody, prompt) || e.CaptureStatus != "complete" {
				t.Fatal("streams mixed")
			}
		default:
			t.Fatal("missing completed response")
		}
	}
	c.observe([]byte(`{"type":"response.create","input":"interrupted"}`), true)
	c.finish()
	e := <-p.eventQueue
	if e.CaptureStatus != "error" || e.TruncatedReason != "websocket_closed_before_response_completed" {
		t.Fatal("interrupted response silently lost")
	}
	c.observe([]byte(`{"type":"response.create","input":"large"}`), true)
	c.observe([]byte(strings.Repeat("x", websocketCaptureLimit+1)), false)
	e = <-p.eventQueue
	if e.CaptureStatus != "truncated" {
		t.Fatal("oversized message not marked")
	}
}

func TestChatGPTControlPlaneIsNotRecorded(t *testing.T) {
	p := &ProxyServer{}
	for _, path := range []string{"/backend-api/codex/models", "/backend-api/accounts/check", "/backend-api/wham/remote/control/server"} {
		if p.shouldAuditHTTP(httptest.NewRequest("GET", "https://chatgpt.com"+path, nil)) {
			t.Fatalf("must not record %s", path)
		}
	}
	if !p.shouldAuditHTTP(httptest.NewRequest("POST", "https://chatgpt.com/backend-api/codex/responses", nil)) {
		t.Fatal("model route omitted")
	}
	if p.spoolFilePath != "" {
		t.Fatal("embedded/test proxy must not access the user's spool")
	}
}

func TestWebSocketCaptureRecoversAfterInvalidMessage(t *testing.T) {
	p := &ProxyServer{callbackURL: "fixture", eventQueue: make(chan CapturePayload, 10)}
	c := &responsesSocketCapture{proxy: p, request: httptest.NewRequest("GET", "http://localhost/v1/responses", nil), responseHeaders: make(http.Header), pending: make(map[string][]*socketResponse)}
	c.observe([]byte(`{"type":"response.create","input":"lost"}`), true)
	c.observe([]byte(`invalid`), false)
	<-p.eventQueue
	diagnostic := <-p.eventQueue
	if diagnostic.Attribution != "connection" || !strings.Contains(diagnostic.ResponseBody, "invalid") {
		t.Fatal("unattributed raw fault lost")
	}
	c.observe([]byte(`{"type":"response.create","stream_id":"fresh","input":"recovered"}`), true)
	c.observe([]byte(`{"type":"response.completed","stream_id":"fresh","response":{"id":"new"}}`), false)
	select {
	case e := <-p.eventQueue:
		if e.CaptureStatus != "complete" || !strings.Contains(e.RequestBody, "recovered") {
			t.Fatal("wrong recovery")
		}
	default:
		t.Fatal("new valid request was silently lost after invalid message")
	}
}

func socketFixture() (*ProxyServer, *responsesSocketCapture) {
	p := &ProxyServer{callbackURL: "fixture", eventQueue: make(chan CapturePayload, 200)}
	return p, &responsesSocketCapture{proxy: p, request: httptest.NewRequest("GET", "http://localhost/v1/responses", nil), responseHeaders: make(http.Header), pending: make(map[string][]*socketResponse)}
}
func TestSocketRawAttributionDuplicatesAndDraining(t *testing.T) {
	p, c := socketFixture()
	first := []byte(" {\n\"type\":\"response.create\",\"stream_id\":\"a\",\"input\":\"中文😀\" } ")
	c.observe(first, true)
	c.observe([]byte(`{"type":"response.create","stream_id":"a","input":"second"}`), true)
	c.observe([]byte(`{"type":"response.created","stream_id":"a","response":{"id":"one"}}`), false)
	c.observe([]byte(`{"type":"response.output_text.delta","stream_id":"a","response_id":"one","sequence_number":1,"delta":"text"}`), false)
	terminal := []byte(`{"type":"response.completed","stream_id":"a","response":{"id":"one"}}`)
	c.observe(terminal, false)
	e := <-p.eventQueue
	if e.RequestBody != string(first) || e.BodyFormat != "ws-messages-v1" || strings.Contains(e.ResponseBody, "data: ") {
		t.Fatal("raw payload changed")
	}
	var raw struct {
		Messages []socketMessage `json:"messages"`
	}
	if err := json.Unmarshal([]byte(e.ResponseBody), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Messages) != 4 || raw.Messages[0].Payload != string(first) || raw.Messages[0].Direction != "client" || raw.Messages[3].Payload != string(terminal) {
		t.Fatal("message bytes or directions lost")
	}
	c.observe(terminal, false)
	if len(p.eventQueue) != 0 {
		t.Fatal("duplicate completion consumed next request")
	}
	c.observe([]byte(`{"type":"response.failed","stream_id":"a","response":{"id":"two","error":{"message":"failed"}}}`), false)
	if e = <-p.eventQueue; e.CaptureStatus != "error" || !strings.Contains(e.RequestBody, "second") {
		t.Fatal("failed response attribution")
	}
	c.observe([]byte(`{"type":"response.create","stream_id":"old","input":"interrupted"}`), true)
	c.observe([]byte(`bad json`), false)
	<-p.eventQueue
	<-p.eventQueue
	c.observe([]byte(`{"type":"response.create","stream_id":"old","input":"later"}`), true)
	c.observe([]byte(`{"type":"response.completed","stream_id":"old","response":{"id":"retired"}}`), false)
	if len(p.eventQueue) != 0 {
		t.Fatal("quarantined old response was assigned to later request")
	}
	c.observe([]byte(`{"type":"response.incomplete","stream_id":"old","response":{"id":"later","status":"incomplete"}}`), false)
	if e = <-p.eventQueue; e.CaptureStatus != "truncated" || !strings.Contains(e.RequestBody, "later") {
		t.Fatal("drained lane did not resume")
	}
	if c.bytes != 0 || c.count != 0 {
		t.Fatal("capture accounting leaked")
	}
}
func TestSocketConnectionErrorAndPendingBudget(t *testing.T) {
	p, c := socketFixture()
	for _, lane := range []string{"a", "b"} {
		c.observe([]byte(fmt.Sprintf(`{"type":"response.create","stream_id":"%s","input":"q"}`, lane)), true)
	}
	fault := []byte(`{"type":"error","status":400,"error":{"code":"invalid_stream_id","message":"connection error"}}`)
	c.observe(fault, false)
	e := <-p.eventQueue
	if e.Attribution != "connection" || e.RequestBody != "" || !strings.Contains(e.ResponseBody, "connection error") {
		t.Fatal("connection error must not become an arbitrary lane reply")
	}
	for i := 0; i < 2; i++ {
		if (<-p.eventQueue).CaptureStatus != "truncated" {
			t.Fatal("affected lane not marked uncertain")
		}
	}
	c.observe(fault, false)
	if len(p.eventQueue) != 0 {
		t.Fatal("duplicate connection error")
	}
	p, c = socketFixture()
	for i := 0; i < 65; i++ {
		c.observe([]byte(fmt.Sprintf(`{"type":"response.create","input":"q%d"}`, i)), true)
	}
	if c.count != 64 || c.bytes != 0 || !c.frozen || len(c.pending) != 1 {
		t.Fatal("pending state is not bounded")
	}
	var boundary CapturePayload
	for len(p.eventQueue) > 0 {
		boundary = <-p.eventQueue
	}
	if boundary.TruncatedReason != "websocket_pending_limit_reconnect_required" {
		t.Fatal("unrecoverable boundary must be explicit")
	}
	c.finish()
	if c.count != 0 || len(c.pending) != 0 {
		t.Fatal("disconnect did not release state")
	}
}
func TestSocketMessageBudgetAndQueueLimits(t *testing.T) {
	p, c := socketFixture()
	c.observe([]byte(`{"type":"response.create","stream_id":"a","input":"q"}`), true)
	for i := 0; i < 8192; i++ {
		c.observe([]byte(`{"type":"response.output_text.delta","stream_id":"a","delta":"x"}`), false)
	}
	if c.bytes != 0 || c.count != 1 || !c.pending["a"][0].abandoned {
		t.Fatal("message count was not bounded")
	}
	c.observe([]byte(`{"type":"response.create","stream_id":"b","input":"fresh"}`), true)
	c.observe([]byte(`{"type":"response.completed","stream_id":"b","response":{"id":"fresh"}}`), false)
	var last CapturePayload
	for len(p.eventQueue) > 0 {
		last = <-p.eventQueue
	}
	if last.CaptureStatus != "complete" {
		t.Fatal("message count fault disabled independent lane")
	}
	p.queuedBytes = auditQueueBudget
	payload := CapturePayload{RequestBody: "synthetic"}
	if p.reserveQueue(&payload) {
		t.Fatal("queue byte budget ignored")
	}
	p.spoolFilePath = t.TempDir() + "/spool.jsonl"
	f, err := os.Create(p.spoolFilePath)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Truncate(auditSpoolBudget)
	_ = f.Close()
	p.spoolEvent(payload)
	info, _ := os.Stat(p.spoolFilePath)
	if info.Size() != auditSpoolBudget {
		t.Fatal("spool byte budget ignored")
	}
}

// A fragmented message must reach the client before the origin finishes it.
// This deadlocks with the old read-entire-message-before-forwarding path.
func TestSocketStreamingFirstSegmentAndLargePayload(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	payload := []byte(`{"type":"response.completed","response":{"id":"large","output":[],"padding":"` + strings.Repeat("x", 6*1024*1024) + `"}}`)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		socket, err := up.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer socket.Close()
		if _, _, err := socket.ReadMessage(); err != nil {
			return
		}
		writer, err := socket.NextWriter(websocket.TextMessage)
		if err != nil {
			return
		}
		_, _ = writer.Write(payload[:16384])
		select {
		case <-release:
		case <-time.After(3 * time.Second):
			t.Error("first segment was buffered by audit")
		}
		_, _ = writer.Write(payload[16384:])
		_ = writer.Close()
		_, _, _ = socket.ReadMessage()
	}))
	defer origin.Close()
	p := &ProxyServer{websocketDialer: &websocket.Dialer{}, callbackURL: "fixture", eventQueue: make(chan CapturePayload, 10)}
	target := strings.TrimPrefix(origin.URL, "http://")
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { p.proxyWebSocket(w, r, target, "http") }))
	defer proxy.Close()
	socket, _, err := websocket.DefaultDialer.Dial(strings.Replace(proxy.URL, "http://", "ws://", 1)+"/v1/responses", http.Header{"User-Agent": []string{"codex/fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	_ = socket.SetReadDeadline(time.Now().Add(4 * time.Second))
	started := time.Now()
	if err := socket.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","input":"q"}`)); err != nil {
		t.Fatal(err)
	}
	_, reader, err := socket.NextReader()
	if err != nil {
		t.Fatal(err)
	}
	prefix := make([]byte, 128)
	if _, err := io.ReadFull(reader, prefix); err != nil {
		t.Fatal(err)
	}
	first := time.Since(started)
	once.Do(func() { close(release) })
	suffix, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(append(prefix, suffix...), payload) {
		t.Fatal("large forwarded bytes changed")
	}
	select {
	case event := <-p.eventQueue:
		var raw struct {
			Messages []socketMessage `json:"messages"`
		}
		if err := json.Unmarshal([]byte(event.ResponseBody), &raw); err != nil {
			t.Fatal(err)
		}
		if len(raw.Messages) != 2 || raw.Messages[1].Payload != string(payload) || event.CaptureStatus != "complete" {
			t.Fatal("large raw application payload changed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("large capture missing")
	}
	t.Logf("6 MiB fragmented WS: first segment %s, complete transfer %s", first, time.Since(started))
}
func TestSocketLongConnectionStateBound(t *testing.T) {
	p, c := socketFixture()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	started := time.Now()
	for i := 0; i < 5000; i++ {
		c.observe([]byte(`{"type":"response.create","input":"fixture"}`), true)
		c.observe([]byte(fmt.Sprintf(`{"type":"response.created","response":{"id":"r%d"}}`, i)), false)
		c.observe([]byte(fmt.Sprintf(`{"type":"response.completed","response":{"id":"r%d","usage":{"total_tokens":12}}}`, i)), false)
		<-p.eventQueue
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	if c.count != 0 || c.bytes != 0 || len(c.retired) > 1024 || len(c.retiredOrder) > 1024 {
		t.Fatal("long socket retained unbounded response state")
	}
	t.Logf("5000 WS requests: elapsed=%s live heap before=%d after=%d retired=%d", time.Since(started), before.HeapAlloc, after.HeapAlloc, len(c.retired))
}

func TestSocketBoundResponseWithoutLaneAndRetiredWindow(t *testing.T) {
	p, c := socketFixture()
	for _, lane := range []string{"a", "b"} {
		c.observe([]byte(fmt.Sprintf(`{"type":"response.create","stream_id":"%s","input":"%s"}`, lane, lane)), true)
		c.observe([]byte(fmt.Sprintf(`{"type":"response.created","stream_id":"%s","response":{"id":"%s"}}`, lane, lane)), false)
	}
	for _, id := range []string{"b", "a"} {
		c.observe([]byte(fmt.Sprintf(`{"type":"response.completed","response":{"id":"%s"}}`, id)), false)
		e := <-p.eventQueue
		if !strings.Contains(e.RequestBody, `"input":"`+id+`"`) {
			t.Fatal("explicit response ID crossed lanes")
		}
	}
	c.requireCreated = true
	c.observe([]byte(`{"type":"response.create","input":"new"}`), true)
	c.observe([]byte(`{"type":"response.completed","response":{"id":"old-evicted"}}`), false)
	e := <-p.eventQueue
	if e.CaptureStatus != "truncated" || e.TruncatedReason != "websocket_response_attribution_requires_created" {
		t.Fatal("uncertain terminal was charged to new request")
	}
	c.observe([]byte(`{"type":"response.created","response":{"id":"new"}}`), false)
	c.observe([]byte(`{"type":"response.completed","response":{"id":"new"}}`), false)
	if c.count != 0 || len(p.eventQueue) != 0 {
		t.Fatal("uncertain capture did not drain once")
	}
	c.observe([]byte(`{"type":"response.create","input":"healthy"}`), true)
	c.observe([]byte(`{"type":"response.created","response":{"id":"healthy"}}`), false)
	c.observe([]byte(`{"type":"response.completed","response":{"id":"healthy"}}`), false)
	if e = <-p.eventQueue; e.CaptureStatus != "complete" {
		t.Fatal("reliable creation boundary failed to restore capture")
	}
}
