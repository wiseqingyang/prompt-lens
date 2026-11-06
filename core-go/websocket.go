package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const websocketCaptureLimit = 8 * 1024 * 1024

func isWebSocketRequest(r *http.Request) bool { return websocket.IsWebSocketUpgrade(r) }

func isResponsesPath(path string) bool {
	path = strings.TrimSuffix(path, "/")
	return path == "/v1/responses" || path == "/backend-api/codex/responses" || path == "/responses"
}

// A decrypted CONNECT already owns a socket, while ordinary HTTP uses the
// server's ResponseWriter. Both use the same WebSocket upgrade implementation.
type connResponseWriter struct {
	conn   net.Conn
	reader *bufio.Reader
	header http.Header
	wrote  bool
}

func newConnResponseWriter(conn net.Conn) *connResponseWriter {
	reader := bufio.NewReader(conn)
	if stream, ok := conn.(*mitmClientConn); ok {
		reader = stream.reader
	}
	return &connResponseWriter{conn: conn, reader: reader, header: make(http.Header)}
}
func (w *connResponseWriter) Header() http.Header { return w.header }
func (w *connResponseWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	w.wrote = true
	// Failed upgrades close this CONNECT connection, so a close-delimited body
	// is valid and avoids buffering an upstream error page.
	w.header.Set("Connection", "close")
	_, _ = fmt.Fprintf(w.conn, "HTTP/1.1 %d %s\r\n", code, http.StatusText(code))
	_ = w.header.Write(w.conn)
	_, _ = io.WriteString(w.conn, "\r\n")
}
func (w *connResponseWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(200)
	}
	return w.conn.Write(b)
}
func (w *connResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(w.reader, bufio.NewWriter(w.conn)), nil
}

func (p *ProxyServer) proxyWebSocket(w http.ResponseWriter, req *http.Request, target, scheme string) {
	dialer := *p.websocketDialer
	dialer.Subprotocols = websocket.Subprotocols(req)
	headers := req.Header.Clone()
	if _, present := headers["User-Agent"]; !present {
		headers["User-Agent"] = nil
	}
	stripHopHeaders(headers)
	for _, k := range []string{"Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions", "Sec-WebSocket-Protocol"} {
		headers.Del(k)
	}
	headers.Set("Host", req.Host)
	wsScheme := "ws"
	if scheme == "https" {
		wsScheme = "wss"
	}
	u := &url.URL{Scheme: wsScheme, Host: target, Path: req.URL.Path, RawPath: req.URL.RawPath, RawQuery: req.URL.RawQuery}
	upstream, response, err := dialer.DialContext(req.Context(), u.String(), headers)
	if err != nil {
		if response != nil {
			defer response.Body.Close()
			for k, vv := range response.Header {
				for _, v := range vv {
					w.Header().Add(k, v)
				}
			}
			stripHopHeaders(w.Header())
			w.WriteHeader(response.StatusCode)
			_, _ = io.Copy(w, response.Body)
		} else {
			http.Error(w, "WebSocket upstream connection failed", http.StatusBadGateway)
		}
		return
	}
	defer upstream.Close()
	responseHeaders := response.Header.Clone()
	stripHopHeaders(responseHeaders)
	for _, k := range []string{"Sec-WebSocket-Accept", "Sec-WebSocket-Extensions", "Sec-WebSocket-Protocol"} {
		responseHeaders.Del(k)
	}
	upgrader := websocket.Upgrader{HandshakeTimeout: 15 * time.Second, CheckOrigin: func(*http.Request) bool { return true }}
	if protocol := upstream.Subprotocol(); protocol != "" {
		upgrader.Subprotocols = []string{protocol}
	}
	downstream, err := upgrader.Upgrade(w, req, responseHeaders)
	if err != nil {
		return
	}
	defer downstream.Close()
	var audit *responsesSocketCapture
	if p.shouldAuditHTTP(req) && isResponsesPath(req.URL.Path) {
		audit = &responsesSocketCapture{proxy: p, request: req.Clone(req.Context()), responseHeaders: response.Header.Clone(),
			pending: make(map[string][]*socketResponse), connectionID: generateID(), address: sanitizeURL(u.String()), transport: wsScheme}
	}
	// Control frames are relayed too. WriteControl may run concurrently with the
	// single data writer, as required by the WebSocket library.
	relayControls := func(src, dst *websocket.Conn) {
		src.SetPingHandler(func(s string) error {
			return dst.WriteControl(websocket.PingMessage, []byte(s), time.Now().Add(5*time.Second))
		})
		src.SetPongHandler(func(s string) error {
			return dst.WriteControl(websocket.PongMessage, []byte(s), time.Now().Add(5*time.Second))
		})
		src.SetCloseHandler(func(code int, s string) error {
			return dst.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, s), time.Now().Add(5*time.Second))
		})
	}
	relayControls(downstream, upstream)
	relayControls(upstream, downstream)
	copyMessages := func(dst, src *websocket.Conn, fromClient bool) {
		for {
			kind, reader, err := src.NextReader()
			if err != nil {
				return
			}
			// Forward each chunk immediately. Capture is a bounded tee, never a
			// prerequisite for writing the first upstream/downstream frame.
			writer, err := dst.NextWriter(kind)
			if err != nil {
				return
			}
			var copy bodyCapture
			source := reader
			if audit != nil && kind == websocket.TextMessage {
				source = io.TeeReader(reader, &copy)
			}
			_, err = io.Copy(writer, source)
			// Register a complete client message before releasing the final frame:
			// the origin may respond immediately when Close flushes that frame.
			if err == nil && audit != nil && kind == websocket.TextMessage && fromClient {
				data, total := copy.snapshot()
				audit.observeMessage(data, true, total > websocketCaptureLimit)
			}
			closeErr := writer.Close()
			if err == nil && closeErr == nil && audit != nil && kind == websocket.TextMessage && !fromClient {
				data, total := copy.snapshot()
				audit.observeMessage(data, false, total > websocketCaptureLimit)
			}
			if err != nil || closeErr != nil {
				return
			}
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		copyMessages(upstream, downstream, true)
		_ = upstream.Close()
		_ = downstream.Close()
	}()
	copyMessages(downstream, upstream, false)
	_ = downstream.Close()
	_ = upstream.Close()
	<-done
	if audit != nil {
		audit.finish()
	}
}

