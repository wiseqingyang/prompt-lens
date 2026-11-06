<template>
  <div class="detail-header shrink-0 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/90 dark:bg-slate-900/90 px-3 sm:px-5 py-3">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 min-w-0">
      <div class="flex-1 min-w-0 basis-[220px]">
        <div class="flex items-center gap-2 min-w-0">
          <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0" :class="agentBadgeClass(session.agent_name)">{{ session.agent_name }}</span>
          <span v-if="session.kind !== 'connection'" class="font-semibold text-slate-900 dark:text-slate-100 text-xs font-mono truncate min-w-0" :title="session.kind === 'auxiliary' ? selectedRecord?.model : session.model">{{ session.kind === 'auxiliary' ? selectedRecord?.model : session.model }}</span>
          <button v-if="selectedRecordId" @click="$emit('copy', String(selectedRecordId))"
            class="shrink-0 flex items-center gap-1 text-[10px] font-mono text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 cursor-pointer"
            :title="t('detailHeader.copyRecordId', { id: selectedRecordId })">
            <span>#{{ selectedRecordId }}</span><i class="fa-regular fa-copy text-[9px]"></i>
          </button>
          <span v-if="selectedRecord?.confidence === 'heuristic'" class="text-[10px] text-amber-600 dark:text-amber-400 shrink-0" :title="t('detailHeader.autoDetectedTitle')">{{ t('detailHeader.autoDetected') }}</span>
        </div>
        <div class="mt-1.5 text-[10px] text-slate-400 dark:text-slate-500 flex flex-wrap gap-x-2 gap-y-0.5">
          <span>{{ t('detailHeader.totalDuration') }} <span class="font-mono">{{ (session.total_duration_ms / 1000).toFixed(1) }}s</span></span>
          <span class="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
          <span class="font-mono">{{ formatDateTime(session.created_at) }}</span>
        </div>
      </div>
      <div class="flex shrink-0 bg-slate-100/80 dark:bg-slate-950/70 p-0.5 rounded-lg text-xs">
        <button @click="$emit('update:activeTab', 'messages')" class="px-3 py-1.5 font-medium rounded-md transition cursor-pointer whitespace-nowrap"
          :class="activeTab === 'messages' ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-300 shadow-xs' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'">
          <i class="fa-regular fa-comments mr-1.5 text-[11px]"></i>{{ t('detailHeader.tabTimeline') }}
        </button>
        <button @click="$emit('update:activeTab', 'anatomy')" class="px-3 py-1.5 font-medium rounded-md transition cursor-pointer whitespace-nowrap"
          :class="activeTab === 'anatomy' ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-300 shadow-xs' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'">
          <i class="fa-solid fa-layer-group mr-1.5 text-[11px]"></i>{{ t('detailHeader.tabAnatomy') }}
        </button>
      </div>
    </div>

    <div v-if="session.kind === 'turn' || session.kind === 'auxiliary' || session.kind === 'connection'" class="mt-2 text-xs text-slate-600 dark:text-slate-300" :aria-label="session.kind === 'turn' ? '当前轮次' : session.kind === 'connection' ? '当前异常' : '当前用途'">
      <span class="block truncate" :title="session.user_prompt">{{ session.user_prompt }}</span>
    </div>
    <div v-if="communication.transport || communication.format || communication.api || communication.address" class="communication-strip flex flex-wrap items-center gap-x-3 gap-y-2 mt-3 py-2 px-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-100 dark:border-slate-800/70 min-w-0 min-h-10" aria-label="当前请求通信信息">
      <div v-if="communication.transport || communication.format" class="flex items-center gap-1.5 shrink-0" :title="selectedRecord?.body_encoding">
        <span v-if="communication.transport" class="protocol-badge inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300 ring-1 ring-inset ring-teal-600/15 dark:ring-teal-400/20" :title="t('detailHeader.transport')">
          <i class="fa-solid fa-arrow-right-arrow-left text-[9px] opacity-60"></i>{{ communication.transport }}
        </span>
        <span v-if="communication.format" class="payload-badge text-[10px] font-mono text-slate-500 dark:text-slate-400 px-1.5 py-0.5 rounded bg-slate-200/50 dark:bg-slate-800/80" :title="t('detailHeader.format')">{{ communication.format }}</span>
      </div>
      <div v-if="communication.api" class="flex items-center gap-1.5 shrink-0">
        <span class="text-[10px] text-slate-400 dark:text-slate-500">{{ t('detailHeader.api') }}</span>
        <span class="api-name text-xs font-semibold text-slate-700 dark:text-slate-200">{{ communication.api }}</span>
      </div>
      <div v-if="communication.address" class="communication-address flex items-center gap-1.5 flex-1 min-w-0 basis-[160px]" :title="communication.address">
        <span class="text-[10px] text-slate-400 dark:text-slate-500 shrink-0">{{ communication.address.includes('://') ? t('detailHeader.address') : t('detailHeader.path') }}</span>
        <span class="address-value truncate font-mono text-[10px] text-slate-500 dark:text-slate-400 select-text">{{ communication.address }}</span>
      </div>
    </div>
    <div v-if="session.kind !== 'connection' && (selectedRecord?.attribution === 'connection' || selectedRecord?.truncated_reason)" class="flex flex-wrap gap-2 mt-2 text-[10px] text-amber-700 dark:text-amber-400">
      <span v-if="selectedRecord?.attribution === 'connection'" title="此记录无法归属于具体模型请求">{{ t('detailHeader.connectionDiag') }}</span>
      <span v-if="selectedRecord?.truncated_reason" :title="selectedRecord.truncated_reason">{{ selectedRecord.capture_status === 'error' ? t('detailHeader.abnormalResponse') : t('detailHeader.incompleteCapture') }} <i class="fa-regular fa-circle-question opacity-60"></i></span>
    </div>

    <div class="mt-3 pt-2 border-t border-slate-100 dark:border-slate-800/70 space-y-1">
      <div class="header-grid" aria-label="会话请求导航">
        <div class="header-label flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400" data-header-label="requests" title="每次模型调用计为一次请求，请求数不等于用户问答次数">
          <span class="whitespace-nowrap">{{ session.kind === 'connection' ? t('detailHeader.groupEvents') : session.kind ? t('detailHeader.groupRequests') : t('detailHeader.sessionRequests') }}</span>
          <span v-if="currentTurnIndex !== null" class="font-mono text-[10px] text-slate-700 dark:text-slate-300 whitespace-nowrap">{{ currentTurnIndex }}/{{ turns.length }}</span>
        </div>
        <div class="request-track flex items-center gap-1 min-w-0 h-9" data-header-track="requests">
          <button @click="scrollTurns('left')" :disabled="!canScrollLeft" :class="{ invisible: !hasOverflow }" :aria-hidden="!hasOverflow" :tabindex="hasOverflow ? 0 : -1"
            class="nav-control" data-header-arrow="left" :title="t('detailHeader.scrollLeft')" :aria-label="t('detailHeader.scrollLeft')">
            <i class="fa-solid fa-chevron-left text-[9px]"></i>
          </button>
          <div ref="turnsScrollRef" @scroll="updateScrollState" @wheel="handleWheel" class="request-buttons flex-1 min-w-0 h-9 overflow-x-auto no-scrollbar scroll-smooth flex items-center gap-1">
            <button v-for="tTurn in turns" :key="tTurn.record_id" :ref="(el) => setTurnButtonRef(tTurn.record_id, el)" @click="$emit('jump-to-turn', tTurn.turn_index, tTurn.record_id)"
              class="request-button shrink-0 flex items-center gap-1 h-7 px-2 rounded-md border text-[11px] transition cursor-pointer"
              :class="selectedRecordId === tTurn.record_id ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-500/15 dark:border-indigo-500/40 dark:text-indigo-200 font-medium' : 'bg-slate-50 border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:bg-slate-800/50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'"
              :aria-current="selectedRecordId === tTurn.record_id ? 'step' : undefined" :title="`R${tTurn.turn_index} (#${tTurn.record_id})${formatTurnSummary(tTurn) ? ': ' + formatTurnSummary(tTurn) : ''}`">
              <span class="truncate">{{ formatTurnSummary(tTurn) ? `R${tTurn.turn_index} · ${formatTurnSummary(tTurn)}` : `R${tTurn.turn_index}` }}</span>
              <i v-if="tTurn.turn_type === 'thought_and_action'" class="fa-solid fa-wrench text-[9px] opacity-60" aria-label="含工具调用"></i>
              <i v-else-if="tTurn.turn_type === 'error'" class="fa-solid fa-triangle-exclamation text-[9px] text-amber-500" aria-label="请求异常"></i>
            </button>
          </div>
          <button @click="scrollTurns('right')" :disabled="!canScrollRight" :class="{ invisible: !hasOverflow }" :aria-hidden="!hasOverflow" :tabindex="hasOverflow ? 0 : -1"
            class="nav-control" data-header-arrow="right" :title="t('detailHeader.scrollRight')" :aria-label="t('detailHeader.scrollRight')">
            <i class="fa-solid fa-chevron-right text-[9px]"></i>
          </button>
          <div class="hidden lg:flex items-center gap-0.5 pl-1 ml-1 border-l border-slate-200 dark:border-slate-800 shrink-0" :class="{ invisible: turns.length < 8 }" :aria-hidden="turns.length < 8">
            <button @click="jumpToFirstTurn" class="nav-control" :tabindex="turns.length >= 8 ? 0 : -1" :title="t('detailHeader.jumpFirst')" :aria-label="t('detailHeader.jumpFirst')"><i class="fa-solid fa-backward-step text-[9px]"></i></button>
            <button @click="jumpToLastTurn" class="nav-control" :tabindex="turns.length >= 8 ? 0 : -1" :title="t('detailHeader.jumpLast')" :aria-label="t('detailHeader.jumpLast')"><i class="fa-solid fa-forward-step text-[9px]"></i></button>
          </div>
        </div>
      </div>
      <div v-if="session.kind !== 'connection'" class="header-grid" aria-label="会话累计用量">
        <span class="header-label text-[11px] text-slate-400 dark:text-slate-500" data-header-label="usage">{{ t('detailHeader.reportedUsage') }}</span>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 min-h-6 pl-7 text-[10px] text-slate-400 dark:text-slate-500">
          <span v-if="!turns.some(turn => turn.token_source === 'reported')">{{ t('session.usageUnavailable') }}</span>
          <template v-else>
            <span>{{ t('detailHeader.input') }} <span class="font-mono text-blue-600 dark:text-blue-400" :title="formatNum(session.total_input_tokens)">{{ formatTokens(session.total_input_tokens) }}</span></span>
            <span>{{ t('detailHeader.output') }} <span class="font-mono text-pink-600 dark:text-pink-400" :title="formatNum(session.total_output_tokens)">{{ formatTokens(session.total_output_tokens) }}</span></span>
            <span v-if="session.total_cached_tokens > 0">{{ t('detailHeader.cache') }} <span class="font-mono text-emerald-600 dark:text-emerald-400" :title="`${formatNum(session.total_cached_tokens)} tokens · ${session.cache_ratio}%`">{{ formatTokens(session.total_cached_tokens) }}</span></span>
            <span v-if="session.total_thinking_tokens > 0">{{ t('detailHeader.thinking') }} <span class="font-mono text-purple-600 dark:text-purple-400" :title="formatNum(session.total_thinking_tokens)">{{ formatTokens(session.total_thinking_tokens) }}</span></span>
          </template>
          <span v-if="bloatMultiplier" :title="t('detailHeader.bloatMultiplier', { n: formatNum(bloatMultiplier) })">{{ t('detailHeader.context') }} <span class="font-mono text-slate-600 dark:text-slate-300">{{ formatNum(bloatMultiplier) }}×</span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { Session, TaskTurn, RecordDetail } from '../../types';
