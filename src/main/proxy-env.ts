export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** One source for the dashboard and tray's POSIX shell setup. */
export function buildProxyEnv(port: number, caPath: string, caBundlePath: string): string {
  const quote = shellQuote;
  const proxy = `http://127.0.0.1:${port}`;
  // Keep PromptLens' own control plane reachable without re-entering the
  // auditing proxy, while allowing local model gateways such as
  // http://localhost:20128 (9router) to be captured.
  const bypass = 'localhost:8897,localhost:8088,127.0.0.1:8897,127.0.0.1:8088,[::1]:8897,[::1]:8088';
  const vars: Record<string, string> = {
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    NO_PROXY: bypass, no_proxy: bypass,
    NODE_EXTRA_CA_CERTS: caPath, SSL_CERT_FILE: caBundlePath,
    REQUESTS_CA_BUNDLE: caBundlePath, CURL_CA_BUNDLE: caBundlePath
  };
  return Object.entries(vars).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n');
}
