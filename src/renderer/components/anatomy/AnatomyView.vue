<template>
  <div class="space-y-4 max-w-5xl mx-auto">
    <!-- Layer 1 Overview: Context Composition Bar & Legend -->
    <div class="bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800/80 rounded-xl p-4 space-y-3 shadow-xs dark:shadow-none">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="flex items-center space-x-2 flex-wrap gap-y-1">
          <span class="text-xs font-bold text-slate-800 dark:text-slate-200">{{ t('anatomy.structureTitle') }}</span>
          <button
            v-if="record?.id"
            @click="$emit('copy', String(record.id))"
            class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white border border-slate-200 dark:border-slate-700 transition cursor-pointer flex items-center space-x-1"
            :title="`Record ID: #${record.id}`"
          >
            <span>#{{ record.id }}</span>
            <i class="fa-regular fa-copy text-[9px] opacity-60"></i>
          </button>
          <span class="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
            {{ t('anatomy.totalAssembled', { count: formatNum(record?.anatomy?.total_chars || 0) }) }}
          </span>
        </div>
        <div class="flex items-center space-x-3 text-xs">
          <span class="font-mono text-slate-500 dark:text-slate-400">
            {{ t('anatomy.bloatRatio', { n: formatNum(record?.anatomy?.bloat_multiplier || 1) }) }}
          </span>
          <button
            @click="toggleAllLayers"
            class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 transition text-xs cursor-pointer font-medium"
          >
            {{ areAllLayersExpanded ? t('anatomy.collapseAll') : t('anatomy.expandAll') }}
          </button>
        </div>
      </div>

      <!-- Proportional Horizontal Bar -->
      <div class="w-full bg-slate-100 dark:bg-slate-950 h-2.5 rounded-full overflow-hidden flex border border-slate-200 dark:border-slate-800">
        <div
          v-for="l in record?.anatomy?.layers || []"
          :key="l.id"
          :style="{ width: l.percentage + '%' }"
          :class="layerBarColor(l.badge_color)"
          :title="l.name + ': ' + l.percentage + '%'"
        ></div>
      </div>

      <!-- Legend Row -->
      <div class="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] font-mono">
        <div
          v-for="l in record?.anatomy?.layers || []"
          :key="l.id"
          @click="toggleLayer(l.id)"
          class="flex items-center space-x-1.5 cursor-pointer hover:opacity-80 transition"
        >
          <span class="w-2 h-2 rounded-full shrink-0" :class="layerDotColor(l.badge_color)"></span>
          <span class="text-slate-500 dark:text-slate-400">{{ l.name.split(' ')[0] }}:</span>
          <span class="text-slate-800 dark:text-slate-200 font-semibold">{{ l.percentage }}%</span>
        </div>
      </div>
    </div>

    <!-- The 5 Structured Architectural Layers -->
    <div class="space-y-3">
      <!-- LAYER 1: USER INTENT (用户指令) -->
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs dark:shadow-none">
        <div class="px-4 py-3 bg-emerald-50 dark:bg-emerald-950/20 border-b border-emerald-100 dark:border-emerald-900/30 flex items-center justify-between">
          <div class="flex items-center space-x-2.5">
            <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
            <span class="text-xs font-bold text-emerald-800 dark:text-emerald-300">{{ t('anatomy.userIntent') }}</span>
            <span class="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              {{ record?.anatomy?.layers[0]?.chars || 0 }} chars ({{ record?.anatomy?.layers[0]?.percentage || '0.0' }}%)
            </span>
          </div>
          <div class="flex items-center space-x-2">
            <button
              @click="$emit('copy', record?.anatomy?.user_prompt || '')"
              class="w-6 h-6 rounded flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:hover:text-white border border-slate-200 dark:border-transparent transition cursor-pointer"
              :title="t('anatomy.copyUserIntent')"
            >
              <i class="fa-regular fa-copy text-[10px]"></i>
            </button>
          </div>
        </div>
        <div class="p-4">
          <div class="bg-slate-50 dark:bg-slate-950 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80 text-xs font-mono text-slate-800 dark:text-slate-100 whitespace-pre-wrap leading-relaxed">
            {{ record?.anatomy?.user_prompt || t('anatomy.noTextPrompt') }}
          </div>
        </div>
      </div>

      <!-- LAYER 2: SYSTEM PERSONA (核心人设与指引) -->
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs dark:shadow-none">
        <div
          @click="toggleLayer('system_persona')"
          class="px-4 py-3 bg-slate-50/80 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between cursor-pointer transition"
        >
          <div class="flex items-center space-x-2.5">
            <span class="w-2 h-2 rounded-full bg-amber-500"></span>
            <div>
              <span class="text-xs font-bold text-slate-800 dark:text-slate-200">{{ t('anatomy.systemPersona') }}</span>
              <span class="text-[11px] text-slate-500 dark:text-slate-400 ml-2 font-mono">
                {{ record?.anatomy?.layers[1]?.chars || 0 }} chars ({{ record?.anatomy?.layers[1]?.percentage || 0 }}%)
              </span>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <button
              v-if="expandedLayers['system_persona']"
              @click.stop="$emit('copy', record?.anatomy?.layers[1]?.content || '')"
              class="w-6 h-6 rounded flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 rounded text-[11px] border border-slate-200 dark:border-transparent transition cursor-pointer"
              :title="t('anatomy.copyContent')"
            >
              <i class="fa-regular fa-copy text-[10px]"></i>
            </button>
            <i class="fa-solid text-slate-400 text-xs transition" :class="expandedLayers['system_persona'] ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
          </div>
        </div>
        <div v-if="expandedLayers['system_persona']" class="p-4 bg-slate-50/60 dark:bg-slate-950/50 border-t border-slate-200 dark:border-slate-800/50">
          <pre class="p-3 bg-white dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-800 dark:text-slate-300 max-h-80 overflow-y-auto whitespace-pre-wrap border border-slate-200 dark:border-slate-800/80 leading-relaxed">{{ record?.anatomy?.layers[1]?.content || t('anatomy.noPersona') }}</pre>
        </div>
      </div>

      <!-- LAYER 3: TOOL SCHEMAS (工具库与函数声明) -->
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs dark:shadow-none">
        <div
          @click="toggleLayer('tool_schemas')"
          class="px-4 py-3 bg-slate-50/80 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between cursor-pointer transition"
        >
          <div class="flex items-center space-x-2.5">
            <span class="w-2 h-2 rounded-full bg-cyan-500"></span>
            <div>
              <span class="text-xs font-bold text-slate-800 dark:text-slate-200">{{ t('anatomy.toolSchemas') }}</span>
              <span v-if="toolNames.length" class="ml-2 px-1.5 py-0.2 rounded text-[10px] bg-cyan-50 text-cyan-700 border border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-300 dark:border-cyan-500/20 font-mono">
                {{ t('anatomy.toolCount', { count: toolNames.length }) }}
              </span>
              <span class="text-[11px] text-slate-500 dark:text-slate-400 ml-2 font-mono">
                {{ record?.anatomy?.layers[2]?.chars || 0 }} chars ({{ record?.anatomy?.layers[2]?.percentage || 0 }}%)
              </span>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <button
              v-if="expandedLayers['tool_schemas']"
              @click.stop="$emit('copy', record?.anatomy?.layers[2]?.content || '')"
              class="w-6 h-6 rounded flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 rounded text-[11px] border border-slate-200 dark:border-transparent transition cursor-pointer"
              :title="t('anatomy.copySchema')"
            >
              <i class="fa-regular fa-copy text-[10px]"></i>
            </button>
            <i class="fa-solid text-slate-400 text-xs transition" :class="expandedLayers['tool_schemas'] ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
          </div>
        </div>

        <!-- Quick Tool Names Chips -->
        <div v-if="toolNames.length > 0" class="px-4 py-2 bg-slate-50/70 dark:bg-slate-950/40 border-b border-slate-200 dark:border-slate-800/40 flex flex-wrap gap-1.5 items-center">
          <span class="text-[10px] text-slate-400 dark:text-slate-500 font-mono">{{ t('anatomy.injectedTools') }}</span>
          <span
            v-for="name in toolNames"
            :key="name"
            class="px-2 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[10px] font-mono text-cyan-700 dark:text-cyan-300"
          >
            {{ name }}
          </span>
        </div>

        <div v-if="expandedLayers['tool_schemas']" class="p-4 bg-slate-50/60 dark:bg-slate-950/50 border-t border-slate-200 dark:border-slate-800/50">
          <pre class="p-3 bg-white dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-800 dark:text-slate-300 max-h-80 overflow-y-auto whitespace-pre-wrap border border-slate-200 dark:border-slate-800/80 leading-relaxed">{{ prettyJson(record?.anatomy?.layers[2]?.content) }}</pre>
        </div>
      </div>

      <!-- LAYER 4: WORKSPACE CONTEXT (工作空间与环境规则) -->
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs dark:shadow-none">
        <div
          @click="toggleLayer('workspace_context')"
          class="px-4 py-3 bg-slate-50/80 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between cursor-pointer transition"
        >
          <div class="flex items-center space-x-2.5">
            <span class="w-2 h-2 rounded-full bg-blue-500"></span>
            <div>
              <span class="text-xs font-bold text-slate-800 dark:text-slate-200">{{ t('anatomy.workspaceContext') }}</span>
              <span class="text-[11px] text-slate-500 dark:text-slate-400 ml-2 font-mono">
                {{ record?.anatomy?.layers[3]?.chars || 0 }} chars ({{ record?.anatomy?.layers[3]?.percentage || 0 }}%)
              </span>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <button
              v-if="expandedLayers['workspace_context']"
              @click.stop="$emit('copy', record?.anatomy?.layers[3]?.content || '')"
              class="w-6 h-6 rounded flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 rounded text-[11px] border border-slate-200 dark:border-transparent transition cursor-pointer"
              :title="t('anatomy.copyContent')"
            >
              <i class="fa-regular fa-copy text-[10px]"></i>
            </button>
            <i class="fa-solid text-slate-400 text-xs transition" :class="expandedLayers['workspace_context'] ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
          </div>
        </div>
        <div v-if="expandedLayers['workspace_context']" class="p-4 bg-slate-50/60 dark:bg-slate-950/50 border-t border-slate-200 dark:border-slate-800/50">
          <pre class="p-3 bg-white dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-800 dark:text-slate-300 max-h-80 overflow-y-auto whitespace-pre-wrap border border-slate-200 dark:border-slate-800/80 leading-relaxed">{{ record?.anatomy?.layers[3]?.content || t('anatomy.noWorkspaceContext') }}</pre>
        </div>
      </div>

      <!-- LAYER 5: HISTORY & INJECTIONS (多轮历史与注入代码) -->
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs dark:shadow-none">
        <div
          @click="toggleLayer('history_artifacts')"
          class="px-4 py-3 bg-slate-50/80 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800/80 flex items-center justify-between cursor-pointer transition"
        >
          <div class="flex items-center space-x-2.5">
            <span class="w-2 h-2 rounded-full bg-purple-500"></span>
            <div>
              <span class="text-xs font-bold text-slate-800 dark:text-slate-200">{{ t('anatomy.historyInjections') }}</span>
              <span class="text-[11px] text-slate-500 dark:text-slate-400 ml-2 font-mono">
                {{ record?.anatomy?.layers[4]?.chars || 0 }} chars ({{ record?.anatomy?.layers[4]?.percentage || 0 }}%)
              </span>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <i class="fa-solid text-slate-400 text-xs transition" :class="expandedLayers['history_artifacts'] ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
          </div>
        </div>
        <div v-if="expandedLayers['history_artifacts']" class="p-4 bg-slate-50/60 dark:bg-slate-950/50 border-t border-slate-200 dark:border-slate-800/50 space-y-2">
          <p class="text-xs text-slate-500 dark:text-slate-400">
            {{ t('anatomy.historyInjectionsDesc') }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { RecordDetail } from '../../types';
import { formatNum, layerBarColor, layerDotColor, prettyJson } from '../../utils/formatters';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  record: RecordDetail | null;
}>();

