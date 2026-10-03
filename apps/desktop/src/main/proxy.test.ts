import { describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, Session as ElectronSession } from 'electron';
import type { ProxySettings } from '../../../../packages/desktop-contract/src/index';
import { ProxySessionManager } from './proxy';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  const pending = Promise.withResolvers<T>();
  return { promise: pending.promise, resolve: pending.resolve };
}

function fakeSession() {
  const setProxy = vi.fn(async (_config: ProxyConfig) => {});
  const closeAllConnections = vi.fn(async () => {});
  return {
    session: { setProxy, closeAllConnections } as unknown as ElectronSession,
    setProxy,
    closeAllConnections
  };
}

const custom: ProxySettings = { mode: 'custom', server: 'HTTPS://Proxy.Example:443/', bypass: '<local>,*.internal' };

describe('Chromium proxy sessions', () => {
  it('drains only OAuth connections after a route change while new component sessions keep their creation route', async () => {
    const defaultSession = fakeSession();
    const updaterSession = fakeSession();
    const oauthSession = fakeSession();
    const componentSession = fakeSession();
    const sessions = [updaterSession, oauthSession, componentSession];
    const manager = new ProxySessionManager({
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => sessions.shift()!.session)
    });

    await manager.configure({ mode: 'system', server: '', bypass: '' });
    await manager.createSession('memory:oauth');
    await manager.configure(custom);
    await manager.configure({ ...custom });
    await manager.createComponentSession('memory:component');
    await manager.configure({ mode: 'direct', server: '', bypass: '' });
    manager.release(oauthSession.session);
    await manager.configure({ mode: 'system', server: '', bypass: '' });

    expect(oauthSession.setProxy.mock.calls.map(([config]) => config)).toEqual([
      { mode: 'system' },
      { mode: 'fixed_servers', proxyRules: 'https://proxy.example:443', proxyBypassRules: '<local>,*.internal' },
      { mode: 'direct' }
    ]);
    expect(oauthSession.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(componentSession.setProxy).toHaveBeenCalledTimes(1);
    expect(componentSession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers', proxyRules: 'https://proxy.example:443', proxyBypassRules: '<local>,*.internal'
    });
    expect(componentSession.closeAllConnections).not.toHaveBeenCalled();
    expect(defaultSession.setProxy).toHaveBeenLastCalledWith({ mode: 'system' });
    expect(updaterSession.setProxy).toHaveBeenLastCalledWith({ mode: 'system' });
  });

  it('serializes creation behind an in-flight setting change and retains the last complete configuration after failure', async () => {
    const defaultSession = fakeSession();
    const updaterSession = fakeSession();
    const oauthSession = fakeSession();
    const componentSession = fakeSession();
    const delayedSetProxy = deferred<void>();
    defaultSession.setProxy.mockImplementationOnce(() => delayedSetProxy.promise);
    const sessions = [updaterSession, oauthSession, componentSession];
    const manager = new ProxySessionManager({
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => sessions.shift()!.session)
    });

    const changing = manager.configure({ mode: 'direct', server: '', bypass: '' });
    const creating = manager.createSession('memory:oauth');
    expect(oauthSession.setProxy).not.toHaveBeenCalled();
    delayedSetProxy.resolve();
    await changing;
    await creating;
    expect(oauthSession.setProxy).toHaveBeenCalledTimes(1);
    expect(oauthSession.setProxy).toHaveBeenCalledWith({ mode: 'direct' });

    defaultSession.setProxy.mockRejectedValueOnce(new Error('proxy service unavailable'));
    await expect(manager.configure(custom)).rejects.toThrow('proxy service unavailable');
    await manager.createComponentSession('memory:component');
    expect(componentSession.setProxy).toHaveBeenCalledTimes(1);
    expect(componentSession.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
  });
});
