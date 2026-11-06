import { ref, shallowRef, computed, watch } from 'vue';
import type { AgentCategory, RecordDetail, Session, SessionCluster, TaskTurn } from '../types';
import { sessionNavigation } from '../utils/sessionNavigation';
import { isConversation, requestNavigationGroups } from '../utils/requestNavigation';
import { parseRequestTurnPayload } from '../../shared/protocol';
import { getAgentCategory } from '../utils/formatters';
import codexIcon from '../assets/agent-codex.svg';
import antigravityIcon from '../assets/agent-antigravity.svg';
import piIcon from '../assets/agent-pi.svg';
import workbuddyIcon from '../assets/agent-workbuddy.svg';
import otherIcon from '../assets/agent-other.svg';
import { useI18n } from './useI18n';

const isElectron = () => typeof (window as any).electronAPI !== 'undefined';

export function useSessions() {
  const { t } = useI18n();
  const stats = ref<any>({});
  const sessions = shallowRef<SessionCluster[]>([]);
  const selectedSessionId = ref<string | null>(null);
  const selectedTaskId = ref<string | null>(null);
  const selectedId = ref<number | null>(null);
  const currentRecord = shallowRef<RecordDetail | null>(null);
  const sessionTurnRecords = shallowRef<Record<number, RecordDetail>>({});
  const isLoadingSessionTurns = ref(false);
  const isRefreshing = ref(false);
  const loadError = ref<string | null>(null);

  const searchQuery = ref('');
  const activeAgent = ref<AgentCategory>('Codex');
  let searchTimeout: any = null;
  let taskSelectionSeq = 0;
  const navigationGroups = computed(() => requestNavigationGroups(sessions.value));
  const discoveredAgents = ref(new Set<AgentCategory>());
  // Global capture history covers pagination; current requests also reveal Agents
  // before stats arrive. Keep discoveries across temporary loading failures.
  watch([stats, sessions], () => {
    const names = [...(Array.isArray(stats.value?.agents) ? stats.value.agents : []), ...sessions.value.map(s => s.agent_name)];
    const discovered = new Set(discoveredAgents.value);
    for (const name of names) if (typeof name === 'string') discovered.add(getAgentCategory(name));
    if (discovered.size !== discoveredAgents.value.size) discoveredAgents.value = discovered;
  }, { flush: 'sync' });

  const agentTabs = computed(() => {
    const currentList = sessions.value.filter(isConversation);
    const codexCount = currentList.filter((s) => getAgentCategory(s.agent_name) === 'Codex').length;
    const antigravityCount = currentList.filter((s) => getAgentCategory(s.agent_name) === 'Antigravity').length;
    const piCount = currentList.filter((s) => getAgentCategory(s.agent_name) === 'Pi').length;
    const workbuddyCount = currentList.filter((s) => getAgentCategory(s.agent_name) === 'WorkBuddy').length;
    const otherCount = currentList.filter((s) => getAgentCategory(s.agent_name) === 'Other').length;

    return [
      {
        id: 'Codex' as AgentCategory,
        label: 'Codex',
        iconImg: codexIcon,
        count: codexCount,
        activeContainerClass: 'bg-emerald-50/80 dark:bg-emerald-950/40',
        indicatorClass: 'bg-[#10a37f]',
        activeIconBoxClass: 'bg-white dark:bg-emerald-950/70 ring-1 ring-emerald-500/50 shadow-xs shadow-emerald-500/20',
        activeTextClass: 'text-emerald-700 dark:text-[#10a37f] font-semibold',
        dotClass: 'bg-[#10a37f]'
      },
      {
        id: 'Antigravity' as AgentCategory,
        label: 'Antigravity',
        iconImg: antigravityIcon,
        count: antigravityCount,
        activeContainerClass: 'bg-blue-50/80 dark:bg-blue-950/40',
        indicatorClass: 'bg-[#4285F4]',
        activeIconBoxClass: 'bg-white dark:bg-blue-950/70 ring-1 ring-blue-500/50 shadow-xs shadow-blue-500/20',
        activeTextClass: 'text-blue-700 dark:text-sky-300 font-semibold',
        dotClass: 'bg-[#4285F4]'
      },
      {
        id: 'Pi' as AgentCategory,
        label: 'Pi',
        iconImg: piIcon,
        count: piCount,
        activeContainerClass: 'bg-orange-50/80 dark:bg-orange-950/40',
        indicatorClass: 'bg-[#F09082]',
        activeIconBoxClass: 'bg-white dark:bg-slate-900/90 ring-1 ring-[#F09082]/60 shadow-xs shadow-[#F09082]/20',
        activeTextClass: 'text-[#e07a6c] dark:text-[#f3a497] font-semibold',
        dotClass: 'bg-[#F09082]'
      },
      {
        id: 'WorkBuddy' as AgentCategory,
        label: 'WorkBuddy',
        iconImg: workbuddyIcon,
        count: workbuddyCount,
        activeContainerClass: 'bg-violet-50/80 dark:bg-violet-950/40',
        indicatorClass: 'bg-violet-500',
        activeIconBoxClass: 'bg-white dark:bg-violet-950/70 ring-1 ring-violet-500/50 shadow-xs',
        activeTextClass: 'text-violet-700 dark:text-violet-300 font-semibold',
        dotClass: 'bg-violet-500'
      },
      {
        id: 'Other' as AgentCategory,
        label: t('agent.other'),
        iconImg: otherIcon,
        count: otherCount,
        activeContainerClass: 'bg-slate-200/70 dark:bg-slate-800/40',
        indicatorClass: 'bg-slate-400',
        activeIconBoxClass: 'bg-white dark:bg-slate-800/80 ring-1 ring-slate-400/50 dark:ring-slate-600/50 shadow-xs',
        activeTextClass: 'text-slate-800 dark:text-slate-200 font-semibold',
        dotClass: 'bg-slate-400'
      }
    ].filter(tab => tab.id === 'Codex' || tab.id === 'Other' || discoveredAgents.value.has(tab.id));
  });

  const currentTabInfo = computed(() => {
    return agentTabs.value.find((t) => t.id === activeAgent.value) || agentTabs.value[0];
  });

  const filteredSessions = computed(() => {
    let list = navigationGroups.value.filter((s) => getAgentCategory(s.agent_name) === activeAgent.value);
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase().trim();
      list = list.filter((s) => {
        return s.title?.toLowerCase().includes(q) || s.tasks.some((task) => task.user_prompt?.toLowerCase().includes(q)) ||
          s.model?.toLowerCase().includes(q) ||
          s.agent_name?.toLowerCase().includes(q) ||
          s.tasks.some((task) => task.turns?.some((turn: any) =>
            (turn.model || '').toLowerCase().includes(q) || (turn.summary || '').toLowerCase().includes(q) ||
            (turn.response_preview || '').toLowerCase().includes(q)
          ));
      });
    }
    return list;
  });

  const currentSessionGroup = computed(() => navigationGroups.value.find((s) => s.id === selectedSessionId.value) || null);
  const currentSession = computed<Session | null>(() => sessionNavigation(currentSessionGroup.value, selectedTaskId.value));

  const relatedTaskTurns = computed<TaskTurn[]>(() => {
    return currentSession.value ? currentSession.value.turns : [];
  });

  const selectAgentTab = (tabId: AgentCategory) => {
    activeAgent.value = tabId;
    syncActiveSelection();
  };

  const ensureRecordRawBody = async (id: number): Promise<RecordDetail | null> => {
    const cached = sessionTurnRecords.value[id];
    if (cached && cached.raw_loaded) {
      return cached;
    }
    if (cached) {
      sessionTurnRecords.value = {
        ...sessionTurnRecords.value,
        [id]: { ...cached, raw_loading: true, raw_load_error: null }
      };
    }
    const selectionSeq = taskSelectionSeq;
    try {
      let rec: any = null;
      if (isElectron()) {
        rec = await (window as any).electronAPI.getRecordDetail(id);
      } else {
        const res = await fetch(`/api/records/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rec = await res.json();
      }
      if (rec) {
        rec.raw_loaded = true;
        rec.raw_loading = false;
        rec.raw_load_error = null;
        sessionTurnRecords.value = { ...sessionTurnRecords.value, [id]: { ...sessionTurnRecords.value[id], ...rec } };
        const loadedIds = Object.keys(sessionTurnRecords.value).map(Number).filter(key => key !== id && sessionTurnRecords.value[key].raw_loaded);
        const retained = { ...sessionTurnRecords.value };
        const bodySize = (item: RecordDetail) => (item.request_body?.length || 0) + (item.response_body?.length || 0)
          + (item.response_text?.length || 0) + (item.thinking_text?.length || 0);
        let bytes = bodySize(retained[id]);
        let count = 1;
        if (selectedId.value && selectedId.value !== id && retained[selectedId.value]?.raw_loaded) {
          bytes += bodySize(retained[selectedId.value]);
          count++;
        }
        for (const key of loadedIds.reverse()) {
          if (key === selectedId.value) continue;
          const item = retained[key];
          const size = bodySize(item);
          if (count >= 4 || bytes + size > 16 * 1024 * 1024) {
            retained[key] = {
              ...item,
              parsed_question: item.parsed_question || (item.request_body ? parseRequestTurnPayload(item.request_body) : undefined),
              request_body: '',
              response_body: '',
              raw_loaded: false
            };
          } else { bytes += size; count++; }
        }
        sessionTurnRecords.value = retained;
        if (selectedId.value === id && selectionSeq === taskSelectionSeq) {
          currentRecord.value = rec;
        }
        return rec;
      }
    } catch (err: any) {
      console.error('Ensure record raw body error:', err);
      const errMsg = err?.message || '拉取报文失败';
      if (sessionTurnRecords.value[id]) {
        sessionTurnRecords.value = {
          ...sessionTurnRecords.value,
          [id]: {
            ...sessionTurnRecords.value[id],
            raw_loading: false,
            raw_load_error: errMsg
          }
        };
      }
    }
    return sessionTurnRecords.value[id] || null;
  };

  const ensureRelatedHistory = async (id: number) => {
    const cached = sessionTurnRecords.value[id];
    if (!cached || cached.history_loading || cached.related_history && cached.related_history.status !== 'error') return;
    sessionTurnRecords.value = { ...sessionTurnRecords.value, [id]: { ...cached, history_loading: true } };
    try {
      const history = isElectron() ? await (window as any).electronAPI.getRecordHistory(id)
        : await fetch(`/api/records/${id}/history`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
      const latest = sessionTurnRecords.value[id];
      if (latest) {
        const entries = { ...sessionTurnRecords.value, [id]: { ...latest, related_history: history, history_loading: false } };
        const others = Object.keys(entries).map(Number).filter(key => key !== id && entries[key].related_history);
        for (const key of others.slice(0, Math.max(0, others.length - 3))) entries[key] = { ...entries[key], related_history: undefined };
        sessionTurnRecords.value = entries;
      }
    } catch {
      const latest = sessionTurnRecords.value[id];
      if (latest) sessionTurnRecords.value = { ...sessionTurnRecords.value, [id]: { ...latest, related_history: { records: [], status: 'error', messageCount: 0 }, history_loading: false } };
    }
  };

  const selectRecord = async (id: number, includeRawBody = true) => {
    selectedId.value = id;
    const selectionSeq = taskSelectionSeq;
    const cached = sessionTurnRecords.value[id];
    if (cached && cached.raw_loaded) {
      currentRecord.value = cached;
      return;
    }
    currentRecord.value = cached || null;
    if (includeRawBody) { await ensureRecordRawBody(id); return; }
    if (cached) return;
    try {
      const records = isElectron() ? await (window as any).electronAPI.getRecordsByIds([id], { includeRawBody: false, lightweight: true })
        : await fetch('/api/records/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], lightweight: true }) })
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(r => r.records);
      const rec = records?.[0];
      if (rec) {
        sessionTurnRecords.value = { ...sessionTurnRecords.value, [id]: { ...rec, ...sessionTurnRecords.value[id] } };
        if (selectedId.value === id && selectionSeq === taskSelectionSeq) currentRecord.value = sessionTurnRecords.value[id];
      }
    } catch { if (selectedId.value === id) loadError.value = '请求通信信息加载失败，请刷新重试'; }

  };

  const loadSessionTurns = async (session: Session, selectionSeq: number) => {
    if (!session || !session.turns || session.turns.length === 0) return;

    // 初屏只加载轻量详情；完整原文按请求选择/展开加载。
    const missingTurns = session.turns.slice(0, 30).filter(
      (t) => !sessionTurnRecords.value[t.record_id]
    );
    if (missingTurns.length === 0) {
      if (selectionSeq === taskSelectionSeq) isLoadingSessionTurns.value = false;
      return;
    }

    try {
      const missingIds = missingTurns.map((t) => t.record_id);
      let recordsList: any[] = [];
      if (isElectron() && (window as any).electronAPI?.getRecordsByIds) {
        recordsList = await (window as any).electronAPI.getRecordsByIds(missingIds, { includeRawBody: false, lightweight: true });
      } else {
        const response = await fetch('/api/records/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: missingIds, includeRawBody: false, lightweight: true })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const res = await response.json();
        recordsList = res.records || [];
      }

      const newEntries: Record<number, RecordDetail> = {};
      for (const rec of recordsList) {
        if (rec && rec.id) {
          newEntries[rec.id] = { ...rec, ...sessionTurnRecords.value[rec.id] };
        }
      }
      // 一次性批量合并，只触发一次依赖更新
      sessionTurnRecords.value = { ...sessionTurnRecords.value, ...newEntries };
    } catch (err) {
      if (selectionSeq === taskSelectionSeq) loadError.value = '请求详情加载失败，请刷新重试';
      console.error('Failed to load session turn records:', err);
    } finally {
      if (selectionSeq === taskSelectionSeq) isLoadingSessionTurns.value = false;
    }
  };

  const selectTask = async (task: Session, resetToFirstTurn = true) => {
    const selectionSeq = ++taskSelectionSeq;
    selectedTaskId.value = task.id;
    const hasCurrent = task.turns.some((t) => t.record_id === selectedId.value);
    if (resetToFirstTurn || !hasCurrent) {
      selectedId.value = task.turns[0]?.record_id || null;
      currentRecord.value = selectedId.value ? sessionTurnRecords.value[selectedId.value] || null : null;
    }
    isLoadingSessionTurns.value = task.turns.some((t) => !sessionTurnRecords.value[t.record_id]?.raw_loaded);
    await loadSessionTurns(task, selectionSeq);

    // A slower request from a previous task must never move the active record
    // away from the task the user currently selected.
    if (selectionSeq !== taskSelectionSeq || selectedTaskId.value !== task.id) return;

    if (task.turns && task.turns.length > 0) {
      await selectRecord(selectedId.value || task.turns[0].record_id);
    }
  };

  const selectSession = async (group: SessionCluster, resetToFirstTurn = true) => {
    selectedSessionId.value = group.id;
    const session = sessionNavigation(group, resetToFirstTurn ? null : selectedTaskId.value);
    if (group.attribution_mode === 'verified' && session) return selectTask(session, resetToFirstTurn);
    selectedTaskId.value = null;
    if (!session) return;
    const selectionSeq = ++taskSelectionSeq;
    if (resetToFirstTurn || !session.turns.some(t => t.record_id === selectedId.value)) {
      selectedId.value = session.turns[0]?.record_id || null;
    }
    currentRecord.value = selectedId.value ? sessionTurnRecords.value[selectedId.value] || null : null;
    isLoadingSessionTurns.value = session.turns.slice(0, 30).some(t => !sessionTurnRecords.value[t.record_id]);
    await loadSessionTurns(session, selectionSeq);
    if (selectionSeq !== taskSelectionSeq || selectedSessionId.value !== group.id) return;
    if (selectedId.value) await selectRecord(selectedId.value);
  };

  const syncActiveSelection = () => {
    const list = filteredSessions.value;
    if (list.length > 0) {
      const existing = list.find((s) => s.id === selectedSessionId.value);
      if (existing) {
        selectSession(existing, false);
      } else {
        selectSession(list[0], true);
      }
    } else {
      taskSelectionSeq++;
      isLoadingSessionTurns.value = false;
      selectedSessionId.value = null;
      selectedTaskId.value = null;
      selectedId.value = null;
      currentRecord.value = null;
    }
  };

  const scrollToTurn = (turnIndex: number, recordId: number) => {
    selectRecord(recordId);
    const el = document.getElementById(`turn-anchor-${turnIndex}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const onSearchInput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      syncActiveSelection();
    }, 150);
  };

  const fetchData = async (options?: { resetDiscovery?: boolean }) => {
    isRefreshing.value = true;
    loadError.value = null;
    try {
      if (isElectron()) {
        const api = (window as any).electronAPI;
        if (!api?.getSessions) throw new Error('会话接口未初始化，请重启应用');
        let nextStats: any;
        const statsTask = (async () => {
          try {
            nextStats = await api.getStats();
          } catch (statsErr) {
            console.warn('[useSessions] getStats error:', statsErr);
          }
        })();
        const response = await api.getSessions({ limit: 500 });
        if (!response || !Array.isArray(response.sessions)) {
          throw new Error('会话接口返回格式无效');
        }
        await statsTask;
        if (options?.resetDiscovery) {
          discoveredAgents.value = new Set();
          stats.value = nextStats || {};
        } else if (nextStats !== undefined) {
          stats.value = nextStats;
        }
        sessions.value = response.sessions;
      } else {
        let nextStats: any;
        const statsTask = fetch('/api/stats').then(async (statsResponse) => {
          if (statsResponse.ok) nextStats = await statsResponse.json();
        }).catch(() => {});
        const response = await fetch('/api/sessions?limit=500');
        if (!response.ok) {
          throw new Error(`会话接口请求失败（HTTP ${response.status}）`);
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.sessions)) throw new Error('会话接口返回格式无效');
        await statsTask;
        if (options?.resetDiscovery) {
          discoveredAgents.value = new Set();
          stats.value = nextStats || {};
        } else if (nextStats !== undefined) {
          stats.value = nextStats;
        }
        sessions.value = data.sessions;
      }
      if (!agentTabs.value.some((tab) => tab.id === activeAgent.value)) {
        activeAgent.value = 'Codex';
      }
      syncActiveSelection();
    } catch (err) {
      const message = err instanceof Error ? err.message : '会话数据加载失败';
      loadError.value = message;
      sessions.value = [];
      syncActiveSelection();
      console.error('[useSessions] Fetch error:', err);
    } finally {
      isRefreshing.value = false;
    }
  };

  const clearRecords = async () => {
    if (isElectron()) {
      await (window as any).electronAPI.clearRecords();
    } else {
      const response = await fetch('/api/clear', { method: 'POST' });
      if (!response.ok) throw new Error('清空历史内容失败');
    }
    selectedId.value = null;
    taskSelectionSeq++;
    isLoadingSessionTurns.value = false;
    selectedSessionId.value = null;
    selectedTaskId.value = null;
    currentRecord.value = null;
    sessionTurnRecords.value = {};
    await fetchData();
  };

  watch(activeAgent, () => {
    syncActiveSelection();
  });

  return {
    stats,
    sessions,
    selectedSessionId,
    selectedTaskId,
    selectedId,
    currentRecord,
    sessionTurnRecords,
    isLoadingSessionTurns,
    isRefreshing,
    loadError,
    searchQuery,
    activeAgent,
    agentTabs,
    currentTabInfo,
    filteredSessions,
    currentSession,
    currentSessionGroup,
    relatedTaskTurns,
    selectAgentTab,
    selectSession,
    selectTask,
    selectRecord,
    ensureRecordRawBody,
    ensureRelatedHistory,
    scrollToTurn,
    onSearchInput,
    syncActiveSelection,
    fetchData,
    clearRecords
  };
}
