import { getAgentCategory } from '../../../shared/agent';
import type { AttributionDecision, AttributionReason, Resolution } from '../../../shared/attribution';
import { captureProtocol, headerValues, isObject } from '../../../shared/captureProtocol';
import { unresolved, type AgentAdapter, type CaptureFacts, type CaptureInput } from '../contracts';
import { codexConnectionIssue } from './codexConnectionIssue';

// Field contracts and source evidence: docs/requirements/codex-attribution.md.
export const CODEX_RULE_VERSION = '5';
type Candidate = { path: string; value: unknown };
function agree(candidates: Candidate[], missing: AttributionReason, conflict: AttributionReason): Resolution<string> {
  const present = candidates.filter(candidate => candidate.value !== undefined);
  const evidence = present.map(candidate => candidate.path);
  if (present.some(candidate => typeof candidate.value !== 'string')) return unresolved('invalid_metadata', evidence);
  const values = [...new Set(present.map(candidate => candidate.value as string))].sort();
  if (values.length > 1) return { status: 'conflict', reason: conflict, candidates: values, evidence };
  return values[0] ? { status: 'resolved', value: values[0], evidence } : unresolved(missing, evidence);
}
function jsonMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return;
  try { const parsed: unknown = JSON.parse(value); return isObject(parsed) ? parsed : undefined; } catch { return; }
}

