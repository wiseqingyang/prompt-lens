<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 dark:bg-black/75 backdrop-blur-xs p-4 sm:p-6 select-none">
    <div class="w-full max-w-5xl lg:max-w-6xl h-[740px] max-h-[92vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[18px] shadow-2xl flex flex-col overflow-hidden">
      <!-- Modal Top Header -->
      <div class="px-6 py-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
        <h2 class="text-sm font-semibold text-slate-900 dark:text-white tracking-tight">{{ t('settings.title') }}</h2>
        <button
          type="button"
          :aria-label="t('common.close')"
          @click="$emit('close')"
          class="text-slate-400 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-[10px] hover:bg-slate-100 dark:hover:bg-slate-800 transition duration-150 cursor-pointer"
        >
          <i class="fa-solid fa-xmark text-sm"></i>
        </button>
      </div>

      <!-- Modal Body (Sidebar + Content) -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Left Navigation Sidebar -->
        <div class="w-40 sm:w-44 bg-slate-50/70 dark:bg-slate-950/60 border-r border-slate-200 dark:border-slate-800 p-3 space-y-1 shrink-0 text-xs">
          <button
            v-for="item in navItems"
            :key="item.id"
            type="button"
            @click="activeTab = item.id"
            class="w-full px-3 py-2 rounded-[10px] transition duration-150 flex items-center space-x-2.5 text-left cursor-pointer"
            :class="activeTab === item.id
              ? 'bg-indigo-600 text-white font-semibold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 font-medium hover:bg-slate-200/60 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-white'"
          >
            <i :class="[item.icon, 'text-xs w-4 text-center shrink-0']"></i>
            <span class="truncate">{{ item.label }}</span>
          </button>
        </div>

        <!-- Right Content Container -->
        <div class="flex-1 overflow-y-auto p-6 text-xs select-text bg-white dark:bg-slate-900">
          <ProfileDashboard v-if="activeTab === 'stats'" :agent-options="agentOptions" />

          <AppearanceTab v-else-if="activeTab === 'appearance'" />

          <NetworkTab
            v-else-if="activeTab === 'network'"
            :form="settings.settingsForm.value"
            :is-testing-upstream="settings.isTestingUpstream.value"
            :upstream-test-result="settings.upstreamTestResult.value"
            :builtin-domains="settings.builtinLlmDomains"
            @test-upstream="settings.testUpstream"
            @add-domain="settings.addCustomDomain"
            @remove-domain="settings.removeCustomDomain"
          />

          <PrivacyTab
            v-else-if="activeTab === 'privacy'"
            :certificate="settings.certificate.value"
            @refresh-cert="settings.refreshCertificate"
            @install-cert="settings.installCert"
          />

          <StorageTab
            v-else-if="activeTab === 'storage'"
            :form="settings.settingsForm.value"
            :db-info="settings.dbInfo.value"
            :total-requests="totalRequests"
            :is-compacting="settings.isCompactingDb.value"
            @reveal-folder="settings.revealDbFolder"
            @compact-database="settings.compactDatabase"
            @clear-records="$emit('clear-records')"
            @reset-usage="settings.deleteData('resetUsage')"
            @delete-all-data="settings.deleteData('deleteAllData')"
          />

          <AgentGuideTab
            v-else-if="activeTab === 'agent'"
            :status="settings.agentStatus.value"
            :commands="settings.agentCommands.value"
            :is-launching-agent="settings.isLaunchingAgent.value"
            :is-mac-electron="settings.isMacElectron.value"
            @launch-agent="settings.launchAgentApp"
            @copy-command="(cmd) => $emit('copy', cmd)"
          />
        </div>
      </div>

      <!-- Modal Bottom Actions -->
      <div class="px-6 py-3.5 bg-slate-50/80 dark:bg-slate-950/80 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2.5 shrink-0">
        <button
          type="button"
          @click="$emit('close')"
          class="px-4 py-1.5 rounded-[10px] border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium transition duration-150 cursor-pointer"
        >
          {{ t('common.close') }}
        </button>
        <button
          v-if="activeTab !== 'stats'"
          type="button"
          @click="settings.saveSettings"
          :disabled="settings.isSavingSettings.value"
          class="px-4 py-1.5 rounded-[10px] bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition duration-150 shadow-xs disabled:opacity-60 cursor-pointer"
        >
          {{ settings.isSavingSettings.value ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>
    <AgentRestartDialog
      v-if="settings.agentRestartRequest.value"
      :request="settings.agentRestartRequest.value"
      :busy="settings.isConfirmingAgentRestart.value"
      @respond="settings.respondToAgentRestart"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentCategory } from '../../types';
import ProfileDashboard from '../dashboard/ProfileDashboard.vue';
import AppearanceTab from './AppearanceTab.vue';
import NetworkTab from './NetworkTab.vue';
import PrivacyTab from './PrivacyTab.vue';
import StorageTab from './StorageTab.vue';
import AgentGuideTab from './AgentGuideTab.vue';
import AgentRestartDialog from './AgentRestartDialog.vue';
import { useI18n } from '../../composables/useI18n';

type SettingsTabId = 'stats' | 'appearance' | 'network' | 'privacy' | 'storage' | 'agent';

const { t } = useI18n();

const navItems = computed<Array<{ id: SettingsTabId; label: string; icon: string }>>(() => [
  { id: 'stats', label: t('settings.tabStats'), icon: 'fa-solid fa-chart-line' },
  { id: 'appearance', label: t('settings.tabAppearance'), icon: 'fa-solid fa-palette' },
  { id: 'network', label: t('settings.tabNetwork'), icon: 'fa-solid fa-network-wired' },
  { id: 'privacy', label: t('settings.tabPrivacy'), icon: 'fa-solid fa-shield-halved' },
  { id: 'storage', label: t('settings.tabStorage'), icon: 'fa-solid fa-database' },
  { id: 'agent', label: t('settings.tabAgent'), icon: 'fa-solid fa-terminal' }
]);

const props = withDefaults(defineProps<{
  isOpen: boolean;
  settings: any;
  totalRequests?: number;
  agentOptions?: Array<{ id: AgentCategory; label: string }>;
}>(), {
  agentOptions: () => [
    { id: 'Codex', label: 'Codex' },
    { id: 'Other', label: '其他' }
  ]
});

defineEmits<{
  (e: 'close'): void;
  (e: 'copy', text: string): void;
  (e: 'clear-records'): void;
}>();

const activeTab = computed({
  get: () => props.settings.settingsTab.value as SettingsTabId,
  set: (val: SettingsTabId) => {
    if (props.settings.selectSettingsTab) {
      void props.settings.selectSettingsTab(val);
    } else {
      props.settings.settingsTab.value = val;
    }
  }
});
</script>
