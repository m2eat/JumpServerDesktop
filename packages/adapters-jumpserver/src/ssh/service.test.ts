import { describe, expect, it, vi } from 'vitest';
import { dialog, utilityProcess } from 'electron';
import type { AppEvent, ResourceContext, SessionInfo } from '../../../desktop-contract/src/index';
import type { AdapterHost, AuthorizedSshConnection } from '../host';
import { SshServiceImpl } from './service';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  utilityProcess: { fork: vi.fn() }
}));

type Listener = (...args: unknown[]) => void;

class FakeReadable {
  paused = false;
  private readonly listeners = new Map<string, Listener[]>();

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  output(bytes: Uint8Array) {
    for (const listener of this.listeners.get('data') ?? []) listener(bytes);
  }
}

class FakeTerminal extends FakeReadable {
  readonly writes: Buffer[] = [];
  readonly stderr = new FakeReadable();

  write(bytes: Uint8Array) {
    this.writes.push(Buffer.from(bytes));
    return true;
  }

  end() {}
  setWindow() {}
}

class FakeSftp {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>(['/']);
  readonly opens: Array<{ path: string; flags: string; handle: Buffer }> = [];
  failWrite = false;
  failUnlink = false;
  failOpenWrite = false;
  failOpenExclusive = false;

  readdir(path: string, callback: (error: Error | null, entries?: unknown[]) => void) {
    const prefix = path === '/' ? '/' : `${path}/`;
    const entries = [...this.files].flatMap(([filePath, data]) => {
      if (!filePath.startsWith(prefix) || filePath.slice(prefix.length).includes('/')) return [];
      return [{ filename: filePath.slice(prefix.length), longname: '-rw-------', attrs: { size: data.byteLength, mtime: 0, mode: 0o100600 } }];
    });
    callback(null, entries);
  }

  mkdir(path: string, callback: (error?: Error | null) => void) {
    if (this.directories.has(path)) callback(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    else { this.directories.add(path); callback(null); }
  }

  rename(from: string, to: string, callback: (error?: Error | null) => void) {
    const data = this.files.get(from);
    if (!data) callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    else { this.files.delete(from); this.files.set(to, data); callback(null); }
  }

  unlink(path: string, callback: (error?: Error | null) => void) {
    if (this.failUnlink) callback(new Error('connection lost'));
    else { this.files.delete(path); callback(null); }
  }

  rmdir(path: string, callback: (error?: Error | null) => void) {
    this.directories.delete(path);
    callback(null);
  }

  lstat(path: string, callback: (error: Error | null, attrs?: unknown) => void) {
    if (this.directories.has(path)) { callback(null, { mode: 0o040700 }); return; }
    const file = this.files.get(path);
    if (file) { callback(null, { size: file.byteLength, mtime: 0, mode: 0o100600 }); return; }
    callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  }

  fstat(handle: Buffer, callback: (error: Error | null, attrs?: unknown) => void) {
    const opened = this.opens.find(entry => entry.handle === handle);
    const data = opened ? this.files.get(opened.path) : undefined;
    if (!data) callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    else callback(null, { size: data.byteLength, mode: 0o100600 });
  }

  open(path: string, flags: string, callback: (error: Error | null, handle?: Buffer) => void) {
    if (flags === 'wx' && this.files.has(path)) { callback(Object.assign(new Error('exists'), { code: 'EEXIST' })); return; }
    if (flags === 'r' && !this.files.has(path)) { callback(Object.assign(new Error('missing'), { code: 'ENOENT' })); return; }
    if (flags.includes('w')) {
      this.files.set(path, Buffer.alloc(0));
      if ((flags === 'w' && this.failOpenWrite) || (flags === 'wx' && this.failOpenExclusive)) {
        callback(new Error('connection lost'));
        return;
      }
    }
    const handle = Buffer.from(`${this.opens.length + 1}`);
    this.opens.push({ path, flags, handle });
    callback(null, handle);
  }

  close(_handle: Buffer, callback: (error?: Error | null) => void) { callback(null); }

  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | null, bytesRead?: number) => void) {
    const opened = this.opens.find(entry => entry.handle === handle);
    const data = opened ? this.files.get(opened.path) : undefined;
    if (!data) { callback(new Error('missing')); return; }
    const bytes = data.subarray(position, position + length);
    bytes.copy(buffer, offset);
    callback(null, bytes.byteLength);
  }

  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error?: Error | null) => void) {
    if (this.failWrite) { callback(new Error('connection lost')); return; }
    const opened = this.opens.find(entry => entry.handle === handle);
    if (!opened) { callback(new Error('missing')); return; }
    const current = this.files.get(opened.path) ?? Buffer.alloc(0);
    const next = Buffer.alloc(Math.max(current.byteLength, position + length));
    current.copy(next);
    buffer.subarray(offset, offset + length).copy(next, position);
    this.files.set(opened.path, next);
    callback(null);
  }
}

