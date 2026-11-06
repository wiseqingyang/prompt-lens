<template>
  <div class="flex flex-col h-screen w-screen bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100 overflow-hidden select-text transition-colors duration-200">
    <!-- Top Header -->
    <AppHeader
      :is-mac-electron="isMacElectron"
      :listen-port="settings.settingsForm.value.proxy.listenPort"
      v-model:search-query="searchQuery"
      :is-refreshing="isRefreshing"
      @search="onSearchInput"
      @refresh="fetchData"
      @open-settings="settings.openSettings"
    />

    <!-- Main Workspace Split Container -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 1. Leftmost Column: Agent Tabs Column -->
      <AgentSidebar
        :tabs="agentTabs"
        :active-agent="activeAgent"
        @select="selectAgentTab"
      />

      <!-- 2. Second Column: Session List for Current Agent -->
      <SessionList
        :current-tab-info="currentTabInfo"
        :sessions="filteredSessions"
        :selected-session-id="selectedSessionId"
        :selected-task-id="selectedTaskId"
        :load-error="loadError"
        @select-session="selectSession"
        @select-turn="selectTask"
        @retry="fetchData"
      />

        <!-- 3. Right Column: Session Details View -->
        <div class="min-w-0 flex-1 flex flex-col bg-slate-50/50 dark:bg-slate-950 overflow-hidden transition-colors duration-200">
          <!-- Empty State -->
          <div v-if="!currentSession" class="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 p-8 select-none">
            <i class="fa-regular fa-comments text-3xl mb-3 text-slate-300 dark:text-slate-700"></i>
            <p class="text-xs font-medium">{{ t('session.emptyTitle') }}</p>
          </div>

          <!-- Detail Content -->
          <template v-else>
            <!-- Inspector Header -->
            <SessionDetailHeader
              :session="currentSession"
              :turns="relatedTaskTurns"
              :selected-record-id="selectedId"
              :selected-record="currentRecord"
              v-model:active-tab="activeTab"
              :bloat-multiplier="currentRecord?.anatomy?.bloat_multiplier"
              @jump-to-turn="handleJumpToTurn"
              @copy="copyText"
            />

            <!-- Tab Content Scrollable Area -->
            <div
              class="flex-1 overflow-y-auto p-3 sm:p-5"
              ref="chatScrollContainer"
              @scroll.passive="onChatScroll"
              @wheel="onChatWheel"
              @touchmove.passive="onChatWheel"
              @pointerdown="onChatPointerDown"
              @keydown="onChatKeyDown"
            >
              <TimelineView
                v-if="activeTab === 'messages'"
                ref="timelineViewRef"
                :session-id="selectedTaskId || selectedSessionId"
                :turns="chatTimelineTurns"
                :is-loading="isLoadingSessionTurns"
                :ensure-raw-body-fn="handleEnsureRawBody"
                @copy="copyText"
                @ensure-raw-body="handleEnsureRawBody"
                @ensure-related-history="ensureRelatedHistory"
                @export-fixture="handleExportFixture"
              />
              <AnatomyView
                v-else-if="activeTab === 'anatomy'"
                :record="currentRecord"
                @copy="copyText"
              />
            </div>
          </template>
        </div>
    </div>

    <!-- Settings Center Modal -->
    <SettingsModal
      :is-open="settings.isSettingsOpen.value"
      :settings="settings"
      :total-requests="stats.total_requests"
      :agent-options="agentTabs"
      @close="settings.isSettingsOpen.value = false"
      @copy="copyText"
      @clear-records="handleClearContent"
    />

    <div v-if="fixturePreview" role="dialog" aria-modal="true" aria-labelledby="export-title" class="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-5">
      <div class="bg-white dark:bg-slate-900 rounded-xl p-5 w-full max-w-3xl max-h-[90vh] flex flex-col gap-4 border border-slate-300 dark:border-slate-700">
        <h2 id="export-title" class="font-bold">{{ t('fixture.previewTitle', { id: fixturePreview.id }) }}</h2>
        <p class="text-sm text-amber-700 dark:text-amber-300">{{ t('fixture.warning') }}</p>
        <textarea v-model="fixturePreview.text" aria-label="待导出的用例 JSON" spellcheck="false" class="min-h-64 h-[50vh] w-full p-3 font-mono text-xs bg-slate-100 dark:bg-slate-950 border rounded-lg" />
        <div class="flex justify-end gap-3">
          <button class="px-4 py-2 border rounded-lg cursor-pointer text-xs" @click="fixturePreview = null">{{ t('common.cancel') }}</button>
          <button class="px-4 py-2 rounded-lg bg-indigo-600 text-white cursor-pointer text-xs font-semibold" @click="copyFixturePreview">{{ t('fixture.copyConfirmed') }}</button>
        </div>
      </div>
    </div>

    <!-- Floating Toast Notification -->
    <ToastNotification :message="toastMessage" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useSessions } from './composables/useSessions';
