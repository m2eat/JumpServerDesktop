import type { ProxyConfig, Session as ElectronSession } from 'electron';
import type { ProxySettings } from '../../../../packages/desktop-contract/src/index';
import { proxySettingsSchema } from '../../../../packages/desktop-contract/src/preferences';

const UPDATER_SESSION_PARTITION = 'electron-updater';

export interface ProxySessionSource {
  defaultSession: ElectronSession;
  fromPartition(partition: string, options: { cache: boolean }): ElectronSession;
}

function proxyRule(server: string): string {
  const url = new URL(server);
  // Validation requires an explicit port; URL.port erases :80 and :443.
  const port = /:([0-9]+)\/?$/.exec(server)![1];
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}:${port}`;
}

export function electronProxyConfig(proxy: ProxySettings): ProxyConfig {
  proxy = proxySettingsSchema.parse(proxy);
  switch (proxy.mode) {
    case 'system':
      return { mode: 'system' };
    case 'direct':
      return { mode: 'direct' };
    case 'custom':
      return {
        mode: 'fixed_servers',
        proxyRules: proxyRule(proxy.server),
        ...(proxy.bypass ? { proxyBypassRules: proxy.bypass } : {})
      };
  }
}

/**
 * Serializes proxy changes before callers create network sessions.
 *
 * Active OAuth sessions are deliberately drained after a successful change so
 * Core cannot reuse an HTTP connection that was opened under the old route.
 * Component sessions are configured at creation only and retain their route
 * until their owner reconnects.
 */
export class ProxySessionManager {
  private current: ProxyConfig = { mode: 'system' };
  private initialized = false;
  private operations: Promise<void> = Promise.resolve();
  private readonly configuredSessions = new Set<ElectronSession>();
  private readonly oauthSessions = new Set<ElectronSession>();

  constructor(private readonly source: ProxySessionSource) {
    this.configuredSessions.add(source.defaultSession);
    // electron-updater creates this exact in-memory Session for its HTTP requests.
    this.configuredSessions.add(source.fromPartition(UPDATER_SESSION_PARTITION, { cache: false }));
  }

  configure(proxy: ProxySettings): Promise<void> {
    const config = electronProxyConfig(proxy);
    return this.enqueue(async () => {
      const previous = this.current;
      if (this.initialized && config.mode === previous.mode && config.proxyRules === previous.proxyRules && config.proxyBypassRules === previous.proxyBypassRules) return;
      try {
        const applied = await Promise.allSettled([...this.configuredSessions].map((network) => network.setProxy(config)));
        const failure = applied.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        await Promise.all([...this.oauthSessions].map((network) => network.closeAllConnections()));
        this.current = config;
        this.initialized = true;
      } catch (cause) {
        await Promise.allSettled([...this.configuredSessions].map((network) => network.setProxy(previous)));
        throw cause;
      }
    });
  }

  createSession(partition: string): Promise<ElectronSession> {
    return this.createTrackedSession(partition, true);
  }

  createComponentSession(partition: string): Promise<ElectronSession> {
    return this.createTrackedSession(partition, false);
  }

  release(network: ElectronSession): void {
    this.oauthSessions.delete(network);
    this.configuredSessions.delete(network);
  }

  private createTrackedSession(partition: string, followsChanges: boolean): Promise<ElectronSession> {
    const network = this.source.fromPartition(partition, { cache: false });
    return this.enqueue(async () => {
      await network.setProxy(this.current);
      if (followsChanges) {
        this.oauthSessions.add(network);
        this.configuredSessions.add(network);
      }
      return network;
    });
  }

  ready(): Promise<void> {
    return this.operations;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.operations.then(operation, operation);
    this.operations = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }
}
