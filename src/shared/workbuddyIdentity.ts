import { headerValues } from './captureProtocol';

/** Client evidence, independent of the model endpoint (including custom providers). */
export function workbuddyIdentity(headers: Record<string, unknown> | undefined): 'workbuddy' | 'conflict' | 'absent' {
  const agents = headerValues(headers, 'user-agent');
  const isWorkBuddy = (value: unknown): value is string => typeof value === 'string' && /^WorkBuddy\/[^\s/]+(?:\s|$)/i.test(value);
  if (!agents.some(isWorkBuddy)) return 'absent';
  if (agents.some(value => !isWorkBuddy(value)) || new Set(agents).size !== 1 ||
      agents.some(value => /(?:^|\s)(?:codex|chatgpt|pi|antigravity|claude-code|claude-cli|cursor)(?:\/|\s|$)/i.test(String(value)))) return 'conflict';
  for (const key of ['x-ide-name', 'x-ide-type', 'originator']) {
    if (headerValues(headers, key).some(value => typeof value !== 'string' || value.toLowerCase() !== 'workbuddy')) return 'conflict';
  }
  if (headerValues(headers, 'x-codex-turn-metadata').length) return 'conflict';
  return 'workbuddy';
}
