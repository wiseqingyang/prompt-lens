import type { Session, SessionCluster } from '../types';
import { UNRECOGNIZED_NAME } from '../../shared/attribution';
import { cleanPromptSummary } from '../../shared/protocol';

export function shortTitle(value = '', limit = 28): string {
  const text = cleanPromptSummary(value)
    .replace(/\[Tool Result:?\s*([^\]]*)\]/g, '工具结果 $1')
    .replace(/\[Tool Call\]\s*/g, '工具调用 ')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[#*>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text || UNRECOGNIZED_NAME);
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : chars.join('');
}

/** Verified sessions navigate a server-defined turn; legacy Agents retain their existing navigation. */
export function sessionNavigation(group: SessionCluster | null, selectedTaskId?: string | null): Session | null {
  if (!group) return null;
  if (group.attribution_mode === 'verified') {
    const task = group.tasks.find(task => task.id === selectedTaskId) || group.tasks.find(task => task.kind === 'turn') || group.tasks[0] || null;
    if (!task) return null;
    return {
      ...task,
      turns: task.turns.map(turn => ({
        ...turn,
        summary: cleanPromptSummary(turn.summary) ? shortTitle(turn.summary, 28) : ''
      }))
    };
  }
  const turns = group.tasks.flatMap(task => task.turns.map(turn => ({ ...turn,
    summary: shortTitle(cleanPromptSummary(turn.summary) || task.user_prompt || turn.response_preview) })))
    .sort((a, b) => a.record_id - b.record_id)
    .map((turn, index) => ({ ...turn, turn_index: index + 1 }));
  return { ...group, kind: undefined, user_prompt: group.tasks[0]?.user_prompt || '', turns };
}
