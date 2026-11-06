/**
 * PromptLens Electron Main Process Entry
 * Orchestrates Gateway (8899), MITM Proxy (8898), WebServer (8088),
 * SQLite Database, System Tray, and Main Browser Window.
 */

// 1. Preserve the inherited proxy before clearing child-process loop risks.
let UPSTREAM_PROXY = '';
for (const envVar of ['UPSTREAM_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  const val = process.env[envVar];
  if (val && !val.includes('8899') && !val.includes('8898')) {
    UPSTREAM_PROXY = val;
    break;
  }
}

// 2. CRITICAL: Strip proxy environment variables from current process to prevent infinite socket loops
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key];
}

import { app, BrowserWindow, ipcMain, clipboard, dialog, shell, nativeImage, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execSync, execFileSync } from 'child_process';
import crypto from 'crypto';
import { testUpstreamConnectivity } from './upstream-test';
import { buildProxyEnv, shellQuote } from './proxy-env';
import { launchCodexDesktop } from './codex-desktop';
import { AgentRestartConfirmations } from './agent-restart-confirmation';
import { URL } from 'url';
import { StorageEngine } from './storage';
import { CertManager } from './cert';
import { CoreManager } from './core';
import { WebServer } from './web';
import { TrayController } from './tray';
import { ConfigManager, LensConfig, proxyConfigurationChanged } from './config';
import { clusterRecordsIntoTasks, dissectPromptAnatomy, paginateSessions } from './session';
import { createSanitizedFixture } from './sanitizer';
import { assertTrustedSender, assertIpcArguments, secureWebContents } from './desktop-security';

// 3. Single Instance Lock (prevent port conflicts and multiple agent instances)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.warn('[Main] Another PromptLens instance is already running, exiting');
  app.quit();
}

const APP_SECRET = process.env.LLM_LENS_SECRET || crypto.randomBytes(32).toString('hex');

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let isShuttingDown = false;
const agentRestartConfirmations = new AgentRestartConfirmations();

function getBrandIconPath(): string {
  const packagedPath = path.join(process.resourcesPath, 'promptlens-mark.png');
  const devPath = path.join(__dirname, '../../resources/promptlens-mark.png');
  return app.isPackaged ? packagedPath : devPath;
}

function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const iconPath = getBrandIconPath();
  if (fs.existsSync(iconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
    console.log(`[Main] Dock icon configured: ${iconPath}`);
  } else {
    console.warn(`[Main] Dock icon not found at: ${iconPath}`);
  }
}

// Core Services
const configManager = new ConfigManager(undefined, UPSTREAM_PROXY);
const currentCfg = configManager.getConfig();
const storage = new StorageEngine(undefined, { backgroundAttribution: true });
const startCollection = () => storage.startAttributionCollection(() => configManager.getConfig().attribution, {
  onCollected: ids => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('record:updated', ids[0]);
  }
});
// Warm the first session projection in parallel with service/window startup before background collection begins.
void storage.getAttributedSessions().catch(() => undefined).finally(startCollection);
const certManager = new CertManager();

const effectiveUpstream = configManager.resolveEffectiveUpstream(UPSTREAM_PROXY);
const coreManager = new CoreManager(storage, {
  listenPort: currentCfg.proxy.listenPort,
  upstream: effectiveUpstream,
  customDomains: currentCfg.proxy.customDomains,
  receiverPort: 8897,
  secret: APP_SECRET,
  onRecordSaved: (recordId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('record:updated', recordId);
    }
  }
});
const webServer = new WebServer(storage, certManager, 8088, coreManager, APP_SECRET, configManager);
const trayController = new TrayController(() => mainWindow, coreManager, certManager, `http://127.0.0.1:8088/?token=${APP_SECRET}`);

async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[Main] Initiating graceful shutdown...');

  try {
    // 1. Drain in-flight proxy traffic
    await coreManager.drain(1000);
  } catch (err) {
    console.error('[Main] coreManager.drain error:', err);
  }

  try {
    // 2. Stop Core (stdin EOF -> SIGTERM)
    await coreManager.stop();
  } catch (err) {
    console.error('[Main] coreManager.stop error:', err);
  }

  try {
    // 3. Stop Fastify Web Server
    await webServer.stop();
  } catch (err) {
    console.error('[Main] webServer.stop error:', err);
  }

  try {
    // 4. Close SQLite storage
    storage.close();
  } catch (err) {
    console.error('[Main] storage.close error:', err);
  }

  console.log('[Main] Graceful shutdown complete');
}


