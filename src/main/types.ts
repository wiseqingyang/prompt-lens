/**
 * PromptLens Core Data Models & Type Definitions
 */

export type ProviderType = 'gemini' | 'anthropic' | 'openai' | 'unknown';

export type SessionIdentitySource = 'workbuddy_metadata' | 'pi_native'
  | 'conversation_id' | 'thread_id' | 'session_id' | 'codex_metadata'
  | 'header' | 'heuristic' | 'unknown' | 'legacy';
export type SessionConfidence = 'exact' | 'heuristic' | 'unknown';

export interface SessionIdentity {
  id: string;
  source: SessionIdentitySource;
  confidence: SessionConfidence;
  namespace?: string;
  thread_id?: string;
  session_id?: string;
  turn_id?: string;
}

export type CaptureStatus = 'complete' | 'truncated' | 'metadata_only' | 'interrupted' | 'unavailable' | 'error';

export type TokenSource = 'reported' | 'estimated' | 'unavailable' | 'parse_error';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
  cache_ratio: number;
  token_source: TokenSource;
  raw_details: Record<string, any>;
}

export interface PromptLayer {
  id: string;
  name: string;
  chars: number;
  percentage: number;
  content: string;
  badge_color: 'emerald' | 'amber' | 'cyan' | 'blue' | 'purple';
  description: string;
  tool_count?: number;
}

export interface PromptAnatomy {
  user_prompt: string;
  total_chars: number;
  total_input_tokens: number;
  bloat_multiplier: number;
  layers: PromptLayer[];
}

export interface AuditRecord {
  id?: number;
  schema_version?: string;
  event_id?: string;
  request_id?: string;
  parent_request_id?: string;
  parent_event_id?: string;
  sequence?: number;
  core_instance_id?: string;
  transport?: string;
  protocol_family?: 'http' | 'websocket' | 'unknown';
  address?: string;
  body_format?: string;
  body_encoding?: string;
  connection_id?: string;
  stream_id?: string;
  response_id?: string;
  previous_response_id?: string;
  attribution?: string;
  response_headers?: Record<string, string>;
  truncated_reason?: string;
  capture_status?: CaptureStatus;
  bytes_wire?: number;
  bytes_captured?: number;
  session_id: string;
  session_id_source?: SessionIdentitySource;
  session_confidence?: SessionConfidence;
  session_namespace?: string;
  thread_id?: string;
  turn_id?: string;
  agent_name: string;
  provider: ProviderType;
  model: string;
  method: string;
  url_path: string;
  status_code: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
  cache_ratio: number;
  system_prompt: string;
  prompt_summary: string;
  user_prompt: string;
  response_preview: string;
  response_text?: string;
  thinking_text?: string;
  is_subagent?: number;
  subagent_type?: string;
  request_headers: Record<string, string>;
  request_body: string;
  response_body: string;
  raw_usage: Record<string, any>;
  token_source?: TokenSource;
  finish_reason?: string;
  confidence?: 'exact' | 'heuristic' | 'unknown';
  tool_calls_json?: string;
  created_at?: string;
  raw_loaded?: boolean;
  raw_pruned?: boolean;
  content_expired?: number;
  bloat?: any;
  anatomy?: PromptAnatomy;
  parsed_question?: import('../shared/protocol').ParsedRequestTurnPayload;
}


export interface SubagentDetail {
  record_id: number;
  subagent_type: string;
  agent_name: string;
  model: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  user_prompt: string;
  response_preview: string;
  response_text: string;
  created_at: string;
  status_code: number;
}

export interface TaskTurn {
  token_source?: 'reported' | 'estimated' | 'unavailable' | 'parse_error';
  model?: string;
  created_at?: string;
  assignment?: import('../shared/attribution').AttributionDecision;
  record_id: number;
  turn_index: number;
  turn_type: 'thought_and_action' | 'final_answer' | 'error';
  status_code: number;
  duration_ms: number;
  input_tokens: number;
  cached_tokens: number;
  thinking_tokens: number;
  output_tokens: number;
  summary: string;
  response_preview: string;
  subagents?: SubagentDetail[];
}

export interface TaskCluster {
  kind?: 'turn' | 'unassigned' | 'auxiliary' | 'connection';
  turn_kind?: 'execution' | 'background';
  lifecycle?: 'unknown';
  native_input_index?: number;
  native_trajectory_id?: string;
  id: string;
  session_id?: string;
  session_id_source?: SessionIdentitySource;
  session_confidence?: SessionConfidence;
  session_namespace?: string;
  thread_id?: string;
  user_prompt: string;
  created_at: string;
  model: string;
  agent_name: string;
  turns: TaskTurn[];
  turns_count: number;
  total_duration_ms: number;
  total_input_tokens: number;
  total_cached_tokens: number;
  total_thinking_tokens: number;
  total_output_tokens: number;
  is_completed: boolean;
  cache_ratio: number;
}

export interface SessionCluster {
  attribution_mode?: 'verified';
  kind?: 'session' | 'pending';
  title?: string;
  parent_session_id?: string;
  id: string;
  session_id: string;
  session_id_source: SessionIdentitySource;
  session_confidence: SessionConfidence;
  session_namespace?: string;
  thread_id?: string;
  agent_name: string;
  model: string;
  created_at: string;
  updated_at: string;
  tasks: TaskCluster[];
  tasks_count: number;
  turns_count: number;
  total_duration_ms: number;
  total_input_tokens: number;
  total_cached_tokens: number;
  total_thinking_tokens: number;
  total_output_tokens: number;
  cache_ratio: number;
}

export interface PaginatedSessions {
  sessions: SessionCluster[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

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

export interface DayModelUsageItem {
  reported_requests: number;
  model: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}