class FakeClient {
  readonly terminal = new FakeTerminal();
  readonly listeners = new Map<string, Listener[]>();

  constructor(private readonly sftpClient: FakeSftp) {}

  shell(_options: unknown, callback: (error: Error | null, stream?: FakeTerminal) => void) { queueMicrotask(() => callback(null, this.terminal)); }
  sftp(callback: (error: Error | null, sftp?: FakeSftp) => void) { queueMicrotask(() => callback(null, this.sftpClient)); }

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
}

class FakeWorker {
  holdFirstReadStart = false;
  readonly readStarts: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  private readonly readers = new Map<string, { sent: boolean }>();

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  postMessage(message: unknown) {
    const request = message as { id: string; command: string; args: { path?: string; handleId?: string; roots?: string[] } };
    const reply = (result: unknown) => queueMicrotask(() => {
      for (const listener of this.listeners.get('message') ?? []) listener({ id: request.id, ok: true, result });
    });
    if (request.command === 'scan') {
      const path = request.args.roots?.[0] ?? '/safe/file.txt';
      const name = path.slice(path.lastIndexOf('/') + 1);
      reply([{ kind: 'file', relativePath: name, path, size: 1 }]);
    } else if (request.command === 'readStart') {
      const handleId = '00000000-0000-4000-8000-000000000001';
      this.readStarts.push(request.args.path ?? '');
      this.readers.set(handleId, { sent: false });
      if (!this.holdFirstReadStart) reply({ handleId, size: 1 });
    } else if (request.command === 'readNext') {
      const reader = this.readers.get(request.args.handleId!);
      if (!reader || reader.sent) reply({ data: '', eof: true, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' });
      else {
        reader.sent = true;
        reply({ data: 'YQ==', chunk_sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', eof: true, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' });
      }
    } else reply(null);
  }

  kill() {}
}

class FakeHost implements AdapterHost {
  readonly events: AppEvent[] = [];
  readonly updates: SessionInfo[] = [];
  readonly sftp = new FakeSftp();
  readonly client = new FakeClient(this.sftp);

  async authorize(): Promise<never> { throw new Error('SSH must not request Chen authorization'); }

  async authorizeNative(): Promise<AuthorizedSshConnection> {
    return { client: this.client as never, close() {} };
  }

  assertContext() {}
  emit(event: AppEvent) { this.events.push(event); }
  update(session: SessionInfo) { this.updates.push(session); }
}

const terminalContext: ResourceContext = {
  siteId: 'site', userId: 'user', orgId: 'org', assetId: 'asset', assetName: 'asset', address: '192.0.2.1',
  accountId: 'account', accountName: 'operator', protocol: 'ssh', connectMethod: { component: 'koko', type: 'native', value: 'ssh-client' }
};
const filesContext: ResourceContext = { ...terminalContext, protocol: 'sftp', connectMethod: { component: 'koko', type: 'native', value: 'sftp-client' } };

describe('native SSH transport', () => {
  it('forwards stdout and stderr through one acknowledgement budget before pausing both streams', async () => {
    const host = new FakeHost();
    const service = new SshServiceImpl(host);
    const session = await service.open('terminal', terminalContext);

    host.client.terminal.output(Buffer.from('stdout'));
    host.client.terminal.stderr.output(Buffer.from('stderr'));
    const output = host.events.filter((event): event is Extract<AppEvent, { type: 'terminal' }> => event.type === 'terminal');
    expect(output.map(event => Buffer.from(event.data).toString('utf8'))).toEqual(['stdout', 'stderr']);

    const total = 'stdout'.length + 'stderr'.length + 8 * 1024 * 1024 - 256 * 1024;
    host.client.terminal.output(Buffer.alloc(8 * 1024 * 1024 - 256 * 1024, 65));
    expect(host.client.terminal.paused).toBe(true);
    expect(host.client.terminal.stderr.paused).toBe(true);
    await service.invoke('terminal.ack', { sessionId: session.id, bytes: total });
    expect(host.client.terminal.paused).toBe(false);
    expect(host.client.terminal.stderr.paused).toBe(false);
    await service.invoke('terminal.input', { sessionId: session.id, data: 'echo 安全\n' });
    expect(host.client.terminal.writes.at(-1)?.toString('utf8')).toBe('echo 安全\n');
    await service.closeAll();
  });
  it('uses a Windows-safe default target for a valid POSIX remote device name', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' });
    const host = new FakeHost();
    const service = new SshServiceImpl(host);
    const session = await service.open('files', filesContext);

    await expect(service.invoke('files.download', { sessionId: session.id, path: '/CON.txt', name: 'CON.txt' })).resolves.toBeNull();
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'download' }));
    await service.closeAll();
  });


  it('stops a content-version conflict before opening a writable SFTP handle', async () => {
    const host = new FakeHost();
    host.sftp.files.set('/notes.txt', Buffer.from('before'));

    const service = new SshServiceImpl(host);
    const session = await service.open('files', filesContext);

    await expect(service.invoke('files.saveText', { sessionId: session.id, path: '/notes.txt', content: 'after', version: 'not-the-sha256' })).rejects.toThrow('远端文件已变化');

    expect(host.sftp.opens.some(opened => opened.flags === 'w')).toBe(false);
    expect(session.capabilities.atomicCompareAndSwap?.state).toBe('unsupported');
    await service.closeAll();
  });
  it('keeps the SFTP race boundary visible after save and reports a lost truncate acknowledgement as unknown', async () => {
    const host = new FakeHost();
    host.sftp.files.set('/notes.txt', Buffer.from('before'));
    const service = new SshServiceImpl(host);
    const session = await service.open('files', filesContext);

    const initial = await service.invoke('files.readText', { sessionId: session.id, path: '/notes.txt' }) as { version: string };
    const saved = await service.invoke('files.saveText', { sessionId: session.id, path: '/notes.txt', content: 'verified', version: initial.version }) as { reason?: string };
    expect(saved.reason).toContain('没有原子 compare-and-swap');

    const baseline = await service.invoke('files.readText', { sessionId: session.id, path: '/notes.txt' }) as { version: string };
    host.sftp.failOpenWrite = true;
    await expect(service.invoke('files.saveText', { sessionId: session.id, path: '/notes.txt', content: 'lost', version: baseline.version })).rejects.toThrow('保存结果未知');
    expect(host.sftp.files.get('/notes.txt')).toEqual(Buffer.alloc(0));
    await service.closeAll();
  });
  it('cancels a queued upload before it opens a second local reader', async () => {
    const worker = new FakeWorker();
    worker.holdFirstReadStart = true;
    vi.mocked(utilityProcess.fork).mockReturnValue(worker as never);
    const host = new FakeHost();
    const service = new SshServiceImpl(host);
    const session = await service.open('files', filesContext);

    const tasks = await service.invoke('files.uploadPaths', {
      sessionId: session.id,
      path: '/',
      localPaths: ['/safe/first.txt', '/safe/second.txt']
    }) as Array<{ id: string }>;
    await vi.waitFor(() => expect(worker.readStarts).toEqual(['/safe/first.txt']));
    await service.invoke('tasks.cancel', { taskId: tasks[1]?.id });
    const canceled = host.events.filter(
      (event): event is Extract<AppEvent, { type: 'task' }> => event.type === 'task' && event.task.id === tasks[1]?.id
    );
    expect(canceled.at(-1)?.task.phase).toBe('canceled');
    expect(worker.readStarts).toEqual(['/safe/first.txt']);
    await service.closeAll();
  });

  it('reports a lost exclusive-create acknowledgement as unknown without deleting a possibly created remote file', async () => {
    const worker = new FakeWorker();
    vi.mocked(utilityProcess.fork).mockReturnValue(worker as never);
    const host = new FakeHost();
    host.sftp.failOpenExclusive = true;
    const service = new SshServiceImpl(host);
    const session = await service.open('files', filesContext);

    const tasks = await service.invoke('files.uploadPaths', { sessionId: session.id, path: '/', localPaths: ['/safe/file.txt'] }) as Array<{ id: string }>;
    await vi.waitFor(() => {
      const events = host.events.filter((event): event is Extract<AppEvent, { type: 'task' }> => event.type === 'task' && event.task.id === tasks[0]?.id);
      expect(events.at(-1)?.task.phase).toBe('unknown');
    });
    expect(host.sftp.files.has('/file.txt')).toBe(true);
    await service.closeAll();
  });

  it('reports an upload as unknown when a started exclusive write cannot be cleaned up', async () => {
    const worker = new FakeWorker();
    vi.mocked(utilityProcess.fork).mockReturnValue(worker as never);
    const host = new FakeHost();
    host.sftp.failWrite = true;
    host.sftp.failUnlink = true;
    const service = new SshServiceImpl(host);
    const session = await service.open('files', filesContext);

    const tasks = await service.invoke('files.uploadPaths', { sessionId: session.id, path: '/', localPaths: ['/safe/file.txt'] }) as Array<{ id: string }>;
    await vi.waitFor(() => {
      const events = host.events.filter((event): event is Extract<AppEvent, { type: 'task' }> => event.type === 'task' && event.task.id === tasks[0]?.id);
      expect(events.at(-1)?.task.phase).toBe('unknown');
    });
    await service.closeAll();
  });
});
