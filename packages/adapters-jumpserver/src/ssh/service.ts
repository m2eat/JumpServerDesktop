import { dialog, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import type {
  Capability,
  FileListing,
  RemoteFile,
  ResourceContext,
  SessionInfo,
  TextFile,
  TransferTask
} from '../../../desktop-contract/src/index';
import type { ClientChannel, FileEntryWithStats, OpenMode, SFTPWrapper, Stats } from 'ssh2';
import type { AdapterHost, AuthorizedSshConnection, SshService } from '../host';
import { nativeText } from '../../../desktop-contract/src/native-i18n';

const MAX_EDITOR_BYTES = 5 * 1024 * 1024;
const MAX_TERMINAL_OUTSTANDING_BYTES = 8 * 1024 * 1024;
const MAX_SFTP_STREAM_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024 * 1024;
const SFTP_CHUNK_BYTES = 256 * 1024;
const TERMINAL_OUTPUT_CHUNK_HEADROOM = 512 * 1024;
const TERMINAL_PAUSE_WATERMARK = MAX_TERMINAL_OUTSTANDING_BYTES - TERMINAL_OUTPUT_CHUNK_HEADROOM;
const TEXT_SAVE_RACE_REASON = '保存前会重新读取并比较 SHA-256；标准 SFTP 没有原子 compare-and-swap，检查与写入之间仍可能发生远端竞态。';
const connectionTimeoutMs = 15_000;
const requestTimeoutMs = 60_000;
const maxTerminalInputCharacters = 1024 * 1024;
const maxUploadPlanRoots = 32;
const maxUploadPlanEntries = 5_000;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const terminalInputSchema = z.object({ sessionId: z.string().uuid(), data: z.string().max(maxTerminalInputCharacters) }).strict();
const terminalResizeSchema = z.object({ sessionId: z.string().uuid(), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).strict();
const terminalAckSchema = z.object({ sessionId: z.string().uuid(), bytes: z.number().int().positive().max(MAX_TERMINAL_OUTSTANDING_BYTES) }).strict();
const filePathSchema = z.object({ sessionId: z.string().uuid(), path: z.string().min(1) }).strict();
const uploadPathsSchema = z.object({ sessionId: z.string().uuid(), path: z.string().min(1), localPaths: z.array(z.string().min(1)).min(1) }).strict();
const fileRenameSchema = z.object({ sessionId: z.string().uuid(), path: z.string().min(1), newName: z.string().min(1) }).strict();
const fileRemoveSchema = z.object({ sessionId: z.string().uuid(), path: z.string().min(1), directory: z.boolean() }).strict();
const downloadSchema = z.object({ sessionId: z.string().uuid(), path: z.string().min(1), name: z.string().min(1) }).strict();
const downloadToLocalSchema = z.object({ sessionId: z.string().uuid(), path: z.string().min(1), name: z.string().min(1), targetPath: z.string().min(1) }).strict();
const copySchema = z.object({ sessionId: z.string().uuid(), targetSessionId: z.string().uuid(), path: z.string().min(1), targetPath: z.string().min(1), name: z.string().min(1) }).strict();
const saveTextSchema = z.object({ sessionId: z.string().uuid(), path: z.string().min(1), content: z.string(), version: z.string().min(1) }).strict();
const taskCancelSchema = z.object({ taskId: z.string().uuid() }).strict();

const workerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string().uuid(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: z.string(), ok: z.literal(false), error: z.string().min(1) }).strict()
]);
const workerEventSchema = z.object({ data: z.unknown() }).passthrough();
const workerScanSchema = z.array(z.object({ kind: z.enum(['file', 'directory']), relativePath: z.string(), path: z.string().min(1), size: z.number().int().nonnegative().optional() }).strict());
const workerReadStartSchema = z.object({ handleId: z.string().uuid(), size: z.number().int().nonnegative().safe() }).strict();
const workerReadNextSchema = z.object({ data: z.string(), chunk_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), eof: z.boolean(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const workerWriteChunkSchema = z.object({ bytesWritten: z.number().int().nonnegative().safe() }).strict();
const workerSpoolStartSchema = z.object({ path: z.string().min(1) }).strict();

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void };
  }
}

type FileWorkerCommand = 'scan' | 'readStart' | 'readNext' | 'readClose' | 'writeStart' | 'writeChunk' | 'writeFinish' | 'writeAbort' | 'spoolStart' | 'spoolRemove';
type LocalFileEntry = { kind: 'file' | 'directory'; relativePath: string; path: string; size?: number };
type OpeningState = { closed: boolean };
type SftpHandle = Buffer;
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };
type WorkerPending = { resolve(result: unknown): void; reject(error: Error): void; timeout: NodeJS.Timeout };
type TerminalState = {
  session: SessionInfo;
  connection: AuthorizedSshConnection;
  stream: ClientChannel | null;
  ready: Deferred<void>;
  cols: number;
  rows: number;
  outstandingBytes: number;
  paused: boolean;
  closed: boolean;
};
type FileState = {
  session: SessionInfo;
  connection: AuthorizedSshConnection;
  sftp: SFTPWrapper | null;
  ready: Deferred<void>;
  uploadDirectories: Set<string>;
  serial: Promise<void>;
  closed: boolean;
};
type TransferControl = {
  task: TransferTask;
  controller: AbortController;
  file: FileState;
  sourceFile?: FileState;
  sourceStaged: boolean;
  started: boolean;
  finished: boolean;
  interruption: 'closed' | 'lost' | null;
};

class SshServiceError extends Error {
  constructor(readonly code: 'conflict' | 'remote' | 'cancelled' | 'unknown' | 'protocol', message: string) {
    super(message);
    this.name = 'SshServiceError';
  }
}

class LocalFileWorker {
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<string, WorkerPending>();

  async request(command: FileWorkerCommand, args: unknown): Promise<unknown> {
    const child = this.start();
    const id = randomUUID();
    const deferred = Promise.withResolvers<unknown>();
    const timeout = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(new Error('本地文件工具响应超时'));
    }, requestTimeoutMs);
    this.pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, timeout });
    try {
      child.postMessage({ id, command, args });
    } catch (cause) {
      clearTimeout(timeout);
      this.pending.delete(id);
      deferred.reject(cause instanceof Error ? cause : new Error('无法向本地文件工具发送请求'));
    }
    return deferred.promise;
  }

  dispose() {
    const child = this.child;
    this.child = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('本地文件工具已停止'));
      this.pending.delete(id);
    }
    child?.kill();
  }

  private start() {
    if (this.child) return this.child;
    const child = utilityProcess.fork(join(import.meta.dirname, 'file-worker.js'));
    child.on('message', (...values: unknown[]) => {
      let raw = values[0];
      const event = workerEventSchema.safeParse(raw);
      if (event.success) raw = event.data.data;
      const response = workerResponseSchema.safeParse(raw);
      if (!response.success) return;
      const pending = this.pending.get(response.data.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(response.data.id);
      if (response.data.ok) pending.resolve(response.data.result);
      else pending.reject(new Error(response.data.error));
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('本地文件工具意外退出'));
        this.pending.delete(id);
      }
    });
    this.child = child;
    return child;
  }
}

