/**
 * Built-in Declarative Protocol Schemas for PromptLens
 * Covers standard public APIs and private coding agent protocols.
 */

import { DeclarativeSchemaRule, ExtractionContext, isTokenCount } from './types';
import { queryPath, queryFirst } from './pathQuery';

export const BUILTIN_SCHEMAS: DeclarativeSchemaRule[] = [
  // 1. Google Gemini / Antigravity Protocol
  {
    id: 'gemini',
    name: 'Google Gemini & Antigravity CloudCode',
    provider: 'gemini',
    priority: 100,
    textPaths: [
      'response.candidates.[].content.parts.[?!thought].text',
      'candidates.[].content.parts.[?!thought].text'
    ],
    thinkingPaths: [
      'response.candidates.[].content.parts.[?thought].text',
      'candidates.[].content.parts.[?thought].text'
    ],
    finishReasonPaths: [
      'response.candidates.[].finishReason',
      'candidates.[].finishReason'
    ],
    usage: {
      input_tokens: ['response.usageMetadata.promptTokenCount', 'usageMetadata.promptTokenCount'],
      output_tokens: ['response.usageMetadata.candidatesTokenCount', 'usageMetadata.candidatesTokenCount'],
      cached_tokens: ['response.usageMetadata.cachedContentTokenCount', 'usageMetadata.cachedContentTokenCount'],
      thinking_tokens: ['response.usageMetadata.thoughtsTokenCount', 'usageMetadata.thoughtsTokenCount'],
      total_tokens: ['response.usageMetadata.totalTokenCount', 'usageMetadata.totalTokenCount']
    },
    customChunkHandler: (rawChunk: any, ctx: ExtractionContext) => {
      const chunk = rawChunk.response || rawChunk;
      const candidates = chunk.candidates || rawChunk.candidates;
      if (Array.isArray(candidates)) {
        for (const cand of candidates) {
          if (cand.content?.parts && Array.isArray(cand.content.parts)) {
            for (const p of cand.content.parts) {
              if (p.functionCall) {
                ctx.toolCalls.push({
                  id: p.functionCall.id || '',
                  name: p.functionCall.name || 'tool',
                  args: p.functionCall.args
                });
              }
            }
          }
        }
      }
      return false; // allow standard declarative path extraction to proceed
    }
  },

  // 2. Anthropic Claude Messages Protocol
  {
    id: 'anthropic',
    name: 'Anthropic Claude Messages & Claude Code CLI',
    provider: 'anthropic',
    priority: 100,
    textPaths: [
      'delta.text',
      'content_block.text'
    ],
    thinkingPaths: [
      'delta.thinking'
    ],
    finishReasonPaths: [
      'delta.stop_reason'
    ],
    customChunkHandler: (chunk: any, ctx: ExtractionContext) => {
      // Anthropic usage may arrive in message_start, message_delta or a full message.
      const u = chunk.type === 'message_start' ? chunk.message?.usage : chunk.usage;
      if (u && typeof u === 'object') {
        if (isTokenCount(u.input_tokens)) { ctx.inTok = u.input_tokens; ctx.hasUsage = true; }
        if (isTokenCount(u.output_tokens)) { ctx.outTok = u.output_tokens; ctx.hasUsage = true; }
        if (isTokenCount(u.cache_read_input_tokens) || isTokenCount(u.cache_creation_input_tokens)) {
          ctx.cachedTok = (isTokenCount(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0) +
            (isTokenCount(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0);
          ctx.hasUsage = true;
        }
        ctx.rawDetails = { ...ctx.rawDetails, ...u };
      }

      // Streaming tool calls
      if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
        const key = chunk.content_block.id || `claude_idx_${chunk.index ?? ctx.pendingTools.size}`;
        ctx.pendingTools.set(key, {
          name: chunk.content_block.name || '',
          id: chunk.content_block.id || '',
          args: typeof chunk.content_block.input === 'string'
            ? chunk.content_block.input
            : (chunk.content_block.input ? JSON.stringify(chunk.content_block.input) : '')
        });
      } else if (chunk.type === 'content_block_delta' && chunk.delta) {
        if (chunk.delta.type === 'input_json_delta' && chunk.delta.partial_json) {
          const key = `claude_idx_${chunk.index ?? 0}`;
          const pt = ctx.pendingTools.get(key) || Array.from(ctx.pendingTools.values()).pop();
          if (pt) {
            pt.args = (pt.args === '{}' || pt.args === '""' ? '' : pt.args) + chunk.delta.partial_json;
          }
        }
      }

      return false;
    }
  },

  // 3. OpenAI Codex Responses API Protocol
  {
    id: 'openai_codex',
    name: 'OpenAI Codex Responses API',
    provider: 'openai',
    priority: 120,
    textPaths: [],
    finishReasonPaths: [
      'response.status'
    ],
    usage: {
      input_tokens: ['response.usage.input_tokens', 'usage.input_tokens', 'item.usage.input_tokens'],
      output_tokens: ['response.usage.output_tokens', 'usage.output_tokens', 'item.usage.output_tokens'],
      cached_tokens: [
        'response.usage.input_tokens_details.cached_tokens',
        'usage.input_tokens_details.cached_tokens',
        'item.usage.input_tokens_details.cached_tokens'
      ],
      thinking_tokens: [
        'response.usage.output_tokens_details.reasoning_tokens',
        'usage.output_tokens_details.reasoning_tokens',
        'item.usage.output_tokens_details.reasoning_tokens'
      ],
      total_tokens: ['response.usage.total_tokens', 'usage.total_tokens', 'item.usage.total_tokens']
    },
    customChunkHandler: (chunk: any, ctx: ExtractionContext) => {
      // 1. Streaming text delta
      if (chunk.type === 'response.output_text.delta' && chunk.delta) {
        ctx.textSegments.push(chunk.delta);
        return true;
      }
      // 2. Streaming text done (only populate if no deltas were received)
      if (chunk.type === 'response.output_text.done' && chunk.text) {
        if (!ctx.textSegments.length) ctx.textSegments.push(chunk.text);
        return true;
      }
      // 3. Thinking text delta
      if ((chunk.type === 'response.reasoning_summary_text.delta' || chunk.type === 'response.reasoning_text.delta') && chunk.delta) {
        ctx.thinkingSegments.push(chunk.delta);
        return true;
      }

      // 4. Tool call added
      if (chunk.type === 'response.output_item.added' && chunk.item) {
        if (chunk.item.type === 'message') {
          return true;
        }
        if (chunk.item.type === 'function_call' || chunk.item.type === 'custom_tool_call') {
          const callId = chunk.item.call_id || '';
          const itemId = chunk.item.id || '';
          const key = itemId || callId || `idx_${chunk.output_index ?? ''}`;
          const rawArgs = chunk.item.arguments !== undefined ? chunk.item.arguments : chunk.item.input;
          const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '');

          let pt = ctx.pendingTools.get(key);
          if (!pt && (itemId || callId)) {
            for (const existing of ctx.pendingTools.values()) {
              if ((itemId && existing.id === itemId) || (callId && existing.id === callId)) {
                pt = existing;
                break;
              }
            }
          }
          if (pt) {
            if (callId || itemId) pt.id = callId || itemId;
            if (chunk.item.name) pt.name = chunk.item.name;
            if (args) pt.args = args;
          } else {
            ctx.pendingTools.set(key, {
              id: callId || itemId,
              name: chunk.item.name || '',
              args
            });
          }
          return true;
        }
      }

      if (
        (chunk.type === 'response.function_call_arguments.delta' ||
          chunk.type === 'response.custom_tool_call_input.delta') &&
        chunk.delta
      ) {
        const key = chunk.item_id || `idx_${chunk.output_index ?? ''}`;
        let pt = ctx.pendingTools.get(key);
        if (!pt && chunk.item_id) {
          for (const existing of ctx.pendingTools.values()) {
            if (existing.id === chunk.item_id) {
              pt = existing;
              break;
            }
          }
        }
        if (pt) {
          pt.args += chunk.delta;
        } else {
          ctx.pendingTools.set(key, { id: chunk.item_id || key, name: '', args: chunk.delta });
        }
        return true;
      }

      if (
        chunk.type === 'response.function_call_arguments.done' ||
        chunk.type === 'response.custom_tool_call_input.done'
      ) {
        const key = chunk.item_id || chunk.call_id || `idx_${chunk.output_index ?? ''}`;
        let pt = ctx.pendingTools.get(key);
        if (!pt && (chunk.item_id || chunk.call_id)) {
          for (const existing of ctx.pendingTools.values()) {
            if ((chunk.item_id && existing.id === chunk.item_id) || (chunk.call_id && existing.id === chunk.call_id)) {
              pt = existing;
              break;
            }
          }
        }
        const rawArgs = chunk.arguments !== undefined ? chunk.arguments : chunk.input;
        const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '');
        if (pt) {
          if (args) pt.args = args;
          if (chunk.name) pt.name = chunk.name;
          if (chunk.call_id) pt.id = chunk.call_id;
        } else {
          ctx.pendingTools.set(key, {
            id: chunk.call_id || chunk.item_id || '',
            name: chunk.name || '',
            args
          });
        }
        return true;
      }

      // 5. Output item done
      if (chunk.type === 'response.output_item.done' && chunk.item) {
        if (chunk.item.type === 'message') {
          // If no streaming deltas were received, fallback to complete message text snapshot
          if (ctx.textSegments.length === 0 && Array.isArray(chunk.item.content)) {
            for (const c of chunk.item.content) {
              if (c && (c.type === 'text' || c.type === 'output_text') && c.text) {
                ctx.textSegments.push(c.text);
              }
            }
          }
          return true;
        }
        if (chunk.item.type === 'function_call' || chunk.item.type === 'custom_tool_call') {
          const callId = chunk.item.call_id || '';
          const itemId = chunk.item.id || '';
          const key = itemId || callId || `idx_${chunk.output_index ?? ''}`;
          let pt = ctx.pendingTools.get(key);
          if (!pt && (itemId || callId)) {
            for (const existing of ctx.pendingTools.values()) {
              if ((itemId && existing.id === itemId) || (callId && existing.id === callId)) {
                pt = existing;
                break;
              }
            }
          }
          const rawArgs = chunk.item.arguments !== undefined ? chunk.item.arguments : chunk.item.input;
          const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '');
          if (pt) {
            if (callId || itemId) pt.id = callId || itemId;
            if (chunk.item.name) pt.name = chunk.item.name;
            if (args) pt.args = args;
          } else {
            ctx.pendingTools.set(key, {
              id: callId || itemId,
              name: chunk.item.name || '',
              args
            });
          }
          return true;
        }
      }

      // 6. Response completed or done
      if (chunk.type === 'response.completed' || chunk.type === 'response.done' || chunk.type === 'response.failed' || chunk.type === 'response.incomplete' || chunk.object === 'response') {
        // Terminal status supersedes the earlier response.created/in_progress snapshot.
        ctx.finishReason = chunk.response?.status || chunk.status || 'completed';
        const outputList = chunk.response?.output || chunk.output;
        if (Array.isArray(outputList)) {
          // A terminal snapshot is authoritative, including multiple output
          // items. It replaces accumulated deltas only in the parsed view.
          const text = outputList.filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content || []).filter((part: any) => part.type === 'output_text' || part.type === 'text')
            .map((part: any) => part.text || '').join('');
          const thinking = outputList.filter((item: any) => item.type === 'reasoning')
            .flatMap((item: any) => item.summary || item.content || []).map((part: any) => part.text || '').filter(Boolean);
          if (text) ctx.textSegments = [text];
          if (thinking.length) ctx.thinkingSegments = thinking;
          for (const item of outputList) {
            if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              const callId = item.call_id || '';
              const itemId = item.id || '';
              const key = itemId || callId || `out_${item.name}`;
              let pt = ctx.pendingTools.get(key);
              if (!pt && (itemId || callId)) {
                for (const existing of ctx.pendingTools.values()) {
                  if ((itemId && existing.id === itemId) || (callId && existing.id === callId)) {
                    pt = existing;
                    break;
                  }
                }
              }
              const rawArgs = item.arguments !== undefined ? item.arguments : item.input;
              const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '');
              if (pt) {
                if (callId || itemId) pt.id = callId || itemId;
                if (item.name) pt.name = item.name;
                if (args) pt.args = args;
              } else {
                ctx.pendingTools.set(key, {
                  id: callId || itemId,
                  name: item.name || '',
                  args
                });
              }
            } else if (item.type === 'message') {
              // Fallback for message text snapshot in completed event
              if (ctx.textSegments.length === 0 && Array.isArray(item.content)) {
                for (const c of item.content) {
                  if (c && (c.type === 'text' || c.type === 'output_text') && c.text) {
                    ctx.textSegments.push(c.text);
                  }
                }
              }
            }
          }
        }
        return true;
      }

      // 7. Non-streaming direct response with output array
      const directOutputs = chunk.output || chunk.response?.output;
      if (Array.isArray(directOutputs)) {
        for (const item of directOutputs) {
          if (item && item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c && (c.type === 'text' || c.type === 'output_text') && c.text) {
                if (ctx.textSegments.length === 0) {
                  ctx.textSegments.push(c.text);
                }
              }
            }
          }
        }
        if (ctx.textSegments.length > 0) return true;
      }

      // Catch-all for any other response.* SSE event to prevent falling into chat completions
      if (typeof chunk.type === 'string' && chunk.type.startsWith('response.')) {
        return true;
      }

      return false;
    }
  },

  // 4. OpenAI Chat Completions Standard & DeepSeek Protocol
  {
    id: 'openai_chat',
    name: 'OpenAI Standard Chat Completions & DeepSeek R1',
    provider: 'openai',
    priority: 100,
    textPaths: [
      'choices.[].delta.content',
      'choices.[].message.content'
    ],
    thinkingPaths: [
      'choices.[].delta.reasoning_content',
      'choices.[].delta.reasoning',
      'choices.[].delta.thought',
      'choices.[].message.reasoning_content'
    ],
    finishReasonPaths: [
      'choices.[].finish_reason'
    ],
    usage: {
      input_tokens: ['usage.prompt_tokens'],
      output_tokens: ['usage.completion_tokens'],
      cached_tokens: ['usage.prompt_tokens_details.cached_tokens'],
      thinking_tokens: ['usage.completion_tokens_details.reasoning_tokens'],
      total_tokens: ['usage.total_tokens']
    },
    customChunkHandler: (chunk: any, ctx: ExtractionContext) => {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta || choice?.message;

      // Streaming tool calls
      if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idxKey = `tc_idx_${tc.index ?? 0}`;
          const existing = ctx.pendingTools.get(idxKey);
          const fnName = tc.function?.name || '';
          const fnArgs = tc.function?.arguments || '';
          if (existing) {
            if (tc.id && !existing.id) existing.id = tc.id;
            if (fnName) existing.name = fnName;
            if (fnArgs) existing.args += fnArgs;
          } else {
            ctx.pendingTools.set(idxKey, {
              id: tc.id || '',
              name: fnName,
              args: fnArgs
            });
          }
        }
      }
      return false;
    }
  }
];
