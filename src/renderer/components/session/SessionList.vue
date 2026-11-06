<template>
  <div class="w-[180px] sm:w-[240px] lg:w-[320px] xl:w-[370px] shrink-0 border-r border-slate-200/80 dark:border-slate-800/80 flex flex-col bg-white/60 dark:bg-slate-950/60 backdrop-blur-xs transition-colors duration-200">
    <!-- Header of Conversation List -->
    <div class="px-3.5 py-2.5 bg-slate-50/80 dark:bg-slate-900/60 border-b border-slate-200/80 dark:border-slate-800/80 shrink-0 select-none flex items-center justify-between gap-2 min-w-0">
      <div class="flex items-center space-x-2 min-w-0">
        <img :src="currentTabInfo.iconImg" :alt="currentTabLabel" class="w-4 h-4 object-contain rounded-xs shrink-0" />
        <span class="text-xs font-bold text-slate-800 dark:text-slate-200 tracking-tight truncate">{{ t('session.sessionsHeader', { agent: currentTabLabel }) }}</span>
      </div>
      <span class="text-slate-500 dark:text-slate-400 font-mono text-[11px] px-2 py-0.5 rounded-md bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800/80 shrink-0 whitespace-nowrap">
        {{ t('session.sessionsCount', { count: conversations.length }) }}
      </span>
    </div>

    <!-- One chronological stream for conversations and request collections -->
    <div
      class="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/50"
      aria-label="请求时间流"
      @scroll.passive="onListScroll"
    >
      <div v-if="loadError" class="p-8 text-center text-red-500 dark:text-red-400 text-xs flex flex-col items-center justify-center space-y-3">
        <i class="fa-solid fa-triangle-exclamation text-2xl"></i>
        <span>{{ loadError }}</span>
        <button class="px-3 py-1.5 rounded-md border border-red-200 dark:border-red-900/60 hover:bg-red-50 dark:hover:bg-red-950/40 transition cursor-pointer" @click="$emit('retry')">{{ t('common.reload') }}</button>
      </div>
      <div v-else-if="sessions.length === 0" class="p-8 text-center text-slate-400 dark:text-slate-500 text-xs flex flex-col items-center justify-center space-y-2">
        <i class="fa-regular fa-folder-open text-2xl text-slate-300 dark:text-slate-600"></i>
        <span>{{ t('session.noRecords', { agent: currentTabLabel }) }}</span>
      </div>

      <div
        v-for="s in visibleSessions"
        :key="s.id"
        :data-navigation-kind="s.kind || 'session'"
        @click="$emit('select-session', s)"
        class="p-3 hover:bg-slate-100/70 dark:hover:bg-slate-900/50 cursor-pointer transition border-l-2 flex flex-col gap-1.5"
        :class="selectedSessionId === s.id ? 'bg-indigo-50/80 dark:bg-slate-900/80 border-indigo-600 dark:border-indigo-500 shadow-xs' : 'border-transparent'"
      >
        <!-- Row 1: Agent Badge + Record ID Range + Duration + Time -->
        <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] font-mono">
          <div class="flex items-center space-x-1.5 min-w-0">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0" :class="agentBadgeClass(s.agent_name)">
              {{ s.agent_name }}
            </span>
            <span
              v-if="formatRecordIdRange(s)"
              class="px-1.5 py-0.2 rounded text-[10px] font-mono font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0"
              :title="t('session.recordId', { id: formatRecordIdRange(s) })"
            >
              {{ formatRecordIdRange(s) }}
            </span>
          </div>
          <div class="flex items-center space-x-1.5 text-slate-400 dark:text-slate-500 shrink-0">
            <span>{{ (s.total_duration_ms / 1000).toFixed(1) }}s</span>
            <span>·</span>
            <span>{{ formatTime(s.updated_at) }}</span>
          </div>
        </div>

        <!-- Row 2: Model Name -->
        <div v-if="s.model" class="text-[11px] font-mono text-slate-600 dark:text-slate-300 font-medium break-all leading-snug flex items-center gap-1.5" :title="s.model">
          <i class="fa-solid fa-robot text-[10px] text-slate-400 dark:text-slate-500 shrink-0"></i>
          <span>{{ s.model }}</span>
        </div>

        <!-- Row 3: User Prompt -->
        <div class="text-xs text-slate-800 dark:text-slate-200 line-clamp-2 leading-relaxed font-mono font-normal">
          {{ shortTitle(s.title, 44) }}
        </div>

        <!-- Row 4: Turns + Tokens (input, cache, output, thinking) + Tools -->
        <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] font-mono text-slate-500 dark:text-slate-400 pt-0.5">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
            <span class="text-slate-700 dark:text-slate-300 font-semibold shrink-0">
              <template v-if="s.attribution_mode !== 'verified' || s.tasks_count > 0">
                <span>{{ s.attribution_mode === 'verified' ? t('session.turnsCount', { count: s.tasks_count }) : t('session.inferredGroups', { count: s.tasks_count || s.tasks.length || 1 }) }}</span>
                <span class="mx-1">&middot;</span>
              </template>
              {{ s.kind === 'connection' ? t('session.eventsCount', { count: s.turns_count }) : t('session.requestsCount', { count: s.turns_count }) }}
            </span>
            <span v-if="s.kind !== 'connection' && !s.tasks.some(task => task.turns.some(turn => turn.token_source === 'reported'))">{{ t('session.usageUnavailable') }}</span>
            <template v-if="s.kind !== 'connection' && s.tasks.some(task => task.turns.some(turn => turn.token_source === 'reported'))">
              <span class="text-slate-300 dark:text-slate-600">·</span>
              <span class="shrink-0">
                input <span class="text-blue-600 dark:text-blue-400 font-medium">{{ formatTokens(s.total_input_tokens) }}</span><span v-if="s.total_cached_tokens > 0" class="text-emerald-600 dark:text-emerald-400 font-medium">(cache {{ formatTokens(s.total_cached_tokens) }} {{ s.cache_ratio }}%)</span>
              </span>
              <span class="shrink-0">
                output <span class="text-pink-600 dark:text-pink-400 font-medium">{{ formatTokens(s.total_output_tokens) }}</span>
              </span>
              <span v-if="s.total_thinking_tokens > 0" class="shrink-0">
                thinking <span class="text-purple-600 dark:text-purple-400 font-medium">{{ formatTokens(s.total_thinking_tokens) }}</span>
              </span>
            </template>
          </div>
          <span v-if="s.tasks.some((task) => hasActionTurn(task))" class="text-indigo-600 dark:text-indigo-400 text-[10px] shrink-0 font-medium" :title="t('session.hasToolsTitle')">
            {{ t('session.hasTools') }}
          </span>
        </div>
        <div v-if="s.attribution_mode === 'verified' && (s.kind === 'auxiliary' || s.kind === 'connection' || s.tasks_count > 0 || s.tasks.length > 1) && selectedSessionId === s.id" class="mt-1 space-y-1 border-l border-indigo-200 dark:border-slate-700 pl-2" :aria-label="s.kind === 'auxiliary' ? '辅助请求用途' : s.kind === 'connection' ? '连接异常类型' : '会话轮次'">
          <button v-for="task in s.tasks" :key="task.id" type="button"
            :aria-pressed="selectedTaskId === task.id" @click.stop="$emit('select-turn', task)"
            class="w-full text-left rounded-md px-2 py-2 text-xs cursor-pointer"
            :class="selectedTaskId === task.id ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-500/20 dark:text-indigo-200' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400'">
            <span class="block truncate" :title="task.user_prompt">{{ shortTitle(task.user_prompt, 32) }}</span>
            <span class="block mt-1 text-[10px] opacity-70">{{ task.turns_count }} {{ task.kind === 'connection' ? t('session.eventsCount', { count: task.turns_count }) : t('session.requestsCount', { count: task.turns_count }) }}</span>
          </button>
        </div>
      </div>

      <!-- Progressive Loading Indicator / End of List -->
      <div
        v-if="visibleSessions.length < sessions.length"
        class="py-3 text-center text-slate-400 dark:text-slate-500 text-[11px] select-none"
      >
        <span>{{ t('session.loadedProgress', { visible: visibleSessions.length, total: sessions.length }) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { shortTitle } from '../../utils/sessionNavigation';
import { isConversation } from '../../utils/requestNavigation';
import { ref, computed, watch } from 'vue';
import type { Session, SessionCluster } from '../../types';
import { agentBadgeClass, formatTime, formatTokens, hasActionTurn } from '../../utils/formatters';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  currentTabInfo: {
    label: string;
    iconImg: string;
    id?: string;
  };
  sessions: SessionCluster[];
  selectedSessionId: string | null;
  selectedTaskId?: string | null;
  loadError: string | null;
}>();

defineEmits<{
  (e: 'select-session', session: SessionCluster): void;
  (e: 'retry'): void;
  (e: 'select-turn', turn: Session): void;
}>();

const { t } = useI18n();

const currentTabLabel = computed(() => {
  if (props.currentTabInfo.id === 'Other' || props.currentTabInfo.label === '其他') {
    return t('agent.other');
  }
  return props.currentTabInfo.label;
});

const formatRecordIdRange = (s: SessionCluster): string => {
  if (!s.tasks?.length) return '';
  const ids = s.tasks.flatMap(t => t.turns.map(r => r.record_id)).filter(id => typeof id === 'number');
  if (!ids.length) return '';
  const min = Math.min(...ids);
  const max = Math.max(...ids);
  return min === max ? `${min}` : `${min}-${max}`;
};

// 视口切片渲染：默认显示前 35 条，滚动到底部附近自动追加 25 条
const displayLimit = ref(35);
const conversations = computed(() => props.sessions.filter(isConversation));

const visibleSessions = computed(() => {
  return props.sessions.slice(0, displayLimit.value);
});

// 监听滚动，平滑追加
const onListScroll = (e: Event) => {
  const el = e.target as HTMLElement;
  if (!el) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 150) {
    if (displayLimit.value < props.sessions.length) {
      displayLimit.value += 25;
    }
  }
};

watch(() => props.selectedSessionId, () => {
  displayLimit.value = 35;
});
</script>
