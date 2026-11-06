package main

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
)

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

var knownLlmDomains = []string{
	"generativelanguage.googleapis.com",
	"aiplatform.googleapis.com",
	"cloudaicompanion.googleapis.com",
	"cloudcode-pa.googleapis.com",
	"daily-cloudcode-pa.googleapis.com",
	"api.anthropic.com",
	"api.openai.com",
	"openrouter.ai",
	"api.deepseek.com",
	"api.groq.com",
	"api.together.xyz",
	"api.cohere.ai",
	"api.mistral.ai",
	"api.perplexity.ai",
	"api.moonshot.cn",
}

func shouldInterceptHost(target string) bool {
	ps := &ProxyServer{}
	return ps.shouldInterceptHost(target)
}

func (p *ProxyServer) shouldInterceptHost(target string) bool {
	if target == "" {
		return false
	}
	host := hostname(target)
	// Codex's official Responses endpoint shares this host with the desktop
	// control plane. Subdomains (login, remote control, telemetry) stay opaque.
	if host == "chatgpt.com" {
		return true
	}

	// 1. Loopback bypass
	if isLocalHost(host) {
		return false
	}

	// 2. Auth & Telemetry bypass
	if strings.Contains(host, "oauth") || strings.Contains(host, "accounts.") || strings.Contains(host, "login.") ||
		strings.Contains(host, "auth.") ||
		strings.Contains(host, "telemetry") || strings.Contains(host, "sentry") {
		return false
	}

	// 3. Match known LLM endpoints
	for _, domain := range knownLlmDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}

	// 4. Match user custom domains
	for _, domain := range p.customDomains {
		clean := strings.TrimSpace(strings.ToLower(domain))
		if clean == "" {
			continue
		}
		if host == clean || strings.HasSuffix(host, "."+clean) {
			return true
		}
	}

	return false
}

func hostname(target string) string {
	if h, _, err := net.SplitHostPort(target); err == nil {
		return strings.ToLower(h)
	}
	return strings.ToLower(target)
}

func isLocalHost(target string) bool {
	host := hostname(target)
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local")
}

type ProxyServer struct {
	listenAddr      string
	upstreamURL     *url.URL
	callbackURL     string
	callbackSecret  string
	coreInstanceID  string
	certManager     *CertManager
	customDomains   []string
	activeConns     int64
	client          *http.Client
	websocketDialer *websocket.Dialer
	eventQueue      chan CapturePayload
	queuedBytes     int64
	spoolMu         sync.Mutex
	spoolFilePath   string
	deliveredEvents int64
	retriedEvents   int64
	droppedEvents   int64
	failedCallbacks int64
	workerStopChan  chan struct{}
	workerWg        sync.WaitGroup
}

func (p *ProxyServer) SetCustomDomains(domains []string) {
	p.customDomains = domains
}

type CapturePayload struct {
	queueSize       int64
	Transport       string            `json:"transport,omitempty"`
	Address         string            `json:"address,omitempty"`
	BodyFormat      string            `json:"body_format,omitempty"`
	BodyEncoding    string            `json:"body_encoding,omitempty"`
	ConnectionID    string            `json:"connection_id,omitempty"`
	StreamID        string            `json:"stream_id,omitempty"`
	Attribution     string            `json:"attribution,omitempty"`
	SchemaVersion   string            `json:"schema_version"`
	EventID         string            `json:"event_id"`
	RequestID       string            `json:"request_id"`
	Sequence        int               `json:"sequence"`
	CoreInstanceID  string            `json:"core_instance_id"`
	CaptureStatus   string            `json:"capture_status"`
	BytesWire       int64             `json:"bytes_wire"`
	BytesCaptured   int64             `json:"bytes_captured"`
	TruncatedReason string            `json:"truncated_reason,omitempty"`
	URLPath         string            `json:"url_path"`
	Method          string            `json:"method"`
	StatusCode      int               `json:"status_code"`
	DurationMs      int64             `json:"duration_ms"`
	RequestHeaders  map[string]string `json:"request_headers"`
	RequestBody     string            `json:"request_body"`
	ResponseHeaders map[string]string `json:"response_headers"`
	ResponseBody    string            `json:"response_body"`
}

func sanitizeURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	u.User = nil
	u.Fragment = ""
	q := u.Query()
	for key := range q {
		q.Set(key, "[REDACTED]")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func sanitizeHeaders(h http.Header) map[string]string {
	res := make(map[string]string)
	for k, vv := range h {
		lowerKey := strings.ToLower(k)
		switch lowerKey {
		case "authorization":
			val := strings.Join(vv, ", ")
			if strings.HasPrefix(strings.ToLower(val), "bearer ") {
				res[lowerKey] = "Bearer [REDACTED]"
			} else if strings.HasPrefix(strings.ToLower(val), "basic ") {
				res[lowerKey] = "Basic [REDACTED]"
			} else {
				res[lowerKey] = "[REDACTED]"
			}
		case "proxy-authorization", "cookie", "set-cookie",
			"x-api-key", "api-key", "anthropic-api-key", "x-goog-api-key":
			res[lowerKey] = "[REDACTED]"
		default:
			res[lowerKey] = strings.Join(vv, ", ")
		}
	}
	return res
}

func NewProxyServer(listenAddr, upstreamStr, callbackURL string, cm *CertManager) (*ProxyServer, error) {
	return NewProxyServerWithSecret(listenAddr, upstreamStr, callbackURL, "", cm)
}

func NewProxyServerWithSecret(listenAddr, upstreamStr, callbackURL, secret string, cm *CertManager) (*ProxyServer, error) {
	var upstreamURL *url.URL
	if upstreamStr != "" {
		var err error
		upstreamURL, err = url.Parse(upstreamStr)
		if err != nil {
			return nil, err
		}
		if upstreamURL.Hostname() == "" || (upstreamURL.Scheme != "http" && upstreamURL.Scheme != "https") {
			return nil, fmt.Errorf("upstream must be an http:// or https:// proxy URL")
		}
	}

	transport := &http.Transport{
		// Forward the client's encoding contract without adding gzip or decoding responses.
		DisableCompression: true,
		// A custom DialContext otherwise disables automatic HTTP/2 negotiation.
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ResponseHeaderTimeout: 120 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	if upstreamURL != nil {
		transport.Proxy = func(req *http.Request) (*url.URL, error) {
			if isLocalHost(req.URL.Host) {
				return nil, nil
			}
			return upstreamURL, nil
		}
	}

	client := &http.Client{
		Transport: transport,
		// A generation can stream for minutes. Bound dial/headers, not the body.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}

	ps := &ProxyServer{
		listenAddr:     listenAddr,
		upstreamURL:    upstreamURL,
		callbackURL:    callbackURL,
		callbackSecret: secret,
		coreInstanceID: generateID(),
		certManager:    cm,
		client:         client,
		// net/http owns and initializes its TLS configuration for HTTP/2.
		// WebSocket Upgrade requires HTTP/1.1 and must own a separate config.
		websocketDialer: &websocket.Dialer{
			Proxy:            transport.Proxy,
			NetDialContext:   transport.DialContext,
			HandshakeTimeout: 15 * time.Second,
			TLSClientConfig:  &tls.Config{NextProtos: []string{"http/1.1"}},
		},
		eventQueue:     make(chan CapturePayload, 2000),
		workerStopChan: make(chan struct{}),
	}
	ps.startWorkers(2)
	return ps, nil
}

func (p *ProxyServer) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	atomic.AddInt64(&p.activeConns, 1)
	defer atomic.AddInt64(&p.activeConns, -1)

	if req.Method == http.MethodConnect {
		p.handleConnect(w, req)
	} else {
		p.handleHTTP(w, req)
	}
}

func (p *ProxyServer) handleConnect(w http.ResponseWriter, req *http.Request) {
	targetHost := req.URL.Host
	// Pi's undici proxy dispatcher uses CONNECT even for an http:// origin.
	// Local OpenAI-compatible gateways therefore send plaintext HTTP inside
	// the CONNECT tunnel. Inspect local tunnels so those requests can be
	// captured while retaining opaque forwarding for local TLS services.
	if isLocalHost(targetHost) {
		p.handleLocalConnect(w, req)
		return
	}
	if !p.shouldInterceptHost(targetHost) {
		// Non-LLM domain -> Direct transparent tunnel to Clash upstream
		p.handleTunnelDirect(w, req)
		return
	}

	// LLM Target Domain -> MITM TLS Decryption & Stream Capture
	p.handleMitm(w, req)
}

func looksLikeHTTP(data []byte) bool {
	for _, method := range []string{"GET ", "POST ", "PUT ", "PATCH ", "DELETE ", "HEAD ", "OPTIONS ", "TRACE "} {
		if bytes.HasPrefix(data, []byte(method)) {
			return true
		}
	}
	return false
}

func (p *ProxyServer) handleLocalConnect(w http.ResponseWriter, req *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuffer, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer clientConn.Close()

	if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}

	// A CONNECT client may send the first tunneled bytes immediately after
	// the request. Peek preserves them for either HTTP parsing or tunneling.
	first, err := clientBuffer.Peek(8)
	if err == nil && looksLikeHTTP(first) {
		stream := &mitmClientConn{Conn: clientConn, reader: clientBuffer.Reader}
		for {
			clientReq, readErr := stream.readRequest()
			if readErr != nil {
				return
			}
			if !p.processPlainHTTPConnectRequest(stream, clientReq, req.URL.Host) {
				return
			}
		}
	}

	// Non-HTTP bytes (normally a TLS ClientHello) remain an opaque local
	// tunnel. This keeps existing local HTTPS services working.
	upstreamConn, err := net.DialTimeout("tcp", req.URL.Host, 10*time.Second)
	if err != nil {
		return
	}
	defer upstreamConn.Close()
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstreamConn, clientBuffer)
		if tcp, ok := upstreamConn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(clientConn, upstreamConn)
	_ = clientConn.Close()
	_ = upstreamConn.Close()
	<-done
}

