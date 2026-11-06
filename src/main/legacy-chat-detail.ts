import { extractRequestInfo } from './parser';
import { extractUserPromptFromRecord } from './session';
import type { AuditRecord } from './types';

// Model classification and record identity remain unchanged. This is a read-time view of
// retained, complete legacy Chat Completions request evidence, never a database repair.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export function legacyChatDetail(record: AuditRecord, request: string): AuditRecord {
  if (record.provider !== 'unknown' || record.capture_status !== 'complete' || record.content_expired ||
      !/^\/v2\/chat\/completions(?:\?.*)?$/i.test(record.url_path || '') || !request ||
      Buffer.byteLength(request) > MAX_REQUEST_BYTES ||
      (record.system_prompt && record.prompt_summary && record.user_prompt)) return record;
  try {
    const data: unknown = JSON.parse(request);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray((data as any).messages)) return record;
    const info = extractRequestInfo('openai', request, record.url_path);
    const last = info.messages.at(-1);
    let summary = (last?.text || '').slice(0, 300).replace(/\n/g, ' ').trim();
    if ((!summary || last?.role === 'tool') && last?.tools) {
      summary = `[Tool Result: ${last.tools.map((item: any) => item.name || 'tool').slice(0, 2).join(', ')}]`;
    }
    return { ...record,
      system_prompt: record.system_prompt || info.system_prompt || '',
      prompt_summary: record.prompt_summary || summary,
      user_prompt: record.user_prompt || (last?.role === 'user' && last.text ? extractUserPromptFromRecord({ request_body: JSON.stringify({ messages: [{ role: 'user', content: last.text }] }), prompt_summary: '' }) : '') };
  } catch {
    // Invalid or partial message structures are not evidence.
    return record;
  }
}
