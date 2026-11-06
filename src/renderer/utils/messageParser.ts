import type { ChatTimelineTurn, RecordDetail, Session, ToolCallItem, ToolResultItem } from '../types';
import { socketMessages } from '../../shared/communication';
import {
  cleanPromptSummary,
  extractMsgText,
  extractTailDiffAndHistory,
  extractToolResultSummaryNames,
  getMessagesFromRequestBody,
  parseRequestTurnPayload
} from '../../shared/protocol';
import { prettyJson } from './formatters';

export { cleanPromptSummary, extractMsgText, extractTailDiffAndHistory, getMessagesFromRequestBody, parseRequestTurnPayload };

export function deduplicateDoubledText(str: string): string {
  if (!str || str.length < 4) return str;
  const len = str.length;
  if (len % 2 === 0) {
    const halfLen = len / 2;
    if (str.slice(0, halfLen) === str.slice(halfLen)) {
      return str.slice(0, halfLen);
    }
  }
  return str;
}

export function parseModelResponse(rec: any): { text: string; thinking: string; toolCalls: ToolCallItem[] } {
  if (!rec) return { text: '', thinking: '', toolCalls: [] };
  if (rec.body_format === 'ws-messages-v1') {
    let tools: ToolCallItem[] = [];
    try { tools = JSON.parse(rec.tool_calls_json || '[]').map((tool: any) => {
      let args = tool.args; if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
      return { ...tool, args };
    }); } catch {}
    return { text: rec.response_text || rec.response_preview || '', thinking: rec.thinking_text || '', toolCalls: tools };
  }
  let text = '';
  let thinking = '';
  const toolCalls: ToolCallItem[] = [];
  const streamTools = new Map<string, { id: string; name: string; args: string }>();

  // 1. First priority: Check if backend storage already parsed tool_calls_json
  let hasValidDbTools = false;
  if (rec.tool_calls_json) {
    try {
      const parsedTools = JSON.parse(rec.tool_calls_json);
      if (Array.isArray(parsedTools) && parsedTools.length > 0) {
        for (const pt of parsedTools) {
          if (pt.name || pt.args) {
            let argsObj: any = pt.args;
            if (typeof pt.args === 'string') {
              try {
                argsObj = JSON.parse(pt.args);
              } catch {
                argsObj = pt.args;
              }
            } else if (typeof pt.args === 'object' && pt.args !== null) {
              argsObj = pt.args;
            }
            const isEmptyArgs = !argsObj || (typeof argsObj === 'string' && !argsObj.trim()) || (typeof argsObj === 'object' && Object.keys(argsObj).length === 1 && argsObj.raw === '');
            if (!isEmptyArgs) {
              hasValidDbTools = true;
            }
            toolCalls.push({
              id: pt.id || '',
              name: pt.name || 'tool',
              args: argsObj
            });
          }
        }
      }
    } catch {}
  }
  if (!hasValidDbTools) {
    toolCalls.length = 0;
  }

  // 2. SSOT: If backend storage already parsed complete response_text, use it directly (with anti-duplication guard)
  if (rec.response_text !== undefined && rec.response_text !== null && rec.response_text !== '') {
    text = rec.response_text;
    thinking = rec.thinking_text || '';
  }

  // 3. Fallback: Parse response_body if text is still empty or toolCalls need recovery
  try {
    const raw = (rec.response_body || '').trim();
    if (!raw) {
      if (!text && rec.response_preview && !rec.response_preview.startsWith('[Tool Call]')) text = rec.response_preview;
      return { text, thinking, toolCalls };
    }

    let streamText = '';
    let streamThinking = '';

    const processChunk = (chunk: any) => {
      if (!chunk || typeof chunk !== 'object') return;

      // 1. Gemini format (streaming chunk or direct JSON)
      const geminiObj = chunk.response || chunk;
      const candidates = geminiObj.candidates || [];
      for (const cand of candidates) {
        const parts = cand.content?.parts || [];
        for (const p of parts) {
          if (p.text) {
            if (p.thought) streamThinking += p.text;
            else streamText += p.text;
          }
          if (p.functionCall) {
            const k = p.functionCall.id || `gemini_${streamTools.size}`;
            streamTools.set(k, {
              id: p.functionCall.id || '',
              name: p.functionCall.name || 'tool',
              args: typeof p.functionCall.args === 'string' ? p.functionCall.args : JSON.stringify(p.functionCall.args || {})
            });
          }
        }
      }

      // 2. Anthropic format (direct JSON message or SSE deltas)
      if (Array.isArray(chunk.content)) {
        for (const b of chunk.content) {
          if (b.type === 'text' && b.text) streamText += b.text;
          if (b.type === 'thinking' && b.thinking) streamThinking += b.thinking;
          if (b.type === 'tool_use') {
            const k = b.id || `ant_${streamTools.size}`;
            streamTools.set(k, {
              id: b.id || '',
              name: b.name || 'tool',
              args: typeof b.input === 'string' ? b.input : JSON.stringify(b.input || {})
            });
          }
        }
      } else if (chunk.type === 'content_block_delta' && chunk.delta) {
        if (chunk.delta.type === 'text_delta' && chunk.delta.text) streamText += chunk.delta.text;
        if (chunk.delta.type === 'thinking_delta' && chunk.delta.thinking) streamThinking += chunk.delta.thinking;
      }

      // 3. OpenAI Responses API format (Codex)
      if (chunk.type === 'response.output_text.delta' && chunk.delta) {
        streamText += chunk.delta;
      } else if (chunk.type === 'response.output_text.done' && chunk.text) {
        if (!streamText) streamText = chunk.text;
      } else if ((chunk.type === 'response.reasoning_summary_text.delta' || chunk.type === 'response.reasoning_text.delta') && chunk.delta) {
        streamThinking += chunk.delta;
      } else if ((chunk.type === 'response.reasoning_summary_text.done' || chunk.type === 'response.reasoning_text.done') && chunk.text) {
        if (!streamThinking) streamThinking = chunk.text;
      } else if (chunk.type === 'response.output_item.added' && chunk.item) {
        const it = chunk.item;
        if (it.type === 'function_call' || it.type === 'custom_tool_call') {
          const callId = it.call_id || '';
          const itemId = it.id || '';
          const key = itemId || callId || `idx_${chunk.output_index ?? ''}`;
          const rawArgs = it.arguments !== undefined ? it.arguments : it.input;
          const args = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '');

          let pt = streamTools.get(key);
          if (!pt && (itemId || callId)) {
            for (const existing of streamTools.values()) {
              if ((itemId && existing.id === itemId) || (callId && existing.id === callId)) {
                pt = existing;
                break;
              }
            }
          }
          if (pt) {
            if (callId || itemId) pt.id = callId || itemId;
            if (it.name) pt.name = it.name;
            if (args) pt.args = args;
          } else {
            streamTools.set(key, { id: callId || itemId, name: it.name || 'tool', args });
          }
        }
      } else if (
        (chunk.type === 'response.function_call_arguments.delta' ||
          chunk.type === 'response.custom_tool_call_input.delta') &&
        chunk.delta
      ) {
        const key = chunk.item_id || `idx_${chunk.output_index ?? ''}`;
        let pt = streamTools.get(key);
        if (!pt && chunk.item_id) {
          for (const existing of streamTools.values()) {
            if (existing.id === chunk.item_id) {
              pt = existing;
              break;
            }
          }
        }
        if (pt) {
          pt.args += chunk.delta;
        } else {
          streamTools.set(key, { id: chunk.item_id || key, name: '', args: chunk.delta });
        }
      } else if (
        chunk.type === 'response.function_call_arguments.done' ||
        chunk.type === 'response.custom_tool_call_input.done'
      ) {
        const key = chunk.item_id || chunk.call_id || `idx_${chunk.output_index ?? ''}`;
        let pt = streamTools.get(key);
        if (!pt && (chunk.item_id || chunk.call_id)) {
          for (const existing of streamTools.values()) {
            if ((chunk.item_id && existing.id === chunk.item_id) || (chunk.call_id && existing.id === chunk.call_id)) {
              pt = existing;
              break;
            }
          }
        }
        const rawArgs = chunk.arguments !== undefined ? chunk.arguments : chunk.input;
        const args = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '');
        if (pt) {
          if (args) pt.args = args;
          if (chunk.name) pt.name = chunk.name;
          if (chunk.call_id) pt.id = chunk.call_id;
        } else {
          streamTools.set(key, { id: chunk.call_id || chunk.item_id || '', name: chunk.name || 'tool', args });
        }
      } else if (chunk.type === 'response.output_item.done' && chunk.item) {
        const it = chunk.item;
        if (it.type === 'function_call' || it.type === 'custom_tool_call') {
          const callId = it.call_id || '';
          const itemId = it.id || '';
          const key = itemId || callId || `idx_${chunk.output_index ?? ''}`;
          let pt = streamTools.get(key);
          if (!pt && (itemId || callId)) {
            for (const existing of streamTools.values()) {
              if ((itemId && existing.id === itemId) || (callId && existing.id === callId)) {
                pt = existing;
                break;
              }
            }
          }
          const rawArgs = it.arguments !== undefined ? it.arguments : it.input;
          const args = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '');
          if (pt) {
            if (callId || itemId) pt.id = callId || itemId;
            if (it.name) pt.name = it.name;
            if (args) pt.args = args;
          } else {
            streamTools.set(key, { id: callId || itemId, name: it.name || 'tool', args });
          }
        }
      } else if (chunk.type === 'response.completed' || chunk.type === 'response.done') {
        const outputList = chunk.response?.output || chunk.output;
        if (Array.isArray(outputList)) {
          for (const item of outputList) {
            if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              const callId = item.call_id || '';
              const itemId = item.id || '';
              const key = itemId || callId || `out_${item.name}`;
              let pt = streamTools.get(key);
              if (!pt && (itemId || callId)) {
                for (const existing of streamTools.values()) {
                  if ((itemId && existing.id === itemId) || (callId && existing.id === callId)) {
                    pt = existing;
                    break;
                  }
                }
              }
              const rawArgs = item.arguments !== undefined ? item.arguments : item.input;
              const args = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '');
              if (pt) {
                if (callId || itemId) pt.id = callId || itemId;
                if (item.name) pt.name = item.name;
                if (args) pt.args = args;
              } else {
                streamTools.set(key, { id: callId || itemId, name: item.name || 'tool', args });
              }
            }
          }
        }
      }

      // 4. OpenAI Responses API direct non-streaming output list
      const directOutputs = chunk.output || chunk.response?.output;
      if (Array.isArray(directOutputs)) {
        for (const item of directOutputs) {
          if (item && item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c && (c.type === 'text' || c.type === 'output_text') && c.text) {
                if (!streamText) {
                  streamText = c.text;
                }
              }
            }
          }
        }
      }

      // 5. OpenAI Chat Completions streaming & non-streaming
      const choice = chunk.choices?.[0];
      const delta = choice?.delta || choice?.message;
      if (delta) {
        if (delta.content) streamText += delta.content;
        if (delta.reasoning_content) streamThinking += delta.reasoning_content;
        else if (delta.reasoning) streamThinking += delta.reasoning;
        else if (delta.thought) streamThinking += delta.thought;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idxKey = tc.id || `tc_idx_${tc.index ?? 0}`;
            const existing = streamTools.get(idxKey);
            const fnName = tc.function?.name || '';
            const fnArgs = tc.function?.arguments || '';
            if (existing) {
              if (tc.id && !existing.id) existing.id = tc.id;
              if (fnName) existing.name = fnName;
              if (fnArgs) existing.args += fnArgs;
            } else {
              streamTools.set(idxKey, {
                id: tc.id || '',
                name: fnName || 'tool',
                args: fnArgs
              });
            }
          }
        }
      }
    };

    // Process SSE lines if present
    if (raw.includes('data:')) {
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          processChunk(JSON.parse(payload));
        } catch {}
      }
    }

    // Direct JSON fallback (if text and tools are still empty, or non-SSE)
    if (!streamText && !text && streamTools.size === 0 && (raw.startsWith('{') || raw.startsWith('['))) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) processChunk(item);
        } else {
          processChunk(parsed);
        }
      } catch {}
    }

    if (streamText) {
      if (!text) {
        text = streamText;
      } else if (text === streamText + streamText || (text !== streamText && deduplicateDoubledText(text) === streamText)) {
        // The persisted value is only replaced when the raw stream proves it is doubled.
        text = streamText;
      }
    }
    if (!thinking) {
      thinking = streamThinking;
    }
  } catch {}

  // If no DB tools were present or valid, populate from streamTools
  if (toolCalls.length === 0 && streamTools.size > 0) {
    const seenIds = new Set<string>();
    for (const pt of streamTools.values()) {
      if (pt.name || pt.args) {
        if (pt.id && seenIds.has(pt.id)) continue;
        if (pt.id) seenIds.add(pt.id);
        let argsObj: any = pt.args;
        if (typeof pt.args === 'string') {
          try {
            argsObj = JSON.parse(pt.args);
          } catch {
            argsObj = pt.args;
          }
        }
        toolCalls.push({
          id: pt.id || '',
          name: pt.name || 'tool',
          args: argsObj
        });
      }
    }
  }

  // Parse inline <think> tags if any
  if (text.includes('<think>')) {
    const m = text.match(/<think>([\s\S]*?)<\/think>/i);
    if (m) {
      if (!thinking) thinking = m[1].trim();
      text = text.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
    }
  }

  // Fallback to response_preview if empty
  const preview = rec.response_preview || '';
  if (!text.trim() && !toolCalls.length && preview) {
    if (preview.startsWith('[Tool Call]')) {
      const name = preview.replace('[Tool Call]', '').trim();
      toolCalls.push({ name, args: {} });
    } else {
      text = preview;
    }
  }

  return {
    text: text.trim(),
    thinking: thinking.trim(),
    toolCalls
  };
}

