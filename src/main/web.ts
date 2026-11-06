/**
 * PromptLens Embedded Fastify Web Server (Port 8088)
 * Serves the Dashboard UI and REST API for browser/CLI access and Electron renderer IPC.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { StorageEngine } from './storage';
import { CertManager } from './cert';
import { CoreManager } from './core';
import { buildProxyEnv } from './proxy-env';
import { clusterRecordsIntoTasks, dissectPromptAnatomy, paginateSessions } from './session';
import { createSanitizedFixture } from './sanitizer';

import { ConfigManager, validateConfigPatch, proxyConfigurationChanged } from './config';

export class WebServer {
  public app: FastifyInstance;
  private secret: string;

  constructor(
    private storage: StorageEngine,
    private certManager: CertManager,
    private port: number = 8088,
    private coreManager?: CoreManager,
    secret?: string,
    private configManager?: ConfigManager
  ) {
    this.secret = secret || process.env.PROMPT_LENS_SECRET || process.env.LLM_LENS_SECRET || '';
    this.app = Fastify({ logger: false });
    this.setupSecurityHooks();
    this.setupRoutes();
  }

  private setupSecurityHooks(): void {
    this.app.addHook('onRequest', async (req, reply) => {
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'no-store');
      const host = req.headers.host || '';
      let base: URL;
      try {
        base = new URL(`http://${host}`);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || !/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) {
          return reply.code(403).send({ error: 'Forbidden: Invalid Host header' });
        }
      } catch {
        return reply.code(403).send({ error: 'Forbidden: Invalid Host header' });
      }
      const origin = req.headers.origin;
      if (origin && origin !== base.origin) {
        return reply.code(403).send({ error: 'Forbidden: Untrusted Origin' });
      }
      const url = new URL(req.url, base);
      const queryToken = url.searchParams.get('token');
      // Only the landing page accepts a bootstrap token; redirect before loading assets.
      if (this.secret && url.pathname === '/' && req.method === 'GET' && queryToken === this.secret) {
        reply.header('Set-Cookie', `prompt_lens_token=${this.secret}; Path=/; HttpOnly; SameSite=Strict`);
        return reply.code(303).header('Location', '/').send();
      }
      if (this.secret && url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
        const cookies = (req.headers.cookie || '').split(';').map(value => value.trim());
        const authenticated = req.headers['x-prompt-lens-secret'] === this.secret ||
          req.headers.authorization === `Bearer ${this.secret}` ||
          cookies.includes(`prompt_lens_token=${this.secret}`);
        if (!authenticated) return reply.code(401).send({ error: 'Unauthorized: Missing or invalid API secret' });
      }
    });
  }


  private setupRoutes(): void {
    const pageProperties = { limit: { type: 'integer', minimum: 1, maximum: 1000 }, offset: { type: 'integer', minimum: 0 } };
    const textField = { type: 'string', maxLength: 4096 };
    const idSchema = { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } };
    const pageSchema = { schema: { querystring: { type: 'object', properties: pageProperties } } };
    const recordsSchema = { schema: { querystring: { type: 'object', properties: { ...pageProperties, session_id: textField, search: textField, filter_type: textField, agent_name: textField } } } };
    const batchSchema = { schema: { body: { type: 'object', required: ['ids'], properties: {
      ids: { type: 'array', maxItems: 10000, items: { type: 'integer', minimum: 1 } }, includeRawBody: { type: 'boolean' }, lightweight: { type: 'boolean' }
    } } } };
    const appStaticDir = path.join(__dirname, '../renderer');
    const cwdStaticDir = path.join(process.cwd(), 'dist', 'renderer');

    let targetDir = '';
    if (fs.existsSync(appStaticDir)) {
      targetDir = appStaticDir;
    } else if (fs.existsSync(cwdStaticDir)) {
      targetDir = cwdStaticDir;
    }

    if (fs.existsSync(targetDir)) {
      this.app.register(fastifyStatic, {
        root: targetDir,
        prefix: '/'
      });
    }

    const healthHandler = async (_req: any, reply: any) => {
      const proxy = this.coreManager?.getStatus();
      const ready = proxy?.isCoreRunning === true;
      return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'offline', engine: 'electron-go', proxy });
    };

    this.app.get('/health', healthHandler);
    this.app.get('/api/health', healthHandler);

    this.app.get('/api/proxy-env', async () => {
      return { command: buildProxyEnv(this.coreManager?.getStatus().listenPort || 8899, this.certManager.getCertPaths().caCertPath, this.certManager.prepareAgentCaBundle()) };
    });

    this.app.get('/api/stats', async () => {
      return this.storage.getStats();
    });

    this.app.get('/api/stats/daily-activity', async (req) => {
      const query = req.query as any;
      return this.storage.getDailyTokenActivity(query?.agent);
    });

    this.app.get('/api/stats/day-model-usage', async (req) => {
      const query = req.query as any;
      return this.storage.getResolvedDayModelUsage(query?.date, query?.agent);
    });

    this.app.get('/api/stats/day-details', async (req) => {
      const query = req.query as any;
      return this.storage.getResolvedDayTokenDetails(query?.date, query?.agent);
    });

    this.app.get('/api/records', recordsSchema, async (req) => {
      const query = req.query as any;
      const records = this.storage.getRecords({
        limit: Number(query.limit) || 50,
        offset: Number(query.offset) || 0,
        sessionId: query.session_id,
        search: query.search,
        filterType: query.filter_type,
        agentName: query.agent_name
      });
      return { records };
    });

    this.app.get('/api/records/:id', idSchema, async (req, reply) => {
      const { id } = req.params as { id: string };
      const record = this.storage.getRecordById(Number(id));
      if (!record) {
        return reply.status(404).send({ error: 'Record not found' });
      }
      record.anatomy = dissectPromptAnatomy(record);
      return record;
    });

    this.app.post('/api/records/batch', batchSchema, async (req) => {
      const body = req.body as { ids?: number[]; includeRawBody?: boolean; lightweight?: boolean };
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      if (!ids.length) return { records: [] };
      const includeRaw = body?.includeRawBody !== undefined ? Boolean(body.includeRawBody) : false;
      const records = this.storage.getRecordsByIds(ids, { includeRawBody: includeRaw, lightweight: body?.lightweight }).map((record) => {
        return this.storage.attachTimelineDetail(record);
      });
      return { records };
    });

    this.app.get('/api/records/:id/history', idSchema, async req => this.storage.getRelatedHistory(Number((req.params as { id: string }).id)));

    this.app.get('/api/records/:id/fixture', idSchema, async (req, reply) => {
      const { id } = req.params as { id: string };
      const record = this.storage.getRecordById(Number(id));
      if (!record) {
        return reply.status(404).send({ error: 'Record not found' });
      }
      return createSanitizedFixture(record);
    });

    this.app.get('/api/sessions', pageSchema, async (req) => {
      const query = req.query as any;
      const limit = Number(query.limit) || 50;
      const offset = Number(query.offset) || 0;
      const sessions = await this.storage.getAttributedSessions();
      return paginateSessions(sessions, { limit, offset });
    });

    this.app.get('/api/db-info', async () => this.storage.getDbInfo());
    this.app.post('/api/maintenance/reclaim', async () => this.storage.reclaimSpace());
    this.app.post('/api/reset-usage', async () => { this.storage.resetUsage(); return { success: true }; });
    this.app.post('/api/delete-all-data', async () => { this.storage.deleteAllData(); return { success: true }; });

    this.app.post('/api/clear', async () => {
      this.storage.clearRecords();
      return { success: true };
    });

    this.app.get('/api/cert/status', async () => this.certManager.getStatus());

    this.app.post('/api/cert/install', async () => {
      return this.certManager.installToSystemStore();
    });

    this.app.get('/api/diagnostics', async () => {
      const coreStatus = this.coreManager ? this.coreManager.getStatus() : { status: 'offline', isCoreRunning: false, listenPort: 0, upstream: '' };
      const { caCertPath, exists } = this.certManager.getCertPaths();
      const fingerprint = this.certManager.getFingerprint();
      const queueStats = this.storage.getTruncatedAndDroppedStats();
      const recentErrors = this.storage.getRecentErrors(10);
      const sensitiveScan = this.storage.scanSensitiveRecords();

      return {
        core: coreStatus,
        cert: {
          fingerprint,
          caCertPath,
          exists
        },
        queue: queueStats,
        recentErrors,
        sensitiveScan
      };
    });

    this.app.post('/api/maintenance/sanitize', async () => {
      const result = this.storage.sanitizeHistoricalRecords();
      return { success: true, ...result };
    });

    this.app.get('/api/config', async () => {
      return this.configManager ? this.configManager.getConfig() : {};
    });

    this.app.post('/api/config', async (req, reply) => {
      const body = req.body as any;
      try { validateConfigPatch(body); } catch { return reply.code(400).send({ error: 'Invalid configuration' }); }
      if (this.configManager) {
        const previous = this.configManager.getConfig();
        const updated = this.configManager.save(body);
        if (this.coreManager && proxyConfigurationChanged(previous, updated)) {
          const effectiveUpstream = this.configManager.resolveEffectiveUpstream();
          await this.coreManager.restart({
            listenPort: updated.proxy.listenPort,
            upstream: effectiveUpstream,
            customDomains: updated.proxy.customDomains
          });
        }
        this.storage.startMaintenance(updated.storage);
        this.storage.refreshAttributionCollection();
        return { success: true, config: updated };
      }
      return { success: false };
    });
  }

  public async start(): Promise<void> {
    if (!this.secret) throw new Error('A control-plane secret is required to start the server');
    if (this.configManager) {
      this.storage.startMaintenance(this.configManager.getConfig().storage);
      this.storage.startAttributionCollection(() => this.configManager!.getConfig().attribution);
    }
    return new Promise((resolve, reject) => {
      this.app.listen({ port: this.port, host: '127.0.0.1' }, (err) => {
        if (err) {
          console.error(`[Web 8088] Server failed to start:`, err);
          return reject(err);
        }
        console.log(`\x1b[1;32m[Web 8088]\x1b[0m Dashboard server listening on \x1b[4;34mhttp://127.0.0.1:${this.port}/\x1b[0m`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    await this.app.close();
    console.log('[Web 8088] Dashboard server closed');
  }
}