func (p *ProxyServer) handleTunnelDirect(w http.ResponseWriter, req *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuffer, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer clientConn.Close()

	var upstreamConn net.Conn
	var upstreamReader io.Reader
	if p.upstreamURL != nil && !isLocalHost(req.URL.Host) {
		// Connect through upstream proxy (Clash 7890)
		proxyAddr := p.upstreamURL.Host
		if p.upstreamURL.Port() == "" {
			port := "80"
			if p.upstreamURL.Scheme == "https" {
				port = "443"
			}
			proxyAddr = net.JoinHostPort(p.upstreamURL.Hostname(), port)
		}
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		if p.upstreamURL.Scheme == "https" {
			upstreamConn, err = tls.DialWithDialer(dialer, "tcp", proxyAddr, &tls.Config{ServerName: p.upstreamURL.Hostname()})
		} else {
			upstreamConn, err = dialer.DialContext(req.Context(), "tcp", proxyAddr)
		}
		if err != nil {
			clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			return
		}
		// Send standard CONNECT request to Clash
		_ = upstreamConn.SetDeadline(time.Now().Add(10 * time.Second))
		auth := ""
		if user := p.upstreamURL.User; user != nil {
			password, _ := user.Password()
			auth = "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(user.Username()+":"+password)) + "\r\n"
		}
		connectReq := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n%s\r\n", req.URL.Host, req.URL.Host, auth)
		if _, err := upstreamConn.Write([]byte(connectReq)); err != nil {
			upstreamConn.Close()
			return
		}
		// Read 200 OK from upstream
		reader := bufio.NewReader(upstreamConn)
		resp, err := http.ReadResponse(reader, req)
		if err != nil || resp.StatusCode != 200 {
			upstreamConn.Close()
			clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			return
		}
		_ = upstreamConn.SetDeadline(time.Time{})
		upstreamReader = reader
	} else {
		// Direct TCP connect
		upstreamConn, err = net.DialTimeout("tcp", req.URL.Host, 10*time.Second)
		if err != nil {
			clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			return
		}
		upstreamReader = upstreamConn
	}
	defer upstreamConn.Close()

	clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	// Bi-directional zero-copy transparent pipe
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstreamConn, clientBuffer)
		if tcp, ok := upstreamConn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(clientConn, upstreamReader)
	_ = clientConn.Close()
	_ = upstreamConn.Close()
	<-done
}

