import http from 'http';
import https from 'https';

type Result = { ok: boolean; latencyMs: number; message: string };
/** A connectivity probe, never a model request or an end-to-end capture claim. */
export async function testUpstreamConnectivity(proxy: string, target = 'https://generativelanguage.googleapis.com'): Promise<Result> {
  const start = Date.now();
  let upstream: URL | undefined;
  try {
    if (proxy) {
      upstream = new URL(proxy);
      if (!['http:', 'https:'].includes(upstream.protocol)) return { ok: false, latencyMs: 0, message: '当前仅支持 HTTP/HTTPS 上游代理，不支持 SOCKS' };
      if (!upstream.hostname || upstream.hash || upstream.search || upstream.pathname !== '/') throw new Error('invalid');
    }
  } catch { return { ok: false, latencyMs: 0, message: '代理地址格式错误' }; }
  return new Promise(resolve => {
    const finish = (ok: boolean, message: string) => resolve({ ok, latencyMs: Date.now() - start, message });
    const dest = new URL(target);
    const transport = (upstream || dest).protocol === 'https:' ? https : http;
    const request = upstream ? transport.request({
      hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: `${dest.hostname}:${dest.port || 443}`, timeout: 6000,
      headers: upstream.username || upstream.password ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')}` } : {}
    }) : transport.request(dest, { method: 'HEAD', timeout: 6000 });
    request.on('connect', (response, socket) => {
      socket.destroy();
      finish(response.statusCode === 200, `代理隧道响应 HTTP ${response.statusCode}；尚未验证目标 TLS 或模型调用`);
    });
    request.on('response', response => {
      response.resume();
      finish(!upstream, `HTTP ${response.statusCode}；仅验证网络可达性`);
    });
    request.on('timeout', () => { request.destroy(); finish(false, '连接测试超时 (6s)'); });
    request.on('error', () => finish(false, '连接失败，请检查地址、认证与证书信任'));
    request.end();
  });
}
