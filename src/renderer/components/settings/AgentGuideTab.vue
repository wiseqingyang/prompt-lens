<template>
  <div class="space-y-4 max-w-2xl">
    <!-- Agent Tabs Navigation -->
    <div class="border-b border-slate-200 dark:border-slate-800 overflow-x-auto no-scrollbar">
      <nav class="flex space-x-6 min-w-max -mb-px px-1" aria-label="Agent Tabs">
        <button
          v-for="tab in AgentList"
          :key="tab.key"
          type="button"
          @click="selectedTab = tab.key"
          class="pb-2.5 pt-1 text-xs whitespace-nowrap shrink-0 border-b-2 transition duration-150 cursor-pointer"
          :class="selectedTab === tab.key
            ? 'border-indigo-600 dark:border-indigo-400 text-indigo-600 dark:text-indigo-400 font-semibold'
            : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 font-medium'"
        >
          {{ getAgentTabName(tab) }}
        </button>
      </nav>
    </div>

    <!-- App Action Bar for Launchable Agents -->
    <div
      v-if="currentAgentApp"
      class="p-4 bg-slate-50 dark:bg-slate-950 rounded-[14px] border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4"
    >
      <div class="min-w-0 space-y-1">
        <div class="flex items-center space-x-2 flex-wrap gap-y-1">
          <span class="font-semibold text-slate-900 dark:text-white text-xs">{{ getAgentAppName(currentAgentApp) }}</span>
          <span v-if="!isElectron" class="px-2 py-0.5 rounded-[10px] text-[10px] font-medium bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800">
            {{ t('settings.agentGuide.webMode') }}
          </span>
          <template v-else-if="currentAgentStatus">
            <span v-if="currentAgentStatus.installed" class="px-2 py-0.5 rounded-[10px] text-[10px] font-medium bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
              {{ t('settings.agentGuide.installed') }}
            </span>
            <span v-else class="px-2 py-0.5 rounded-[10px] text-[10px] font-medium bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800">
              {{ t('settings.agentGuide.notInstalled') }}
            </span>
          </template>
        </div>
        <p v-if="isDesktopApp" class="text-[11px] text-slate-500 dark:text-slate-400">
          {{ t('settings.agentGuide.runningNotice') }}
        </p>
      </div>

      <button
        v-if="isMacElectron && currentAgentStatus?.installed"
        type="button"
        data-agent-launch
        @click="$emit('launch-agent', currentAgentApp.key)"
        :disabled="isLaunchingAgent"
        class="px-3.5 py-1.5 rounded-[10px] bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition duration-150 shadow-xs shrink-0 disabled:opacity-60 cursor-pointer"
      >
        {{ isLaunchingAgent ? t('settings.agentGuide.launching') : t('settings.agentGuide.launch') }}
      </button>
    </div>

    <!-- Command Snippet Box -->
    <div class="p-4 bg-slate-50 dark:bg-slate-950 rounded-[14px] border border-slate-200 dark:border-slate-800 space-y-2.5">
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold text-slate-900 dark:text-white">{{ t('settings.agentGuide.terminalCmd') }}</span>
        <button
          type="button"
          @click="$emit('copy-command', commands[selectedTab])"
          class="px-3 py-1 rounded-[10px] bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-200 dark:border-slate-800 text-xs font-medium transition duration-150 cursor-pointer"
        >
          {{ t('common.copy') }}
        </button>
      </div>
      <pre class="p-3.5 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-200 rounded-[10px] font-mono text-[11px] leading-relaxed overflow-x-auto select-all border border-slate-200 dark:border-slate-800 whitespace-pre">{{ commands[selectedTab] }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { AgentList, type LaunchableAgentKey } from '../../../shared/agent';
import type { AgentAppKey, AgentStatusMap } from '../../types';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  status: AgentStatusMap;
  commands: Record<AgentAppKey, string>;
  isLaunchingAgent: boolean;
  isMacElectron: boolean;
}>();

defineEmits<{
  (e: 'launch-agent', agent: LaunchableAgentKey): void;
  (e: 'copy-command', cmd: string): void;
}>();

const { t, locale } = useI18n();

const isElectron = typeof (window as any).electronAPI !== 'undefined';
const selectedTab = ref<AgentAppKey>(AgentList[0].key);

const getAgentTabName = (tab: { key: string; name: string }) => {
  if (locale.value === 'zh-CN') return tab.name;
  return t(`settings.agentGuide.${tab.key}`) || tab.name;
};

const getAgentAppName = (agent: { key: string; appName?: string; name: string }) => {
  if (locale.value === 'zh-CN') return agent.appName || agent.name;
  return t(`settings.agentGuide.${agent.key}`) || agent.appName || agent.name;
};

const currentAgentApp = computed(() => {
  const agent = AgentList.find(a => a.key === selectedTab.value);
  return agent?.launchable ? agent : null;
});

const isDesktopApp = computed(() => {
  return currentAgentApp.value ? currentAgentApp.value.key !== 'codex_cli' : false;
});

const currentAgentStatus = computed(() => {
  if (!currentAgentApp.value) return null;
  return props.status[currentAgentApp.value.key];
});
</script>