func (p *ProxyServer) handleMitm(w http.ResponseWriter, req *http.Request) {
	targetHost := req.URL.Host
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuffer, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer clientConn.Close()

	// 1. Tell client the tunnel is ready
	_, _ = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	// 2. Get dynamic RFC 5280 compliant TLS certificate
	tlsCert, err := p.certManager.GetOrCreateCertificate(targetHost)
	if err != nil {
		fmt.Printf("\x1b[1;31m[Go-Core] Failed to issue certificate (%s):\x1b[0m %v\n", targetHost, err)
		return
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{*tlsCert},
		NextProtos:   []string{"http/1.1"},
	}

	tlsClientConn := tls.Server(&bufferedConn{Conn: clientConn, reader: clientBuffer.Reader}, tlsConfig)
	ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
	defer cancel()
	if err := tlsClientConn.HandshakeContext(ctx); err != nil {
		fmt.Printf("[Go-Core] TLS handshake failed (%s): %v\n", targetHost, err)
		return
	}
	defer tlsClientConn.Close()

	stream := &mitmClientConn{Conn: tlsClientConn, reader: bufio.NewReader(tlsClientConn)}
	for {
		clientReq, err := stream.readRequest()
		if err != nil {
			break
		}

		if !p.processDecryptedRequest(stream, clientReq, targetHost) {
			break
		}
	}
}

// One buffered reader owns the decrypted request stream. A disconnect probe
// peeks without consuming the next request, and the parser joins that probe
// before reading again. Read deadlines cannot interrupt a TLS probe safely:
// a timed-out TLS read permanently poisons the connection for later requests.
type mitmClientConn struct {
	net.Conn
	reader   *bufio.Reader
	readDone chan struct{}
}

func (c *mitmClientConn) readRequest() (*http.Request, error) {
	if c.readDone != nil {
		<-c.readDone
	}
	return http.ReadRequest(c.reader)
}

func (c *mitmClientConn) watchDisconnect(cancel context.CancelFunc) {
	done := make(chan struct{})
	c.readDone = done
	go func() {
		defer close(done)
		if _, err := c.reader.Peek(1); err != nil {
			cancel()
		}
	}()
}

// Preserve bytes net/http may have read ahead while parsing CONNECT.
type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }

func stripHopHeaders(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, key := range strings.Split(value, ",") {
			header.Del(strings.TrimSpace(key))
		}
	}
	for _, key := range []string{"Connection", "Proxy-Connection", "Proxy-Authorization", "Proxy-Authenticate", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		header.Del(key)
	}
}

func (p *ProxyServer) processDecryptedRequest(clientConn net.Conn, clientReq *http.Request, targetHost string) bool {
	return p.processCapturedRequest(clientConn, clientReq, targetHost, "https")
}

func (p *ProxyServer) processPlainHTTPConnectRequest(clientConn net.Conn, clientReq *http.Request, targetHost string) bool {
	return p.processCapturedRequest(clientConn, clientReq, targetHost, "http")
}

func (p *ProxyServer) processCapturedRequest(clientConn net.Conn, clientReq *http.Request, targetHost, scheme string) bool {
	if isWebSocketRequest(clientReq) {
		p.proxyWebSocket(newConnResponseWriter(clientConn), clientReq, targetHost, scheme)
		return false
	}
	var afterUpload func(context.CancelFunc)
	if stream, ok := clientConn.(*mitmClientConn); ok {
		// The reader can peek for disconnects only after the upload is consumed.
		afterUpload = func(cancel context.CancelFunc) { stream.watchDisconnect(cancel) }
	}
	return p.forwardHTTP(clientReq, targetHost, scheme,
		func(response *http.Response) error { return writeConnResponse(clientConn, response) },
		func(code int, headers http.Header) error { return writeConnInformational(clientConn, code, headers) }, afterUpload)
}

