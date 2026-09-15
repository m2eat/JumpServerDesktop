import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import { z } from 'zod';
import type { Identity } from '../../../../packages/desktop-contract/src/index';
import type { OAuthConfiguration, OAuthTokens } from './oauth';

const MAX_CIPHERTEXT_BYTES = 128 * 1024;
const MAX_SERIALIZED_RECORD_BYTES = 96 * 1024;
const MAX_URL_LENGTH = 2_048;
const MAX_TOKEN_LENGTH = 16 * 1024;

const guid = z.string().guid();
const plainIdentifier = z.string().trim().min(1).max(512);
const userIdentifier = z.string().trim().min(1).max(256);
const secret = z
  .string()
  .min(1)
  .max(MAX_TOKEN_LENGTH)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f]/.test(value));

const tokensSchema = z
  .object({
    accessToken: secret,
    refreshToken: secret.optional(),
    expiresAt: z.number().finite().int().min(0).max(8_640_000_000_000_000)
  })
  .strict();

const identitySchema = z
  .object({
    siteId: guid,
    userId: userIdentifier,
    name: plainIdentifier,
    // Core uses UUID-shaped built-in organization IDs whose version and variant bits are zero.
    orgId: guid
  })
  .strict();

const configurationSchema = z
  .object({
    clientId: z.string().trim().min(1).max(512),
    issuer: z.string().min(1).max(MAX_URL_LENGTH),
    authorizationEndpoint: z.string().min(1).max(MAX_URL_LENGTH),
    tokenEndpoint: z.string().min(1).max(MAX_URL_LENGTH),
    revocationEndpoint: z.string().min(1).max(MAX_URL_LENGTH)
  })
  .strict();

const storedSessionSchema = z
  .object({
    siteId: guid,
    siteUrl: z.string().min(1).max(MAX_URL_LENGTH),
    identity: identitySchema,
    configuration: configurationSchema,
    tokens: tokensSchema
  })
  .strict();

export interface StoredOAuthSession {
  siteId: string;
  siteUrl: string;
  identity: Identity;
  configuration: OAuthConfiguration;
  tokens: OAuthTokens;
}

export class OAuthCredentialStoreError extends Error {
  constructor(readonly kind: 'unavailable' | 'corrupt' | 'filesystem' | 'invalid') {
    super(
      kind === 'unavailable'
        ? '系统密钥库不可用，无法安全保存登录凭据'
        : kind === 'corrupt'
          ? '已保存的登录凭据无法解密或格式无效；请重新登录'
          : kind === 'filesystem'
            ? '无法安全访问本地登录凭据存储'
            : 'OAuth 登录凭据记录格式无效'
    );
    this.name = 'OAuthCredentialStoreError';
  }
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}


