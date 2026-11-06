import http from 'http';
import { isExcludedBackgroundRequest } from '../shared/auditScope';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { app } from 'electron';
import { StorageEngine } from './storage';
import { detectAgent, detectProvider, extractRequestInfo, extractResponseInfo } from './parser';
import { extractUserPromptFromRecord, resolveSessionIdentity, resolveRequestParents } from './session';
import { ProxyAdapter, ProxyStatus } from './adapter';
import { redactAddress, socketMessages } from '../shared/communication';
import { parseJsonChunks } from './parser';
import { isWebFetchRequest } from '../shared/protocol';
import { codexResponseModel, modelResponseEvents } from './codex-model';
import { workbuddyRequestSummary } from '../shared/workbuddyPrompt';

export interface CoreOptions {
  listenPort?: number;       // Go proxy listen port, default 8899
  upstream?: string;         // Optional upstream proxy; defaults to direct
  receiverPort?: number;     // Electron internal receiver port, default 8897
  customDomains?: string[];  // Custom interception domains
  secret?: string;           // Shared authentication secret
  onRecordSaved?: (recordId: number) => void;
}

export class CoreManager implements ProxyAdapter {
  private receiverServer: http.Server | null = null;
  private coreProcess: ChildProcess | null = null;
  private isRunning: boolean = false;
  private receiverPort: number;
  private proxyPort: number;
  private upstream: string;
  private customDomains: string[] = [];
  private secret: string;

  private inFlightCaptures: number = 0;

  constructor(
    private storage: StorageEngine,
    private options: CoreOptions = {}
  ) {
    this.receiverPort = options.receiverPort !== undefined ? options.receiverPort : 8897;
    this.proxyPort = options.listenPort !== undefined ? options.listenPort : 8899;
    this.upstream = options.upstream ?? '';
    this.customDomains = options.customDomains ? [...options.customDomains] : [];
    this.secret = options.secret || process.env.PROMPT_LENS_SECRET || process.env.LLM_LENS_SECRET || '';
  }

  public getSecret(): string {
    return this.secret;
  }

  public getStatus(): ProxyStatus {
    return {
      listenPort: this.proxyPort,
      upstream: redactAddress(this.upstream),
      isCoreRunning: this.isRunning,
      status: this.isRunning ? 'auditing' : 'offline'
    };
  }

