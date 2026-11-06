export interface DailyTokenDayStat {
  date: string; // 'YYYY-MM-DD'
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  thinking_tokens: number;
  request_count: number;
  max_duration_ms: number;
  agent_breakdown?: Record<string, number>;
}

export interface TokenActivitySummary {
  total_tokens: number;
  peak_tokens: number;
  peak_date: string;
  max_duration_ms: number;
  current_streak: number;
  longest_streak: number;
  days: DailyTokenDayStat[];
}

export type StatsAgentCategory = 'all' | import('../../shared/agent').AgentCategory;
export type ActivityViewMode = 'daily' | 'weekly' | 'cumulative';

export interface HeatmapCell {
  date: string; // YYYY-MM-DD
  dayOfWeek: number; // 0: Sun, 1: Mon, ..., 6: Sat
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requestCount: number;
  level: number; // 0..4
  isInFuture?: boolean;
  agentBreakdown?: Record<string, number>;
  weekRange?: string;
  weekNumber?: number;
}

export interface HeatmapMonthLabel {
  label: string; // '10月', '11月', ...
  weekIndex: number;
}

export interface DayModelUsageItem {
  reported_requests: number;
  model: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}
