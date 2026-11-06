<template>
  <div class="space-y-4 max-w-2xl">
    <!-- SQLite 数据库文件信息 -->
    <div class="p-4 bg-slate-50/50 dark:bg-slate-950/60 rounded-[14px] border border-slate-200 dark:border-slate-800 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-slate-900 dark:text-slate-100 font-semibold text-xs">{{ t('settings.storage.localDb') }}</h3>
          <p class="text-slate-500 dark:text-slate-400 text-[11px] font-mono mt-0.5 truncate max-w-xs sm:max-w-md">{{ dbInfo.dbPath || '~/.prompt-lens/lens.db' }}</p>
        </div>
        <button
          type="button"
          @click="$emit('reveal-folder')"
          class="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 rounded-[10px] text-xs font-medium border border-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-200 dark:border-slate-800 transition flex items-center space-x-1.5 cursor-pointer shrink-0"
        >
          <i class="fa-regular fa-folder-open text-indigo-600 dark:text-indigo-400"></i>
          <span>{{ t('settings.storage.openFolder') }}</span>
        </button>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-200/80 dark:border-slate-800/80 text-xs">
        <div>
          <span class="block text-slate-400 dark:text-slate-500 text-[11px]">{{ t('settings.storage.dbSize') }}</span>
          <span class="font-mono text-slate-900 dark:text-white font-semibold mt-0.5 block">{{ dbInfo.dbSize ? (dbInfo.dbSize / (1024 * 1024)).toFixed(2) + ' MB' : '-- MB' }}</span>
        </div>
        <div>
          <span class="block text-slate-400 dark:text-slate-500 text-[11px]">{{ t('settings.storage.recordsCount') }}</span>
          <span class="font-mono text-indigo-600 dark:text-indigo-400 font-semibold mt-0.5 block">{{ dbInfo.recordsCount !== undefined && dbInfo.recordsCount > 0 ? t('settings.storage.recordsUnit', { count: formatNum(dbInfo.recordsCount) }) : '--' }}</span>
        </div>
        <div>
          <span class="block text-slate-400 dark:text-slate-500 text-[11px]">{{ t('settings.storage.savedByDedup') }}</span>
          <span class="font-mono text-slate-900 dark:text-white font-semibold mt-0.5 block">{{ mb((dbInfo.dedupSavedBytes || 0) + (dbInfo.compressionSavedBytes || 0)) }} MB</span>
        </div>
        <div>
          <span class="block text-slate-400 dark:text-slate-500 text-[11px]">{{ t('settings.storage.reclaimable') }}</span>
          <span class="font-mono text-slate-900 dark:text-white font-semibold mt-0.5 block">{{ mb(dbInfo.reclaimableBytes) }} MB</span>
        </div>
      </div>

      <div class="flex flex-wrap gap-x-6 gap-y-1 pt-2 border-t border-slate-200/80 dark:border-slate-800/80 text-[11px] text-slate-500 dark:text-slate-400">
        <span>{{ t('settings.storage.contentStart', { time: dbInfo.contentFrom || t('settings.storage.noRecords') }) }}</span>
        <span>{{ t('settings.storage.usageStart', { time: dbInfo.usageCoverageStart || t('settings.storage.loadingStart') }) }}</span>
      </div>

      <p v-if="dbInfo.maintenanceError" role="alert" class="text-red-600 dark:text-red-400 text-xs">
        {{ t('settings.storage.maintenancePrompt', { error: dbInfo.maintenanceError }) }}
      </p>
    </div>

    <!-- 数据保留周期 -->
    <div class="p-4 bg-slate-50/50 dark:bg-slate-950/60 rounded-[14px] border border-slate-200 dark:border-slate-800 space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <label class="block text-slate-900 dark:text-slate-100 font-semibold text-xs">{{ t('settings.storage.historyRetention') }}</label>
          <span class="text-[11px] text-slate-500 dark:text-slate-400">{{ t('settings.storage.historyRetentionDesc') }}</span>
        </div>
        <select
          v-model.number="form.storage.retentionDays"
          class="w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] px-3 py-1.5 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500 font-mono cursor-pointer"
        >
          <option v-if="![0, 7, 14, 30, 90, 180].includes(form.storage.retentionDays)" :value="form.storage.retentionDays">{{ t('settings.storage.keepDays', { days: form.storage.retentionDays }) }}</option>
          <option :value="0">{{ t('settings.storage.keepForever') }}</option>
          <option :value="7">{{ t('settings.storage.keepDays', { days: 7 }) }}</option>
          <option :value="14">{{ t('settings.storage.keepDays', { days: 14 }) }}</option>
          <option :value="30">{{ t('settings.storage.keepDays', { days: 30 }) }}</option>
          <option :value="90">{{ t('settings.storage.keepDays', { days: 90 }) }}</option>
          <option :value="180">{{ t('settings.storage.keepDays', { days: 180 }) }}</option>
        </select>
      </div>

      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-3 border-t border-slate-200/80 dark:border-slate-800/80">
        <div>
          <label class="block text-slate-900 dark:text-slate-100 font-semibold text-xs">{{ t('settings.storage.payloadRetention') }}</label>
          <span class="text-[11px] text-slate-500 dark:text-slate-400">{{ t('settings.storage.payloadRetentionDesc') }}</span>
        </div>
        <select
          v-model.number="form.storage.rawPayloadRetentionDays"
          class="w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] px-3 py-1.5 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500 font-mono cursor-pointer"
        >
          <option v-if="![0, 1, 3, 7, 30, 90, 180].includes(form.storage.rawPayloadRetentionDays || 0)" :value="form.storage.rawPayloadRetentionDays">{{ t('settings.storage.keepDays', { days: form.storage.rawPayloadRetentionDays || 0 }) }}</option>
          <option :value="0">{{ t('settings.storage.keepForeverFull') }}</option>
          <option :value="30">{{ t('settings.storage.keepDays', { days: 30 }) }}</option>
          <option :value="90">{{ t('settings.storage.keepDays', { days: 90 }) }}</option>
          <option :value="180">{{ t('settings.storage.keepDays', { days: 180 }) }}</option>
          <option :value="7">{{ t('settings.storage.keepDays', { days: 7 }) }}</option>
          <option :value="3">{{ t('settings.storage.keepDays', { days: 3 }) }}</option>
          <option :value="1">{{ t('settings.storage.keepDays', { days: 1 }) }}</option>
        </select>
      </div>
    </div>

    <!-- 目录与高级维护折叠项 -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <details class="p-3.5 bg-slate-50/50 dark:bg-slate-950/60 rounded-[14px] border border-slate-200 dark:border-slate-800 space-y-2">
        <summary class="text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">{{ t('settings.storage.antigravityDir') }}</summary>
        <label for="antigravity-data-dir" class="block text-[11px] text-slate-500 pt-1">{{ t('settings.storage.dirLocation') }}</label>
        <input
          id="antigravity-data-dir"
          v-model="form.attribution.antigravityDataDir"
          type="text"
          :placeholder="t('settings.storage.autoLocate')"
          class="w-full rounded-[10px] border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
        />
      </details>

      <details class="p-3.5 bg-slate-50/50 dark:bg-slate-950/60 rounded-[14px] border border-slate-200 dark:border-slate-800 space-y-2">
        <summary class="text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">{{ t('settings.storage.piDir') }}</summary>
        <label for="pi-sessions-dir" class="block text-[11px] text-slate-500 pt-1">{{ t('settings.storage.piLocation') }}</label>
        <input
          id="pi-sessions-dir"
          v-model="form.attribution.piSessionsDir"
          type="text"
          :placeholder="t('settings.storage.autoLocate')"
          class="w-full rounded-[10px] border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
        />
      </details>
    </div>

    <!-- 空间维护与数据清理 -->
    <div class="p-4 bg-slate-50/50 dark:bg-slate-950/60 rounded-[14px] border border-slate-200 dark:border-slate-800 space-y-3 text-xs">
      <div class="flex items-center justify-between gap-3">
        <div>
          <span class="font-semibold text-slate-900 dark:text-slate-100">{{ t('settings.storage.reclaimSpace') }}</span>
          <p class="text-[11px] text-slate-500 dark:text-slate-400">{{ t('settings.storage.reclaimSpaceDesc') }}</p>
        </div>
        <button
          type="button"
          @click="$emit('compact-database')"
          :disabled="isCompacting"
          class="px-3 py-1.5 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-[10px] cursor-pointer transition shrink-0 disabled:opacity-50"
        >
          {{ isCompacting ? t('settings.storage.reclaiming') : t('settings.storage.reclaimNow') }}
        </button>
      </div>

      <div class="pt-3 border-t border-slate-200/80 dark:border-slate-800/80 flex flex-wrap gap-2.5">
        <button
          type="button"
          @click="requestDeletion('clear-records')"
          class="px-3 py-1.5 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-red-300 dark:hover:border-red-900 rounded-[10px] text-red-600 dark:text-red-400 cursor-pointer transition"
        >
          {{ t('settings.storage.clearRecords') }}
        </button>
        <button
          type="button"
          @click="requestDeletion('reset-usage')"
          class="px-3 py-1.5 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-red-300 dark:hover:border-red-900 rounded-[10px] text-red-600 dark:text-red-400 cursor-pointer transition"
        >
          {{ t('settings.storage.resetUsage') }}
        </button>
        <button
          type="button"
          @click="requestDeletion('delete-all-data')"
          class="px-3 py-1.5 border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/20 hover:bg-red-100/70 dark:hover:bg-red-950/40 rounded-[10px] text-red-600 dark:text-red-400 cursor-pointer transition font-medium"
        >
          {{ t('settings.storage.deleteAllData') }}
        </button>
      </div>
    </div>

    <dialog
      ref="confirmationDialog"
      @cancel="pendingAction = null"
      class="m-auto w-[min(90vw,400px)] rounded-[14px] border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 text-slate-900 dark:text-white shadow-xl backdrop:bg-black/60"
      aria-labelledby="storage-confirm-title"
      aria-describedby="storage-confirm-description"
    >
      <h3 id="storage-confirm-title" class="font-semibold text-sm">{{ confirmationTitle }}</h3>
      <p id="storage-confirm-description" class="mt-2.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{{ confirmationDescription }}</p>
      <div class="mt-5 flex justify-end gap-2.5">
        <button autofocus type="button" @click="cancelDeletion" class="px-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-[10px] text-xs cursor-pointer">{{ t('common.cancel') }}</button>
        <button type="button" @click="confirmDeletion" class="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-[10px] text-xs font-medium cursor-pointer">{{ t('settings.storage.confirmAction', { action: confirmationTitle }) }}</button>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import type { DbInfo, SettingsForm } from '../../types';