  public async drain(timeoutMs: number = 3000): Promise<void> {
    const start = Date.now();
    while (this.inFlightCaptures > 0 && (Date.now() - start) < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  public async start(): Promise<void> {
    try {
      await this.startReceiver();
      await this.startCoreProcess();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private async stopCoreProcessOnly(): Promise<void> {
    if (this.coreProcess) {
      const proc = this.coreProcess;
      this.coreProcess = null;
      try {
        proc.stdin?.end();
        await new Promise<void>((resolve) => {
          let resolved = false;
          const done = () => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          };
          proc.once('exit', done);
          setTimeout(() => {
            try {
              proc.kill('SIGTERM');
            } catch {}
          }, 800);
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {}
            done();
          }, 1500);
        });
      } catch {}
    }
    this.isRunning = false;
  }

  public async restart(newOptions?: Partial<CoreOptions>): Promise<void> {
    console.log('[CoreManager] Reloading Go proxy core...');
    if (newOptions) {
      if (newOptions.listenPort !== undefined) this.proxyPort = newOptions.listenPort;
      if (newOptions.upstream !== undefined) this.upstream = newOptions.upstream;
      if (newOptions.customDomains !== undefined) this.customDomains = [...newOptions.customDomains];
    }
    await this.drain(1500);
    await this.stopCoreProcessOnly();
    await this.startCoreProcess();
    console.log(`[CoreManager] Proxy core ready on 127.0.0.1:${this.proxyPort}, upstream: ${redactAddress(this.upstream) || 'DIRECT'}`);
  }

  public async stop(): Promise<void> {
    await this.stopCoreProcessOnly();

    if (this.receiverServer) {
      await new Promise<void>((resolve) => {
        this.receiverServer!.close(() => resolve());
      });
      this.receiverServer = null;
    }
    this.isRunning = false;
    console.log('[CoreManager] Receiver and Go core stopped');
  }

  private startReceiver(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.receiverServer = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/api/capture') {
          this.inFlightCaptures++;
          let tracked = true;
          const releaseFlight = () => {
            if (tracked) {
              tracked = false;
              this.inFlightCaptures--;
            }
          };
          res.on('finish', releaseFlight);
          res.on('close', releaseFlight);

          // 1. Content-Type 限制
          const contentType = req.headers['content-type'] || '';
          if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
            res.writeHead(415, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unsupported Media Type: must be application/json' }));
            return;
          }

          // 2. 凭证校验
          if (this.secret) {
            const clientSecret = req.headers['x-prompt-lens-secret'] ||
              (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
            if (clientSecret !== this.secret) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unauthorized: Invalid capture secret' }));
              return;
            }
          }

          // 3. 避免字符串拼接损坏跨 TCP 块 UTF-8，使用 Buffer 收集并限制最大正文 32MB
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

          req.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > MAX_CAPTURE_BYTES) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payload Too Large' }));
              req.destroy();
              return;
            }
            chunks.push(buf);
          });

          req.on('end', () => {
            if (res.writableEnded) return;

            const fullBuffer = Buffer.concat(chunks);
            let rawJson = '';
            try {
              rawJson = fullBuffer.toString('utf8');
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid UTF-8 encoding' }));
              return;
            }

            let data: any;
            try {
              data = JSON.parse(rawJson);
            } catch (err: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
              return;
            }

            // 4. 解析入库校验，持久化成功后再发送 200 ACK
            try {
              const recordId = this.handleCapturePayload(data);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, id: recordId }));
            } catch (err: any) {
              console.error('[CoreManager] Persistence failed:', err.message || err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Storage persistence failure' }));
            }
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.receiverServer.on('error', (err) => {
        console.error('[CoreManager] Failed to start receiver:', err);
        reject(err);
      });

      this.receiverServer.listen(this.receiverPort, '127.0.0.1', () => {
        console.log(`\x1b[1;36m[CoreManager]\x1b[0m Capture receiver started on \x1b[1;33m127.0.0.1:${this.receiverPort}\x1b[0m`);
        resolve();
      });
    });
  }


  private async startCoreProcess(): Promise<void> {
    // Locate Go binary:
    // 1. Packaged: process.resourcesPath/bin/prompt-lens-core
    // 2. Dev mode: project_root/resources/bin/prompt-lens-core
    const primaryBin = process.platform === 'win32' ? 'prompt-lens-core.exe' : 'prompt-lens-core';
    const candidates = [
      path.join(process.resourcesPath || '', 'bin', primaryBin),
      path.join(app.getAppPath(), 'resources', 'bin', primaryBin),
      path.join(__dirname, '../../resources/bin', primaryBin),
    ];
    let binPath = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];

    if (!fs.existsSync(binPath)) {
      throw new Error(`未在 ${binPath} 找到 Go 核心，请先运行 npm run build:core`);
    }

    // Make executable
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {}

    const callbackUrl = `http://127.0.0.1:${this.receiverPort}/api/capture`;
    const args = [
      '-port', String(this.proxyPort),
      '-upstream', this.upstream,
      '-callback', callbackUrl
    ];
    if (this.customDomains && this.customDomains.length > 0) {
      args.push('-custom-domains', this.customDomains.join(','));
    }

    console.log(`\x1b[1;32m[CoreManager]\x1b[0m Spawning Go proxy core: \x1b[1;35m${binPath}\x1b[0m`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PROMPT_LENS_SECRET: this.secret, LLM_LENS_SECRET: this.secret }
      });
      this.coreProcess = child;

      let output = '';
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error('Go 核心启动超时，未收到端口就绪信号'));
      }, 15000);
      child.stdout?.on('data', (data) => {
        process.stdout.write(data);
        output = (output + data.toString()).slice(-4096);
        const readyPort = `127.0.0.1:${this.proxyPort}\n`;
        if (!ready && (output.includes(`PROMPT_LENS_CORE_READY ${readyPort}`) || output.includes(`LLM_LENS_CORE_READY ${readyPort}`))) {
          ready = true;
          this.isRunning = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr?.on('data', (data) => process.stderr.write(data));
      child.on('error', (err) => {
        clearTimeout(timer);
        this.isRunning = false;
        reject(err);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        this.isRunning = false;
        console.log(`[CoreManager] Go core exited: code=${code}, signal=${signal}`);
        if (!ready) reject(new Error(`Go 核心在就绪前退出 (code=${code}, signal=${signal})，请检查端口占用与证书`));
      });
    });
  }

  public handleCapturePayload(data: any): number {
    const urlPath = data.url_path || '';
    const pathLower = urlPath.toLowerCase();

    if (isExcludedBackgroundRequest(data)) return 0;

    // Filter noise RPCs
    if (
      pathLower.includes('/log') ||
      pathLower.includes('listexperiments') ||
      pathLower.includes('loadcodeassist') ||
      pathLower.includes('fetchuserinfo') ||
      pathLower.includes('fetchavailablemodels') ||
      pathLower.includes('optimizationguide')
    ) {
      return 0;
    }

    // Secondary defense-in-depth header sanitization
    const rawHeaders = data.request_headers || {};
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      const lk = k.toLowerCase();
      if (lk === 'authorization') {
        const valStr = String(v);
        if (valStr.toLowerCase().startsWith('bearer ')) {
          reqHeaders[lk] = 'Bearer [REDACTED]';
        } else if (valStr.toLowerCase().startsWith('basic ')) {
          reqHeaders[lk] = 'Basic [REDACTED]';
        } else {
          reqHeaders[lk] = '[REDACTED]';
        }
      } else if (
        lk === 'proxy-authorization' ||
        lk === 'cookie' ||
        lk === 'set-cookie' ||
        lk === 'x-api-key' ||
        lk === 'api-key' ||
        lk === 'anthropic-api-key' ||
        lk === 'x-goog-api-key'
      ) {
        reqHeaders[lk] = '[REDACTED]';
      } else {
        reqHeaders[lk] = String(v);
      }
    }

    const reqBody = data.request_body || '';
    const resBody = data.response_body || '';
    const method = data.method || 'POST';
    const statusCode = data.status_code || 200;
    const durationMs = data.duration_ms || 0;

    const provider = detectProvider(urlPath, reqHeaders);
    const reqInfo = extractRequestInfo(provider, reqBody, urlPath);
    const agentName = detectAgent(reqHeaders, urlPath, reqInfo.raw_json);
    const webFetch = isWebFetchRequest(urlPath);
    const { usage, responseText, thinkingText, toolCalls, finishReason } = extractResponseInfo(provider, resBody, urlPath, data.body_format);
    let responseId = '';
    let responseEvents: any[] = [];
    if (data.body_format === 'ws-messages-v1') {
      if (resBody) { try { responseEvents = socketMessages(resBody).filter(m => m.direction === 'server').map(m => { try { return JSON.parse(m.payload); } catch { return {}; } }); } catch {} }
    } else responseEvents = parseJsonChunks(resBody);
    for (const chunk of responseEvents) {
      const response = chunk.response || (chunk.object === 'response' ? chunk : null);
      if (typeof response?.id === 'string') responseId = response.id;
    }
    const resolvedModel = codexResponseModel(agentName, urlPath, reqInfo.model, modelResponseEvents(resBody, data.body_format)) ?? reqInfo.model;
    const requestId = data.request_id ? String(data.request_id) : undefined;
    const eventId = data.event_id ? String(data.event_id) : undefined;
    const sequence = Number.isInteger(data.sequence) ? data.sequence : 1;
    const identity = resolveSessionIdentity(data.attribution === 'connection' ? {} : reqHeaders, data.attribution === 'connection' ? {} : reqInfo.raw_json, provider, reqInfo.model, {
      request_id: requestId, event_id: eventId, agent_name: agentName, url_path: urlPath,
      transport: data.transport, schemaVersion: data.schema_version || '2.0.0', attribution: data.attribution,
      method: data.method, statusCode: data.status_code
    });
    const parents = resolveRequestParents(reqHeaders, reqInfo.raw_json, data);

    if (
      reqInfo.messages.length === 0 &&
      usage.total_tokens === 0 &&
      !webFetch &&
      !pathLower.includes('generatecontent') &&
      !pathLower.includes('messages') &&
      !pathLower.endsWith('/responses') &&
      !pathLower.includes('completions')
    ) {
      return 0;
    }

    let promptSummary = '';
    if (webFetch) {
      promptSummary = `网页抓取（${reqInfo.raw_json?.liveFetch ? '实时' : '缓存'}） | ${reqInfo.raw_json?.url || ''}`;
    } else if (provider === 'openai' && reqInfo.raw_json?.generate === false) {
      promptSummary = '上下文更新（不生成回复）';
    } else if (reqInfo.messages.length) {
      const last = reqInfo.messages[reqInfo.messages.length - 1];
      let lastMsg = (last.text || '').slice(0, 300).replace(/\n/g, ' ').trim();
      if ((!lastMsg || last.role === 'tool') && last.tools) {
        const names = last.tools.map((t: any) => t.name || 'tool').slice(0, 2);
        lastMsg = `[Tool Result: ${names.join(', ')}]`;
      }
      promptSummary = lastMsg;
    }

    let responsePreview = (responseText || '').slice(0, 200).replace(/\n/g, ' ');
    if (toolCalls.length && !responsePreview) {
      const names = toolCalls.map((t: any) => t.name || 'tool').slice(0, 3);
      responsePreview = `[Tool Call] ${names.join(', ')}`;
    }

    const userPrompt = webFetch ? '' : extractUserPromptFromRecord({
      agent_name: agentName,
      request_headers: reqHeaders,
      request_body: reqBody,
      prompt_summary: promptSummary
    });
    if (agentName === 'WorkBuddy') promptSummary = workbuddyRequestSummary(reqHeaders, reqInfo.raw_json)?.text ?? promptSummary;

    const isSubagent = (agentName.includes('WebSearch') || (reqBody && reqBody.includes('"web_search"'))) ? 1 : 0;
    const subagentType = isSubagent ? 'web_search' : '';

    const recordId = this.storage.insertRecord({
      schema_version: data.schema_version || '2.0.0',
      transport: data.transport || '',
      address: redactAddress(data.address || urlPath),
      body_format: data.body_format || '',
      body_encoding: data.body_encoding || '',
      connection_id: data.connection_id || '',
      stream_id: data.stream_id || '',
      attribution: data.attribution || '',
      response_id: responseId,
      previous_response_id: typeof reqInfo.raw_json?.previous_response_id === 'string' ? reqInfo.raw_json.previous_response_id : '',
      response_headers: data.response_headers || {},
      event_id: eventId,
      request_id: requestId,
      ...parents,
      sequence,
      core_instance_id: data.core_instance_id || '',
      capture_status: data.capture_status || 'complete',
      bytes_wire: data.bytes_wire || 0,
      bytes_captured: data.bytes_captured || 0,
      truncated_reason: data.truncated_reason || '',
      session_id: identity.id,
      session_id_source: identity.source,
      session_confidence: identity.confidence,
      session_namespace: identity.namespace,
      thread_id: identity.thread_id,
      turn_id: identity.turn_id || data.turn_id || data.turnId || reqHeaders['x-codex-turn-id'],
      agent_name: agentName,
      provider,
      model: resolvedModel,
      method,
      url_path: urlPath,
      status_code: statusCode,
      duration_ms: durationMs,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      thinking_tokens: usage.thinking_tokens,
      total_tokens: usage.total_tokens,
      cache_ratio: usage.cache_ratio,
      system_prompt: reqInfo.system_prompt,
      prompt_summary: promptSummary,
      user_prompt: userPrompt,
      response_preview: responsePreview,
      response_text: responseText || '',
      thinking_text: thinkingText || '',
      is_subagent: isSubagent,
      subagent_type: subagentType,
      request_headers: reqHeaders,
      request_body: reqBody,
      response_body: resBody,
      raw_usage: usage.raw_details,
      token_source: data.attribution === 'connection' ? 'unavailable' : usage.token_source,
      finish_reason: finishReason,
      tool_calls_json: JSON.stringify(toolCalls || [])
    });


    if (this.options.onRecordSaved) {
      this.options.onRecordSaved(recordId);
    }
    return recordId;
  }
}