export function buildChatTimelineTurns(
  session: Session | null,
  sessionTurnRecords: Record<number, RecordDetail>
): ChatTimelineTurn[] {
  if (!session || !session.turns) return [];
  const turnsList = session.turns;

  return turnsList.map((turn, idx) => {
    const rec = sessionTurnRecords[turn.record_id] || ({ prompt_summary: turn.summary, response_preview: turn.response_preview } as RecordDetail);
    const parsedFromBody = rec.request_body ? parseRequestTurnPayload(rec.request_body) : null;
    const parsed = parsedFromBody || rec.parsed_question || parseRequestTurnPayload('');

    const cleanSummary = cleanPromptSummary(rec.prompt_summary || turn.summary || '');
    const isContextUpdate = rec.request_body
      ? parsed.isContextUpdate
      : Boolean(rec.parsed_question?.isContextUpdate || cleanSummary === '上下文更新（不生成回复）');
    const contextTools = parsed.contextTools || [];
    const historyCount = parsed.historyCount || 0;
    const historyMessages = parsed.historyMessages || [];

    let newText = parsed.newText || '';
    const toolResults: ToolResultItem[] = [...(parsed.toolResults || [])];

    const hasParsedRequest = Boolean(parsed.hasMessages || isContextUpdate);
    if (!hasParsedRequest && !newText.trim() && !toolResults.length) {
      const toolNames = extractToolResultSummaryNames(cleanSummary);
      if (toolNames.length > 0) {
        for (const name of toolNames) {
          toolResults.push({ name, output: '' });
        }
      } else if (turn.assignment) {
        newText = cleanSummary || cleanPromptSummary(rec.user_prompt || '') || '';
      } else if (idx === 0) {
        newText = cleanPromptSummary(rec.user_prompt || '') || cleanSummary || cleanPromptSummary(session.user_prompt || '') || '';
      } else if (cleanSummary) {
        newText = cleanSummary;
      } else if (rec.user_prompt && rec.user_prompt !== session.user_prompt) {
        newText = cleanPromptSummary(rec.user_prompt);
      }
    }

    const hasUserText = Boolean(newText.trim());
    const hasTools = toolResults.length > 0;
    const isUser = !turn.assignment && !isContextUpdate && !hasTools && (idx === 0 || hasUserText);

    let roleLabel = '增量提示词';
    let title = '执行反馈注入';

    const isWebSearch =
      (session.agent_name && session.agent_name.includes('WebSearch')) ||
      (rec.agent_name && rec.agent_name.includes('WebSearch')) ||
      (rec.request_body && (rec.request_body.includes('"web_search"') || rec.request_body.includes('"googleSearch"')));

    if (isContextUpdate) {
      roleLabel = '上下文更新';
      title = '更新说明与工具定义';
    } else if (hasTools) {
      roleLabel = '工具执行返回';
      title = '执行反馈注入';
    } else if (turn.assignment) {
      roleLabel = '请求内容';
      title = turn.assignment.turn.status === 'resolved' ? '轮次内请求' : '';
    } else if (isUser) {
      if (isWebSearch) {
        roleLabel = '检索指令';
        title = idx === 0 ? 'WebSearch 子 Agent 发起' : '搜索后续检索词';
      } else {
        roleLabel = '用户指令';
        title = idx === 0 ? (session.agent_name + ' 会话发起') : '用户后续指令';
      }
    } else {
      roleLabel = '增量提示词';
      title = '增量触发';
    }

    const question = {
      isContextUpdate,
      contextTools,
      isUser,
      roleLabel,
      title,
      newText: newText.trim(),
      toolResults,
      historyCount,
      historyMessages
    };

    const parsedResp = parseModelResponse(rec);
    const answer = {
      model: rec.model || session.model,
      thinkingText: parsedResp.thinking,
      toolCalls: parsedResp.toolCalls,
      responseText: parsedResp.text,
      subagents: turn.subagents || []
    };

    const rawLoaded = rec.raw_loaded !== undefined ? Boolean(rec.raw_loaded) : Boolean(rec.request_body || rec.response_body);
    const readableLoaded = Boolean(rawLoaded || rec.parsed_question?.hasMessages || rec.parsed_question?.isContextUpdate);

    return {
      turnIndex: turn.turn_index,
      recordId: turn.record_id,
      statusCode: rec.status_code || turn.status_code || 200,
      connectionIssue: turn.assignment?.connectionIssue,
      purpose: turn.assignment?.purpose,
      toolLink: turn.assignment?.toolLink?.status === 'resolved' ? turn.assignment.toolLink.value : undefined,
      captureStatus: rec.capture_status,
      duration_ms: rec.duration_ms || turn.duration_ms || 0,
      tokenSource: rec.token_source ?? turn.token_source,
      inputTokens: rec.input_tokens ?? turn.input_tokens ?? 0,
      cachedTokens: rec.cached_tokens ?? turn.cached_tokens ?? 0,
      cacheRatio: rec.cache_ratio ?? turn.cache_ratio ?? 0,
      thinkingTokens: rec.thinking_tokens ?? turn.thinking_tokens ?? 0,
      outputTokens: rec.output_tokens ?? turn.output_tokens ?? 0,
      relatedHistory: rec.related_history,
      historyLoading: rec.history_loading,
      previousResponseId: rec.previous_response_id,
      bodyFormat: rec.body_format,
      rawHeaders: rec.request_headers || {},
      rawRequestBody: rec.request_body || '',
      rawResponseBody: rec.response_body || '',
      rawLoaded,
      readableLoaded,
      rawPruned: Boolean(rec.raw_pruned),
      contentExpired: Boolean(rec.content_expired),
      rawLoading: Boolean(rec.raw_loading),
      rawLoadError: rec.raw_load_error || null,
      question,
      answer
    };
  });
}

