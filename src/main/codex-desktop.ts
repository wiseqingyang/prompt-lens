import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

export interface DesktopProcess {
  pid: number;
  ppid: number;
  uid: number;
  startedAt: string;
  executable: string;
}

interface ProcessOperations {
  selfPid: number;
  uid: number;
  resolveAppPath: (appPath: string) => string;
  readProcesses: () => Promise<DesktopProcess[]>;
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  pause: () => Promise<void>;
}

type LaunchResult = { success: boolean; message: string };
const execute = promisify(execFile);
const pendingLaunches = new Set<string>();

/** comm contains the executable path, never command-line arguments. */
export function parseDesktopProcesses(output: string): DesktopProcess[] {
  return output.split('\n').filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) throw new Error('无法解析进程信息，请稍后重试。');
    return {
      pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]),
      startedAt: match[4].replace(/\s+/g, ' '), executable: match[5].trim()
    };
  });
}

const systemOperations: ProcessOperations = {
  selfPid: process.pid,
  uid: process.getuid?.() ?? -1,
  resolveAppPath: appPath => fs.realpathSync(appPath),
  readProcesses: async () => {
    const { stdout } = await execute('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,lstart=,comm='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }
    });
    return parseDesktopProcesses(stdout);
  },
  signal: (pid, signal) => { process.kill(pid, signal); },
  pause: () => new Promise(resolve => setTimeout(resolve, 100))
};

function relatedProcesses(processes: DesktopProcess[], appPath: string): DesktopProcess[] {
  const pids = new Set(processes.filter(p => p.executable.startsWith(`${appPath}/Contents/`)).map(p => p.pid));
  let added: boolean;
  do {
    added = false;
    for (const p of processes) {
      if (pids.has(p.ppid) && !pids.has(p.pid)) { pids.add(p.pid); added = true; }
    }
  } while (added);
  return processes.filter(p => pids.has(p.pid));
}

function sameProcess(a: DesktopProcess, b: DesktopProcess): boolean {
  return a.pid === b.pid && a.uid === b.uid && a.startedAt === b.startedAt && a.executable === b.executable;
}

/** Confirmation, termination and launch stay in the main process; no PID is accepted from IPC. */
export async function launchCodexDesktop(
  selectedAppPath: string,
  confirmRestart: (processCount: number) => Promise<boolean>,
  launch: () => LaunchResult | Promise<LaunchResult>,
  operations: ProcessOperations = systemOperations
): Promise<LaunchResult> {
  let lockedPath: string | undefined;
  const appLabel = path.basename(selectedAppPath, '.app') || '目标应用';
  try {
    const appPath = operations.resolveAppPath(selectedAppPath);
    if (pendingLaunches.has(appPath)) return { success: false, message: `${appLabel} 正在启动，请稍候。` };
    pendingLaunches.add(appPath);
    lockedPath = appPath;
    const snapshot = await operations.readProcesses();
    const targets = relatedProcesses(snapshot, appPath);
    if (targets.length) {
      const protectedPids = new Set<number>([operations.selfPid]);
      let parent = snapshot.find(p => p.pid === operations.selfPid)?.ppid;
      while (parent && !protectedPids.has(parent)) {
        protectedPids.add(parent);
        parent = snapshot.find(p => p.pid === parent)?.ppid;
      }
      if (targets.some(p => p.uid !== operations.uid || protectedPids.has(p.pid))) {
        return { success: false, message: '进程属于其他用户或当前运行链路，请手动退出后重试。' };
      }
      if (!await confirmRestart(targets.length)) return { success: false, message: '已取消启动。' };

      const remaining = async () => {
        const fresh = await operations.readProcesses();
        return targets.filter(target => fresh.some(p => sameProcess(target, p)));
      };
      const signalConfirmed = async (signal: 'SIGTERM' | 'SIGKILL') => {
        for (const target of targets) {
          // Recheck PID, birth time and executable immediately before each signal.
          if (!(await remaining()).some(p => p.pid === target.pid)) continue;
          try { operations.signal(target.pid, signal); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
      };
      const waitForExit = async (attempts: number) => {
        for (let i = 0; i < attempts; i++) {
          if (!(await remaining()).length) return;
          await operations.pause();
        }
      };
      await signalConfirmed('SIGTERM');
      await waitForExit(20);
      if ((await remaining()).length) {
        await signalConfirmed('SIGKILL');
        await waitForExit(10);
      }
      if ((await remaining()).length) return { success: false, message: `${appLabel} 进程未能退出，请手动退出后重试。` };
    }
    // Catch a helper/main process that appeared while the confirmation was open,
    // including a reused PID. A new identity requires a new user decision.
    if (relatedProcesses(await operations.readProcesses(), appPath).length) {
      return { success: false, message: `${appLabel} 仍有运行进程，请重新点击启动或手动退出。` };
    }
    return await launch();
  } catch (error) {
    return { success: false, message: `启动 ${appLabel} 失败：${(error as Error).message}` };
  } finally {
    if (lockedPath) pendingLaunches.delete(lockedPath);
  }
}
