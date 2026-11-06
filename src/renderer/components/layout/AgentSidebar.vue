<template>
  <div class="w-[72px] shrink-0 bg-slate-100/80 dark:bg-slate-950 border-r border-slate-200/80 dark:border-slate-800/80 flex flex-col items-center py-4 space-y-3.5 select-none z-10 transition-colors duration-200">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      @click="$emit('select', tab.id)"
      class="relative group w-[56px] py-2 px-1 flex flex-col items-center rounded-xl transition cursor-pointer"
      :class="activeAgent === tab.id ? tab.activeContainerClass : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900/60'"
      :title="`${getTabLabel(tab)} (${t('agent.sessionsCount', { count: tab.count })})`"
    >
      <!-- Active Indicator Pill on the left edge -->
      <div
        v-if="activeAgent === tab.id"
        class="absolute -left-[8px] top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full"
        :class="tab.indicatorClass"
      ></div>

      <!-- Icon Container -->
      <div
        class="relative w-9 h-9 rounded-xl flex items-center justify-center transition shadow-xs p-1"
        :class="activeAgent === tab.id ? tab.activeIconBoxClass : 'bg-white dark:bg-slate-900/80 border border-slate-200/80 dark:border-slate-800/80 group-hover:border-slate-300 dark:group-hover:border-slate-700'"
      >
        <img :src="tab.iconImg" :alt="getTabLabel(tab)" class="w-full h-full object-contain rounded-md transition-transform group-hover:scale-105" />
      </div>

      <!-- Tab Label -->
      <span
        class="text-[10px] font-medium tracking-tight mt-1.5 text-center leading-tight truncate max-w-full px-0.5"
        :class="activeAgent === tab.id ? tab.activeTextClass : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-800 dark:group-hover:text-slate-300'"
      >
        {{ getTabLabel(tab) }}
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { AgentCategory } from '../../types';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  tabs: Array<{
    id: AgentCategory;
    label: string;
    iconImg: string;
    count: number;
    activeContainerClass: string;
    indicatorClass: string;
    activeIconBoxClass: string;
    activeTextClass: string;
  }>;
  activeAgent: AgentCategory;
}>();

defineEmits<{
  (e: 'select', id: AgentCategory): void;
}>();

const { t } = useI18n();

const getTabLabel = (tab: { id: AgentCategory; label: string }) => {
  if (tab.id === 'Other') return t('agent.other');
  return tab.label;
};
</script>
