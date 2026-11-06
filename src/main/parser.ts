/**
 * PromptLens Protocol Parser (TypeScript)
 * Deep protocol inspector for Gemini (CloudCode/Antigravity), Anthropic (Claude Code), OpenAI (Cursor/Copilot).
 * Extracts Input/Output/Cached/Thinking tokens, Tool Calls, and Agent identities.
 */

import { workbuddyIdentity } from '../shared/workbuddyIdentity';
import { piIdentity } from '../shared/piIdentity';
import { ProviderType, TokenUsage } from './types';
import { socketMessages } from '../shared/communication';
import { isWebFetchRequest } from '../shared/protocol';
import { schemaRegistry, SchemaRegistry } from './schemas/registry';
export { schemaRegistry, SchemaRegistry };
export * from './schemas/types';

export function detectProvider(
  urlPath: string,
  headers: Record<string, string>,
  bodyJson?: any
): ProviderType {
  const path = (urlPath || '').toLowerCase();
  const host = (headers['host'] || '').toLowerCase();

  if (
    host.includes('googleapis.com') ||
    path.includes('streamgeneratecontent') ||
    path.includes('generatecontent') ||
    path.includes('v1internal') ||
    (bodyJson && ('contents' in bodyJson || (bodyJson.request && 'contents' in bodyJson.request)))
  ) {
    return 'gemini';
  }

  if (
    host.includes('anthropic.com') ||
    path.includes('v1/messages') ||
    headers['anthropic-version']
  ) {
    return 'anthropic';
  }

  if (
    host.includes('openai.com') ||
    host.includes('chatgpt.com') ||
    path.includes('v1/chat/completions') ||
    /^\/v2\/chat\/completions(?:[?#]|$)/.test(path) ||
    path.includes('v1/responses') ||
    path.includes('/backend-api/') ||
    path.includes('/codex/') ||
    (bodyJson && ('messages' in bodyJson || 'input' in bodyJson || 'instructions' in bodyJson) && !bodyJson.contents)
  ) {
    return 'openai';
  }

  return 'unknown';
}

export function detectAgent(
  headers: Record<string, string>,
  urlPath = '',
  bodyJson?: any
): string {
  const header = (name: string): string => {
    const wanted = name.toLowerCase();
    const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === wanted);
    return key ? String(headers[key] || '') : '';
  };
  const workbuddy = workbuddyIdentity(headers);
  if (workbuddy === 'conflict') return 'Unknown';
  if (workbuddy === 'workbuddy') return 'WorkBuddy';
  const pi = piIdentity(headers);
  if (pi === 'conflict') return 'Unknown';
  if (pi === 'pi') return 'Pi Agent';
  const ua = header('user-agent').toLowerCase();
  const host = header('host').toLowerCase();
  const originator = header('originator').toLowerCase();
  const path = String(urlPath || '').toLowerCase();
  const hasCodexHeader = Boolean(
    bodyJson?.client_metadata?.['x-codex-turn-metadata'] ||
    originator.includes('codex') ||
    header('x-codex-turn-metadata') ||
    header('x-codex-turn-id') ||
    header('x-codex-session-id') ||
    header('x-codex-window-id') ||
    header('chatgpt-account-id')
  );

  // 1. Codex App & CLI (UA check or explicit Codex protocol headers)
  if (
    ua.includes('codex') ||
    ua.includes('chatgpt') ||
    hasCodexHeader ||
    path.includes('/backend-api/codex') ||
    path.includes('/codex/')
  ) {
    return 'Codex';
  }

  // 2. Antigravity (Google CloudCode / Antigravity internal client)
  if (
    path.includes('v1internal') ||
    path.includes('cloudcode') ||
    host.includes('cloudcode') ||
    ua.includes('antigravity') ||
    Boolean(bodyJson && bodyJson.request && bodyJson.request.contents)
  ) {
    if (bodyJson && (bodyJson.requestType === 'web_search' || bodyJson.request?.requestType === 'web_search')) {
      return 'Antigravity (WebSearch)';
    }
    return 'Antigravity';
  }

  // Other known clients are retained for compatibility with existing sessions.
  if (
    ua.includes('claude-cli') ||
    ua.includes('claude-code') ||
    ua.includes('claude') ||
    header('anthropic-client')
  ) {
    return 'Claude Code';
  }

  if (ua.includes('cursor') || header('x-cursor-client')) {
    return 'Cursor';
  }

  if (ua.includes('windsurf') || ua.includes('codeium')) return 'Windsurf';
  if (ua.includes('copilot')) return 'Copilot';

  const provider = detectProvider(urlPath, headers, bodyJson);
  if (provider === 'gemini') return 'Antigravity';
  if (provider === 'anthropic') return 'Claude Agent';
  if (provider === 'openai') return 'OpenAI Agent';

  return 'Agent';
}

export function extractRequestInfo(
  provider: ProviderType,
  bodyStr: string,
  urlPath: string
): {
  model: string;
  system_prompt: string;
  messages: Array<{ role: string; text: string; tools?: any[] }>;
  raw_json: any;
} {
  let data: any = {};
  try {
    data = bodyStr ? JSON.parse(bodyStr) : {};
  } catch {
    return { model: 'unknown', system_prompt: '', messages: [], raw_json: null };
  }

  if (isWebFetchRequest(urlPath)) {
    return { model: 'web-fetch', system_prompt: '', messages: [], raw_json: data };
  }

  let model = 'unknown';
  let system_prompt = '';
  const messages: Array<{ role: string; text: string; tools?: any[] }> = [];

  if (provider === 'gemini') {
    const reqObj = data.request || data;
    if (data.model) model = data.model;
    else if (reqObj.model) model = reqObj.model;
    else {
      const m = urlPath.match(/models\/([^/:]+)/);
      if (m) model = m[1];
    }

    const sysInst = reqObj.systemInstruction;
    if (sysInst && sysInst.parts && Array.isArray(sysInst.parts)) {
      system_prompt = sysInst.parts
        .map((p: any) => p.text || '')
        .filter(Boolean)
        .join('\n');
    }

    const contents = reqObj.contents || [];
    for (const c of contents) {
      const parts = c.parts || [];
      const role = parts.some((p: any) => p.functionResponse) &&
        !parts.some((p: any) => p.text || p.functionCall) ? 'tool' : c.role || 'user';
      const textParts: string[] = [];
      const tools: any[] = [];

      for (const p of parts) {
        if (p.text) textParts.push(p.text);
        if (p.functionCall) tools.push(p.functionCall);
        if (p.functionResponse) {
          tools.push(p.functionResponse);
          const output = p.functionResponse.response;
          if (typeof output?.output === 'string') textParts.push(output.output);
          else if (output !== undefined) textParts.push(JSON.stringify(output));
        }
      }

      messages.push({
        role,
        text: textParts.join('\n'),
        tools: tools.length ? tools : undefined
      });
    }
  } else if (provider === 'anthropic') {
    model = data.model || 'unknown';
    if (typeof data.system === 'string') {
      system_prompt = data.system;
    } else if (Array.isArray(data.system)) {
      system_prompt = data.system.map((s: any) => s.text || '').join('\n');
    }

    const toolUseIdToName = new Map<string, string>();
    for (const m of data.messages || []) {
      if (Array.isArray(m?.content)) {
        for (const c of m.content) {
          if (c?.type === 'tool_use' && c.id && c.name) {
            toolUseIdToName.set(c.id, c.name);
          }
        }
      }
    }

    for (const m of data.messages || []) {
      let role = m.role || 'user';
      let text = '';
      const tools: any[] = [];
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        const texts: string[] = [];
        for (const c of m.content) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'text' && c.text) texts.push(c.text);
          if (c.type === 'tool_use') {
            tools.push({ id: c.id || '', name: c.name || 'tool', args: c.input });
          }
          if (c.type === 'tool_result') {
            const toolName = (c.tool_use_id && toolUseIdToName.get(c.tool_use_id)) || c.name || 'tool';
            const out = typeof c.content === 'string'
              ? c.content
              : Array.isArray(c.content)
              ? c.content.map((p: any) => p?.text || JSON.stringify(p)).join('\n')
              : JSON.stringify(c.content || '');
            tools.push({ id: c.tool_use_id || '', name: toolName, output: out });
          }
        }
        if (m.content.some((c: any) => c?.type === 'tool_result') && !texts.length) {
          role = 'tool';
        }
        text = texts.join('\n');
      }

      messages.push({ role, text, tools: tools.length ? tools : undefined });
    }
  } else if (provider === 'openai') {
    model = data.model || 'unknown';

    // Instructions / system prompt (OpenAI Responses API or Chat)
    if (typeof data.instructions === 'string') {
      system_prompt = data.instructions;
    } else if (Array.isArray(data.instructions)) {
      system_prompt = data.instructions
        .map((i: any) => (typeof i === 'string' ? i : i.text || ''))
        .filter(Boolean)
        .join('\n');
    }

    // 1. Process standard chat completions messages
    const chatCallIdToName = new Map<string, string>();
    for (const m of data.messages || []) {
      if (Array.isArray(m?.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc?.function?.name || tc?.name;
          if (tc?.id && name) chatCallIdToName.set(tc.id, name);
        }
      }
    }
    for (const m of data.messages || []) {
      const role = m.role || 'user';
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .filter((c: any) => c.type === 'text' || typeof c === 'string')
          .map((c: any) => (typeof c === 'string' ? c : c.text || ''))
          .join('\n');
      }

      if ((role === 'system' || role === 'developer') && !system_prompt) {
        system_prompt = text;
      } else if (role === 'developer' && system_prompt) {
        system_prompt += '\n\n' + text;
      } else if (role === 'tool') {
        const toolName = (m.tool_call_id && chatCallIdToName.get(m.tool_call_id)) || m.name || 'tool';
        messages.push({ role, text, tools: [{ id: m.tool_call_id || '', name: toolName, output: text }] });
      } else {
        messages.push({ role, text, tools: m.tool_calls || m.tools });
      }
    }

    // 2. Process OpenAI Responses API input (used by Codex)
    if (data.input !== undefined) {
      if (typeof data.input === 'string') {
        messages.push({ role: 'user', text: data.input });
      } else if (Array.isArray(data.input)) {
        // Build call_id to tool name mapping from function_call and custom_tool_call items
        const callIdToName = new Map<string, string>();
        for (const item of data.input) {
          if (item && typeof item === 'object') {
            if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.call_id && item.name) {
              callIdToName.set(item.call_id, item.name);
            }
          }
        }

        for (const item of data.input) {
          if (typeof item === 'string') {
            messages.push({ role: 'user', text: item });
          } else if (item && typeof item === 'object') {
            if (item.type === 'additional_tools') {
              // Tool schemas definition container - skip from conversation messages
              continue;
            } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              const rawArgs = item.arguments !== undefined ? item.arguments : item.input;
              const toolArgs = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '');
              messages.push({
                role: 'assistant',
                text: '',
                tools: [{
                  id: item.call_id || item.id || '',
                  name: item.name || 'tool',
                  args: toolArgs
                }]
              });
            } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
              const toolName = (item.call_id && callIdToName.get(item.call_id)) || 'tool';
              let text = '';
              if (typeof item.output === 'string') {
                text = item.output;
              } else if (Array.isArray(item.output)) {
                text = item.output
                  .map((p: any) => {
                    if (typeof p === 'string') return p;
                    if (p && typeof p === 'object') {
                      if (p.type === 'input_text' || p.type === 'text' || p.type === 'output_text') return p.text || '';
                      return p.text || JSON.stringify(p);
                    }
                    return '';
                  })
                  .filter(Boolean)
                  .join('\n');
              } else {
                text = JSON.stringify(item.output || '');
              }
              messages.push({
                role: 'tool',
                text,
                tools: [{
                  id: item.call_id || '',
                  name: toolName,
                  output: text
                }]
              });
            } else {
              const role = item.role || (item.type === 'message' ? item.role || 'user' : 'user');
              let text = '';
              if (typeof item.content === 'string') {
                text = item.content;
              } else if (Array.isArray(item.content)) {
                text = item.content
                  .map((c: any) => {
                    if (typeof c === 'string') return c;
                    if (c && typeof c === 'object') {
                      if (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') return c.text || '';
                      return c.text || '';
                    }
                    return '';
                  })
                  .filter(Boolean)
                  .join('\n');
              } else if (typeof item.text === 'string') {
                text = item.text;
              }

              if ((role === 'system' || role === 'developer') && !system_prompt) {
                system_prompt = text;
              } else if (role === 'developer' && system_prompt) {
                system_prompt += '\n\n' + text;
              } else {
                messages.push({ role, text });
              }
            }
          }
        }
      }
    }
  }

  return { model, system_prompt, messages, raw_json: data };
}

