<template>
  <div class="space-y-6 max-w-4xl mx-auto">
    <!-- Loading indicator when fetching turn records -->
    <div v-if="isLoading" class="p-6 text-center text-slate-500 dark:text-slate-400 text-xs flex items-center justify-center space-x-2">
      <i class="fa-solid fa-arrows-rotate animate-spin text-indigo-500 dark:text-indigo-400"></i>
      <span>{{ t('timeline.loading') }}</span>
    </div>

    <!-- Conversation Turns Flow -->
    <div
      v-for="turnChat in visibleTurns"
      :key="turnChat.turnIndex"
      :id="`turn-anchor-${turnChat.turnIndex}`"
      class="space-y-3.5 pt-2"
      :class="turnChat.toolLink ? 'ml-3 pl-3 border-l-2 border-sky-200 dark:border-sky-800' : ''"
      :data-search-parent="turnChat.toolLink?.parentRecordId"
    >
      <!-- Turn Divider & Anchor Badge -->
      <div class="flex flex-wrap gap-y-2 items-center justify-between text-xs font-mono py-1 border-b border-slate-200/80 dark:border-slate-800/60 select-none">
        <div class="flex flex-wrap gap-2 items-center">
          <span class="px-2 py-0.5 rounded text-[11px] font-bold bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700/50">
            {{ turnChat.connectionIssue ? t('timeline.event') : t('timeline.request') }} {{ turnChat.turnIndex }}
          </span>
          <button
            v-if="turnChat.recordId"
            @click="handleCopy(String(turnChat.recordId))"
            class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white border border-slate-200 dark:border-slate-700 transition cursor-pointer flex items-center space-x-1"
            :title="`Record ID: #${turnChat.recordId}`"
          >
            <span>#{{ turnChat.recordId }}</span>
            <i class="fa-regular fa-copy text-[9px] opacity-60"></i>
          </button>
          <span v-if="turnChat.toolLink" class="text-sky-700 dark:text-sky-300 text-xs" aria-label="关联网页搜索">{{ t('timeline.linkedSearch') }} · {{ t('timeline.fromRequest', { id: turnChat.toolLink.parentRecordId }) }}</span>
          <span v-else-if="turnChat.purpose" class="text-sky-700 dark:text-sky-300 text-xs" aria-label="请求用途">{{ t('auxiliaryPurpose.' + turnChat.purpose.kind) || auxiliaryPurposeLabels[turnChat.purpose.kind] }}</span>
          <span class="text-slate-300 dark:text-slate-600">·</span>
          <span class="text-slate-500 dark:text-slate-400">{{ t('timeline.duration', { ms: turnChat.duration_ms }) }}</span>
          <span class="text-slate-300 dark:text-slate-600">·</span>
          <span :class="isSuccessfulCapture(turnChat.statusCode, turnChat.captureStatus) ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'">
            <template v-if="turnChat.connectionIssue">{{ t('timeline.connectionIssueStatus') }} {{ turnChat.connectionIssue.statusCode }}</template>
            <template v-else>{{ turnChat.statusCode }} {{ turnChat.captureStatus === 'error' ? 'Error' : turnChat.statusCode === 101 ? 'WebSocket' : '' }}</template>
          </span>
        </div>
        <span v-if="!turnChat.connectionIssue && turnChat.tokenSource !== 'reported'" class="text-xs text-slate-500 dark:text-slate-400">{{ t('session.usageUnavailable') }}</span>
        <div v-if="!turnChat.connectionIssue && turnChat.tokenSource === 'reported'" class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-slate-500 dark:text-slate-400 text-[11px] font-mono">
          <span>input <span class="text-blue-600 dark:text-blue-400 font-medium">{{ formatTokens(turnChat.inputTokens) }}</span><span v-if="turnChat.cachedTokens > 0" class="text-emerald-600 dark:text-emerald-400 font-medium">(cache {{ formatTokens(turnChat.cachedTokens) }} {{ turnChat.cacheRatio }}%)</span></span>
          <span>output <span class="text-pink-600 dark:text-pink-400 font-medium">{{ formatTokens(turnChat.outputTokens) }}</span></span>
          <span v-if="turnChat.thinkingTokens && turnChat.thinkingTokens > 0">thinking <span class="text-purple-600 dark:text-purple-400 font-medium">{{ formatTokens(turnChat.thinkingTokens) }}</span></span>
        </div>
      </div>

      <p v-if="turnChat.contentExpired" class="text-xs text-amber-700 dark:text-amber-400 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900">
        {{ t('timeline.expiredNotice') }}
      </p>

      <!-- 1. 【问】: Prompt / User Input / Tool Feedback -->
      <div v-if="!turnChat.connectionIssue" class="flex justify-end w-full">
        <div class="w-full max-w-[94%] sm:max-w-[90%] lg:max-w-[88%] bg-white dark:bg-slate-900/95 border border-slate-200/90 dark:border-slate-700/80 rounded-2xl rounded-tr-xs overflow-hidden shadow-xs dark:shadow-none transition-colors">
          <!-- Header -->
          <div class="px-4 py-2.5 bg-slate-50/90 dark:bg-slate-800/50 border-b border-slate-200/80 dark:border-slate-800/80 flex flex-wrap gap-2 items-center justify-between text-xs">
            <div class="flex items-center space-x-2 font-mono whitespace-nowrap">
              <span
                class="px-2 py-0.5 rounded text-[10px] font-bold uppercase"
                :class="turnChat.question.isContextUpdate ? 'bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' : turnChat.question.toolResults.length > 0 ? 'bg-cyan-50 text-cyan-700 border border-cyan-200 dark:bg-cyan-500/10 dark:text-cyan-400 dark:border-cyan-500/20' : 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'"
              >
                <i :class="turnChat.question.isContextUpdate ? 'fa-solid fa-sliders mr-1' : turnChat.question.toolResults.length > 0 ? 'fa-solid fa-terminal mr-1' : 'fa-regular fa-user mr-1'"></i>
                {{ turnChat.question.roleLabel }}
              </span>
            </div>

            <!-- High-contrast RAW Switch -->
            <div class="flex items-center space-x-2 whitespace-nowrap">
              <button
                type="button"
                role="switch"
                :aria-checked="isRaw(turnChat.turnIndex, 'req')"
                @click="toggleRaw(turnChat.turnIndex, 'req', turnChat.recordId)"
                class="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono border transition-all cursor-pointer select-none"
                :class="isRaw(turnChat.turnIndex, 'req')
                  ? 'bg-indigo-600 border-indigo-500 text-white font-bold shadow-xs'
                  : 'bg-slate-100 border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-200 dark:bg-slate-800/80 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-700'"
                :title="isRaw(turnChat.turnIndex, 'req') ? t('timeline.rawModeActive') : t('timeline.rawModeInactive')"
              >
                <span class="text-[10px] tracking-wider">RAW</span>
                <span
                  class="relative inline-flex h-3 w-5 shrink-0 rounded-full transition-colors duration-200 ease-in-out border"
                  :class="isRaw(turnChat.turnIndex, 'req') ? 'bg-indigo-400/90 border-white/60' : 'bg-slate-300 border-slate-300 dark:bg-slate-600 dark:border-slate-500'"
                >
                  <span
                    class="inline-block h-2 w-2 transform rounded-full bg-white shadow-xs transition duration-200 ease-in-out mt-[1px] ml-[1px]"
                    :class="isRaw(turnChat.turnIndex, 'req') ? 'translate-x-2' : 'translate-x-0'"
                  ></span>
                </span>
              </button>
            </div>
          </div>

          <!-- Body -->
          <div class="p-4 space-y-3">
            <!-- Collapsed Prior History Summary -->
            <div
              v-if="!isRaw(turnChat.turnIndex, 'req') && turnChat.question.historyCount > 0"
              class="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800/80 rounded-lg p-2.5 text-xs text-slate-600 dark:text-slate-400 flex flex-col space-y-2"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center space-x-2">
                  <i class="fa-solid fa-clock-rotate-left text-indigo-500 dark:text-indigo-400 text-xs"></i>
                  <span class="text-slate-700 dark:text-slate-300 font-medium text-[11px]">
                    {{ t('timeline.priorMessages', { count: turnChat.question.historyCount }) }}
                  </span>
                </div>
                <button
                  @click="toggleHistory(turnChat.turnIndex)"
                  class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 text-[11px] font-medium transition cursor-pointer flex items-center space-x-1"
                >
                  <span>{{ isHistoryExpanded(turnChat.turnIndex) ? t('timeline.collapseHistory') : t('timeline.expandHistory') }}</span>
                  <i class="fa-solid text-[10px]" :class="isHistoryExpanded(turnChat.turnIndex) ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
                </button>
              </div>

              <!-- Expanded Historical Messages List -->
              <div
                v-if="isHistoryExpanded(turnChat.turnIndex)"
                class="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2 max-h-64 overflow-y-auto"
              >
                <div
                  v-for="(h, hIdx) in turnChat.question.historyMessages"
                  :key="hIdx"
                  class="p-2 bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800/60 text-[11px] font-mono text-slate-700 dark:text-slate-300"
                >
                  <div class="font-bold text-[10px] text-slate-400 dark:text-slate-500 uppercase mb-1">{{ h.role }}</div>
                  <div class="whitespace-pre-wrap break-words leading-relaxed">{{ h.text }}</div>
                </div>
              </div>
            </div>

            <div v-if="!isRaw(turnChat.turnIndex, 'req') && turnChat.previousResponseId" class="p-3 rounded-lg border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/30 text-xs space-y-2">
              <button class="text-indigo-700 dark:text-indigo-300 cursor-pointer" @click="loadRelated(turnChat)">
                {{ t('timeline.relatedHistory', { count: turnChat.relatedHistory ? turnChat.relatedHistory.messageCount : 0 }) }} · {{ relatedExpanded[turnChat.recordId] ? t('timeline.collapse') : t('timeline.expand') }}
              </button>
              <p class="text-slate-500">{{ t('timeline.relatedHistoryNotice') }}</p>
              <div v-if="relatedExpanded[turnChat.recordId]" class="space-y-2 max-h-80 overflow-auto">
                <p v-if="turnChat.historyLoading">{{ t('timeline.queryingHistory') }}</p>
                <p v-if="turnChat.relatedHistory && turnChat.relatedHistory.status !== 'complete'" class="text-amber-600 dark:text-amber-400">{{ historyStatus[turnChat.relatedHistory.status] }}</p>
                <div v-for="record in turnChat.relatedHistory?.records" :key="record.record_id" class="space-y-1 border-t border-indigo-200 dark:border-indigo-900 pt-2">
                  <span class="font-mono text-slate-500">#{{ record.record_id }} · {{ record.response_id }}</span>
                  <div v-for="(message, index) in record.messages" :key="index" class="whitespace-pre-wrap break-words"><strong>{{ message.role }}</strong> · {{ message.text }}</div>
                </div>
              </div>
            </div>

            <!-- View Mode 1: 易读格式 -->
            <div v-if="!isRaw(turnChat.turnIndex, 'req')" class="space-y-3">
              <button v-if="!turnChat.readableLoaded && !turnChat.contentExpired" class="text-xs text-indigo-600 cursor-pointer" @click="emit('ensure-raw-body', turnChat.recordId)">{{ t('timeline.loadFullContent') }}</button>
              <p v-if="turnChat.question.isContextUpdate" class="text-xs text-slate-600 dark:text-slate-400">
                {{ t('timeline.contextUpdateNotice') }}
              </p>
              <template v-if="turnChat.question.isContextUpdate">
                <details v-if="turnChat.question.newText" class="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
                  <summary class="text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer flex items-center justify-between">
                    <span>{{ t('timeline.contextDesc') }} · {{ t('timeline.chars', { count: turnChat.question.newText.length.toLocaleString() }) }}</span>
                    <button
                      type="button"
                      @click.stop="handleCopy(turnChat.question.newText, t('timeline.copiedContext'), `ctx-${turnChat.turnIndex}`)"
                      class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                      :title="t('timeline.copyContext')"
                    >
                      <i :class="copiedKey === `ctx-${turnChat.turnIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                    </button>
                  </summary>
                  <pre class="mt-3 text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto text-slate-800 dark:text-slate-200">{{ turnChat.question.newText }}</pre>
                </details>
                <div v-if="turnChat.question.contextTools?.length" class="space-y-2">
                  <p class="text-xs font-medium text-slate-600 dark:text-slate-400">{{ t('timeline.additionalTools') }}</p>
                  <details v-for="(tool, toolIndex) in turnChat.question.contextTools" :key="toolIndex" class="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
                    <summary class="text-xs font-mono text-slate-700 dark:text-slate-200 cursor-pointer break-words flex items-center justify-between">
                      <span>{{ tool.name || tool.type || 'tool' }}<span v-if="Array.isArray(tool.tools)"> · {{ t('timeline.itemsCount', { count: tool.tools.length }) }}</span></span>
                      <button
                        type="button"
                        @click.stop="handleCopy(prettyJson(tool), t('timeline.copiedToolDef'), `tooldef-${turnChat.turnIndex}-${toolIndex}`)"
                        class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                        :title="t('timeline.copyToolDef')"
                      >
                        <i :class="copiedKey === `tooldef-${turnChat.turnIndex}-${toolIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                      </button>
                    </summary>
                    <pre class="mt-3 text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto text-slate-800 dark:text-slate-200">{{ prettyJson(tool) }}</pre>
                  </details>
                </div>
              </template>
              <!-- User Text Prompt -->
              <div v-else-if="turnChat.question.newText" class="text-xs font-mono text-slate-800 dark:text-slate-100 whitespace-pre-wrap leading-relaxed bg-slate-50 dark:bg-slate-950 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                <div class="flex items-center justify-between mb-1.5 pb-1 border-b border-slate-200/50 dark:border-slate-800/50 text-[10px] text-slate-400">
                  <span>{{ t('timeline.requestContent') }}</span>
                  <button
                    type="button"
                    @click="handleCopy(turnChat.question.newText, t('timeline.copiedRequest'), `req-${turnChat.turnIndex}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                    :title="t('timeline.copyRequest')"
                  >
                    <i :class="copiedKey === `req-${turnChat.turnIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
                <div>{{ turnChat.question.newText }}</div>
              </div>

              <!-- Tool Results Feedback -->
              <div
                v-for="(tr, trIdx) in turnChat.question.toolResults"
                :key="trIdx"
                class="bg-cyan-50/60 dark:bg-slate-950 rounded-lg border border-cyan-200 dark:border-cyan-800/40 p-3 space-y-1.5"
              >
                <div class="flex items-center justify-between text-xs font-mono font-bold text-cyan-800 dark:text-cyan-300">
                  <div class="flex items-center space-x-2">
                    <i class="fa-solid fa-terminal text-[11px]"></i>
                    <span>{{ t('timeline.toolReturn', { name: tr.name }) }}</span>
                  </div>
                  <button
                    v-if="tr.output"
                    type="button"
                    @click="handleCopy(tr.output, t('timeline.copiedToolOutput', { name: tr.name }), `toolres-${turnChat.turnIndex}-${trIdx}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-cyan-700 dark:text-cyan-300 hover:text-cyan-900 dark:hover:text-white hover:bg-cyan-100/60 dark:hover:bg-cyan-950/60 transition cursor-pointer"
                    :title="t('timeline.copyToolOutput')"
                  >
                    <i :class="copiedKey === `toolres-${turnChat.turnIndex}-${trIdx}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
                <pre v-if="tr.output" class="p-2.5 bg-white dark:bg-slate-900/90 rounded text-[11px] font-mono text-slate-800 dark:text-slate-300 max-h-72 overflow-y-auto whitespace-pre-wrap leading-relaxed border border-cyan-100 dark:border-slate-800/80">{{ tr.output }}</pre>
              </div>
            </div>

            <!-- View Mode 2: 原始载荷 -->
            <div v-else class="space-y-3 font-mono text-xs">
              <div class="space-y-1">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400">{{ t('timeline.requestHeaders') }}</span>
                  <button
                    type="button"
                    @click="handleCopy(prettyJson(turnChat.rawHeaders), t('timeline.copiedHeaders'), `headers-${turnChat.turnIndex}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                    :title="t('timeline.copyHeaders')"
                  >
                    <i :class="copiedKey === `headers-${turnChat.turnIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
                <pre class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-[11px] text-slate-800 dark:text-slate-300 max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-800">{{ prettyJson(turnChat.rawHeaders) }}</pre>
              </div>
              <div class="space-y-1">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400">{{ t('timeline.requestBody') }}</span>
                  <button
                    v-if="turnChat.rawRequestBody"
                    type="button"
                    @click="handleCopy(formatPayload(turnChat.rawRequestBody), t('timeline.copiedRequestBody'), `reqbody-${turnChat.turnIndex}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                    :title="t('timeline.copyRequestBody')"
                  >
                    <i :class="copiedKey === `reqbody-${turnChat.turnIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
                <pre
                  v-if="turnChat.rawRequestBody"
                  class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-[11px] text-slate-800 dark:text-slate-300 max-h-96 overflow-y-auto border border-slate-200 dark:border-slate-800 whitespace-pre-wrap break-all"
                >{{ formatPayload(turnChat.rawRequestBody) }}</pre>
                <div
                  v-else-if="turnChat.rawLoading"
                  class="p-3.5 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 flex items-center space-x-2"
                >
                  <i class="fa-solid fa-spinner fa-spin text-indigo-500"></i>
                  <span>{{ t('timeline.loadingRawPayload') }}</span>
                </div>
                <div
                  v-else-if="turnChat.rawLoadError"
                  class="p-3 bg-rose-50 dark:bg-rose-950/40 rounded-lg text-xs font-mono text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 flex items-center justify-between"
                >
                  <div class="flex items-center space-x-1.5">
                    <i class="fa-solid fa-circle-exclamation text-rose-500"></i>
                    <span>{{ turnChat.rawLoadError }}</span>
                  </div>
                  <button
                    @click="toggleRaw(turnChat.turnIndex, 'req', turnChat.recordId)"
                    class="px-2 py-0.5 bg-white hover:bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:hover:bg-rose-900 dark:text-rose-200 rounded border border-rose-300 dark:border-rose-800 text-[11px] cursor-pointer"
                  >
                    {{ t('timeline.retry') }}
                  </button>
                </div>
                <div
                  v-else-if="!turnChat.rawLoaded"
                  class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 flex items-center justify-between"
                >
                  <div class="flex items-center space-x-1.5">
                    <i class="fa-solid fa-cloud-arrow-down text-slate-400"></i>
                    <span>{{ t('timeline.rawPayloadNotLoaded') }}</span>
                  </div>
                  <button
                    @click="toggleRaw(turnChat.turnIndex, 'req', turnChat.recordId)"
                    class="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 rounded border border-indigo-200 dark:border-indigo-800 text-[11px] cursor-pointer"
                  >
                    {{ t('timeline.fetchPayload') }}
                  </button>
                </div>
                <div
                  v-else-if="turnChat.rawPruned"
                  class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-400 italic border border-dashed border-slate-200 dark:border-slate-800"
                >
                  <i class="fa-solid fa-database mr-1 opacity-70"></i>
                  {{ t('timeline.rawReqPayloadExpired') }}
                </div>
                <div
                  v-else
                  class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-400 italic border border-dashed border-slate-200 dark:border-slate-800"
                >
                  {{ t('timeline.noRawReqPayload') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 【答】: Assistant / Model Response -->
      <div class="flex justify-start w-full">
        <div class="w-full max-w-[94%] sm:max-w-[90%] lg:max-w-[88%] bg-white dark:bg-slate-900/95 border border-indigo-200 dark:border-indigo-500/30 rounded-2xl rounded-tl-xs overflow-hidden shadow-xs dark:shadow-none transition-colors">
          <!-- Header -->
          <div class="px-4 py-2.5 bg-indigo-50/50 dark:bg-indigo-950/20 border-b border-indigo-100 dark:border-indigo-900/30 flex flex-wrap gap-2 items-center justify-between text-xs">
            <div class="flex items-center space-x-2 font-mono whitespace-nowrap">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20">
                <i class="fa-solid fa-robot mr-1"></i>
                {{ turnChat.connectionIssue ? t('timeline.connectionEvent') : t('timeline.modelResponse') }}
              </span>
              <span v-if="!turnChat.connectionIssue" class="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:inline">
                {{ turnChat.answer.model }}
              </span>
            </div>

            <!-- High-contrast RAW Switch for Response -->
            <div class="flex items-center space-x-2 whitespace-nowrap">
              <button
                type="button"
                role="switch"
                :aria-checked="isRaw(turnChat.turnIndex, 'res')"
                @click="toggleRaw(turnChat.turnIndex, 'res', turnChat.recordId)"
                class="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono border transition-all cursor-pointer select-none"
                :class="isRaw(turnChat.turnIndex, 'res')
                  ? 'bg-indigo-600 border-indigo-500 text-white font-bold shadow-xs'
                  : 'bg-slate-100 border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-200 dark:bg-slate-800/80 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-700'"
                :title="isRaw(turnChat.turnIndex, 'res') ? t('timeline.rawModeActive') : t('timeline.rawModeInactive')"
              >
                <span class="text-[10px] tracking-wider">RAW</span>
                <span
                  class="relative inline-flex h-3 w-5 shrink-0 rounded-full transition-colors duration-200 ease-in-out border"
                  :class="isRaw(turnChat.turnIndex, 'res') ? 'bg-indigo-400/90 border-white/60' : 'bg-slate-300 border-slate-300 dark:bg-slate-600 dark:border-slate-500'"
                >
                  <span
                    class="inline-block h-2 w-2 transform rounded-full bg-white shadow-xs transition duration-200 ease-in-out mt-[1px] ml-[1px]"
                    :class="isRaw(turnChat.turnIndex, 'res') ? 'translate-x-2' : 'translate-x-0'"
                  ></span>
                </span>
              </button>
            </div>
          </div>

          <!-- Body -->
          <div class="p-4 space-y-3">
            <!-- View Mode 1: 易读格式 -->
            <div v-if="!isRaw(turnChat.turnIndex, 'res')" class="space-y-3">
              <!-- Thinking Stream -->
              <div v-if="turnChat.answer.thinkingText" class="p-3 bg-purple-50/70 dark:bg-purple-950/20 border border-purple-200/80 dark:border-purple-800/30 rounded-lg space-y-1.5">
                <div class="flex items-center justify-between text-[11px] font-mono text-purple-800 dark:text-purple-300 font-semibold">
                  <div class="flex items-center space-x-1.5">
                    <span>{{ t('timeline.thinkingHeader') }}</span>
                  </div>
                  <button
                    type="button"
                    @click="handleCopy(turnChat.answer.thinkingText, t('timeline.copiedThinking'), `think-${turnChat.turnIndex}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-purple-700 dark:text-purple-300 hover:text-purple-900 dark:hover:text-white hover:bg-purple-100/60 dark:hover:bg-purple-950/60 transition cursor-pointer"
                    :title="t('timeline.copyThinking')"
                  >
                    <i :class="copiedKey === `think-${turnChat.turnIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
                <div class="text-xs font-mono text-purple-950/90 dark:text-purple-200/80 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {{ turnChat.answer.thinkingText }}
                </div>
              </div>

              <!-- Tool Calls -->
              <div
                v-for="(tc, tcIdx) in turnChat.answer.toolCalls"
                :key="tcIdx"
                class="bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-800/40 rounded-lg p-3 space-y-1.5"
              >
                <div class="flex items-center justify-between text-xs font-mono font-bold text-amber-800 dark:text-amber-300">
                  <div class="flex items-center space-x-1.5">
                    <i class="fa-solid fa-screwdriver-wrench text-xs"></i>
                    <span>{{ t('timeline.triggerToolCall', { name: tc.name }) }}</span>
                  </div>
                  <button
                    type="button"
                    @click="handleCopy(prettyJson(tc.args), t('timeline.copiedToolArgs', { name: tc.name }), `toolcall-${turnChat.turnIndex}-${tcIdx}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-white hover:bg-amber-100/60 dark:hover:bg-amber-950/60 transition cursor-pointer"
                    :title="t('timeline.copyToolArgs')"
                  >
                    <i :class="copiedKey === `toolcall-${turnChat.turnIndex}-${tcIdx}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
                <pre class="p-2.5 bg-white dark:bg-slate-950 rounded text-[11px] font-mono text-amber-900 dark:text-amber-200/90 max-h-48 overflow-y-auto whitespace-pre-wrap border border-amber-200 dark:border-amber-900/40">{{ prettyJson(tc.args) }}</pre>
              </div>

              <!-- Subagent Nested Executions -->
              <div
                v-if="turnChat.answer.subagents && turnChat.answer.subagents.length > 0"
                class="space-y-2 mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-800"
              >
                <div class="text-[11px] font-mono font-bold text-blue-700 dark:text-sky-300 flex items-center space-x-1.5">
                  <i class="fa-solid fa-network-wired text-[10px]"></i>
                  <span>{{ t('timeline.subagentCollaborations', { count: turnChat.answer.subagents.length }) }}</span>
                </div>

                <div
                  v-for="sub in turnChat.answer.subagents"
                  :key="sub.record_id"
                  class="bg-blue-50/50 dark:bg-slate-950/80 border border-blue-200/80 dark:border-blue-900/40 rounded-lg p-2.5 space-y-2"
                >
                  <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-2 flex-wrap gap-y-1">
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border border-blue-300 dark:border-blue-800 flex items-center space-x-1">
                        <i class="fa-solid fa-robot text-[9px]"></i>
                        <span>{{ sub.subagent_type || 'SubAgent' }}</span>
                      </span>
                      <span class="text-xs font-mono font-semibold text-slate-800 dark:text-slate-200">{{ sub.agent_name }}</span>
                      <span class="text-[10px] font-mono text-slate-500 dark:text-slate-400">{{ sub.model }}</span>
                      <span class="text-[10px] font-mono text-slate-400">
                        #{{ sub.record_id }} · {{ (sub.duration_ms / 1000).toFixed(1) }}s · {{ sub.input_tokens + sub.output_tokens }} toks
                      </span>
                    </div>

                    <button
                      @click="toggleSubagent(sub.record_id)"
                      class="px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 rounded transition cursor-pointer flex items-center space-x-1"
                    >
                      <span>{{ isSubagentExpanded(sub.record_id) ? t('timeline.collapseSubagent') : t('timeline.expandSubagent') }}</span>
                      <i class="fa-solid text-[9px]" :class="isSubagentExpanded(sub.record_id) ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
                    </button>
                  </div>

                  <!-- Expanded subagent details -->
                  <div v-if="isSubagentExpanded(sub.record_id)" class="pt-2 border-t border-blue-200/60 dark:border-slate-800/80 space-y-2 text-xs font-mono">
                    <div v-if="sub.user_prompt" class="space-y-1">
                      <div class="text-[10px] font-bold text-slate-500 dark:text-slate-400 flex items-center justify-between">
                        <span>{{ t('timeline.subagentPrompt') }}</span>
                        <button @click="handleCopy(sub.user_prompt)" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer">
                          <i class="fa-regular fa-copy"></i>
                        </button>
                      </div>
                      <pre class="p-2 bg-white dark:bg-slate-900 rounded text-[11px] text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-800 whitespace-pre-wrap max-h-48 overflow-y-auto">{{ sub.user_prompt }}</pre>
                    </div>

                    <div v-if="sub.response_text || sub.response_preview" class="space-y-1">
                      <div class="text-[10px] font-bold text-slate-500 dark:text-slate-400 flex items-center justify-between">
                        <span>{{ t('timeline.subagentResponse') }}</span>
                        <button @click="handleCopy(sub.response_text || sub.response_preview)" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer">
                          <i class="fa-regular fa-copy"></i>
                        </button>
                      </div>
                      <pre class="p-2 bg-white dark:bg-slate-900 rounded text-[11px] text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-800 whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed">{{ sub.response_text || sub.response_preview }}</pre>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Text Response Content -->
              <div v-if="turnChat.answer.responseText" class="text-xs font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto bg-slate-50 dark:bg-slate-950 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                <div class="flex items-center justify-between mb-1.5 pb-1 border-b border-slate-200/50 dark:border-slate-800/50 text-[10px] text-slate-400">
                  <span>{{ t('timeline.responseContent') }}</span>
                  <button
                    type="button"
                    @click="handleCopy(turnChat.answer.responseText, t('timeline.copiedResponseContent'), `res-${turnChat.turnIndex}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                    :title="t('timeline.copyResponseContent')"
                  >
                    <i :class="copiedKey === `res-${turnChat.turnIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
                <div>{{ turnChat.answer.responseText }}</div>
              </div>

              <p v-else-if="turnChat.connectionIssue" class="text-xs text-rose-700 dark:text-rose-300">
                {{ connectionIssueLabels[turnChat.connectionIssue.kind] }}
              </p>

              <!-- Tool Call Only Notice -->
              <p v-else-if="turnChat.question.isContextUpdate && turnChat.readableLoaded && !turnChat.contentExpired && turnChat.captureStatus === 'complete' && isSuccessfulCapture(turnChat.statusCode, turnChat.captureStatus) && !turnChat.answer.thinkingText && !turnChat.answer.toolCalls.length" class="text-xs text-slate-600 dark:text-slate-400">
                {{ t('timeline.noResponseContextOnly') }}
              </p>
              <div
                v-else-if="turnChat.answer.toolCalls.length > 0"
                class="text-[11px] text-slate-400 dark:text-slate-500 font-mono italic"
              >
                {{ t('timeline.toolCallOnlyNotice') }}
              </div>
            </div>

            <button v-if="!isRaw(turnChat.turnIndex, 'res') && !turnChat.readableLoaded && !turnChat.contentExpired" class="text-xs text-indigo-600 cursor-pointer" @click="emit('ensure-raw-body', turnChat.recordId)">{{ t('timeline.loadFullResponsePreview') }}</button>
            <!-- View Mode 2: 原始载荷 Response -->
            <div v-if="isRaw(turnChat.turnIndex, 'res')" class="space-y-1 font-mono text-xs">
              <div class="flex items-center justify-between mb-1">
                <div class="flex items-center space-x-2">
                  <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400">Response Body:</span>
                  <span
                    v-if="isSsePayload(turnChat.rawResponseBody)"
                    class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800"
                  >
                    {{ t('timeline.sseStream') }}
                  </span>
                </div>
                <div class="flex items-center space-x-2.5">
                  <!-- SSE Merge Switch (Only shown when payload is SSE) -->
                  <button
                    v-if="isSsePayload(turnChat.rawResponseBody)"
                    type="button"
                    role="switch"
                    :aria-checked="isMergedSse(turnChat.turnIndex)"
                    @click="toggleMergedSse(turnChat.turnIndex)"
                    class="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono border transition-all cursor-pointer select-none"
                    :class="isMergedSse(turnChat.turnIndex)
                      ? 'bg-indigo-600 border-indigo-500 text-white font-semibold shadow-xs'
                      : 'bg-slate-100 border-slate-200 text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:bg-slate-800/80 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200'"
                    :title="t('timeline.mergedPayload')"
                  >
                    <span>{{ isMergedSse(turnChat.turnIndex) ? t('timeline.mergedPayload') : t('timeline.rawStream') }}</span>
                    <span
                      class="relative inline-flex h-3 w-5 shrink-0 rounded-full transition-colors duration-200 ease-in-out border"
                      :class="isMergedSse(turnChat.turnIndex) ? 'bg-indigo-400 border-white/60' : 'bg-slate-300 border-slate-300 dark:bg-slate-600 dark:border-slate-500'"
                    >
                      <span
                        class="inline-block h-2 w-2 transform rounded-full bg-white shadow-xs transition duration-200 ease-in-out mt-[1px] ml-[1px]"
                        :class="isMergedSse(turnChat.turnIndex) ? 'translate-x-2' : 'translate-x-0'"
                      ></span>
                    </span>
                  </button>

                  <!-- Copy button for raw response body -->
                  <button
                    v-if="turnChat.rawResponseBody"
                    type="button"
                    @click="handleCopy(getRawResponseDisplay(turnChat), t('timeline.copiedResponseBody'), `resraw-${turnChat.turnIndex}`)"
                    class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition cursor-pointer"
                    :title="t('timeline.copyResponseBody')"
                  >
                    <i :class="copiedKey === `resraw-${turnChat.turnIndex}` ? 'fa-solid fa-check text-emerald-500 text-xs' : 'fa-regular fa-copy text-xs'"></i>
                  </button>
                </div>
              </div>
              <SocketRaw v-if="turnChat.rawResponseBody && turnChat.bodyFormat === 'ws-messages-v1'" :body="turnChat.rawResponseBody" />
              <pre
                v-else-if="turnChat.rawResponseBody && turnChat.bodyFormat !== 'ws-messages-v1'"
                class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-[11px] text-slate-800 dark:text-slate-300 max-h-96 overflow-y-auto border border-slate-200 dark:border-slate-800 whitespace-pre-wrap break-all"
              >{{ getRawResponseDisplay(turnChat) }}</pre>
              <div
                v-else-if="turnChat.rawLoading"
                class="p-3.5 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 flex items-center space-x-2"
              >
                <i class="fa-solid fa-spinner fa-spin text-indigo-500"></i>
                <span>{{ t('timeline.loadingRawPayload') }}</span>
              </div>
              <div
                v-else-if="turnChat.rawLoadError"
                class="p-3 bg-rose-50 dark:bg-rose-950/40 rounded-lg text-xs font-mono text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 flex items-center justify-between"
              >
                <div class="flex items-center space-x-1.5">
                  <i class="fa-solid fa-circle-exclamation text-rose-500"></i>
                  <span>{{ turnChat.rawLoadError }}</span>
                </div>
                <button
                  @click="toggleRaw(turnChat.turnIndex, 'res', turnChat.recordId)"
                  class="px-2 py-0.5 bg-white hover:bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:hover:bg-rose-900 dark:text-rose-200 rounded border border-rose-300 dark:border-rose-800 text-[11px] cursor-pointer"
                >
                  {{ t('timeline.retry') }}
                </button>
              </div>
              <div
                v-else-if="!turnChat.rawLoaded"
                class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 flex items-center justify-between"
              >
                <div class="flex items-center space-x-1.5">
                  <i class="fa-solid fa-cloud-arrow-down text-slate-400"></i>
                  <span>{{ t('timeline.rawPayloadNotLoaded') }}</span>
                </div>
                <button
                  @click="toggleRaw(turnChat.turnIndex, 'res', turnChat.recordId)"
                  class="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 rounded text-[11px] cursor-pointer"
                >
                  {{ t('timeline.fetchPayload') }}
                </button>
              </div>
              <div
                v-else-if="turnChat.rawPruned"
                class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-400 italic border border-dashed border-slate-200 dark:border-slate-800"
              >
                <i class="fa-solid fa-database mr-1 opacity-70"></i>
                {{ t('timeline.rawPayloadExpired') }}
              </div>
              <div
                v-else
                class="p-3 bg-slate-50 dark:bg-slate-950 rounded-lg text-xs font-mono text-slate-400 italic border border-dashed border-slate-200 dark:border-slate-800"
              >
                {{ t('timeline.noRawPayload') }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 增量切片加载控制器 (长会话保障毫秒级首屏与零卡顿) -->
    <div
      v-if="visibleTurns.length < turns.length"
      class="py-4 text-center space-y-2.5 border-t border-dashed border-slate-200 dark:border-slate-800"
    >
      <div class="text-xs text-slate-500 dark:text-slate-400 font-mono">
        {{ t('timeline.shownTurns', { visible: visibleTurns.length, total: turns.length }) }}
      </div>
      <div class="flex items-center justify-center space-x-2">
        <button
          @click="loadMoreTurns"
          class="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 dark:text-indigo-300 dark:border-indigo-800/60 rounded-lg text-xs font-semibold border border-indigo-200 transition cursor-pointer flex items-center space-x-1"
        >
          <i class="fa-solid fa-arrow-down text-[10px]"></i>
          <span>{{ t('timeline.loadMoreTurns', { count: Math.min(25, turns.length - visibleTurns.length) }) }}</span>
        </button>
        <button
          @click="showAllTurns"
          class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 transition cursor-pointer"
        >
          <span>{{ t('timeline.showAllTurns', { count: turns.length }) }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { isSuccessfulCapture } from '../../../shared/capture';
import { auxiliaryPurposeLabels, connectionIssueLabels } from '../../../shared/attribution';
import type { ChatTimelineTurn } from '../../types';
import { formatTokens, prettyJson } from '../../utils/formatters';
import { isSsePayload, formatPayload } from '../../../shared/protocol';
import SocketRaw from './SocketRaw.vue';
import { getTurnReqCopyContent, getTurnResCopyContent } from '../../utils/messageParser';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  sessionId?: string | null;
  turns: ChatTimelineTurn[];
  isLoading: boolean;
  ensureRawBodyFn?: (recordId: number) => Promise<any>;
}>();

const { t } = useI18n();

const INITIAL_TURNS_COUNT = 30;
const PAGE_SIZE = 25;
const renderedCount = ref(INITIAL_TURNS_COUNT);

// 标识当前会话（优先使用 sessionId，兜底使用首轮交互的 recordId，避免因 props.turns 数组引用变化而误触发重置）
const sessionKey = computed(() => {
  if (props.sessionId !== undefined) {
    return props.sessionId;
  }
  return props.turns?.[0]?.recordId ?? null;
});

// Reset slices on a session change; append only within the same session.
watch([sessionKey, () => props.turns?.length], ([key, length], [oldKey, oldLength]) => {
  if (key !== oldKey) {
    renderedCount.value = INITIAL_TURNS_COUNT;
    rawToggleMap.value = {};
    mergedSseMap.value = {};
    relatedExpanded.value = {};
    expandedHistoryMap.value = {};
    expandedSubagentMap.value = {};
  } else if (length && oldLength && length > oldLength && renderedCount.value >= oldLength) {
    renderedCount.value = length;
  }
});

const visibleTurns = computed(() => {
  if (!props.turns || props.turns.length <= INITIAL_TURNS_COUNT) return props.turns || [];
  return props.turns.slice(0, renderedCount.value);
});

const loadMoreTurns = () => {
  renderedCount.value = Math.min(props.turns.length, renderedCount.value + PAGE_SIZE);
};

const showAllTurns = () => {
  renderedCount.value = props.turns.length;
};

const ensureTurnVisible = (turnIndex: number) => {
  if (turnIndex > renderedCount.value) {
    renderedCount.value = Math.min(props.turns.length, turnIndex + 5);
  }
};

defineExpose({
  ensureTurnVisible
});

const emit = defineEmits<{
  (e: 'copy', text: string, msg?: string): void;
  (e: 'export-fixture', recordId: number): void;
  (e: 'ensure-raw-body', recordId: number): void;
  (e: 'ensure-related-history', recordId: number): void;
}>();

const relatedExpanded = ref<Record<number, boolean>>({});
const historyStatus: Record<string, string> = { none: '没有前序响应', missing: '前序记录未捕获或已删除', expired: '前序原文已过期，历史不完整', ambiguous: '同会话响应 ID 存在歧义，已停止关联', cycle: '检测到响应关联环，已停止', budget: '达到历史读取上限（32 条记录 / 1 MiB），仅展示已读取部分', untrusted: '缺少可信会话身份，无法关联', error: '历史读取失败，请刷新后重试', complete: '' };
const loadRelated = (turn: ChatTimelineTurn) => {
  relatedExpanded.value[turn.recordId] = !relatedExpanded.value[turn.recordId];
  if (relatedExpanded.value[turn.recordId]) emit('ensure-related-history', turn.recordId);
};

const rawToggleMap = ref<Record<string, boolean>>({});
const mergedSseMap = ref<Record<number, boolean>>({});
const expandedHistoryMap = ref<Record<number, boolean>>({});

const isMergedSse = (turnIndex: number) => {
  return mergedSseMap.value[turnIndex] !== false;
};

const toggleMergedSse = (turnIndex: number) => {
  mergedSseMap.value[turnIndex] = !isMergedSse(turnIndex);
};

const getRawResponseDisplay = (turnChat: ChatTimelineTurn): string => {
  const raw = turnChat.rawResponseBody || '';
  if (!raw) return '';
  return formatPayload(raw, isMergedSse(turnChat.turnIndex));
};

const copyFixture = (recordId: number) => {
  emit('export-fixture', recordId);
};

const isRaw = (turnIndex: number, type: 'req' | 'res') => {
  return !!rawToggleMap.value[`turn_${turnIndex}_${type}`];
};

const toggleRaw = async (turnIndex: number, type: 'req' | 'res', recordId?: number) => {
  const key = `turn_${turnIndex}_${type}`;
  rawToggleMap.value[key] = !rawToggleMap.value[key];
  if (rawToggleMap.value[key] && recordId) {
    if (props.ensureRawBodyFn) {
      await props.ensureRawBodyFn(recordId);
    } else {
      emit('ensure-raw-body', recordId);
    }
  }
};

const isHistoryExpanded = (turnIndex: number) => {
  return !!expandedHistoryMap.value[turnIndex];
};

const toggleHistory = (turnIndex: number) => {
  expandedHistoryMap.value[turnIndex] = !expandedHistoryMap.value[turnIndex];
};

const expandedSubagentMap = ref<Record<number, boolean>>({});

const isSubagentExpanded = (recordId: number) => {
  return !!expandedSubagentMap.value[recordId];
};

const toggleSubagent = (recordId: number) => {
  expandedSubagentMap.value[recordId] = !expandedSubagentMap.value[recordId];
};

const copiedKey = ref<string | null>(null);
let copyTimer: any = null;

const handleCopy = (tStr: string, msg?: string, key?: string) => {
  if (!tStr) return;
  if (key) {
    copiedKey.value = key;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      if (copiedKey.value === key) {
        copiedKey.value = null;
      }
    }, 1500);
  }
  emit('copy', tStr, msg || t('common.copied'));
};
</script>
