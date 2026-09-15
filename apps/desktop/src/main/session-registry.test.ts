import { describe, expect, it, vi } from 'vitest';
import type { AppEvent, SessionInfo, TransferTask } from '../../../../packages/desktop-contract/src/index';
import { SessionRegistry } from './session-registry';

const session: SessionInfo = {
  id: 'files', generation: 1, kind: 'files', phase: 'active', detached: false, capabilities: {},
  context: { siteId: 'site', userId: 'user', orgId: 'org', assetId: 'asset', assetName: 'host', address: 'host.test', accountId: 'account', accountName: 'operator', protocol: 'sftp', connectMethod: { value: 'sftp_client', component: 'koko', type: 'native' } }
};
const task: TransferTask = { id: 'upload', sessionId: 'files', name: 'notes.txt', direction: 'upload', phase: 'transferring', transferred: 4 };

describe('background file workspace ownership', () => {
  it('retains the connection until every detached transfer has a final outcome', async () => {
    const events: AppEvent[] = [];
    const close = vi.fn(async (value: SessionInfo) => { registry.accept({ type: 'session', session: { ...value, phase: 'closed' } }); });
    const registry = new SessionRegistry(close, event => events.push(event));
    registry.accept({ type: 'session', session });
    registry.accept({ type: 'task', task });
    registry.accept({ type: 'task', task: { ...task, id: 'queued', phase: 'queued' } });
    await registry.detach(session.id);
    expect(close).not.toHaveBeenCalled();
    registry.accept({ type: 'task', task: { ...task, phase: 'completed' } });
    expect(close).not.toHaveBeenCalled();
    registry.accept({ type: 'task', task: { ...task, id: 'queued', phase: 'unknown' } });
    await vi.waitFor(() => expect(registry.get(session.id)).toBeUndefined());
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.listTasks().find(value => value.id === 'queued')?.phase).toBe('unknown');
    expect(events.some(event => event.type === 'session' && event.session.phase === 'closed' && event.session.detached)).toBe(true);
  });

  it('does not close a workspace reattached before its transfer finishes', async () => {
    const close = vi.fn(async () => {});
    const registry = new SessionRegistry(close, () => {});
    registry.accept({ type: 'session', session });
    registry.accept({ type: 'task', task });
    await registry.detach(session.id);
    expect(registry.attach(session.id).detached).toBe(false);
    registry.accept({ type: 'task', task: { ...task, phase: 'completed' } });
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(registry.activeCount).toBe(1);
    await registry.detach(session.id);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retains both detached endpoints of a remote copy until its outcome is known', async () => {
    const close = vi.fn(async () => {});
    const registry = new SessionRegistry(close, () => {});
    const source = { ...session, id: 'source' };
    registry.accept({ type: 'session', session });
    registry.accept({ type: 'session', session: source });
    const copy = { ...task, sourceSessionId: source.id };
    registry.accept({ type: 'task', task: copy });
    await registry.detach(source.id);
    await registry.detach(session.id);
    expect(registry.activeCount).toBe(2);
    expect(close).not.toHaveBeenCalled();
    registry.accept({ type: 'task', task: { ...copy, phase: 'unknown' } });
    await vi.waitFor(() => expect(registry.activeCount).toBe(0));
    expect(registry.get(source.id)).toBeUndefined();
    expect(registry.get(session.id)).toBeUndefined();
  });

  it('protects unsaved drafts after connection loss, but not after logout', () => {
    const registry = new SessionRegistry(async () => {}, () => {});
    registry.accept({ type: 'session', session: { ...session, phase: 'lost' } });
    expect(registry.needsExitConfirmation).toBe(false);
    registry.setDirty(session.id, true);
    expect(registry.needsExitConfirmation).toBe(true);
    registry.clear();
    expect(registry.needsExitConfirmation).toBe(false);
    expect(() => registry.setDirty(session.id, true)).toThrow();
    registry.setDirty(session.id, false);
    expect(registry.needsExitConfirmation).toBe(false);
  });

  it('coalesces closing when protocol shutdown emits another task terminal event', async () => {
    const close = vi.fn(async (value: SessionInfo) => {
      registry.accept({ type: 'task', task: { ...task, phase: 'canceled' } });
      registry.accept({ type: 'session', session: { ...value, phase: 'closed' } });
    });
    const registry = new SessionRegistry(close, () => {});
    registry.accept({ type: 'session', session });
    registry.accept({ type: 'task', task });
    await registry.detach(session.id);
    await Promise.all([registry.close(session.id), registry.close(session.id)]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.activeCount).toBe(0);
  });
});
