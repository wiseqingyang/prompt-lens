<template>
  <header class="relative z-30 bg-white/85 dark:bg-slate-900/90 border-b border-slate-200/80 dark:border-slate-800/80 px-3 sm:px-4 h-12 flex items-center justify-between shadow-xs shrink-0 app-drag-region select-none backdrop-blur-md transition-colors duration-200">
    <!-- Left Section: Traffic Lights Spacer + Brand -->
    <div class="flex items-center space-x-2 sm:space-x-3 shrink-0">
      <!-- macOS Traffic Light Reserved Spacer -->
      <div v-if="isMacElectron" class="w-[72px] shrink-0 h-6"></div>

      <!-- Brand Identity -->
      <div class="flex items-center space-x-2 sm:space-x-2.5 shrink-0">
        <img :src="brandMark" alt="PromptLens" class="w-6 h-6 shrink-0" />
        <div class="flex items-center space-x-2 leading-none">
          <span class="text-sm font-bold tracking-tight text-slate-900 dark:text-white font-sans">PromptLens</span>
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] bg-emerald-50 dark:bg-slate-800/80 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-slate-700/60 font-mono font-medium">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            :{{ listenPort || 8899 }}
          </span>
        </div>
      </div>
    </div>

    <!-- Center Section: Search Input -->
    <div class="flex-1 min-w-0 max-w-lg mx-3 sm:mx-6 flex items-center space-x-2 app-no-drag">
      <div class="relative w-full min-w-0">
        <i class="fa-solid fa-magnifying-glass absolute left-3 top-2.5 text-slate-400 dark:text-slate-500 text-xs"></i>
        <input
          :value="searchQuery"
          @input="onInput"
          type="text"
          :placeholder="t('header.searchPlaceholder')"
          class="w-full bg-slate-100/90 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-lg pl-8 pr-7 py-1 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition-all truncate"
        />
        <button
          v-if="searchQuery"
          @click="clearSearch"
          class="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 text-xs cursor-pointer"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>

    <!-- Right Section: Action Buttons -->
    <div class="flex items-center space-x-1.5 sm:space-x-2 shrink-0 app-no-drag">
      <!-- Language Switcher Dropdown -->
      <LocaleDropdown />

      <!-- Theme Switcher Dropdown -->
      <ThemeDropdown />

      <!-- Refresh Button -->
      <button
        @click="$emit('refresh')"
        class="w-7 h-7 flex items-center justify-center bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/80 dark:hover:bg-slate-700 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white rounded-lg border border-slate-200 dark:border-slate-700/60 transition text-xs cursor-pointer"
        :class="isRefreshing ? 'text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800/50' : ''"
        :title="t('header.refreshTooltip')"
        :aria-label="t('header.refreshTooltip')"
      >
        <i class="fa-solid fa-arrows-rotate inline-block" :class="{ 'animate-spin': isRefreshing }"></i>
      </button>

      <!-- Settings Button -->
      <button
        @click="$emit('open-settings')"
        class="w-7 h-7 flex items-center justify-center bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 dark:bg-slate-800/80 dark:hover:bg-indigo-600/30 text-slate-600 dark:text-slate-300 dark:hover:text-indigo-300 rounded-lg border border-slate-200 dark:border-slate-700/60 dark:hover:border-indigo-500/40 transition text-xs cursor-pointer"
        :title="t('header.settingsTooltip')"
        :aria-label="t('header.settingsTooltip')"
      >
        <i class="fa-solid fa-gear"></i>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import brandMark from '../../assets/promptlens-mark.svg';
import ThemeDropdown from '../common/ThemeDropdown.vue';
import LocaleDropdown from '../common/LocaleDropdown.vue';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  isMacElectron: boolean;
  listenPort: number;
  searchQuery: string;
  isRefreshing: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:searchQuery', val: string): void;
  (e: 'search'): void;
  (e: 'refresh'): void;
  (e: 'open-settings'): void;
}>();

const { t } = useI18n();

const onInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  emit('update:searchQuery', target.value);
  emit('search');
};

const clearSearch = () => {
  emit('update:searchQuery', '');
  emit('search');
};
</script>
