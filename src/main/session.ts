import { workbuddyAdapter } from './attribution/adapters/workbuddy';
/**
 * PromptLens Session & Prompt Anatomy Analyzer (TypeScript)
 * Dissects raw LLM inputs into 5 distinct architectural layers:
 * 1. User Intent (What user actually typed)
 * 2. System Persona & Core Rules
 * 3. Tool Schemas & Definitions
 * 4. Workspace Context & Injected Rules
 * 5. History & Injected File Contents
 *
 * Computes context bloat multiplier and aggregates turns into ReAct Task Trees.
 */

import { AuditRecord, PaginatedSessions, PromptAnatomy, PromptLayer, SessionCluster, SessionIdentity, SubagentDetail, TaskCluster, TaskTurn } from './types';
import { getAgentCategory } from '../shared/agent';
import { isSuccessfulCapture } from '../shared/capture';
import { cleanPromptSummary, isWebFetchRequest } from '../shared/protocol';
import { codexAdapter } from './attribution/adapters/codex';
import type { ProtocolCapture } from '../shared/captureProtocol';
import { antigravityFacts } from './attribution/adapters/antigravity';
import { workbuddyUserInput } from '../shared/workbuddyPrompt';

function normalizedHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function firstString(...values: any[]): string | undefined {
  return values.find((v) => typeof v === 'string' && v.trim())?.trim();
}

