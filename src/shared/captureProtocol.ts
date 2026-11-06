/** Transport evidence describes a protocol family; it never invents a TLS scheme. */
export interface ProtocolEvidence {
  family: 'http' | 'websocket' | 'unknown';
  ruleVersion: '1';
  evidence: string[];
}
export interface ProtocolCapture {
  transport?: string;
  schemaVersion?: string;
  method?: string;
  statusCode?: number;
  headers?: Record<string, unknown>;
  body?: unknown;
}
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve duplicate case-insensitive header names for validation by the identity adapter. */
export function headerValues(headers: Record<string, unknown> | undefined, name: string): unknown[] {
  return Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
}
export function captureProtocol(input: ProtocolCapture): ProtocolEvidence {
  const result = (family: ProtocolEvidence['family'], evidence: string[]): ProtocolEvidence => ({ family, ruleVersion: '1', evidence });
  if (['http', 'https'].includes(input.transport || '')) return result('http', ['transport']);
  if (['ws', 'wss'].includes(input.transport || '')) return result('websocket', ['transport']);
  if (input.transport || input.schemaVersion !== '2.0.0') return result('unknown', []);
  const single = (name: string): string | undefined => {
    const values = headerValues(input.headers, name);
    return values.length === 1 && typeof values[0] === 'string' ? values[0] : undefined;
  };
  const upgrade = single('upgrade')?.toLowerCase();
  const connection = single('connection')?.toLowerCase().split(',').map(value => value.trim()) || [];
  const body = isObject(input.body) ? input.body : undefined;
  if (input.method === 'GET' && input.statusCode === 101 && upgrade === 'websocket' && connection.includes('upgrade') &&
      single('sec-websocket-version') === '13' && body?.type === 'response.create') {
    return result('websocket', ['schema_version', 'method', 'status_code', 'headers.connection', 'headers.upgrade', 'headers.sec-websocket-version', 'body.type']);
  }
  if (input.method === 'POST' && !headerValues(input.headers, 'upgrade').length &&
      headerValues(input.headers, 'connection').length <= 1 && !connection.includes('upgrade') &&
      single('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json' && body && body.type === undefined) {
    return result('http', ['schema_version', 'method', 'headers.content-type', 'headers.upgrade:absent', 'headers.connection:no-upgrade', 'body.type:absent']);
  }
  return result('unknown', []);
}