function createDeferred<T>(): Deferred<T> {
  const deferred = Promise.withResolvers<T>();
  return { promise: deferred.promise, resolve: deferred.resolve, reject: deferred.reject };
}

function withTimeout<T>(promise: Promise<T>, message: string) {
  const deferred = Promise.withResolvers<T>();
  const timeout = setTimeout(() => deferred.reject(new Error(message)), connectionTimeoutMs);
  void promise.then(value => { clearTimeout(timeout); deferred.resolve(value); }, cause => { clearTimeout(timeout); deferred.reject(cause); });
  return deferred.promise;
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) throw new Error(`无效命令参数：${result.error.issues[0]?.message ?? '格式错误'}`);
  return result.data;
}

function operationError(cause: unknown): SshServiceError {
  if (cause instanceof SshServiceError) return cause;
  return new SshServiceError('remote', cause instanceof Error ? cause.message : 'SSH 操作失败');
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new SshServiceError('cancelled', '传输已取消');
}

function checkedSize(value: number | undefined, message = '远端文件大小无效') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TRANSFER_BYTES) throw new SshServiceError('protocol', message);
  return value;
}

function ensureRemotePath(path: string) {
  if (!path.startsWith('/') || /[\\\u0000-\u001F\u007F]/.test(path)) throw new Error('远端路径必须是安全的绝对路径');
  const segments = path.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) throw new Error('远端路径不能包含 . 或 .. 段');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function ensureRemoteName(name: string) {
  if (name.length === 0 || name === '.' || name === '..' || /[\\/\u0000-\u001F\u007F]/.test(name)) throw new Error('远端文件名无效');
  return name;
}

function joinRemotePath(directory: string, name: string) {
  ensureRemotePath(directory);
  ensureRemoteName(name);
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function parentRemotePath(path: string) {
  ensureRemotePath(path);
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function baseRemoteName(path: string) {
  ensureRemotePath(path);
  return ensureRemoteName(path.slice(path.lastIndexOf('/') + 1));
}

const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

function safeDownloadName(name: string) {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '_')
    .replace(/[. ]+$/, '');
  return !cleaned || windowsReservedName.test(cleaned) ? 'download' : cleaned;
}

function decodeBase64(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new SshServiceError('protocol', '本地文件工具返回了无效 Base64 分块');
  return Buffer.from(value, 'base64');
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SshServiceError('protocol', '文件不是有效 UTF-8 文本');
  }
}

function encodeValidUtf8(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (decodeUtf8(bytes) !== text) throw new SshServiceError('protocol', '文本包含无法按 UTF-8 保存的字符');
  return Buffer.from(bytes);
}

function remotePathFromLocalRelative(directory: string, relativePath: string) {
  if (relativePath.length === 0) return directory;
  return relativePath.split(sep).reduce((current, segment) => joinRemotePath(current, segment), directory);
}

function remoteType(attrs: Stats): 'file' | 'directory' | 'link' | 'unknown' {
  const kind = attrs.mode & S_IFMT;
  if (kind === S_IFREG) return 'file';
  if (kind === S_IFDIR) return 'directory';
  if (kind === S_IFLNK) return 'link';
  return 'unknown';
}

function capabilitiesForTerminal(): Record<string, Capability> {
  return {
    rawBinary: { state: 'supported', reason: '原生 SSH PTY 将原始 UTF-8 字节直接交给终端渲染器。' },
    boundedOutput: { state: 'supported', reason: `SSH Channel 在未确认输出达到 ${MAX_TERMINAL_OUTSTANDING_BYTES} 字节时暂停读取，确认后恢复。` }
  };
}

function capabilitiesForFiles(): Record<string, Capability> {
  return {
    list: { state: 'supported', reason: '使用原生 SFTP readdir。' },
    mkdir: { state: 'supported', reason: '使用原生 SFTP mkdir，并拒绝已观察到的符号链接目录。' },
    rename: { state: 'supported', reason: '使用原生 SFTP rename；客户端在请求前拒绝已存在的目标。' },
    remove: { state: 'supported', reason: '使用原生 SFTP unlink 或 rmdir。' },
    upload: { state: 'supported', reason: '新建上传以 SFTP O_EXCL 打开远端路径，绝不覆盖同名文件。' },
    download: { state: 'supported', reason: '下载经受限本地临时文件完成，并以排他链接或 COPYFILE_EXCL 提交。' },
    textRead: { state: 'supported', reason: `按受限 SFTP 流读取至多 ${MAX_EDITOR_BYTES} 字节，并以 SHA-256 标识版本。` },
    textSave: { state: 'supported', reason: TEXT_SAVE_RACE_REASON },
    conditionalSave: { state: 'supported', reason: '客户端执行内容版本冲突检测，冲突时停止保存且不重试；该检测不是服务器原子 CAS。' },
    atomicCompareAndSwap: { state: 'unsupported', reason: '标准 SFTP 不提供带 expected_version 的原子写入；客户端不会声称检查后写入是原子的。' },
    symlinkSafety: { state: 'unsupported', reason: '客户端拒绝操作已观察到的符号链接并逐级检查父目录；标准 SFTP 没有原子 O_NOFOLLOW，远端并发替换仍无法由协议消除。' }
  };
}

function isSafeTaskByteCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function isNotFound(error: unknown) {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  return code === '2' || code === 'ENOENT' || /no such file/i.test(error instanceof Error ? error.message : '');
}

function isAlreadyExists(error: unknown) {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  return code === 'EEXIST' || /already exists|file exists/i.test(error instanceof Error ? error.message : '');
}
function hasConfirmedSftpRejection(cause: unknown) {
  if (!(cause instanceof Error) || !('code' in cause)) return false;
  const code = cause.code;
  return (typeof code === 'number' && Number.isInteger(code)) || ['EACCES', 'EEXIST', 'ENOENT', 'EPERM'].includes(String(code));
}



function sftpVoid(start: (done: (error?: Error | null) => void) => void) {
  return new Promise<void>((resolve, reject) => start(error => error ? reject(error) : resolve()));
}

function sftpValue<T>(start: (done: (error: Error | null | undefined, value?: T) => void) => void, failure: string) {
  return new Promise<T>((resolve, reject) => start((error, value) => {
    if (error) reject(error);
    else if (value === undefined) reject(new SshServiceError('protocol', failure));
    else resolve(value);
  }));
}