import { describeCommunication } from '../../../shared/communication';
import { cleanPromptSummary } from '../../../shared/protocol';
import { shortTitle } from '../../utils/sessionNavigation';
import { agentBadgeClass, formatDateTime, formatNum, formatTokens } from '../../utils/formatters';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  session: Session;
  turns: TaskTurn[];
  selectedRecordId: number | null;
  selectedRecord?: RecordDetail | null;
  activeTab: 'messages' | 'anatomy';
  bloatMultiplier?: number;
}>();

const emit = defineEmits<{
  (e: 'update:activeTab', tab: 'messages' | 'anatomy'): void;
  (e: 'jump-to-turn', turnIndex: number, recordId: number): void;
  (e: 'copy', text: string): void;
}>();

const { t } = useI18n();

const communication = computed(() => describeCommunication(props.selectedRecord || {}));

const formatTurnSummary = (tTurn: TaskTurn) => {
  const clean = cleanPromptSummary(tTurn.summary || '');
  if (!clean) return '';
  return shortTitle(clean, 24);
};

const turnsScrollRef = ref<HTMLElement | null>(null);
const turnButtonRefs = new Map<number, HTMLElement>();

const setTurnButtonRef = (recordId: number, el: any) => {
  if (el) {
    turnButtonRefs.set(recordId, el as HTMLElement);
  } else {
    turnButtonRefs.delete(recordId);
  }
};

