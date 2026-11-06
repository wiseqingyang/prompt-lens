package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type CertManager struct {
	caCert    *x509.Certificate
	caPrivKey *rsa.PrivateKey
	tlsCert   tls.Certificate
	cache     sync.Map // map[string]*tls.Certificate
}

func secureDirectory(dir string, perm os.FileMode) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("安全错误: 拒绝使用符号链接目录: %s", dir)
	}
	if !fi.IsDir() {
		return fmt.Errorf("路径不是目录: %s", dir)
	}
	if fi.Mode().Perm() != perm {
		return os.Chmod(dir, perm)
	}
	return nil
}

func secureFile(file string, perm os.FileMode) error {
	fi, err := os.Lstat(file)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("安全错误: 拒绝使用符号链接文件: %s", file)
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("路径不是常规文件: %s", file)
	}
	if fi.Mode().Perm() != perm {
		return os.Chmod(file, perm)
	}
	return nil
}

func NewCertManager() (*CertManager, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	defaultDir := filepath.Join(home, ".prompt-lens")
	return newCertManagerAt(defaultDir)
}

func newCertManagerAt(baseDir string) (*CertManager, error) {
	var err error
	if err := os.MkdirAll(baseDir, 0700); err != nil {
		return nil, err
	}
	_ = secureDirectory(baseDir, 0700)

	sslDir := filepath.Join(baseDir, "ssl")
	certsDir := filepath.Join(sslDir, "certs")
	keysDir := filepath.Join(sslDir, "keys")
	if err := os.MkdirAll(certsDir, 0755); err != nil {
		return nil, err
	}
	if err := secureDirectory(certsDir, 0755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(keysDir, 0700); err != nil {
		return nil, err
	}
	if err := secureDirectory(keysDir, 0700); err != nil {
		return nil, err
	}

	caPemPath := filepath.Join(certsDir, "ca.pem")
	caKeyPath := filepath.Join(keysDir, "ca.private.key")
	caCrtPath := filepath.Join(baseDir, "ca.crt")

	var caCert *x509.Certificate
	var caPrivKey *rsa.PrivateKey

	_, pemStatErr := os.Lstat(caPemPath)
	_, keyStatErr := os.Lstat(caKeyPath)
	pemExists := pemStatErr == nil
	keyExists := keyStatErr == nil

	if !pemExists && !keyExists {
		// 1. Neither exists: generate a fresh RFC 5280 compliant CA
		fmt.Println("\x1b[1;33m[Go-Core]\x1b[0m No existing CA credentials found, generating RFC 5280 Root CA...")
		caPrivKey, err = rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}

		pubKeyBytes := x509.MarshalPKCS1PublicKey(&caPrivKey.PublicKey)
		pubKeyHash := sha1.Sum(pubKeyBytes)

		serialNumber, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		caTemplate := &x509.Certificate{
			SerialNumber: serialNumber,
			Subject: pkix.Name{
				CommonName:   "PromptLens Root CA",
				Organization: []string{"PromptLens"},
				Country:      []string{"CN"},
			},
			NotBefore:             time.Now().Add(-24 * time.Hour),
			NotAfter:              time.Now().Add(3650 * 24 * time.Hour), // 10 years
			KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
			BasicConstraintsValid: true,
			IsCA:                  true,
			MaxPathLen:            2,
			SubjectKeyId:          pubKeyHash[:],
		}

		caDer, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caPrivKey.PublicKey, caPrivKey)
		if err != nil {
			return nil, err
		}

		caCert, err = x509.ParseCertificate(caDer)
		if err != nil {
			return nil, err
		}

		// Save CA cert and key atomically
		certPem := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDer})
		keyPem := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(caPrivKey)})

		tmpKeyPath := fmt.Sprintf("%s.%d.tmp", caKeyPath, time.Now().UnixNano())
		if err := os.WriteFile(tmpKeyPath, keyPem, 0600); err != nil {
			return nil, err
		}
		if err := os.Rename(tmpKeyPath, caKeyPath); err != nil {
			_ = os.Remove(tmpKeyPath)
			return nil, err
		}
		_ = secureFile(caKeyPath, 0600)

		if err := os.WriteFile(caPemPath, certPem, 0644); err != nil {
			return nil, err
		}
		fmt.Printf("\x1b[1;32m[Go-Core]\x1b[0m Root CA generated and synced to: %s\n", caCrtPath)
	} else if !pemExists || !keyExists {
		return nil, fmt.Errorf("CA 材料不完整 (ca.pem 存在=%v, ca.private.key 存在=%v)，拒绝静默重新生成以防止破坏已有信任", pemExists, keyExists)
	} else {
		// 2. Both exist: load and strictly validate without silent rotation
		if err := secureFile(caKeyPath, 0600); err != nil {
			return nil, fmt.Errorf("修正私钥权限失败: %w", err)
		}
		certBytes, err := os.ReadFile(caPemPath)
		if err != nil {
			return nil, fmt.Errorf("读取 CA 证书失败: %w", err)
		}
		keyBytes, err := os.ReadFile(caKeyPath)
		if err != nil {
			return nil, fmt.Errorf("读取 CA 私钥失败: %w", err)
		}

		blockCert, _ := pem.Decode(certBytes)
		if blockCert == nil {
			return nil, fmt.Errorf("CA 证书内容损坏 (无法解码 PEM)，拒绝静默轮换")
		}
		parsedCert, err := x509.ParseCertificate(blockCert.Bytes)
		if err != nil {
			return nil, fmt.Errorf("CA 证书解析失败 (%w)，拒绝静默轮换", err)
		}

		blockKey, _ := pem.Decode(keyBytes)
		if blockKey == nil {
			return nil, fmt.Errorf("CA 私钥内容损坏 (无法解码 PEM)，拒绝静默轮换")
		}
		parsedKey, err := x509.ParsePKCS1PrivateKey(blockKey.Bytes)
		if err != nil {
			if parsedKeyAny, err2 := x509.ParsePKCS8PrivateKey(blockKey.Bytes); err2 == nil {
				if rsaKey, ok := parsedKeyAny.(*rsa.PrivateKey); ok {
					parsedKey = rsaKey
				} else {
					return nil, fmt.Errorf("CA 私钥非 RSA 私钥格式")
				}
			} else {
				return nil, fmt.Errorf("CA 私钥解析失败 (%w)，拒绝静默轮换", err)
			}
		}

		// Strictly validate CA validity
		now := time.Now()
		if now.Before(parsedCert.NotBefore) {
			return nil, fmt.Errorf("CA 证书尚未生效 (notBefore: %s)", parsedCert.NotBefore)
		}
		if now.After(parsedCert.NotAfter) {
			return nil, fmt.Errorf("CA 证书已于 %s 过期，请手动确认后处理", parsedCert.NotAfter)
		}
		if !parsedCert.IsCA {
			return nil, fmt.Errorf("证书缺少 IsCA=true 约束")
		}
		if parsedCert.KeyUsage&x509.KeyUsageCertSign == 0 {
			return nil, fmt.Errorf("证书缺少 KeyUsageCertSign 签发权限")
		}
		if !parsedKey.PublicKey.Equal(parsedCert.PublicKey) {
			return nil, fmt.Errorf("CA 证书与私钥公钥不匹配，拒绝静默覆盖")
		}

		caCert = parsedCert
		caPrivKey = parsedKey
	}

	fp := fmt.Sprintf("%X", sha256.Sum256(caCert.Raw))
	fmt.Printf("\x1b[1;32m[Go-Core]\x1b[0m Root CA verified, SHA256 fingerprint: %s\n", fp)

	if err := os.WriteFile(caCrtPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caCert.Raw}), 0644); err != nil {
		return nil, err
	}

	// Ensure SubjectKeyId exists on CA
	if len(caCert.SubjectKeyId) == 0 {
		pubKeyBytes := x509.MarshalPKCS1PublicKey(&caPrivKey.PublicKey)
		pubKeyHash := sha1.Sum(pubKeyBytes)
		caCert.SubjectKeyId = pubKeyHash[:]
	}

	tlsCert := tls.Certificate{
		Certificate: [][]byte{caCert.Raw},
		PrivateKey:  caPrivKey,
	}

	return &CertManager{
		caCert:    caCert,
		caPrivKey: caPrivKey,
		tlsCert:   tlsCert,
	}, nil
}

