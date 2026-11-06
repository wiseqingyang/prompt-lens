import type Database from 'better-sqlite3';
import { ContentStore, ContentReadCache } from '../content-store';
import type { AuditRecord } from '../types';
import type { CaptureInput } from './contracts';
import { getAgentCategory } from '../../shared/agent';

/** Build the rule input from stored capture facts, never from derived identity columns. */
export function captureInput(record: Partial<AuditRecord>, rawBody: string, rawResponse?: string): CaptureInput {
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { body = undefined; }
  let headers: Record<string, unknown> = {};
  try {
    const raw: unknown = typeof record.request_headers === 'string' ? JSON.parse(record.request_headers) : record.request_headers;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) headers = raw as Record<string, unknown>;
  } catch { /* Unreadable capture headers provide no identity evidence. */ }
  // This whitelist also bounds the cache input and excludes credentials.
  headers = Object.fromEntries(Object.entries(headers).filter(([key]) =>
    ['x-ide-name', 'x-ide-type', 'x-conversation-id', 'x-conversation-request-id', 'x-agent-type', 'x-agent-purpose',
      'originator', 'user-agent', 'thread-id', 'x-codex-turn-metadata', 'connection', 'upgrade', 'sec-websocket-version', 'content-type'].includes(key.toLowerCase())
  ).sort(([a], [b]) => a.localeCompare(b)));
  const result: CaptureInput = { agentName: record.agent_name || '', capturedAt: record.created_at || '', body,
    headers: record.content_expired ? {} : headers, transport: record.transport, schemaVersion: record.schema_version,
    attribution: record.attribution, method: record.method, statusCode: record.status_code,
    contentExpired: Boolean(record.content_expired) };
  if (!record.content_expired && record.attribution === 'connection' && getAgentCategory(record.agent_name) === 'Codex') {
    let response: unknown;
    try { response = JSON.parse(rawResponse || ''); } catch { /* Invalid content cannot classify an event. */ }
    result.connection = { requestBodyEmpty: rawBody === '', captureStatus: record.capture_status,
      truncatedReason: record.truncated_reason, response };
  }
  if (!record.content_expired && ['Antigravity', 'Pi'].includes(getAgentCategory(record.agent_name))) {
    result.responseEvidence = { body: rawResponse || '', complete: record.capture_status === 'complete' &&
      !record.truncated_reason && record.status_code !== undefined && (record.status_code >= 200 && record.status_code < 300 || getAgentCategory(record.agent_name) === 'Pi' && record.status_code === 101 && ['ws', 'wss'].includes(record.transport || '')) };
  }
  return result;
}

export function readCapture(db: Database.Database, id: number, cache?: ContentReadCache): CaptureInput {
  // A worker can read while capture/maintenance writes; all fields must share one snapshot.
  if (!db.inTransaction) return db.transaction(() => readCapture(db, id, cache)).deferred();
  const row = db.prepare(`SELECT id, agent_name, created_at, schema_version, transport, attribution, method,
    status_code, request_headers, request_body, content_expired, capture_status, truncated_reason
    FROM records WHERE id = ?`).get(id) as AuditRecord | undefined;
  if (!row || row.content_expired) return captureInput(row || { content_expired: 1 }, '');
  const store = new ContentStore(db, cache);
  // Responses are loaded only for adapters whose rule facts depend on them.
  let response: string | undefined;
  if (['Antigravity', 'Pi'].includes(getAgentCategory(row.agent_name)) || row.attribution === 'connection' && getAgentCategory(row.agent_name) === 'Codex') {
    const raw = db.prepare('SELECT response_body FROM records WHERE id=?').get(id) as { response_body: unknown };
    response = store.read(id, 'response_body', raw.response_body);
  }
  return captureInput(row, store.read(id, 'request_body', row.request_body), response);
}
