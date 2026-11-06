/** Verified UI notices endpoint; unrelated to model or session classification. */
export function isExcludedBackgroundRequest(input: {
  method?: string; address?: string; url_path?: string; request_headers?: Record<string, unknown>;
}): boolean {
  if (input.method !== 'GET') return false;
  const addresses = [input.address, input.url_path].filter((value): value is string => Boolean(value && /^https?:\/\//.test(value)));
  const hosts: string[] = [];
  let pathname: string | undefined;
  for (const address of addresses) {
    try {
      // Preserve literal path; URL normalization must not broaden an exclusion.
      const url = new URL(address);
      const rawPath = address.match(/^https?:\/\/[^/?#]+([^?#]*)/)?.[1] || '/';
      if (url.username || url.password || rawPath !== '/v1internal/cascadeNuxes') return false;
      hosts.push(url.hostname);
      pathname = rawPath;
    } catch { return false; }
  }
  if (input.url_path && !/^https?:\/\//.test(input.url_path)) {
    const path = input.url_path.split(/[?#]/, 1)[0];
    if (pathname && pathname !== path) return false;
    pathname = path;
  }
  for (const [key, value] of Object.entries(input.request_headers || {})) {
    if (key.toLowerCase() !== 'host') continue;
    if (typeof value !== 'string' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(value)) return false;
    hosts.push(value.replace(/:\d+$/, '').toLowerCase());
  }
  return pathname === '/v1internal/cascadeNuxes' && hosts.length > 0 &&
    hosts.every(host => host === 'daily-cloudcode-pa.googleapis.com');
}
