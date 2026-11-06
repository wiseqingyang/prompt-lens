/** Pattern-based redaction; never a guarantee that arbitrary content is safe to publish. */
export const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'anthropic-api-key',
  'x-goog-api-key',
  'openai-organization',
  'openai-project'
]);

export function sanitizeText(text: string): string {
  if (!text || typeof text !== 'string') return text || '';

  return text
    // 1. Redact Bearer tokens & OAuth credentials
    .replace(/(bearer\s+)[A-Za-z0-9_\-\.]{15,}/gi, '$1[REDACTED_TOKEN]')
    .replace(/(sk-[A-Za-z0-9_\-]{20,})/gi, 'sk-[REDACTED_API_KEY]')
    .replace(/(AIza[0-9A-Za-z_\-]{30,})/g, 'AIza[REDACTED_GOOGLE_KEY]')
    // 2. Redact system user home paths
    .replace(/(\/Users\/)[a-zA-Z0-9_\-\.]+(\/)/g, '$1[USER]$2')
    .replace(/(\/home\/)[a-zA-Z0-9_\-\.]+(\/)/g, '$1[USER]$2')
    .replace(/(C:\\Users\\)[a-zA-Z0-9_\-\.]+(\\)/gi, '$1[USER]$2')
    // 3. Redact email addresses
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED_EMAIL]');
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lk)) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = sanitizeText(String(v));
    }
  }
  return result;
}
