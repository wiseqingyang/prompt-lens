<template>
  <div class="space-y-4 max-w-2xl">
    <!-- 监听端口 -->
    <div class="p-4 rounded-[14px] border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/60 space-y-2">
      <label class="block text-slate-800 dark:text-slate-200 font-semibold text-xs">
        {{ t('settings.network.listenPort') }}
      </label>
      <div class="flex items-center space-x-3">
        <div class="relative w-40">
          <span class="absolute left-3 top-2 font-mono text-slate-400 dark:text-slate-500">:</span>
          <input
            v-model.number="form.proxy.listenPort"
            type="number"
            min="1024"
            max="65535"
            class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] pl-6 pr-3 py-1.5 font-mono text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
          />
        </div>
        <span class="text-slate-500 dark:text-slate-400 text-[11px]">
          {{ t('settings.network.portDefault') }}
        </span>
      </div>
    </div>

    <!-- 上游转发模式 -->
    <div class="p-4 rounded-[14px] border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/60 space-y-3">
      <label class="block text-slate-800 dark:text-slate-200 font-semibold text-xs">
        {{ t('settings.network.upstreamProxy') }}
      </label>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <button
          v-for="mode in upstreamModes"
          :key="mode.id"
          type="button"
          @click="form.proxy.upstreamMode = mode.id"
          class="p-2.5 rounded-[10px] border cursor-pointer transition flex items-center justify-between"
          :class="form.proxy.upstreamMode === mode.id
            ? 'bg-indigo-50 dark:bg-indigo-600/20 border-indigo-500 text-slate-900 dark:text-white shadow-xs'
            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700'"
        >
          <span class="font-semibold text-xs">{{ mode.label }}</span>
          <i v-if="form.proxy.upstreamMode === mode.id" class="fa-solid fa-circle-check text-indigo-600 dark:text-indigo-400 text-xs"></i>
        </button>
      </div>

      <p class="text-slate-500 dark:text-slate-400 text-[11px]">
        {{ t('settings.network.upstreamEnvDesc') }}
      </p>

      <!-- 自定义代理地址输入框 -->
      <div v-if="form.proxy.upstreamMode === 'custom'" class="pt-1 space-y-2">
        <div class="flex items-center space-x-2">
          <input
            v-model="form.proxy.customUpstream"
            type="text"
            :placeholder="t('settings.network.customPlaceholder')"
            class="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] px-3 py-1.5 font-mono text-slate-900 dark:text-white text-xs focus:outline-none focus:border-indigo-500"
          />
          <button
            type="button"
            @click="$emit('test-upstream')"
            :disabled="isTestingUpstream"
            class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-[10px] font-medium transition flex items-center space-x-1.5 shrink-0 cursor-pointer text-xs disabled:opacity-50"
          >
            <i class="fa-solid fa-bolt text-xs" :class="isTestingUpstream ? 'animate-spin' : ''"></i>
            <span>{{ isTestingUpstream ? t('settings.network.testing') : t('settings.network.testConnectivity') }}</span>
          </button>
        </div>
        <!-- 测试结果提示 -->
        <div
          v-if="upstreamTestResult"
          class="p-2.5 rounded-[10px] text-[11px] flex items-center space-x-2"
          :class="upstreamTestResult.ok
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/40'
            : 'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/40'"
        >
          <i class="fa-solid" :class="upstreamTestResult.ok ? 'fa-circle-check text-emerald-600 dark:text-emerald-400' : 'fa-circle-xmark text-red-600 dark:text-red-400'"></i>
          <span>{{ upstreamTestResult.message }}</span>
        </div>
      </div>
    </div>

    <!-- 自定义拦截域名白名单 -->
    <div class="p-4 rounded-[14px] border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/60 space-y-3">
      <div class="flex items-center justify-between">
        <label class="block text-slate-800 dark:text-slate-200 font-semibold text-xs">
          {{ t('settings.network.allowlist') }}
        </label>
        <button
          type="button"
          @click="showBuiltinDomains = !showBuiltinDomains"
          class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 text-[11px] underline cursor-pointer font-medium"
        >
          {{ showBuiltinDomains ? t('settings.network.hideBuiltin') : t('settings.network.viewBuiltin') }}
        </button>
      </div>

      <!-- 内置域名折叠卡片 -->
      <div v-if="showBuiltinDomains" class="p-3 bg-white dark:bg-slate-900 rounded-[10px] border border-slate-200 dark:border-slate-800">
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="d in builtinDomains"
            :key="d"
            class="px-2 py-0.5 rounded-[6px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[10px] font-mono text-slate-700 dark:text-slate-300"
          >
            {{ d }}
          </span>
        </div>
      </div>

      <!-- 自定义域名添加器 -->
      <div class="space-y-2.5">
        <div class="flex items-center space-x-2">
          <input
            v-model="newDomainInput"
            @keyup.enter="handleAddDomain"
            type="text"
            :placeholder="t('settings.network.domainPlaceholder')"
            class="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] px-3 py-1.5 font-mono text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
          />
          <button
            type="button"
            @click="handleAddDomain"
            class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-[10px] font-medium transition shrink-0 cursor-pointer text-xs"
          >
            {{ t('settings.network.add') }}
          </button>
        </div>

        <!-- 已添加标签列表 -->
        <div class="flex flex-wrap gap-2 min-h-[38px] p-2.5 bg-white dark:bg-slate-900 rounded-[10px] border border-slate-200 dark:border-slate-800 items-center">
          <div v-if="form.proxy.customDomains.length === 0" class="text-slate-400 dark:text-slate-500 text-[11px] px-1">
            {{ t('settings.network.noCustomDomains') }}
          </div>
          <span
            v-for="(cd, idx) in form.proxy.customDomains"
            :key="cd"
            class="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-[6px] bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/50 font-mono text-[11px]"
          >
            <span>{{ cd }}</span>
            <button type="button" @click="$emit('remove-domain', idx)" class="text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-white transition cursor-pointer">
              <i class="fa-solid fa-xmark text-[10px]"></i>
            </button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SettingsForm, UpstreamTestResult } from '../../types';
import { useI18n } from '../../composables/useI18n';

type UpstreamProxyMode = SettingsForm['proxy']['upstreamMode'];

const props = defineProps<{
  form: SettingsForm;
  isTestingUpstream: boolean;
  upstreamTestResult: UpstreamTestResult | null;
  builtinDomains: string[];
}>();

const emit = defineEmits<{
  (e: 'test-upstream'): void;
  (e: 'add-domain', domain: string): void;
  (e: 'remove-domain', index: number): void;
}>();

const { t } = useI18n();

const showBuiltinDomains = ref(false);
const newDomainInput = ref('');

const upstreamModes = computed<Array<{ id: UpstreamProxyMode; label: string }>>(() => [
  { id: 'system', label: t('settings.network.upstreamEnv') },
  { id: 'direct', label: t('settings.network.upstreamDirect') },
  { id: 'custom', label: t('settings.network.upstreamCustom') }
]);

const handleAddDomain = () => {
  const d = newDomainInput.value.trim().toLowerCase();
  if (d) {
    emit('add-domain', d);
    newDomainInput.value = '';
  }
};
</script>
