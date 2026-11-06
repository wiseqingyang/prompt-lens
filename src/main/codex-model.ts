import { socketMessages } from '../shared/communication';

/** Return only complete, top-level server events. Never recover JSON substrings from damaged frames. */
export function modelResponseEvents(raw: string, format = ''): unknown[] {
  const object = (text: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; }
  };
  if (!raw) return [];
  if (format === 'ws-messages-v1') {
    try {
      return socketMessages(raw).filter(message => message.direction === 'server')
        .map(message => object(message.payload)).filter((event): event is Record<string, unknown> => !!event);
    } catch { return []; }
  }
  const direct = object(raw);
  if (direct) return [direct];
  const events: Record<string, unknown>[] = [];
  // Only an empty SSE line dispatches an event. The final unfinished block is not evidence.
  const lines = raw.split(/\r\n|\r|\n/);
  let data: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line === '') {
      if (data.length) {
        const event = object(data.join('\n'));
        if (event) events.push(event);
      }
      data = [];
    } else if (line === 'data') data.push('');
    else if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      data.push(value);
    }
  }
  return events;
}

/** Resolve model evidence for Codex Responses captures without inferring from text or usage.
 * The caller supplies only server response events from the captured exchange. */
export function codexResponseModel(agent: string, urlPath: string, requestModel: unknown, events: unknown[]): string | undefined {
  if (agent !== 'Codex' || !/^\/(?:backend-api\/codex|v1)\/responses(?:\?.*)?$/i.test(urlPath)) return undefined;
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0 && value === value.trim() && value !== 'unknown') candidates.add(value);
  };
  add(requestModel);
  for (const value of events) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (!['response.created', 'response.in_progress', 'response.completed'].includes(String(event.type))) continue;
    if (!event.response || typeof event.response !== 'object' || Array.isArray(event.response)) continue;
    add((event.response as Record<string, unknown>).model);
  }
  return candidates.size === 1 ? [...candidates][0] : 'unknown';
}
