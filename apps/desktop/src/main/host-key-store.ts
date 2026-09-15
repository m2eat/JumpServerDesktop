import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

const MAX_STORE_BYTES = 64 * 1024;
const MAX_RECORDS = 1_000;
const fingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
const recordKeySchema = z.string().min(1).max(3_072);
const storedKeysSchema = z.object({
  version: z.literal(1),
  fingerprints: z.record(recordKeySchema, fingerprintSchema)
}).strict().superRefine((value, issue) => {
  if (Object.keys(value.fingerprints).length > MAX_RECORDS) {
    issue.addIssue({ code: 'custom', message: 'too many host keys' });
  }
});


export class HostKeyStoreError extends Error {
  constructor() {
    super('SSH 主机密钥信任记录不可用');
    this.name = 'HostKeyStoreError';
  }
}

/** Stores only public SSH host-key fingerprints, keyed by site and gateway endpoint. */
export class HostKeyStore {
  private readonly directory: string;
  private readonly records = new Map<string, string>();
  private loaded: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.directory = dirname(filePath);
  }

  async fingerprintFor(key: string): Promise<string | undefined> {
    await this.load();
    await this.writes;
    return this.records.get(recordKeySchema.parse(key));
  }

  async remember(key: string, fingerprint: string): Promise<void> {
    await this.load();
    const recordKey = recordKeySchema.parse(key);
    const parsedFingerprint = fingerprintSchema.parse(fingerprint);
    const queued = this.writes.then(async () => {
      const previous = this.records.get(recordKey);
      if (previous === parsedFingerprint) return;
      this.records.set(recordKey, parsedFingerprint);
      try {
        await this.persist();
      } catch (error) {
        if (previous === undefined) this.records.delete(recordKey);
        else this.records.set(recordKey, previous);
        throw error;
      }
    });
    this.writes = queued.catch(() => {});
    try {
      await queued;
    } catch (error) {
      throw error instanceof HostKeyStoreError ? error : new HostKeyStoreError();
    }
  }
  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = this.read();
    try {
      await this.loaded;
    } catch (error) {
      this.loaded = undefined;
      throw error instanceof HostKeyStoreError ? error : new HostKeyStoreError();
    }
  }

  private async read(): Promise<void> {
    const data = await this.readExisting();
    if (data === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      throw new HostKeyStoreError();
    }
    const stored = storedKeysSchema.safeParse(parsed);
    if (!stored.success) throw new HostKeyStoreError();
    for (const [key, fingerprint] of Object.entries(stored.data.fingerprints)) this.records.set(key, fingerprint);
  }

  private async readExisting(): Promise<Buffer | null> {
    const exists = await this.inspectExistingFile(true);
    if (!exists) return null;
    let data: Buffer;
    try {
      data = await readFile(this.filePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw new HostKeyStoreError();
    }
    if (data.length === 0 || data.length > MAX_STORE_BYTES) throw new HostKeyStoreError();
    return data;
  }

  private async inspectDirectory(): Promise<boolean> {
    let info;
    try {
      info = await lstat(this.directory);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw new HostKeyStoreError();
    }
    const ownedByCurrentUser = process.platform === 'win32' || typeof process.getuid !== 'function' || info.uid === process.getuid();
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser) throw new HostKeyStoreError();
    return true;
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!(await this.inspectDirectory())) throw new HostKeyStoreError();
      if (process.platform !== 'win32') await chmod(this.directory, 0o700);
    } catch (error) {
      throw error instanceof HostKeyStoreError ? error : new HostKeyStoreError();
    }
  }


  private async inspectExistingFile(requireBoundedSize: boolean): Promise<boolean> {
    if (!(await this.inspectDirectory())) return false;

    let info;
    try {
      info = await lstat(this.filePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw new HostKeyStoreError();
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !(process.platform === 'win32' || typeof process.getuid !== 'function' || info.uid === process.getuid()) ||
      (requireBoundedSize && info.size > MAX_STORE_BYTES)
    ) {
      throw new HostKeyStoreError();
    }
    return true;
  }

  private async persist(): Promise<void> {
    const serialized = JSON.stringify({ version: 1, fingerprints: Object.fromEntries(this.records) });
    const data = Buffer.from(serialized, 'utf8');
    if (data.length === 0 || data.length > MAX_STORE_BYTES) throw new HostKeyStoreError();

    await this.ensureDirectory();
    await this.inspectExistingFile(false);
    const temporaryPath = join(this.directory, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await this.inspectExistingFile(true);
      if (process.platform !== 'win32') await chmod(this.filePath, 0o600);
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // A failed cleanup can only leave a public fingerprint in a private directory.
      }
      throw error instanceof HostKeyStoreError ? error : new HostKeyStoreError();
    }
  }
}