/**
 * Robustly parses SSE streams, multi-line formatted JSON, JSON arrays,
 * and handles missing space after "data:".
 */
export function parseJsonChunks(rawText: string): any[] {
  if (!rawText || !rawText.trim()) return [];
  const trimmed = rawText.trim();

  // 1. Direct JSON (single object or array)
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
  }

  const results: any[] = [];

  // 2. Standard SSE blocks separated by double newlines
  const sseBlocks = rawText.split(/\r?\n\r?\n/);
  if (sseBlocks.length > 1) {
    for (const block of sseBlocks) {
      const lines = block.split(/\r?\n/);
      const dataLines: string[] = [];
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith('data:')) {
          const payload = l.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            dataLines.push(payload);
          }
        }
      }
      if (dataLines.length) {
        const fullPayload = dataLines.join('\n');
        try {
          const parsed = JSON.parse(fullPayload);
          if (Array.isArray(parsed)) results.push(...parsed);
          else results.push(parsed);
        } catch {
          // Attempt extraction of JSON object within block
          const start = fullPayload.indexOf('{');
          const end = fullPayload.lastIndexOf('}');
          if (start !== -1 && end > start) {
            try {
              results.push(JSON.parse(fullPayload.slice(start, end + 1)));
            } catch {}
          }
        }
      }
    }
    if (results.length > 0) return results;
  }

  // 3. Fallback: line-by-line data: extraction
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    let jsonStr = '';
    if (l.startsWith('data:')) {
      jsonStr = l.slice(5).trim();
    } else if (l.startsWith('{') && l.endsWith('}')) {
      jsonStr = l;
    }
    if (!jsonStr || jsonStr === '[DONE]') continue;
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) results.push(...parsed);
      else results.push(parsed);
    } catch {}
  }

  if (results.length > 0) return results;

  // 4. Bracket balancing extraction for multi-line JSON objects embedded without double newlines
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < rawText.length; i++) {
    const char = rawText[i];
    if (inString) {
      if (char === '\\') {
        isEscaped = !isEscaped;
      } else if (char === '"' && !isEscaped) {
        inString = false;
      } else {
        isEscaped = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      isEscaped = false;
    } else if (char === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        const candidate = rawText.slice(startIdx, i + 1);
        try {
          results.push(JSON.parse(candidate));
        } catch {}
        startIdx = -1;
      }
    }
  }

  return results;
}

