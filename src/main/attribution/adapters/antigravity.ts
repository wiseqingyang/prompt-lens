import type { AgentAdapter, CaptureFacts, DecisionSnapshot, NativeEvidence } from '../contracts';
import { object, unresolved } from '../contracts';
import { decodeAntigravityArchive } from './antigravityArchive';
import { antigravityPurpose } from './antigravityPurpose';
import { searchFacts, linkSearches } from './antigravitySearch';
import type { AttributionDecision, Resolution } from '../../../shared/attribution';

const RULE_VERSION = '7';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const nativeUuid = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;

export function antigravityFacts(body: unknown): CaptureFacts {
  const envelope = object(body), request = object(envelope.request), labels = object(request.labels);
  const parts = typeof envelope.requestId === 'string' ? envelope.requestId.split('/') : [];
  const structured = parts.length === 5 && parts[0] === 'agent' && nativeUuid(parts[1]) &&
    /^\d+$/.test(parts[2]) && nativeUuid(parts[3]) && /^\d+$/.test(parts[4]) && Number.isSafeInteger(Number(parts[4]));
  const fromRequest = structured ? nativeUuid(parts[1]) : undefined;
  const fromLabel = nativeUuid(labels.cascade_id);
  const evidence = [fromLabel && 'request.labels.cascade_id', fromRequest && 'requestId'].filter(Boolean) as string[];
  let session: Resolution<string> = unresolved('missing_session');
  if (fromLabel && fromRequest && fromLabel !== fromRequest) {
    session = { status: 'conflict', reason: 'session_conflict', candidates: [fromLabel, fromRequest], evidence };
  } else if (fromLabel || fromRequest) session = { status: 'resolved', value: (fromLabel || fromRequest)!, evidence };
  const fields: CaptureFacts['fields'] = {};
  for (const [name, value] of Object.entries({ requestId: envelope.requestId, cascade_id: labels.cascade_id,
    trajectory_id: labels.trajectory_id, last_step_index: labels.last_step_index, parent_cascade_id: labels.parent_cascade_id })) {
    if (typeof value === 'string' || typeof value === 'number') fields[name] = typeof value === 'string' ? value.slice(0, 512) : value;
  }
  const facts: CaptureFacts = { session, fields, parentSessionId: nativeUuid(labels.parent_cascade_id) };
  const purpose = antigravityPurpose(body);
  if (purpose) facts.purpose = purpose;
  const labelIndex = typeof labels.last_step_index === 'string' && /^\d+$/.test(labels.last_step_index)
    ? Number(labels.last_step_index) : undefined;
  if (session.status === 'resolved' && structured) {
    if (labels.trajectory_id !== undefined && nativeUuid(labels.trajectory_id) !== nativeUuid(parts[3]) ||
        labels.last_step_index !== undefined && labelIndex !== Number(parts[4]) - 1) facts.positionConflict = true;
    else if (Number(parts[4]) > 0) facts.locator = {
      conversationId: session.value, trajectoryId: nativeUuid(parts[3])!, throughStep: Number(parts[4]) - 1
    };
  }
  return facts;
}

function resolve(snapshot: DecisionSnapshot): AttributionDecision {
  const { facts, native } = snapshot;
  const result: AttributionDecision = { agentId: 'antigravity', ruleVersion: RULE_VERSION, turnGrouping: 'observed_inputs', session: facts.session,
    turn: unresolved('missing_position'), ...(facts.parentSessionId ? { parentSessionId: facts.parentSessionId } : {}) };
  if (facts.purpose) result.purpose = facts.purpose;
  if (facts.session.status !== 'resolved') { result.turn = unresolved(facts.session.reason); return result; }
  if (facts.positionConflict) { result.turn = unresolved('position_conflict'); return result; }
  if (!facts.locator || facts.locator.kind === 'pi') return result;
  const locator = facts.locator;
  if (native.status !== 'available') { result.turn = unresolved(native.status === 'unavailable' ? native.reason : 'source_missing'); return result; }
  if (native.kind === 'pi') return result;
  if (native.conflict) { result.turn = unresolved('source_changed'); return result; }
  if (native.trajectoryId !== facts.locator.trajectoryId) { result.turn = unresolved('trajectory_mismatch'); return result; }
  const steps = native.steps.filter(step => step.index <= locator.throughStep);
  // Turns follow observed explicit inputs. Gaps neither end the active turn nor create a new one.
  // Later evidence can add a boundary and deterministically regroup the affected requests.
  const captureTime = Date.parse(snapshot.capturedAt.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(snapshot.capturedAt) ? '' : 'Z'));
  if (!Number.isFinite(captureTime) || steps.some(step => !Number.isFinite(Date.parse(step.createdAt)) || Date.parse(step.createdAt) > captureTime)) {
    result.turn = unresolved('source_changed'); return result;
  }
  const input = [...steps].reverse().find(step => step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT');
  if (!input) { result.turn = unresolved('no_user_input'); return result; }
  result.turn = { status: 'resolved', value: {
    id: JSON.stringify([facts.session.value, facts.locator.trajectoryId, input.index]),
    inputIndex: input.index, trajectoryId: facts.locator.trajectoryId, title: input.input
  }, evidence: ['requestId', `native.steps[${input.index}].source`, `native.steps[${input.index}].type`] };
  return result;
}

/** Preserve both observations when a previously established input prefix changes. */
function reconcile(facts: CaptureFacts, current: NativeEvidence,
  previous?: DecisionSnapshot & { decision: AttributionDecision }): NativeEvidence {
  const observed = previous?.native.status === 'available' ? previous.native : previous?.native.previous;
  if (!observed || observed.kind === 'pi') return current;
  // Unavailability is not evidence that a previously observed event ceased to exist.
  if (current.status !== 'available' || current.kind === 'pi') return observed;
  if (observed.trajectoryId !== current.trajectoryId) return current;
  if (observed.conflict) return observed;
  const boundary = facts.locator?.kind !== 'pi' ? facts.locator?.throughStep ?? -1 : -1;
  const before = observed.steps.filter(step => step.index <= boundary);
  const now = current.steps.filter(step => step.index <= boundary);
  const byIndex = new Map(before.map(step => [step.index, step]));
  if (now.some(step => byIndex.has(step.index) && JSON.stringify(byIndex.get(step.index)) !== JSON.stringify(step))) {
    return { ...current, conflict: { previousSteps: before } };
  }
  // A shortened source cannot erase stored facts. Never join disjoint partial logs.
  return now.length >= before.length ? current : observed;
}

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity', version: RULE_VERSION,
  matches: input => /^antigravity(?:$|[\s(/-])/i.test(input.agentName),
  extract: input => {
    const facts = antigravityFacts(input.body);
    if (!input.body) facts.session = unresolved('content_unavailable');
    facts.antigravitySearch = searchFacts(input, facts.purpose?.kind === 'web_search');
    return facts;
  }, relate: linkSearches, reconcile, resolve,
  decodeEvidence: evidence => {
    if (!evidence.raw || evidence.raw.format !== 'antigravity-jsonl-v1') return evidence; // Migrated snapshots retain their original fidelity.
    return decodeAntigravityArchive(evidence.raw, evidence.raw.sourceId);
  }
};