const hasOverflow = ref(false);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);

const updateScrollState = () => {
  const el = turnsScrollRef.value;
  if (!el) return;
  const tolerance = 2;
  hasOverflow.value = el.scrollWidth > el.clientWidth + tolerance;
  canScrollLeft.value = el.scrollLeft > tolerance;
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - tolerance;
};

const scrollTurns = (direction: 'left' | 'right') => {
  const el = turnsScrollRef.value;
  if (!el) return;
  const distance = Math.max(el.clientWidth * 0.6, 120);
  el.scrollBy({ left: direction === 'left' ? -distance : distance, behavior: 'smooth' });
};

const handleWheel = (e: WheelEvent) => {
  const el = turnsScrollRef.value;
  if (!el || !hasOverflow.value) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    el.scrollLeft += e.deltaY;
    updateScrollState();
  }
};

const jumpToFirstTurn = () => {
  if (!props.turns.length) return;
  const first = props.turns[0];
  emit('jump-to-turn', first.turn_index, first.record_id);
};

const jumpToLastTurn = () => {
  if (!props.turns.length) return;
  const last = props.turns[props.turns.length - 1];
  emit('jump-to-turn', last.turn_index, last.record_id);
};

const currentTurnIndex = computed(() => {
  if (props.selectedRecordId === null) return null;
  const turn = props.turns.find(tTurn => tTurn.record_id === props.selectedRecordId);
  return turn ? turn.turn_index : null;
});

const scrollToActiveButton = (behavior: ScrollBehavior = 'smooth') => {
  if (props.selectedRecordId === null) return;
  const btn = turnButtonRefs.get(props.selectedRecordId);
  const container = turnsScrollRef.value;
  if (!btn || !container) return;
  const btnLeft = btn.offsetLeft;
  const btnRight = btnLeft + btn.offsetWidth;
  const containerLeft = container.scrollLeft;
  const containerRight = containerLeft + container.clientWidth;
  if (btnLeft < containerLeft || btnRight > containerRight) {
    const targetScroll = btnLeft - container.clientWidth / 2 + btn.offsetWidth / 2;
    container.scrollTo({ left: Math.max(0, targetScroll), behavior });
  }
};

watch(() => props.selectedRecordId, () => {
  void nextTick(() => {
    scrollToActiveButton('smooth');
    updateScrollState();
  });
});

watch(() => props.turns, () => {
  void nextTick(() => {
    updateScrollState();
    scrollToActiveButton('auto');
  });
}, { deep: true });

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  void nextTick(() => {
    updateScrollState();
    scrollToActiveButton('auto');
  });
  if (turnsScrollRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => updateScrollState());
    resizeObserver.observe(turnsScrollRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});
</script>
