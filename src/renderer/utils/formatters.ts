import type { Session } from '../types';
import { getAgentCategory } from '../../shared/agent';

export const formatNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
};

export const formatTokens = (n: number | null | undefined): string => {
  if (!n) return '0';
  if (n >= 1000000) {
    const val = (n / 1000000).toFixed(1);
    return (val.endsWith('.0') ? val.slice(0, -2) : val) + 'M';
  }
  if (n >= 1000) {
    const val = (n / 1000).toFixed(1);
    return (val.endsWith('.0') ? val.slice(0, -2) : val) + 'k';
  }
  return n.toString();
};

export const parseDateTime = (ts: string | null | undefined): Date | null => {
  if (!ts) return null;
  const str = String(ts).trim();
  if (!str) return null;
  // SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" (stored in UTC without Z)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) {
    const isoStr = str.replace(' ', 'T') + 'Z';
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
};

export const formatTime = (ts: string | null | undefined): string => {
  const d = parseDateTime(ts);
  if (!d) return '';
  return d.toTimeString().split(' ')[0];
};

export const formatDateTime = (ts: string | null | undefined): string => {
  const d = parseDateTime(ts);
  if (!d) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const time = d.toTimeString().split(' ')[0];
  return `${year}-${month}-${day} ${time}`;
};

export const agentBadgeClass = (agent: string): string => {
  const a = getAgentCategory(agent);
  if (a === 'Antigravity') return 'bg-blue-50 dark:bg-blue-950/80 text-blue-700 dark:text-sky-300 border border-blue-200 dark:border-blue-600/50';
  if (a === 'Codex') return 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-600/50';
  if (a === 'WorkBuddy') return 'bg-violet-50 dark:bg-violet-950/80 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-600/50';
  if (a === 'Pi') return 'bg-orange-50 dark:bg-orange-950/80 text-[#e07a6c] dark:text-[#f3a497] border border-orange-200 dark:border-orange-600/50';
  return 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700/60';
};

export const layerBarColor = (color: string): string => {
  switch (color) {
    case 'emerald': return 'bg-emerald-400';
    case 'amber': return 'bg-amber-400';
    case 'cyan': return 'bg-cyan-400';
    case 'blue': return 'bg-blue-400';
    case 'purple': return 'bg-purple-400';
    default: return 'bg-slate-400';
  }
};

export const layerDotColor = (color: string): string => {
  switch (color) {
    case 'emerald': return 'bg-emerald-400';
    case 'amber': return 'bg-amber-400';
    case 'cyan': return 'bg-cyan-400';
    case 'blue': return 'bg-blue-400';
    case 'purple': return 'bg-purple-400';
    default: return 'bg-slate-400';
  }
};

const prettyCache = new Map<string, string>();
const MAX_PRETTY_CACHE = 50;
const MAX_CACHEABLE_CHARS = 32 * 1024; // 仅对 <= 32KB 的适中报文缓存，超大报文不进长期静态缓存

export const prettyJson = (val: any): string => {
  if (val === undefined || val === null || val === '') return '';
  if (typeof val === 'string') {
    if (val.length > 1024 && val.length <= MAX_CACHEABLE_CHARS) {
      const cached = prettyCache.get(val);
      if (cached) return cached;
      try {
        const parsed = JSON.parse(val);
        const res = typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed, null, 2) : val;
        if (prettyCache.size >= MAX_PRETTY_CACHE) {
          const firstKey = prettyCache.keys().next().value;
          if (firstKey) prettyCache.delete(firstKey);
        }
        prettyCache.set(val, res);
        return res;
      } catch {
        return val;
      }
    }
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify(parsed, null, 2);
      }
      return val;
    } catch {
      return val;
    }
  }
  if (typeof val === 'object') {
    if (Object.keys(val).length === 1 && typeof val.raw === 'string') {
      try {
        const parsed = JSON.parse(val.raw);
        if (typeof parsed === 'object' && parsed !== null) {
          return JSON.stringify(parsed, null, 2);
        }
      } catch {}
      return val.raw;
    }
    return JSON.stringify(val, null, 2);
  }
  return String(val);
};

export { getAgentCategory };

export const hasActionTurn = (session: Session): boolean => {
  return session.turns?.some((turn) => turn.turn_type === 'thought_and_action') || false;
};
