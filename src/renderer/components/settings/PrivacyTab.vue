<template>
  <div class="space-y-4 max-w-2xl">
    <div class="p-4 rounded-[14px] border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/60 space-y-2">
      <h3 class="font-semibold text-slate-900 dark:text-slate-100">{{ t('settings.privacy.redactionTitle') }}</h3>
      <p class="text-slate-500 dark:text-slate-400 leading-relaxed">
        {{ t('settings.privacy.redactionDesc1') }}
      </p>
      <p class="text-slate-500 dark:text-slate-400 leading-relaxed">
        {{ t('settings.privacy.redactionDesc2') }}
      </p>
    </div>

    <div class="p-4 rounded-[14px] border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/60 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="font-semibold text-slate-900 dark:text-slate-100">{{ t('settings.privacy.certTitle') }}</h3>
        <span
          class="font-semibold text-[11px] px-2 py-0.5 rounded-[6px] border"
          :class="certificate.state === 'trusted'
            ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/50'
            : 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/50'"
        >
          {{ getCertStateLabel(certificate.state) }}
        </span>
      </div>
      <p class="text-slate-500 dark:text-slate-400 leading-relaxed">{{ certificate.message }}</p>
      <p v-if="certificate.fingerprint" class="font-mono break-all text-[11px] text-slate-600 dark:text-slate-400">SHA-256: {{ certificate.fingerprint }}</p>
      <p v-if="certificate.path" class="font-mono break-all text-[11px] text-slate-500 dark:text-slate-500">{{ certificate.path }}</p>
      <div class="flex gap-2.5 pt-1">
        <button
          type="button"
          class="px-3 py-1.5 rounded-[10px] border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer transition text-xs"
          @click="$emit('refresh-cert')"
        >
          {{ t('settings.privacy.recheck') }}
        </button>
        <button
          type="button"
          class="px-3 py-1.5 rounded-[10px] bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer disabled:opacity-50 transition font-medium text-xs"
          :disabled="['missing', 'invalid', 'expired'].includes(certificate.state)"
          @click="$emit('install-cert')"
        >
          {{ t('settings.privacy.installCert') }}
        </button>
      </div>
      <p class="text-slate-400 dark:text-slate-500 leading-relaxed text-[11px]">
        {{ t('settings.privacy.certNotice') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';

defineProps<{ certificate: { state: string; message: string; fingerprint?: string; path?: string } }>();
defineEmits<{ (e: 'install-cert'): void; (e: 'refresh-cert'): void }>();

const { t } = useI18n();

const getCertStateLabel = (state: string): string => {
  const key = `settings.privacy.certStates.${state}`;
  return t(key) || t('settings.privacy.certStates.unknown');
};
</script>
