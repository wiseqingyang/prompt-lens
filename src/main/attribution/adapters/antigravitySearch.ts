import { createHash } from 'node:crypto';
import { object, type CaptureInput, type RelationItem } from '../contracts';
import type { ToolLink } from '../../../shared/attribution';

/** Derived fingerprints only; exact underlying request/response evidence stays in the content store. */
export interface SearchFacts {
  result?: { queryHash: string; resultHash: string };
  calls: { id: string; queryHash: string }[];
  receipts: { id: string; queryHash: string; resultHash: string }[];
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const note = '\n\nNote: Source URLs are HTTP redirects; check where they resolve if you need the direct link.';
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function call(value: unknown): { id: string; query: string } | undefined {
  const c = object(value), args = object(c.args);
  if (c.name === 'search_web' && typeof c.id === 'string' && c.id &&
      Object.keys(args).length === 1 && typeof args.query === 'string' && args.query) return { id: c.id, query: args.query };
}

/** Only the observed JSON and SSE envelopes; malformed/truncated streams provide no call evidence. */
function responses(raw: string): unknown[] {
  try { return [JSON.parse(raw)]; } catch { /* SSE is parsed below. */ }
  try {
    const lines = raw.split(/\r?\n/).filter(line => line.trim());
    if (!lines.length || lines.some(line => !line.startsWith('data:'))) return [];
    return lines.map(line => JSON.parse(line.slice(5)));
  } catch { return []; }
}

function groundedResult(value: unknown): string | undefined {
  const envelope = object(value), response = object(envelope.response), candidates = array(response.candidates);
  if (envelope.error || candidates.length !== 1) return;
  const candidate = object(candidates[0]), content = object(candidate.content), parts = array(content.parts);
  if (candidate.finishReason !== 'STOP' || content.role !== 'model' || !parts.length ||
      parts.some(p => typeof object(p).text !== 'string' || object(p).thought === true || object(p).functionCall)) return;
  const text = parts.map(p => object(p).text as string).join('');
  if (!text) return;
  const grounding = object(candidate.groundingMetadata), chunks = array(grounding.groundingChunks), supports = array(grounding.groundingSupports);
  if (!chunks.length || !supports.length) return;
  const sources: string[] = [], uris = new Set<string>();
  for (const [index, chunk] of chunks.entries()) {
    const web = object(object(chunk).web);
    if (typeof web.uri !== 'string' || !/^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[^\s()]+$/.test(web.uri) ||
        typeof web.title !== 'string' || !web.title || /[\r\n\[\]]/.test(web.title) || uris.has(web.uri)) return;
    uris.add(web.uri); sources.push(`[${index + 1}] [${web.title}](${web.uri})`);
  }
  const original = Buffer.from(text), insertions = new Map<number, string>();
  for (const item of supports) {
    const support = object(item), segment = object(support.segment), end = segment.endIndex, start = segment.startIndex ?? 0;
    const indices = array(support.groundingChunkIndices);
    if (!integer(start) || !integer(end) || start >= end || end > original.length ||
        typeof segment.text !== 'string' || original.subarray(start, end).toString('utf8') !== segment.text ||
        !indices.length || indices.some(i => !integer(i) || i >= chunks.length) || new Set(indices).size !== indices.length || insertions.has(end)) return;
    insertions.set(end, indices.map(i => `[${Number(i) + 1}]`).join(''));
  }
  let rendered = original;
  for (const [end, citation] of [...insertions].sort(([a], [b]) => b - a)) {
    rendered = Buffer.concat([rendered.subarray(0, end), Buffer.from(citation), rendered.subarray(end)]);
  }
  return rendered.toString('utf8') + '\n\nSources:\n' + sources.join('\n') + note;
}

export function searchFacts(input: CaptureInput, isSearch: boolean): SearchFacts | undefined {
  if (input.contentExpired) return;
  const request = object(object(input.body).request), contents = array(request.contents);
  const frames = input.responseEvidence?.complete ? responses(input.responseEvidence.body) : [];
  const result: SearchFacts = { calls: [], receipts: [] };
  if (isSearch) {
    const message = object(contents[0]), parts = array(message.parts), part = object(parts[0]);
    if (contents.length !== 1 || message.role !== 'user' || parts.length !== 1 ||
        Object.keys(part).length !== 1 || typeof part.text !== 'string' || !part.text || frames.length !== 1) return;
    const rendered = groundedResult(frames[0]);
    if (rendered) result.result = { queryHash: hash(part.text), resultHash: hash(rendered) };
    return result;
  }
  for (const frame of frames) for (const candidate of array(object(object(frame).response).candidates)) {
    for (const part of array(object(object(candidate).content).parts)) {
      const c = call(object(part).functionCall);
      if (c) result.calls.push({ id: c.id, queryHash: hash(c.query) });
    }
  }
  const parts = contents.flatMap(message => array(object(message).parts));
  const calls = parts.flatMap(part => { const c = call(object(part).functionCall); return c ? [c] : []; });
  for (const part of parts) {
    const fr = object(object(part).functionResponse), output = object(fr.response).output;
    if (fr.name !== 'search_web' || typeof fr.id !== 'string' || typeof output !== 'string') continue;
    const paired = calls.filter(c => c.id === fr.id);
    if (!paired.length || new Set(paired.map(c => c.query)).size !== 1) continue;
    const query = paired[0].query;
    // Keep query and result exact; strip only the observed timestamp envelope (not a proximity heuristic).
    const lines = output.split('\n');
    const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
    if (!lines[0]?.startsWith('Created At: ') || !lines[1]?.startsWith('Completed At: ') ||
        !timestamp.test(lines[0].slice(12)) || !timestamp.test(lines[1].slice(14))) continue;
    const prefix = `The search for "${query}" returned the following summary:\n`, remainder = lines.slice(2).join('\n');
    if (!remainder.startsWith(prefix)) continue;
    result.receipts.push({ id: fr.id, queryHash: hash(query), resultHash: hash(remainder.slice(prefix.length)) });
  }
  return result.calls.length || result.receipts.length ? result : undefined;
}

/** Full-snapshot relation pass. Native identities are never replaced by inferred IDs. */
export function linkSearches(items: RelationItem[]): Map<number, ToolLink> {
  const links = new Map<number, ToolLink>();
  const searches = new Map<string, RelationItem[]>(), receipts = new Map<string, { item: RelationItem; id: string }[]>();
  const origins = new Map<string, RelationItem[]>();
  const key = (q: string, r: string) => JSON.stringify([q, r]);
  for (const item of items) {
    const facts = item.facts.antigravitySearch;
    if (!facts || item.contentExpired) continue;
    if (facts.result) {
      const k = key(facts.result.queryHash, facts.result.resultHash);
      const group = searches.get(k) || []; group.push(item); searches.set(k, group);
    }
    for (const receipt of facts.receipts) {
      const k = key(receipt.queryHash, receipt.resultHash);
      const group = receipts.get(k) || []; group.push({item, id: receipt.id}); receipts.set(k, group);
    }
    for (const call of facts.calls) {
      const k = key(call.queryHash, call.id);
      const group = origins.get(k) || [];
      if (!group.includes(item)) group.push(item);
      origins.set(k, group);
    }
  }
  for (const [k, sources] of searches) {
    const consumers = receipts.get(k) || [];
    if (!consumers.length) continue;
    const candidates = new Set<string>();
    let uncertain = false;
    for (const {item, id} of consumers) {
      if (item.decision.session.status !== 'resolved') { uncertain = true; continue; }
      candidates.add(JSON.stringify([item.decision.session.value, id]));
    }
    const conflict = () => { for (const source of sources) links.set(source.recordId, { status: 'conflict', reason: 'tool_link_conflict', candidates: [], evidence: [...new Set(consumers.map(c => c.item.recordId))].sort((a,b) => a-b).map(id => `record:${id}`) }); };
    if (sources.length !== 1 || candidates.size > 1 || uncertain) { conflict(); continue; }
    if (candidates.size !== 1) continue;
    const [sessionId, callId] = JSON.parse([...candidates][0]) as [string, string], source = sources[0];
    const matching = origins.get(key(source.facts.antigravitySearch!.result!.queryHash, callId)) || [];
    // All possible origins must agree, including unresolved ones. Duplicate captures remain ambiguous.
    if (matching.length !== 1) { if (matching.length) conflict(); continue; }
    const origin = matching[0], decision = origin.decision;
    if (decision.session.status !== 'resolved' || decision.turn.status !== 'resolved') continue;
    if (source.facts.positionConflict || decision.session.value !== sessionId || source.decision.turn.status === 'conflict' ||
        source.decision.turn.status === 'resolved' && source.decision.turn.value.id !== decision.turn.value.id ||
        source.decision.session.status === 'conflict' ||
        source.decision.session.status === 'resolved' && source.decision.session.value !== sessionId) { conflict(); continue; }
    // A reused call ID with contradictory arguments in the originating response cannot establish an edge.
    if (origin.facts.antigravitySearch!.calls.some(c => c.id === callId && c.queryHash !== source.facts.antigravitySearch!.result!.queryHash)) { conflict(); continue; }
    links.set(source.recordId, { status: 'resolved', value: { ruleVersion: '1', sessionId, turn: decision.turn.value,
      parentRecordId: origin.recordId, callId, resultHash: source.facts.antigravitySearch!.result!.resultHash,
      consumerRecordIds: [...new Set(consumers.map(c => c.item.recordId))].sort((a,b) => a-b) },
      evidence: ['search.query', 'search.grounded_result', 'search.sources', 'functionCall.id', 'functionResponse.id', `record:${origin.recordId}`] });
  }
  return links;
}
