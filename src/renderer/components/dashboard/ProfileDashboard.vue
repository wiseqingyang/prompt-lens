<template>
  <div class="space-y-5 select-none">
    <!-- 1. Top Bar: Agent Category Switcher -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-slate-200/80 dark:border-slate-800/80">
      <div>
        <h3 class="text-base font-bold tracking-tight text-slate-900 dark:text-white">
          {{ t('stats.title') }}
        </h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {{ t('stats.subtitle') }}
        </p>
      </div>

      <!-- Agent Segmented Filter Pills -->
      <div role="group" aria-label="Agent 统计筛选" class="inline-flex items-center flex-wrap gap-1 bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-medium">
        <button
          v-for="agent in agentFilters"
          :key="agent.id"
          @click="onSelectAgent(agent.id)"
          :aria-pressed="selectedAgent === agent.id"
          class="px-3 py-1.5 rounded-lg transition cursor-pointer"
          :class="selectedAgent === agent.id ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'"
        >
          {{ getFilterLabel(agent) }}
        </button>
      </div>
    </div>

    <p v-if="error" role="alert" class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>

    <p v-if="isLoading" role="status" class="text-sm text-slate-500 dark:text-slate-400 py-8 text-center">{{ t('stats.loading') }}</p>

    <!-- 2. KPI Summary Bar -->
    <div v-if="!isLoading && !error" class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl py-5 px-4 shadow-xs select-none transition-colors duration-200">
      <div class="grid grid-cols-2 md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-slate-100 dark:divide-slate-800/80">
        <!-- 1. 累计 Token 数 -->
        <div class="flex flex-col items-center justify-center p-2 text-center min-w-0">
          <span class="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-mono whitespace-nowrap">
            {{ formatTokenDisplay(summary.total_tokens) }}
          </span>
          <span class="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium whitespace-nowrap">
            {{ t('stats.totalTokens') }}
          </span>
        </div>

        <!-- 2. 峰值 Token 数 -->
        <div class="flex flex-col items-center justify-center p-2 text-center min-w-0">
          <span class="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-mono whitespace-nowrap">
            {{ formatTokenDisplay(summary.peak_tokens) }}
          </span>
          <span class="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium whitespace-nowrap">
            {{ t('stats.peakTokens') }}
          </span>
        </div>

        <!-- 3. 最长任务用时 -->
        <div class="flex flex-col items-center justify-center p-2 text-center min-w-0">
          <span class="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-mono whitespace-nowrap">
            {{ formatDurationDisplay(summary.max_duration_ms) }}
          </span>
          <span class="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium whitespace-nowrap">
            {{ t('stats.longestDuration') }}
          </span>
        </div>

        <!-- 4. 当前连续天数 -->
        <div class="flex flex-col items-center justify-center p-2 text-center min-w-0">
          <span class="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-mono whitespace-nowrap">
            {{ t('stats.daysUnit', { count: summary.current_streak }) }}
          </span>
          <span class="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium whitespace-nowrap">
            {{ t('stats.currentStreak') }}
          </span>
        </div>

        <!-- 5. 最长连续天数 -->
        <div class="flex flex-col items-center justify-center p-2 text-center col-span-2 md:col-span-1 min-w-0">
          <span class="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-mono whitespace-nowrap">
            {{ t('stats.daysUnit', { count: summary.longest_streak }) }}
          </span>
          <span class="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium whitespace-nowrap">
            {{ t('stats.longestStreak') }}
          </span>
        </div>
      </div>
    </div>

    <!-- 3. Token Activity Contribution Heatmap -->
    <TokenActivityHeatmap
      v-if="!isLoading && !error"
      :weeks="heatmapData.weeks"
      :month-labels="heatmapData.monthLabels"
      v-model:view-mode="viewMode"
      :selected-agent="selectedAgent"
      :selected-date="selectedDate"
      @select-day="selectDay"
    />

    <!-- 4. Selected Day Model Usage Breakdown -->
    <DayDetailPanel
      v-if="selectedDate && !isLoading && !error"
      :date="selectedDate"
      :selected-agent="selectedAgent"
      :models="dayModelUsages"
      :is-loading="isLoadingDayModels"
      @close="selectDay(selectedDate)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import type { AgentCategory, StatsAgentCategory } from '../../types';
import { useTokenActivity, formatLocalizedTokens } from '../../composables/useTokenActivity';
import TokenActivityHeatmap from './TokenActivityHeatmap.vue';
import DayDetailPanel from './DayDetailPanel.vue';
import { useI18n } from '../../composables/useI18n';

const props = withDefaults(defineProps<{
  agentOptions?: Array<{ id: AgentCategory; label: string }>;
}>(), {
  agentOptions: () => [
    { id: 'Codex', label: 'Codex' },
    { id: 'Other', label: '其他' }
  ]
});

const { t, locale } = useI18n();

const {
  selectedAgent,
  viewMode,
  isLoading,
  error,
  summary,
  selectedDate,
  dayModelUsages,
  isLoadingDayModels,
  heatmapData,
  fetchActivity,
  selectDay,
  formatDurationChinese
} = useTokenActivity();

const agentFilters = computed<Array<{ id: StatsAgentCategory; label: string }>>(() => [
  { id: 'all', label: t('stats.allAgents') },
  ...props.agentOptions.map(({ id, label }) => ({ id, label }))
]);

const getFilterLabel = (agent: { id: StatsAgentCategory; label: string }) => {
  if (agent.id === 'all') return t('stats.allAgents');
  if (agent.id === 'Other') return t('agent.other');
  return agent.label;
};

const formatTokenDisplay = (n: number | null | undefined): string => {
  return formatLocalizedTokens(n, locale.value);
};

const formatDurationDisplay = (ms: number | null | undefined): string => {
  if (!ms || ms <= 0) return locale.value === 'zh-CN' ? '0 分' : '0m';
  if (locale.value === 'zh-CN') {
    return formatDurationChinese(ms);
  }
  if (ms >= 3600000) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }
  if (ms >= 60000) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds}s`;
};

watch(() => props.agentOptions, (options) => {
  if (selectedAgent.value !== 'all' && !options.some((item) => item.id === selectedAgent.value)) {
    void fetchActivity('all');
  }
}, { deep: true });

const onSelectAgent = (agent: StatsAgentCategory) => {
  selectedAgent.value = agent;
  void fetchActivity(agent);
};

onMounted(() => {
  void fetchActivity(selectedAgent.value);
});
</script>
