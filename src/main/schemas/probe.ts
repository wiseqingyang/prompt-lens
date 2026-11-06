/**
 * PromptLens Adaptive Heuristic Protocol Probe (Duck-Typing)
 * Automatically unpacks text, chain-of-thought, and tool calls from unknown or private protocols.
 * Guarantees zero-blank-screen and graceful degradation when no predefined schema matches.
 */

import { ExtractionContext } from './types';

// Static precompiled regexes for maximum throughput
const RE_NAME = /^(name|tool_name|function_name|func|tool)$/i;
const RE_ARGS = /^(args|arguments|input|parameters|params|payload)$/i;
const RE_ID = /^(id|call_id|tool_call_id|invocation_id)$/i;

const RE_THINKING = /^(thought|thoughts|thinking|reasoning|reasoning_content|thought_process|chain_of_thought|inner_thoughts)$/i;
const RE_TEXT = /^(text|content|output|message|delta|answer|reply|generation|result)$/i;
const RE_FINISH = /^(finish_reason|finishReason|stop_reason|status|state)$/i;

const METADATA_STRINGS = new Set([
  'stop',
  'completed',
  'done',
  'finished',
  'user',
  'assistant',
  'system',
  'model',
  'developer',
  'tool',
  'function',
  'chat.completion',
  'chat.completion.chunk',
  'response.done',
  'response.completed'
]);

function isMetadataString(str: string): boolean {
  return METADATA_STRINGS.has(str.trim().toLowerCase());
}

function probeObject(
  obj: any,
  ctx: ExtractionContext,
  visited: Set<any>,
  depth: number
): void {
  if (!obj || typeof obj !== 'object' || depth > 12 || visited.has(obj)) {
    return;
  }
  visited.add(obj);

  // Definitions describe available tools; their JSON schemas are not call arguments.
  if (obj.type === 'additional_tools' ||
      (obj.parameters && typeof obj.parameters === 'object' &&
       (obj.parameters.type === 'object' || obj.parameters.properties || obj.parameters.$schema))) {
    return;
  }

  // 1. Tool Call detection: object with both a function/tool name and argument payload
  const keys = Object.keys(obj);
  const nameKey = keys.find((k) => RE_NAME.test(k));
  const argsKey = keys.find((k) => RE_ARGS.test(k));

  if (nameKey && argsKey && typeof obj[nameKey] === 'string' && obj[nameKey].trim()) {
    const idKey = keys.find((k) => RE_ID.test(k));
    ctx.toolCalls.push({
      id: idKey ? String(obj[idKey]) : '',
      name: String(obj[nameKey]),
      args: obj[argsKey]
    });
    return;
  }

  // 2. Traversal
  for (const k of keys) {
    if (k === 'tools' || k === 'tool_choice' || k === 'instructions') continue;
    const val = obj[k];
    if (val === undefined || val === null) continue;

    // Check finish reason
    if (typeof val === 'string' && RE_FINISH.test(k) && !ctx.finishReason) {
      ctx.finishReason = val;
    }

    // Check thinking / reasoning
    if (RE_THINKING.test(k)) {
      if (typeof val === 'string' && val.trim()) {
        ctx.thinkingSegments.push(val);
        continue;
      }
    }

    // Check text / message content
    if (RE_TEXT.test(k)) {
      if (typeof val === 'string' && val.trim() && !isMetadataString(val)) {
        ctx.textSegments.push(val);
        continue;
      }
    }

    // Recurse into children objects or arrays
    if (typeof val === 'object') {
      probeObject(val, ctx, visited, depth + 1);
    }
  }
}

/**
 * Executes heuristic Duck-Typing extraction on unstructured or unknown JSON chunks.
 * Activates when predefined schemas fail to extract text or tool calls.
 * Returns true if any meaningful LLM output was successfully unpacked.
 */
export function probeChunks(chunks: any[], ctx: ExtractionContext): boolean {
  const visited = new Set<any>();

  for (const chunk of chunks) {
    probeObject(chunk, ctx, visited, 0);
  }

  const foundData =
    ctx.textSegments.length > 0 ||
    ctx.toolCalls.length > 0 ||
    ctx.thinkingSegments.length > 0;

  if (foundData) {
    ctx.confidence = 'heuristic';
  }

  return foundData;
}
