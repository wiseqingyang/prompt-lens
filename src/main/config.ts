/**
 * PromptLens Configuration Manager
 * Manages persistent user preferences stored at ~/.prompt-lens/config.json.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface LensConfig {
  proxy: {
    listenPort: number;
    upstreamMode: 'system' | 'custom' | 'direct';
    customUpstream: string;
    customDomains: string[];
  };
  privacy: {
    maskApiKeys: boolean;
  };
  storage: {
    retentionDays: number; // 0 = permanent, 7 = 7 days, 30 = 30 days
    rawPayloadRetentionDays?: number; // 0 = permanent; expire complete content by session last activity
  };
  attribution: { antigravityDataDir: string; piSessionsDir: string };
  general: {
    minimizeToTrayOnClose: boolean;
    defaultView: 'tasks' | 'flows';
  };
}

export function normalizeRetentionDays(val: any, defaultVal = 0): number {
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return defaultVal;
}

/** Attribution, appearance and retention changes must not interrupt proxy traffic. */
export function proxyConfigurationChanged(before: LensConfig, after: LensConfig): boolean {
  return before.proxy.listenPort !== after.proxy.listenPort ||
    before.proxy.upstreamMode !== after.proxy.upstreamMode ||
    before.proxy.customUpstream !== after.proxy.customUpstream ||
    JSON.stringify(before.proxy.customDomains) !== JSON.stringify(after.proxy.customDomains);
}

export const DEFAULT_CONFIG: LensConfig = {
  attribution: { antigravityDataDir: '', piSessionsDir: '' },
  proxy: {
    listenPort: 8899,
    upstreamMode: 'system',
    customUpstream: '',
    customDomains: [
      'api.siliconflow.cn',
      'open.bigmodel.cn',
      'api.minimax.chat'
    ]
  },
  privacy: {
    maskApiKeys: true
  },
  storage: {
    retentionDays: 0,
    rawPayloadRetentionDays: 0 // 默认 0 (永久完整保留原始报文，必须由用户主动开启内容过期删除)
  },
  general: {
    minimizeToTrayOnClose: true,
    defaultView: 'tasks'
  }
};

export function validateConfigPatch(value: unknown): asserts value is Partial<LensConfig> {
  const fail = () => { throw new TypeError('配置无效：请检查端口、代理地址、域名与字段类型'); };
  const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
  if (!object(value)) return fail();
  const fields: Record<string, string[]> = { attribution: ['antigravityDataDir', 'piSessionsDir'], proxy: ['listenPort', 'upstreamMode', 'customUpstream', 'customDomains'], privacy: ['maskApiKeys'], storage: ['retentionDays', 'rawPayloadRetentionDays'], general: ['minimizeToTrayOnClose', 'defaultView'] };
  for (const [section, v] of Object.entries(value)) {
    if (!fields[section] || !object(v) || Object.keys(v).some(key => !fields[section].includes(key))) return fail();
  }
  const p = value.proxy;
  if (p) {
    if (p.listenPort !== undefined && (!Number.isInteger(p.listenPort) || p.listenPort < 1024 || p.listenPort > 65535 || [8088, 8897].includes(p.listenPort))) return fail();
    if (p.upstreamMode !== undefined && !['system', 'custom', 'direct'].includes(p.upstreamMode)) return fail();
    if (p.customUpstream !== undefined) {
      if (typeof p.customUpstream !== 'string' || p.customUpstream.length > 2048) return fail();
      if (p.customUpstream.trim()) {
        try {
          const url = new URL(p.customUpstream);
          if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || (url.pathname && url.pathname !== '/')) return fail();
        } catch { return fail(); }
      }
    }
    if (p.customDomains !== undefined && (!Array.isArray(p.customDomains) || p.customDomains.length > 100 || p.customDomains.some((v: unknown) => typeof v !== 'string' || v.length > 253 || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(v)))) return fail();
  }
  if (value.privacy?.maskApiKeys !== undefined && typeof value.privacy.maskApiKeys !== 'boolean') return fail();
  for (const nativeDir of [value.attribution?.antigravityDataDir, value.attribution?.piSessionsDir]) if (nativeDir !== undefined && (typeof nativeDir !== 'string' || nativeDir.length > 4096 || nativeDir.includes('\0') || nativeDir !== '' && !path.isAbsolute(nativeDir))) return fail();
  if (value.general?.minimizeToTrayOnClose !== undefined && typeof value.general.minimizeToTrayOnClose !== 'boolean') return fail();
  if (value.general?.defaultView !== undefined && !['tasks', 'flows'].includes(value.general.defaultView)) return fail();
}

export class ConfigManager {
  private configPath: string;
  private currentConfig: LensConfig;

  constructor(customPath?: string, private inheritedUpstream = '', private readonly homeDirectory = os.homedir()) {
    if (customPath) {
      this.configPath = customPath;
    } else {
      const dir = path.join(this.homeDirectory, '.prompt-lens');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      this.configPath = path.join(dir, 'config.json');
    }
    this.currentConfig = this.load();
  }