export function extractResponseInfo(
  provider: ProviderType,
  resText: string,
  urlPath = '',
  bodyFormat = ''
): {
  usage: TokenUsage;
  responseText: string;
  thinkingText?: string;
  toolCalls: any[];
  finishReason: string;
  confidence?: 'exact' | 'heuristic';
} {
  if (!resText || !resText.trim()) {
    return {
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        thinking_tokens: 0,
        total_tokens: 0,
        cache_ratio: 0,
        token_source: 'unavailable',
        raw_details: {}
      },
      responseText: '',
      thinkingText: '',
      toolCalls: [],
      finishReason: ''
    };
  }

  let chunks: any[];
  if (bodyFormat === 'ws-messages-v1') {
    try {
      chunks = socketMessages(resText).filter(m => m.direction === 'server').map(m => JSON.parse(m.payload));
      const seen = new Set<number>();
      chunks = chunks.filter(chunk => {
        if (!Number.isInteger(chunk.sequence_number)) return true;
        if (seen.has(chunk.sequence_number)) return false;
        seen.add(chunk.sequence_number); return true;
      });
    } catch { chunks = []; }
  } else chunks = parseJsonChunks(resText);
  if (isWebFetchRequest(urlPath)) {
    const payload = chunks[0];
    const content = payload?.content;
    const error = payload?.error;
    return {
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, thinking_tokens: 0,
        total_tokens: 0, cache_ratio: 0, token_source: chunks.length ? 'unavailable' : 'parse_error', raw_details: {} },
      responseText: typeof content === 'string'
        ? `网页抓取成功（${content.length} 字符），完整内容见原始响应报文。`
        : typeof error?.message === 'string' ? `网页抓取失败：${error.message}` : '',
      thinkingText: '', toolCalls: [],
      finishReason: typeof error?.status === 'string' ? error.status : typeof content === 'string' ? 'fetched' : ''
    };
  }
  const ctx = schemaRegistry.extract(chunks, provider);

  let responseText = ctx.textSegments.join('');
  const thinkingSegments = [...ctx.thinkingSegments];
  const toolCalls = [...ctx.toolCalls];
  let inTok = ctx.inTok;
  let outTok = ctx.outTok;
  let cachedTok = ctx.cachedTok;
  let thinkingTok = ctx.thinkingTok;
  let totalTok = ctx.totalTok;
  const finishReason = ctx.finishReason;
  const rawDetails = ctx.rawDetails;

  const thinkMatch = responseText.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    thinkingSegments.push(thinkMatch[1].trim());
    responseText = responseText.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
  }

  // Error text remains readable, but it is never model output or usage evidence.
  if (!responseText) {
    const error = chunks.find(chunk => typeof chunk?.error?.message === 'string')?.error;
    if (error) responseText = error.message;
  }
  const tokenSource = ctx.hasUsage ? 'reported' : chunks.length ? 'unavailable' : 'parse_error';

  const cacheRatio = inTok > 0 && cachedTok > 0 ? Number(((cachedTok / inTok) * 100).toFixed(1)) : 0.0;

  return {
    usage: {
      input_tokens: inTok,
      output_tokens: outTok,
      cached_tokens: cachedTok,
      thinking_tokens: thinkingTok,
      total_tokens: ctx.hasTotalUsage ? totalTok : inTok + outTok,
      cache_ratio: cacheRatio,
      token_source: tokenSource,
      raw_details: rawDetails
    },
    responseText: responseText || chunks.map(chunk => chunk.error?.message || chunk.response?.error?.message || '').filter(Boolean).join('\n'),
    thinkingText: thinkingSegments.join('\n').trim(),
    toolCalls,
    finishReason,
    confidence: ctx.confidence
  };
}