function parseMetadata(value: any): Record<string, any> | undefined {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

// Only inspect identity-bearing envelopes, never arbitrary message/tool arguments.
function identityEnvelopes(value: any, depth = 0): Record<string, any>[] {
  const obj = parseMetadata(value);
  if (!obj || depth > 6) return [];
  return [obj, ...['request', 'metadata', 'client_metadata', 'x-codex-turn-metadata', 'context'].flatMap(
    (key) => identityEnvelopes(obj[key], depth + 1)
  )];
}

export interface SessionResolutionContext extends ProtocolCapture {
  attribution?: string;
  request_id?: string;
  event_id?: string;
  agent_name?: string;
  url_path?: string;
}

export function resolveSessionIdentity(
  headers: Record<string, string>, reqData: any, provider: string, model: string,
  context: SessionResolutionContext = {}
): SessionIdentity {
  if (getAgentCategory(context.agent_name) === 'WorkBuddy') {
    const facts = workbuddyAdapter.extract({ ...context, agentName: 'WorkBuddy', body: reqData, headers, capturedAt: '' });
    const decision = workbuddyAdapter.resolve({ facts, native: { status: 'not_required' }, capturedAt: '' });
    const session = decision.session.status === 'resolved' ? decision.session.value : undefined;
    return { id: session || (context.request_id || context.event_id ? `unknown:${context.request_id || context.event_id}` : 'unknown'),
      source: session ? 'workbuddy_metadata' : 'unknown', confidence: session ? 'exact' : 'unknown', thread_id: session,
      turn_id: session && decision.turn.status === 'resolved' ? decision.turn.value.id : undefined, namespace: '' };
  }
  const h = normalizedHeaders(headers);
  const envelopes = identityEnvelopes(reqData);
  const read = (snake: string, camel: string) => firstString(...envelopes.flatMap((o) => [o[snake], o[camel]]));
  // Per-request metadata is authoritative, especially when WebSocket handshake
  // headers are reused across several turns on the same connection.
  const meta = parseMetadata(reqData?.client_metadata?.['x-codex-turn-metadata']) ||
    parseMetadata(h['x-codex-turn-metadata']);
  const antigravity = /antigravity/i.test(context.agent_name || h['user-agent'] || '') ||
    /antigravity/i.test(provider) || /antigravity/i.test(model) || /v1internal.*generatecontent/i.test(context.url_path || '');
  if (antigravity) {
    const session = antigravityFacts(reqData).session;
    return session.status === 'resolved'
      ? { id: session.value, source: 'conversation_id', confidence: 'exact' }
      : { id: `unknown:${context.request_id || context.event_id || 'antigravity'}`, source: 'unknown', confidence: 'unknown' };
  }
  const codex = !antigravity && Boolean(meta || h['x-codex-turn-id'] ||
    /codex/i.test(context.agent_name || h['user-agent'] || ''));
  if (codex) {
    const facts = codexAdapter.extract({ ...context, agentName: context.agent_name || 'Codex', body: reqData, headers,
      capturedAt: '' });
    const decision = codexAdapter.resolve({ facts, native: { status: 'not_required' }, capturedAt: '' });
    const thread = decision.session.status === 'resolved' ? decision.session.value : undefined;
    return { id: thread || (context.request_id || context.event_id ? `unknown:${context.request_id || context.event_id}` : 'unknown'),
      source: thread ? 'codex_metadata' : 'unknown', confidence: thread ? 'exact' : 'unknown',
      thread_id: thread, turn_id: thread && decision.turn.status === 'resolved' ? decision.turn.value.id : undefined, namespace: '' };
  }
  const bodyThread = read('thread_id', 'threadId');
  const bodySession = read('session_id', 'sessionId');
  const headerThread = firstString(h['thread-id'], h['x-thread-id']);
  const headerSession = firstString(h['session-id'], h['x-session-id'], h['x-codex-session-id'],
    h['x-cursor-session-id'], h['x-pi-session-id']);
  const thread = firstString(bodyThread, headerThread);
  const session = firstString(bodySession, headerSession);
  const turn = firstString(read('turn_id', 'turnId'), h['x-codex-turn-id'], h['x-turn-id']);
  const conversation = read('conversation_id', 'conversationId');
  const namespace = firstString(read('session_namespace', 'sessionNamespace'), session);
  const auxiliary = { thread_id: thread, session_id: session, turn_id: turn, namespace };
  const result = (id: string, source: SessionIdentity['source'], confidence: SessionIdentity['confidence'] = 'exact'): SessionIdentity => ({
    id, source, confidence, ...auxiliary
  });

  if (conversation) return result(conversation, 'conversation_id');
  if (bodyThread) return result(thread!, 'thread_id');
  if (h['conversation-id'] || h['x-conversation-id']) {
    return result(firstString(h['conversation-id'], h['x-conversation-id'])!, 'header');
  }
  if (thread) return result(thread, bodyThread ? 'thread_id' : 'header');
  if (session) return result(session, bodySession ? 'session_id' : 'header');

  const requestId = firstString(context.request_id, read('request_id', 'requestId'));
  const eventId = firstString(context.event_id, read('event_id', 'eventId'));
  const unknownId = requestId ? `unknown:${requestId}` : eventId ? `unknown:${eventId}` : 'unknown';
  const cache = read('prompt_cache_key', 'promptCacheKey');
  // Cache keys can be shared by unrelated conversations: preserve the evidence,
  // but isolate these candidates by request/event, even from each other.
  if (cache) return { id: unknownId, source: 'heuristic', confidence: 'heuristic', ...auxiliary, namespace: namespace || cache };
  return { id: unknownId, source: 'unknown', confidence: 'unknown', ...auxiliary };
}

export function resolveRequestParents(headers: Record<string, string>, reqData: any, capture: any = {}): {
  parent_request_id?: string; parent_event_id?: string;
} {
  const h = normalizedHeaders(headers);
  const envelopes = [...identityEnvelopes(reqData), ...identityEnvelopes(parseMetadata(h['x-codex-turn-metadata']))];
  return {
    parent_request_id: firstString(capture.parent_request_id, capture.parentRequestId, h['x-parent-request-id'],
      h['parent-request-id'], ...envelopes.flatMap((o) => [o.parent_request_id, o.parentRequestId])),
    parent_event_id: firstString(capture.parent_event_id, capture.parentEventId, h['x-parent-event-id'],
      h['parent-event-id'], ...envelopes.flatMap((o) => [o.parent_event_id, o.parentEventId]))
  };
}

export function extractUserPromptFromRecord(record: Partial<AuditRecord>): string {
  const reqBodyStr = record.request_body || '';
  if (getAgentCategory(record.agent_name || '') === 'WorkBuddy') {
    try { return (workbuddyUserInput(record.request_headers, JSON.parse(reqBodyStr))?.text || '').slice(0, 4000); }
    catch { return ''; }
  }
  if (reqBodyStr) {
    try {
      const data = JSON.parse(reqBodyStr);
      const reqObj = data.request || data;
      const contents = reqObj.contents || reqObj.messages || [];

      let fallbackHandoff = '';

      for (let i = contents.length - 1; i >= 0; i--) {
        const c = contents[i];
        if (c.role !== 'user') continue;

        const parts = c.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p && p.text) {
              const t: string = p.text;
              // Handle Context Summary compression restart
              if (t.includes('</CONTEXT_SUMMARY>')) {
                const afterSummary = t.split('</CONTEXT_SUMMARY>')[1] || '';
                const m = afterSummary.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                if (m) return m[1].trim();

                const mSec = t.match(/# User Requests\s*([\s\S]*?)(?=\n# |\Z)/);
                if (mSec) {
                  const lines = mSec[1]
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => /^\d+\./.test(l));
                  if (lines.length) {
                    const last = lines[lines.length - 1].replace(/^\d+\.\s*/, '').trim();
                    return `[会话压缩续接] ${last}`;
                  }
                }
                return '[会话历史压缩重启]';
              }

              const m = t.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
              if (m) return m[1].trim();

              if (t.includes('Comments on artifact URI:')) {
                return '[用户审批/评论了产物方案]';
              }
              if (t.includes('<SYSTEM_MESSAGE>')) continue;

              if (
                t.includes('Another language model started to solve this problem') ||
                t.includes('Context Checkpoint Compaction') ||
                t.includes('You are performing a CONTEXT CHECKPOINT COMPACTION')
              ) {
                if (!fallbackHandoff) fallbackHandoff = '[会话压缩续接] 任务接力推进';
                continue;
              }

              const clean = t
                .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, '')
                .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
                .replace(/<[^>]+>/g, '')
                .trim();
              if (clean && !clean.startsWith('[') && !clean.startsWith('{')) {
                return clean.slice(0, 4000);
              }
            }
          }
        } else if (typeof c.content === 'string') {
          const t: string = c.content;
          if (t.includes('</CONTEXT_SUMMARY>')) {
            const afterSummary = t.split('</CONTEXT_SUMMARY>')[1] || '';
            const m = afterSummary.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (m) return m[1].trim();
            const mSec = t.match(/# User Requests\s*([\s\S]*?)(?=\n# |\Z)/);
            if (mSec) {
              const lines = mSec[1]
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => /^\d+\./.test(l));
              if (lines.length) {
                const last = lines[lines.length - 1].replace(/^\d+\.\s*/, '').trim();
                return `[会话压缩续接] ${last}`;
              }
            }
          }
          const m = t.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (m) return m[1].trim();

          if (
            t.includes('Another language model started to solve this problem') ||
            t.includes('Context Checkpoint Compaction') ||
            t.includes('You are performing a CONTEXT CHECKPOINT COMPACTION')
          ) {
            if (!fallbackHandoff) fallbackHandoff = '[会话压缩续接] 任务接力推进';
            continue;
          }

          const clean = t
            .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, '')
            .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
            .replace(/<[^>]+>/g, '')
            .trim();
          if (clean && !clean.startsWith('[') && !clean.startsWith('{')) {
            return clean.slice(0, 4000);
          }
        }
      }

      // Check OpenAI Responses API input (used by Codex)
      if (reqObj.input !== undefined) {
        if (typeof reqObj.input === 'string') {
          const clean = reqObj.input.replace(/<[^>]+>/g, '').trim();
          if (clean && !clean.startsWith('[') && !clean.startsWith('{')) {
            return clean.slice(0, 4000);
          }
        } else if (Array.isArray(reqObj.input)) {
          for (let i = reqObj.input.length - 1; i >= 0; i--) {
            const item = reqObj.input[i];
            if (typeof item === 'string') {
              const clean = item.replace(/<[^>]+>/g, '').trim();
              if (clean) return clean.slice(0, 4000);
            } else if (item && typeof item === 'object') {
              if (
                item.type === 'function_call' ||
                item.type === 'function_call_output' ||
                item.type === 'custom_tool_call' ||
                item.type === 'custom_tool_call_output' ||
                item.type === 'additional_tools'
              ) {
                continue;
              }
              const role = item.role || (item.type === 'message' ? item.role || 'user' : 'user');
              if (role !== 'user') continue;
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

              const mUserReq = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
              if (mUserReq) return mUserReq[1].trim();

              const lower = text.toLowerCase();
              if (
                lower.includes('another language model started to solve this problem') ||
                lower.includes('context checkpoint compaction') ||
                lower.includes('you are performing a context checkpoint compaction')
              ) {
                if (!fallbackHandoff) {
                  const mSummary = text.match(/## Context Checkpoint Compaction[\s\S]*?(?:###\s*\d+\.\s*([^\n]+)|$)/i);
                  if (mSummary && mSummary[1]) {
                    fallbackHandoff = `[会话压缩续接] ${mSummary[1].trim()}`;
                  } else {
                    fallbackHandoff = '[会话压缩续接] 任务接力推进';
                  }
                }
                continue;
              }

              const clean = text
                .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, '')
                .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
                .replace(/<app-context>[\s\S]*?<\/app-context>/gi, '')
                .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, '')
                .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, '')
                .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, '')
                .replace(/<[^>]+>/g, '')
                .trim();

              if (clean && !clean.startsWith('[') && !clean.startsWith('{')) {
                return clean.slice(0, 4000);
              }
            }
          }
        }
      }

      if (fallbackHandoff) return fallbackHandoff;
    } catch {}
  }

  // Fallback to prompt_summary
  const lastText = cleanPromptSummary(record.prompt_summary || '');
  if (lastText) {
    const m = lastText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
    if (m) return m[1].trim();
    const markers = ['functionResponse', 'tool_result', '[Tool Result', '[Tool Call', 'diff --git', 'File Path:', 'Created At:', '上下文更新（不生成回复）', '网页抓取（'];
    if (!markers.some((mk) => lastText.includes(mk))) {
      if (!lastText.startsWith('[') && !lastText.startsWith('{')) {
        return lastText.slice(0, 4000);
      }
    }
  }

  return '';
}

