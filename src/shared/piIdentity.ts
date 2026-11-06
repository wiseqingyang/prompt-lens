import { headerValues } from './captureProtocol';

/** Client evidence only; a Codex provider URL/account is not a Codex client identity. */
export function piIdentity(headers: Record<string, unknown> | undefined): 'pi' | 'conflict' | 'absent' {
  const values = (key: string) => headerValues(headers, key).filter((value): value is string => typeof value === 'string');
  const agents = values('user-agent').map(value => value.toLowerCase());
  const origins = values('originator').map(value => value.toLowerCase());
  const pi = agents.some(value => /^pi(?:-coding-agent|-agent)?(?:\/|\s|\(|$)/.test(value)) || origins.includes('pi');
  if (!pi) return 'absent';
  const other = new Set(agents).size > 1 || new Set(origins).size > 1 || agents.some(value => /codex|chatgpt|antigravity|claude-cli|claude-code|cursor/.test(value)) ||
    origins.some(value => value !== 'pi') || values('x-codex-turn-metadata').length > 0;
  return other ? 'conflict' : 'pi';
}
