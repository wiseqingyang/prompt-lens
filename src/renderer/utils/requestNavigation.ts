import type { Session, SessionCluster, TaskTurn } from '../types';
import { auxiliaryPurposeLabels, connectionIssueLabels } from '../../shared/attribution';
import { getAgentCategory } from '../../shared/agent';

function totals(turns: TaskTurn[]) {
  const sum = (field: 'duration_ms' | 'input_tokens' | 'cached_tokens' | 'thinking_tokens' | 'output_tokens') =>
    turns.reduce((n, turn) => n + (turn[field] || 0), 0);
  const input = sum('input_tokens'), cached = sum('cached_tokens');
  return { turns_count: turns.length, total_duration_ms: sum('duration_ms'), total_input_tokens: input,
    total_cached_tokens: cached, total_thinking_tokens: sum('thinking_tokens'), total_output_tokens: sum('output_tokens'),
    cache_ratio: input ? Number((cached * 100 / input).toFixed(1)) : 0 };
}

function timeRange(turns: TaskTurn[], source: SessionCluster) {
  const times = turns.map(request => request.created_at || '').filter(Boolean).sort();
  return { created_at: times[0] || source.created_at, updated_at: times[times.length - 1] || source.updated_at };
}

type CollectionKind = 'auxiliary' | 'connection';
const collectionDefinitions: Record<CollectionKind, { title: string; labels: Readonly<Record<string, string>> }> = {
  auxiliary: { title: '辅助请求', labels: auxiliaryPurposeLabels },
  connection: { title: '连接异常', labels: connectionIssueLabels }
};

function classification(request: TaskTurn): { kind: CollectionKind; category: string } | undefined {
  if (request.assignment?.toolLink?.status === 'resolved') return;
  const purpose = request.assignment?.purpose?.kind, issue = request.assignment?.connectionIssue?.kind;
  if (purpose && issue) return; // Conflicting classifications cannot silently hide a record.
  if (purpose && Object.hasOwn(auxiliaryPurposeLabels, purpose)) return { kind: 'auxiliary', category: purpose };
  if (issue && Object.hasOwn(connectionIssueLabels, issue)) return { kind: 'connection', category: issue };
}

/** Collections reference canonical requests; they are never persisted or used as accounting totals. */
export function requestNavigationGroups(sessions: SessionCluster[]): SessionCluster[] {
  const result: SessionCluster[] = [];
  const collections = new Map<string, { agent: string; kind: CollectionKind; source: SessionCluster;
    categories: Map<string, TaskTurn[]>; seen: Set<number> }>();
  for (const group of sessions) {
    for (const task of group.tasks) for (const request of task.turns) {
      const classified = classification(request);
      if (!classified) continue;
      const agent = getAgentCategory(group.agent_name), { kind, category } = classified;
      const id = JSON.stringify(['request-collection', agent, kind]);
      let collection = collections.get(id);
      if (!collection) {
        collection = { agent, kind, source: group, categories: new Map(), seen: new Set() };
        collections.set(id, collection);
      }
      if (collection.seen.has(request.record_id)) continue;
      collection.seen.add(request.record_id);
      const requests = collection.categories.get(category) || [];
      requests.push(request);
      collection.categories.set(category, requests);
    }
    if (group.kind !== 'pending') { result.push(group); continue; }
    const tasks = group.tasks.flatMap(task => {
      const turns = task.turns.filter(request => !classification(request));
      return turns.length ? [{ ...task, turns, ...totals(turns) }] : [];
    });
    if (tasks.length) {
      const turns = tasks.flatMap(task => task.turns);
      result.push({ ...group, tasks, ...totals(turns), ...timeRange(turns, group) });
    }
  }
  for (const [id, {agent, kind, source, categories}] of collections) {
    const definition = collectionDefinitions[kind], tasks: Session[] = [];
    for (const [category, label] of Object.entries(definition.labels)) {
      const requests = categories.get(category);
      if (!requests) continue;
      const turns = [...requests].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.record_id - b.record_id)
        .map((request, index) => ({ ...request, turn_index: index + 1 }));
      tasks.push({id: JSON.stringify([id, category]), kind, agent_name: agent, model: '',
        user_prompt: label, created_at: turns[0].created_at || source.created_at, turns, ...totals(turns)});
    }
    const turns = tasks.flatMap(task => task.turns);
    result.push({id, kind, attribution_mode: 'verified', title: definition.title, session_id: '',
      agent_name: agent, model: '', ...timeRange(turns, source), tasks, tasks_count: 0, ...totals(turns)});
  }
  return result.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || a.id.localeCompare(b.id));
}

export const isConversation = (group: SessionCluster): boolean =>
  group.kind !== 'pending' && group.kind !== 'auxiliary' && group.kind !== 'connection';