export function extractHistoryAndInjectionsChars(reqObj: any): { historyChars: number; historySnippet: string } {
  let historyChars = 0;
  const snippets: string[] = [];

  if (!reqObj || typeof reqObj !== 'object') {
    return { historyChars: 0, historySnippet: '(本轮为首轮对话，无历史上下文)' };
  }

  // 1. Gemini format: reqObj.contents
  if (Array.isArray(reqObj.contents)) {
    const contents = reqObj.contents;
    if (contents.length > 1) {
      for (let i = 0; i < contents.length - 1; i++) {
        const item = contents[i];
        if (!item) continue;
        const parts = item.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (!p) continue;
            if (typeof p.text === 'string') {
              historyChars += p.text.length;
              if (snippets.length < 3 && p.text.trim()) snippets.push(p.text.trim().slice(0, 300));
            }
            if (p.functionCall) {
              const str = JSON.stringify(p.functionCall);
              historyChars += str.length;
              if (snippets.length < 3) snippets.push(`[Tool Call: ${p.functionCall.name || 'unknown'}]`);
            }
            if (p.functionResponse) {
              const str = JSON.stringify(p.functionResponse);
              historyChars += str.length;
              if (snippets.length < 3) snippets.push(`[Tool Response: ${p.functionResponse.name || 'unknown'}]`);
            }
          }
        }
      }
    }

    // Check last turn for injected tool responses (e.g. current turn trigger is a tool result)
    if (contents.length >= 1) {
      const lastTurn = contents[contents.length - 1];
      if (lastTurn && Array.isArray(lastTurn.parts)) {
        for (const p of lastTurn.parts) {
          if (!p) continue;
          if (p.functionResponse) {
            const str = JSON.stringify(p.functionResponse);
            historyChars += str.length;
            if (snippets.length < 3) snippets.push(`[Current Tool Response: ${p.functionResponse.name || 'unknown'}]`);
          }
        }
      }
    }
  }

  // 2. Anthropic & OpenAI Chat format: reqObj.messages
  else if (Array.isArray(reqObj.messages)) {
    const messages = reqObj.messages;
    if (messages.length > 1) {
      for (let i = 0; i < messages.length - 1; i++) {
        const m = messages[i];
        if (!m) continue;
        // Skip leading system/developer prompt as they are counted in system_persona
        if (m.role === 'system' || m.role === 'developer') continue;

        if (typeof m.content === 'string') {
          historyChars += m.content.length;
          if (snippets.length < 3 && m.content.trim()) snippets.push(m.content.trim().slice(0, 300));
        } else if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (!c) continue;
            if (typeof c === 'string') {
              historyChars += c.length;
            } else if (typeof c.text === 'string') {
              historyChars += c.text.length;
              if (snippets.length < 3 && c.text.trim()) snippets.push(c.text.trim().slice(0, 300));
            } else if (c.type === 'tool_result' || c.type === 'tool_use') {
              const str = typeof c.content === 'string' ? c.content : JSON.stringify(c);
              historyChars += str.length;
              if (snippets.length < 3) snippets.push(`[${c.type}: ${c.name || c.tool_use_id || ''}]`);
            } else {
              historyChars += JSON.stringify(c).length;
            }
          }
        }
        if (m.tool_calls && Array.isArray(m.tool_calls)) {
          historyChars += JSON.stringify(m.tool_calls).length;
        }
      }
    }

    // Check last message for tool results
    if (messages.length >= 1) {
      const last = messages[messages.length - 1];
      if (last) {
        if (last.role === 'tool') {
          const str = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
          historyChars += str.length;
          if (snippets.length < 3) snippets.push(`[Tool Result: ${last.tool_call_id || ''}]`);
        } else if (Array.isArray(last.content)) {
          for (const c of last.content) {
            if (c && c.type === 'tool_result') {
              const str = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
              historyChars += str.length;
              if (snippets.length < 3) snippets.push(`[Tool Result: ${c.tool_use_id || ''}]`);
            }
          }
        }
      }
    }
  }

  // 3. OpenAI Responses API (Codex): reqObj.input
  else if (Array.isArray(reqObj.input)) {
    const input = reqObj.input;
    if (input.length > 1) {
      for (let i = 0; i < input.length - 1; i++) {
        const item = input[i];
        if (!item) continue;
        if (item.role === 'developer' || item.role === 'system' || item.type === 'additional_tools') continue;

        if (typeof item === 'string') {
          historyChars += item.length;
        } else if (typeof item === 'object') {
          if (item.type === 'message' || !item.type) {
            if (typeof item.content === 'string') {
              historyChars += item.content.length;
              if (snippets.length < 3 && item.content.trim()) snippets.push(item.content.trim().slice(0, 300));
            } else if (Array.isArray(item.content)) {
              for (const c of item.content) {
                if (typeof c === 'string') historyChars += c.length;
                else if (c && c.text) historyChars += c.text.length;
              }
            }
          } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            historyChars += JSON.stringify(item).length;
          } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
            const outStr = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '');
            historyChars += outStr.length;
            if (snippets.length < 3) snippets.push(`[Codex Output: ${item.call_id || ''}]`);
          }
        }
      }
    }

    if (input.length >= 1) {
      const last = input[input.length - 1];
      if (last && typeof last === 'object') {
        if (last.type === 'function_call_output' || last.type === 'custom_tool_call_output') {
          const outStr = typeof last.output === 'string' ? last.output : JSON.stringify(last.output || '');
          historyChars += outStr.length;
          if (snippets.length < 3) snippets.push(`[Codex Output: ${last.call_id || ''}]`);
        }
      }
    }
  }

  return {
    historyChars,
    historySnippet: snippets.length
      ? snippets.join('\n---\n').slice(0, 4000)
      : historyChars === 0
        ? '(本轮为首轮对话，无历史上下文)'
        : '(前序轮次交互或工具执行结果)'
  };
}