func (cm *CertManager) GetOrCreateCertificate(host string) (*tls.Certificate, error) {
	// Strip port if present
	if strings.Contains(host, ":") {
		h, _, err := net.SplitHostPort(host)
		if err == nil {
			host = h
		}
	}
	host = strings.ToLower(strings.TrimSpace(host))

	if val, ok := cm.cache.Load(host); ok {
		return val.(*tls.Certificate), nil
	}

	// Generate a dedicated host certificate
	privKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}

	pubKeyBytes := x509.MarshalPKCS1PublicKey(&privKey.PublicKey)
	pubKeyHash := sha1.Sum(pubKeyBytes)

	serialNumber, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName:   host,
			Organization: []string{"PromptLens Mitm Authority"},
		},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(730 * 24 * time.Hour), // 2 years
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
		SubjectKeyId:          pubKeyHash[:],
		AuthorityKeyId:        cm.caCert.SubjectKeyId, // RFC 5280 Required AKI!
	}

	if ip := net.ParseIP(host); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{host}
		if !strings.HasPrefix(host, "*.") && strings.Count(host, ".") >= 2 {
			// Add wildcard support if applicable
			parts := strings.SplitN(host, ".", 2)
			template.DNSNames = append(template.DNSNames, "*."+parts[1])
		}
	}

	certDer, err := x509.CreateCertificate(rand.Reader, template, cm.caCert, &privKey.PublicKey, cm.caPrivKey)
	if err != nil {
		return nil, err
	}

	tlsCert := &tls.Certificate{
		Certificate: [][]byte{certDer, cm.caCert.Raw},
		PrivateKey:  privKey,
	}

	cm.cache.Store(host, tlsCert)
	return tlsCert, nil
}
