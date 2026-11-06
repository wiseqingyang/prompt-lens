/**
 * Schema Registry for PromptLens Protocol Engine
 * Manages built-in and user-customized declarative schemas.
 * Drives extraction across streaming/batched JSON chunks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProviderType } from '../types';
import { DeclarativeSchemaRule, ExtractionContext, CustomSchemaConfig, isTokenCount } from './types';
import { BUILTIN_SCHEMAS } from './builtin';
import { queryPath, queryFirst } from './pathQuery';
import { probeChunks } from './probe';

export class SchemaRegistry {
  private schemas: DeclarativeSchemaRule[] = [];
  private customSchemasPath: string;

  constructor(customSchemasPath?: string) {
    this.customSchemasPath = customSchemasPath || path.join(os.homedir(), '.prompt-lens', 'custom_schemas.json');
    this.reset();
  }

  public reset(): void {
    this.schemas = [...BUILTIN_SCHEMAS];
    this.loadCustomSchemas();
  }

  public register(schema: DeclarativeSchemaRule): void {
    // Unregister existing schema with same id if any
    this.schemas = this.schemas.filter((s) => s.id !== schema.id);
    this.schemas.push(schema);
    // Sort by priority descending
    this.schemas.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  public getSchemas(provider?: ProviderType): DeclarativeSchemaRule[] {
    if (!provider || provider === 'unknown') {
      return [...this.schemas];
    }
    return this.schemas.filter((s) => s.provider === provider);
  }

  public loadCustomSchemas(filePath?: string): number {
    const targetPath = filePath || this.customSchemasPath;
    if (!fs.existsSync(targetPath)) return 0;

    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      const parsed: CustomSchemaConfig[] = JSON.parse(content);
      if (!Array.isArray(parsed)) return 0;

      let loaded = 0;
      for (const item of parsed) {
        if (!item.id || !item.textPaths || !item.provider) continue;
        const rule: DeclarativeSchemaRule = {
          id: item.id,
          name: item.name || item.id,
          provider: item.provider,
          priority: 200, // Custom schemas override built-ins by default
          textPaths: item.textPaths,
          thinkingPaths: item.thinkingPaths || [],
          finishReasonPaths: item.finishReasonPaths || [],
          usage: item.usage
        };
        this.register(rule);
        loaded++;
      }
      return loaded;
    } catch {
      return 0;
    }
  }

  /**
   * Execute extraction across parsed JSON chunks using matching schemas.
   */
  public extract(chunks: any[], provider: ProviderType): ExtractionContext {
    const ctx: ExtractionContext = {
      provider,
      confidence: 'exact',
      textSegments: [],
      thinkingSegments: [],
      toolCalls: [],
      pendingTools: new Map(),
      finishReason: '',
      inTok: 0,
      outTok: 0,
      cachedTok: 0,
      thinkingTok: 0,
      totalTok: 0,
      hasUsage: false,
      hasTotalUsage: false,
      rawDetails: {}
    };

    const candidateSchemas = this.getSchemas(provider);

    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;

      for (const schema of candidateSchemas) {
        // Run custom handler if provided
        let handled = false;
        if (schema.customChunkHandler) {
          handled = schema.customChunkHandler(chunk, ctx);
        }

        // Extract usage
        if (schema.usage) {
          const u = schema.usage;
          if (u.input_tokens) {
            const v = queryFirst(chunk, u.input_tokens);
            if (isTokenCount(v)) { ctx.inTok = v; ctx.hasUsage = true; }
          }
          if (u.output_tokens) {
            const v = queryFirst(chunk, u.output_tokens);
            if (isTokenCount(v)) { ctx.outTok = v; ctx.hasUsage = true; }
          }
          if (u.cached_tokens) {
            const v = queryFirst(chunk, u.cached_tokens);
            if (isTokenCount(v)) { ctx.cachedTok = v; ctx.hasUsage = true; }
          }
          if (u.thinking_tokens) {
            const v = queryFirst(chunk, u.thinking_tokens);
            if (isTokenCount(v)) { ctx.thinkingTok = v; ctx.hasUsage = true; }
          }
          if (u.total_tokens) {
            const v = queryFirst(chunk, u.total_tokens);
            if (isTokenCount(v)) { ctx.totalTok = v; ctx.hasUsage = true; ctx.hasTotalUsage = true; }
          }
        }

        // Extract text (only if custom handler did not take exclusive ownership)
        if (!handled && schema.textPaths && schema.textPaths.length) {
          for (const tp of schema.textPaths) {
            const texts = queryPath(chunk, tp);
            for (const t of texts) {
              if (typeof t === 'string' && t) {
                ctx.textSegments.push(t);
              }
            }
          }
        }

        // Extract thinking (only if custom handler did not take exclusive ownership)
        if (!handled && schema.thinkingPaths && schema.thinkingPaths.length) {
          for (const tp of schema.thinkingPaths) {
            const thinkings = queryPath(chunk, tp);
            for (const t of thinkings) {
              if (typeof t === 'string' && t) {
                ctx.thinkingSegments.push(t);
              }
            }
          }
        }

        // Extract finish reason
        if (!ctx.finishReason && schema.finishReasonPaths && schema.finishReasonPaths.length) {
          const fr = queryFirst(chunk, schema.finishReasonPaths);
          if (typeof fr === 'string' && fr) {
            ctx.finishReason = fr;
          }
        }

        // Record metadata
        const meta = chunk.response?.usageMetadata || chunk.usageMetadata || chunk.usage || chunk.response?.usage;
        if (meta && typeof meta === 'object') {
          ctx.rawDetails = { ...ctx.rawDetails, ...meta };
        }

        // If the chunk was completely handled by high-priority custom handler, don't cascade to lower-priority schemas
        if (handled) {
          break;
        }
      }
    }

    // Finalize pending streaming tools into toolCalls array
    const seenToolIds = new Set<string>();
    for (const [, pt] of ctx.pendingTools.entries()) {
      if (pt.name || pt.args) {
        if (pt.id && seenToolIds.has(pt.id)) continue;
        if (pt.id) seenToolIds.add(pt.id);
        ctx.toolCalls.push({
          id: pt.id,
          name: pt.name || 'tool',
          args: pt.args
        });
      }
    }

    // Heuristic Probe fallback: If predefined schemas extracted neither text nor tool calls, activate Duck-Typing probe
    if (ctx.textSegments.length === 0 && ctx.toolCalls.length === 0 && chunks.length > 0) {
      // An empty Responses output is valid (e.g. generate:false context updates).
      // Never infer output from the response envelope's echoed configuration.
      const isResponses = chunks.some((chunk) => chunk && typeof chunk === 'object' &&
        ((typeof chunk.type === 'string' && chunk.type.startsWith('response.')) ||
          chunk.object === 'response'));
      if (!isResponses) probeChunks(chunks.filter(chunk => !chunk?.error && chunk?.type !== 'error'), ctx);
    }

    return ctx;
  }
}

export const schemaRegistry = new SchemaRegistry();
