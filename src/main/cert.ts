/**
 * PromptLens Root CA Certificate Manager
 * Handles CA certificate generation and one-click native OS trust injection
 * for macOS Keychain and Windows Certificate Store.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';
import tls from 'tls';
import nodeCrypto from 'crypto';

const runFile = util.promisify(execFile);
export interface CertificateStatus {
  state: 'missing' | 'invalid' | 'expired' | 'untrusted' | 'trusted' | 'unknown';
  fingerprint?: string;
  path: string;
  message: string;
}
type CertRuntime = { platform?: NodeJS.Platform; run?: (file: string, args: string[]) => Promise<unknown> };

export class CertManager {
  private baseDir: string;
  private sslDir: string;
  private caPemPath: string;
  private caCrtPath: string;
  private caKeyPath: string;

  constructor(customBaseDir?: string, private runtime: CertRuntime = {}) {
    this.baseDir = customBaseDir || path.join(os.homedir(), '.prompt-lens');
    this.sslDir = path.join(this.baseDir, 'ssl');
    this.caPemPath = path.join(this.sslDir, 'certs', 'ca.pem');
    this.caCrtPath = path.join(this.baseDir, 'ca.crt');
    this.caKeyPath = path.join(this.sslDir, 'keys', 'ca.private.key');
  }

  private secureDirectory(dir: string, perm: number): void {
    if (!fs.existsSync(dir)) return;
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) {
      throw new Error(`安全错误: 拒绝使用符号链接目录: ${dir}`);
    }
    if ((stat.mode & 0o777) !== perm) {
      try { fs.chmodSync(dir, perm); } catch {}
    }
  }

  private secureFile(file: string, perm: number): void {
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new Error(`安全错误: 拒绝使用符号链接文件: ${file}`);
    }
    if ((stat.mode & 0o777) !== perm) {
      try { fs.chmodSync(file, perm); } catch {}
    }
  }

  public getSslDir(): string {
    return this.sslDir;
  }

  public getFingerprint(): string {
    const { caCertPath, exists } = this.getCertPaths();
    if (!exists) return 'unavailable';
    try {
      const raw = fs.readFileSync(caCertPath);
      return new nodeCrypto.X509Certificate(raw).fingerprint256;
    } catch {
      return 'error_reading_cert';
    }
  }

  /** SSL_CERT_FILE replaces a client's CA bundle; it is not an extra-CA setting. */
  public prepareAgentCaBundle(): string {
    const { caCertPath, exists } = this.getCertPaths();
    if (!exists) throw new Error('代理 CA 尚未生成，无法生成 Agent 信任证书包');
    const auditCa = fs.readFileSync(caCertPath, 'utf8');
    // Keep public roots even when an inherited SSL_CERT_FILE contains only our
    // MITM CA. Include OS roots for locally trusted enterprise certificates.
    const roots = new Set<string>(tls.rootCertificates.map((pem) => pem.trim()));
    if (typeof tls.getCACertificates === 'function') {
      for (const pem of tls.getCACertificates('system')) roots.add(pem.trim());
    }
    roots.add(auditCa.trim());
    const bundlePath = path.join(this.baseDir, 'agent-ca-bundle.pem');
    const content = Array.from(roots).join('\n') + '\n';
    if (!fs.existsSync(bundlePath) || fs.readFileSync(bundlePath, 'utf8') !== content) {
      const tempPath = `${bundlePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, content, { mode: 0o644 });
      fs.renameSync(tempPath, bundlePath);
    }
    return bundlePath;
  }

  public getCertPaths() {
    this.syncCaFiles();
    this.secureFile(this.caKeyPath, 0o600);
    const exists = fs.existsSync(this.caPemPath) || fs.existsSync(this.caCrtPath);
    return {
      sslDir: this.sslDir,
      caPemPath: this.caPemPath,
      caCertPath: fs.existsSync(this.caCrtPath) ? this.caCrtPath : this.caPemPath,
      caKeyPath: this.caKeyPath,
      exists
    };
  }

  public ensureCertDir(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    }
    this.secureDirectory(this.baseDir, 0o700);

    if (!fs.existsSync(this.sslDir)) {
      fs.mkdirSync(this.sslDir, { recursive: true, mode: 0o700 });
    }
    this.secureDirectory(this.sslDir, 0o700);

    const keysDir = path.join(this.sslDir, 'keys');
    if (fs.existsSync(keysDir)) {
      this.secureDirectory(keysDir, 0o700);
    }
    const certsDir = path.join(this.sslDir, 'certs');
    if (fs.existsSync(certsDir)) {
      this.secureDirectory(certsDir, 0o755);
    }

    this.secureFile(this.caKeyPath, 0o600);
  }

  public async getStatus(): Promise<CertificateStatus> {
    const certPath = fs.existsSync(this.caPemPath) ? this.caPemPath : this.caCrtPath;
    if (!fs.existsSync(certPath)) return { state: 'missing', path: certPath, message: '代理 CA 尚未生成' };
    let cert: nodeCrypto.X509Certificate;
    try {
      this.secureFile(certPath, 0o644);
      this.secureFile(this.caKeyPath, 0o600);
      cert = new nodeCrypto.X509Certificate(fs.readFileSync(certPath));
      if (fs.existsSync(this.caKeyPath) && !cert.checkPrivateKey(nodeCrypto.createPrivateKey(fs.readFileSync(this.caKeyPath)))) throw new Error('key mismatch');
    } catch { return { state: 'invalid', path: certPath, message: '证书格式无效或与私钥不匹配；不会自动替换' }; }
    const info = { path: certPath, fingerprint: cert.fingerprint256 };
    if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) {
      return { ...info, state: 'expired', message: '证书不在有效期内；请按恢复指南处理' };
    }
    if ((this.runtime.platform || process.platform) !== 'darwin') {
      return { ...info, state: 'unknown', message: '证书已生成；本平台需在系统证书管理器中核实信任状态' };
    }
    try {
      await this.run('/usr/bin/security', ['verify-cert', '-c', certPath, '-p', 'ssl']);
      return { ...info, state: 'trusted', message: '系统证书验证通过；各 Agent 的独立信任设置仍需按接入指南配置' };
    } catch (error: any) {
      if (typeof error.code === 'number') return { ...info, state: 'untrusted', message: '系统未通过证书验证，请检查信任设置' };
      return { ...info, state: 'unknown', message: '无法读取系统信任状态，请手动检查' };
    }
  }

  private run(file: string, args: string[]): Promise<unknown> {
    return this.runtime.run ? this.runtime.run(file, args) : runFile(file, args, { timeout: 10000, maxBuffer: 1024 * 1024 });
  }

  /**
   * Syncs ca.pem generated by proxy core to ca.crt for easy user/agent reference
   */
  public syncCaFiles(): void {
    this.secureFile(this.caPemPath, 0o644);
    this.secureFile(this.caCrtPath, 0o644);
    try {
      if (fs.existsSync(this.caPemPath)) {
        fs.copyFileSync(this.caPemPath, this.caCrtPath);
      }
    } catch (e) {
      // Ignore copy error
    }
  }

  /**
   * One-click install and trust the CA certificate into native OS trust store.
   * macOS: User login keychain (no root/sudo required!)
   * Windows: CurrentUser Root Store (certutil -addstore -user Root)
   */
  public async installToSystemStore(): Promise<{ success: boolean; message: string }> {
    const status = await this.getStatus();
    if (['missing', 'invalid', 'expired'].includes(status.state)) return { success: false, message: status.message };
    this.syncCaFiles();
    const certPath = fs.existsSync(this.caCrtPath) ? this.caCrtPath : this.caPemPath;

    if (!fs.existsSync(certPath)) {
      return { success: false, message: 'CA 证书文件尚未生成，请先启动一次代理服务' };
    }

    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        // macOS: Install into user login keychain without sudo or password prompt!
        const loginKeychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
        await this.run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', loginKeychain, certPath]);
        return {
          success: true,
          message: '已成功将 PromptLens CA 证书导入 macOS 登录钥匙串并设置为受信任！'
        };
      } else if (platform === 'win32') {
        // Windows: Install into current user's Trusted Root Certification Authorities
        await this.run('certutil', ['-addstore', '-user', 'Root', certPath]);
        return {
          success: true,
          message: '已成功将 PromptLens CA 证书导入 Windows 个人受信任根证书存储库！'
        };
      } else if (platform === 'linux') {
        // Linux: Copy to trust store
        return {
          success: false,
          message: `尚未安装。请在终端中执行: sudo cp "${certPath}" /usr/local/share/ca-certificates/prompt-lens.crt && sudo update-ca-certificates`
        };
      } else {
        return { success: false, message: `暂不支持的操作系统: ${platform}` };
      }
    } catch (err: any) {
      return {
        success: false,
        message: `安装证书失败: ${err.message || err}`
      };
    }
  }
}