export function dissectPromptAnatomy(record: Partial<AuditRecord>): PromptAnatomy {
  const systemPrompt = record.system_prompt || '';
  const reqBodyStr = record.request_body || '';
  const totalInputTokens = record.input_tokens || 0;

  let data: any = {};
  try {
    data = reqBodyStr ? JSON.parse(reqBodyStr) : {};
  } catch {}

  const reqObj = data.request || data;

  // A historical v2 tool continuation does not establish a new current user input.
  // Preserve the earlier message in request history rather than promoting it into this request's intent.
  const legacyV2ToolContinuation = record.provider === 'unknown' && record.capture_status === 'complete' &&
    /^\/v2\/chat\/completions(?:\?.*)?$/i.test(record.url_path || '') &&
    Array.isArray(data.messages) && data.messages.at(-1)?.role === 'tool';
  // 1. Extract raw user prompt
  let userPrompt = record.user_prompt || (legacyV2ToolContinuation ? '' : extractUserPromptFromRecord(record));
  if (!userPrompt) {
    userPrompt = getAgentCategory(record.agent_name || '') === 'WorkBuddy'
      ? '(未识别用户输入)'
      : cleanPromptSummary(record.prompt_summary || '') || '(内部调用或工具反馈)';
  }

  const userChars = Math.max(1, userPrompt.length);

  // 2. Extract tools definitions
  let tools = reqObj.tools || data.tools || [];
  if ((!tools || !tools.length) && Array.isArray(reqObj.input)) {
    for (const item of reqObj.input) {
      if (item && item.type === 'additional_tools' && Array.isArray(item.tools)) {
        tools = item.tools;
        break;
      }
    }
  }
  const toolsStr = tools.length ? JSON.stringify(tools) : '';
  const toolsChars = toolsStr.length;

  const countTools = (items: any[]): number => {
    let count = 0;
    for (const t of items) {
      if (!t || typeof t !== 'object') continue;
      if (t.functionDeclarations && Array.isArray(t.functionDeclarations)) {
        count += t.functionDeclarations.length;
      } else if (t.tools && Array.isArray(t.tools)) {
        count += countTools(t.tools);
      } else {
        count += 1;
      }
    }
    return count;
  };
  const toolDeclarationsCount = Array.isArray(tools) ? countTools(tools) : 0;

  // 3. System persona & workspace rules
  let coreSystem = systemPrompt || '';
  if (!coreSystem.trim() && Array.isArray(reqObj.input)) {
    const devTexts: string[] = [];
    for (const item of reqObj.input) {
      if (item && (item.role === 'developer' || item.role === 'system')) {
        if (typeof item.content === 'string') devTexts.push(item.content);
        else if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c && typeof c === 'object' && c.text) devTexts.push(c.text);
          }
        }
      }
    }
    if (devTexts.length) coreSystem = devTexts.join('\n\n');
  }

  let workspaceChars = 0;
  const extracted: string[] = [];

  const mInfo = coreSystem.match(/(<user_information>[\s\S]*?<\/user_information>|<environment_context>[\s\S]*?<\/environment_context>)/i);
  const mRules = coreSystem.match(/(<user_rules>[\s\S]*?<\/user_rules>|<permissions\s+instructions>[\s\S]*?<\/permissions\s+instructions>)/i);
  const mSkills = coreSystem.match(/(<skills>[\s\S]*?<\/skills>|<skills_instructions>[\s\S]*?<\/skills_instructions>|<app-context>[\s\S]*?<\/app-context>)/i);

  if (mInfo) extracted.push(mInfo[1]);
  if (mRules) extracted.push(mRules[1]);
  if (mSkills) extracted.push(mSkills[1]);

  let workspaceInfo = '';
  if (extracted.length) {
    workspaceInfo = extracted.join('\n\n');
    workspaceChars = workspaceInfo.length;
    for (const ext of extracted) {
      coreSystem = coreSystem.replace(ext, '');
    }
  }

  const systemChars = Math.max(0, coreSystem.trim().length);

  // 4. History & Injections (calculated from AST instead of raw string length subtraction)
  const { historyChars, historySnippet } = extractHistoryAndInjectionsChars(reqObj);
  const totalEffectiveChars = Math.max(1, userChars + toolsChars + systemChars + workspaceChars + historyChars);

  const bloatMultiplier = Number((totalEffectiveChars / userChars).toFixed(1));

  const layers: PromptLayer[] = [
    {
      id: 'user_query',
      name: '用户真实原话 (User Intent)',
      chars: userChars,
      percentage: Number(((userChars / totalEffectiveChars) * 100).toFixed(2)),
      content: userPrompt,
      badge_color: 'emerald',
      description: '你在聊天框中亲手敲下的原始提问或指令'
    },
    {
      id: 'system_persona',
      name: '核心人设与指引 (System Persona)',
      chars: systemChars,
      percentage: Number(((systemChars / totalEffectiveChars) * 100).toFixed(2)),
      content: coreSystem.trim().slice(0, 4000),
      badge_color: 'amber',
      description: 'Agent 固化的角色设定、行为约束、规划准则'
    },
    {
      id: 'tool_schemas',
      name: '工具库元数据定义 (Tool Schemas)',
      chars: toolsChars,
      percentage: Number(((toolsChars / totalEffectiveChars) * 100).toFixed(2)),
      content: toolsStr.slice(0, 4000),
      tool_count: toolDeclarationsCount,
      badge_color: 'cyan',
      description: `注入的 ${toolDeclarationsCount} 个可用工具的 JSON Schema 定义`
    },
    {
      id: 'workspace_context',
      name: '工作空间与系统规则 (Workspace Context)',
      chars: workspaceChars,
      percentage: Number(((workspaceChars / totalEffectiveChars) * 100).toFixed(2)),
      content: workspaceInfo.trim().slice(0, 4000),
      badge_color: 'blue',
      description: 'Agent 自动嗅探注入的系统环境、项目路径、自定义技能'
    },
    {
      id: 'history_artifacts',
      name: '多轮历史与工具执行结果 (History & Injections)',
      chars: historyChars,
      percentage: Number(((historyChars / totalEffectiveChars) * 100).toFixed(2)),
      content: historySnippet,
      badge_color: 'purple',
      description: '以往所有轮次的问答记录、文件读取与命令执行反馈'
    }
  ];

  return {
    user_prompt: userPrompt,
    total_chars: totalEffectiveChars,
    total_input_tokens: totalInputTokens,
    bloat_multiplier: bloatMultiplier,
    layers
  };
}