type socketMessage struct {
	Direction string `json:"direction"`
	Sequence  int64  `json:"sequence"`
	Payload   string `json:"payload"`
}
type socketResponse struct {
	requestID  string
	responseID string
	request    []byte
	messages   []socketMessage
	size       int
	started    time.Time
	wire       int64
	abandoned  bool
}
type responsesSocketCapture struct {
	mu                               sync.Mutex
	proxy                            *ProxyServer
	request                          *http.Request
	responseHeaders                  http.Header
	pending                          map[string][]*socketResponse
	bytes                            int
	count                            int
	sequence                         int64
	connectionID, address, transport string
	// Bounded recently retired IDs prevent duplicate terminal events consuming
	// the next queued request. An abandoned lane drains before it can be reused.
	retired             map[string]bool
	retiredOrder        []string
	lastConnectionError string
	frozen              bool
	requireCreated      bool
}

func (c *responsesSocketCapture) observe(data []byte, fromClient bool) {
	c.observeMessage(data, fromClient, len(data) > websocketCaptureLimit)
}
func (c *responsesSocketCapture) observeMessage(data []byte, fromClient, oversized bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sequence++
	if c.frozen {
		return
	}
	if c.connectionID == "" {
		c.connectionID = generateID()
	}
	var event struct {
		Type       string `json:"type"`
		StreamID   string `json:"stream_id"`
		ResponseID string `json:"response_id"`
		Response   struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"response"`
	}
	if oversized || json.Unmarshal(data, &event) != nil {
		c.abandon("websocket_message_exceeded_budget_or_invalid_json")
		c.diagnostic(data, "truncated", "websocket_message_exceeded_budget_or_invalid_json", fromClient)
		return
	}
	lane := event.StreamID
	id := event.ResponseID
	if event.Response.ID != "" {
		id = event.Response.ID
	}
	if len(lane) > 256 || len(id) > 1024 {
		c.abandon("websocket_identifier_exceeded_budget")
		c.diagnostic(data, "metadata_only", "websocket_identifier_exceeded_budget", fromClient)
		return
	}
	if fromClient {
		if event.Type != "response.create" {
			return
		}
		c.lastConnectionError = ""
		if c.count >= 64 || c.bytes+len(data) > websocketCaptureLimit {
			c.abandon("websocket_capture_budget_exceeded")
		}
		// After a FIFO gap caused by the count limit, attribution cannot be
		// recovered on this socket. Report that boundary once; a new connection
		// gets a fresh capture state. Other budget faults can drain tombstones.
		if c.count >= 64 {
			c.diagnostic(data, "metadata_only", "websocket_pending_limit_reconnect_required", true)
			c.frozen = true
			return
		}
		item := &socketResponse{requestID: generateID(), request: append([]byte(nil), data...), started: time.Now(), wire: int64(len(data))}
		item.messages = []socketMessage{{"client", c.sequence, string(data)}}
		item.size = len(data)
		c.pending[lane] = append(c.pending[lane], item)
		c.bytes += item.size
		c.count++
		return
	}
	// Missing stream_id on error is a connection diagnostic, not a default-lane reply.
	if event.Type == "error" && lane == "" && id == "" {
		fingerprint := sha256.Sum256(data)
		if c.lastConnectionError != string(fingerprint[:]) {
			c.diagnostic(data, "error", "websocket_connection_error_unattributed")
			c.lastConnectionError = string(fingerprint[:])
		}
		c.abandon("websocket_connection_error_unattributed")
		return
	}
	if id != "" && c.retired[id] {
		return
	}
	// An explicit response ID already bound by response.created takes precedence
	// over lane position, including events that omit stream_id.
	if id != "" {
		for boundLane, queue := range c.pending {
			if len(queue) > 0 && queue[0].responseID == id {
				lane = boundLane
				break
			}
		}
	}
	queue := c.pending[lane]
	if len(queue) == 0 {
		return
	}
	item := queue[0]
	// Once the bounded retired-ID window rolls over, terminal-only assignment
	// cannot distinguish an old duplicate from a new response. Require a fresh
	// creation boundary rather than charge usage to an uncertain request.
	if c.requireCreated && item.responseID == "" && id != "" && event.Type != "response.created" {
		if !item.abandoned {
			c.emit(item, "truncated", "websocket_response_attribution_requires_created", "request")
			c.bytes -= item.size
			item.size = 0
			item.request = nil
			item.messages = nil
			item.abandoned = true
		}
		return
	}
	if id != "" {
		// Once bound, a different response ID is never assigned by queue position.
		if item.responseID != "" && item.responseID != id {
			return
		}
		item.responseID = id
	}
	terminal := event.Type == "response.completed" || event.Type == "response.done" || event.Type == "response.failed" || event.Type == "response.incomplete" || event.Type == "error"
	if item.abandoned {
		if terminal {
			c.remove(lane, item)
		}
		return
	}
	item.wire += int64(len(data))
	if c.bytes+len(data) > websocketCaptureLimit || len(item.messages) >= 8192 {
		c.abandon("websocket_capture_budget_exceeded")
		if terminal {
			c.remove(lane, item)
		}
		return
	}
	item.messages = append(item.messages, socketMessage{"server", c.sequence, string(data)})
	item.size += len(data)
	c.bytes += len(data)
	if terminal {
		status, reason := "complete", ""
		if event.Type == "error" || event.Type == "response.failed" || event.Response.Status == "failed" {
			status = "error"
		}
		if event.Type == "response.incomplete" || event.Response.Status == "incomplete" {
			status = "truncated"
			reason = "response_incomplete"
		}
		c.emit(item, status, reason, "request")
		c.remove(lane, item)
	}
}
func (c *responsesSocketCapture) remove(lane string, item *socketResponse) {
	if item.responseID != "" {
		if c.retired == nil {
			c.retired = make(map[string]bool)
		}
		c.retired[item.responseID] = true
		c.retiredOrder = append(c.retiredOrder, item.responseID)
		if len(c.retiredOrder) > 1024 {
			c.requireCreated = true
			delete(c.retired, c.retiredOrder[0])
			c.retiredOrder = c.retiredOrder[1:]
		}
	}
	c.bytes -= item.size
	c.count--
	if len(c.pending[lane]) == 1 {
		delete(c.pending, lane)
	} else {
		c.pending[lane] = c.pending[lane][1:]
	}
}
func (c *responsesSocketCapture) emit(item *socketResponse, status, reason, attribution string) {
	reqHeaders := sanitizeHeaders(c.request.Header)
	reqHeaders["host"] = c.request.Host
	envelope, _ := json.Marshal(struct {
		Format   string          `json:"format"`
		Messages []socketMessage `json:"messages"`
	}{"ws-messages-v1", item.messages})
	var lane struct {
		StreamID string `json:"stream_id"`
	}
	_ = json.Unmarshal(item.request, &lane)
	c.proxy.sendToElectron(CapturePayload{SchemaVersion: "3.0.0", EventID: item.requestID, RequestID: item.requestID, Sequence: 1,
		CoreInstanceID: c.proxy.coreInstanceID, CaptureStatus: status, TruncatedReason: reason,
		Transport: c.transport, Address: c.address, BodyFormat: "ws-messages-v1", BodyEncoding: "UTF-8 WebSocket text payload", ConnectionID: c.connectionID, StreamID: lane.StreamID, Attribution: attribution,
		URLPath: sanitizeURL(c.request.URL.RequestURI()), Method: c.request.Method, StatusCode: 101, DurationMs: time.Since(item.started).Milliseconds(),
		RequestHeaders: reqHeaders, ResponseHeaders: sanitizeHeaders(c.responseHeaders), RequestBody: string(item.request), ResponseBody: string(envelope),
		BytesWire: item.wire, BytesCaptured: int64(item.size)})
}
func (c *responsesSocketCapture) diagnostic(data []byte, status, reason string, fromClient ...bool) {
	item := &socketResponse{requestID: generateID(), started: time.Now(), size: len(data)}
	if data != nil {
		direction := "server"
		if len(fromClient) > 0 && fromClient[0] {
			direction = "client"
		}
		item.messages = []socketMessage{{direction, c.sequence, string(data)}}
	} else {
		item.messages = []socketMessage{}
	}
	c.emit(item, status, reason, "connection")
}
func (c *responsesSocketCapture) abandon(reason string) {
	for _, queue := range c.pending {
		for _, item := range queue {
			if item.abandoned {
				continue
			}
			c.emit(item, "truncated", reason, "request")
			c.bytes -= item.size
			item.size = 0
			item.request = nil
			item.messages = nil
			item.abandoned = true
		}
	}
}
func (c *responsesSocketCapture) finish() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, queue := range c.pending {
		for _, item := range queue {
			if !item.abandoned {
				c.emit(item, "error", "websocket_closed_before_response_completed", "request")
			}
		}
	}
	c.pending = make(map[string][]*socketResponse)
	c.bytes = 0
	c.count = 0
}
