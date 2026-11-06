package main

import (
	"bytes"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCertSecurityPermissionsAndNoSilentRotation(t *testing.T) {
	dir := t.TempDir()

	// 1. Initial generation creates valid CA with 0600 key
	first, err := newCertManagerAt(dir)
	if err != nil {
		t.Fatalf("first creation failed: %v", err)
	}
	keyPath := filepath.Join(dir, "ssl", "keys", "ca.private.key")
	fi, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("stat key failed: %v", err)
	}
	if fi.Mode().Perm() != 0600 {
		t.Errorf("expected key perm 0600, got %o", fi.Mode().Perm())
	}

	// 2. Simulate historical 0644 key permission -> reload must tighten to 0600
	if err := os.Chmod(keyPath, 0644); err != nil {
		t.Fatal(err)
	}
	second, err := newCertManagerAt(dir)
	if err != nil {
		t.Fatalf("reload with 0644 key failed: %v", err)
	}
	fi, _ = os.Stat(keyPath)
	if fi.Mode().Perm() != 0600 {
		t.Errorf("expected tightened perm 0600, got %o", fi.Mode().Perm())
	}
	// Fingerprint / certificate must remain unchanged!
	if !bytes.Equal(first.caCert.Raw, second.caCert.Raw) {
		t.Errorf("CA was rotated unexpectedly")
	}

	// 3. Corrupt existing key -> reload MUST fail with error, NOT rotate
	if err := os.WriteFile(keyPath, []byte("corrupted private key"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = newCertManagerAt(dir)
	if err == nil {
		t.Fatalf("expected error on corrupted key, but succeeded (silent rotation!)")
	}

	// 4. Expired CA cert -> reload MUST fail with error
	dir2 := t.TempDir()
	cm2, err := newCertManagerAt(dir2)
	if err != nil {
		t.Fatal(err)
	}
	template := *cm2.caCert
	template.NotBefore = time.Now().Add(-48 * time.Hour)
	template.NotAfter = time.Now().Add(-24 * time.Hour)
	expiredDer, err := x509.CreateCertificate(rand.Reader, &template, &template, &cm2.caPrivKey.PublicKey, cm2.caPrivKey)
	if err != nil {
		t.Fatal(err)
	}
	caPemPath := filepath.Join(dir2, "ssl", "certs", "ca.pem")
	if err := os.WriteFile(caPemPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: expiredDer}), 0644); err != nil {
		t.Fatal(err)
	}
	_, err = newCertManagerAt(dir2)
	if err == nil {
		t.Fatalf("expected error for expired CA, but succeeded")
	}

	// 5. Insecure symlink for keysDir -> reload MUST fail
	dir3 := t.TempDir()
	targetDir := filepath.Join(dir3, "actual_keys")
	os.MkdirAll(targetDir, 0700)
	sslDir := filepath.Join(dir3, "ssl")
	os.MkdirAll(sslDir, 0700)
	symlinkKeys := filepath.Join(sslDir, "keys")
	os.Symlink(targetDir, symlinkKeys)
	_, err = newCertManagerAt(dir3)
	if err == nil {
		t.Fatalf("expected error for symlink directory, but succeeded")
	}
}
