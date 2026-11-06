/** Explicit transport is independent from the API and the body representation. */
export function describeCommunication(record: { transport?: string; protocol_family?: 'http' | 'websocket' | 'unknown'; body_format?: string; address?: string; url_path?: string }) {
  const path = record.url_path || '';
  const api = /\/responses(?:[?#]|$)/i.test(path) ? 'Responses API'
    : /\/chat\/completions(?:[?#]|$)/i.test(path) ? 'Chat Completions'
    : /\/messages(?:[?#]|$)/i.test(path) ? 'Messages API'
    : /generatecontent/i.test(path) ? 'GenerateContent'
    : '';
  const address = redactAddress(record.address || path);
  const format = record.body_format || '';
  return { transport: record.transport && record.transport.toLowerCase() !== 'unknown' ? record.transport.toUpperCase() : record.protocol_family === 'http' ? 'HTTP' : record.protocol_family === 'websocket' ? 'WebSocket' : '', api,
    format: format === 'ws-messages-v1' ? 'JSON 消息'
      : ['legacy', 'unknown', ''].includes(format) ? ''
      : format.toUpperCase(),
    address: address === '地址无效' ? '' : address };
}

export function redactAddress(address: string): string {
  if (!address) return '';
  try {
    const absolute = /^[a-z]+:\/\//i.test(address);
    const url = new URL(address, 'http://unknown.invalid');
    url.username = ''; url.password = ''; url.hash = '';
    // Query values may contain credentials under arbitrary names. Keep names only.
    for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, '[REDACTED]');
    return absolute ? url.toString() : url.pathname + url.search;
  } catch { return '地址无效'; }
}

export interface SocketMessage { direction: 'client' | 'server'; sequence: number; payload: string }
export function socketMessages(raw: string): SocketMessage[] {
  const envelope = JSON.parse(raw);
  if (envelope?.format !== 'ws-messages-v1' || !Array.isArray(envelope.messages)) throw new Error('WebSocket 原文格式无效');
  if (!envelope.messages.every((m: any) => (m.direction === 'client' || m.direction === 'server') && Number.isInteger(m.sequence) && typeof m.payload === 'string')) throw new Error('WebSocket 消息格式无效');
  return envelope.messages;
}