import { sanitizeHeaders, sanitizeText } from './sanitizer';

export const getTurnReqCopyContent = (
  turnChat: ChatTimelineTurn,
  isRaw: boolean,
  isSanitized: boolean = false
): string => {
  if (isRaw) {
    return isSanitized ? sanitizeText(turnChat.rawRequestBody) : turnChat.rawRequestBody;
  }
  let str = turnChat.question.newText;
  if (turnChat.question.contextTools?.length) {
    str += '\n\n[附加工具定义]\n' + prettyJson(turnChat.question.contextTools);
  }
  if (turnChat.question.toolResults?.length) {
    str += '\n' + turnChat.question.toolResults.map((t) => `[Tool Result: ${t.name}]\n${t.output}`).join('\n\n');
  }
  const content = str.trim();
  return isSanitized ? sanitizeText(content) : content;
};

export const getTurnResCopyContent = (
  turnChat: ChatTimelineTurn,
  isRaw: boolean,
  isSanitized: boolean = false
): string => {
  let content = '';
  if (isRaw) {
    content = turnChat.rawResponseBody;
  } else {
    let str = '';
    if (turnChat.answer.thinkingText) {
      str += `[Thinking]\n${turnChat.answer.thinkingText}\n\n`;
    }
    if (turnChat.answer.toolCalls?.length) {
      str += turnChat.answer.toolCalls.map((tc) => `[Tool Call: ${tc.name}]\n${prettyJson(tc.args)}`).join('\n\n') + '\n\n';
    }
    if (turnChat.answer.responseText) {
      str += turnChat.answer.responseText;
    }
    content = str.trim();
  }
  return isSanitized ? sanitizeText(content) : content;
};
