<template>
  <div class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-4 sm:p-5 shadow-xs select-none transition-colors duration-200">
    <!-- Header with Title and Mode Switcher -->
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <div class="flex items-center space-x-2">
        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">{{ t('stats.heatmapTitle') }}</h3>
        <span v-if="selectedDate" class="text-xs text-indigo-600 dark:text-indigo-400 font-medium">
          {{ t('stats.selectedDate', { date: selectedDate }) }}
        </span>
      </div>

      <!-- Segmented View Mode Tabs: [ 每日 | 每周 | 累计 ] -->
      <div class="flex items-center bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400">
        <button
          v-for="mode in modes"
          :key="mode.id"
          @click="$emit('update:viewMode', mode.id)"
          class="px-2.5 py-1 rounded-md transition cursor-pointer"
          :class="viewMode === mode.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs font-semibold' : 'hover:text-slate-700 dark:hover:text-slate-300'"
        >
          {{ mode.label }}
        </button>
      </div>
    </div>

    <!-- Heatmap Grid Container -->
    <div class="relative overflow-x-auto overflow-y-hidden pb-1 no-scrollbar select-none">
      <div class="w-fit mx-auto">
        <!-- 52-Week Grid Matrix -->
        <div class="flex items-start gap-[3px]">
          <div
            v-for="(week, wIdx) in weeks"
            :key="wIdx"
            class="flex flex-col gap-[3px]"
          >
            <div
              v-for="(cell, dIdx) in week"
              :key="`${wIdx}-${dIdx}`"
              @mouseenter="onHoverCell($event, cell)"
              @mouseleave="onLeaveCell"
              @click="onCellClick(cell)"
              class="w-[11px] h-[11px] rounded-[2.5px] transition-transform duration-100"
              :class="[
                getCellColorClass(cell),
                cell.isInFuture ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer hover:scale-125 hover:z-10',
                selectedDate === cell.date ? 'ring-2 ring-indigo-500 dark:ring-indigo-400 z-10' : ''
              ]"
            ></div>
          </div>
        </div>

        <!-- Month Labels Row -->
        <div class="relative h-4 mt-2 text-[10px] text-slate-400 dark:text-slate-500 font-mono select-none">
          <span
            v-for="m in monthLabels"
            :key="m.weekIndex"
            class="absolute whitespace-nowrap leading-none"
            :style="{ left: `${m.weekIndex * 14}px` }"
          >
            {{ m.label }}
          </span>
        </div>
      </div>
    </div>

    <!-- Floating Tooltip -->
    <div
      v-if="hoveredCell && tooltipPos"
      class="fixed z-50 pointer-events-none transform -translate-x-1/2 -translate-y-full mb-2 bg-slate-900/95 dark:bg-slate-950/95 text-white text-[11px] rounded-lg px-3 py-2 shadow-xl border border-slate-700/80 backdrop-blur-md transition-all duration-75 min-w-[140px]"
      :style="{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y - 8}px` }"
    >
      <div class="font-medium text-slate-200 border-b border-slate-800 pb-1 mb-1.5 flex items-center justify-between gap-2">
        <span class="truncate">{{ tooltipTitle }}</span>
        <span v-if="hoveredCell.tokens > 0" class="text-[10px] text-slate-400 font-mono shrink-0">
          {{ selectedAgent === 'all' ? t('stats.allAgents') : selectedAgent }}
        </span>
      </div>

      <div v-if="hoveredCell.tokens > 0" class="space-y-1 font-mono">
        <!-- 1. 如果是所有 Agent tab -->
        <template v-if="selectedAgent === 'all'">
          <!-- 若仅有一种 Agent 有数据：只展示这个 Agent 的数量，不展示合计 -->
          <template v-if="getActiveAgentBreakdown(hoveredCell).length === 1">
            <div
              v-for="ag in getActiveAgentBreakdown(hoveredCell)"
              :key="ag.name"
              class="font-semibold text-xs flex justify-between items-center gap-3"
              :class="ag.colorClass"
            >
              <span>{{ ag.name }}:</span>
              <span>{{ formatLocalizedTokens(ag.tokens, locale) }} Tokens</span>
            </div>
          </template>

          <!-- 若有多种 Agent 都有数据：展示总消耗，以及各个 Agent 的数量 -->
          <template v-else-if="getActiveAgentBreakdown(hoveredCell).length > 1">
            <div class="text-indigo-400 font-bold text-xs pb-1 border-b border-slate-800/60 flex justify-between items-center gap-3">
              <span>{{ totalUsageLabel }}</span>
              <span>{{ formatLocalizedTokens(hoveredCell.tokens, locale) }} Tokens</span>
            </div>
            <div class="space-y-1 text-[11px] pt-0.5">
              <div
                v-for="ag in getActiveAgentBreakdown(hoveredCell)"
                :key="ag.name"
                class="flex justify-between items-center gap-3"
                :class="ag.colorClass"
              >
                <span>{{ ag.name }}:</span>
                <span>{{ formatLocalizedTokens(ag.tokens, locale) }}</span>
              </div>
            </div>
          </template>

          <!-- 兜底（如果无分拆但有总数） -->
          <template v-else>
            <div class="text-indigo-400 font-semibold text-xs">
              {{ singleUsageLabel }} {{ formatLocalizedTokens(hoveredCell.tokens, locale) }} Tokens
            </div>
          </template>
        </template>

        <!-- 2. 如果是选定的特定 Agent：只展示总消耗 token，不要明细，计数本地化 -->
        <template v-else>
          <div class="text-slate-100 font-semibold text-xs">
            {{ singleUsageLabel }} {{ formatLocalizedTokens(hoveredCell.tokens, locale) }} Tokens
          </div>
        </template>
      </div>

      <div v-else-if="hoveredCell.isInFuture" class="text-slate-500 text-[10px]">
        {{ t('stats.futureDate') }}
      </div>
      <div v-else class="text-slate-400 text-[10px]">
        {{ t('stats.noUsage') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { HeatmapCell, HeatmapMonthLabel, ActivityViewMode, StatsAgentCategory } from '../../types';
import { formatLocalizedTokens } from '../../composables/useTokenActivity';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  weeks: HeatmapCell[][];
  monthLabels: HeatmapMonthLabel[];
  viewMode: ActivityViewMode;
  selectedAgent: StatsAgentCategory;
  selectedDate: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:viewMode', mode: ActivityViewMode): void;
  (e: 'select-day', date: string): void;
}>();

const { t, locale } = useI18n();

const modes = computed<Array<{ id: ActivityViewMode; label: string }>>(() => [
  { id: 'daily', label: t('stats.modeDaily') },
  { id: 'weekly', label: t('stats.modeWeekly') },
  { id: 'cumulative', label: t('stats.modeCumulative') }
]);

const hoveredCell = ref<HeatmapCell | null>(null);
const tooltipPos = ref<{ x: number; y: number } | null>(null);

const tooltipTitle = computed(() => {
  if (!hoveredCell.value) return '';
  if (props.viewMode === 'weekly' && hoveredCell.value.weekRange) {
    const weekNum = hoveredCell.value.weekNumber
      ? ` (${locale.value === 'zh-CN' ? `第${hoveredCell.value.weekNumber}周` : `W${hoveredCell.value.weekNumber}`})`
      : '';
    return `${hoveredCell.value.weekRange}${weekNum}`;
  }
  if (props.viewMode === 'cumulative') {
    return `${hoveredCell.value.date} (${t('stats.modeCumulative')})`;
  }
  return hoveredCell.value.date;
});

const totalUsageLabel = computed(() => {
  if (props.viewMode === 'weekly') return t('stats.weeklyUsage');
  if (props.viewMode === 'cumulative') return t('stats.cumulativeUsage');
  return t('stats.totalUsage');
});

const singleUsageLabel = computed(() => {
  if (props.viewMode === 'weekly') return t('stats.weeklyUsage');
  if (props.viewMode === 'cumulative') return t('stats.cumulativeUsage');
  return t('stats.usage');
});

const onHoverCell = (event: MouseEvent, cell: HeatmapCell) => {
  hoveredCell.value = cell;
  tooltipPos.value = {
    x: event.clientX,
    y: event.clientY
  };
};

const onLeaveCell = () => {
  hoveredCell.value = null;
  tooltipPos.value = null;
};

const onCellClick = (cell: HeatmapCell) => {
  if (cell.isInFuture) return;
  emit('select-day', cell.date);
};

const getCellColorClass = (cell: HeatmapCell): string => {
  if (cell.isInFuture) {
    return 'bg-slate-100 dark:bg-slate-800/40 border border-transparent';
  }
  switch (cell.level) {
    case 0:
      return 'bg-slate-100 dark:bg-slate-800/80 border border-slate-200/50 dark:border-slate-800';
    case 1:
      return 'bg-emerald-200 dark:bg-emerald-950/80 border border-emerald-300 dark:border-emerald-800/50';
    case 2:
      return 'bg-emerald-300 dark:bg-emerald-800 border border-emerald-400 dark:border-emerald-700/60';
    case 3:
      return 'bg-emerald-400 dark:bg-emerald-600 border border-emerald-500 dark:border-emerald-500';
    case 4:
      return 'bg-emerald-500 dark:bg-emerald-500 border border-emerald-600 dark:border-emerald-400';
    default:
      return 'bg-slate-100 dark:bg-slate-800';
  }
};

const getActiveAgentBreakdown = (cell: HeatmapCell) => {
  const list: Array<{ name: string; tokens: number; colorClass: string }> = [];
  const order: Array<{ key: string; label: string; colorClass: string }> = [
    { key: 'Codex', label: 'Codex', colorClass: 'text-emerald-400' },
    { key: 'Antigravity', label: 'Antigravity', colorClass: 'text-blue-400' },
    { key: 'Pi', label: 'Pi', colorClass: 'text-orange-400' },
    { key: 'WorkBuddy', label: 'WorkBuddy', colorClass: 'text-violet-400' },
    { key: 'Other', label: t('agent.other'), colorClass: 'text-slate-400' }
  ];
  for (const item of order) {
    const val = cell.agentBreakdown?.[item.key] || 0;
    if (val > 0) {
      list.push({
        name: item.label,
        tokens: val,
        colorClass: item.colorClass
      });
    }
  }
  return list;
};
</script>
