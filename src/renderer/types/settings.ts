import type { LaunchableAgentKey } from '../../shared/agent';
export type { AgentAppKey, LaunchableAgentKey } from '../../shared/agent';

export interface ProxyConfig {
  listenPort: number;
  upstreamMode: 'system' | 'custom' | 'direct';
  customUpstream: string;
  customDomains: string[];
}

export interface PrivacyConfig {
  maskApiKeys: boolean;
}

export interface StorageConfig {
  retentionDays: number;
  rawPayloadRetentionDays?: number;
}

export interface GeneralConfig {
  minimizeToTrayOnClose?: boolean;
}

export interface SettingsForm {
  attribution: { antigravityDataDir: string; piSessionsDir: string };
  proxy: ProxyConfig;
  privacy: PrivacyConfig;
  storage: StorageConfig;
  general: GeneralConfig;
}

export interface DbInfo {
  dbPath: string;
  dbSize: number;
  recordsCount: number;
  reclaimableBytes?: number;
  dedupSavedBytes?: number;
  compressionSavedBytes?: number;
  logicalBytes?: number;
  contentFrom?: string | null;
  usageCoverageStart?: string;
  maintenanceError?: string;
}

export interface UpstreamTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export interface SingleAgentStatus {
  installed: boolean;
}

export type AgentStatusMap = Record<LaunchableAgentKey, SingleAgentStatus>;