func (p *ProxyServer) isSelfPort(host string) bool {
	if host == "" {
		return false
	}
	_, port, err := net.SplitHostPort(host)
	if err != nil {
		return false
	}
	if p.listenAddr != "" {
		_, selfPort, err := net.SplitHostPort(p.listenAddr)
		if err == nil && port == selfPort {
			return true
		}
	}
	if p.callbackURL != "" {
		if u, err := url.Parse(p.callbackURL); err == nil && u.Port() == port {
			return true
		}
	}
	return false
}

func (p *ProxyServer) shouldAuditHTTP(req *http.Request) bool {
	target := req.Host
	if target == "" {
		target = req.URL.Host
	}
	if target == "" || p.isSelfPort(target) {
		return false
	}
	host := hostname(target)
	if host == "chatgpt.com" {
		return isResponsesPath(req.URL.Path)
	}
	// Verified UI notices endpoint. Forward normally; do not create an audit copy.
	if host == "daily-cloudcode-pa.googleapis.com" && req.Method == http.MethodGet &&
		req.URL.EscapedPath() == "/v1internal/cascadeNuxes" {
		return false
	}

	// 1. Known LLM domain or custom domain
	for _, domain := range knownLlmDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	for _, domain := range p.customDomains {
		clean := strings.TrimSpace(strings.ToLower(domain))
		if clean == "" {
			continue
		}
		if host == clean || strings.HasSuffix(host, "."+clean) || strings.ToLower(target) == clean {
			return true
		}
	}

	// 2. Localhost / local IP LLM endpoints (e.g. CC Switch, local Ollama, sidecars)
	if isLocalHost(host) {
		path := strings.ToLower(req.URL.Path)
		ua := strings.ToLower(req.Header.Get("User-Agent"))
		if strings.Contains(path, "/v1/") ||
			strings.Contains(path, "/v1beta/") ||
			strings.Contains(path, "/backend-api/") ||
			strings.Contains(ua, "codex") ||
			strings.Contains(ua, "chatgpt") ||
			req.Header.Get("x-codex-turn-id") != "" ||
			req.Header.Get("chatgpt-account-id") != "" {
			return true
		}
	}

	return false
}

func (p *ProxyServer) handleHTTPUpgrade(w http.ResponseWriter, req *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuffer, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer clientConn.Close()

	target := req.Host
	if target == "" {
		target = req.URL.Host
	}
	if !strings.Contains(target, ":") {
		target = net.JoinHostPort(target, "80")
	}

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	var upstreamConn net.Conn
	if p.upstreamURL != nil && !isLocalHost(target) {
		proxyAddr := p.upstreamURL.Host
		if p.upstreamURL.Port() == "" {
			proxyAddr = net.JoinHostPort(p.upstreamURL.Hostname(), "80")
		}
		upstreamConn, err = dialer.DialContext(req.Context(), "tcp", proxyAddr)
	} else {
		upstreamConn, err = dialer.DialContext(req.Context(), "tcp", target)
	}
	if err != nil {
		clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	defer upstreamConn.Close()

	outReq := forwardingRequest(req, req.Context(), "", "http")
	outReq.Header.Set("Connection", "Upgrade")
	outReq.Header.Set("Upgrade", req.Header.Get("Upgrade"))
	var writeErr error
	if p.upstreamURL != nil && !isLocalHost(target) {
		writeErr = outReq.WriteProxy(upstreamConn)
	} else {
		writeErr = outReq.Write(upstreamConn)
	}
	if writeErr != nil {
		return
	}

	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstreamConn, clientBuffer)
		if tcp, ok := upstreamConn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(clientConn, upstreamConn)
	<-done
}

