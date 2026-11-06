import { ref, computed } from 'vue';
import { useI18n } from './useI18n';
import type {
  StatsAgentCategory,
  ActivityViewMode,
  TokenActivitySummary,
  HeatmapCell,
  HeatmapMonthLabel,
  DayModelUsageItem
} from '../types';

const MONTH_NAMES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isElectron = () => typeof (window as any).electronAPI !== 'undefined';

/**
 * Token 计数本地化格式化函数
 * 支持按语言环境格式化为 xx万 / xx亿（中文环境）或 xxK / xxM / xxB（后续国际化）
 */
export function formatLocalizedTokens(n: number | null | undefined, locale: string = 'zh-CN'): string {
  if (!n || n <= 0) return '0';

  if (locale === 'zh-CN' || locale.startsWith('zh')) {
    if (n >= 100000000) {
      const val = (n / 100000000).toFixed(2).replace(/\.?0+$/, '');
      return `${val}亿`;
    }
    if (n >= 10000) {
      const val = (n / 10000).toFixed(1).replace(/\.?0+$/, '');
      return `${val}万`;
    }
    return n.toLocaleString();
  }

  // 预留国际化多语言扩展 (如 en-US: 1.2M, 3.4B 等)
  if (n >= 1000000000) {
    const val = (n / 1000000000).toFixed(2).replace(/\.?0+$/, '');
    return `${val}B`;
  }
  if (n >= 1000000) {
    const val = (n / 1000000).toFixed(1).replace(/\.?0+$/, '');
    return `${val}M`;
  }
  if (n >= 1000) {
    const val = (n / 1000).toFixed(1).replace(/\.?0+$/, '');
    return `${val}K`;
  }
  return n.toLocaleString();
}

export const formatTokenChinese = formatLocalizedTokens;

