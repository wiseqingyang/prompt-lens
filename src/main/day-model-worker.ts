import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';
import { ContentStore } from './content-store';
import { codexResponseModel, modelResponseEvents } from './codex-model';
import { isWebFetchRequest } from '../shared/protocol';
import { getAgentCategory } from '../shared/agent';
import type { DayModelUsageItem } from './types';

// Bound work from a single user selection; exceeding a bound is an error, not a partial result.
const MAX_CANDIDATES = 1000;
const MAX_FIELD_BYTES = 8 * 1024 * 1024;
const { dbPath, date, agent } = workerData as {dbPath: string; date: string; agent?: string};

function run() {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (agent !== undefined && (typeof agent !== 'string' || agent.length > 128))) throw new Error('Invalid daily statistics parameters');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 5000');
    db.function('agent_category', { deterministic: true }, getAgentCategory);
    db.function('is_model_request', { deterministic: true }, (url: unknown) => isWebFetchRequest(String(url || '')) ? 0 : 1);
    return db.transaction(() => {
      const params: Record<string, string> = { day: date };
      let clause = '';
      if (agent && agent !== 'all') { clause = 'AND LOWER(agent_category(u.agent_name)) = @agent'; params.agent = agent.toLowerCase().trim(); }
      const where = `is_model_request(u.url_path) = 1 AND strftime('%Y-%m-%d', u.created_at, 'localtime') = @day ${clause}`;
      const rows = db.prepare(`SELECT COALESCE(NULLIF(u.model, ''), 'unknown') model,
        COALESCE(SUM(u.total_tokens),0) total_tokens, COALESCE(SUM(u.input_tokens),0) input_tokens,
        COALESCE(SUM(u.output_tokens),0) output_tokens, COUNT(*) request_count,
        SUM(CASE WHEN u.token_source = 'reported' THEN 1 ELSE 0 END) reported_requests
        FROM usage_events u WHERE ${where} GROUP BY COALESCE(NULLIF(u.model, ''), 'unknown')`).all(params) as DayModelUsageItem[];
      const grouped = new Map(rows.map(row => [row.model, row]));
      const unknown = grouped.get('unknown');
      const candidates = db.prepare(`SELECT u.id, u.event_id, u.agent_name, u.url_path, u.input_tokens, u.output_tokens, u.total_tokens, u.token_source,
          r.body_format, r.capture_status, r.content_expired
        FROM usage_events u JOIN records r ON r.id = u.id AND COALESCE(r.event_id,'') = COALESCE(u.event_id,'')
        WHERE ${where} AND COALESCE(NULLIF(u.model,''),'unknown') = 'unknown' AND r.content_expired = 0
          AND (u.url_path = '/v2/chat/completions' OR u.url_path LIKE '/v2/chat/completions?%'
            OR (u.agent_name = 'Codex' AND (u.url_path = '/backend-api/codex/responses' OR u.url_path LIKE '/backend-api/codex/responses?%' OR u.url_path = '/v1/responses' OR u.url_path LIKE '/v1/responses?%')))
        ORDER BY u.id LIMIT ${MAX_CANDIDATES + 1}`).all(params) as any[];
      if (candidates.length > MAX_CANDIDATES) throw new Error('Model evidence exceeds daily record budget');
      const store = new ContentStore(db);
      const meta = db.prepare('SELECT raw_length FROM content_fields WHERE record_id = ? AND field = ?');
      const read = (row: any, field: 'request_body' | 'response_body'): string => {
        const entry = meta.get(row.id, field) as { raw_length: number } | undefined;
        if (entry && (entry.raw_length < 0 || entry.raw_length > MAX_FIELD_BYTES)) throw new Error('Model evidence exceeds field budget');
        // Load each legacy value only after checking its encoded size; never accumulate bodies in the candidate list.
        const stored = db.prepare(`SELECT length(CAST(${field} AS BLOB)) bytes, CASE WHEN length(CAST(${field} AS BLOB)) <= ? THEN ${field} ELSE NULL END value FROM records WHERE id = ?`).get(MAX_FIELD_BYTES, row.id) as { bytes: number | null; value: unknown };
        if ((stored.bytes || 0) > MAX_FIELD_BYTES) throw new Error('Model evidence exceeds field budget');
        const value = stored.value;
        let result: string;
        if (entry) result = store.read(row.id, field, value);
        else if (Buffer.isBuffer(value)) result = zlib.inflateRawSync(value, { maxOutputLength: MAX_FIELD_BYTES }).toString('utf8');
        else result = typeof value === 'string' ? value : '';
        const bytes = Buffer.byteLength(result);
        if (bytes > MAX_FIELD_BYTES) throw new Error('Model evidence exceeds field budget');
        return result;
      };
      const resolved = new Map<number, string>();
      for (const row of candidates) {
        const request = read(row, 'request_body'), response = read(row, 'response_body');
        let requestModel: unknown;
        try { const data = JSON.parse(request); if (data && typeof data === 'object' && !Array.isArray(data)) requestModel = data.model; } catch { /* no complete request object */ }
        const events = modelResponseEvents(response, row.body_format) as any[];
        let model: string | undefined;
        if (/^\/v2\/chat\/completions(?:\?.*)?$/i.test(row.url_path)) {
          const names = new Set<string>();
          const add = (v: unknown) => { if (typeof v === 'string' && v && v === v.trim() && v !== 'unknown') names.add(v); };
          if (row.capture_status === 'complete') add(requestModel);
          for (const event of events) if (event && typeof event === 'object' && !Array.isArray(event) &&
            ['chat.completion', 'chat.completion.chunk'].includes(event.object) && Array.isArray(event.choices)) add(event.model);
          model = names.size === 1 ? [...names][0] : undefined;
        } else model = codexResponseModel(row.agent_name, row.url_path, requestModel, events);
        if (!model || model === 'unknown' || !unknown) continue;
        resolved.set(row.id, model);
        const target = grouped.get(model) || { model, total_tokens: 0, input_tokens: 0, output_tokens: 0, request_count: 0, reported_requests: 0 };
        grouped.set(model, target);
        for (const field of ['total_tokens', 'input_tokens', 'output_tokens'] as const) {
          const value = Number(row[field] || 0); unknown[field] -= value; target[field] += value;
        }
        unknown.request_count--; target.request_count++;
        if (row.token_source === 'reported') { unknown.reported_requests--; target.reported_requests++; }
      }
      const models = [...grouped.values()].filter(row => row.request_count > 0).sort((a,b) => b.total_tokens - a.total_tokens);
      const details = db.prepare(`SELECT u.id, u.event_id, u.session_id, u.agent_name, u.provider, u.model, u.token_source, u.status_code, u.capture_status, u.user_prompt, u.prompt_summary, u.duration_ms,
        u.input_tokens, u.output_tokens, u.cached_tokens, u.thinking_tokens, u.total_tokens, u.created_at
        FROM usage_events u WHERE ${where} ORDER BY u.total_tokens DESC LIMIT 50`).all(params) as any[];
      for (const row of details) if (resolved.has(row.id)) row.model = resolved.get(row.id);
      return { models, details };
    }).deferred();
  } finally { db.close(); }
}

try { parentPort?.postMessage({ result: run() }); }
catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