async function sftpLstat(sftp: SFTPWrapper, path: string) {
  return sftpValue<Stats>(done => sftp.lstat(path, done), 'SFTP 未返回文件属性');
}

async function sftpOpen(sftp: SFTPWrapper, path: string, flags: OpenMode) {
  return sftpValue<SftpHandle>(done => sftp.open(path, flags, done), 'SFTP 未返回文件句柄');
}

async function sftpFstat(sftp: SFTPWrapper, handle: SftpHandle) {
  return sftpValue<Stats>(done => sftp.fstat(handle, done), 'SFTP 未返回打开文件属性');
}

async function sftpRead(sftp: SFTPWrapper, handle: SftpHandle, buffer: Buffer, position: number) {
  return new Promise<number>((resolve, reject) => sftp.read(handle, buffer, 0, buffer.byteLength, position, (error, bytesRead) => {
    if (error) reject(error);
    else if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) reject(new SshServiceError('protocol', 'SFTP 返回了无效读取长度'));
    else resolve(bytesRead);
  }));
}

async function sftpWrite(sftp: SFTPWrapper, handle: SftpHandle, buffer: Buffer, position: number) {
  await sftpVoid(done => sftp.write(handle, buffer, 0, buffer.byteLength, position, done));
}

async function sftpClose(sftp: SFTPWrapper, handle: SftpHandle) {
  await sftpVoid(done => sftp.close(handle, done));
}

export class SshServiceImpl implements SshService {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly files = new Map<string, FileState>();
  private readonly openings = new Set<OpeningState>();
  private readonly transfers = new Map<string, TransferControl>();
  private readonly fileWorker = new LocalFileWorker();
  private generation = 0;

  constructor(private readonly host: AdapterHost) {}

  async open(kind: 'terminal' | 'files', context: ResourceContext): Promise<SessionInfo> {
    this.host.assertContext(context);
    if (kind === 'terminal' && context.protocol !== 'ssh' && context.protocol !== 'telnet') {
      throw new Error('原生终端仅支持通过网关 SSH 启动的 SSH 或 Telnet 协议');
    }
    if (kind === 'files' && context.protocol !== 'sftp') throw new Error('原生文件工作区仅支持 SFTP 协议');
    return kind === 'terminal' ? this.openTerminal(context) : this.openFiles(context);
  }

  async close(sessionId: string): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (terminal) {
      this.closeTerminal(terminal, 'closed');
      this.terminals.delete(sessionId);
      return;
    }
    const file = this.files.get(sessionId);
    if (file) {
      this.closeFiles(file, 'closed');
      this.files.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    for (const opening of this.openings) opening.closed = true;
    for (const terminal of this.terminals.values()) this.closeTerminal(terminal, 'closed');
    for (const file of this.files.values()) this.closeFiles(file, 'closed');
    this.terminals.clear();
    this.files.clear();
    this.fileWorker.dispose();
  }