function normalizeHttpsUrl(value: string): string {
  if (value.trim() !== value) throw new OAuthCredentialStoreError('invalid');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthCredentialStoreError('invalid');
  }

  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%2f|%5c|\\/i.test(url.pathname)
  ) {
    throw new OAuthCredentialStoreError('invalid');
  }

  const decodedPath = decodeURIComponent(url.pathname);
  if (decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new OAuthCredentialStoreError('invalid');
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function remainsUnderGateway(siteUrl: string, endpoint: string): boolean {
  const site = new URL(siteUrl);
  const target = new URL(endpoint);
  if (site.origin !== target.origin) return false;

  const gatewayPath = site.pathname.replace(/\/+$/, '');
  return gatewayPath === '' || target.pathname === gatewayPath || target.pathname.startsWith(`${gatewayPath}/`);
}

function normalizeConfiguration(value: z.infer<typeof configurationSchema>, siteUrl: string): OAuthConfiguration {
  const configuration: OAuthConfiguration = {
    clientId: value.clientId,
    issuer: value.issuer,
    authorizationEndpoint: `${normalizeHttpsUrl(value.authorizationEndpoint)}/`,
    tokenEndpoint: `${normalizeHttpsUrl(value.tokenEndpoint)}/`,
    revocationEndpoint: `${normalizeHttpsUrl(value.revocationEndpoint)}/`
  };

  // Preserve issuer as an identifier, but bind its TLS-terminated authority to the site.
  // Stored request endpoints remain strictly HTTPS.
  const issuer = normalizeHttpsUrl(configuration.issuer.replace(/^http:\/\//i, 'https://'));
  if ((issuer !== new URL(siteUrl).origin && issuer !== siteUrl) ||
      ![configuration.authorizationEndpoint, configuration.tokenEndpoint, configuration.revocationEndpoint].every((endpoint) => remainsUnderGateway(siteUrl, endpoint))) {
    throw new OAuthCredentialStoreError('invalid');
  }
  return configuration;
}

function normalizeRecord(value: unknown): StoredOAuthSession {
  let parsed: z.infer<typeof storedSessionSchema>;
  try {
    parsed = storedSessionSchema.parse(value);
  } catch {
    throw new OAuthCredentialStoreError('invalid');
  }

  if (parsed.siteId !== parsed.identity.siteId) throw new OAuthCredentialStoreError('invalid');

  const siteUrl = normalizeHttpsUrl(parsed.siteUrl);
  return {
    siteId: parsed.siteId,
    siteUrl,
    identity: {
      siteId: parsed.identity.siteId,
      userId: parsed.identity.userId,
      name: parsed.identity.name,
      orgId: parsed.identity.orgId
    },
    configuration: normalizeConfiguration(parsed.configuration, siteUrl),
    tokens: {
      accessToken: parsed.tokens.accessToken,
      ...(parsed.tokens.refreshToken === undefined ? {} : { refreshToken: parsed.tokens.refreshToken }),
      expiresAt: parsed.tokens.expiresAt
    }
  };
}

/**
 * Persists one complete OAuth identity as a single encrypted blob. The operation queue
 * deliberately includes crypto so a queued clear cannot be overtaken by a slow save.
 */
export class OAuthCredentialStore {
  private readonly directory: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.directory = dirname(filePath);
  }

  load(): Promise<StoredOAuthSession | null> {
    return this.enqueue(async () => {
      const ciphertext = await this.readCiphertext();
      if (ciphertext === null) return null;

      await this.assertEncryptionAvailable();
      let decrypted: Electron.DecryptStringAsyncReturnValue;
      try {
        decrypted = await safeStorage.decryptStringAsync(ciphertext);
      } catch {
        throw new OAuthCredentialStoreError('corrupt');
      }

      const record = this.parseDecryptedRecord(decrypted.result);
      if (decrypted.shouldReEncrypt) await this.persist(record);
      return record;
    });
  }

  save(record: StoredOAuthSession): Promise<void> {
    let snapshot: StoredOAuthSession;
    try {
      snapshot = normalizeRecord(record);
    } catch (error) {
      return Promise.reject(error instanceof OAuthCredentialStoreError ? error : new OAuthCredentialStoreError('invalid'));
    }
    return this.enqueue(() => this.persist(snapshot));
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (!(await this.inspectDirectory())) return;
        // unlinking a symlink removes the link itself rather than following it; clear does not need a keychain.
        await rm(this.filePath, { force: true });
      } catch (error) {
        throw error instanceof OAuthCredentialStoreError ? error : new OAuthCredentialStoreError('filesystem');
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async assertEncryptionAvailable(): Promise<void> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new OAuthCredentialStoreError('unavailable');
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') throw new OAuthCredentialStoreError('unavailable');
      }
    } catch (error) {
      throw error instanceof OAuthCredentialStoreError ? error : new OAuthCredentialStoreError('unavailable');
    }
  }

  private async inspectDirectory(): Promise<boolean> {
    let info: Stats;
    try {
      info = await lstat(this.directory);
    } catch (error) {
      if (missing(error)) return false;
      throw new OAuthCredentialStoreError('filesystem');
    }

    const ownedByCurrentUser = process.platform === 'win32' || typeof process.getuid !== 'function' || info.uid === process.getuid();
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser) {
      throw new OAuthCredentialStoreError('filesystem');
    }
    return true;
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!(await this.inspectDirectory())) throw new OAuthCredentialStoreError('filesystem');
      if (process.platform !== 'win32') await chmod(this.directory, 0o700);
    } catch (error) {
      throw error instanceof OAuthCredentialStoreError ? error : new OAuthCredentialStoreError('filesystem');
    }
  }

  private async inspectExistingFile(requireBoundedSize: boolean): Promise<boolean> {
    if (!(await this.inspectDirectory())) return false;

    let info: Stats;
    try {
      info = await lstat(this.filePath);
    } catch (error) {
      if (missing(error)) return false;
      throw new OAuthCredentialStoreError('filesystem');
    }

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !(process.platform === 'win32' || typeof process.getuid !== 'function' || info.uid === process.getuid()) ||
      (requireBoundedSize && info.size > MAX_CIPHERTEXT_BYTES)
    ) {
      throw new OAuthCredentialStoreError(requireBoundedSize && info.size > MAX_CIPHERTEXT_BYTES ? 'corrupt' : 'filesystem');
    }
    return true;
  }

  private async readCiphertext(): Promise<Buffer | null> {
    if (!(await this.inspectExistingFile(true))) return null;

    let ciphertext: Buffer;
    try {
      ciphertext = await readFile(this.filePath);
    } catch (error) {
      if (missing(error)) return null;
      throw new OAuthCredentialStoreError('filesystem');
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) throw new OAuthCredentialStoreError('corrupt');
    return ciphertext;
  }

  private parseDecryptedRecord(value: string): StoredOAuthSession {
    try {
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SERIALIZED_RECORD_BYTES) {
        throw new OAuthCredentialStoreError('corrupt');
      }
      return normalizeRecord(JSON.parse(value));
    } catch {
      throw new OAuthCredentialStoreError('corrupt');
    }
  }

  private async persist(record: StoredOAuthSession): Promise<void> {
    await this.assertEncryptionAvailable();

    let ciphertext: Buffer;
    try {
      ciphertext = await safeStorage.encryptStringAsync(JSON.stringify(record));
    } catch {
      throw new OAuthCredentialStoreError('unavailable');
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      throw new OAuthCredentialStoreError('unavailable');
    }

    await this.writeCiphertext(ciphertext);
  }

  private async writeCiphertext(ciphertext: Buffer): Promise<void> {
    await this.ensureDirectory();
    await this.inspectExistingFile(false);

    const temporaryPath = join(this.directory, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, ciphertext, { flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await this.inspectExistingFile(false);
      if (process.platform !== 'win32') await chmod(this.filePath, 0o600);
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // A failed cleanup can only leave ciphertext in the already-private directory.
      }
      throw error instanceof OAuthCredentialStoreError ? error : new OAuthCredentialStoreError('filesystem');
    }
  }
}
