import { createHash, randomUUID } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { closeSync, constants as fsConstants, rmSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdtemp, open, readdir, rm, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const { parentPort } = process;
const maxChunkBytes = 256 * 1024;
const maxTransferBytes = 1024 * 1024 * 1024 * 16;
const maxScanDepth = 32;
const maxScanEntries = 5_000;

const commandSchema = z.union([
  z.literal('scan'),
  z.literal('readStart'),
  z.literal('readNext'),
  z.literal('readClose'),
  z.literal('writeStart'),
  z.literal('writeChunk'),
  z.literal('writeFinish'),
  z.literal('writeAbort'),
  z.literal('spoolStart'),
  z.literal('spoolRemove')
]);

const requestSchema = z
  .object({
    id: z.string().min(1),
    command: commandSchema,
    args: z.unknown()
  })
  .strict();

const scanArgsSchema = z.object({ roots: z.array(z.string().min(1)).min(1) }).strict();
const readStartArgsSchema = z.object({ path: z.string().min(1) }).strict();
const readNextArgsSchema = z.object({ handleId: z.string().uuid() }).strict();
const readCloseArgsSchema = z.object({ handleId: z.string().uuid() }).strict();
const writeStartArgsSchema = z.object({ targetPath: z.string().min(1), handleId: z.string().uuid() }).strict();
const writeChunkArgsSchema = z.object({ handleId: z.string().uuid(), data: z.string() }).strict();
const writeFinishArgsSchema = z.object({ handleId: z.string().uuid() }).strict();
const writeAbortArgsSchema = z.object({ handleId: z.string().uuid() }).strict();
const spoolStartArgsSchema = z.object({ handleId: z.string().uuid(), spoolId: z.string().uuid() }).strict();
const spoolRemoveArgsSchema = z.object({ spoolId: z.string().uuid() }).strict();

type ScanEntry = { kind: 'file' | 'directory'; relativePath: string; path: string; size?: number };
type WorkerCommand = z.infer<typeof commandSchema>;

type ReadHandle = {
  file: FileHandle;
  size: number;
  offset: number;
  hash: Hash;
};

type WriteHandle = {
  file: FileHandle;
  targetPath: string;
  temporaryPath: string;
  bytesWritten: number;
  spoolId?: string;
};

type Spool = { directory: string; path: string };

const reads = new Map<string, ReadHandle>();
const writes = new Map<string, WriteHandle>();
const spools = new Map<string, Spool>();
let workerFilesCleaned = false;

function cleanupWorkerFiles(): void {
  if (workerFilesCleaned) return;
  workerFilesCleaned = true;
  for (const reader of reads.values()) {
    try {
      closeSync(reader.file.fd);
    } catch {
      // The process is exiting; subsequent cleanup still matters for protected spool directories.
    }
  }
  for (const writer of writes.values()) {
    try {
      closeSync(writer.file.fd);
    } catch {
      // The staged path can still be unlinked after a failed descriptor close.
    }
    try {
      rmSync(writer.temporaryPath, { force: true });
    } catch {
      // The process exit closes remaining descriptors and does not expose the spool path to the renderer.
    }
  }
  for (const spool of spools.values()) {
    try {
      rmSync(spool.directory, { recursive: true, force: true });
    } catch {
      // Best effort is the only possible cleanup after a utility-process crash.
    }
  }
}

process.once('exit', cleanupWorkerFiles);
process.once('SIGTERM', () => {
  cleanupWorkerFiles();
  process.exit(0);
});
process.once('SIGINT', () => {
  cleanupWorkerFiles();
  process.exit(0);
});


function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`无效文件工具请求：${result.error.issues[0]?.message ?? '格式错误'}`);
  return result.data;
}

function checkedSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxTransferBytes) {
    throw new Error('文件大小超出安全传输上限');
  }
  return size;
}


