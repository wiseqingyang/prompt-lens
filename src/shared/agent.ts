export type AgentCategory = 'Codex' | 'Antigravity' | 'Pi' | 'WorkBuddy' | 'Other';

/** Shared product access catalog and registered attribution adapters. */
export const AgentList = [
  { key: 'antigravity', name: 'Antigravity', appName: 'Antigravity IDE', adapterId: 'antigravity', launchable: true },
  { key: 'codex_app', name: 'Codex 桌面端', appName: 'Codex 桌面端', adapterId: 'codex', launchable: true },
  { key: 'codex_cli', name: 'Codex CLI', appName: 'Codex CLI', adapterId: 'codex', launchable: true },
  { key: 'pi', name: 'Pi Agent', appName: 'Pi Agent', adapterId: 'pi', launchable: true },
  { key: 'workbuddy', name: 'WorkBuddy', appName: 'WorkBuddy', adapterId: 'workbuddy', launchable: true },
  { key: 'terminal', name: '通用终端', launchable: false },
] as const;

export type AgentAccess = typeof AgentList[number];
export type AgentAppKey = AgentAccess['key'];
export type LaunchableAgent = Extract<AgentAccess, { launchable: true }>;
export type LaunchableAgentKey = LaunchableAgent['key'];
export const launchableAgents = AgentList.filter((agent): agent is LaunchableAgent => agent.launchable);

/** Keep Agent grouping identical in the main process and renderer. */
export function getAgentCategory(agentName?: string | null): AgentCategory {
  const name = String(agentName || '').toLowerCase().trim();
  if (/^workbuddy(?:$|[\s(/-])/.test(name)) return 'WorkBuddy';
  if (name.includes('codex')) return 'Codex';
  if (name.includes('antigravity')) return 'Antigravity';
  if (/^pi(?:$|[\s(/-])/.test(name) || name.includes('@earendil-works/pi')) return 'Pi';
  return 'Other';
}
