<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs dark:bg-black/75">
      <section
        ref="panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="agent-restart-title"
        aria-describedby="agent-restart-description"
        :aria-busy="busy"
        class="w-full max-w-sm rounded-[14px] border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
      >
        <h2 id="agent-restart-title" class="text-sm font-semibold text-slate-900 dark:text-white">
          {{ t('restartDialog.runningTitle', { app: appLabel }) }}
        </h2>
        <p id="agent-restart-description" class="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {{ t('restartDialog.desc') }}
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <button
            ref="cancelButton"
            type="button"
            :disabled="busy"
            @click="$emit('respond', false)"
            class="cursor-pointer rounded-[10px] border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 transition duration-150 hover:bg-slate-100 disabled:cursor-wait disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            ref="confirmButton"
            type="button"
            :disabled="busy"
            @click="$emit('respond', true)"
            class="cursor-pointer rounded-[10px] bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white transition duration-150 hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60"
          >
            <span aria-live="polite">{{ busy ? t('restartDialog.restarting') : t('restartDialog.restart') }}</span>
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { AgentRestartRequest } from '../../../shared/agentRestart';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{ request: AgentRestartRequest; busy: boolean }>();
const emit = defineEmits<{ (e: 'respond', confirmed: boolean): void }>();
const { t } = useI18n();

const panel = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
const appLabel = computed(() => props.request.appName.replace(/\.app$/i, '') || props.request.appName);
let previousFocus: HTMLElement | null = null;

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!props.busy) emit('respond', false);
  } else if (event.key === 'Tab') {
    const outside = !panel.value?.contains(document.activeElement);
    if (props.busy || outside || (event.shiftKey && document.activeElement === cancelButton.value) || (!event.shiftKey && document.activeElement === confirmButton.value)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!props.busy) (event.shiftKey ? confirmButton.value : cancelButton.value)?.focus();
    }
  }
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  cancelButton.value?.focus();
  document.addEventListener('keydown', handleKeydown, true);
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true);
  void nextTick(() => {
    const target = previousFocus?.isConnected && previousFocus !== document.body && !previousFocus.hasAttribute('disabled')
      ? previousFocus : document.querySelector<HTMLButtonElement>('[data-agent-launch]');
    target?.focus();
  });
});
</script>
