export const UNRECOGNIZED_NAME = '未识别名称';

export const auxiliaryPurposeLabels = {
  conversation_title: '标题生成',
  terminal_input_check: '终端输入等待检测',
  web_search: '网页搜索',
  web_content_analysis: '网页内容分析',
  prewarm: '预热',
  memory: '后台记忆任务',
  context_compaction: '上下文压缩'
} as const;

export const connectionIssueLabels = {
  usage_limit: '额度耗尽',
  connection_limit: '连接时长达到上限',
  server_error: '服务端错误'
} as const;

export interface ConnectionIssue {
  kind: keyof typeof connectionIssueLabels;
  ruleVersion: '1';
  statusCode: 429 | 400 | 503;
  evidence: string[];
}

export type RequestPurpose = {
  kind: keyof typeof auxiliaryPurposeLabels;
  evidence: string[];
} & ({ templateId: string; ruleId?: never } | { ruleId: string; templateId?: never });

export type AttributionReason = 'missing_response' | 'response_conflict' | 'agent_identity_unconfirmed' | 'missing_session' | 'session_conflict' | 'missing_position'
  | 'position_conflict' | 'source_disabled' | 'source_missing' | 'source_invalid'
  | 'source_changed' | 'source_limit' | 'trajectory_mismatch' | 'source_incomplete'
  | 'no_user_input' | 'content_unavailable' | 'adapter_conflict'
  | 'tool_link_conflict' | 'missing_turn' | 'turn_conflict' | 'invalid_metadata' | 'unsupported_version' | 'unsupported_format' | 'unknown_protocol' | 'connection_only' | 'prewarm';

export type Resolution<T> =
  | { status: 'resolved'; value: T; evidence: string[] }
  | { status: 'unresolved'; reason: AttributionReason; evidence: string[] }
  | { status: 'conflict'; reason: AttributionReason; candidates: T[]; evidence: string[] };

export type TurnIdentity = { id: string; title?: string } & (
  { inputIndex: number; trajectoryId: string } |
  { inputIndex?: never; trajectoryId?: never }
);

export type ToolLink = Resolution<{
  ruleVersion: '1'; sessionId: string; turn: TurnIdentity; parentRecordId: number;
  callId: string; resultHash: string; consumerRecordIds: number[];
}>;

export interface AttributionDecision {
  identitySource?: 'codex_metadata' | 'pi_native' | 'workbuddy_metadata';
  /** Product grouping policy; does not replace the native turn evidence below. */
  turnGrouping?: 'observed_inputs';
  /** Auxiliary execution IDs do not open or switch the active product turn. */
  turnBehavior?: 'continue';
  toolLink?: ToolLink;
  agentId: string;
  ruleVersion: string;
  session: Resolution<string>;
  turn: Resolution<TurnIdentity>;
  purpose?: RequestPurpose;
  connectionIssue?: ConnectionIssue;
  parentSessionId?: string;
  protocol?: import('./captureProtocol').ProtocolEvidence;
  turnKind?: 'execution' | 'background';
  lifecycle?: 'unknown';
}

export const attributionReasonText: Record<AttributionReason, string> = {
  missing_response: '缺少响应标识', response_conflict: '响应标识冲突', agent_identity_unconfirmed: 'Agent 身份依据不足',
  tool_link_conflict: '工具结果关联存在冲突',
  missing_turn: '缺少有效轮次标识', turn_conflict: '轮次标识冲突', invalid_metadata: '身份数据无效',
  unsupported_version: '尚未核验来源版本', unsupported_format: '尚未支持捕获格式', unknown_protocol: '协议依据不足',
  connection_only: '连接级记录', prewarm: '连接预热',
  missing_session: '缺少有效会话标识', session_conflict: '会话标识冲突',
  missing_position: '缺少请求的原生步骤位置', position_conflict: '原生步骤位置冲突',
  source_disabled: '未配置原生日志目录', source_missing: '原生日志不可用',
  source_invalid: '原生日志格式无效', source_changed: '原生轨迹已改写或读取中变化',
  source_limit: '原生日志超出读取上限', trajectory_mismatch: '原生轨迹标识不匹配',
  source_incomplete: '原生步骤尚不完整', no_user_input: '没有明确的用户输入步骤',
  content_unavailable: '原始请求内容不可用', adapter_conflict: '多个适配器匹配，无法确认规则'
};
