package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	port := flag.Int("port", 8899, "Proxy listen port")
	upstream := flag.String("upstream", "", "Optional upstream proxy URL; empty means direct")
	callback := flag.String("callback", "http://127.0.0.1:8897/api/capture", "Electron capture callback URL")
	customDomainsFlag := flag.String("custom-domains", "", "Comma-separated list of additional domains to intercept")
	dataDir := flag.String("data-dir", "", "Certificate and retry spool directory (default ~/.prompt-lens)")
	flag.Parse()

	secret := os.Getenv("PROMPT_LENS_SECRET")
	if secret == "" {
		secret = os.Getenv("LLM_LENS_SECRET")
	}

	if *dataDir == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		*dataDir = filepath.Join(homeDir, ".prompt-lens")
	}
	certMgr, err := newCertManagerAt(*dataDir)
	if err != nil {
		fmt.Printf("\x1b[1;31m[Go-Core] Failed to initialize cert manager:\x1b[0m %v\n", err)
		os.Exit(1)
	}

	listenAddr := fmt.Sprintf("127.0.0.1:%d", *port)
	proxyServer, err := NewProxyServerWithSecret(listenAddr, *upstream, *callback, secret, certMgr)
	if err != nil {
		fmt.Printf("\x1b[1;31m[Go-Core] Failed to initialize proxy server:\x1b[0m %v\n", err)
		os.Exit(1)
	}
	if *customDomainsFlag != "" {
		parts := strings.Split(*customDomainsFlag, ",")
		proxyServer.SetCustomDomains(parts)
	}

	server := &http.Server{
		Addr:    listenAddr,
		Handler: proxyServer,
	}

	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[Go-Core] Listen failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("PROMPT_LENS_CORE_READY %s\n", listener.Addr())
	fmt.Printf("LLM_LENS_CORE_READY %s\n", listener.Addr())
	proxyServer.SetSpoolFilePath(filepath.Join(*dataDir, "spool.jsonl"))
	go proxyServer.replaySpool()
	_ = os.Stdout.Sync()
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			fmt.Printf("\x1b[1;31m[Go-Core] Runtime error:\x1b[0m %v\n", err)
			os.Exit(1)
		}
	}()

	exitChan := make(chan struct{})
	go func() {
		buf := make([]byte, 1)
		for {
			_, err := os.Stdin.Read(buf)
			if err != nil {
				// Parent closed stdin (process exit or crash)
				close(exitChan)
				return
			}
		}
	}()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	select {
	case <-sigChan:
	case <-exitChan:
	}

	fmt.Println("\x1b[1;33m[Go-Core] Shutting down proxy core...\x1b[0m")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	proxyServer.Shutdown(ctx)
	fmt.Println("\x1b[1;32m[Go-Core] Proxy core exited\x1b[0m")
}