/** Source annotations distinguish user input from user-role context and other turns' history. */
function userInputTitle(input: unknown, turnId: string): NonNullable<CaptureFacts['codex']>['title'] {
  if (!Array.isArray(input)) return;
  for (const [index, message] of input.entries()) {
    if (!isObject(message) || message.type !== 'message' || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const metadata = message.internal_chat_message_metadata_passthrough;
    if (!isObject(metadata) || metadata.turn_id !== turnId || !Array.isArray(metadata.content_item_kinds) ||
        metadata.content_item_kinds.length !== message.content.length) continue;
    const texts: string[] = [], evidence: string[] = [];
    const prefix = `body.input[${index}]`;
    for (const [position, content] of message.content.entries()) {
      if (metadata.content_item_kinds[position] !== 'user.text' || !isObject(content) ||
          content.type !== 'input_text' || typeof content.text !== 'string' || !content.text.trim()) continue;
      texts.push(content.text);
      evidence.push(`${prefix}.internal_chat_message_metadata_passthrough.content_item_kinds[${position}]`, `${prefix}.content[${position}].text`);
    }
    if (texts.length) return {
      text: Array.from(texts.join('\n').replace(/\s+/g, ' ').trim()).slice(0, 256).join(''),
      evidence: [`${prefix}.type`, `${prefix}.role`, `${prefix}.internal_chat_message_metadata_passthrough.turn_id`, ...evidence]
    };
  }
}

export function codexFacts(input: CaptureInput): CaptureFacts {
  const protocol = captureProtocol(input);
  const fail = (reason: AttributionReason): CaptureFacts => ({ session: unresolved(reason), fields: {}, codex: {
    format: 'codex-capture-v2', turn: unresolved(reason), requestKind: unresolved(reason), protocol
  } });
  if (input.contentExpired) return fail('content_unavailable');
  if (input.attribution === 'connection') {
    const facts = fail('connection_only');
    const issue = codexConnectionIssue(input);
    if (issue) facts.connectionIssue = issue;
    return facts;
  }
  const userAgents = headerValues(input.headers, 'user-agent');
  const version = userAgents.length === 1 && typeof userAgents[0] === 'string'
    ? /^Codex Desktop\/([^\s]+)(?:\s|$)/.exec(userAgents[0])?.[1] : undefined;
  if (!['2.0.0', '3.0.0'].includes(input.schemaVersion || '')) return fail('unsupported_format');
  if (protocol.family === 'unknown') return fail('unknown_protocol');
  const body = isObject(input.body) ? input.body : undefined;
  // Known WS capture format retains the request event, independently of its response format.
  if (protocol.family === 'websocket' && body?.type !== 'response.create') return fail('unsupported_format');
  const metadata = body?.client_metadata;
  if (metadata !== undefined && !isObject(metadata)) return fail('invalid_metadata');
  const flat = isObject(metadata) ? metadata : {};
  const scopes: { path: string; value: Record<string, unknown> }[] = [{ path: 'body.client_metadata', value: flat }];
  const canonical = flat['x-codex-turn-metadata'];
  if (canonical !== undefined) {
    const parsed = jsonMetadata(canonical);
    if (!parsed) return fail('invalid_metadata');
    scopes.push({ path: 'body.client_metadata.x-codex-turn-metadata', value: parsed });
  }
  if (protocol.family === 'http') {
    for (const value of headerValues(input.headers, 'x-codex-turn-metadata')) {
      const parsed = jsonMetadata(value);
      if (!parsed) return fail('invalid_metadata');
      scopes.push({ path: 'headers.x-codex-turn-metadata', value: parsed });
    }
    for (const value of headerValues(input.headers, 'thread-id')) scopes.push({ path: 'headers', value: { thread_id: value } });
  }
  const candidates = (key: string): Candidate[] => scopes.map(scope => ({ path: `${scope.path}.${key}`, value: scope.value[key] }));
  const session = agree(candidates('thread_id'), 'missing_session', 'session_conflict');
  let turn = agree(candidates('turn_id'), 'missing_turn', 'turn_conflict');
  const requestKind = agree(scopes.filter(scope => scope.path !== 'body.client_metadata').map(scope => ({
    path: `${scope.path}.request_kind`, value: scope.value.request_kind
  })), 'invalid_metadata', 'invalid_metadata');
  if (turn.status === 'unresolved' && turn.reason === 'missing_turn' &&
      requestKind.status === 'resolved' && requestKind.value === 'prewarm' && body?.generate === false) {
    turn = unresolved('prewarm', [...turn.evidence, ...requestKind.evidence, 'body.generate']);
  }
  // The registry selects the Agent; client versions are diagnostic, not identity evidence.
  const fields: CaptureFacts['fields'] = { schemaVersion: input.schemaVersion!, ...(version ? { sourceVersion: version } : {}) };
  // Retain whitelisted identity facts; only the separately evidenced, bounded display title contains user text.
  for (const scope of scopes) for (const key of ['thread_id', 'turn_id', 'request_kind']) {
    const value = scope.value[key];
    if (typeof value === 'string') fields[`${scope.path}.${key}`] = value;
  }
  const title = session.status === 'resolved' && turn.status === 'resolved' ? userInputTitle(body?.input, turn.value) : undefined;
  let purpose: CaptureFacts['purpose'];
  if (turn.status === 'unresolved' && turn.reason === 'prewarm') {
    purpose = { kind: 'prewarm', ruleId: 'codex-prewarm-v1', evidence: turn.evidence };
  } else if (requestKind.status === 'resolved' && requestKind.value === 'memory') {
    purpose = { kind: 'memory', ruleId: 'codex-memory-v1', evidence: requestKind.evidence };
  } else if (requestKind.status === 'resolved' && requestKind.value === 'compaction') {
    purpose = { kind: 'context_compaction', ruleId: 'codex-compaction-v1', evidence: requestKind.evidence };
  }
  return { session, fields, ...(purpose ? { purpose } : {}), codex: { format: 'codex-capture-v2', turn, requestKind, protocol, ...(title ? { title } : {}) } };
}
export const codexAdapter: AgentAdapter = {
  id: 'codex', version: CODEX_RULE_VERSION, identityIndex: { category: 'Codex', source: 'codex_metadata' }, evidenceMode: 'capture',
  matches: input => getAgentCategory(input.agentName) === 'Codex',
  extract: codexFacts,
  resolve: ({ facts }): AttributionDecision => {
    const data = facts.codex;
    const result: AttributionDecision = { agentId: 'codex', ruleVersion: CODEX_RULE_VERSION, identitySource: 'codex_metadata',
      session: facts.session, turn: unresolved('unsupported_format'), lifecycle: 'unknown', turnGrouping: 'observed_inputs' };
    if (!data || data.format !== 'codex-capture-v2') { result.session = unresolved('unsupported_format'); return result; }
    result.protocol = data.protocol;
    if (facts.connectionIssue) result.connectionIssue = facts.connectionIssue;
    if (facts.purpose) result.purpose = facts.purpose;
    if (facts.purpose?.kind === 'prewarm' || facts.purpose?.kind === 'memory') result.turnBehavior = 'continue';
    if (facts.session.status !== 'resolved') { result.turn = unresolved(facts.session.reason); return result; }
    result.turn = data.turn.status === 'resolved'
      ? { status: 'resolved', value: { id: data.turn.value, ...(data.title ? { title: data.title.text } : {}) }, evidence: data.turn.evidence }
      : data.turn.status === 'conflict'
        ? { ...data.turn, candidates: data.turn.candidates.map(id => ({ id })) } : data.turn;
    if (data.requestKind.status === 'resolved') result.turnKind = data.requestKind.value === 'memory' ? 'background' : 'execution';
    return result;
  }
};
