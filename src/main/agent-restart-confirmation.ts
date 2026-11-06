import { randomUUID } from 'crypto';
import type { WebContents } from 'electron';
import type { AgentRestartRequest } from '../shared/agentRestart';

/** Keep the pending process snapshot in its original launch call, bound to its window. */
export class AgentRestartConfirmations {
  private pending = new Map<string, { senderId: number; finish: (confirmed: boolean) => void }>();

  constructor(private timeoutMs = 120_000) {}

  request(sender: WebContents, details: Omit<AgentRestartRequest, 'requestId'>): Promise<boolean> {
    if (sender.isDestroyed()) return Promise.resolve(false);
    return new Promise(resolve => {
      const requestId = randomUUID();
      const cancel = () => finish(false);
      const finish = (confirmed: boolean) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        sender.removeListener('destroyed', cancel);
        sender.removeListener('did-start-navigation', cancel);
        resolve(confirmed);
      };
      const timer = setTimeout(cancel, this.timeoutMs);
      timer.unref();
      this.pending.set(requestId, { senderId: sender.id, finish });
      sender.once('destroyed', cancel);
      sender.once('did-start-navigation', cancel);
      try { sender.send('agent:restart-confirmation', { ...details, requestId }); }
      catch { finish(false); }
    });
  }

  respond(senderId: number, requestId: string, confirmed: boolean): boolean {
    const request = this.pending.get(requestId);
    if (!request || request.senderId !== senderId) return false;
    request.finish(confirmed);
    return true;
  }

  cancelFor(senderId: number): void {
    for (const request of this.pending.values()) if (request.senderId === senderId) request.finish(false);
  }
}
