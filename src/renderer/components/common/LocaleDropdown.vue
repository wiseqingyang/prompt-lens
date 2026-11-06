<template>
  <div class="relative" ref="dropdownRef">
    <button
      type="button"
      @click="isOpen = !isOpen"
      class="h-7 px-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/80 dark:hover:bg-slate-700 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white rounded-lg border border-slate-200 dark:border-slate-700/60 transition text-xs cursor-pointer flex items-center space-x-1.5 select-none"
      :title="`${t('header.languageTooltip')}: ${currentLabel} (Click to switch)`"
      :aria-label="t('header.languageTooltip')"
    >
      <i class="fa-solid fa-language text-xs opacity-75"></i>
      <span class="font-mono text-[11px] font-semibold">{{ currentBadge }}</span>
      <i class="fa-solid fa-chevron-down text-[9px] opacity-60"></i>
    </button>

    <!-- Language Popover Menu -->
    <div
      v-if="isOpen"
      class="absolute right-0 top-full mt-1.5 w-44 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl dark:shadow-2xl py-1 z-50 text-xs select-none ring-1 ring-black/5 dark:ring-white/10 overflow-hidden"
    >
      <div class="px-2.5 py-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500 tracking-wider uppercase border-b border-slate-100 dark:border-slate-800/60 mb-0.5">
        {{ t('header.languageTooltip') }}
      </div>
      <button
        type="button"
        @click="selectLocale('zh-CN')"
        class="w-full px-3 py-1.5 flex items-center justify-between text-left transition cursor-pointer"
        :class="localeMode === 'zh-CN' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'"
      >
        <span>简体中文</span>
        <i v-if="localeMode === 'zh-CN'" class="fa-solid fa-check text-[10px]"></i>
      </button>
      <button
        type="button"
        @click="selectLocale('en-US')"
        class="w-full px-3 py-1.5 flex items-center justify-between text-left transition cursor-pointer"
        :class="localeMode === 'en-US' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'"
      >
        <span>English</span>
        <i v-if="localeMode === 'en-US'" class="fa-solid fa-check text-[10px]"></i>
      </button>
      <button
        type="button"
        @click="selectLocale('auto')"
        class="w-full px-3 py-1.5 flex items-center justify-between text-left transition cursor-pointer border-t border-slate-100 dark:border-slate-800/60 mt-0.5"
        :class="localeMode === 'auto' ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'"
      >
        <span>{{ t('settings.langAuto') }}</span>
        <i v-if="localeMode === 'auto'" class="fa-solid fa-check text-[10px]"></i>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type { LocaleMode } from '../../locales';

const { locale, localeMode, setLocale, t } = useI18n();

const isOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

const currentBadge = computed(() => {
  return locale.value === 'zh-CN' ? '中' : 'EN';
});

const currentLabel = computed(() => {
  if (localeMode.value === 'zh-CN') return '简体中文';
  if (localeMode.value === 'en-US') return 'English';
  return `${t('settings.langAuto')} (${locale.value === 'zh-CN' ? '中' : 'EN'})`;
});

const selectLocale = (mode: LocaleMode) => {
  setLocale(mode);
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
