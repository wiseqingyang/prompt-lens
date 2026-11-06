<template>
  <div class="space-y-2">
    <p class="text-[11px] text-slate-500">{{ t('timeline.wsNotice') }}</p>
    <div v-for="message in messages" :key="message.sequence" class="space-y-1">
      <span class="text-[10px] font-mono text-slate-500">#{{ message.sequence }} · {{ message.direction === 'client' ? t('timeline.clientToServer') : t('timeline.serverToClient') }}</span>
      <pre class="p-3 text-[11px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg overflow-auto max-h-96 whitespace-pre-wrap break-all">{{ message.payload }}</pre>
    </div>
    <p v-if="error" class="text-rose-500">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { socketMessages } from '../../../shared/communication';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{ body: string }>();
const { t } = useI18n();

const parsed = computed(() => {
  try {
    return { messages: socketMessages(props.body), error: '' };
  } catch {
    return { messages: [], error: '消息原文格式损坏' };
  }
});
const messages = computed(() => parsed.value.messages);
const error = computed(() => parsed.value.error);
</script>