export function formatDurationChinese(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '0分';
  if (ms >= 3600000) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
  }
  if (ms >= 60000) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds}秒`;
}

export function useTokenActivity() {
  const { locale } = useI18n();
  const selectedAgent = ref<StatsAgentCategory>('all');
  const viewMode = ref<ActivityViewMode>('daily');
  const isLoading = ref(false);
  const error = ref('');

  const summary = ref<TokenActivitySummary>({
    total_tokens: 0,
    peak_tokens: 0,
    peak_date: '',
    max_duration_ms: 0,
    current_streak: 0,
    longest_streak: 0,
    days: []
  });

  const selectedDate = ref<string | null>(null);
  const dayModelUsages = ref<DayModelUsageItem[]>([]);
  const isLoadingDayModels = ref(false);
  let dayModelReqSeq = 0;
  let activityReqSeq = 0;

  const formatDateKey = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const dayStatMap = computed(() => {
    const map = new Map<string, any>();
    for (const d of summary.value.days) {
      map.set(d.date, d);
    }
    return map;
  });

  // 获取全量 365 天活动数据
  const fetchActivity = async (agent?: StatsAgentCategory) => {
    if (agent !== undefined) {
      selectedAgent.value = agent;
    }
    const currentSeq = ++activityReqSeq;
    const requestedAgent = selectedAgent.value;
    isLoading.value = true;
    error.value = '';
    // A pending detail request for the previous filter must not populate this filter.
    dayModelReqSeq++;
    dayModelUsages.value = [];
    isLoadingDayModels.value = Boolean(selectedDate.value);

    try {
      let data: TokenActivitySummary | undefined;
      if (isElectron() && typeof (window as any).electronAPI?.getDailyTokenActivity === 'function') {
        try {
          const res = await (window as any).electronAPI.getDailyTokenActivity(requestedAgent);
          if (res && typeof res.total_tokens === 'number' && Array.isArray(res.days)) data = res;
        } catch (ipcErr) {
          console.warn('[useTokenActivity] IPC getDailyTokenActivity fallback:', ipcErr);
        }
      }
      if (currentSeq !== activityReqSeq) return;

      if (!data) {
        try {
          const res = await fetch(`/api/stats/daily-activity?agent=${encodeURIComponent(requestedAgent)}`);
          if (currentSeq !== activityReqSeq) return;
          if (res.ok) {
            const json = await res.json();
            if (json && typeof json.total_tokens === 'number' && Array.isArray(json.days)) data = json;
          }
        } catch { /* Report unavailable usage only for the current selection below. */ }
      }
      if (currentSeq !== activityReqSeq) return;
      if (!data) throw new Error('用量账本暂时不可用，请重试');
      summary.value = data;
      if (selectedDate.value) void loadDayModelUsages(selectedDate.value, requestedAgent);
    } catch (err) {
      if (currentSeq !== activityReqSeq) return;
      error.value = err instanceof Error ? err.message : '用量统计加载失败';
      isLoadingDayModels.value = false;
      console.error('[useTokenActivity] Failed to fetch daily stats:', err);
    } finally {
      if (currentSeq === activityReqSeq) isLoading.value = false;
    }
  };

  // 选择某一天并加载该日各个模型的消耗量
  // 统一加载指定日期在所选 Agent 下的模型消耗数据
  const loadDayModelUsages = async (dateStr: string, agent: StatsAgentCategory) => {
    const currentSeq = ++dayModelReqSeq;
    isLoadingDayModels.value = true;
    try {
      let loaded = false;

      // 1. 尝试原生 IPC
      if (isElectron() && typeof (window as any).electronAPI?.getDayModelUsage === 'function') {
        try {
          const res = await (window as any).electronAPI.getDayModelUsage(dateStr, agent);
          if (currentSeq !== dayModelReqSeq) return;
          if (Array.isArray(res)) {
            dayModelUsages.value = res;
            loaded = true;
          }
        } catch (ipcErr) {
          console.warn('[useTokenActivity] IPC getDayModelUsage failed:', ipcErr);
        }
      }

      // 2. 尝试 Web API
      if (!loaded) {
        if (currentSeq !== dayModelReqSeq) return;
        try {
          const url = `/api/stats/day-model-usage?date=${encodeURIComponent(dateStr)}&agent=${encodeURIComponent(agent)}`;
          const res = await fetch(url);
          if (currentSeq !== dayModelReqSeq) return;
          if (res.ok) {
            const list = await res.json();
            if (currentSeq !== dayModelReqSeq) return;
            if (Array.isArray(list)) {
              dayModelUsages.value = list;
              loaded = true;
            }
          }
        } catch {}
      }

      if (!loaded) throw new Error('模型用量账本暂时不可用，请重试');
    } catch (err) {
      if (currentSeq !== dayModelReqSeq) return;
      error.value = err instanceof Error ? err.message : '模型用量加载失败';
      console.error('[useTokenActivity] Failed to fetch day model usage:', err);
      dayModelUsages.value = [];
    } finally {
      if (currentSeq === dayModelReqSeq) {
        isLoadingDayModels.value = false;
      }
    }
  };

  // 选择某一天并加载该日各个模型的消耗量
  const selectDay = async (dateStr: string) => {
    if (selectedDate.value === dateStr) {
      selectedDate.value = null;
      dayModelUsages.value = [];
      dayModelReqSeq++;
      isLoadingDayModels.value = false;
      return;
    }
    selectedDate.value = dateStr;
    await loadDayModelUsages(dateStr, selectedAgent.value);
  };

  // 计算过去 52 周的网格矩阵 (52 周 x 7 天)
  const heatmapData = computed(() => {
    const now = new Date();
    const todayStr = formatDateKey(now);

    const endOfWeek = new Date(now);
    const dayOfWeek = endOfWeek.getDay();
    endOfWeek.setDate(endOfWeek.getDate() + (6 - dayOfWeek));

    const startOfWeek = new Date(endOfWeek);
    startOfWeek.setDate(startOfWeek.getDate() - (52 * 7 - 1));
    startOfWeek.setHours(0, 0, 0, 0);

    const monthLabels: HeatmapMonthLabel[] = [];

    // 1. 基础天数据矩阵构建
    let currDay = new Date(startOfWeek);
    let lastMonth = -1;

    interface RawDayItem {
      date: string;
      dayOfWeek: number;
      isInFuture: boolean;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      requestCount: number;
      agentBreakdown?: Record<string, number>;
    }

    const rawWeeks: RawDayItem[][] = [];
    for (let w = 0; w < 52; w++) {
      const weekDays: RawDayItem[] = [];
      for (let d = 0; d < 7; d++) {
        const dateStr = formatDateKey(currDay);
        const dayStat = dayStatMap.value.get(dateStr);
        const isInFuture = dateStr > todayStr;
        let totalTokens = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;
        let requestCount = 0;
        let agentBreakdown: Record<string, number> | undefined = undefined;

        if (dayStat && !isInFuture) {
          totalTokens = dayStat.total_tokens || 0;
          inputTokens = dayStat.input_tokens || 0;
          outputTokens = dayStat.output_tokens || 0;
          cachedTokens = dayStat.cached_tokens || 0;
          requestCount = dayStat.request_count || 0;
          agentBreakdown = dayStat.agent_breakdown;
        }

        weekDays.push({
          date: dateStr,
          dayOfWeek: d,
          isInFuture,
          totalTokens,
          inputTokens,
          outputTokens,
          cachedTokens,
          requestCount,
          agentBreakdown
        });

        const month = currDay.getMonth();
        if (month !== lastMonth && d === 0) {
          const monthText = locale.value === 'zh-CN' ? `${month + 1}月` : MONTH_NAMES_EN[month];
          const lastLabel = monthLabels[monthLabels.length - 1];
          if ((!lastLabel || w - lastLabel.weekIndex >= 3) && (52 - w >= 2)) {
            monthLabels.push({ label: monthText, weekIndex: w });
            lastMonth = month;
          }
        }
        currDay.setDate(currDay.getDate() + 1);
      }
      rawWeeks.push(weekDays);
    }

    const mode = viewMode.value;
    const weeks: HeatmapCell[][] = [];

    if (mode === 'weekly') {
      // 2. 每周模式：以周（一列）为单位统计
      interface WeekSummary {
        total: number;
        input: number;
        output: number;
        cached: number;
        requestCount: number;
        breakdown: Record<string, number>;
        range: string;
      }
      const weekSummaries: WeekSummary[] = rawWeeks.map(days => {
        let total = 0, input = 0, output = 0, cached = 0, requestCount = 0;
        const breakdown: Record<string, number> = {};
        for (const day of days) {
          if (day.isInFuture) continue;
          total += day.totalTokens;
          input += day.inputTokens;
          output += day.outputTokens;
          cached += day.cachedTokens;
          requestCount += day.requestCount;
          if (day.agentBreakdown) {
            for (const [agent, tokens] of Object.entries(day.agentBreakdown)) {
              breakdown[agent] = (breakdown[agent] || 0) + tokens;
            }
          }
        }
        const range = `${days[0].date} ~ ${days[6].date}`;
        return { total, input, output, cached, requestCount, breakdown, range };
      });

      let maxWeekVal = 0;
      for (const ws of weekSummaries) {
        if (ws.total > maxWeekVal) maxWeekVal = ws.total;
      }
      if (maxWeekVal === 0) maxWeekVal = 1;

      for (let w = 0; w < 52; w++) {
        const ws = weekSummaries[w];
        const weekCells: HeatmapCell[] = rawWeeks[w].map(day => {
          let level = 0;
          if (!day.isInFuture && ws.total > 0) {
            const ratio = ws.total / maxWeekVal;
            if (ratio <= 0.2) level = 1;
            else if (ratio <= 0.45) level = 2;
            else if (ratio <= 0.75) level = 3;
            else level = 4;
          }
          return {
            date: day.date,
            dayOfWeek: day.dayOfWeek,
            tokens: ws.total,
            inputTokens: ws.input,
            outputTokens: ws.output,
            cachedTokens: ws.cached,
            requestCount: ws.requestCount,
            level,
            isInFuture: day.isInFuture,
            agentBreakdown: ws.breakdown,
            weekRange: ws.range,
            weekNumber: w + 1
          };
        });
        weeks.push(weekCells);
      }
    } else if (mode === 'cumulative') {
      // 3. 累计模式：按日期递增计算累计值
      let runningTotal = 0;
      const cumulativeMap = new Map<string, number>();
      for (const week of rawWeeks) {
        for (const day of week) {
          if (!day.isInFuture) {
            runningTotal += day.totalTokens;
            cumulativeMap.set(day.date, runningTotal);
          }
        }
      }
      const maxCumulative = Math.max(runningTotal, 1);

      for (let w = 0; w < 52; w++) {
        const weekCells: HeatmapCell[] = rawWeeks[w].map(day => {
          const tokens = day.isInFuture ? 0 : (cumulativeMap.get(day.date) || 0);
          let level = 0;
          if (!day.isInFuture && tokens > 0) {
            const ratio = tokens / maxCumulative;
            if (ratio <= 0.2) level = 1;
            else if (ratio <= 0.45) level = 2;
            else if (ratio <= 0.75) level = 3;
            else level = 4;
          }
          return {
            date: day.date,
            dayOfWeek: day.dayOfWeek,
            tokens,
            inputTokens: day.inputTokens,
            outputTokens: day.outputTokens,
            cachedTokens: day.cachedTokens,
            requestCount: day.requestCount,
            level,
            isInFuture: day.isInFuture,
            agentBreakdown: day.agentBreakdown
          };
        });
        weeks.push(weekCells);
      }
    } else {
      // 4. 每日模式（默认）：每个格子展示当天的实际数值
      let maxDayVal = 0;
      for (const week of rawWeeks) {
        for (const day of week) {
          if (!day.isInFuture && day.totalTokens > maxDayVal) {
            maxDayVal = day.totalTokens;
          }
        }
      }
      if (maxDayVal === 0) maxDayVal = 1;

      for (let w = 0; w < 52; w++) {
        const weekCells: HeatmapCell[] = rawWeeks[w].map(day => {
          let level = 0;
          if (!day.isInFuture && day.totalTokens > 0) {
            const ratio = day.totalTokens / maxDayVal;
            if (ratio <= 0.2) level = 1;
            else if (ratio <= 0.45) level = 2;
            else if (ratio <= 0.75) level = 3;
            else level = 4;
          }
          return {
            date: day.date,
            dayOfWeek: day.dayOfWeek,
            tokens: day.totalTokens,
            inputTokens: day.inputTokens,
            outputTokens: day.outputTokens,
            cachedTokens: day.cachedTokens,
            requestCount: day.requestCount,
            level,
            isInFuture: day.isInFuture,
            agentBreakdown: day.agentBreakdown
          };
        });
        weeks.push(weekCells);
      }
    }

    return {
      weeks,
      monthLabels
    };
  });

  return {
    selectedAgent,
    viewMode,
    isLoading,
    error,
    summary,
    selectedDate,
    dayModelUsages,
    isLoadingDayModels,
    heatmapData,
    fetchActivity,
    selectDay,
    formatTokenChinese,
    formatDurationChinese
  };
}
