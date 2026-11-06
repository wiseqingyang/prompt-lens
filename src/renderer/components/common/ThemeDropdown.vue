<template>
  <div class="relative" ref="dropdownRef">
    <button
      type="button"
      @click="isOpen = !isOpen"
      class="h-7 p-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/80 dark:hover:bg-slate-700 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white rounded-lg border border-slate-200 dark:border-slate-700/60 transition text-xs cursor-pointer flex items-center space-x-1"
      :title="`${t('header.themeTooltip')}: ${getThemeLabel(themeMode)}`"
      :aria-label="t('header.themeTooltip')"
    >
      <i :class="getCurrentThemeIcon()" class="w-3.5 text-center"></i>
      <i class="fa-solid fa-chevron-down text-[9px] opacity-60"></i>
    </button>

    <!-- Theme Popover Menu -->
    <div
      v-if="isOpen"
      class="absolute right-0 top-full mt-1.5 w-40 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl dark:shadow-2xl py-1 z-50 text-xs select-none ring-1 ring-black/5 dark:ring-white/10 overflow-hidden"
    >
      <div class="px-2.5 py-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500 tracking-wider uppercase border-b border-slate-100 dark:border-slate-800/60 mb-0.5">
        {{ t('header.themeTooltip') }}
      </div>
      <button
        type="button"
        @click="selectMode('light')"
        class="w-full px-3 py-1.5 flex items-center justify-between text-left transition cursor-pointer"
        :class="themeMode === 'light' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'"
      >
        <div class="flex items-center space-x-2">
          <i class="fa-solid fa-sun text-amber-500 w-4 text-center"></i>
          <span>{{ t('settings.themeLight') }}</span>
        </div>
        <i v-if="themeMode === 'light'" class="fa-solid fa-check text-[10px]"></i>
      </button>
      <button
        type="button"
        @click="selectMode('dark')"
        class="w-full px-3 py-1.5 flex items-center justify-between text-left transition cursor-pointer"
        :class="themeMode === 'dark' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'"
      >
        <div class="flex items-center space-x-2">
          <i class="fa-solid fa-moon text-indigo-400 w-4 text-center"></i>
          <span>{{ t('settings.themeDark') }}</span>
        </div>
        <i v-if="themeMode === 'dark'" class="fa-solid fa-check text-[10px]"></i>
      </button>
      <button
        type="button"
        @click="selectMode('system')"
        class="w-full px-3 py-1.5 flex items-center justify-between text-left transition cursor-pointer"
        :class="themeMode === 'system' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'"
      >
        <div class="flex items-center space-x-2">
          <i class="fa-solid fa-desktop text-slate-400 w-4 text-center"></i>
          <span>{{ t('settings.themeSystem') }}</span>
        </div>
        <i v-if="themeMode === 'system'" class="fa-solid fa-check text-[10px]"></i>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useTheme, type ThemeMode } from '../../composables/useTheme';
import { useI18n } from '../../composables/useI18n';

const { themeMode, resolvedTheme, setTheme } = useTheme();
const { t } = useI18n();

const isOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

const getCurrentThemeIcon = () => {
  if (themeMode.value === 'light') return 'fa-solid fa-sun text-amber-500';
  if (themeMode.value === 'dark') return 'fa-solid fa-moon text-indigo-400';
  return 'fa-solid fa-desktop text-slate-500 dark:text-slate-400';
};

const getThemeLabel = (mode: ThemeMode) => {
  if (mode === 'light') return t('settings.themeLight');
  if (mode === 'dark') return t('settings.themeDark');
  return `${t('settings.themeSystem')} (${resolvedTheme.value === 'dark' ? t('settings.themeDark') : t('settings.themeLight')})`;
};

const selectMode = (mode: ThemeMode) => {
  setTheme(mode);
  isOpen.value = false;
};

const handleClickOutside = (e: MouseEvent) => {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isOpen.value = false;
  }
};

onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('click', handleClickOutside);
  }
});

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('click', handleClickOutside);
  }
});
</script>
