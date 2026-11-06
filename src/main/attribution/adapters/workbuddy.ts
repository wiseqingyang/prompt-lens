import { getAgentCategory } from '../../../shared/agent';
import { captureProtocol, headerValues } from '../../../shared/captureProtocol';
import { workbuddyIdentity } from '../../../shared/workbuddyIdentity';
import { workbuddyUserInput } from '../../../shared/workbuddyPrompt';
import type { AttributionDecision, AttributionReason, Resolution } from '../../../shared/attribution';
import { unresolved, type AgentAdapter, type CaptureFacts, type CaptureInput } from '../contracts';

// Evidence and field scope: docs/requirements/workbuddy-adaptation.md.
export const WORKBUDDY_RULE_VERSION = '1';
function field(input: CaptureInput, name: string, missing: AttributionReason, conflict: AttributionReason): Resolution<string> {
  const values = headerValues(input.headers, name), evidence = values.length ? [`headers.${name}`] : [];
  if (!values.length) return unresolved(missing);
  if (values.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value))) return unresolved('invalid_metadata', evidence);
  const candidates = [...new Set(values as string[])].sort();
  return candidates.length > 1 ? { status: 'conflict', reason: conflict, candidates, evidence }
    : { status: 'resolved', value: candidates[0], evidence };
}
export function workbuddyFacts(input: CaptureInput): CaptureFacts {
  const protocol = captureProtocol(input);
  const fail = (reason: AttributionReason): CaptureFacts => ({ session: unresolved(reason), fields: {},
    workbuddy: { format: 'workbuddy-capture-v1', turn: unresolved(reason), protocol, continueTurn: false } });
  if (input.contentExpired) return fail('content_unavailable');
  if (workbuddyIdentity(input.headers) !== 'workbuddy') return fail('agent_identity_unconfirmed');
  if (input.attribution === 'connection') return fail('connection_only');
  if (!['2.0.0', '3.0.0'].includes(input.schemaVersion || '')) return fail('unsupported_format');
  // No verified per-frame metadata contract: HTTP handshake IDs must never identify WS frames.
  if (protocol.family !== 'http') return fail('unknown_protocol');
  if (input.method !== 'POST') return fail('unsupported_format');
  const session = field(input, 'x-conversation-id', 'missing_session', 'session_conflict');
  const turn = field(input, 'x-conversation-request-id', 'missing_turn', 'turn_conflict');
  const type = field(input, 'x-agent-type', 'invalid_metadata', 'invalid_metadata');
  const purpose = field(input, 'x-agent-purpose', 'invalid_metadata', 'invalid_metadata');
  const fields: CaptureFacts['fields'] = {};
  for (const name of ['x-conversation-id', 'x-conversation-request-id', 'x-agent-type', 'x-agent-purpose']) {
    const value = field(input, name, 'invalid_metadata', 'invalid_metadata');
    if (value.status === 'resolved') fields[`headers.${name}`] = value.value;
  }
  const facts: CaptureFacts = { session, fields, workbuddy: { format: 'workbuddy-capture-v1', turn, protocol,
    continueTurn: type.status === 'resolved' && ['auxiliary', 'compaction'].includes(type.value) } };
  if (type.status === 'resolved' && purpose.status === 'resolved') {
    const kind = type.value === 'auxiliary' && purpose.value === 'conversation_topic' ? 'conversation_title'
      : type.value === 'auxiliary' && purpose.value === 'webfetch' ? 'web_content_analysis'
        : type.value === 'compaction' && purpose.value === 'context_summary_max_token' ? 'context_compaction' : undefined;
    if (kind) facts.purpose = { kind, ruleId: 'workbuddy-purpose-v1', evidence: [...type.evidence, ...purpose.evidence] };
  }
  if (session.status === 'resolved' && turn.status === 'resolved' && type.status === 'resolved' && type.value === 'main' &&
      purpose.status === 'resolved' && purpose.value === 'conversation') {
    const inputText = workbuddyUserInput(input.headers, input.body);
    if (inputText) facts.workbuddy!.title = { evidence: inputText.evidence, text: Array.from(inputText.text.replace(/\s+/g, ' ')).slice(0, 256).join('') };
  }
  return facts;
}
export const workbuddyAdapter: AgentAdapter = {
  id: 'workbuddy', version: WORKBUDDY_RULE_VERSION, evidenceMode: 'capture',
  identityIndex: { category: 'WorkBuddy', source: 'workbuddy_metadata' },
  matches: input => getAgentCategory(input.agentName) === 'WorkBuddy',
  extract: workbuddyFacts,
  resolve: ({ facts }): AttributionDecision => {
    const data = facts.workbuddy;
    const result: AttributionDecision = { agentId: 'workbuddy', ruleVersion: WORKBUDDY_RULE_VERSION,
      identitySource: 'workbuddy_metadata', session: facts.session, turn: unresolved('unsupported_format'),
      lifecycle: 'unknown', turnGrouping: 'observed_inputs' };
    if (!data || data.format !== 'workbuddy-capture-v1') { result.session = unresolved('unsupported_format'); return result; }
    result.protocol = data.protocol;
    if (facts.purpose) result.purpose = facts.purpose;
    if (data.continueTurn) result.turnBehavior = 'continue';
    if (facts.session.status !== 'resolved') { result.turn = unresolved(facts.session.reason); return result; }
    result.turn = data.turn.status === 'resolved'
      ? { status: 'resolved', value: { id: data.turn.value, ...(data.title ? { title: data.title.text } : {}) }, evidence: [...data.turn.evidence, ...(data.title?.evidence || [])] }
      : data.turn.status === 'conflict' ? { ...data.turn, candidates: data.turn.candidates.map(id => ({ id })) } : data.turn;
    return result;
  }
};
