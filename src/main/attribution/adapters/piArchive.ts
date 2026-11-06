import type { Resolution, TurnIdentity } from '../../../shared/attribution';
import { object, unresolved, type PiApi, type PiArchive, type PiNativeEvidence, type NativeEvidence } from '../contracts';

export function piApi(value: unknown): PiApi | undefined {
  if (value === 'openai-responses' || value === 'openai-codex-responses') return 'responses';
  if (value === 'anthropic-messages') return 'anthropic';
  if (value === 'openai-completions') return 'chat-completions';
}
/** Validate one independently observed parent chain, never file order or wire user messages. */
function inputTurn(raw: PiArchive, path: string, entryId: string, sessionId: string,
  records: Map<string, Record<string, unknown>>): Resolution<TurnIdentity> {
  const observations = (raw.ancestry || []).filter(item => item.path === path && item.entryIds[0] === entryId);
  let result: Resolution<TurnIdentity> = unresolved('missing_turn');
  for (const observation of observations) {
    let next: unknown = entryId;
    const seen = new Set<string>();
    let input: Record<string, unknown> | undefined;
    let invalid = false;
    for (const id of observation.entryIds) {
      const entry = records.get(JSON.stringify([path, id]));
      if (!entry || id !== next || seen.has(id) || input) { invalid = true; break; }
      seen.add(id);
      if (entry.type === 'message' && object(entry.message).role === 'user') input = entry;
      next = entry.parentId;
    }
    if (invalid) return unresolved('source_invalid');
    if (input && !observation.limited) {
      const content = object(input.message).content;
      const title = (typeof content === 'string' ? content : Array.isArray(content)
        ? content.map(item => { const block = object(item); return block.type === 'text' && typeof block.text === 'string' ? block.text : ''; }).join('\n') : '').trim().slice(0, 500);
      return { status: 'resolved', value: { id: JSON.stringify([raw.sourceId, sessionId, input.id]), ...(title ? { title } : {}) },
        evidence: ['native.entry.parentId', 'native.message.role=user', 'native.input.id'] };
    }
    result = unresolved(observation.limited ? 'source_limit' : seen.has(String(next)) || (next !== null && typeof next !== 'string')
      ? 'source_invalid' : next === null ? 'missing_turn' : 'source_incomplete');
  }
  return result;
}
export function decodePiArchive(raw: PiArchive): NativeEvidence {
  try {
    const candidates: PiNativeEvidence['candidates'] = [];
    const records = new Map<string, Record<string, unknown>>();
    const headers = new Map<string, string>();
    const decoded = raw.records.map(record => ({ record, entry: object(JSON.parse(record.entry)) }));
    decoded.sort((a, b) => a.record.path.localeCompare(b.record.path) || String(a.entry.id).localeCompare(String(b.entry.id)));
    raw = { ...raw, records: decoded.map(item => item.record), ...(raw.ancestry ? { ancestry: [...raw.ancestry]
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}) };
    for (const { record, entry } of decoded) {
      const key = JSON.stringify([record.path, entry.id]);
      if (headers.has(record.path) && headers.get(record.path) !== record.header) throw new Error('Conflicting Pi headers');
      headers.set(record.path, record.header);
      if (records.has(key)) throw new Error('Duplicate Pi record');
      records.set(key, entry);
    }
    for (const { record, entry } of decoded) {
      const header = object(JSON.parse(record.header));
      if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || (!header.id.trim() || header.id.length > 512) ||
          typeof entry.type !== 'string' || typeof entry.id !== 'string' || !entry.id) throw new Error('Invalid Pi record');
      const message = object(entry.message);
      if (entry.type === 'message' && message.role === 'assistant' && message.responseId === raw.locator.responseId && piApi(message.api) === raw.locator.api) {
        candidates.push({ sessionId: header.id, entryId: entry.id, path: record.path, turn: inputTurn(raw, record.path, entry.id, header.id, records) });
      }
    }
    return { kind: 'pi', status: 'available', sourceId: raw.sourceId, raw, candidates };
  } catch { return { status: 'unavailable', reason: 'source_invalid', raw }; }
}

/** Union immutable observations; absence never erases facts, rewriting an entry is a conflict. */
export function reconcilePi(current: NativeEvidence, previous?: NativeEvidence): NativeEvidence {
  if (previous?.status !== 'available' || previous.kind !== 'pi') return current;
  if (current.status !== 'available' || current.kind !== 'pi') return previous;
  if (previous.conflict) return previous;
  if (current.sourceId !== previous.sourceId) return { ...current, conflict: { reason: 'source_changed' as const } };
  const records = new Map(previous.raw.records.map(record => [JSON.stringify([record.path, object(JSON.parse(record.entry)).id]), record]));
  for (const record of current.raw.records) {
    const key = JSON.stringify([record.path, object(JSON.parse(record.entry)).id]);
    const old = records.get(key);
    if (old && (old.header !== record.header || old.entry !== record.entry)) return { ...current, conflict: { reason: 'source_changed' as const } };
    records.set(key, record);
  }
  const ancestry = [...new Map([...(previous.raw.ancestry || []), ...(current.raw.ancestry || [])].map(item => [JSON.stringify(item), item])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return decodePiArchive({ ...current.raw, ancestry, records: [...records.values()] });
}
