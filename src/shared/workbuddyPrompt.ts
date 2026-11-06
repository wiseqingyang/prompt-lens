import { headerValues, isObject } from './captureProtocol';
import { workbuddyIdentity } from './workbuddyIdentity';

const REMINDER_BLOCK = '<system-reminder data-role="(?:user-context|additional-data)">[\\s\\S]*?<\\/system-reminder>';
const ENVELOPE_RE = new RegExp(`^${REMINDER_BLOCK}(?:\\s*${REMINDER_BLOCK})?\\s*<user_query>([\\s\\S]*)<\\/user_query>$`);

/** WorkBuddy's prompt envelope, not a general XML/tag sanitizer. */
function userQuery(text: string): string | undefined {
  const remaining = text.trim();
  if (!remaining) return;
  if (remaining.startsWith('<system-reminder')) {
    if (!remaining.endsWith('</user_query>')) return;
    const query = remaining.match(ENVELOPE_RE);
    return query?.[1].trim() || undefined;
  }
  if (remaining.startsWith('<user_query')) {
    const query = remaining.match(/^<user_query>([\s\S]*)<\/user_query>$/);
    return query?.[1].trim() || undefined;
  }
  return remaining;
}

/** One explicitly marked external input for the current main execution. */
export function workbuddyUserInput(headers: Record<string, unknown> | undefined, body: unknown): { text: string; evidence: string[]; messageIndex: number } | undefined {
  if (workbuddyIdentity(headers) !== 'workbuddy') return;
  const unique = (key: string) => {
    const values = headerValues(headers, key);
    return values.length && values.every(value => value === values[0]) ? values[0] : undefined;
  };
  const turn = unique('x-conversation-request-id');
  if (typeof turn !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(turn) ||
      unique('x-agent-type') !== 'main' || unique('x-agent-purpose') !== 'conversation') return;
  if (!isObject(body) || !Array.isArray(body.messages)) return;
  const candidates = body.messages.filter(message => isObject(message) && message.role === 'user' &&
    message.startsNewUserRequest === true && message.conversationRequestId === turn &&
    !message.isMeta && !message.isAdditionalData);
  if (candidates.length !== 1) return;
  const content: unknown = candidates[0].content;
  const raw = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => isObject(part) && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
  const text = userQuery(raw);
  const messageIndex = body.messages.indexOf(candidates[0]);
  const prefix = `body.messages[${messageIndex}]`;
  return text ? { text, messageIndex, evidence: ['role', 'startsNewUserRequest', 'conversationRequestId', 'content'].map(key => `${prefix}.${key}`) } : undefined;
}

/** A request preview describes its last message, not an earlier input in the turn. */
export function workbuddyRequestSummary(headers: Record<string, unknown> | undefined, body: unknown): { text: string; evidence: string[] } | undefined {
  const input = workbuddyUserInput(headers, body);
  if (!input || !isObject(body) || !Array.isArray(body.messages) || input.messageIndex !== body.messages.length - 1) return;
  return { text: Array.from(input.text.replace(/\s+/g, ' ')).slice(0, 300).join(''), evidence: input.evidence };
}
