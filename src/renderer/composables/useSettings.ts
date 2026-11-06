import { ref, computed, watch, getCurrentScope, onScopeDispose } from 'vue';
import type { AgentRestartRequest } from '../../shared/agentRestart';
import { AgentList, launchableAgents, type LaunchableAgentKey } from '../../shared/agent';
import type { AgentAppKey, AgentStatusMap, DbInfo, SettingsForm, UpstreamTestResult } from '../types';
import { useI18n } from './useI18n';

const isElectron = () => typeof (window as any).electronAPI !== 'undefined';

export function useSettings(
  onSettingsSaved?: (options?: { resetDiscovery?: boolean }) => Promise<void>,
  showToast?: (msg: string) => void
) {
  const { t, locale } = useI18n();
  const isSettingsOpen = ref(false);
  const settingsTab = ref<'stats' | 'appearance' | 'network' | 'privacy' | 'storage' | 'agent'>('stats');

  const settingsForm = ref<SettingsForm>({
    attribution: { antigravityDataDir: '', piSessionsDir: '' },
    proxy: {
      listenPort: 8899,
      upstreamMode: 'system',
      customUpstream: '',
      customDomains: []
    },
    privacy: {
      maskApiKeys: true
    },
    storage: {
      retentionDays: 0,
      rawPayloadRetentionDays: 0
    },
    general: {
      minimizeToTrayOnClose: true
    }
  });

  const newCustomDomainInput = ref('');
  const showBuiltinDomains = ref(false);
  const isTestingUpstream = ref(false);
  const upstreamTestResult = ref<UpstreamTestResult | null>(null);
  const certificate = ref<{ state: string; message: string; fingerprint?: string; path?: string }>({ state: 'unknown', message: '尚未检查证书状态' });
  const refreshCertificate = async () => {
    try {
      if (isElectron()) certificate.value = await (window as any).electronAPI.getCertStatus();
      else {
        const response = await fetch('/api/cert/status');
        if (!response.ok) throw new Error('证书状态不可用');
        certificate.value = await response.json();
      }
    } catch { certificate.value = { state: 'unknown', message: '无法读取证书状态，请在系统证书管理器中检查' }; }
  };
  const dbInfo = ref<DbInfo>({ dbPath: '', dbSize: 0, recordsCount: 0 });
  const isLoadingDbInfo = ref(false);
  const isSavingSettings = ref(false);

  const selectedAgentTab = ref<AgentAppKey>(AgentList[0].key);
  const agentStatus = ref<AgentStatusMap>(Object.fromEntries(
    launchableAgents.map(agent => [agent.key, { installed: false }])
  ) as AgentStatusMap);
  const isLaunchingAgent = ref(false);
  const agentRestartRequest = ref<AgentRestartRequest | null>(null);
  const isConfirmingAgentRestart = ref(false);
  const restartApi = isElectron() ? (window as any).electronAPI : undefined;

  const respondToAgentRestart = async (confirmed: boolean) => {
    const request = agentRestartRequest.value;
    if (!request || isConfirmingAgentRestart.value) return;
    isConfirmingAgentRestart.value = true;
    try {
      const accepted = await restartApi.confirmAgentRestart(request.requestId, confirmed);
      if (!accepted) agentRestartRequest.value = null;
      if (!accepted) showToast?.(t('settings.toasts.restartExpired'));
    } catch {
      isConfirmingAgentRestart.value = false;
      showToast?.(t('settings.toasts.restartSubmitFailed'));
    }
  };
  const unsubscribeRestart = restartApi?.onAgentRestartConfirmation?.((request: AgentRestartRequest) => {
    if (!isSettingsOpen.value || !isLaunchingAgent.value) {
      void restartApi.confirmAgentRestart(request.requestId, false).catch(() => {});
      return;
    }
    agentRestartRequest.value = request;
    isConfirmingAgentRestart.value = false;
  });
  watch(isSettingsOpen, open => { if (!open) void respondToAgentRestart(false); }, { flush: 'sync' });
  if (getCurrentScope()) onScopeDispose(() => {
    unsubscribeRestart?.();
    const request = agentRestartRequest.value;
    if (request && !isConfirmingAgentRestart.value) void restartApi.confirmAgentRestart(request.requestId, false).catch(() => {});
  });

  const isMacElectron = computed(() => {
    const api = (window as any).electronAPI;
    if (api && typeof api.platform === 'string') {
      return api.platform === 'darwin';
    }
    const isElectronEnv = typeof (window as any).electronAPI !== 'undefined';
    return isElectronEnv && navigator.userAgent.toLowerCase().includes('mac');
  });

  const builtinLlmDomains = [
    'chatgpt.com',
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'aiplatform.googleapis.com',
    'cloudaicompanion.googleapis.com',
    'cloudcode-pa.googleapis.com',
    'daily-cloudcode-pa.googleapis.com',
    'api.deepseek.com',
    'openrouter.ai',
    'api.groq.com',
    'api.together.xyz',
    'api.cohere.ai',
    'api.mistral.ai',
    'api.perplexity.ai',
    'api.moonshot.cn'
  ];

  const agentCommands = computed<Record<AgentAppKey, string>>(() => {
    const p = settingsForm.value.proxy?.listenPort || 8899;
    const isZh = locale.value === 'zh-CN';
    const restartPrompt = (name: string) => isZh
      ? `${name} 正在运行，是否重启以挂载代理？[y/N] `
      : `${name} is running. Restart to attach proxy? [y/N] `;
    const terminalComment = isZh
      ? '# 为当前终端注入代理环境与证书'
      : '# Set up proxy environment and certificates for current terminal';
    return {
      antigravity: `if pgrep -f "Antigravity\\.app/Contents/" >/dev/null; then
  read -r -p "${restartPrompt('Antigravity')}" ans
  [[ "$ans" =~ ^[Yy]$ ]] && pkill -f "Antigravity\\.app/Contents/" && sleep 1 || exit 0
fi
export HTTP_PROXY="http://127.0.0.1:${p}"
export HTTPS_PROXY="http://127.0.0.1:${p}"
export ALL_PROXY="http://127.0.0.1:${p}"
export NO_PROXY="localhost,127.0.0.1,::1,.localhost"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
export NODE_EXTRA_CA_CERTS="$HOME/.prompt-lens/ca.crt"
export SSL_CERT_FILE="$HOME/.prompt-lens/agent-ca-bundle.pem"
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE" CURL_CA_BUNDLE="$SSL_CERT_FILE"
/Applications/Antigravity.app/Contents/MacOS/Antigravity --proxy-server="http://127.0.0.1:${p}" --proxy-bypass-list="localhost;127.0.0.1;[::1];*.localhost"`,

      codex_app: `if pgrep -f "(Codex|ChatGPT)\\.app/Contents/" >/dev/null; then
  read -r -p "${restartPrompt(isZh ? 'Codex 桌面端' : 'Codex Desktop')}" ans
  [[ "$ans" =~ ^[Yy]$ ]] && pkill -f "(Codex|ChatGPT)\\.app/Contents/" && sleep 1 || exit 0
fi
export HTTP_PROXY="http://127.0.0.1:${p}"
export HTTPS_PROXY="http://127.0.0.1:${p}"
export ALL_PROXY="http://127.0.0.1:${p}"
export NO_PROXY="127.0.0.1:8897,127.0.0.1:8088"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
export NODE_EXTRA_CA_CERTS="$HOME/.prompt-lens/ca.crt"
export SSL_CERT_FILE="$HOME/.prompt-lens/agent-ca-bundle.pem"
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE" CURL_CA_BUNDLE="$SSL_CERT_FILE"
/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --proxy-server="http://127.0.0.1:${p}" --proxy-bypass-list="127.0.0.1:8897;127.0.0.1:8088"`,

      codex_cli: `export HTTP_PROXY="http://127.0.0.1:${p}"
export HTTPS_PROXY="http://127.0.0.1:${p}"
export ALL_PROXY="http://127.0.0.1:${p}"
export NO_PROXY="127.0.0.1:8897,127.0.0.1:8088"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
export NODE_EXTRA_CA_CERTS="$HOME/.prompt-lens/ca.crt"
export SSL_CERT_FILE="$HOME/.prompt-lens/agent-ca-bundle.pem"
codex`,

      pi: `export HTTP_PROXY="http://127.0.0.1:${p}"
export HTTPS_PROXY="http://127.0.0.1:${p}"
export ALL_PROXY="http://127.0.0.1:${p}"
export NO_PROXY="localhost:8897,localhost:8088,127.0.0.1:8897,127.0.0.1:8088,[::1]:8897,[::1]:8088"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
export NODE_EXTRA_CA_CERTS="$HOME/.prompt-lens/ca.crt"
export SSL_CERT_FILE="$HOME/.prompt-lens/agent-ca-bundle.pem"
pi`,

      workbuddy: `if pgrep -f "WorkBuddy\\.app/Contents/" >/dev/null; then
  read -r -p "${restartPrompt('WorkBuddy')}" ans
  [[ "$ans" =~ ^[Yy]$ ]] && pkill -f "WorkBuddy\\.app/Contents/" && sleep 1 || exit 0
fi
export HTTP_PROXY="http://127.0.0.1:${p}"
export HTTPS_PROXY="http://127.0.0.1:${p}"
export ALL_PROXY="http://127.0.0.1:${p}"
export NO_PROXY="localhost,127.0.0.1,::1,.localhost"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
export NODE_EXTRA_CA_CERTS="$HOME/.prompt-lens/ca.crt"
export SSL_CERT_FILE="$HOME/.prompt-lens/agent-ca-bundle.pem"
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE" CURL_CA_BUNDLE="$SSL_CERT_FILE"
/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy --proxy-server="http://127.0.0.1:${p}" --proxy-bypass-list="localhost;127.0.0.1;[::1];*.localhost"`,

      terminal: `${terminalComment}
export HTTP_PROXY="http://127.0.0.1:${p}"
export HTTPS_PROXY="http://127.0.0.1:${p}"
export ALL_PROXY="http://127.0.0.1:${p}"
export NO_PROXY="localhost,127.0.0.1,::1,.localhost"
export http_proxy="http://127.0.0.1:${p}"
export https_proxy="http://127.0.0.1:${p}"
export all_proxy="http://127.0.0.1:${p}"
export no_proxy="localhost,127.0.0.1,::1,.localhost"
export NODE_EXTRA_CA_CERTS="$HOME/.prompt-lens/ca.crt"
export SSL_CERT_FILE="$HOME/.prompt-lens/agent-ca-bundle.pem"`
    };
  });

  const checkAgentsStatus = async () => {
    if (isElectron()) {
      const api = (window as any).electronAPI;
      if (api && api.checkAgent) {
        try {
          const results = await Promise.all(launchableAgents.map(agent => api.checkAgent(agent.key)));
          launchableAgents.forEach((agent, index) => {
            if (results[index]) agentStatus.value[agent.key] = results[index];
          });
        } catch (err) {
          console.warn('[useSettings] Failed to check agent status:', err);
        }
      }
    }
  };

  const loadSettings = async () => {
    try {
      const cfg = isElectron()
        ? await (window as any).electronAPI.getConfig()
        : await fetch('/api/config').then(r => { if (!r.ok) throw new Error('设置暂时不可用'); return r.json(); });
      if (cfg?.proxy) {
        settingsForm.value = JSON.parse(JSON.stringify(cfg));
        if (settingsForm.value.storage && settingsForm.value.storage.rawPayloadRetentionDays === undefined) {
          settingsForm.value.storage.rawPayloadRetentionDays = 0;
        }
      }
    } catch (err) {
      console.error('[useSettings] Failed to load settings:', err);
    }
  };

  const loadDbInfo = async () => {
    isLoadingDbInfo.value = true;
    try {
      const info = isElectron()
        ? await (window as any).electronAPI.getDbInfo()
        : await fetch('/api/db-info').then(r => { if (!r.ok) throw new Error('存储信息暂时不可用'); return r.json(); });
      if (info) dbInfo.value = info;
    } catch (err) {
      console.error('[useSettings] Failed to load storage info:', err);
    } finally {
      isLoadingDbInfo.value = false;
    }
  };

  const loadSelectedTab = async () => {
    if (settingsTab.value === 'storage') await loadDbInfo();
    else if (settingsTab.value === 'privacy') await refreshCertificate();
    else if (settingsTab.value === 'agent') await checkAgentsStatus();
  };

  const selectSettingsTab = async (tab: typeof settingsTab.value) => {
    if (settingsTab.value === tab) return;
    settingsTab.value = tab;
    if (isSettingsOpen.value) await loadSelectedTab();
  };

  const openSettings = async () => {
    isSettingsOpen.value = true;
    upstreamTestResult.value = null;
    await Promise.all([loadSettings(), loadSelectedTab()]);
  };

  const addCustomDomain = (inputDomain?: string) => {
    const raw = typeof inputDomain === 'string' ? inputDomain : newCustomDomainInput.value;
    let val = raw.trim().toLowerCase();
    if (!val) return;
    val = val.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').trim();
    if (!val) return;
    if (!settingsForm.value.proxy.customDomains) {
      settingsForm.value.proxy.customDomains = [];
    }
    if (!settingsForm.value.proxy.customDomains.includes(val)) {
      settingsForm.value.proxy.customDomains.push(val);
    }
    newCustomDomainInput.value = '';
  };

  const removeCustomDomain = (index: number) => {
    if (settingsForm.value.proxy.customDomains) {
      settingsForm.value.proxy.customDomains.splice(index, 1);
    }
  };

  const testUpstream = async () => {
    isTestingUpstream.value = true;
    upstreamTestResult.value = null;
    try {
      let target: string | undefined = settingsForm.value.proxy.upstreamMode === 'direct' ? '' : undefined;
      if (settingsForm.value.proxy.upstreamMode === 'custom') {
        target = settingsForm.value.proxy.customUpstream || '';
        if (!target.trim()) throw new Error('请先填写自定义代理地址');
      }

      if (isElectron()) {
        const api = (window as any).electronAPI;
        const res = await api.testUpstream(target);
        upstreamTestResult.value = res;
      } else {
        upstreamTestResult.value = { ok: false, latencyMs: 0, message: '浏览器模式不支持连接测试，请在桌面应用中测试或使用实际请求验证' };
      }
    } catch (err: any) {
      upstreamTestResult.value = { ok: false, latencyMs: 0, message: err.message || '测试失败' };
    } finally {
      isTestingUpstream.value = false;
    }
  };

  const saveSettings = async () => {
    isSavingSettings.value = true;
    try {
      const rawConfig = JSON.parse(JSON.stringify(settingsForm.value));
      if (isElectron()) {
        const api = (window as any).electronAPI;
        await api.saveConfig(rawConfig);
      } else {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rawConfig)
        });
        if (!response.ok) throw new Error('服务器拒绝保存设置');
        const result = await response.json();
        if (!result.success) throw new Error('设置未保存');
      }
      showToast?.(t('settings.toasts.saved'));
      isSettingsOpen.value = false;
      if (onSettingsSaved) {
        await onSettingsSaved();
      }
    } catch (err: any) {
      alert('保存设置失败: ' + (err.message || String(err)));
    } finally {
      isSavingSettings.value = false;
    }
  };

  const revealDbFolder = async () => {
    if (isElectron()) {
      await (window as any).electronAPI.revealDbFolder();
    } else {
      showToast?.(t('settings.toasts.webNoLocalDir'));
    }
  };

  const installCert = async () => {
    if (!window.confirm('信任此根证书将允许 PromptLens 解密已配置域名的 HTTPS 流量。仅在你了解并同意此范围时继续；卸载应用不会自动撤销系统信任。')) return;
    if (isElectron()) {
      const res = await (window as any).electronAPI.installCert();
      alert(res.message);
    } else {
      const res = await fetch('/api/cert/install', { method: 'POST' }).then((r) => r.json());
      alert(res.message);
    }
    await refreshCertificate();
  };

  const launchAgentApp = async (agent: LaunchableAgentKey) => {
    if (!isElectron()) {
      showToast?.(t('settings.toasts.webNoDirectLaunch'));
      return;
    }
    if (isLaunchingAgent.value) return;
    isLaunchingAgent.value = true;
    try {
      const api = (window as any).electronAPI;
      const res = await api.launchAgent(agent);
      showToast?.(res.message);
      await checkAgentsStatus();
    } catch (err: any) {
      showToast?.(t('settings.toasts.launchFailed', { err: err.message || String(err) }));
    } finally {
      isLaunchingAgent.value = false;
      agentRestartRequest.value = null;
      isConfirmingAgentRestart.value = false;
    }
  };

  const isCompactingDb = ref(false);

  const compactDatabase = async () => {
    isCompactingDb.value = true;
    try {
      const res = isElectron()
        ? await (window as any).electronAPI.compactDatabase()
        : await fetch('/api/maintenance/reclaim', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('空间回收失败'); return r.json(); });
      showToast?.(t('settings.toasts.reclaimed', { mb: (res.savedBytes / 1024 / 1024).toFixed(1) }));
      await Promise.all([loadSettings(), loadDbInfo()]);
    } catch (err: any) {
      showToast?.(t('settings.toasts.reclaimFailed', { err: err.message || String(err) }));
    } finally {
      isCompactingDb.value = false;
    }
  };

  const deleteData = async (operation: 'resetUsage' | 'deleteAllData') => {
    try {
      if (isElectron()) await (window as any).electronAPI[operation]();
      else {
        const response = await fetch(operation === 'resetUsage' ? '/api/reset-usage' : '/api/delete-all-data', { method: 'POST' });
        if (!response.ok) throw new Error('删除操作失败');
      }
      await Promise.all([loadSettings(), loadDbInfo()]);
      await onSettingsSaved?.({ resetDiscovery: true });
      showToast?.(t('settings.toasts.operationComplete'));
    } catch (error: any) { showToast?.(error.message || String(error)); }
  };

  return {
    isSettingsOpen,
    settingsTab,
    settingsForm,
    newCustomDomainInput,
    showBuiltinDomains,
    isTestingUpstream,
    upstreamTestResult,
    dbInfo,
    isLoadingDbInfo,
    isSavingSettings,
    isCompactingDb,
    selectedAgentTab,
    agentStatus,
    isLaunchingAgent,
    agentRestartRequest,
    isConfirmingAgentRestart,
    respondToAgentRestart,
    isMacElectron,
    builtinLlmDomains,
    agentCommands,
    openSettings,
    loadSettings,
    loadDbInfo,
    selectSettingsTab,
    addCustomDomain,
    removeCustomDomain,
    testUpstream,
    saveSettings,
    revealDbFolder,
    compactDatabase,
    deleteData,
    installCert,
    certificate,
    refreshCertificate,
    checkAgentsStatus,
    launchAgentApp
  };
}
