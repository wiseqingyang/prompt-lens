import type { AuditRecord, SessionCluster, TaskCluster, TaskTurn } from '../types';
import type { AttributionDecision, TurnIdentity } from '../../shared/attribution';
import { auxiliaryPurposeLabels, connectionIssueLabels, UNRECOGNIZED_NAME } from '../../shared/attribution';
import { isSuccessfulCapture } from '../../shared/capture';
import { cleanPromptSummary } from '../../shared/protocol';

/** Existing navigation DTO names are translated here: tasks are turn groups, turns are request references. */
export function attributionView(items: { record: AuditRecord; decision: AttributionDecision }[]): SessionCluster[] {
  const sessions = new Map<string, SessionCluster>();
  const activeTurns = new Map<string, TurnIdentity>();
  const observedTurns = new Map<string, Set<string>>();
  for (const { record: r, decision } of [...items].sort((a, b) => (a.record.created_at || '').localeCompare(b.record.created_at || '') || (a.record.id || 0) - (b.record.id || 0))) {
    const link = decision.toolLink?.status === 'resolved' ? decision.toolLink.value : undefined;
    const sid = link?.sessionId || (decision.session.status === 'resolved' ? decision.session.value : '');
    const id = JSON.stringify(['attribution', decision.agentId, sid || 'pending']);
    let session = sessions.get(id);
    if (!session) {
      session = { id, session_id: sid, agent_name: r.agent_name, model: r.model,
        session_id_source: sid ? (decision.identitySource || (decision.agentId === 'codex' ? 'codex_metadata' : 'conversation_id')) : 'unknown', session_confidence: sid ? 'exact' : 'unknown',
        attribution_mode: 'verified', kind: sid ? 'session' : 'pending', parent_session_id: decision.parentSessionId,
        title: sid ? UNRECOGNIZED_NAME : '其他请求', created_at: r.created_at || '', updated_at: r.created_at || '',
        tasks: [], tasks_count: 0, turns_count: 0, total_duration_ms: 0, total_input_tokens: 0,
        total_cached_tokens: 0, total_thinking_tokens: 0, total_output_tokens: 0, cache_ratio: 0 };
      sessions.set(id, session);
    }
    let turn = link?.turn || (sid && decision.turn.status === 'resolved' ? decision.turn.value : undefined);
    if (sid && decision.turnGrouping === 'observed_inputs') {
      // An explicit session always has a product turn, even when capture began mid-conversation.
      // Late requests for an already observed turn retain that group without rewinding the active turn.
      if (!link) {
        const observed = observedTurns.get(id) || new Set<string>();
        observedTurns.set(id, observed);
        if (!turn || decision.turnBehavior === 'continue') {
          turn = activeTurns.get(id) || { id: JSON.stringify([id, 'initial']) };
          activeTurns.set(id, turn);
        } else {
          if (!observed.has(turn.id) || activeTurns.get(id)?.id === turn.id) activeTurns.set(id, turn);
          observed.add(turn.id);
        }
      }
    }
    const purpose = decision.purpose?.kind;
    const issue = decision.connectionIssue?.kind;
    const taskId = JSON.stringify([id, turn?.id || (purpose ? ['purpose', purpose] : issue ? ['connection', issue] : 'unassigned')]);
    let task = session.tasks.find(item => item.id === taskId);
    if (!task) {
      task = { id: taskId, kind: turn ? 'turn' : purpose ? 'auxiliary' : issue ? 'connection' : 'unassigned', native_input_index: turn?.inputIndex, native_trajectory_id: turn?.trajectoryId,
        turn_kind: decision.turnBehavior === 'continue' ? undefined : decision.turnKind, lifecycle: decision.lifecycle,
        session_id: sid, session_confidence: sid ? 'exact' : 'unknown', session_id_source: sid ? (decision.identitySource || (decision.agentId === 'codex' ? 'codex_metadata' : 'conversation_id')) : 'unknown',
        user_prompt: turn ? (turn.title?.trim() || '') : purpose ? auxiliaryPurposeLabels[purpose] : issue ? connectionIssueLabels[issue] : '其他请求', created_at: r.created_at || '',
        agent_name: r.agent_name, model: r.model, turns: [], turns_count: 0, total_duration_ms: 0,
        total_input_tokens: 0, total_cached_tokens: 0, total_thinking_tokens: 0, total_output_tokens: 0,
        is_completed: false, cache_ratio: 0 };
      session.tasks.push(task);
      if (turn) session.tasks_count++;
    }
    if (turn && !task.user_prompt && turn.title?.trim()) task.user_prompt = turn.title.trim();
    const request: TaskTurn = { record_id: r.id!, turn_index: task.turns.length + 1,
      model: r.model, created_at: r.created_at, token_source: r.token_source,
      turn_type: !isSuccessfulCapture(r.status_code, r.capture_status) ? 'error' : r.tool_calls_json && r.tool_calls_json !== '[]' ? 'thought_and_action' : 'final_answer',
      status_code: r.status_code, duration_ms: r.duration_ms || 0, input_tokens: r.input_tokens || 0,
      output_tokens: r.output_tokens || 0, cached_tokens: r.cached_tokens || 0, thinking_tokens: r.thinking_tokens || 0,
      summary: cleanPromptSummary(r.prompt_summary || ''), response_preview: r.response_preview || '', assignment: decision, subagents: [] };
    task.turns.push(request);
    task.turns_count++; session.turns_count++;
    for (const aggregate of [task, session]) {
      aggregate.total_duration_ms += request.duration_ms;
      aggregate.total_input_tokens += request.input_tokens;
      aggregate.total_cached_tokens += request.cached_tokens;
      aggregate.total_output_tokens += request.output_tokens;
      aggregate.total_thinking_tokens += request.thinking_tokens;
      aggregate.cache_ratio = aggregate.total_input_tokens ? Number((aggregate.total_cached_tokens * 100 / aggregate.total_input_tokens).toFixed(1)) : 0;
    }
    if (!link) task.is_completed = decision.lifecycle === 'unknown' ? false : request.turn_type === 'final_answer';
    if (r.created_at) {
      session.updated_at = r.created_at > session.updated_at ? r.created_at : session.updated_at;
      session.created_at = r.created_at < session.created_at ? r.created_at : session.created_at;
    }
  }
  for (const session of sessions.values()) {
    // Trajectory order is display-only; within a trajectory the native event index orders turns.
    const trajectoryStart = new Map<string, string>();
    for (const task of session.tasks) {
      if (task.native_trajectory_id) {
        const first = trajectoryStart.get(task.native_trajectory_id);
        if (!first || task.created_at < first) trajectoryStart.set(task.native_trajectory_id, task.created_at);
      }
    }
    session.tasks.sort((a, b) => {
      if ((a.kind === 'turn') !== (b.kind === 'turn')) return a.kind === 'turn' ? -1 : 1;
      if (a.native_trajectory_id && b.native_trajectory_id) {
        if (a.native_trajectory_id === b.native_trajectory_id) return a.native_input_index! - b.native_input_index!;
        return trajectoryStart.get(a.native_trajectory_id)!.localeCompare(trajectoryStart.get(b.native_trajectory_id)!) || a.native_trajectory_id.localeCompare(b.native_trajectory_id);
      }
      return a.created_at.localeCompare(b.created_at) || (a.turns[0]?.record_id || 0) - (b.turns[0]?.record_id || 0) || a.id.localeCompare(b.id);
    });
    for (const task of session.tasks) {
      const linked = new Map<number, TaskTurn[]>();
      for (const request of task.turns) if (request.assignment?.toolLink?.status === 'resolved') {
        const parent = request.assignment.toolLink.value.parentRecordId;
        linked.set(parent, [...(linked.get(parent) || []), request]);
      }
      task.turns = task.turns.filter(request => request.assignment?.toolLink?.status !== 'resolved')
        .flatMap(request => [request, ...(linked.get(request.record_id) || [])]);
      task.turns.forEach((request, index) => { request.turn_index = index + 1; });
    }
    if (session.kind === 'session') session.title = session.tasks.find(task => task.kind === 'turn' && task.user_prompt)?.user_prompt || UNRECOGNIZED_NAME;
    for (const task of session.tasks) if (task.kind === 'turn' && !task.user_prompt) task.user_prompt = UNRECOGNIZED_NAME;
  }
  return [...sessions.values()];
}