  async invoke(command: string, args: unknown): Promise<unknown> {
    switch (command) {
      case 'terminal.input': {
        const input = parseArgs(terminalInputSchema, args);
        const state = this.requireTerminal(input.sessionId);
        if (state.session.phase !== 'active' || !state.stream) throw new Error('终端尚未就绪');
        try {
          state.stream.write(Buffer.from(input.data, 'utf8'));
        } catch (cause) {
          this.failTerminal(state, cause instanceof Error ? cause.message : '终端输入发送失败');
          throw cause;
        }
        return undefined;
      }
      case 'terminal.resize': {
        const resize = parseArgs(terminalResizeSchema, args);
        const state = this.requireTerminal(resize.sessionId);
        if (state.session.phase !== 'active' || !state.stream) throw new Error('终端尚未就绪');
        state.cols = resize.cols;
        state.rows = resize.rows;
        try {
          state.stream.setWindow(resize.rows, resize.cols, 0, 0);
        } catch (cause) {
          this.failTerminal(state, cause instanceof Error ? cause.message : '终端尺寸更新失败');
          throw cause;
        }
        return undefined;
      }
      case 'terminal.ack': {
        const ack = parseArgs(terminalAckSchema, args);
        const state = this.requireTerminal(ack.sessionId);
        state.outstandingBytes = Math.max(0, state.outstandingBytes - ack.bytes);
        if (state.paused && state.outstandingBytes <= MAX_TERMINAL_OUTSTANDING_BYTES / 2 && state.stream) {
          state.paused = false;
          state.stream.resume();
          state.stream.stderr.resume();
        }
        return undefined;
      }
      case 'files.list': {
        const input = parseArgs(filePathSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        return this.queueFileOperation(state, () => this.listFiles(state, input.path));
      }
      case 'files.mkdir': {
        const input = parseArgs(filePathSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        await this.queueFileOperation(state, () => this.mkdir(state, input.path));
        return undefined;
      }
      case 'files.rename': {
        const input = parseArgs(fileRenameSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        ensureRemoteName(input.newName);
        await this.queueFileOperation(state, () => this.rename(state, input.path, input.newName));
        return undefined;
      }
      case 'files.remove': {
        const input = parseArgs(fileRemoveSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        await this.queueFileOperation(state, () => this.remove(state, input.path, input.directory));
        return undefined;
      }
      case 'files.readText': {
        const input = parseArgs(filePathSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        return this.queueFileOperation(state, () => this.readText(state, input.path));
      }
      case 'files.saveText': {
        const input = parseArgs(saveTextSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        return this.queueFileOperation(state, () => this.saveText(state, input.path, input.content, input.version));
      }
      case 'files.upload': {
        const input = parseArgs(filePathSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        return this.prepareUploads(state, input.path);
      }
      case 'files.uploadPaths': {
        const input = parseArgs(uploadPathsSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        return this.prepareUploadPaths(state, input.path, input.localPaths);
      }
      case 'files.download': {
        const input = parseArgs(downloadSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        ensureRemoteName(input.name);
        return this.prepareDownload(state, input.path, input.name);
      }
      case 'files.downloadLocal': {
        const input = parseArgs(downloadToLocalSchema, args);
        const state = this.requireFiles(input.sessionId);
        ensureRemotePath(input.path);
        ensureRemoteName(input.name);
        if (baseRemoteName(input.path) !== input.name || !isAbsolute(input.targetPath) || basename(input.targetPath) !== input.name) throw new Error('本地下载目标与远端普通文件不匹配');
        const transfer = this.createTransfer(state, input.path, 'download');
        void this.runDownload(transfer, input.path, input.targetPath);
        return transfer.task;
      }
      case 'files.copy': {
        const input = parseArgs(copySchema, args);
        const source = this.requireFiles(input.sessionId);
        const target = this.requireFiles(input.targetSessionId);
        ensureRemotePath(input.path);
        ensureRemotePath(input.targetPath);
        ensureRemoteName(input.name);
        if (baseRemoteName(input.path) !== input.name) throw new Error('远端复制源路径与文件名不匹配');
        const destination = joinRemotePath(input.targetPath, input.name);
        if (source === target && input.path === destination) throw new Error('不能将远端文件复制到其自身路径');
        const transfer = this.createTransfer(target, destination, 'upload', undefined, source === target ? undefined : source);
        void this.runRemoteCopy(transfer, source, input.path, destination);
        return transfer.task;
      }
      case 'tasks.cancel': {
        const input = parseArgs(taskCancelSchema, args);
        const transfer = this.transfers.get(input.taskId);
        if (!transfer) throw new Error('传输任务不存在或已结束');
        this.host.assertContext(transfer.file.session.context);
        if (transfer.sourceFile) this.host.assertContext(transfer.sourceFile.session.context);
        this.stopTransfer(transfer);
        return undefined;
      }
      default:
        throw new Error(`SSH 服务不支持命令：${command}`);
    }
  }

  private async openTerminal(context: ResourceContext): Promise<SessionInfo> {
    const opening: OpeningState = { closed: false };
    this.openings.add(opening);
    let connection: AuthorizedSshConnection | undefined;
    let state: TerminalState | null = null;
    try {
      connection = await this.host.authorizeNative(context, 'terminal');
      if (opening.closed) throw new Error('终端会话已关闭');
      const session = this.newSession('terminal', context, capabilitiesForTerminal());
      this.host.update(session);
      state = { session, connection, stream: null, ready: createDeferred<void>(), cols: 80, rows: 24, outstandingBytes: 0, paused: false, closed: false };
      this.terminals.set(session.id, state);
      this.attachClientLifecycle(state, 'terminal');
      connection.client.shell({ term: 'xterm-256color', cols: state.cols, rows: state.rows }, (error, stream) => {
        if (error) {
          this.failTerminal(state!, error.message);
          return;
        }
        if (state!.closed || opening.closed) {
          try { stream.end(); } catch { /* connection closure below is authoritative */ }
          return;
        }
        state!.stream = stream;
        this.attachTerminalStream(state!);
        this.updateSession(state!.session, 'active');
        state!.ready.resolve(undefined);
      });
      await withTimeout(state.ready.promise, 'SSH 终端连接超时');
      return state.session;
    } catch (cause) {
      if (state) {
        this.failTerminal(state, cause instanceof Error ? cause.message : '终端连接失败');
        this.terminals.delete(state.session.id);
      } else connection?.close();
      throw cause;
    } finally {
      this.openings.delete(opening);
    }
  }

  private async openFiles(context: ResourceContext): Promise<SessionInfo> {
    const opening: OpeningState = { closed: false };
    this.openings.add(opening);
    let connection: AuthorizedSshConnection | undefined;
    let state: FileState | null = null;
    try {
      connection = await this.host.authorizeNative(context, 'files');
      if (opening.closed) throw new Error('文件会话已关闭');
      const session = this.newSession('files', context, capabilitiesForFiles());
      this.host.update(session);
      state = { session, connection, sftp: null, ready: createDeferred<void>(), uploadDirectories: new Set(), serial: Promise.resolve(), closed: false };
      this.files.set(session.id, state);
      this.attachClientLifecycle(state, 'files');
      connection.client.sftp((error, sftp) => {
        if (error) {
          this.failFiles(state!, error.message);
          return;
        }
        if (state!.closed || opening.closed) return;
        state!.sftp = sftp;
        this.updateSession(state!.session, 'active');
        state!.ready.resolve(undefined);
      });
      await withTimeout(state.ready.promise, 'SFTP 连接超时');
      return state.session;
    } catch (cause) {
      if (state) {
        this.failFiles(state, cause instanceof Error ? cause.message : '文件连接失败');
        this.files.delete(state.session.id);
      } else connection?.close();
      throw cause;
    } finally {
      this.openings.delete(opening);
    }
  }

  private newSession(kind: 'terminal' | 'files', context: ResourceContext, capabilities: Record<string, Capability>): SessionInfo {
    this.generation += 1;
    return { id: randomUUID(), generation: this.generation, kind, phase: 'connecting', detached: false, context, capabilities };
  }

  private attachClientLifecycle(state: TerminalState | FileState, kind: 'terminal' | 'files') {
    const fail = (message: string) => kind === 'terminal' ? this.failTerminal(state as TerminalState, message) : this.failFiles(state as FileState, message);
    const client = state.connection.client;
    client.on('error', error => fail(error.message));
    client.on('end', () => fail('SSH 连接已结束'));
    client.on('close', () => fail('SSH 连接已关闭'));
  }

  private attachTerminalStream(state: TerminalState) {
    const stream = state.stream!;
    const pauseOutput = () => {
      state.paused = true;
      stream.pause();
      stream.stderr.pause();
    };
    const publishOutput = (bytes: Buffer) => {
      if (state.closed) return;
      const nextOutstanding = state.outstandingBytes + bytes.byteLength;
      if (nextOutstanding > MAX_TERMINAL_OUTSTANDING_BYTES) {
        try { pauseOutput(); } catch { /* terminal is being failed */ }
        this.failTerminal(state, '终端输出超过已确认缓冲上限，已受控断开');
        this.host.emit({ type: 'notice', message: '终端输出超过已确认缓冲上限，已受控断开。' });
        return;
      }
      state.outstandingBytes = nextOutstanding;
      this.host.emit({ type: 'terminal', sessionId: state.session.id, generation: state.session.generation, data: bytes });
      if (state.outstandingBytes >= TERMINAL_PAUSE_WATERMARK) pauseOutput();
    };
    stream.on('data', (bytes: Buffer) => publishOutput(bytes));
    stream.stderr.on('data', (bytes: Buffer) => publishOutput(bytes));
    stream.on('error', (error: Error) => this.failTerminal(state, error.message));
    stream.stderr.on('error', error => this.failTerminal(state, error.message));
    stream.on('close', () => { if (!state.closed) this.failTerminal(state, 'SSH 终端通道已关闭'); });
  }

  private requireTerminal(sessionId: string) {
    const state = this.terminals.get(sessionId);
    if (!state || state.closed) throw new Error('终端会话不存在或已关闭');
    this.host.assertContext(state.session.context);
    return state;
  }

  private requireFiles(sessionId: string) {
    const state = this.files.get(sessionId);
    if (!state || state.closed || !state.sftp) throw new Error('文件会话不存在或已关闭');
    this.host.assertContext(state.session.context);
    return state;
  }

  private sftp(state: FileState) {
    if (state.closed || !state.sftp) throw new Error('文件会话未连接');
    return state.sftp;
  }

  private isCurrentFileState(state: FileState) {
    return !state.closed && this.files.get(state.session.id) === state;
  }

  private assertCurrentFileState(state: FileState) {
    if (!this.isCurrentFileState(state)) throw new Error('文件会话已关闭或已由新会话替代');
  }

  private queueFileOperation<T>(state: FileState, operation: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      this.assertCurrentFileState(state);
      return operation();
    };
    const run = state.serial.then(guarded, guarded);
    state.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  private async assertSafeAncestors(sftp: SFTPWrapper, path: string) {
    const segments = ensureRemotePath(path).split('/').filter(Boolean);
    let current = '';
    for (const segment of segments.slice(0, -1)) {
      current += `/${segment}`;
      const attrs = await sftpLstat(sftp, current);
      const type = remoteType(attrs);
      if (type === 'link') throw new SshServiceError('protocol', `拒绝跟随远端符号链接目录：${current}`);
      if (type !== 'directory') throw new SshServiceError('protocol', `远端路径不是目录：${current}`);
    }
  }

  private async assertSafeRegularFile(sftp: SFTPWrapper, path: string) {
    await this.assertSafeAncestors(sftp, path);
    const attrs = await sftpLstat(sftp, path);
    const type = remoteType(attrs);
    if (type === 'link') throw new SshServiceError('protocol', '拒绝读取远端符号链接');
    if (type !== 'file') throw new SshServiceError('protocol', '远端路径不存在或不是普通文件');
    return attrs;
  }

  private async listFiles(state: FileState, path: string): Promise<FileListing> {
    const sftp = this.sftp(state);
    ensureRemotePath(path);
    await this.assertSafeAncestors(sftp, path === '/' ? '/placeholder' : `${path}/placeholder`);
    const entries = await sftpValue<FileEntryWithStats[]>(done => sftp.readdir(path, done), 'SFTP 未返回目录列表');
    const mapped: RemoteFile[] = [];
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue;
      ensureRemoteName(entry.filename);
      const type = remoteType(entry.attrs);
      mapped.push({
        name: entry.filename,
        path: joinRemotePath(path, entry.filename),
        type: type === 'directory' ? 'directory' : type === 'link' ? 'link' : 'file',
        size: Number.isSafeInteger(entry.attrs.size) && entry.attrs.size >= 0 ? String(entry.attrs.size) : '',
        modified: Number.isSafeInteger(entry.attrs.mtime) ? new Date(entry.attrs.mtime * 1000).toISOString() : '',
        permissions: `0${entry.attrs.mode.toString(8)}`
      });
    }
    return { path, entries: mapped };
  }

  private async mkdir(state: FileState, path: string) {
    const sftp = this.sftp(state);
    await this.assertSafeAncestors(sftp, path);
    await sftpVoid(done => sftp.mkdir(path, done));
    state.uploadDirectories.add(path);
  }

  private async ensureUploadDirectories(state: FileState, directories: string[], signal: AbortSignal) {
    const sftp = this.sftp(state);
    for (const directory of directories) {
      throwIfCancelled(signal);
      if (state.uploadDirectories.has(directory)) continue;
      await this.assertSafeAncestors(sftp, directory);
      try {
        await sftpVoid(done => sftp.mkdir(directory, done));
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause;
        const attrs = await sftpLstat(sftp, directory);
        if (remoteType(attrs) !== 'directory') throw new SshServiceError('conflict', `远端路径已被非目录项占用：${directory}`);
      }
      state.uploadDirectories.add(directory);
    }
  }

  private async rename(state: FileState, path: string, newName: string) {
    const sftp = this.sftp(state);
    const target = joinRemotePath(parentRemotePath(path), newName);
    await this.assertSafeAncestors(sftp, path);
    await this.assertSafeAncestors(sftp, target);
    try {
      await sftpLstat(sftp, target);
      throw new SshServiceError('conflict', '远端已有同名文件，未覆盖');
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
    await sftpVoid(done => sftp.rename(path, target, done));
  }

  private async remove(state: FileState, path: string, directory: boolean) {
    const sftp = this.sftp(state);
    await this.assertSafeAncestors(sftp, path);
    const attrs = await sftpLstat(sftp, path);
    const type = remoteType(attrs);
    if (directory) {
      if (type !== 'directory') throw new SshServiceError('protocol', '远端路径不是可删除的目录');
      await sftpVoid(done => sftp.rmdir(path, done));
    } else {
      if (type === 'directory') throw new SshServiceError('protocol', '目录必须使用目录删除操作');
      await sftpVoid(done => sftp.unlink(path, done));
    }
  }

  private async readRemote(
    state: FileState,
    path: string,
    limit: number,
    signal: AbortSignal,
    onChunk: (chunk: Buffer) => Promise<void> | void,
    onTotal?: (total: number) => void
  ) {
    const sftp = this.sftp(state);
    await this.assertSafeRegularFile(sftp, path);
    throwIfCancelled(signal);
    const handle = await sftpOpen(sftp, path, 'r');
    let closeFailure: unknown = null;
    try {
      const attrs = await sftpFstat(sftp, handle);
      const total = checkedSize(attrs.size);
      if (total > limit) throw new SshServiceError('protocol', `文件超过 ${Math.floor(limit / (1024 * 1024))} MiB 安全读取上限`);
      onTotal?.(total);
      let offset = 0;
      while (offset < total) {
        throwIfCancelled(signal);
        const buffer = Buffer.allocUnsafe(Math.min(SFTP_CHUNK_BYTES, total - offset));
        const bytesRead = await sftpRead(sftp, handle, buffer, offset);
        if (bytesRead <= 0) throw new SshServiceError('protocol', '远端文件在读取期间提前结束');
        const chunk = buffer.subarray(0, bytesRead);
        await onChunk(chunk);
        offset += bytesRead;
      }
      return total;
    } finally {
      try {
        await sftpClose(sftp, handle);
      } catch (cause) {
        closeFailure = cause;
      }
      if (closeFailure) throw closeFailure;
    }
  }

  private async readText(state: FileState, path: string): Promise<TextFile> {
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    await this.readRemote(state, path, MAX_EDITOR_BYTES, new AbortController().signal, async chunk => {
      chunks.push(chunk);
      hash.update(chunk);
    });
    const bytes = Buffer.concat(chunks);
    return {
      path,
      content: decodeUtf8(bytes),
      version: hash.digest('hex'),
      writable: true,
      reason: TEXT_SAVE_RACE_REASON
    };
  }

  private async contentVersion(state: FileState, path: string, signal: AbortSignal) {
    const hash = createHash('sha256');
    await this.readRemote(state, path, MAX_EDITOR_BYTES, signal, chunk => { hash.update(chunk); });
    return hash.digest('hex');
  }

  private async saveText(state: FileState, path: string, content: string, version: string): Promise<TextFile> {
    const bytes = encodeValidUtf8(content);
    if (bytes.byteLength > MAX_EDITOR_BYTES) throw new SshServiceError('protocol', `文本超过 ${MAX_EDITOR_BYTES} 字节保存上限`);
    const signal = new AbortController().signal;
    const currentVersion = await this.contentVersion(state, path, signal);
    if (currentVersion !== version) throw new SshServiceError('conflict', '远端文件已变化，已停止保存');
    const sftp = this.sftp(state);
    await this.assertSafeRegularFile(sftp, path);
    let handle: SftpHandle | null = null;
    let mutationDispatched = false;
    try {
      mutationDispatched = true;
      handle = await sftpOpen(sftp, path, 'w');
      let offset = 0;
      while (offset < bytes.byteLength) {
        const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + SFTP_CHUNK_BYTES));
        await sftpWrite(sftp, handle, chunk, offset);
        offset += chunk.byteLength;
      }
      await sftpClose(sftp, handle);
      handle = null;
      return {
        path,
        content,
        version: createHash('sha256').update(bytes).digest('hex'),
        writable: true,
        reason: TEXT_SAVE_RACE_REASON
      };
    } catch (cause) {
      if (mutationDispatched && !hasConfirmedSftpRejection(cause)) {
        throw new SshServiceError('unknown', `保存结果未知：${cause instanceof Error ? cause.message : '未收到 SFTP 确认'}；客户端不会自动重试。`);
      }
      throw operationError(cause);
    } finally {
      if (handle) {
        try { await sftpClose(sftp, handle); } catch { /* write result was already classified above */ }
      }
    }
  }

  private async prepareUploads(state: FileState, remoteDirectory: string): Promise<TransferTask[]> {
    const selected = await dialog.showOpenDialog({ title: nativeText('选择要上传的文件或目录'), buttonLabel: nativeText('上传'), properties: ['openFile', 'openDirectory', 'multiSelections'] });
    if (selected.canceled || selected.filePaths.length === 0) return [];
    this.assertCurrentFileState(state);
    return this.prepareUploadPaths(state, remoteDirectory, selected.filePaths);
  }

  private async prepareUploadPaths(state: FileState, remoteDirectory: string, selectedRoots: string[]): Promise<TransferTask[]> {
    this.assertCurrentFileState(state);
    if (selectedRoots.length > maxUploadPlanRoots) throw new Error(`一次最多上传 ${maxUploadPlanRoots} 个本地根目录`);
    const selections: Array<{ root: string; entries: LocalFileEntry[] }> = [];
    let entryCount = 0;
    for (const root of selectedRoots) {
      const result = workerScanSchema.safeParse(await this.fileWorker.request('scan', { roots: [root] }));
      this.assertCurrentFileState(state);
      if (!result.success) throw new Error('本地文件工具返回了无效目录扫描结果');
      entryCount += result.data.length;
      if (entryCount > maxUploadPlanEntries) throw new Error(`目录上传计划超过 ${maxUploadPlanEntries} 个条目上限`);
      selections.push({ root, entries: result.data });
    }
    const planned: Array<{ localPath: string; remotePath: string; size: number; directories: string[] }> = [];
    const destinations = new Map<string, 'file' | 'directory'>();
    for (const selection of selections) {
      const rootName = ensureRemoteName(basename(selection.root));
      const rootDirectory = selection.entries.some(entry => entry.kind === 'directory' && entry.relativePath.length === 0);
      const base = rootDirectory ? joinRemotePath(remoteDirectory, rootName) : remoteDirectory;
      for (const entry of selection.entries) {
        const remotePath = remotePathFromLocalRelative(base, entry.relativePath);
        if (destinations.has(remotePath)) throw new Error(`上传计划包含重复或冲突的远端路径：${remotePath}`);
        destinations.set(remotePath, entry.kind);
        if (entry.kind !== 'file') continue;
        if (entry.relativePath.length === 0 || !isSafeTaskByteCount(entry.size)) throw new Error('本地文件工具未提供有效文件上传计划');
        const segments = entry.relativePath.split(sep);
        const directories = rootDirectory ? [base] : [];
        let currentDirectory = base;
        for (const segment of segments.slice(0, -1)) {
          currentDirectory = joinRemotePath(currentDirectory, segment);
          directories.push(currentDirectory);
        }
        planned.push({ localPath: entry.path, remotePath, size: entry.size, directories });
      }
    }
    const requiredDirectories = new Set(planned.flatMap(item => item.directories));
    const emptyDirectories = [...destinations].flatMap(([path, kind]) => kind === 'directory' && !requiredDirectories.has(path) ? [path] : []);
    this.assertCurrentFileState(state);
    const tasks = planned.map(item => this.createTransfer(state, item.remotePath, 'upload', item.size));
    const directoryTask = emptyDirectories.length > 0 ? this.createTransfer(state, emptyDirectories[0]!, 'upload', 0) : null;
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const item = planned[index];
      if (task && item) void this.runUpload(task, item.localPath, item.remotePath, item.directories);
    }
    if (directoryTask) void this.runDirectoryUpload(directoryTask, emptyDirectories);
    return [...tasks, ...(directoryTask ? [directoryTask] : [])].map(transfer => transfer.task);
  }

  private async prepareDownload(state: FileState, remotePath: string, suggestedName: string): Promise<TransferTask | null> {
    const selected = await dialog.showSaveDialog({ title: nativeText('保存下载文件'), buttonLabel: nativeText('保存'), defaultPath: safeDownloadName(suggestedName), showsTagField: false });
    if (selected.canceled || !selected.filePath) return null;
    this.assertCurrentFileState(state);
    const transfer = this.createTransfer(state, remotePath, 'download');
    void this.runDownload(transfer, remotePath, selected.filePath);
    return transfer.task;
  }

  private createTransfer(file: FileState, remotePath: string, direction: TransferTask['direction'], total?: number, sourceFile?: FileState): TransferControl {
    this.assertCurrentFileState(file);
    if (sourceFile) this.assertCurrentFileState(sourceFile);
    const task: TransferTask = { id: randomUUID(), sessionId: file.session.id, ...(sourceFile ? { sourceSessionId: sourceFile.session.id } : {}), name: baseRemoteName(remotePath), direction, phase: 'queued', transferred: 0, ...(isSafeTaskByteCount(total) ? { total } : {}) };
    const control: TransferControl = { task, controller: new AbortController(), file, ...(sourceFile ? { sourceFile } : {}), sourceStaged: false, started: false, finished: false, interruption: null };
    this.transfers.set(task.id, control);
    this.host.emit({ type: 'task', task });
    return control;
  }

  private async runDirectoryUpload(control: TransferControl, directories: string[]) {
    try {
      await this.queueFileOperation(control.file, async () => {
        if (control.finished) return;
        control.started = true;
        this.publishTask(control, { phase: 'transferring' });
        try {
          await this.ensureUploadDirectories(control.file, directories, control.controller.signal);
          throwIfCancelled(control.controller.signal);
          this.publishTask(control, { phase: 'completed', transferred: 0 });
        } catch (cause) {
          this.settleTransferFailure(control, operationError(cause), '目录创建已停止。');
        }
      });
    } catch (cause) {
      if (!control.finished) this.settleTransferFailure(control, operationError(cause), '目录创建已停止。');
    }
  }

  private async runUpload(control: TransferControl, localPath: string, remotePath: string, directories: string[], afterReaderClosed?: () => Promise<void>) {
    try {
      await this.queueFileOperation(control.file, async () => {
        if (control.finished) return;
        control.started = true;
        this.publishTask(control, { phase: 'transferring' });
        let readerId: string | null = null;
        let remoteHandle: SftpHandle | null = null;
        let remoteOpened = false;
        let completed = false;
        let cleanupConfirmed = false;
        let createDispatched = false;
        let createOutcomeUnknown = false;
        let failure: SshServiceError | null = null;
        let cleanupError: string | null = null;
        try {
          throwIfCancelled(control.controller.signal);
          const started = workerReadStartSchema.safeParse(await this.fileWorker.request('readStart', { path: localPath }));
          if (!started.success) throw new SshServiceError('protocol', '本地文件工具返回了无效读取句柄');
          readerId = started.data.handleId;
          this.publishTask(control, { total: started.data.size });
          await this.ensureUploadDirectories(control.file, directories, control.controller.signal);
          throwIfCancelled(control.controller.signal);
          const sftp = this.sftp(control.file);
          await this.assertSafeAncestors(sftp, remotePath);
          createDispatched = true;
          remoteHandle = await sftpOpen(sftp, remotePath, 'wx');
          remoteOpened = true;
          let offset = 0;
          const hash = createHash('sha256');
          while (true) {
            throwIfCancelled(control.controller.signal);
            const next = workerReadNextSchema.safeParse(await this.fileWorker.request('readNext', { handleId: readerId }));
            if (!next.success) throw new SshServiceError('protocol', '本地文件工具返回了无效读取分块');
            const chunk = decodeBase64(next.data.data);
            if (chunk.byteLength === 0 && !next.data.eof) throw new SshServiceError('protocol', '本地文件工具返回了空的非结束分块');
            if (offset + chunk.byteLength > started.data.size) throw new SshServiceError('protocol', '本地文件工具返回的分块超过声明文件大小');
            if (chunk.byteLength > 0) {
              if (!next.data.chunk_sha256 || createHash('sha256').update(chunk).digest('hex') !== next.data.chunk_sha256) throw new SshServiceError('protocol', '本地文件工具返回的分块校验和无效');
              await sftpWrite(sftp, remoteHandle, chunk, offset);
              hash.update(chunk);
              offset += chunk.byteLength;
              this.publishTask(control, { transferred: offset });
            }
            if (!next.data.eof) continue;
            if (offset !== started.data.size || !next.data.sha256 || hash.digest('hex') !== next.data.sha256) {
              throw new SshServiceError('protocol', '本地文件工具未返回完整且连续的文件校验和');
            }
            break;
          }
          await sftpClose(sftp, remoteHandle);
          remoteHandle = null;
          completed = true;
          this.publishTask(control, { phase: 'completed', transferred: offset });
        } catch (cause) {
          createOutcomeUnknown = createDispatched && !remoteOpened && !hasConfirmedSftpRejection(cause);
          failure = isAlreadyExists(cause)
            ? new SshServiceError('conflict', '远端已有同名文件，未覆盖')
            : operationError(cause);
        } finally {
          if (remoteHandle) {
            try { await sftpClose(this.sftp(control.file), remoteHandle); } catch (cause) { cleanupError ??= `远端文件句柄关闭失败：${operationError(cause).message}`; }
          }
          if (readerId) {
            try { await this.fileWorker.request('readClose', { handleId: readerId }); } catch (cause) { cleanupError ??= `本地读取句柄清理失败：${operationError(cause).message}`; }
          }
          if (afterReaderClosed) {
            try { await afterReaderClosed(); } catch (cause) { cleanupError ??= `远端复制临时文件清理失败：${operationError(cause).message}`; }
          }
          if (!completed && remoteOpened) {
            try {
              await sftpVoid(done => this.sftp(control.file).unlink(remotePath, done));
              cleanupConfirmed = true;
            } catch (cause) {
              cleanupError ??= `新建远端文件清理状态未知：${operationError(cause).message}`;
            }
          }
          if (!completed) {
            const result = failure ?? new SshServiceError('remote', '上传未返回可验证的结果');
            if ((remoteOpened && !cleanupConfirmed) || createOutcomeUnknown) {
              this.publishTask(control, { phase: 'unknown', error: `上传结果未知：${result.message}${cleanupError ? `；${cleanupError}` : ''}；不会自动重试。` });
            } else {
              this.settleTransferFailure(control, result, `上传已停止${cleanupError ? `；${cleanupError}` : '；已完成清理。'}`);
            }
          }
        }
      });
    } catch (cause) {
      if (!control.finished) this.settleTransferFailure(control, operationError(cause), '上传已停止。');
    }
  }

  private async downloadToWriter<T>(
    source: FileState,
    remotePath: string,
    writerId: string,
    startWriter: () => Promise<T>,
    signal: AbortSignal,
    onTotal?: (total: number) => void,
    onProgress?: (transferred: number) => void
  ): Promise<T> {
    let writerStarted = false;
    let completed = false;
    let result: T | undefined;
    let transferred = 0;
    let failure: SshServiceError | null = null;
    let cleanupError: SshServiceError | null = null;
    try {
      throwIfCancelled(signal);
      result = await startWriter();
      writerStarted = true;
      await this.readRemote(source, remotePath, MAX_TRANSFER_BYTES, signal, async chunk => {
        throwIfCancelled(signal);
        if (chunk.byteLength > MAX_SFTP_STREAM_BUFFERED_BYTES) throw new SshServiceError('protocol', '下载分块超过安全缓冲上限');
        const written = workerWriteChunkSchema.safeParse(await this.fileWorker.request('writeChunk', { handleId: writerId, data: chunk.toString('base64') }));
        if (!written.success || written.data.bytesWritten !== chunk.byteLength) throw new SshServiceError('protocol', '本地文件工具未确认完整写入下载分块');
        transferred += chunk.byteLength;
        onProgress?.(transferred);
      }, onTotal);
      throwIfCancelled(signal);
      await this.fileWorker.request('writeFinish', { handleId: writerId });
      completed = true;
    } catch (cause) {
      failure = operationError(cause);
    }
    if (!completed && writerStarted) {
      try {
        await this.fileWorker.request('writeAbort', { handleId: writerId });
      } catch (cause) {
        cleanupError = new SshServiceError('protocol', `本地临时下载文件清理失败：${operationError(cause).message}`);
      }
    }
    if (failure) {
      if (cleanupError) throw new SshServiceError('protocol', `${failure.message}；${cleanupError.message}`);
      throw failure;
    }
    if (cleanupError) throw cleanupError;
    return result as T;
  }

  private async runDownload(control: TransferControl, remotePath: string, targetPath: string) {
    try {
      await this.queueFileOperation(control.file, async () => {
        if (control.finished) return;
        control.started = true;
        this.publishTask(control, { phase: 'transferring' });
        const writerId = randomUUID();
        try {
          await this.downloadToWriter(control.file, remotePath, writerId, async () => {
            await this.fileWorker.request('writeStart', { targetPath, handleId: writerId });
          }, control.controller.signal, total => this.publishTask(control, { total }), transferred => this.publishTask(control, { transferred }));
          this.publishTask(control, { phase: 'completed' });
        } catch (cause) {
          this.settleTransferFailure(control, operationError(cause), '下载已停止；本地临时文件已清理，远端文件未被修改。');
        }
      });
    } catch (cause) {
      if (!control.finished) this.settleTransferFailure(control, operationError(cause), '下载已停止；本地临时文件已清理，远端文件未被修改。');
    }
  }

  private async runRemoteCopy(control: TransferControl, source: FileState, sourcePath: string, targetPath: string) {
    const writerId = randomUUID();
    const spoolId = randomUUID();
    let spoolCreated = false;
    let spoolRemoved = false;
    try {
      const targetReady = await this.queueFileOperation(control.file, async () => {
        if (control.finished) return false;
        control.started = true;
        this.publishTask(control, { phase: 'transferring' });
        throwIfCancelled(control.controller.signal);
        const sftp = this.sftp(control.file);
        await this.assertSafeAncestors(sftp, targetPath);
        try {
          await sftpLstat(sftp, targetPath);
          throw new SshServiceError('conflict', '远端已有同名文件，未覆盖');
        } catch (cause) {
          if (!isNotFound(cause)) throw cause;
        }
        return true;
      });
      if (!targetReady) return;
      const spoolPath = await this.queueFileOperation(source, () => this.downloadToWriter(source, sourcePath, writerId, async () => {
        const started = workerSpoolStartSchema.safeParse(await this.fileWorker.request('spoolStart', { handleId: writerId, spoolId }));
        if (!started.success) throw new SshServiceError('protocol', '本地文件工具返回了无效临时传输存储');
        spoolCreated = true;
        return started.data.path;
      }, control.controller.signal));
      control.sourceStaged = true;
      throwIfCancelled(control.controller.signal);
      await this.runUpload(control, spoolPath, targetPath, [], async () => {
        await this.fileWorker.request('spoolRemove', { spoolId });
        spoolRemoved = true;
      });
    } catch (cause) {
      if (!control.finished) this.settleTransferFailure(control, operationError(cause), '远端复制已停止；本地临时文件已清理。');
    } finally {
      if (spoolCreated && !spoolRemoved) {
        try {
          await this.fileWorker.request('spoolRemove', { spoolId });
          spoolRemoved = true;
        } catch (cause) {
          if (!control.finished) this.publishTask(control, { phase: 'failed', error: `远端复制临时文件清理失败：${operationError(cause).message}` });
        }
      }
    }
  }

  private settleTransferFailure(control: TransferControl, failure: SshServiceError, canceledMessage: string) {
    if (control.finished) return;
    if (failure.code === 'unknown') {
      this.publishTask(control, { phase: 'unknown', error: failure.message });
    } else if (control.task.cancelRequested || control.interruption === 'closed' || (control.interruption !== 'lost' && failure.code === 'cancelled')) {
      this.publishTask(control, { phase: 'canceled', error: canceledMessage });
    } else {
      this.publishTask(control, { phase: 'failed', error: failure.message });
    }
  }

  private publishTask(control: TransferControl, patch: Partial<TransferTask>) {
    if (control.finished) return;
    const phase = patch.phase ?? control.task.phase;
    const terminal = phase === 'completed' || phase === 'canceled' || phase === 'failed' || phase === 'unknown';
    if (!terminal && (!this.isCurrentFileState(control.file) || (control.sourceFile && !control.sourceStaged && !this.isCurrentFileState(control.sourceFile)))) return;
    control.task = { ...control.task, ...patch };
    this.host.emit({ type: 'task', task: control.task });
    if (terminal) {
      control.finished = true;
      this.transfers.delete(control.task.id);
    }
  }

  private stopTransfer(control: TransferControl) {
    if (control.finished) return;
    control.controller.abort();
    if (!control.started) {
      this.publishTask(control, { phase: 'canceled', error: '传输在开始前已取消。' });
      return;
    }
    this.publishTask(control, { cancelRequested: true });
  }

  private interruptTransfersForFile(file: FileState, interruption: 'closed' | 'lost', error: string) {
    for (const transfer of this.transfers.values()) {
      if (transfer.finished || (transfer.file !== file && transfer.sourceFile !== file)) continue;
      if (transfer.sourceFile === file && transfer.sourceStaged && interruption === 'lost') continue;
      transfer.interruption = interruption;
      transfer.controller.abort();
      if (!transfer.started) this.publishTask(transfer, { phase: interruption === 'closed' ? 'canceled' : 'failed', error: `${error}；传输尚未开始。` });
    }
  }

  private closeTerminal(state: TerminalState, phase: 'closed' | 'lost', error?: string) {
    if (state.closed) return;
    state.closed = true;
    try { state.stream?.end(); } catch { /* connection closure below is authoritative */ }
    state.connection.close();
    this.updateSession(state.session, phase, error);
    state.ready.reject(new Error(error ?? '终端已关闭'));
  }

  private failTerminal(state: TerminalState, error: string) {
    this.closeTerminal(state, 'lost', error);
  }

  private closeFiles(state: FileState, phase: 'closed' | 'lost', error?: string) {
    if (state.closed) return;
    const closingError = error ?? '文件会话已关闭';
    this.interruptTransfersForFile(state, phase, closingError);
    state.closed = true;
    state.connection.close();
    this.updateSession(state.session, phase, error);
    state.ready.reject(new Error(closingError));
  }

  private failFiles(state: FileState, error: string) {
    this.closeFiles(state, 'lost', error);
  }

  private updateSession(session: SessionInfo, phase: SessionInfo['phase'], error?: string) {
    const next: SessionInfo = { ...session, phase, ...(error ? { error } : {}) };
    session.phase = next.phase;
    if (next.error) session.error = next.error;
    else delete session.error;
    this.host.update(next);
  }
}
