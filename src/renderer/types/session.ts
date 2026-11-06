export type { AgentCategory } from '../../shared/agent';

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
  assignment?: import('../../shared/attribution').AttributionDecision;
  turn_index: number;
  record_id: number;
  turn_type?: 'thought_and_action' | 'final_answer' | 'error';
  status_code?: number;
  duration_ms?: number;
  input_tokens?: number;
  cached_tokens?: number;
  cache_ratio?: number;
  thinking_tokens?: number;
  output_tokens?: number;
  summary?: string;
  response_preview?: string;
  subagents?: SubagentDetail[];
}

export interface Session {
  kind?: 'turn' | 'unassigned' | 'auxiliary' | 'connection';
  turn_kind?: 'execution' | 'background';
  lifecycle?: 'unknown';
  native_input_index?: number;
  native_trajectory_id?: string;
  id: string;
  session_id?: string;
  session_id_source?: 'conversation_id' | 'thread_id' | 'session_id' | 'codex_metadata' | 'header' | 'heuristic' | 'unknown' | 'legacy';
  session_confidence?: 'exact' | 'heuristic' | 'unknown';
  session_namespace?: string;
  thread_id?: string;
  agent_name: string;
  model: string;
  user_prompt: string;
  turns_count: number;
  total_duration_ms: number;
  total_input_tokens: number;
  total_cached_tokens: number;
  cache_ratio: number;
  total_thinking_tokens: number;
  total_output_tokens: number;
  created_at: string;
  turns: TaskTurn[];
}

export interface SessionCluster {
  attribution_mode?: 'verified';
  kind?: 'session' | 'pending' | 'auxiliary' | 'connection';
  title?: string;
  parent_session_id?: string;
  id: string;
  session_id: string;
  session_id_source?: Session['session_id_source'];
  session_confidence?: Session['session_confidence'];
  session_namespace?: string;
  thread_id?: string;
  agent_name: string;
  model: string;
  created_at: string;
  updated_at: string;
  tasks: Session[];
  tasks_count: number;
  turns_count: number;
  total_duration_ms: number;
  total_input_tokens: number;
  total_cached_tokens: number;
  total_thinking_tokens: number;
  total_output_tokens: number;
  cache_ratio: number;
}

export interface AnatomyLayer {
  id: string;
  name: string;
  chars: number;
  percentage: number;
  badge_color: 'emerald' | 'amber' | 'cyan' | 'blue' | 'purple' | string;
  description?: string;
  content?: string;
}

export interface RecordDetail {
  token_source?: TaskTurn['token_source'];
  id: number;
  session_id?: string;
  session_id_source?: Session['session_id_source'];
  session_confidence?: Session['session_confidence'];
  session_namespace?: string;
  thread_id?: string;
  turn_id?: string;
  parent_request_id?: string;
  parent_event_id?: string;
  agent_name?: string;
  model?: string;
  user_prompt?: string;
  prompt_summary?: string;
  duration_ms?: number;
  status_code?: number;
  input_tokens?: number;
  cached_tokens?: number;
  cache_ratio?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  request_headers?: Record<string, any>;
  request_body?: string;
  response_body?: string;
  response_preview?: string;
  response_text?: string;
  thinking_text?: string;
  is_subagent?: number;
  subagent_type?: string;
  confidence?: 'exact' | 'heuristic' | 'unknown';
  tool_calls_json?: string;
  created_at?: string;
  related_history?: import('../../shared/history').RelatedHistory;
  history_loading?: boolean;
  raw_loaded?: boolean;
  raw_pruned?: boolean;
  content_expired?: number;
  raw_loading?: boolean;
  raw_load_error?: string | null;
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
  capture_status?: string;
  anatomy?: {
    total_chars?: number;
    bloat_multiplier?: number;
    user_prompt?: string;
    layers: AnatomyLayer[];
  };
  parsed_question?: import('../../shared/protocol').ParsedRequestTurnPayload;
}

export interface ToolCallItem {
  id?: string;
  name: string;
  args: any;
}

export interface ToolResultItem {
  name: string;
  output: string;
}

export interface HistoricalMessage {
  role: string;
  text: string;
}

export interface TurnQuestion {
  isContextUpdate?: boolean;
  contextTools?: Array<{ type?: string; name?: string; tools?: unknown[]; [key: string]: unknown }>;
  isUser: boolean;
  roleLabel: string;
  title: string;
  newText: string;
  toolResults: ToolResultItem[];
  historyCount: number;
  historyMessages: HistoricalMessage[];
}

export interface TurnAnswer {
  model: string;
  thinkingText: string;
  toolCalls: ToolCallItem[];
  responseText: string;
  subagents?: SubagentDetail[];
}

export interface ChatTimelineTurn {
  toolLink?: Extract<import('../../shared/attribution').ToolLink, {status: 'resolved'}>['value'];
  tokenSource?: TaskTurn['token_source'];
  turnIndex: number;
  recordId: number;
  statusCode: number;
  connectionIssue?: import('../../shared/attribution').ConnectionIssue;
  purpose?: import('../../shared/attribution').RequestPurpose;
  captureStatus?: string;
  duration_ms: number;
  inputTokens: number;
  cachedTokens: number;
  cacheRatio: number;
  thinkingTokens?: number;
  outputTokens: number;
  relatedHistory?: import('../../shared/history').RelatedHistory;
  previousResponseId?: string;
  historyLoading?: boolean;
  bodyFormat?: string;
  rawHeaders: Record<string, any>;
  rawRequestBody: string;
  rawResponseBody: string;
  rawLoaded?: boolean;
  readableLoaded?: boolean;
  rawPruned?: boolean;
  contentExpired?: boolean;
  rawLoading?: boolean;
  rawLoadError?: string | null;
  question: TurnQuestion;
  answer: TurnAnswer;
}