import { useSettings } from './composables/useSettings';
import { useTheme } from './composables/useTheme';
import { useI18n } from './composables/useI18n';
import { buildChatTimelineTurns } from './utils/messageParser';

// Components
import AppHeader from './components/layout/AppHeader.vue';
import AgentSidebar from './components/layout/AgentSidebar.vue';
import SessionList from './components/session/SessionList.vue';
import SessionDetailHeader from './components/session/SessionDetailHeader.vue';
import TimelineView from './components/timeline/TimelineView.vue';
import AnatomyView from './components/anatomy/AnatomyView.vue';
import SettingsModal from './components/settings/SettingsModal.vue';
import ToastNotification from './components/common/ToastNotification.vue';

// Theme Hook
const { initTheme, cleanupTheme } = useTheme();
const { t } = useI18n();

// Toast State
const toastMessage = ref('');
const showToast = (msg: string) => {
  toastMessage.value = msg;
  setTimeout(() => {
    toastMessage.value = '';
  }, 2500);
};

// Sessions Hook
const {
  stats,
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
  scrollToTurn,
  ensureRecordRawBody,
  ensureRelatedHistory,
  onSearchInput,
  fetchData,
  clearRecords
} = useSessions();

// Settings Hook
const settings = useSettings(fetchData, showToast);
const handleClearContent = async () => {
  try { await clearRecords(); await Promise.all([settings.loadSettings(), settings.loadDbInfo()]); showToast('历史内容已清空，用量统计保留'); }
  catch (error: any) { showToast(error.message || String(error)); }
};
const { isMacElectron } = settings;
const isElectron = () => typeof (window as any).electronAPI !== 'undefined';

// Active Inspector Tab ('messages' | 'anatomy')
const activeTab = ref<'messages' | 'anatomy'>('messages');
const chatScrollContainer = ref<HTMLElement | null>(null);
const timelineViewRef = ref<any>(null);

// Scroll Follow & Turn Tracking State
const isProgrammaticScroll = ref(false);
let userScrollMode = false;
let programmaticScrollTimer: any = null;
let scrollRafId: number | null = null;

// 点击轮次按钮平滑跳转
let jumpSelectionSeq = 0;
const handleJumpToTurn = async (turnIndex: number, recordId: number) => {
  const jumpSeq = ++jumpSelectionSeq;
  userScrollMode = false;
  isProgrammaticScroll.value = true;
  clearTimeout(programmaticScrollTimer);
  // Loading raw content changes card height. Scroll only after that layout settles.
  await selectRecord(recordId);
  if (jumpSeq !== jumpSelectionSeq || selectedId.value !== recordId) return;
  timelineViewRef.value?.ensureTurnVisible?.(turnIndex);
  await nextTick();
  scrollToTurn(turnIndex, recordId);
  programmaticScrollTimer = setTimeout(() => { isProgrammaticScroll.value = false; }, 650);
};

// 当用户点击展开某个轮次的原始 HTTP 报文或复制时，按需拉取完整 raw body 并自动同步 currentRecord
const handleEnsureRawBody = async (recordId: number) => {
  return await ensureRecordRawBody(recordId);
};

// 如果用户手动滑动滚轮，立即恢复手动滚动监听
const onChatWheel = () => {
  userScrollMode = true;
  if (isProgrammaticScroll.value) {
    jumpSelectionSeq++;
    clearTimeout(programmaticScrollTimer);
    isProgrammaticScroll.value = false;
  }
};

// Content expansion and browser scroll anchoring must not change selection.
// Track focus from actual user scrolling, including touch, keys and scrollbar.
const onChatPointerDown = (event: PointerEvent) => {
  userScrollMode = event.target === chatScrollContainer.value;
};
const onChatKeyDown = (event: KeyboardEvent) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) onChatWheel();
};

