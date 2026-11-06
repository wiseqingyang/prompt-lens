package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const httpCaptureLimit = 8 * 1024 * 1024

// This sink owns only an audit copy. Its budget never limits the source stream.
// A transport may still be writing the request when an early response arrives.
type bodyCapture struct {
	mu    sync.Mutex
	data  bytes.Buffer
	total int64
}

func (c *bodyCapture) Write(data []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(data))
	remaining := httpCaptureLimit - c.data.Len()
	if remaining > len(data) {
		remaining = len(data)
	}
	if remaining > 0 {
		_, _ = c.data.Write(data[:remaining])
	}
	return len(data), nil
}
func (c *bodyCapture) snapshot() ([]byte, int64) {
	if c == nil {
		return nil, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.data.Bytes()...), c.total
}

type forwardingBody struct {
	io.ReadCloser
	capture    *bodyCapture
	length     int64
	read       int64
	complete   atomic.Bool
	onComplete func()
	completion sync.Once
}

func (b *forwardingBody) Read(data []byte) (int, error) {
	n, err := b.ReadCloser.Read(data)
	if b.capture != nil && n > 0 {
		_, _ = b.capture.Write(data[:n])
	}
	b.read += int64(n)
	if err == io.EOF || (b.length > 0 && b.read == b.length) {
		b.completion.Do(func() {
			if b.onComplete != nil {
				b.onComplete()
			}
			b.complete.Store(true)
		})
	}
	return n, err
}

// Build a distinct network request. No audit operation can mutate its headers,
// URL or body. Only connection/framing details belong to the proxy transport.
func forwardingRequest(req *http.Request, ctx context.Context, target, scheme string) *http.Request {
	out := req.Clone(ctx)
	out.RequestURI = ""
	out.GetBody = nil
	if out.Trailer == nil {
		out.Trailer = make(http.Header)
	}
	out.Close = false
	if target != "" {
		out.URL.Host = target
	}
	if out.URL.Host == "" {
		out.URL.Host = req.Host
	}
	if target != "" || out.URL.Scheme == "" {
		out.URL.Scheme = scheme
	}
	if out.Host == "" {
		out.Host = out.URL.Host
	}
	stripHopHeaders(out.Header)
	if strings.EqualFold(req.Header.Get("TE"), "trailers") {
		out.Header.Set("TE", "trailers")
	}
	// net/http otherwise invents Go-http-client/1.1 for a missing User-Agent.
	if _, present := out.Header["User-Agent"]; !present {
		out.Header["User-Agent"] = nil
	}
	return out
}

