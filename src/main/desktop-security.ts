import type { IpcMainInvokeEvent } from 'electron';

export function secureWebContents(contents: Electron.WebContents, origin: string): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventUntrusted = (event: Electron.Event, target: string) => { if (!isTrustedPage(target, origin)) event.preventDefault(); };
  contents.on('will-navigate', preventUntrusted);
  contents.on('will-redirect', preventUntrusted);
  const allowed = (sender: Electron.WebContents | null, permission: string, details: { isMainFrame: boolean; requestingUrl?: string }) =>
    permission === 'clipboard-sanitized-write' && sender?.id === contents.id && details.isMainFrame && isTrustedPage(details.requestingUrl || '', origin);
  contents.session.setPermissionRequestHandler((sender, permission, callback, details) => callback(allowed(sender, permission, details)));
  contents.session.setPermissionCheckHandler((sender, permission, _origin, details) => allowed(sender, permission, details));
}

export function isTrustedPage(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === '/' && !url.username && !url.password;
  } catch { return false; }
}

export function assertTrustedSender(event: IpcMainInvokeEvent, webContentsId: number | undefined, origin: string): void {
  const frame = event.senderFrame;
  if (webContentsId === undefined || event.sender.id !== webContentsId || !frame ||
      frame !== event.sender.mainFrame || !isTrustedPage(frame.url, origin)) {
    throw new Error('Untrusted IPC sender');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const options = (v: unknown, fields: Record<string, (v: unknown) => boolean>): boolean => v === undefined ||
  (record(v) && Object.entries(v).every(([key, value]) => key in fields && (value === undefined || fields[key](value))));

/** Validate the bridge contract before any privileged handler is invoked. */
export function assertIpcArguments(channel: string, args: unknown[]): void {
  const noArgs = new Set(['api:get-stats', 'api:clear-records', 'api:install-cert', 'api:get-cert-status',
    'api:get-diagnostics', 'api:sanitize-history', 'api:get-config', 'api:reveal-db-folder',
    'api:get-db-info', 'api:compact-database', 'api:reset-usage', 'api:delete-all-data']);
  let valid = false;
  if (noArgs.has(channel)) valid = args.every(v => v === undefined);
  else if (['api:get-record-history', 'api:get-record-detail', 'api:export-fixture'].includes(channel)) valid = args.length === 1 && integer(args[0], 1);
  else if (channel === 'api:copy-text') valid = args.length === 1 && text(args[0], 16 * 1024 * 1024);
  else if (channel === 'api:get-daily-token-activity') valid = args.length <= 1 && (args[0] === undefined || text(args[0], 128));
  else if (['api:get-day-model-usage', 'api:get-day-token-details'].includes(channel)) {
    valid = args.length === 1 && record(args[0]) && text(args[0].date) && /^\d{4}-\d{2}-\d{2}$/.test(args[0].date) &&
      options(args[0], { date: v => text(v), agentCategory: v => text(v, 128) });
  } else if (channel === 'api:get-sessions') valid = args.length <= 1 && options(args[0], { limit: v => integer(v, 1, 1000), offset: v => integer(v) });
  else if (channel === 'api:get-records') valid = args.length <= 1 && options(args[0], {
    limit: v => integer(v, 1, 1000), offset: v => integer(v), sessionId: v => text(v), search: v => text(v), filterType: v => text(v, 128), agentName: v => text(v, 128)
  });
  else if (channel === 'api:get-records-by-ids') valid = args.length <= 2 && Array.isArray(args[0]) && args[0].length <= 10000 && args[0].every(v => integer(v, 1)) &&
    options(args[1], { includeRawBody: v => typeof v === 'boolean', lightweight: v => typeof v === 'boolean' });
  else if (channel === 'api:save-config') valid = args.length === 1 && record(args[0]); // ConfigManager validates the full schema.
  else if (channel === 'api:test-upstream') valid = args.length === 1 && record(args[0]) && options(args[0], { upstreamUrl: v => text(v, 2048) });
  else if (channel === 'api:confirm-agent-restart') valid = args.length === 1 && record(args[0]) &&
    options(args[0], { requestId: v => text(v, 36), confirmed: v => typeof v === 'boolean' }) &&
    typeof args[0].requestId === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(args[0].requestId) && typeof args[0].confirmed === 'boolean';
  else if (['api:launch-agent', 'api:check-agent'].includes(channel)) valid = args.length === 1 && record(args[0]) &&
    options(args[0], { agent: v => text(v) }) && ['antigravity', 'workbuddy', 'cursor', 'pi', 'codex', 'codex_app', 'codex_cli', 'claude', 'terminal'].includes(String(args[0].agent));
  if (!valid) throw new TypeError('Invalid IPC arguments');
}