import { formatNum } from '../../utils/formatters';
import { useI18n } from '../../composables/useI18n';

const mb = (bytes?: number) => ((bytes || 0) / 1024 / 1024).toFixed(2);

defineProps<{
  form: SettingsForm;
  dbInfo: DbInfo;
  totalRequests?: number;
  isCompacting?: boolean;
}>();

const emit = defineEmits<{
  (e: 'reveal-folder'): void;
  (e: 'compact-database'): void;
  (e: 'clear-records'): void;
  (e: 'reset-usage'): void;
  (e: 'delete-all-data'): void;
}>();

const { t } = useI18n();

type DeletionAction = 'clear-records' | 'reset-usage' | 'delete-all-data';
const pendingAction = ref<DeletionAction | null>(null);
const confirmationDialog = ref<HTMLDialogElement | null>(null);

const confirmationTitle = computed(() =>
  pendingAction.value === 'clear-records'
    ? t('settings.storage.clearRecords')
    : pendingAction.value === 'reset-usage'
      ? t('settings.storage.resetUsage')
      : t('settings.storage.deleteAllData')
);

const confirmationDescription = computed(() =>
  pendingAction.value === 'clear-records'
    ? t('settings.storage.clearRecordsDesc')
    : pendingAction.value === 'reset-usage'
      ? t('settings.storage.resetUsageDesc')
      : t('settings.storage.deleteAllDataDesc')
);

const requestDeletion = async (action: DeletionAction) => {
  pendingAction.value = action;
  await nextTick();
  confirmationDialog.value?.showModal();
};

const cancelDeletion = () => {
  confirmationDialog.value?.close();
  pendingAction.value = null;
};

const confirmDeletion = () => {
  const action = pendingAction.value;
  cancelDeletion();
  if (action === 'clear-records') emit('clear-records');
  else if (action === 'reset-usage') emit('reset-usage');
  else if (action === 'delete-all-data') emit('delete-all-data');
};
</script>