const DASHBOARD_ORIGIN = 'http://127.0.0.1:8088';
function setupIpc() {
  const handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, mainWindow?.webContents.id, DASHBOARD_ORIGIN);
      assertIpcArguments(channel, args);
      return listener(event, ...args);
    });
  };
  handle('api:get-stats', async () => storage.getStats());

  handle('api:get-daily-token-activity', async (_e, agentCategory?: string) => {
    return storage.getDailyTokenActivity(agentCategory);
  });

  handle('api:get-day-model-usage', async (_e, params: { date: string; agentCategory?: string }) => {
    return storage.getResolvedDayModelUsage(params?.date, params?.agentCategory);
  });

  handle('api:get-day-token-details', async (_e, params: { date: string; agentCategory?: string }) => {
    return storage.getResolvedDayTokenDetails(params?.date, params?.agentCategory);
  });

  handle('api:get-records', async (_e, params) => {
    return { records: storage.getRecords(params || {}) };
  });

  handle('api:get-record-history', async (_e, id: number) => storage.getRelatedHistory(id));

  handle('api:get-record-detail', async (_e, id: number) => {
    const record = storage.getRecordById(id);
    if (!record) return null;
    record.anatomy = dissectPromptAnatomy(record);
    return record;
  });

  handle('api:get-records-by-ids', async (_e, ids: number[], options?: { includeRawBody?: boolean; lightweight?: boolean }) => {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const includeRaw = options?.includeRawBody !== undefined ? Boolean(options.includeRawBody) : false;
    return storage.getRecordsByIds(ids, { includeRawBody: includeRaw, lightweight: options?.lightweight }).map((record) => {
      return storage.attachTimelineDetail(record);
    });
  });

  handle('api:export-fixture', async (_e, id: number) => {
    const record = storage.getRecordById(id);
    if (!record) return null;
    return createSanitizedFixture(record);
  });

  handle('api:get-sessions', async (_e, options?: { limit?: number; offset?: number }) => {
    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    return paginateSessions(await storage.getAttributedSessions(), { limit, offset });
  });

  handle('api:clear-records', async () => {
    storage.clearRecords();
    return { success: true };
  });

  handle('api:get-cert-status', async () => certManager.getStatus());

  handle('api:install-cert', async () => {
    return certManager.installToSystemStore();
  });

  handle('api:copy-text', async (_e, text: string) => {
    clipboard.writeText(text);
    return true;
  });

  handle('api:get-diagnostics', async () => {
    return {
      core: coreManager.getStatus(),
      cert: {
        fingerprint: certManager.getFingerprint(),
        caCertPath: certManager.getCertPaths().caCertPath,
        exists: certManager.getCertPaths().exists
      },
      queue: storage.getTruncatedAndDroppedStats(),
      recentErrors: storage.getRecentErrors(10),
      sensitiveScan: storage.scanSensitiveRecords()
    };
  });

  handle('api:sanitize-history', async () => {
    return storage.sanitizeHistoricalRecords();
  });

  handle('api:get-config', async () => {
    return configManager.getConfig();
  });

  handle('api:save-config', async (_e, newConfig: Partial<LensConfig>) => {
    const oldConfig = configManager.getConfig();
    const updated = configManager.save(newConfig);

    if (proxyConfigurationChanged(oldConfig, updated)) {
      const effectiveUpstream = configManager.resolveEffectiveUpstream(UPSTREAM_PROXY);
      await coreManager.restart({
        listenPort: updated.proxy.listenPort,
        upstream: effectiveUpstream,
        customDomains: updated.proxy.customDomains
      });
      trayController.updateMenu();
    }

    storage.startMaintenance(updated.storage);
    storage.refreshAttributionCollection();

    return { success: true, config: updated };
  });

  handle('api:test-upstream', async (_e, { upstreamUrl }: { upstreamUrl?: string }) => {
    return testUpstreamConnectivity(upstreamUrl ?? configManager.resolveEffectiveUpstream());
  });

  handle('api:reveal-db-folder', async () => {
    shell.showItemInFolder(storage.getDbPath());
    return { success: true };
  });

  handle('api:get-db-info', async () => storage.getDbInfo());
  handle('api:compact-database', async () => storage.reclaimSpace());
  handle('api:reset-usage', async () => { storage.resetUsage(); return { success: true }; });
  handle('api:delete-all-data', async () => { storage.deleteAllData(); return { success: true }; });

