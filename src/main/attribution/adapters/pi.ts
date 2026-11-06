import { getAgentCategory } from '../../../shared/agent';
import { piIdentity } from '../../../shared/piIdentity';
import { captureProtocol } from '../../../shared/captureProtocol';
import { socketMessages } from '../../../shared/communication';
import type { AttributionReason, Resolution, TurnIdentity } from '../../../shared/attribution';
import { object, unresolved, type AgentAdapter, type PiApi, type CaptureFacts, type CaptureInput } from '../contracts';
import { decodePiArchive, reconcilePi } from './piArchive';

export const PI_RULE_VERSION = '3';
function responseFacts(raw: string): { api?: PiApi; id: Resolution<string> } {
  const found: { api: PiApi; id: unknown; path: string }[] = [];
  try {
    let events: unknown[];
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      const parsed = object(JSON.parse(trimmed));
      events = parsed.format === 'ws-messages-v1'
        ? socketMessages(raw).filter(message => message.direction === 'server').map(message => JSON.parse(message.payload)) : [parsed];
    } else {
      events = [];
      for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') events.push(JSON.parse(data));
      }
    }
    for (const [index, event] of events.entries()) {
      const item = object(event), response = object(item.response), message = object(item.message);
      if (['response.created', 'response.completed', 'response.incomplete', 'response.failed'].includes(String(item.type))) {
        found.push({ api: 'responses', id: response.id, path: `response.events[${index}].response.id` });
      } else if (item.object === 'response') found.push({ api: 'responses', id: item.id, path: 'response.id' });
      else if (item.object === 'chat.completion' || item.object === 'chat.completion.chunk') {
        if (!Array.isArray(item.choices)) return { id: unresolved('unsupported_format') };
        found.push({ api: 'chat-completions', id: item.id, path: `response.events[${index}].id` });
      }
      else if (item.type === 'message_start' && message.role === 'assistant') found.push({ api: 'anthropic', id: message.id, path: `response.events[${index}].message.id` });
      else if (item.type === 'message' && item.role === 'assistant') found.push({ api: 'anthropic', id: item.id, path: 'response.id' });
    }
  } catch { return { id: unresolved('unsupported_format') }; }
  const evidence = found.map(value => value.path);
  if (!found.length) return { id: unresolved('missing_response') };
  if (found.some(value => typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512)) return { id: unresolved('invalid_metadata', evidence) };
  const ids = [...new Set(found.map(value => value.id as string))].sort();
  if (new Set(found.map(value => value.api)).size !== 1 || ids.length !== 1) return {
    id: { status: 'conflict', reason: 'response_conflict', candidates: ids, evidence }
  };
  return { api: found[0].api, id: { status: 'resolved', value: ids[0], evidence } };
}
export function piFacts(input: CaptureInput): CaptureFacts {
  const protocol = captureProtocol(input);
  const fail = (reason: AttributionReason): CaptureFacts => ({ session: unresolved(reason), fields: {},
    pi: { format: 'pi-capture-v1', protocol, responseId: unresolved(reason) } });
  if (input.contentExpired) return fail('content_unavailable');
  if (input.attribution === 'connection') return fail('connection_only');
  if (!['2.0.0', '3.0.0'].includes(input.schemaVersion || '')) return fail('unsupported_format');
  if (piIdentity(input.headers) !== 'pi') return fail('agent_identity_unconfirmed');
  if (protocol.family === 'unknown') return fail('unknown_protocol');
  if (!input.responseEvidence?.complete) return fail('content_unavailable');
  const response = responseFacts(input.responseEvidence.body);
  if (protocol.family === 'websocket' && response.api !== 'responses') return fail('unsupported_format');
  return { session: unresolved('missing_session'), fields: {}, pi: {
    format: 'pi-capture-v1', protocol, responseId: response.id, api: response.api
  }, ...(response.id.status === 'resolved' && response.api ? { locator: { kind: 'pi', responseId: response.id.value, api: response.api } } : {}) };
}
export const piAdapter: AgentAdapter = {
  id: 'pi', version: PI_RULE_VERSION, identityIndex: { category: 'Pi', source: 'pi_native' }, evidenceMode: 'native', monitorEvidence: true,
  matches: input => getAgentCategory(input.agentName) === 'Pi',
  extract: piFacts,
  decodeEvidence: evidence => evidence.raw?.format === 'pi-jsonl-v3' ? decodePiArchive(evidence.raw) : evidence,
  reconcile: (_facts, current, previous) => reconcilePi(current, previous?.native),
  resolve: ({ facts, native }) => {
    let session = facts.session;
    const data = facts.pi;
    if (data?.format !== 'pi-capture-v1') session = unresolved('unsupported_format');
    else if (data?.responseId.status !== 'resolved') session = data?.responseId || unresolved('unsupported_format');
    else if (native.status === 'available' && native.kind === 'pi') {
      if (native.raw.locator.responseId !== data.responseId.value || native.raw.locator.api !== data.api) session = unresolved('source_invalid');
      else if (native.conflict) session = unresolved('source_changed');
      else {
        const candidates = [...new Set(native.candidates.map(candidate => JSON.stringify([native.sourceId, candidate.sessionId])))].sort();
        const evidence = [...data.responseId.evidence, 'native.header.id', 'native.message.api', 'native.message.responseId'];
        const paths = new Set(native.candidates.map(candidate => candidate.path));
        session = candidates.length === 1 && paths.size > 1 ? unresolved('source_changed', evidence)
          : candidates.length === 1 ? { status: 'resolved', value: candidates[0], evidence }
          : candidates.length > 1 ? { status: 'conflict', reason: 'session_conflict', candidates, evidence } : unresolved('source_missing');
      }
    } else session = unresolved(native.status === 'unavailable' ? native.reason : 'source_missing');
    let turn: Resolution<TurnIdentity> = unresolved('missing_turn');
    if (session.status === 'resolved' && native.status === 'available' && native.kind === 'pi') {
      const evidence = ['native.message.responseId', 'native.entry.parentId', 'native.message.role=user', 'native.input.id'];
      const turns = native.candidates.map(candidate => candidate.turn);
      const values = [...new Map(turns.flatMap(result => result.status === 'resolved' ? [[result.value.id, result.value] as const] : [])).values()]
        .sort((a, b) => a.id.localeCompare(b.id));
      turn = values.length > 1 ? { status: 'conflict', reason: 'turn_conflict', candidates: values, evidence }
        : turns.find(result => result.status !== 'resolved') || (values.length === 1
          ? { status: 'resolved', value: values[0], evidence } : unresolved('missing_turn'));
    }
    return { agentId: 'pi', ruleVersion: PI_RULE_VERSION, session, turn,
      protocol: data?.protocol, lifecycle: 'unknown', turnGrouping: 'observed_inputs', identitySource: 'pi_native' };
  }
};
