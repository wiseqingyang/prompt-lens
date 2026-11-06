/** Antigravity's page retrieval RPC is a tool operation, with no model usage. */
export function isWebFetchRequest(urlPath: string = ''): boolean {
  return /\/v1internal:fetchFromTrawlerCache(?:[?#]|$)/i.test(urlPath);
}

/** Strip legacy `N msgs` and `N msgs | Last:` prefixes while keeping meaningful summaries. */
export function cleanPromptSummary(summary: string = ''): string {
  const trimmed = String(summary || '').trim();
  if (!trimmed || /^\d+\s*msgs$/i.test(trimmed)) return '';
  return trimmed.replace(/^\d+\s*msgs\s*\|\s*Last:\s*/i, '').trim();
}

export function extractToolResultSummaryNames(summary: string = ''): string[] {
  const clean = cleanPromptSummary(summary);
  const m = clean.match(/^\[Tool Result:?\s*([^\]]*)\]$/i);
  if (!m) return [];
  const raw = (m[1] || '').trim();
  if (!raw) return ['tool_result'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getMessagesFromRequestBody(reqBodyStr: string): any[] {
  if (!reqBodyStr) return [];
  try {
    const data = JSON.parse(reqBodyStr);
    const reqObj = data.request || data;
    if (Array.isArray(reqObj.contents)) return reqObj.contents;
    if (Array.isArray(reqObj.messages)) return reqObj.messages;
    if (Array.isArray(reqObj.input)) return reqObj.input;
    if (typeof reqObj.input === 'string') return [{ role: 'user', content: reqObj.input }];
  } catch {}
  return [];
}

export function extractMsgText(m: any): string {
  if (!m) return '';
  if (m.type === 'function_call' || m.type === 'custom_tool_call') {
    const rawArgs = m.arguments !== undefined ? m.arguments : m.input;
    return `[Tool Call: ${m.name || 'tool'}] ${typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '')}`;
  }
  if (m.type === 'function_call_output' || m.type === 'custom_tool_call_output') {
    let out = '';
    if (typeof m.output === 'string') {
      out = m.output;
    } else if (Array.isArray(m.output)) {
      out = m.output
        .map((p: any) => {
          if (typeof p === 'string') return p;
          if (p && typeof p === 'object') return p.text || JSON.stringify(p);
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } else {
      out = JSON.stringify(m.output || {});
    }
    return `[Tool Result] ${out}`;
  }
  if (Array.isArray(m.parts)) {
    return m.parts.map((p: any) => {
      if (p.text) return p.text;
      if (p.functionCall) return `[Tool Call] ${p.functionCall.name}`;
      if (p.functionResponse) return `[Tool Result] ${p.functionResponse.name}`;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((c: any) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') {
        if (c.type === 'tool_result') {
          return `[Tool Result] ${typeof c.content === 'string' ? c.content : JSON.stringify(c.content)}`;
        }
        if (c.type === 'tool_use') {
          return `[Tool Call: ${c.name}] ${JSON.stringify(c.input || {})}`;
        }
        return c.text || c.content || '';
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof m.text === 'string') return m.text;
  return JSON.stringify(m);
}

// Chat-completions assistant messages may contain all three fields simultaneously.
// Keep this limited to history presentation: the tail represents the current input,
// and neither path mutates the original request or interprets a tool definition as a call.
function extractHistoryMessageText(m: any): string {
  if (!m || m.role !== 'assistant' ||
      (!Object.prototype.hasOwnProperty.call(m, 'reasoning') && !Object.prototype.hasOwnProperty.call(m, 'tool_calls'))) {
    return extractMsgText(m);
  }
  const parts: string[] = [];
  if (typeof m.content === 'string') {
    if (m.content) parts.push(m.content);
  } else if (Array.isArray(m.content)) {
    const content = m.content.map((part: any) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return JSON.stringify(part);
    }).filter((part: any) => typeof part === 'string' && part.length > 0).join('\n');
    if (content) parts.push(content);
  } else if (m.content != null) {
    parts.push(JSON.stringify(m.content));
  }
  if (Object.prototype.hasOwnProperty.call(m, 'reasoning')) {
    const reasoning = typeof m.reasoning === 'string' ? m.reasoning : JSON.stringify(m.reasoning);
    if (reasoning) parts.push(`[Reasoning]\n${reasoning}`);
  }
  if (Object.prototype.hasOwnProperty.call(m, 'tool_calls')) {
    const calls = JSON.stringify(m.tool_calls, null, 2);
    if (calls) parts.push(`[Tool Calls]\n${calls}`);
  }
  return parts.join('\n\n');
}

export function extractTailDiffAndHistory(msgs: any[]): {
  diffMsgs: any[];
  historyCount: number;
  historyMessages: Array<{ role: string; text: string }>;
} {
  if (!msgs || msgs.length === 0) {
    return { diffMsgs: [], historyCount: 0, historyMessages: [] };
  }
  if (msgs.length === 1) {
    return { diffMsgs: msgs, historyCount: 0, historyMessages: [] };
  }

  let lastModelIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    if (
      m.role === 'assistant' ||
      m.type === 'function_call' ||
      m.type === 'custom_tool_call' ||
      m.type === 'reasoning'
    ) {
      lastModelIdx = i;
      break;
    }
    if (m.role === 'model') {
      const parts = m.parts || [];
      const hasModelOutput = parts.some((p: any) => p && (p.text || p.functionCall || p.thought));
      if (hasModelOutput) {
        lastModelIdx = i;
        break;
      }
    }
  }

  let splitIdx = 0;
  if (lastModelIdx >= 0) {
    splitIdx = lastModelIdx + 1;
    if (splitIdx >= msgs.length) splitIdx = msgs.length - 1;
  } else if (msgs.length > 1 && msgs[0]?.role === 'system') {
    splitIdx = 1;
  }

  return {
    diffMsgs: msgs.slice(splitIdx),
    historyCount: splitIdx,
    historyMessages: msgs.slice(0, splitIdx).map((m: any) => ({
      role: m.role || (m.type === 'function_call' || m.type === 'custom_tool_call' || m.type === 'reasoning' ? 'assistant' : 'user'),
      text: extractHistoryMessageText(m)
    }))
  };
}

export interface ParsedRequestTurnPayload {
  hasMessages: boolean;
  isContextUpdate: boolean;
  contextTools: any[];
  newText: string;
  toolResults: Array<{ name: string; output: string }>;
  historyCount: number;
  historyMessages: Array<{ role: string; text: string }>;
}

export function parseRequestTurnPayload(reqBodyStr: string = ''): ParsedRequestTurnPayload {
  const currReqMsgs = getMessagesFromRequestBody(reqBodyStr);
  let isContextUpdate = false;
  try {
    if (reqBodyStr) {
      const body = JSON.parse(reqBodyStr);
      isContextUpdate = (body.request || body).generate === false;
    }
  } catch {
    isContextUpdate = false;
  }

  const contextTools = isContextUpdate
    ? currReqMsgs
        .filter((m) => m?.type === 'additional_tools' && Array.isArray(m.tools))
        .flatMap((m) => m.tools)
        .filter((tool) => tool && typeof tool === 'object')
    : [];

  let diffMsgs: any[] = [];
  let historyCount = 0;
  let historyMessages: Array<{ role: string; text: string }> = [];

  if (currReqMsgs.length > 0) {
    const tail = extractTailDiffAndHistory(currReqMsgs);
    historyCount = tail.historyCount;
    historyMessages = tail.historyMessages;
    diffMsgs = tail.diffMsgs;
  }

  const callIdToName = new Map<string, string>();
  currReqMsgs.forEach((m: any) => {
    if (!m || typeof m !== 'object') return;
    if ((m.type === 'function_call' || m.type === 'custom_tool_call') && (m.call_id || m.id) && m.name) {
      callIdToName.set(m.call_id || m.id, m.name);
    }
    if (m.functionCall?.name && m.functionCall?.id) {
      callIdToName.set(m.functionCall.id, m.functionCall.name);
    }
    if (Array.isArray(m.parts)) {
      m.parts.forEach((p: any) => {
        if (p?.functionCall?.name && p.functionCall.id) {
          callIdToName.set(p.functionCall.id, p.functionCall.name);
        }
      });
    }
    if (Array.isArray(m.tool_calls)) {
      m.tool_calls.forEach((tc: any) => {
        const name = tc?.function?.name || tc?.name;
        if (tc?.id && name) callIdToName.set(tc.id, name);
      });
    }
    if (Array.isArray(m.content)) {
      m.content.forEach((c: any) => {
        if (c?.type === 'tool_use' && c.id && c.name) {
          callIdToName.set(c.id, c.name);
        }
      });
    }
  });

  let newText = '';
  const toolResults: Array<{ name: string; output: string }> = [];

  diffMsgs.forEach((m: any) => {
    if (!m) return;
    if (m.type === 'function_call_output' || m.type === 'custom_tool_call_output') {
      const toolName = (m.call_id && callIdToName.get(m.call_id)) || m.name || m.call_id || 'tool_response';
      let outStr = '';
      if (typeof m.output === 'string') {
        outStr = m.output;
      } else if (Array.isArray(m.output)) {
        outStr = m.output
          .map((p: any) => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object') {
              if (p.type === 'input_text' || p.type === 'text' || p.type === 'output_text') return p.text || '';
              return p.text || JSON.stringify(p, null, 2);
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      } else if (typeof m.output === 'object' && m.output !== null) {
        outStr = JSON.stringify(m.output, null, 2);
      } else {
        outStr = String(m.output !== undefined && m.output !== null ? m.output : '');
      }
      toolResults.push({ name: toolName, output: outStr });
      return;
    }
    if (m.type === 'function_call' || m.type === 'custom_tool_call' || m.type === 'reasoning' || m.type === 'additional_tools') {
      return;
    }
    if (m.role === 'tool') {
      const toolName = (m.tool_call_id && callIdToName.get(m.tool_call_id)) || m.name || m.tool_call_id || 'tool_response';
      let outStr = '';
      if (typeof m.content === 'string') {
        outStr = m.content;
      } else if (Array.isArray(m.content)) {
        outStr = m.content.map((p: any) => (typeof p === 'string' ? p : p?.text || JSON.stringify(p, null, 2))).join('\n');
      } else if (m.content !== undefined && m.content !== null) {
        outStr = JSON.stringify(m.content, null, 2);
      }
      toolResults.push({ name: toolName, output: outStr });
      return;
    }

    if (Array.isArray(m.parts)) {
      m.parts.forEach((p: any) => {
        if (p.text) newText += p.text + '\n';
        if (p.functionResponse) {
          const resp = p.functionResponse.response || {};
          const outStr = typeof resp.output === 'string' ? resp.output : JSON.stringify(resp, null, 2);
          toolResults.push({
            name: p.functionResponse.name || (p.functionResponse.id && callIdToName.get(p.functionResponse.id)) || 'tool_response',
            output: outStr
          });
        }
      });
    } else if (typeof m.content === 'string') {
      newText += m.content + '\n';
    } else if (Array.isArray(m.content)) {
      m.content.forEach((c: any) => {
        if (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') {
          if (c.text) {
            newText += c.text + '\n';
          }
        }
        if (c.type === 'tool_result') {
          const toolName = (c.tool_use_id && callIdToName.get(c.tool_use_id)) || c.name || 'tool_result';
          let outStr = '';
          if (typeof c.content === 'string') {
            outStr = c.content;
          } else if (Array.isArray(c.content)) {
            outStr = c.content.map((p: any) => p.text || JSON.stringify(p, null, 2)).join('\n');
          } else {
            outStr = JSON.stringify(c.content || {}, null, 2);
          }
          toolResults.push({ name: toolName, output: outStr });
        }
      });
    } else if (typeof m.text === 'string') {
      newText += m.text + '\n';
    }
  });

  return {
    hasMessages: currReqMsgs.length > 0,
    isContextUpdate,
    contextTools,
    newText: newText.trim(),
    toolResults,
    historyCount,
    historyMessages
  };
}

/**
 * Detects if a text payload represents an SSE (Server-Sent Events) stream.
 */
export function isSsePayload(raw: string = ''): boolean {
  if (!raw || typeof raw !== 'string') return false;
  return /(?:^|\r?\n)data:\s*/m.test(raw);
}

/**
 * Extracts and parses JSON data payloads from an SSE stream.
 */
export function parseSseJsonChunks(raw: string = ''): any[] {
  if (!raw || typeof raw !== 'string') return [];
  const results: any[] = [];

  // Try standard double-newline separated SSE event blocks first
  const blocks = raw.split(/\r?\n\r?\n/);
  if (blocks.length > 1) {
    for (const block of blocks) {
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
        const full = dataLines.join('\n');
        try {
          const parsed = JSON.parse(full);
          if (Array.isArray(parsed)) results.push(...parsed);
          else results.push(parsed);
        } catch {
          const start = full.indexOf('{');
          const end = full.lastIndexOf('}');
          if (start !== -1 && end > start) {
            try {
              results.push(JSON.parse(full.slice(start, end + 1)));
            } catch {}
          }
        }
      }
    }
    if (results.length > 0) return results;
  }

  // Fallback: line-by-line data: extraction
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed)) results.push(...parsed);
      else results.push(parsed);
    } catch {}
  }

  return results;
}

/**
 * Assembles and merges an SSE stream into a unified response object.
 */
export function assembleSsePayload(raw: string = ''): any {
  if (!raw || typeof raw !== 'string') return {};
  const chunks = parseSseJsonChunks(raw);
  if (!chunks.length) return raw;

  // 1. OpenAI Responses API (Codex)
  const completedChunk = chunks.find(
    (c) =>
      c &&
      typeof c === 'object' &&
      (c.type === 'response.completed' || c.type === 'response.done') &&
      c.response &&
      typeof c.response === 'object'
  );
  if (completedChunk) {
    return completedChunk.response;
  }

  const isResponsesApi = chunks.some(
    (c) =>
      c &&
      typeof c === 'object' &&
      typeof c.type === 'string' &&
      c.type.startsWith('response.')
  );
  if (isResponsesApi) {
    let baseId = '';
    let model = '';
    let usage: any = undefined;
    let fullText = '';
    let fullReasoning = '';
    const itemsMap = new Map<string, any>();
    const orderedItemIds: string[] = [];

    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.response?.id) baseId = chunk.response.id;
      if (chunk.response?.model) model = chunk.response.model;
      if (chunk.response?.usage) usage = chunk.response.usage;

      if (chunk.type === 'response.output_text.delta' && chunk.delta) {
        fullText += chunk.delta;
      } else if (
        (chunk.type === 'response.reasoning_summary_text.delta' ||
          chunk.type === 'response.reasoning_text.delta') &&
        chunk.delta
      ) {
        fullReasoning += chunk.delta;
      } else if (chunk.type === 'response.output_item.added' && chunk.item) {
        const item = JSON.parse(JSON.stringify(chunk.item));
        const itemId = item.id || `item_${orderedItemIds.length}`;
        itemsMap.set(itemId, item);
        orderedItemIds.push(itemId);
      } else if (
        (chunk.type === 'response.function_call_arguments.delta' ||
          chunk.type === 'response.custom_tool_call_input.delta') &&
        chunk.delta
      ) {
        const itemId = chunk.item_id || orderedItemIds[orderedItemIds.length - 1];
        if (itemId && itemsMap.has(itemId)) {
          const item = itemsMap.get(itemId);
          item.arguments = (item.arguments || '') + chunk.delta;
        }
      }
    }

    const outputItems = orderedItemIds.map((id) => itemsMap.get(id)).filter(Boolean);
    if (!outputItems.length && fullText) {
      outputItems.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: fullText }]
      });
    }

    return {
      id: baseId || 'response_assembled',
      object: 'response',
      status: 'completed',
      model: model || undefined,
      output: outputItems,
      output_text: fullText || undefined,
      reasoning: fullReasoning || undefined,
      usage: usage || undefined
    };
  }

  // 2. Anthropic Messages API
  const startChunk = chunks.find((c) => c?.type === 'message_start' && c?.message);
  if (startChunk || chunks.some((c) => c?.type === 'content_block_delta' || c?.type === 'content_block_start')) {
    const baseMessage = startChunk?.message
      ? JSON.parse(JSON.stringify(startChunk.message))
      : { id: '', type: 'message', role: 'assistant', model: '', content: [] };

    const contentBlocks: any[] = Array.isArray(baseMessage.content) ? [...baseMessage.content] : [];

    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'content_block_start' && chunk.content_block) {
        const idx = chunk.index ?? contentBlocks.length;
        contentBlocks[idx] = JSON.parse(JSON.stringify(chunk.content_block));
        if (contentBlocks[idx].type === 'tool_use' && !contentBlocks[idx].input) {
          contentBlocks[idx].input = '';
        }
      } else if (chunk.type === 'content_block_delta' && chunk.delta) {
        const idx = chunk.index ?? Math.max(0, contentBlocks.length - 1);
        if (!contentBlocks[idx]) {
          contentBlocks[idx] = { type: chunk.delta.type === 'text_delta' ? 'text' : chunk.delta.type === 'thinking_delta' ? 'thinking' : 'tool_use' };
        }
        const b = contentBlocks[idx];
        if (chunk.delta.type === 'text_delta' && chunk.delta.text) {
          b.text = (b.text || '') + chunk.delta.text;
        } else if (chunk.delta.type === 'thinking_delta' && chunk.delta.thinking) {
          b.thinking = (b.thinking || '') + chunk.delta.thinking;
        } else if (chunk.delta.type === 'input_json_delta' && chunk.delta.partial_json) {
          b.input = (typeof b.input === 'string' ? b.input : '') + chunk.delta.partial_json;
        }
      } else if (chunk.type === 'message_delta') {
        if (chunk.delta?.stop_reason) baseMessage.stop_reason = chunk.delta.stop_reason;
        if (chunk.usage) {
          baseMessage.usage = { ...(baseMessage.usage || {}), ...chunk.usage };
        }
      }
    }

    for (const b of contentBlocks) {
      if (b && b.type === 'tool_use' && typeof b.input === 'string') {
        try {
          b.input = JSON.parse(b.input);
        } catch {}
      }
    }

    baseMessage.content = contentBlocks;
    return baseMessage;
  }

  // 3. OpenAI Chat Completions (chat.completion.chunk)
  const isChatCompletion = chunks.some(
    (c) => c?.object === 'chat.completion.chunk' || (Array.isArray(c?.choices) && c.choices[0]?.delta)
  );
  if (isChatCompletion) {
    let baseId = '';
    let created = 0;
    let model = '';
    let system_fingerprint = '';
    let usage: any = undefined;

    interface ChoiceAccumulator {
      index: number;
      role: string;
      content: string;
      reasoning_content: string;
      tool_calls_map: Map<number | string, any>;
      finish_reason: string | null;
    }

    const choicesMap = new Map<number, ChoiceAccumulator>();

    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.id && !baseId) baseId = chunk.id;
      if (chunk.created && !created) created = chunk.created;
      if (chunk.model && !model) model = chunk.model;
      if (chunk.system_fingerprint && !system_fingerprint) system_fingerprint = chunk.system_fingerprint;
      if (chunk.usage) usage = chunk.usage;

      if (Array.isArray(chunk.choices)) {
        for (const choice of chunk.choices) {
          const idx = choice.index ?? 0;
          if (!choicesMap.has(idx)) {
            choicesMap.set(idx, {
              index: idx,
              role: 'assistant',
              content: '',
              reasoning_content: '',
              tool_calls_map: new Map(),
              finish_reason: null
            });
          }
          const acc = choicesMap.get(idx)!;
          if (choice.finish_reason) acc.finish_reason = choice.finish_reason;

          const delta = choice.delta || choice.message;
          if (delta) {
            if (delta.role) acc.role = delta.role;
            if (delta.content) acc.content += delta.content;
            const reasoning = delta.reasoning_content || delta.reasoning || delta.thought;
            if (reasoning) acc.reasoning_content += reasoning;

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const tcIdx = tc.index ?? acc.tool_calls_map.size;
                if (!acc.tool_calls_map.has(tcIdx)) {
                  acc.tool_calls_map.set(tcIdx, {
                    id: tc.id || '',
                    type: tc.type || 'function',
                    function: {
                      name: tc.function?.name || '',
                      arguments: tc.function?.arguments || ''
                    }
                  });
                } else {
                  const existing = acc.tool_calls_map.get(tcIdx)!;
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.function.name += tc.function.name;
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                }
              }
            }
          }
        }
      }
    }

    const assembledChoices = Array.from(choicesMap.values()).map((acc) => {
      const toolCalls = Array.from(acc.tool_calls_map.values());
      const message: any = { role: acc.role, content: acc.content || null };
      if (acc.reasoning_content) message.reasoning_content = acc.reasoning_content;
      if (toolCalls.length) message.tool_calls = toolCalls;

      return {
        index: acc.index,
        message,
        finish_reason: acc.finish_reason || 'stop'
      };
    });

    return {
      id: baseId || 'chatcmpl-assembled',
      object: 'chat.completion',
      created: created || Math.floor(Date.now() / 1000),
      model: model || undefined,
      system_fingerprint: system_fingerprint || undefined,
      choices: assembledChoices,
      usage: usage || undefined
    };
  }

  // 4. Gemini Streaming format
  const isGemini = chunks.some((c) => c?.candidates || c?.response?.candidates);
  if (isGemini) {
    let fullText = '';
    let fullThought = '';
    const parts: any[] = [];
    let usageMetadata: any = undefined;

    for (const chunk of chunks) {
      const obj = chunk.response || chunk;
      if (obj.usageMetadata) usageMetadata = obj.usageMetadata;
      for (const cand of obj.candidates || []) {
        for (const p of cand.content?.parts || []) {
          if (p.text) {
            if (p.thought) fullThought += p.text;
            else fullText += p.text;
          } else {
            parts.push(p);
          }
        }
      }
    }

    const finalParts: any[] = [];
    if (fullThought) finalParts.push({ text: fullThought, thought: true });
    if (fullText) finalParts.push({ text: fullText });
    finalParts.push(...parts);

    return {
      candidates: [
        {
          content: {
            parts: finalParts,
            role: 'model'
          },
          finishReason: 'STOP'
        }
      ],
      usageMetadata
    };
  }

  // 5. Generic chunks fallback
  if (chunks.length === 1) return chunks[0];
  return chunks;
}

/**
 * Universal JSON and SSE payload formatter:
 * Formats single-line JSON with 2 spaces indentation, and handles SSE merge formatting.
 */
export function formatPayload(raw: string = '', isSseMerged: boolean = false): string {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (isSsePayload(trimmed)) {
    if (isSseMerged) {
      const assembled = assembleSsePayload(trimmed);
      return typeof assembled === 'object' && assembled !== null
        ? JSON.stringify(assembled, null, 2)
        : String(assembled);
    }
    return raw;
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify(parsed, null, 2);
      }
    } catch {}
  }
  return raw;
}