function findMacApp(names: string[]): string | null {
  const userHome = os.homedir();
  const candidateDirs = ['/Applications', path.join(userHome, 'Applications')];
  for (const dir of candidateDirs) {
    for (const name of names) {
      const full = path.join(dir, name.endsWith('.app') ? name : `${name}.app`);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function findCliBinary(name: string): string | null {
  const userHome = os.homedir();
  const searchPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(userHome, '.local/bin'),
    path.join(userHome, '.cargo/bin'),
    path.join(userHome, 'bin'),
    '/usr/bin',
    '/bin'
  ];
  for (const dir of searchPaths) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  try {
    const fullEnvPath = searchPaths.join(':') + ':' + (process.env.PATH || '');
    const out = execSync(`which ${name}`, { env: { ...process.env, PATH: fullEnvPath } }).toString().trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return null;
}

  handle('api:check-agent', async (_e, { agent }: { agent: string }) => {
    if (process.platform !== 'darwin') return { installed: false };
    if (agent === 'workbuddy') return { installed: !!findMacApp(['WorkBuddy']) };
    if (agent === 'antigravity') return { installed: !!findMacApp(['Antigravity']) };
    if (agent === 'cursor') return { installed: !!findMacApp(['Cursor']) };
    if (agent === 'pi') return { installed: !!findCliBinary('pi') };
    if (agent === 'codex' || agent === 'codex_app') return { installed: !!findMacApp(['Codex', 'ChatGPT']) };
    if (agent === 'codex_cli') return { installed: !!findCliBinary('codex') };
    return { installed: false };
  });

  handle('api:confirm-agent-restart', (event, { requestId, confirmed }: { requestId: string; confirmed: boolean }) =>
    agentRestartConfirmations.respond(event.sender.id, requestId, confirmed));

  handle('api:launch-agent', async (event, { agent }: { agent: string }) => {
    if (process.platform !== 'darwin') {
      return { success: false, message: '一键拉起目前仅支持 macOS 环境，其他系统请使用下方命令行启动' };
    }

    const prepareLaunch = () => {
      const port = configManager.getConfig().proxy.listenPort || 8899;
      const caFile = certManager.getCertPaths().caCertPath;
      const caBundle = certManager.prepareAgentCaBundle();
      const proxyUrl = `http://127.0.0.1:${port}`;
      // Do not bypass arbitrary localhost destinations: Pi commonly talks to a
      // local OpenAI-compatible gateway (for example 9router:20128), which
      // must pass through PromptLens to be captured. Only bypass our own
      // control-plane ports.
      const bypass = 'localhost:8897,localhost:8088,127.0.0.1:8897,127.0.0.1:8088,[::1]:8897,[::1]:8088';

      const env = {
        ...process.env,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        all_proxy: proxyUrl,
        NO_PROXY: bypass,
        no_proxy: bypass,
        NODE_EXTRA_CA_CERTS: caFile,
        SSL_CERT_FILE: caBundle,
        REQUESTS_CA_BUNDLE: caBundle,
        CURL_CA_BUNDLE: caBundle
      };
      return { port, caFile, caBundle, proxyUrl, env };
    };

    const launchDesktopApp = (
      appPath: string,
      buildLaunch: (prepared: ReturnType<typeof prepareLaunch>) => { args: string[]; env: NodeJS.ProcessEnv }
    ) =>
      launchCodexDesktop(appPath, processCount => agentRestartConfirmations.request(event.sender, {
        appName: path.basename(appPath), processCount
      }), async () => {
        const { args, env } = buildLaunch(prepareLaunch());
        const binary = path.join(appPath, 'Contents/MacOS', path.basename(appPath, '.app'));
        const child = spawn(binary, args, { detached: true, stdio: 'ignore', env });
        await new Promise<void>((resolve, reject) => {
          const onSpawn = () => { child.removeListener('error', onError); resolve(); };
          const onError = (err: Error) => { child.removeListener('spawn', onSpawn); reject(err); };
          child.once('spawn', onSpawn);
          child.once('error', onError);
        });
        child.unref();
        return { success: true, message: `已启动 ${path.basename(appPath, '.app')} 并挂载代理` };
      });

    if (agent === 'codex' || agent === 'codex_app') {
      const appPath = findMacApp(['Codex', 'ChatGPT']);
      if (!appPath) return { success: false, message: '未检测到 Codex.app 或 ChatGPT.app' };
      return launchDesktopApp(appPath, ({ proxyUrl, env }) => ({
        args: [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=127.0.0.1:8897;127.0.0.1:8088'],
        env: { ...env, NO_PROXY: '127.0.0.1:8897,127.0.0.1:8088', no_proxy: '127.0.0.1:8897,127.0.0.1:8088' }
      }));
    }

    if (agent === 'antigravity' || agent === 'workbuddy') {
      const appName = agent === 'workbuddy' ? 'WorkBuddy' : 'Antigravity';
      const appPath = findMacApp([appName]);
      if (!appPath) return { success: false, message: `未检测到 ${appName}.app` };
      return launchDesktopApp(appPath, ({ proxyUrl, env }) => ({
        args: [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=localhost;127.0.0.1;[::1];*.localhost'],
        env
      }));
    }

    if (agent === 'cursor') {
      const appPath = findMacApp(['Cursor']);
      if (!appPath) return { success: false, message: '未检测到 Cursor.app' };
      return launchDesktopApp(appPath, ({ env }) => ({ args: [], env }));
    }

    const { port, caFile, caBundle } = prepareLaunch();

    if (agent === 'pi') {
      const piBin = findCliBinary('pi');
      if (!piBin) {
        return { success: false, message: '未检测到 pi 命令行工具，请先通过 npm install -g @earendil-works/pi-coding-agent 安装' };
      }

      const script = buildProxyEnv(port, caFile, caBundle) + '\n' + shellQuote(piBin);
      const escapedScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      try {
        execFileSync('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${escapedScript}"`, '-e', 'tell application "Terminal" to activate']);
        return { success: true, message: '已在独立终端窗口中拉起 Pi Agent 并注入 PromptLens 代理环境！' };
      } catch (err: any) {
        return { success: false, message: `拉起终端失败: ${err.message}，请使用下方一键复制命令手动运行` };
      }
    }

    if (agent === 'codex_cli') {
      const codexBin = findCliBinary('codex');
      if (!codexBin) {
        return { success: false, message: '未检测到 codex 命令行工具，请先确保已安装 Codex CLI' };
      }

      const codexBypass = '127.0.0.1:8897,127.0.0.1:8088';
      const script = buildProxyEnv(port, caFile, caBundle) + '\n' + shellQuote(codexBin);
      const escapedScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      try {
        execFileSync('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${escapedScript}"`, '-e', 'tell application "Terminal" to activate']);
        return { success: true, message: '已在独立终端窗口中拉起 Codex CLI 并注入 PromptLens 代理环境！' };
      } catch (err: any) {
        return { success: false, message: `拉起终端失败: ${err.message}，请使用下方一键复制命令手动运行` };
      }
    }

    return { success: false, message: '未知 Agent 类型' };
  });
}

function createWindow() {
  const brandIconPath = getBrandIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    title: 'PromptLens · Prompt Inspector',
    icon: fs.existsSync(brandIconPath) ? brandIconPath : undefined,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#020617', // slate-950
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      contextIsolation: true
    }
  });

  secureWebContents(mainWindow.webContents, DASHBOARD_ORIGIN);
  const contentsId = mainWindow.webContents.id;
  mainWindow.on('hide', () => agentRestartConfirmations.cancelFor(contentsId));

  // Load from local Web Server with secure session token bootstrap
  const url = `http://127.0.0.1:8088/?token=${APP_SECRET}`;
  mainWindow.loadURL(url);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.warn(`[Window] Page load failed with error code: ${errorCode}`);
    setTimeout(() => {
      mainWindow?.loadURL(url);
    }, 1000);
  });

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' || (input.key === 'I' && input.control && input.shift) || (input.key.toLowerCase() === 'i' && input.meta && input.alt)) {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.on('context-menu', (_event, props) => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '检查元素 (Inspect Element)',
        click: () => {
          mainWindow?.webContents.inspectElement(props.x, props.y);
          if (!mainWindow?.webContents.isDevToolsOpened()) {
            mainWindow?.webContents.openDevTools();
          }
        }
      },
      {
        label: '重新加载页面 (Reload)',
        accelerator: 'CmdOrCtrl+R',
        click: () => mainWindow?.webContents.reload()
      }
    ]);
    contextMenu.popup();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
  });
}

function setupApplicationMenu() {
  const menuTemplate: any[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: '视图 (View)',
      submenu: [
        { role: 'reload', label: '重新加载 (Reload)' },
        { role: 'forceReload', label: '强制重新加载 (Force Reload)' },
        { role: 'toggleDevTools', label: '切换开发者工具 (Toggle DevTools)' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  setupIpc();

  // Start background proxy services
  try {
    await storage;
    const currentCfg = configManager.getConfig();
    storage.startMaintenance(currentCfg.storage);
    await coreManager.start();
    certManager.prepareAgentCaBundle();
    await webServer.start();
    trayController.init();
  } catch (err) {
    console.error('[Main] Service initialization failed:', err);
    await coreManager.stop();
    dialog.showErrorBox('PromptLens 启动失败', String(err));
    app.quit();
    return;
  }

  applyDockIcon();
  setupApplicationMenu();
  createWindow();

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  if (!isQuitting) {
    event.preventDefault();
    isQuitting = true;
    gracefulShutdown().finally(() => {
      app.quit();
    });
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep running in tray until explicit Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