defineEmits<{
  (e: 'copy', text: string): void;
}>();

const { t } = useI18n();

const expandedLayers = ref<Record<string, boolean>>({
  user_query: true,
  system_persona: false,
  tool_schemas: false,
  workspace_context: false,
  history_artifacts: false
});

const areAllLayersExpanded = computed(() => {
  return ['system_persona', 'tool_schemas', 'workspace_context', 'history_artifacts'].every(
    (k) => expandedLayers.value[k]
  );
});

const toggleAllLayers = () => {
  const target = !areAllLayersExpanded.value;
  expandedLayers.value.system_persona = target;
  expandedLayers.value.tool_schemas = target;
  expandedLayers.value.workspace_context = target;
  expandedLayers.value.history_artifacts = target;
};

const toggleLayer = (layerId: string) => {
  expandedLayers.value[layerId] = !expandedLayers.value[layerId];
};

const toolNames = computed(() => {
  if (!props.record || !props.record.request_body) return [];
  try {
    const data = JSON.parse(props.record.request_body);
    const reqObj = data.request || data;
    const tools = reqObj.tools || data.tools || [];
    const names = tools.flatMap((toolItem: any) => {
      if (toolItem.functionDeclarations) return toolItem.functionDeclarations.map((f: any) => f.name);
      if (toolItem.function) return [toolItem.function.name];
      if (toolItem.name) return [toolItem.name];
      return [];
    });
    return names.filter(Boolean);
  } catch {
    return [];
  }
});
</script>
