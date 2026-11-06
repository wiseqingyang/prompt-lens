/**
 * PromptLens Declarative Protocol Schema Definitions
 * Enables zero-code adaptation for new LLM providers, proxies, and agent protocols.
 */

import { ProviderType, TokenUsage } from '../types';

export interface UsageMapping {
  input_tokens?: string | string[];
  output_tokens?: string | string[];
  cached_tokens?: string | string[];
  thinking_tokens?: string | string[];
  total_tokens?: string | string[];
}

export interface ExtractedToolCall {
  id?: string;
  name: string;
  args: any;
}

export interface ExtractionContext {
  provider: ProviderType;
  confidence: 'exact' | 'heuristic';
  textSegments: string[];
  thinkingSegments: string[];
  toolCalls: ExtractedToolCall[];
  pendingTools: Map<string, { id: string; name: string; args: string }>;
  finishReason: string;
  inTok: number;
  outTok: number;
  cachedTok: number;
  thinkingTok: number;
  totalTok: number;
  rawDetails: Record<string, any>;
  hasUsage: boolean;
  hasTotalUsage: boolean;
}

export interface DeclarativeSchemaRule {
  id: string;
  name: string;
  provider: ProviderType;
  priority?: number; // Higher number = higher matching priority
  match?: {
    hostPatterns?: string[];
    pathPatterns?: string[];
    headerPatterns?: Record<string, string>;
    chunkPredicates?: Array<(chunk: any) => boolean>;
  };
  textPaths?: string[];
  thinkingPaths?: string[];
  finishReasonPaths?: string[];
  usage?: UsageMapping;
  // Optional declarative tool extraction rule
  tools?: {
    listPath: string; // e.g. "response.candidates.[].content.parts"
    idPath?: string;
    namePath: string; // e.g. "functionCall.name"
    argsPath: string; // e.g. "functionCall.args"
    filterPredicate?: (item: any) => boolean;
  };
  // Optional custom chunk handler for protocols requiring stateful stream stitching (e.g. Claude / Codex delta assembly)
  customChunkHandler?: (chunk: any, ctx: ExtractionContext) => boolean;
}

export interface CustomSchemaConfig {
  id: string;
  name: string;
  provider: ProviderType;
  textPaths: string[];
  thinkingPaths?: string[];
  finishReasonPaths?: string[];
  usage?: {
    input_tokens?: string | string[];
    output_tokens?: string | string[];
    cached_tokens?: string | string[];
    thinking_tokens?: string | string[];
    total_tokens?: string | string[];
  };
}

/** Only non-negative integer counts are valid protocol usage. */
export const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
