/**
 * Data Sanitization & Fixture Export for PromptLens
 * Anonymizes sensitive credentials, tokens, cookies, emails, and user home paths.
 * Exported content still requires human review before sharing.
 */

import { AuditRecord } from './types';

import { sanitizeText, sanitizeHeaders } from '../shared/redaction';
import { redactAddress } from '../shared/communication';
export { sanitizeText, sanitizeHeaders } from '../shared/redaction';

export interface SanitizedExportFixture {
  id?: number;
  exported_at: string;
  transport?: string;
  address?: string;
  body_format?: string;
  body_encoding?: string;
  provider: string;
  model: string;
  agent_name: string;
  method: string;
  url_path: string;
  status_code: number;
  request_headers: Record<string, string>;
  request_body: string;
  response_body: string;
  extracted_meta: {
    response_text?: string;
    thinking_text?: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    thinking_tokens: number;
    total_tokens: number;
    finish_reason?: string;
    confidence?: string;
  };
}

export function createSanitizedFixture(record: AuditRecord): SanitizedExportFixture {
  const rawHeaders =
    typeof record.request_headers === 'string'
      ? (() => {
          try {
            return JSON.parse(record.request_headers);
          } catch {
            return {};
          }
        })()
      : record.request_headers || {};

  return {
    id: record.id,
    transport: record.transport,
    address: sanitizeText(redactAddress(record.address || '')),
    body_format: record.body_format,
    body_encoding: record.body_encoding,
    exported_at: new Date().toISOString(),
    provider: record.provider,
    model: record.model,
    agent_name: record.agent_name,
    method: record.method,
    url_path: sanitizeText(redactAddress(record.url_path)),
    status_code: record.status_code,
    request_headers: sanitizeHeaders(rawHeaders),
    request_body: sanitizeText(record.request_body),
    response_body: sanitizeText(record.response_body),
    extracted_meta: {
      response_text: sanitizeText(record.response_text || ''),
      thinking_text: sanitizeText(record.thinking_text || ''),
      input_tokens: record.input_tokens,
      output_tokens: record.output_tokens,
      cached_tokens: record.cached_tokens,
      thinking_tokens: record.thinking_tokens,
      total_tokens: record.total_tokens,
      finish_reason: record.finish_reason,
      confidence: record.confidence || 'exact'
    }
  };
}
