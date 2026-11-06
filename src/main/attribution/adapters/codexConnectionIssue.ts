import type { CaptureInput } from '../contracts';
import type { ConnectionIssue } from '../../../shared/attribution';
import { getAgentCategory } from '../../../shared/agent';
import { isObject } from '../../../shared/captureProtocol';

/** Strict captured-event contract, independent of session/turn identity and error prose. */
export function codexConnectionIssue(input: CaptureInput): ConnectionIssue | undefined {
  const capture = input.connection;
  if (getAgentCategory(input.agentName) !== 'Codex' || input.contentExpired ||
      input.schemaVersion !== '3.0.0' || input.transport !== 'wss' || input.method !== 'GET' ||
      input.statusCode !== 101 || input.attribution !== 'connection' || !capture ||
      capture.requestBodyEmpty !== true || capture.captureStatus !== 'error' ||
      capture.truncatedReason !== 'websocket_connection_error_unattributed') return;
  const envelope = capture.response;
  if (!isObject(envelope) || envelope.format !== 'ws-messages-v1' ||
      !Array.isArray(envelope.messages) || envelope.messages.length !== 1) return;
  const message = envelope.messages[0];
  if (!isObject(message) || message.direction !== 'server' || typeof message.payload !== 'string') return;
  let frame: unknown;
  try { frame = JSON.parse(message.payload); } catch { return; }
  if (!isObject(frame) || frame.type !== 'error' || !isObject(frame.error) ||
      ['stream_id', 'response_id', 'response'].some(key => Object.hasOwn(frame, key))) return;
  const error = frame.error;
  let kind: ConnectionIssue['kind'], statusCode: ConnectionIssue['statusCode'], statusPath: string;
  if (error.type === 'usage_limit_reached' && !Object.hasOwn(error, 'code') &&
      !Object.hasOwn(frame, 'status') && frame.status_code === 429) {
    kind = 'usage_limit'; statusCode = 429; statusPath = 'status_code';
  } else if (!Object.hasOwn(frame, 'status_code') && frame.status === 400 &&
      error.type === 'invalid_request_error' && error.code === 'websocket_connection_limit_reached') {
    kind = 'connection_limit'; statusCode = 400; statusPath = 'status';
  } else if (!Object.hasOwn(frame, 'status_code') && frame.status === 503 &&
      error.type === 'server_error' && error.code === 'server_error') {
    kind = 'server_error'; statusCode = 503; statusPath = 'status';
  } else return;
  const prefix = 'response_body.messages[0]';
  return { kind, ruleVersion: '1', statusCode, evidence: [
    'agent_name', 'schema_version', 'transport', 'method', 'status_code', 'attribution',
    'content_expired', 'request_body:empty', 'capture_status', 'truncated_reason',
    'response_body.format', 'response_body.messages:length=1', `${prefix}.direction`,
    `${prefix}.payload.type`, `${prefix}.payload.error.type`,
    `${prefix}.payload.error.code${kind === 'usage_limit' ? ':absent' : ''}`,
    `${prefix}.payload.${statusPath}`, `${prefix}.payload.${statusPath === 'status' ? 'status_code' : 'status'}:absent`,
    ...['stream_id', 'response_id', 'response'].map(key => `${prefix}.payload.${key}:absent`)
  ] };
}