// 手动滚动时计算当前视口对应的活跃轮次
const updateActiveTurnOnScroll = () => {
  if (!userScrollMode || isProgrammaticScroll.value || activeTab.value !== 'messages') return;
  const container = chatScrollContainer.value;
  const turns = relatedTaskTurns.value;
  if (!container || !turns || turns.length <= 1) return;

  const syncScrollFocus = (turn: any) => {
    if (!turn || selectedId.value === turn.record_id) return;
    selectRecord(turn.record_id, false);
  };

  // 1. 接近顶部时（50px 内），激活第一轮
  if (container.scrollTop < 50) {
    syncScrollFocus(turns[0]);
    return;
  }

  // 2. 接近底部时（30px 内），若最后一轮已渲染在 DOM 中（如已展开全部或轮次较少），激活最后一轮
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 30) {
    const lastTurn = turns[turns.length - 1];
    if (document.getElementById(`turn-anchor-${lastTurn.turn_index}`)) {
      syncScrollFocus(lastTurn);
      return;
    }
  }

  // 3. 计算阅读视线基准线（取容器顶部向下 100px 处）
  const containerRect = container.getBoundingClientRect();
  const baseline = containerRect.top + 100;

  let activeTurn: any = null;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const el = document.getElementById(`turn-anchor-${t.turn_index}`);
    if (!el) continue;
    const rect = el.getBoundingClientRect();

    // 锚点顶部在基准线上方（或刚好），且底部在基准线下方
    if (rect.top <= baseline && rect.bottom > baseline) {
      activeTurn = t;
      break;
    }
    if (rect.top <= baseline) {
      activeTurn = t;
    }
  }

  if (activeTurn) {
    syncScrollFocus(activeTurn);
  }
};

const onChatScroll = () => {
  if (isProgrammaticScroll.value || activeTab.value !== 'messages') return;
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    updateActiveTurnOnScroll();
  });
};

// 切换 session 时重置右侧滚动位置到顶部
watch([selectedSessionId, selectedTaskId], () => {
  userScrollMode = false;
  jumpSelectionSeq++;
  clearTimeout(programmaticScrollTimer);
  isProgrammaticScroll.value = false;
  if (chatScrollContainer.value) {
    chatScrollContainer.value.scrollTop = 0;
  }
});

// Computed Chat Timeline Turns
const chatTimelineTurns = computed(() => {
  return buildChatTimelineTurns(currentSession.value, sessionTurnRecords.value);
});

// Clipboard Helper
const copyText = async (text: string, msg?: string): Promise<boolean> => {
  if (!text) { if (msg) showToast(msg); return false; }
  try {
    if (isElectron()) await (window as any).electronAPI.copyText(text);
    else await navigator.clipboard.writeText(text);
    showToast(msg || '已复制到剪贴板');
    return true;
  } catch { showToast('复制失败，请检查剪贴板权限'); return false; }
};

const fixturePreview = ref<{ id: number; text: string } | null>(null);
const copyFixturePreview = async () => {
  if (!fixturePreview.value) return;
  if (await copyText(fixturePreview.value.text, '已复制检查后的用例内容')) fixturePreview.value = null;
};

// Export Sanitized Fixture Handler
const handleExportFixture = async (recordId: number) => {
  try {
    let fixture: any = null;
    if (isElectron()) {
      fixture = await (window as any).electronAPI.exportFixture(recordId);
    } else {
      const res = await fetch(`/api/records/${recordId}/fixture`);
      if (res.ok) {
        fixture = await res.json();
      }
    }
    if (!fixture) {
      showToast('未找到该记录或导出失败');
      return;
    }
    fixturePreview.value = { id: recordId, text: JSON.stringify(fixture, null, 2) };
  } catch (err: any) {
    showToast(`导出失败: ${err?.message || err}`);
  }
};

let updateDebounceTimer: any = null;
let pollIntervalId: any = null;

const onWindowFocus = () => {
  fetchData();
};

onMounted(() => {
  initTheme();
  fetchData();

  if (isElectron()) {
    const api = (window as any).electronAPI;
    // 监听实时更新并做 800ms 防抖合并，避免高频流量打爆主线程
    api.onRecordUpdated(() => {
      clearTimeout(updateDebounceTimer);
      updateDebounceTimer = setTimeout(() => {
        fetchData();
      }, 800);
    });
    // 窗口切回时主动同步一次最新数据
    window.addEventListener('focus', onWindowFocus);
  } else {
    // 网页预览模式下使用温和的 10 秒轮询
    pollIntervalId = setInterval(fetchData, 10000);
  }

  onUnmounted(() => {
    cleanupTheme();
    clearTimeout(updateDebounceTimer);
    if (pollIntervalId) clearInterval(pollIntervalId);
    window.removeEventListener('focus', onWindowFocus);
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
    }
    clearTimeout(programmaticScrollTimer);
  });
});
</script>