export function isSubagentRecord(r: Partial<AuditRecord>): boolean {
  if (r.is_subagent === 1) return true;
  if (r.subagent_type && r.subagent_type !== '') return true;

  const agent = (r.agent_name || '').toLowerCase();
  if (
    agent.includes('subagent') ||
    agent.includes('websearch') ||
    agent.includes('worker') ||
    agent.includes('tool-runner') ||
    agent.includes('searchbot')
  ) {
    return true;
  }

  const sys = (r.system_prompt || '').toLowerCase();
  if (
    sys.includes('search engine bot') ||
    sys.includes('you are a subagent') ||
    sys.includes('you are an autonomous research agent') ||
    sys.includes('you are an assistant to the primary agent') ||
    sys.includes('helper agent')
  ) {
    return true;
  }

  const reqBody = (r.request_body || '').toLowerCase();
  if (
    reqBody.includes('"requesttype":"web_search"') ||
    reqBody.includes('"requesttype": "web_search"') ||
    reqBody.includes('"subagent"') ||
    reqBody.includes('"role":"subagent"')
  ) {
    return true;
  }

  return false;
}

function aggregationSessionKey(record: Partial<AuditRecord>, fallback: string): string {
  if (record.session_id && record.session_id !== 'unknown') return record.session_id;
  if (record.request_id) return `unknown:${record.request_id}`;
  if (record.event_id) return `unknown:${record.event_id}`;
  return `unknown:record:${record.id && record.id > 0 ? record.id : fallback}`;
}

