/**
 * ProxyAdapter Contract
 * Decouples the Electron UI and Lifecycle management from the concrete proxy engine (Go native vs sidecar).
 */

export interface ProxyStatus {
  listenPort: number;
  upstream: string;
  isCoreRunning: boolean;
  status: 'auditing' | 'offline' | 'degraded';
}

export interface ProxyAdapter {
  /**
   * Start the proxy core and wait until ready handshake is received
   */
  start(): Promise<void>;

  /**
   * Graceful drain: stop accepting new requests, allow in-flight events to flush
   */
  drain(timeoutMs?: number): Promise<void>;

  /**
   * Stop the proxy process and close listeners
   */
  stop(): Promise<void> | void;

  /**
   * Query the current runtime status
   */
  getStatus(): ProxyStatus;

  /**
   * Get the callback authentication secret
   */
  getSecret(): string;
}