func (p *ProxyServer) handleHTTP(w http.ResponseWriter, req *http.Request) {
	target := req.Host
	if target == "" {
		target = req.URL.Host
	}
	if p.isSelfPort(target) {
		http.Error(w, "Proxy loopback detected", http.StatusBadRequest)
		return
	}

	if isWebSocketRequest(req) {
		p.proxyWebSocket(w, req, target, "http")
		return
	}
	// Other upgrade protocols remain transparent.
	if strings.EqualFold(req.Header.Get("Upgrade"), "websocket") || strings.Contains(strings.ToLower(req.Header.Get("Connection")), "upgrade") {
		p.handleHTTPUpgrade(w, req)
		return
	}

	// HTTP/1 clients may receive responses before finishing their upload.
	_ = http.NewResponseController(w).EnableFullDuplex()
	var transferErr error
	p.forwardHTTP(req, "", "http",
		func(response *http.Response) error { transferErr = writeHTTPResponse(w, response); return transferErr },
		func(code int, headers http.Header) error { return writeInformationalResponse(w, code, headers) }, nil)
	if transferErr != nil {
		panic(http.ErrAbortHandler)
	}
}

const decompressionCaptureLimit = 32 * 1024 * 1024

func decodeBody(data []byte, encoding string) string {
	text, _ := decodeBodyAudit(data, encoding)
	return text
}
func decodeBodyAudit(data []byte, encoding string) (string, string) {
	if len(data) == 0 {
		return "", ""
	}
	enc := strings.ToLower(strings.TrimSpace(encoding))
	if enc == "" || enc == "identity" {
		return string(data), ""
	}
	read := func(reader io.ReadCloser) (string, string) {
		defer reader.Close()
		decoded, err := io.ReadAll(io.LimitReader(reader, decompressionCaptureLimit+1))
		if err != nil {
			return "", "content_decode_failed"
		}
		if len(decoded) > decompressionCaptureLimit {
			return string(decoded[:decompressionCaptureLimit]), "decoded_payload_exceeded_budget"
		}
		return string(decoded), ""
	}
	if enc == "gzip" {
		if reader, err := gzip.NewReader(bytes.NewReader(data)); err == nil {
			return read(reader)
		}
	}
	if enc == "deflate" {
		if reader, err := zlib.NewReader(bytes.NewReader(data)); err == nil {
			return read(reader)
		}
		return read(flate.NewReader(bytes.NewReader(data)))
	}
	if enc == "zstd" {
		// The cap bounds the frame window as well as the independently limited output.
		if reader, err := zstd.NewReader(bytes.NewReader(data), zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(64*1024*1024)); err == nil {
			return read(reader.IOReadCloser())
		}
	}
	return "", "unsupported_or_invalid_content_encoding"
}

func (p *ProxyServer) sendToElectron(payload CapturePayload) {
	p.enqueuePayload(payload)
}

const auditQueueBudget int64 = 64 * 1024 * 1024
const auditSpoolBudget int64 = 256 * 1024 * 1024
const serializedCaptureLimit = 32 * 1024 * 1024

func (p *ProxyServer) reserveQueue(payload *CapturePayload) bool {
	data, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	if len(data) > serializedCaptureLimit {
		payload.RequestBody = ""
		payload.ResponseBody = ""
		payload.CaptureStatus = "metadata_only"
		payload.TruncatedReason = "serialized_capture_exceeded_budget"
		payload.BytesCaptured = 0
		data, _ = json.Marshal(payload)
	}
	size := int64(len(data))
	for {
		current := atomic.LoadInt64(&p.queuedBytes)
		if current+size > auditQueueBudget {
			return false
		}
		if atomic.CompareAndSwapInt64(&p.queuedBytes, current, current+size) {
			payload.queueSize = size
			return true
		}
	}
}
func (p *ProxyServer) enqueuePayload(payload CapturePayload) {
	if p.callbackURL == "" {
		return
	}
	if p.reserveQueue(&payload) {
		select {
		case p.eventQueue <- payload:
			return
		default:
			atomic.AddInt64(&p.queuedBytes, -payload.queueSize)
		}
	}
	atomic.AddInt64(&p.droppedEvents, 1)
	p.spoolEvent(payload)
}

