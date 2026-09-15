import type { AppEvent, SessionInfo, TransferTask } from '../../../../packages/desktop-contract/src/index';

/** Owns workspace visibility independently of protocol connections and background tasks. */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly tasks = new Map<string, TransferTask>();
  private readonly dirty = new Set<string>();
  private readonly closing = new Map<string, Promise<void>>();
  private epoch = 0;

  constructor(
    private readonly closeConnection: (session: SessionInfo) => Promise<void>,
    private readonly publish: (event: AppEvent) => void
  ) {}

  listSessions(): SessionInfo[] { return [...this.sessions.values()]; }
  listTasks(): TransferTask[] { return [...this.tasks.values()]; }
  get(sessionId: string): SessionInfo | undefined { return this.sessions.get(sessionId); }
  get needsExitConfirmation(): boolean {
    return this.dirty.size > 0 || [...this.sessions.values()].some(session => session.phase === 'active' || session.phase === 'connecting');
  }
  get activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.phase === 'active' || session.phase === 'connecting') count++;
    return count;
  }

  accept(event: AppEvent): void {
    if (event.type === 'session') {
      const previous = this.sessions.get(event.session.id);
      const session = { ...event.session, detached: previous?.detached ?? false };
      this.sessions.set(session.id, session);
      this.publish({ type: 'session', session });
      return;
    }
    if (event.type === 'task') {
      this.tasks.set(event.task.id, event.task);
      this.publish(event);
      const involvedSessionIds = new Set([event.task.sessionId, ...(event.task.sourceSessionId ? [event.task.sourceSessionId] : [])]);
      for (const sessionId of involvedSessionIds) {
        const session = this.sessions.get(sessionId);
        if (!session?.detached || this.hasActiveTasks(session.id)) continue;
        const epoch = this.epoch;
        void this.close(session.id).catch(() => {
          if (epoch === this.epoch) this.publish({ type: 'notice', message: '后台文件连接释放失败，请从任务列表重新打开后关闭连接。' });
        });
      }
      return;
    }
    this.publish(event);
  }

  setDirty(sessionId: string, dirty: boolean): void {
    if (!dirty) { this.dirty.delete(sessionId); return; }
    if (!this.sessions.has(sessionId)) throw new Error('不能为已失效的会话保留编辑状态');
    this.dirty.add(sessionId);
  }

  async detach(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    if (session.kind !== 'files') throw new Error('仅文件工作区支持后台传输');
    this.dirty.delete(sessionId);
    if (!this.hasActiveTasks(sessionId)) { await this.close(sessionId); return; }
    const detached = { ...session, detached: true };
    this.sessions.set(sessionId, detached);
    this.publish({ type: 'session', session: detached });
  }

  attach(sessionId: string): SessionInfo {
    const session = this.require(sessionId);
    if (session.kind !== 'files' || !session.detached || session.phase !== 'active' || this.closing.has(sessionId)) {
      throw new Error('后台文件连接已结束，不能重新打开');
    }
    const attached = { ...session, detached: false };
    this.sessions.set(sessionId, attached);
    this.publish({ type: 'session', session: attached });
    return attached;
  }

  async close(sessionId: string): Promise<void> {
    const existing = this.closing.get(sessionId);
    if (existing) return existing;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const epoch = this.epoch;
    // Defer the callback until the in-flight entry exists; closing may synchronously emit task events.
    const closing = Promise.resolve().then(() => {
      if (epoch === this.epoch) return this.closeConnection(session);
    }).then(() => {
      if (epoch !== this.epoch) return;
      this.dirty.delete(sessionId);
      this.sessions.delete(sessionId);
    }).finally(() => {
      if (epoch === this.epoch) this.closing.delete(sessionId);
    });
    this.closing.set(sessionId, closing);
    return closing;
  }

  clear(): void {
    this.epoch++;
    this.sessions.clear();
    this.tasks.clear();
    this.dirty.clear();
    this.closing.clear();
  }

  private hasActiveTasks(sessionId: string): boolean {
    for (const task of this.tasks.values()) {
      if ((task.sessionId === sessionId || task.sourceSessionId === sessionId) && (task.phase === 'queued' || task.phase === 'transferring')) return true;
    }
    return false;
  }

  private require(sessionId: string): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('会话不存在或已经失效');
    return session;
  }
}
