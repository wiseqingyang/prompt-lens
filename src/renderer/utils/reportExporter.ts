import { sanitizeText } from './sanitizer';
import type { RecordDetail, Session } from '../types';
import { formatDateTime, formatNum } from './formatters';

export function generateMarkdownReport(session: Session | null, record: RecordDetail | null): string {
  if (!session && !record) return '';

  const s = session || {
    id: '',
    user_prompt: record?.user_prompt || record?.prompt_summary || '',
    agent_name: record?.agent_name || 'Agent',
    model: record?.model || 'unknown',
    turns_count: 1,
    total_duration_ms: record?.duration_ms || 0,
    total_input_tokens: record?.input_tokens || 0,
    total_cached_tokens: record?.cached_tokens || 0,
    cache_ratio: record?.cache_ratio || 0,
    total_thinking_tokens: record?.thinking_tokens || 0,
    total_output_tokens: record?.output_tokens || 0,
    created_at: record?.created_at || '',
    turns: []
  };

  const rec = record || ({} as RecordDetail);
  const anatomy = rec.anatomy || { layers: [] };
  const layers = anatomy.layers || [];

  let md = `# 🤖 Agent 交互复盘与学习报告\n\n`;
  const captureTime = formatDateTime(rec.created_at || s.created_at) || '最近';
  md += `> 来源：PromptLens · 捕获时间：${captureTime}\n\n`;
  md += `## 📌 会话执行概览\n`;
  md += `- **用户原始指令**: \`${s.user_prompt}\`\n`;
  md += `- **目标 Agent / 模型**: ${s.agent_name || rec.agent_name} (${s.model || rec.model})\n`;
  md += `- **交互轮次**: ${s.turns_count} 轮交互\n`;
  md += `- **累计耗时**: ${(s.total_duration_ms / 1000).toFixed(1)} 秒\n`;
  md += `- **已报告 Token 用量**: 总输入 ${formatNum(s.total_input_tokens)} tok (平均缓存命中率 ${s.cache_ratio}%) · 思考 ${formatNum(s.total_thinking_tokens)} tok · 产出 ${formatNum(s.total_output_tokens)} tok\n\n`;

  md += `## 🧬 1. Prompt 结构解析 (Prompt Anatomy)\n`;
  md += `- **上下文膨胀倍数**: **${formatNum(anatomy.bloat_multiplier || 1)}x** (用户输入 ${layers[0]?.chars || 0} 字符 ➡️ 最终组装 ${formatNum(anatomy.total_chars || 0)} 字符)\n\n`;
  md += `| 图层名称 | 字符数 | 占比 | 作用与机制说明 |\n`;
  md += `|---|---|---|---|\n`;
  layers.forEach((l: any) => {
    md += `| **${l.name}** | ${formatNum(l.chars)} | ${l.percentage}% | ${l.description || '-'} |\n`;
  });
  md += `\n`;

  md += `## 🔄 2. 会话多轮执行时序链路\n\n`;
  md += `| 轮次 | 角色/类型 | 耗时 | 输入 / 缓存 Tokens | 思考 Tokens | 输出 Tokens | 动作 / LLM 反馈 |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  (s.turns || []).forEach((turn: any) => {
    const typeLabel = turn.turn_type === 'thought_and_action' ? '🛠️ 思考+调工具' : (turn.turn_type === 'final_answer' ? '🏁 最终呈现' : '⚠️ 异常');
    const usageAvailable = turn.token_source === 'reported';
    const resp = (turn.response_preview || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    md += `| **T${turn.turn_index}** | ${typeLabel} | ${(turn.duration_ms / 1000).toFixed(1)}s | ${usageAvailable ? formatNum(turn.input_tokens) + ' (缓 ' + formatNum(turn.cached_tokens) + ')' : '用量不可用'} | ${turn.thinking_tokens > 0 ? '🧠 ' + formatNum(turn.thinking_tokens) : '-'} | ${usageAvailable ? formatNum(turn.output_tokens) : '用量不可用'} | \`${resp.slice(0, 80)}\` |\n`;
  });

  return sanitizeText(md);
}