  public getConfig(): LensConfig {
    const config: LensConfig = JSON.parse(JSON.stringify(this.currentConfig));
    if (!config.attribution.antigravityDataDir) {
      const directory = path.join(this.homeDirectory, '.gemini', 'antigravity');
      try {
        if (['brain', 'conversations'].every(name => fs.statSync(path.join(directory, name)).isDirectory())) {
          config.attribution.antigravityDataDir = directory;
        }
      } catch { /* Agent absent or inaccessible: leave requests available without native evidence. */ }
    }
    if (!config.attribution.piSessionsDir) {
      const directory = path.join(this.homeDirectory, '.pi', 'agent', 'sessions');
      try { if (fs.statSync(directory).isDirectory()) config.attribution.piSessionsDir = directory; }
      catch { /* No Agent directories are created during discovery. */ }
    }
    return config;
  }

  public getConfigPath(): string {
    return this.configPath;
  }

  public load(): LensConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        validateConfigPatch(parsed);
        // Deep merge with defaults in case of missing keys
        return {
          attribution: { antigravityDataDir: parsed.attribution?.antigravityDataDir ?? '', piSessionsDir: parsed.attribution?.piSessionsDir ?? '' },
          proxy: {
            listenPort: typeof parsed.proxy?.listenPort === 'number' ? parsed.proxy.listenPort : DEFAULT_CONFIG.proxy.listenPort,
            upstreamMode: ['system', 'custom', 'direct'].includes(parsed.proxy?.upstreamMode ?? '') ? parsed.proxy!.upstreamMode : DEFAULT_CONFIG.proxy.upstreamMode,
            customUpstream: parsed.proxy?.customUpstream || DEFAULT_CONFIG.proxy.customUpstream,
            customDomains: Array.isArray(parsed.proxy?.customDomains) ? parsed.proxy.customDomains : [...DEFAULT_CONFIG.proxy.customDomains]
          },
          privacy: {
            maskApiKeys: typeof parsed.privacy?.maskApiKeys === 'boolean' ? parsed.privacy.maskApiKeys : DEFAULT_CONFIG.privacy.maskApiKeys
          },
          storage: {
            retentionDays: normalizeRetentionDays(parsed.storage?.retentionDays, DEFAULT_CONFIG.storage.retentionDays),
            rawPayloadRetentionDays: normalizeRetentionDays(parsed.storage?.rawPayloadRetentionDays, 0)
          },
          general: {
            minimizeToTrayOnClose: typeof parsed.general?.minimizeToTrayOnClose === 'boolean' ? parsed.general.minimizeToTrayOnClose : DEFAULT_CONFIG.general.minimizeToTrayOnClose,
            defaultView: ['tasks', 'flows'].includes(parsed.general?.defaultView ?? '') ? parsed.general!.defaultView : DEFAULT_CONFIG.general.defaultView
          }
        };
      }
    } catch (err) {
      console.warn('[ConfigManager] Failed to load config, falling back to defaults:', err);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  public save(newConfig: Partial<LensConfig>): LensConfig {
    validateConfigPatch(newConfig);
    const sanitizedRetention = normalizeRetentionDays(
      newConfig.storage?.retentionDays !== undefined ? newConfig.storage.retentionDays : this.currentConfig.storage.retentionDays,
      0
    );
    const sanitizedRawPayloadRetention = normalizeRetentionDays(
      newConfig.storage?.rawPayloadRetentionDays !== undefined ? newConfig.storage.rawPayloadRetentionDays : this.currentConfig.storage.rawPayloadRetentionDays,
      0
    );

    const next: LensConfig = {
      attribution: { ...this.currentConfig.attribution, ...newConfig.attribution },
      proxy: {
        ...this.currentConfig.proxy,
        ...(newConfig.proxy || {})
      },
      privacy: {
        ...this.currentConfig.privacy,
        ...(newConfig.privacy || {})
      },
      storage: {
        ...this.currentConfig.storage,
        ...(newConfig.storage || {}),
        retentionDays: sanitizedRetention,
        rawPayloadRetentionDays: sanitizedRawPayloadRetention
      },
      general: {
        ...this.currentConfig.general,
        ...(newConfig.general || {})
      }
    };

    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      if (next.proxy.upstreamMode === 'custom' && !next.proxy.customUpstream.trim()) throw new TypeError('自定义代理地址不能为空');
      fs.writeFileSync(this.configPath, JSON.stringify(next, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      });
    } catch (err) {
      console.error('[ConfigManager] Failed to save config file:', err);
      throw err;
    }

    this.currentConfig = next;
    return this.getConfig();
  }

  /**
   * Resolves the actual upstream URL passed to Go core based on mode:
   * - 'direct': returns ""
   * - 'custom': returns customUpstream
   * - 'system': uses the inherited environment proxy, otherwise connects directly
   */
  public resolveEffectiveUpstream(systemDefaultProxy: string = this.inheritedUpstream): string {
    const { upstreamMode, customUpstream } = this.currentConfig.proxy;
    if (upstreamMode === 'direct') {
      return '';
    }
    if (upstreamMode === 'custom') {
      return customUpstream.trim();
    }
    return systemDefaultProxy;
  }
}