export function clusterRecordsIntoTasks(records: AuditRecord[]): TaskCluster[] {
  // 1. Separate main records from subagent records
  const mainRecords: AuditRecord[] = [];
  const subagentRecords: AuditRecord[] = [];

  for (const r of records) {
    if (isWebFetchRequest(r.url_path)) continue;
    if (isSubagentRecord(r)) {
      subagentRecords.push(r);
    } else {
      mainRecords.push(r);
    }
  }

  // 2. Group main records strictly by session_id first to prevent cross-session pollution
  const sessionMap = new Map<string, AuditRecord[]>();
  for (let index = 0; index < mainRecords.length; index++) {
    const r = mainRecords[index];
    const sid = aggregationSessionKey(r, String(index));
    const key = JSON.stringify([sid, getAgentCategory(r.agent_name)]);
    if (!sessionMap.has(key)) sessionMap.set(key, []);
    sessionMap.get(key)!.push(r);
  }

  const allTasks: TaskCluster[] = [];
  // Keep an index of all turns across all tasks with metadata for topological matching
  const allTurnsIndex: {
    turn: TaskTurn;
    task: TaskCluster;
    recordId: number;
    createdAtMs: number;
    agentName: string;
    provider: string;
    hasToolCall: boolean;
    sessionId?: string;
    threadId?: string;
    sessionNamespace?: string;
    requestId?: string;
    eventId?: string;
    parentEventId?: string;
  }[] = [];

  for (const sessRecs of sessionMap.values()) {
    const sessionId = aggregationSessionKey(sessRecs[0], String(records.indexOf(sessRecs[0])));
    const sortedRecs = [...sessRecs].sort((a, b) => (a.id || 0) - (b.id || 0));
    let currentTask: TaskCluster | null = null;
    let previousRecord: AuditRecord | null = null;

    for (const r of sortedRecs) {
      const rid = r.id || 0;
      const summary = cleanPromptSummary(r.prompt_summary || '');
      const userPrompt = r.user_prompt || extractUserPromptFromRecord(r);

      const resPrev = r.response_preview || '';
      const hasToolCall = Boolean(resPrev.includes('[Tool Call]') || (r.tool_calls_json && r.tool_calls_json !== '[]'));

      let turnType: 'thought_and_action' | 'final_answer' | 'error' = 'final_answer';
      if (!isSuccessfulCapture(r.status_code, r.capture_status)) {
        turnType = 'error';
      } else if (hasToolCall) {
        turnType = 'thought_and_action';
      }

      const previousHasToolCall = Boolean(
        previousRecord &&
        ((previousRecord.response_preview || '').includes('[Tool Call]') ||
          (previousRecord.tool_calls_json && previousRecord.tool_calls_json !== '[]'))
      );
      const previousCompleted = Boolean(
        previousRecord && isSuccessfulCapture(previousRecord.status_code, previousRecord.capture_status) && !previousHasToolCall &&
        ((previousRecord.response_text && previousRecord.response_text.trim()) ||
          /^(stop|completed|complete|end)$/i.test(previousRecord.finish_reason || ''))
      );
      const requestBoundary = Boolean(
        previousRecord && currentTask && r.request_id && previousRecord.request_id &&
        r.request_id !== previousRecord.request_id && previousCompleted
      );
      const newTurnBoundary = Boolean(
        previousRecord && currentTask &&
        ((Boolean(r.turn_id || previousRecord.turn_id) && r.turn_id !== previousRecord.turn_id) ||
          requestBoundary ||
          (Boolean(r.parent_request_id || previousRecord.parent_request_id) && r.parent_request_id !== previousRecord.parent_request_id) ||
          (!r.turn_id && !previousRecord.turn_id && !r.request_id && !previousRecord.request_id &&
            userPrompt && userPrompt === (previousRecord.user_prompt || extractUserPromptFromRecord(previousRecord)) &&
            previousCompleted))
      );
      if (userPrompt && (!currentTask || currentTask.user_prompt !== userPrompt || newTurnBoundary)) {
        if (currentTask) {
          finalizeTask(currentTask);
          allTasks.push(currentTask);
        }
        currentTask = {
          id: `task_${sessionId}_${rid}`,
          session_id: sessionId,
          session_id_source: r.session_id_source,
          session_confidence: r.session_confidence,
          session_namespace: r.session_namespace,
          thread_id: r.thread_id,
          user_prompt: userPrompt,
          created_at: r.created_at || new Date().toISOString(),
          model: r.model || 'unknown',
          agent_name: r.agent_name || 'Agent',
          turns: [],
          turns_count: 0,
          total_duration_ms: 0,
          total_input_tokens: 0,
          total_cached_tokens: 0,
          total_thinking_tokens: 0,
          total_output_tokens: 0,
          is_completed: false,
          cache_ratio: 0
        };
      }

      if (!currentTask) {
        currentTask = {
          id: `task_${sessionId}_${rid}`,
          session_id: sessionId,
          session_id_source: r.session_id_source,
          session_confidence: r.session_confidence,
          session_namespace: r.session_namespace,
          thread_id: r.thread_id,
          user_prompt: userPrompt || summary || `Task #${rid}`,
          created_at: r.created_at || new Date().toISOString(),
          model: r.model || 'unknown',
          agent_name: r.agent_name || 'Agent',
          turns: [],
          turns_count: 0,
          total_duration_ms: 0,
          total_input_tokens: 0,
          total_cached_tokens: 0,
          total_thinking_tokens: 0,
          total_output_tokens: 0,
          is_completed: false,
          cache_ratio: 0
        };
      }

      const turnObj: TaskTurn = {
        record_id: rid,
        token_source: r.token_source,
        turn_index: currentTask.turns.length + 1,
        turn_type: turnType,
        status_code: r.status_code,
        duration_ms: r.duration_ms || 0,
        input_tokens: r.input_tokens || 0,
        cached_tokens: r.cached_tokens || 0,
        thinking_tokens: r.thinking_tokens || 0,
        output_tokens: r.output_tokens || 0,
        summary,
        response_preview: resPrev,
        subagents: []
      };

      currentTask.turns.push(turnObj);

      const createdAtMs = toTimestampMs(r.created_at);
      allTurnsIndex.push({
        turn: turnObj,
        task: currentTask,
        recordId: rid,
        createdAtMs,
        agentName: r.agent_name || '',
        provider: r.provider || '',
        hasToolCall,
        sessionId: r.session_id,
        threadId: r.thread_id,
        sessionNamespace: r.session_namespace,
        requestId: r.request_id,
        eventId: r.event_id,
        parentEventId: r.parent_event_id
      });
      previousRecord = r;
    }

    if (currentTask) {
      finalizeTask(currentTask);
      allTasks.push(currentTask);
    }
  }

  // 3. Topologically link subagent records into the nearest preceding parent turn (Plan B)
  const orphanSubagents: AuditRecord[] = [];
  allTurnsIndex.sort((a, b) => a.recordId - b.recordId);

  for (const sub of subagentRecords) {
    const subId = sub.id || 0;
    const subTime = toTimestampMs(sub.created_at);
    const subAgentBase = (sub.agent_name || '').split(' ')[0].toLowerCase();

    // Find preceding candidate turns (recordId < subId)
    const hasExplicitParent = Boolean(sub.parent_request_id || (sub as any).parent_event_id);
    const hasIdentity = Boolean(
      hasExplicitParent ||
      (sub.session_id && sub.session_id !== 'unknown') ||
      sub.thread_id ||
      sub.session_namespace
    );
    const candidates = hasIdentity ? allTurnsIndex.filter((t) => {
      if (t.recordId >= subId) return false;
      if (sub.session_id && sub.session_id !== 'unknown' && sub.session_id !== t.sessionId) return false;
      if (sub.thread_id && sub.thread_id !== t.threadId) return false;
      if (sub.session_namespace && sub.session_namespace !== t.sessionNamespace) return false;
      if (sub.parent_request_id && sub.parent_request_id !== t.requestId) return false;
      if (sub.parent_event_id && sub.parent_event_id !== t.eventId) return false;
      return true;
    }) : [];
    let bestMatch: (typeof allTurnsIndex)[0] | null = null;

    if (candidates.length > 0) {
      if (hasExplicitParent) {
        bestMatch = candidates[candidates.length - 1];
      }
      // Priority 1: Candidate in same agent family with tool call within 5 mins (300s)
      for (let i = candidates.length - 1; i >= 0 && !bestMatch; i--) {
        const c = candidates[i];
        const cAgentBase = c.agentName.split(' ')[0].toLowerCase();
        const timeDiff = subTime && c.createdAtMs ? subTime - c.createdAtMs : (subId - c.recordId) * 1000;
        const isTimeReasonable = timeDiff >= 0 && timeDiff <= 300000;

        if (cAgentBase === subAgentBase && isTimeReasonable) {
          if (c.hasToolCall) {
            bestMatch = c;
            break;
          }
          if (!bestMatch) {
            bestMatch = c;
          }
        }
      }

      // Priority 2: Fallback to the latest candidate turn within 60s
      if (!bestMatch && !sub.parent_request_id) {
        const latest = candidates[candidates.length - 1];
        const timeDiff = subTime && latest.createdAtMs ? subTime - latest.createdAtMs : (subId - latest.recordId) * 1000;
        if (timeDiff >= 0 && timeDiff <= 60000) {
          bestMatch = latest;
        }
      }
    }

    if (bestMatch) {
      if (!bestMatch.turn.subagents) bestMatch.turn.subagents = [];
      bestMatch.turn.subagents.push({
        record_id: subId,
        subagent_type: sub.subagent_type || (sub.agent_name?.includes('WebSearch') ? 'web_search' : 'subagent'),
        agent_name: sub.agent_name || 'SubAgent',
        model: sub.model || 'unknown',
        duration_ms: sub.duration_ms || 0,
        input_tokens: sub.input_tokens || 0,
        output_tokens: sub.output_tokens || 0,
        user_prompt: sub.user_prompt || extractUserPromptFromRecord(sub),
        response_preview: sub.response_preview || '',
        response_text: sub.response_text || '',
        created_at: sub.created_at || '',
        status_code: sub.status_code || 200
      });
    } else {
      orphanSubagents.push(sub);
    }
  }

  // 4. Any orphaned subagents without a parent task are gracefully kept as standalone tasks
  if (orphanSubagents.length > 0) {
    const orphanSessionMap = new Map<string, AuditRecord[]>();
    for (let index = 0; index < orphanSubagents.length; index++) {
      const r = orphanSubagents[index];
      const sid = aggregationSessionKey(r, `orphan-${index}`);
      if (!orphanSessionMap.has(sid)) orphanSessionMap.set(sid, []);
      orphanSessionMap.get(sid)!.push(r);
    }
    for (const [sessionId, sessRecs] of orphanSessionMap.entries()) {
      const sortedRecs = [...sessRecs].sort((a, b) => (a.id || 0) - (b.id || 0));
      let orphanTask: TaskCluster | null = null;
      for (const r of sortedRecs) {
        const rid = r.id || 0;
        const summary = cleanPromptSummary(r.prompt_summary || '');
        const userPrompt = r.user_prompt || extractUserPromptFromRecord(r);
        if (!orphanTask) {
          orphanTask = {
            id: `task_${sessionId}_${rid}`,
            session_id: sessionId,
            session_id_source: r.session_id_source,
            session_confidence: r.session_confidence,
            session_namespace: r.session_namespace,
            thread_id: r.thread_id,
            user_prompt: userPrompt || summary || `SubAgent Task #${rid}`,
            created_at: r.created_at || new Date().toISOString(),
            model: r.model || 'unknown',
            agent_name: r.agent_name || 'SubAgent',
            turns: [],
            turns_count: 0,
            total_duration_ms: 0,
            total_input_tokens: 0,
            total_cached_tokens: 0,
            total_thinking_tokens: 0,
            total_output_tokens: 0,
            is_completed: false,
            cache_ratio: 0
          };
        }
        orphanTask.turns.push({
          record_id: rid,
        token_source: r.token_source,
          turn_index: orphanTask.turns.length + 1,
          turn_type: 'final_answer',
          status_code: r.status_code,
          duration_ms: r.duration_ms || 0,
          input_tokens: r.input_tokens || 0,
          cached_tokens: r.cached_tokens || 0,
          thinking_tokens: r.thinking_tokens || 0,
          output_tokens: r.output_tokens || 0,
          summary,
          response_preview: r.response_preview || '',
          subagents: []
        });
      }
      if (orphanTask) {
        finalizeTask(orphanTask);
        allTasks.push(orphanTask);
      }
    }
  }

  // Sort tasks chronologically by creation time descending (newest first)
  return allTasks.sort((a, b) => {
    const timeA = toTimestampMs(a.created_at);
    const timeB = toTimestampMs(b.created_at);
    return timeB - timeA;
  });
}