async function scanRoot(rootPath: string) {
  const root = resolve(rootPath);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error('不能上传符号链接');
  const entries: ScanEntry[] = [];

  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > maxScanDepth) throw new Error('目录层级超过安全上限');
    if (entries.length >= maxScanEntries) throw new Error('目录文件数量超过安全上限');
    const relativeToRoot = relative(root, path);
    if (
      relativeToRoot !== '' &&
      (relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === '..' || relativeToRoot.includes(`..${sep}`))
    ) {
      throw new Error('目录遍历越出已授权目录');
    }

    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    const relativePath = relative(root, path);
    if (info.isDirectory()) {
      entries.push({ kind: 'directory', relativePath, path });
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children) await visit(join(path, child.name), depth + 1);
      return;
    }
    if (!info.isFile()) return;
    entries.push({ kind: 'file', relativePath, path, size: checkedSize(info.size) });
  };

  if (rootInfo.isDirectory()) {
    await visit(root, 0);
  } else if (rootInfo.isFile()) {
    entries.push({ kind: 'file', relativePath: basename(root), path: root, size: checkedSize(rootInfo.size) });
  } else {
    throw new Error('只支持普通文件或目录上传');
  }
  return entries;
}

async function handle(command: WorkerCommand, args: unknown): Promise<unknown> {
  switch (command) {
    case 'scan': {
      const { roots } = parse(scanArgsSchema, args);
      const results: ScanEntry[] = [];
      for (const root of roots) results.push(...(await scanRoot(root)));
      return results;
    }
    case 'readStart': {
      const { path } = parse(readStartArgsSchema, args);
      const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let size: number;
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error('不是普通文件');
        size = checkedSize(info.size);
      } catch (cause) {
        await file.close();
        throw cause;
      }
      const handleId = randomUUID();
      reads.set(handleId, { file, size, offset: 0, hash: createHash('sha256') });
      return { handleId, size };
    }
    case 'readNext': {
      const { handleId } = parse(readNextArgsSchema, args);
      const reader = reads.get(handleId);
      if (!reader) throw new Error('读取句柄不存在');
      if (reader.offset === reader.size) {
        return { data: '', eof: true, sha256: reader.hash.digest('hex') };
      }
      const length = Math.min(maxChunkBytes, reader.size - reader.offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await reader.file.read(buffer, 0, length, reader.offset);
      if (bytesRead <= 0) throw new Error('本地文件在读取期间提前结束');
      const data = buffer.subarray(0, bytesRead);
      reader.hash.update(data);
      reader.offset += bytesRead;
      const chunkSHA256 = createHash('sha256').update(data).digest('hex');
      return {
        data: data.toString('base64'),
        chunk_sha256: chunkSHA256,
        eof: reader.offset === reader.size,
        ...(reader.offset === reader.size ? { sha256: reader.hash.digest('hex') } : {})
      };
    }
    case 'readClose': {
      const { handleId } = parse(readCloseArgsSchema, args);
      const reader = reads.get(handleId);
      if (reader) {
        reads.delete(handleId);
        await reader.file.close();
      }
      return null;
    }
    case 'writeStart': {
      const { targetPath, handleId } = parse(writeStartArgsSchema, args);
      if (writes.has(handleId)) throw new Error('写入句柄已存在');
      const targetDirectory = dirname(targetPath);
      const directory = await lstat(targetDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('下载目标目录必须是现有的非符号链接目录');
      const temporaryPath = join(targetDirectory, `.jumpserver-${handleId}.part`);
      const file = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600
      );
      writes.set(handleId, { file, targetPath, temporaryPath, bytesWritten: 0 });
      return { temporaryPath };
    }
    case 'writeChunk': {
      const { handleId, data } = parse(writeChunkArgsSchema, args);
      const writer = writes.get(handleId);
      if (!writer) throw new Error('写入句柄不存在');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new Error('下载分块不是有效 Base64');
      }
      const chunk = Buffer.from(data, 'base64');
      if (chunk.byteLength > 2 * 1024 * 1024) throw new Error('下载分块超过安全上限');
      if (writer.bytesWritten + chunk.byteLength > maxTransferBytes) throw new Error('下载文件大小超出安全传输上限');
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await writer.file.write(chunk, offset, chunk.byteLength - offset, null);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
          throw new Error('写入临时下载文件失败');
        }
        offset += bytesWritten;
      }
      writer.bytesWritten += chunk.byteLength;
      return { bytesWritten: chunk.byteLength };
    }
    case 'writeFinish': {
      const { handleId } = parse(writeFinishArgsSchema, args);
      const writer = writes.get(handleId);
      if (!writer) throw new Error('写入句柄不存在');
      try {
        const openedFile = await writer.file.stat();
        await writer.file.close();
        const stagedFile = await lstat(writer.temporaryPath);
        if (
          !stagedFile.isFile() ||
          stagedFile.isSymbolicLink() ||
          stagedFile.dev !== openedFile.dev ||
          stagedFile.ino !== openedFile.ino
        ) {
          throw new Error('临时下载文件在完成前已被替换');
        }
        try {
          await link(writer.temporaryPath, writer.targetPath);
        } catch (cause) {
          if (!(cause instanceof Error && 'code' in cause && ['EPERM', 'EOPNOTSUPP', 'ENOTSUP'].includes(String(cause.code)))) throw cause;
          await copyFile(writer.temporaryPath, writer.targetPath, fsConstants.COPYFILE_EXCL);
        }
        await unlink(writer.temporaryPath);
      } catch (cause) {
        await rm(writer.temporaryPath, { force: true });
        throw cause;
      } finally {
        writes.delete(handleId);
      }
      return null;
    }
    case 'writeAbort': {
      const { handleId } = parse(writeAbortArgsSchema, args);
      const writer = writes.get(handleId);
      if (writer) {
        writes.delete(handleId);
        try {
          await writer.file.close();
        } finally {
          await rm(writer.temporaryPath, { force: true });
        }
      }
      return null;
    }
    case 'spoolStart': {
      const { handleId, spoolId } = parse(spoolStartArgsSchema, args);
      if (writes.has(handleId) || spools.has(spoolId)) throw new Error('临时传输存储已存在');
      const directory = await mkdtemp(join(tmpdir(), 'jumpserver-sftp-'));
      const targetPath = join(directory, 'payload');
      const temporaryPath = join(directory, `.payload.jumpserver-${handleId}.part`);
      try {
        await chmod(directory, 0o700);
        const file = await open(
          temporaryPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600
        );
        writes.set(handleId, { file, targetPath, temporaryPath, bytesWritten: 0, spoolId });
        spools.set(spoolId, { directory, path: targetPath });
        return { path: targetPath };
      } catch (cause) {
        await rm(directory, { recursive: true, force: true });
        throw cause;
      }
    }
    case 'spoolRemove': {
      const { spoolId } = parse(spoolRemoveArgsSchema, args);
      const spool = spools.get(spoolId);
      if (!spool) return null;
      for (const writer of writes.values()) {
        if (writer.spoolId === spoolId) throw new Error('临时传输文件仍在写入');
      }
      await rm(spool.directory, { recursive: true, force: true });
      spools.delete(spoolId);
      return null;
    }
  }
}

parentPort.on('message', (event) => {
  const request = requestSchema.safeParse(event.data);
  if (!request.success) {
    parentPort.postMessage({ id: '', ok: false, error: '无效文件工具 IPC 消息' });
    return;
  }
  void handle(request.data.command, request.data.args)
    .then((result) => parentPort.postMessage({ id: request.data.id, ok: true, result }))
    .catch((cause: unknown) =>
      parentPort.postMessage({ id: request.data.id, ok: false, error: cause instanceof Error ? cause.message : '文件工具执行失败' })
    );
});
