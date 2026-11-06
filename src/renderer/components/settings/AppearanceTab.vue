<template>
  <div class="space-y-6 max-w-xl">
    <!-- Language Settings -->
    <div class="space-y-2.5">
      <div>
        <label class="block text-slate-900 dark:text-slate-100 font-semibold text-xs">
          {{ t('settings.language') }}
        </label>
        <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
          {{ t('settings.languageDesc') }}
        </p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          v-for="item in languageOptions"
          :key="item.id"
          type="button"
          @click="setLocale(item.id)"
          class="p-4 rounded-[14px] border transition cursor-pointer flex flex-col items-center justify-center space-y-2.5 relative"
          :class="localeMode === item.id
            ? 'bg-indigo-50/70 dark:bg-indigo-950/30 border-indigo-600 dark:border-indigo-500 text-slate-900 dark:text-white shadow-xs'
            : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700'"
        >
          <div
            class="w-9 h-9 rounded-[10px] border flex items-center justify-center text-sm transition"
            :class="localeMode === item.id
              ? 'bg-indigo-50 dark:bg-indigo-950/50 border-indigo-200 dark:border-indigo-800/60 text-indigo-600 dark:text-indigo-400 font-bold'
              : 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'"
          >
            <span class="font-mono text-xs font-bold">{{ item.badge }}</span>
          </div>
          <span class="font-semibold text-xs text-center">{{ item.label }}</span>
          <i
            v-if="localeMode === item.id"
            class="fa-solid fa-circle-check text-indigo-600 dark:text-indigo-400 text-xs absolute top-2.5 right-2.5"
          ></i>
        </button>
      </div>
    </div>

    <!-- Theme Settings -->
    <div class="space-y-2.5 pt-4 border-t border-slate-100 dark:border-slate-800/80">
      <div>
        <label class="block text-slate-900 dark:text-slate-100 font-semibold text-xs">
          {{ t('settings.theme') }}
        </label>
        <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
          {{ t('settings.themeDesc') }}
        </p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          v-for="item in themeOptions"
          :key="item.id"
          type="button"
          @click="setTheme(item.id)"
          class="p-4 rounded-[14px] border transition cursor-pointer flex flex-col items-center justify-center space-y-2.5 relative"
          :class="themeMode === item.id
            ? 'bg-indigo-50/70 dark:bg-indigo-950/30 border-indigo-600 dark:border-indigo-500 text-slate-900 dark:text-white shadow-xs'
            : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700'"
        >
          <div
            class="w-9 h-9 rounded-[10px] border flex items-center justify-center text-sm transition"
            :class="themeMode === item.id
              ? 'bg-indigo-50 dark:bg-indigo-950/50 border-indigo-200 dark:border-indigo-800/60 text-indigo-600 dark:text-indigo-400'
              : 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'"
          >
            <i :class="item.icon"></i>
          </div>
          <span class="font-semibold text-xs text-center">{{ item.label }}</span>
          <i
            v-if="themeMode === item.id"
            class="fa-solid fa-circle-check text-indigo-600 dark:text-indigo-400 text-xs absolute top-2.5 right-2.5"
          ></i>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme, type ThemeMode } from '../../composables/useTheme';
import { useI18n } from '../../composables/useI18n';
import type { LocaleMode } from '../../locales';

const { themeMode, setTheme } = useTheme();
const { localeMode, setLocale, t } = useI18n();

const languageOptions = computed<Array<{ id: LocaleMode; label: string; badge: string }>>(() => [
  { id: 'zh-CN', label: '简体中文', badge: '中' },
  { id: 'en-US', label: 'English', badge: 'EN' },
  { id: 'auto', label: t('settings.langAuto'), badge: 'AUTO' }
]);

const themeOptions = computed<Array<{ id: ThemeMode; label: string; icon: string }>>(() => [
  { id: 'light', label: t('settings.themeLight'), icon: 'fa-solid fa-sun' },
  { id: 'dark', label: t('settings.themeDark'), icon: 'fa-solid fa-moon' },
  { id: 'system', label: t('settings.themeSystem'), icon: 'fa-solid fa-desktop' }
]);
</script>
