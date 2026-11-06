<template>
  <div class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-6 shadow-xs select-none transition-colors duration-200">
    <div class="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 flex-wrap gap-2">
      <div class="flex items-center space-x-2.5 flex-wrap gap-y-1">
        <div class="w-2.5 h-2.5 rounded-full" :class="agentIndicatorClass"></div>
        <h4 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {{ t('stats.modelBreakdown', { date }) }}
        </h4>
        <span
          class="text-[11px] font-medium px-2 py-0.5 rounded-md border"
          :class="agentBadgeClass"
        >
          {{ agentLabel }}
        </span>
        <span v-if="models.length" class="text-xs text-slate-400 dark:text-slate-500 font-mono">
          {{ t('stats.modelsCount', { count: models.length }) }}
        </span>
      </div>
      <button
        @click="$emit('close')"
        class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition cursor-pointer flex items-center gap-1"
      >
        <i class="fa-solid fa-xmark"></i>
        <span>{{ t('stats.collapse') }}</span>
      </button>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading" class="py-8 flex flex-col items-center justify-center text-slate-400">
      <i class="fa-solid fa-arrows-rotate animate-spin text-lg mb-2"></i>
      <span class="text-xs">{{ t('stats.summarizingDay', { agent: agentLabel }) }}</span>
    </div>

    <!-- Empty State -->
    <div v-else-if="models.length === 0" class="py-8 text-center text-xs text-slate-400 dark:text-slate-500">
      {{ t('stats.noRecordsDay') }}
    </div>

    <!-- Model Usage List -->
    <div v-else class="mt-4 space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
      <div
        v-for="(item, idx) in models"
        :key="item.model"
        class="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/60 dark:border-slate-800/60 hover:border-slate-300 dark:hover:border-slate-700 transition flex-wrap sm:flex-nowrap gap-2"
      >
        <!-- Left: Model Identity & Request Count -->
        <div class="flex items-center space-x-3 min-w-0 pr-4">
          <div class="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200/60 dark:border-indigo-800/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0 font-bold text-xs">
            #{{ idx + 1 }}
          </div>
          <div class="min-w-0">
            <div class="flex items-center space-x-2">
              <span class="text-xs font-semibold text-slate-800 dark:text-slate-100 font-mono truncate">
                {{ item.model }}
              </span>
            </div>
            <div class="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">
              {{ t('stats.requestFreq', { count: item.request_count.toLocaleString() }) }}
            </div>
          </div>
        </div>

        <!-- Right: Localized Total Token Count -->
        <div class="flex flex-col items-end shrink-0 font-mono text-right">
          <span v-if="!item.reported_requests" class="text-xs text-slate-500 dark:text-slate-400">{{ t('session.usageUnavailable') }}</span>
          <span v-else class="text-sm font-bold text-slate-900 dark:text-slate-100">
            {{ formatLocalizedTokens(item.total_tokens, locale) }} <span class="text-[10px] font-normal text-slate-400">Tokens</span>
          </span>
          <span v-if="item.reported_requests" class="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
            {{ t('stats.inputLabel', { tokens: formatLocalizedTokens(item.input_tokens, locale) }) }} · {{ t('stats.outputLabel', { tokens: formatLocalizedTokens(item.output_tokens, locale) }) }}
          </span>
          <span v-if="item.reported_requests < item.request_count" class="text-[10px] text-slate-400">{{ t('stats.unreportedRequests', { count: item.request_count - item.reported_requests }) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DayModelUsageItem, StatsAgentCategory } from '../../types';
import { formatLocalizedTokens } from '../../composables/useTokenActivity';
import { useI18n } from '../../composables/useI18n';

const props = withDefaults(
  defineProps<{
    date: string;
    models: DayModelUsageItem[];
    isLoading: boolean;
    selectedAgent?: StatsAgentCategory;
  }>(),
  {
    selectedAgent: 'all'
  }
);

defineEmits<{
  (e: 'close'): void;
  (e: 'refresh'): void;
}>();

const { t, locale } = useI18n();

const agentLabel = computed(() => {
  if (props.selectedAgent === 'all') return t('stats.allAgents');
  if (props.selectedAgent === 'Other') return t('agent.other');
  return props.selectedAgent || t('stats.allAgents');
});

const agentIndicatorClass = computed(() => {
  switch (props.selectedAgent) {
    case 'Codex': return 'bg-emerald-500';
    case 'Antigravity': return 'bg-blue-500';
    case 'Pi': return 'bg-orange-500';
    case 'WorkBuddy': return 'bg-violet-500';
    case 'Other': return 'bg-slate-400';
    default: return 'bg-indigo-500';
  }
});

const agentBadgeClass = computed(() => {
  switch (props.selectedAgent) {
    case 'Codex': return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800/60';
    case 'Antigravity': return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800/60';
    case 'Pi': return 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/60 dark:text-orange-300 dark:border-orange-800/60';
    case 'WorkBuddy': return 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/60 dark:text-violet-300 dark:border-violet-800/60';
    case 'Other': return 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';
    default: return 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800/60';
  }
});
</script>