// Both HTTP and CONNECT use the same streaming transport and capture contract.
// Informational responses are relayed before the final response (not invented).
func (p *ProxyServer) forwardHTTP(req *http.Request, target, scheme string, send func(*http.Response) error, informational func(int, http.Header) error, afterUpload func(context.CancelFunc)) bool {
	started := time.Now()
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		Got1xxResponse: func(code int, headers textproto.MIMEHeader) error {
			return informational(code, http.Header(headers).Clone())
		},
	})
	out := forwardingRequest(req, ctx, target, scheme)
	policyRequest := *req
	if target != "" {
		policyRequest.Host = target
	}
	audit := p.shouldAuditHTTP(&policyRequest)
	var requestCopy, responseCopy *bodyCapture
	var requestHeaders http.Header
	if audit {
		requestCopy = &bodyCapture{}
		responseCopy = &bodyCapture{}
		requestHeaders = req.Header.Clone()
		if req.Host != "" {
			requestHeaders.Set("Host", req.Host)
		}
	}
	body := &forwardingBody{ReadCloser: req.Body, capture: requestCopy, length: req.ContentLength}
	body.onComplete = func() {
		// Incoming trailers are populated only after reading the last body byte.
		for key, values := range req.Trailer {
			out.Trailer[key] = append([]string(nil), values...)
		}
		if afterUpload != nil {
			afterUpload(cancel)
		}
	}
	if req.Body == nil || req.Body == http.NoBody {
		out.Body = http.NoBody
		body.complete.Store(true)
		if afterUpload != nil {
			afterUpload(cancel)
		}
	} else {
		out.Body = body
	}
	response, upstreamErr := p.client.Do(out)
	if upstreamErr != nil {
		response = &http.Response{StatusCode: http.StatusBadGateway, Header: http.Header{"Content-Type": []string{"text/plain"}},
			Body: io.NopCloser(strings.NewReader(upstreamErr.Error())), ContentLength: -1, Close: true, Request: out}
	}
	defer response.Body.Close()
	forwardedResponse := *response
	response = &forwardedResponse
	var responseHeaders http.Header
	if audit {
		responseHeaders = response.Header.Clone()
		response.Body = struct {
			io.Reader
			io.Closer
		}{io.TeeReader(response.Body, responseCopy), response.Body}
	}
	// A connection with an unfinished upload cannot parse another request safely.
	response.Close = response.Close || req.Close || !body.complete.Load()
	writeErr := send(response)
	if audit {
		requestData, requestBytes := requestCopy.snapshot()
		responseData, responseBytes := responseCopy.snapshot()
		status, reason := "complete", ""
		if requestBytes > httpCaptureLimit || responseBytes > httpCaptureLimit {
			status, reason = "truncated", "payload_exceeded_budget"
		}
		if upstreamErr != nil {
			status, reason = "error", "upstream_error"
		} else if writeErr != nil {
			status, reason = "error", "response_transfer_failed"
		} else if !body.complete.Load() {
			status, reason = "truncated", "upload_not_completed"
		}
		format := "unknown"
		contentType := strings.ToLower(responseHeaders.Get("Content-Type"))
		if strings.Contains(contentType, "text/event-stream") {
			format = "sse"
		} else if strings.Contains(contentType, "json") {
			format = "json"
		}
		encoding := "UTF-8 应用层正文"
		if requestHeaders.Get("Content-Encoding") != "" || responseHeaders.Get("Content-Encoding") != "" {
			encoding = "解码后应用层正文; request=" + requestHeaders.Get("Content-Encoding") + "; response=" + responseHeaders.Get("Content-Encoding")
		}
		payload := CapturePayload{Transport: out.URL.Scheme, Address: sanitizeURL(out.URL.String()), BodyFormat: format, BodyEncoding: encoding, SchemaVersion: "2.0.0", EventID: generateID(), RequestID: generateID(), Sequence: 1,
			CoreInstanceID: p.coreInstanceID, CaptureStatus: status, TruncatedReason: reason,
			BytesWire: requestBytes + responseBytes, BytesCaptured: int64(len(requestData) + len(responseData)),
			URLPath: sanitizeURL(req.URL.RequestURI()), Method: req.Method, StatusCode: response.StatusCode, DurationMs: time.Since(started).Milliseconds()}
		// Everything handed to the asynchronous audit path has independent ownership.
		go func() {
			payload.RequestHeaders = sanitizeHeaders(requestHeaders)
			payload.ResponseHeaders = sanitizeHeaders(responseHeaders)
			var requestReason, responseReason string
			payload.RequestBody, requestReason = decodeBodyAudit(requestData, requestHeaders.Get("Content-Encoding"))
			payload.ResponseBody, responseReason = decodeBodyAudit(responseData, responseHeaders.Get("Content-Encoding"))
			if requestReason != "" || responseReason != "" {
				if payload.CaptureStatus == "complete" {
					payload.CaptureStatus = "truncated"
				}
				payload.TruncatedReason = strings.Trim(strings.Join([]string{payload.TruncatedReason, requestReason, responseReason}, ";"), ";")
			}
			p.sendToElectron(payload)
		}()
	}
	return upstreamErr == nil && writeErr == nil && !response.Close && body.complete.Load()
}

func writeHTTPResponse(w http.ResponseWriter, response *http.Response) error {
	headers := response.Header.Clone()
	stripHopHeaders(headers)
	for key, values := range headers {
		w.Header()[key] = append([]string(nil), values...)
	}
	// ResponseWriter must not synthesize business headers the origin omitted.
	for _, key := range []string{"Content-Type", "Date"} {
		if _, present := headers[key]; !present {
			w.Header()[key] = nil
		}
	}
	announcedTrailers := make(map[string]bool, len(response.Trailer))
	for key := range response.Trailer {
		w.Header().Add("Trailer", key)
		announcedTrailers[key] = true
	}
	if response.Close {
		w.Header().Set("Connection", "close")
	}
	w.WriteHeader(response.StatusCode)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return err
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	for key, values := range response.Trailer {
		if !announcedTrailers[key] {
			key = http.TrailerPrefix + key
		}
		w.Header()[key] = append([]string(nil), values...)
	}
	return nil
}

func writeInformationalResponse(w http.ResponseWriter, code int, headers http.Header) error {
	stripHopHeaders(headers)
	for key, values := range headers {
		w.Header()[key] = append([]string(nil), values...)
	}
	w.WriteHeader(code)
	// Informational headers do not become headers of the final response.
	clear(w.Header())
	return nil
}

func writeConnResponse(conn io.Writer, response *http.Response) error {
	out := *response
	out.Header = response.Header.Clone()
	stripHopHeaders(out.Header)
	out.ProtoMajor, out.ProtoMinor = 1, 1
	if out.ContentLength < 0 && response.Request != nil && response.Request.Method == http.MethodHead {
		out.Body = http.NoBody
	}
	if out.ContentLength < 0 && out.StatusCode >= 200 && out.StatusCode != 204 && out.StatusCode != 304 && out.Body != http.NoBody {
		out.TransferEncoding = []string{"chunked"}
	}
	return out.Write(conn)
}

func writeConnInformational(conn io.Writer, code int, headers http.Header) error {
	stripHopHeaders(headers)
	if _, err := fmt.Fprintf(conn, "HTTP/1.1 %d %s\r\n", code, http.StatusText(code)); err != nil {
		return err
	}
	if err := headers.Write(conn); err != nil {
		return err
	}
	_, err := io.WriteString(conn, "\r\n")
	return err
}