func (p *ProxyServer) startWorkers(count int) {
	for i := 0; i < count; i++ {
		p.workerWg.Add(1)
		go func() {
			defer p.workerWg.Done()
			for {
				select {
				case <-p.workerStopChan:
					// Drain remaining before exit
					for {
						select {
						case item := <-p.eventQueue:
							p.deliverWithRetry(item)
						default:
							return
						}
					}
				case item := <-p.eventQueue:
					p.deliverWithRetry(item)
				}
			}
		}()
	}
}

func (p *ProxyServer) deliverWithRetry(payload CapturePayload) {
	defer atomic.AddInt64(&p.queuedBytes, -payload.queueSize)
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return
	}

	client := &http.Client{
		Timeout: 4 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	backoffs := []time.Duration{0, 50 * time.Millisecond, 150 * time.Millisecond, 400 * time.Millisecond}
	for attempt := 0; attempt < len(backoffs); attempt++ {
		if attempt > 0 {
			atomic.AddInt64(&p.retriedEvents, 1)
			time.Sleep(backoffs[attempt])
		}

		req, err := http.NewRequest(http.MethodPost, p.callbackURL, bytes.NewReader(jsonBytes))
		if err != nil {
			break
		}
		req.Header.Set("Content-Type", "application/json")
		if p.callbackSecret != "" {
			req.Header.Set("X-Prompt-Lens-Secret", p.callbackSecret)
			req.Header.Set("X-LLM-Lens-Secret", p.callbackSecret)
			req.Header.Set("Authorization", "Bearer "+p.callbackSecret)
		}

		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				atomic.AddInt64(&p.deliveredEvents, 1)
				return
			}
		}
	}

	// All retries failed: persist to spool file to survive crashes
	atomic.AddInt64(&p.failedCallbacks, 1)
	p.spoolEvent(payload)
}

func (p *ProxyServer) SetSpoolFilePath(path string) {
	p.spoolMu.Lock()
	defer p.spoolMu.Unlock()
	p.spoolFilePath = path
}

func (p *ProxyServer) spoolEvent(payload CapturePayload) {
	p.spoolMu.Lock()
	defer p.spoolMu.Unlock()
	p.spoolEventLocked(payload)
}

func (p *ProxyServer) spoolEventLocked(payload CapturePayload) {
	if p.spoolFilePath == "" {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	f, err := os.OpenFile(p.spoolFilePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size()+int64(len(data)+1) > auditSpoolBudget {
		atomic.AddInt64(&p.droppedEvents, 1)
		fmt.Println("[Go-Core] Audit spool reached 256 MiB limit; event dropped, traffic continued")
		return
	}
	_, _ = f.Write(append(data, '\n'))
}

func (p *ProxyServer) replaySpool() {
	p.spoolMu.Lock()
	defer p.spoolMu.Unlock()
	if p.spoolFilePath == "" {
		return
	}
	if _, err := os.Stat(p.spoolFilePath); err != nil {
		return
	}
	info, err := os.Stat(p.spoolFilePath)
	if err != nil || info.Size() > auditSpoolBudget {
		fmt.Println("[Go-Core] Stale audit spool exceeds replay budget, preserved for offline inspection")
		return
	}
	data, err := os.ReadFile(p.spoolFilePath)
	if err != nil || len(data) == 0 {
		return
	}
	_ = os.Remove(p.spoolFilePath)

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var payload CapturePayload
		if err := json.Unmarshal([]byte(trimmed), &payload); err == nil {
			if p.reserveQueue(&payload) {
				select {
				case p.eventQueue <- payload:
					continue
				default:
					atomic.AddInt64(&p.queuedBytes, -payload.queueSize)
				}
			}
			p.spoolEventLocked(payload)
		}
	}
}

func (p *ProxyServer) Shutdown(ctx context.Context) {
	close(p.workerStopChan)
	done := make(chan struct{})
	go func() {
		p.workerWg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}
