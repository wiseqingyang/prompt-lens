import { object, type AntigravityArchive, type NativeEvidence, type NativeStep } from '../contracts';

/** Pure decoder: can replay an archived source without the Agent filesystem. */
export function decodeAntigravityArchive(raw: AntigravityArchive, sourceId: string): NativeEvidence {
  try {
    const lines = raw.transcript.split('\n').filter(line => line.trim());
    if (lines.length > 20000) return { status: 'unavailable', reason: 'source_limit', raw };
    const steps: NativeStep[] = lines.map(line => {
      const event = object(JSON.parse(line));
      if (!Number.isSafeInteger(event.step_index) || Number(event.step_index) < 0 ||
          typeof event.source !== 'string' || typeof event.type !== 'string' || typeof event.created_at !== 'string') {
        throw new Error('Invalid native event');
      }
      const step: NativeStep = { index: Number(event.step_index), source: event.source, type: event.type, createdAt: event.created_at };
      if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') {
        const text = typeof event.content === 'string' ? event.content : '';
        step.input = (text.match(/^\s*<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1] || text).trim().slice(0, 4000);
      }
      return step;
    }).sort((a, b) => a.index - b.index);
    if (steps.some((step, index) => index > 0 && step.index === steps[index - 1].index)) throw new Error('Duplicate step');
    return { status: 'available', sourceId, trajectoryId: raw.metadata.trajectory_id, steps, raw };
  } catch {
    return { status: 'unavailable', reason: 'source_invalid', raw };
  }
}