function toTimestampMs(ts?: string | null): number {
  if (!ts) return 0;
  const str = String(ts).trim();
  if (!str) return 0;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) {
    const isoStr = str.replace(' ', 'T') + 'Z';
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function finalizeTask(task: TaskCluster): void {
  task.turns_count = task.turns.length;
  task.total_duration_ms = task.turns.reduce((acc, t) => acc + t.duration_ms, 0);
  task.total_input_tokens = task.turns.reduce((acc, t) => acc + t.input_tokens, 0);
  task.total_cached_tokens = task.turns.reduce((acc, t) => acc + t.cached_tokens, 0);
  task.total_thinking_tokens = task.turns.reduce((acc, t) => acc + t.thinking_tokens, 0);
  task.total_output_tokens = task.turns.reduce((acc, t) => acc + t.output_tokens, 0);

  if (task.total_input_tokens > 0 && task.total_cached_tokens > 0) {
    task.cache_ratio = Number(((task.total_cached_tokens / task.total_input_tokens) * 100).toFixed(1));
  } else {
    task.cache_ratio = 0.0;
  }

  const lastTurn = task.turns[task.turns.length - 1];
  task.is_completed = lastTurn?.turn_type === 'final_answer';
}

export function clusterTasksIntoSessions(tasks: TaskCluster[]): SessionCluster[] {
  const sessionMap = new Map<string, SessionCluster>();
  const confidenceRank = (value: string) => value === 'exact' ? 3 : value === 'heuristic' ? 2 : 1;
  for (const task of tasks) {
    const sessionId = task.session_id || `unknown:task:${task.id}`;
    // A raw provider session id is not globally unique. Keep different Agent
    // families separate so one family cannot hide another in the sidebar.
    const agentCategory = getAgentCategory(task.agent_name);
    const groupKey = `${sessionId}\u001f${agentCategory}\u001f${task.session_namespace || ''}`;
    let session = sessionMap.get(groupKey);
    if (!session) {
      const confidence = task.session_confidence || 'unknown';
      session = {
        id: `session:${sessionId}:${agentCategory}${task.session_namespace ? ':' + task.session_namespace : ''}`,
        session_id: sessionId,
        session_id_source: task.session_id_source || (sessionId.startsWith('unknown:') ? 'unknown' : 'legacy'),
        session_confidence: confidence,
        session_namespace: task.session_namespace,
        thread_id: task.thread_id,
        agent_name: task.agent_name || 'Agent',
        model: task.model || 'unknown',
        created_at: task.created_at,
        updated_at: task.created_at,
        tasks: [],
        tasks_count: 0,
        turns_count: 0,
        total_duration_ms: 0,
        total_input_tokens: 0,
        total_cached_tokens: 0,
        total_thinking_tokens: 0,
        total_output_tokens: 0,
        cache_ratio: 0
      };
      sessionMap.set(groupKey, session);
    }
    if (confidenceRank(task.session_confidence || 'unknown') > confidenceRank(session.session_confidence)) {
      session.session_confidence = task.session_confidence || session.session_confidence;
      session.session_id_source = task.session_id_source || session.session_id_source;
    }
    if (!session.session_namespace && task.session_namespace) session.session_namespace = task.session_namespace;
    if (!session.thread_id && task.thread_id) session.thread_id = task.thread_id;
    session.tasks.push(task);
    session.created_at = toTimestampMs(task.created_at) < toTimestampMs(session.created_at) ? task.created_at : session.created_at;
    session.updated_at = toTimestampMs(task.created_at) > toTimestampMs(session.updated_at) ? task.created_at : session.updated_at;
    session.turns_count += task.turns_count;
    session.total_duration_ms += task.total_duration_ms;
    session.total_input_tokens += task.total_input_tokens;
    session.total_cached_tokens += task.total_cached_tokens;
    session.total_thinking_tokens += task.total_thinking_tokens;
    session.total_output_tokens += task.total_output_tokens;
  }
  for (const session of sessionMap.values()) {
    session.tasks.sort((a, b) => toTimestampMs(b.created_at) - toTimestampMs(a.created_at));
    session.tasks_count = session.tasks.length;
    session.cache_ratio = session.total_input_tokens > 0
      ? Number(((session.total_cached_tokens / session.total_input_tokens) * 100).toFixed(1))
      : 0;
  }
  return [...sessionMap.values()].sort((a, b) => toTimestampMs(b.updated_at) - toTimestampMs(a.updated_at));
}

export function clusterRecordsIntoSessions(records: AuditRecord[]): SessionCluster[] {
  return clusterTasksIntoSessions(clusterRecordsIntoTasks(records));
}

export function paginateSessions(
  allSessions: SessionCluster[], options?: { limit?: number; offset?: number }
): PaginatedSessions {
  const total = allSessions.length;
  const offset = Math.max(0, options?.offset || 0);
  const limit = Math.max(1, options?.limit || 50);
  const sessions = allSessions.slice(offset, offset + limit);
  return { sessions, total, offset, limit, has_more: offset + sessions.length < total };
}

interface IncrementalClusterState {
  version: number;
  lastMaxId: number;
  storageInstance: any;
  allTasks: TaskCluster[];
}

let incrementalClusterState: IncrementalClusterState | null = null;
let sessionClusterCache: { storage: any; version: number; tasks: TaskCluster[]; sessions: SessionCluster[] } | null = null;

export function clearTaskClustersCache(): void {
  incrementalClusterState = null;
  sessionClusterCache = null;
}

export function getCachedTaskClusters(storage: any): TaskCluster[] {
  const currentVersion = typeof storage?.getDataVersion === 'function' ? storage.getDataVersion() : -1;
  // 1. 版本未变，0ms 极速命中
  if (
    currentVersion !== -1 &&
    incrementalClusterState &&
    incrementalClusterState.version === currentVersion &&
    incrementalClusterState.storageInstance === storage &&
    incrementalClusterState.allTasks.length > 0
  ) {
    return incrementalClusterState.allTasks;
  }

  // 2. 尝试增量更新：如果已有状态且仅有新增记录，仅聚合受影响的活跃会话
  if (
    incrementalClusterState &&
    incrementalClusterState.storageInstance === storage &&
    incrementalClusterState.lastMaxId > 0 &&
    typeof storage.getRecords === 'function'
  ) {
    const newRecords = storage.getRecords({
      limit: -1,
      lightweight: true,
      sinceId: incrementalClusterState.lastMaxId,
      order: 'ASC'
    });

    if (newRecords && newRecords.length > 0) {
      const affectedSessionIds = new Set<string>();
      let newMaxId = incrementalClusterState.lastMaxId;
      for (const r of newRecords) {
        if (r.id && r.id > newMaxId) newMaxId = r.id;
        affectedSessionIds.add(aggregationSessionKey(r, 'unidentified'));
      }

      // 仅查询受影响 session 的记录进行局部聚合。老记录可能仍为空 session_id，
      // 这时按 record_id 读取，避免把历史 unknown 记录塞回一个默认桶。
      const affectedRecords: AuditRecord[] = [];
      const seenIds = new Set<number>();
      for (const r of newRecords) {
        if ((!r.session_id || r.session_id === 'unknown') && r.id && typeof storage.getRecordById === 'function') {
          const full = storage.getRecordById(r.id);
          if (full && !seenIds.has(r.id)) { affectedRecords.push(full); seenIds.add(r.id); }
        }
      }
      for (const sid of affectedSessionIds) {
        const sessRecs = storage.getRecords({ limit: -1, lightweight: true, sessionId: sid, order: 'ASC' });
        for (const record of sessRecs || []) {
          if (record.id && !seenIds.has(record.id)) { affectedRecords.push(record); seenIds.add(record.id); }
        }
      }

      const affectedTasks = clusterRecordsIntoTasks(affectedRecords);

      // 从全局任务中移除受影响 session 的旧任务，并合并局部新任务
      const unaffectedTasks = incrementalClusterState.allTasks.filter(
        (t) => !affectedSessionIds.has(t.session_id || 'unknown')
      );

      const mergedTasks = [...unaffectedTasks, ...affectedTasks].sort((a, b) => {
        const timeA = toTimestampMs(b.created_at);
        const timeB = toTimestampMs(a.created_at);
        return timeA - timeB;
      });

      incrementalClusterState.version = currentVersion;
      incrementalClusterState.lastMaxId = newMaxId;
      incrementalClusterState.allTasks = mergedTasks;
      return mergedTasks;
    }
  }

  // 3. 全量冷启动或数据删除后的安全全量聚合
  const records = storage.getRecords({ limit: -1, lightweight: true });
  const tasks = clusterRecordsIntoTasks(records);
  let maxId = 0;
  for (const r of records) {
    if (r.id && r.id > maxId) maxId = r.id;
  }

  incrementalClusterState = {
    version: currentVersion,
    lastMaxId: maxId,
    storageInstance: storage,
    allTasks: tasks
  };

  return tasks;
}

export function getCachedSessionClusters(storage: any): SessionCluster[] {
  const tasks = getCachedTaskClusters(storage);
  const version = typeof storage?.getDataVersion === 'function' ? storage.getDataVersion() : -1;
  if (sessionClusterCache && sessionClusterCache.storage === storage && sessionClusterCache.version === version && sessionClusterCache.tasks === tasks) {
    return sessionClusterCache.sessions;
  }
  const sessions = clusterTasksIntoSessions(tasks);
  sessionClusterCache = { storage, version, tasks, sessions };
  return sessions;
}
