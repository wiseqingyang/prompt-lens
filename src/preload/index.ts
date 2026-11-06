/**
 * PromptLens Electron Preload Bridge
 * Secure IPC communication between Electron Main Process and Renderer View.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AgentRestartRequest } from '../shared/agentRestart';
import type { StorageEngine } from '../main/storage';
import type { PaginatedSessions } from '../main/types';

export interface ElectronAPI {
  getStats: () => Promise<any>;
  getDailyTokenActivity: (agentCategory?: string) => Promise<any>;
  getDayModelUsage: (date: string, agentCategory?: string) => Promise<any[]>;
  getDayTokenDetails: (date: string, agentCategory?: string) => Promise<any[]>;
  getRecords: (params?: any) => Promise<any>;
  getRecordHistory: (id: number) => Promise<import('../shared/history').RelatedHistory>;
  getRecordDetail: (id: number) => Promise<any>;
  getRecordsByIds: (ids: number[], options?: { includeRawBody?: boolean; lightweight?: boolean }) => Promise<any[]>;
  exportFixture: (id: number) => Promise<any>;
  getSessions: (options?: { limit?: number; offset?: number }) => Promise<PaginatedSessions>;
  clearRecords: () => Promise<any>;
  resetUsage: () => Promise<any>;
  deleteAllData: () => Promise<any>;
  getCertStatus: () => Promise<import('../main/cert').CertificateStatus>;
  installCert: () => Promise<{ success: boolean; message: string }>;
  copyText: (text: string) => Promise<boolean>;
  getDiagnostics: () => Promise<any>;
  sanitizeHistory: () => Promise<any>;
  platform: string;
  getConfig: () => Promise<any>;
  saveConfig: (config: any) => Promise<any>;
  testUpstream: (upstreamUrl?: string) => Promise<{ ok: boolean; latencyMs: number; message: string }>;
  revealDbFolder: () => Promise<any>;
  getDbInfo: () => Promise<ReturnType<StorageEngine['getDbInfo']>>;
  compactDatabase: (options?: any) => Promise<{ beforeBytes: number; afterBytes: number; savedBytes: number; compressedCount: number; prunedPayloadsCount: number }>;
  launchAgent: (agent: string) => Promise<{ success: boolean; message: string }>;
  checkAgent: (agent: string) => Promise<{ installed: boolean }>;
  confirmAgentRestart: (requestId: string, confirmed: boolean) => Promise<boolean>;
  onAgentRestartConfirmation: (callback: (request: AgentRestartRequest) => void) => () => void;
  onRecordUpdated: (callback: (recordId: number) => void) => () => void;
}

const api: ElectronAPI = {
  platform: process.platform,
  getStats: () => ipcRenderer.invoke('api:get-stats'),
  getDailyTokenActivity: (agentCategory) => ipcRenderer.invoke('api:get-daily-token-activity', agentCategory),
  getDayModelUsage: (date, agentCategory) => ipcRenderer.invoke('api:get-day-model-usage', { date, agentCategory }),
  getDayTokenDetails: (date, agentCategory) => ipcRenderer.invoke('api:get-day-token-details', { date, agentCategory }),
  getRecords: (params) => ipcRenderer.invoke('api:get-records', params),
  getRecordHistory: (id) => ipcRenderer.invoke('api:get-record-history', id),
  getRecordDetail: (id) => ipcRenderer.invoke('api:get-record-detail', id),
  getRecordsByIds: (ids: number[], options?: { includeRawBody?: boolean; lightweight?: boolean }) => ipcRenderer.invoke('api:get-records-by-ids', ids, options),
  exportFixture: (id) => ipcRenderer.invoke('api:export-fixture', id),
  getSessions: (options) => ipcRenderer.invoke('api:get-sessions', options),
  clearRecords: () => ipcRenderer.invoke('api:clear-records'),
  resetUsage: () => ipcRenderer.invoke('api:reset-usage'),
  deleteAllData: () => ipcRenderer.invoke('api:delete-all-data'),
  getCertStatus: () => ipcRenderer.invoke('api:get-cert-status'),
  installCert: () => ipcRenderer.invoke('api:install-cert'),
  copyText: (text) => ipcRenderer.invoke('api:copy-text', text),
  getDiagnostics: () => ipcRenderer.invoke('api:get-diagnostics'),
  sanitizeHistory: () => ipcRenderer.invoke('api:sanitize-history'),
  getConfig: () => ipcRenderer.invoke('api:get-config'),
  saveConfig: (config: any) => {
    const safeConfig = config ? JSON.parse(JSON.stringify(config)) : {};
    return ipcRenderer.invoke('api:save-config', safeConfig);
  },
  testUpstream: (upstreamUrl?: string) => ipcRenderer.invoke('api:test-upstream', { upstreamUrl }),
  revealDbFolder: () => ipcRenderer.invoke('api:reveal-db-folder'),
  getDbInfo: () => ipcRenderer.invoke('api:get-db-info'),
  compactDatabase: (options?: any) => ipcRenderer.invoke('api:compact-database', options),
  launchAgent: (agent: string) => ipcRenderer.invoke('api:launch-agent', { agent }),
  checkAgent: (agent: string) => ipcRenderer.invoke('api:check-agent', { agent }),
  confirmAgentRestart: (requestId, confirmed) => ipcRenderer.invoke('api:confirm-agent-restart', { requestId, confirmed }),
  onAgentRestartConfirmation: callback => {
    const handler = (_event: Electron.IpcRendererEvent, request: AgentRestartRequest) => callback(request);
    ipcRenderer.on('agent:restart-confirmation', handler);
    return () => ipcRenderer.removeListener('agent:restart-confirmation', handler);
  },
  onRecordUpdated: (callback) => {
    const handler = (_event: any, recordId: number) => callback(recordId);
    ipcRenderer.on('record:updated', handler);
    return () => ipcRenderer.removeListener('record:updated', handler);
  }
};

contextBridge.exposeInMainWorld('electronAPI', api);
