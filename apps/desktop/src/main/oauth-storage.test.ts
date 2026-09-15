import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthCredentialStore } from './oauth-storage';
import type { StoredOAuthSession } from './oauth-storage';
import { OAuthAccess } from './oauth';

const safeStorageMock = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn()
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));


const record: StoredOAuthSession = {
  siteId: '11111111-1111-1111-1111-111111111111',
  siteUrl: 'https://jump.example/gateway',
  identity: {
    siteId: '11111111-1111-1111-1111-111111111111',
    userId: 'operator',
    name: 'Operator',
    // This Core built-in organization UUID intentionally has zero version and variant bits.
    orgId: '00000000-0000-0000-0000-000000000000'
  },
  configuration: {
    clientId: 'desktop-client',
    issuer: 'http://jump.example',
    authorizationEndpoint: 'https://jump.example/gateway/core/auth/oauth2-provider/authorize/',
    tokenEndpoint: 'https://jump.example/gateway/core/auth/oauth2-provider/token/',
    revocationEndpoint: 'https://jump.example/gateway/core/auth/oauth2-provider/revoke/'
  },
  tokens: {
    accessToken: 'access-token-not-plaintext',
    refreshToken: 'refresh-token-not-plaintext',
    expiresAt: 1_800_000_000_000
  }
};

let directory: string;
let filePath: string;

describe('OAuthCredentialStore', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jumpserver-oauth-store-'));
    filePath = join(directory, 'session.enc');
    safeStorageMock.isAsyncEncryptionAvailable.mockResolvedValue(true);
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
    safeStorageMock.encryptStringAsync.mockImplementation(async (plainText: string): Promise<Buffer> =>
      Buffer.from(`cipher:${Buffer.from(plainText, 'utf8').toString('base64url')}`)
    );
    safeStorageMock.decryptStringAsync.mockImplementation(async (ciphertext: Buffer) => {
      const encoded = ciphertext.toString('utf8');
      if (!encoded.startsWith('cipher:')) throw new Error('invalid ciphertext');
      return { result: Buffer.from(encoded.slice('cipher:'.length), 'base64url').toString('utf8'), shouldReEncrypt: false };
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('round-trips a consumer session only through an encrypted file', async () => {
    const store = new OAuthCredentialStore(filePath);

    await store.save(record);

    const ciphertext = await readFile(filePath, 'utf8');
    expect(ciphertext).not.toContain(record.tokens.accessToken);
    expect(ciphertext).not.toContain(record.tokens.refreshToken!);
    await expect(store.load()).resolves.toEqual(record);
    const restored = (await store.load())!;
    const access = new OAuthAccess(restored.configuration, restored.tokens,
      async (url) => {
        expect(url).toBe(record.configuration.tokenEndpoint);
        return Response.json({ access_token: 'renewed', token_type: 'Bearer', expires_in: 3600 });
      },
      { assertCurrent() {}, persist: (tokens) => store.save({ ...restored, tokens }) });
    await expect(access.getAccessToken(restored.tokens.accessToken)).resolves.toBe('renewed');
  });

  it('orders clear behind a delayed save so no stale record can reappear', async () => {
    const store = new OAuthCredentialStore(filePath);
    let releaseEncryption!: () => void;
    const encryptionReleased = new Promise<void>((resolve) => {
      releaseEncryption = resolve;
    });
    let signalEncryptionStarted!: () => void;
    const encryptionStarted = new Promise<void>((resolve) => {
      signalEncryptionStarted = resolve;
    });
    safeStorageMock.encryptStringAsync.mockImplementation(async (plainText: string): Promise<Buffer> => {
      signalEncryptionStarted();
      await encryptionReleased;
      return Buffer.from(`cipher:${Buffer.from(plainText, 'utf8').toString('base64url')}`);
    });

    const saving = store.save(record);
    await encryptionStarted;
    const clearing = store.clear();
    releaseEncryption();
    await Promise.all([saving, clearing]);

    await expect(store.load()).resolves.toBeNull();
  });

  it('rejects corrupted and cross-site encrypted records without exposing their contents', async () => {
    const store = new OAuthCredentialStore(filePath);
    await writeFile(filePath, Buffer.from('not a credential ciphertext'), { mode: 0o600 });
    await expect(store.load()).rejects.toMatchObject({ kind: 'corrupt' });

    const wrongBoundRecord = {
      ...record,
      configuration: { ...record.configuration, tokenEndpoint: 'https://attacker.example/oauth/token' }
    };
    const encryptedWrongBoundRecord = await safeStorageMock.encryptStringAsync(JSON.stringify(wrongBoundRecord));
    await writeFile(filePath, encryptedWrongBoundRecord, { mode: 0o600 });
    await expect(store.load()).rejects.toMatchObject({ kind: 'corrupt' });
  });
  it('does not read, clear, or write through a symbolic-link credentials directory', async () => {
    const credentials = join(directory, 'credentials');
    const outside = join(directory, 'outside');
    const outsideFile = join(outside, 'session.enc');
    await mkdir(outside);
    await writeFile(outsideFile, Buffer.from('outside ciphertext'));
    await symlink(outside, credentials, process.platform === 'win32' ? 'junction' : 'dir');
    const store = new OAuthCredentialStore(join(credentials, 'session.enc'));

    await expect(store.load()).rejects.toMatchObject({ kind: 'filesystem' });
    await expect(store.clear()).rejects.toMatchObject({ kind: 'filesystem' });
    await expect(store.save(record)).rejects.toMatchObject({ kind: 'filesystem' });
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside ciphertext');
  });


  it('never writes plaintext when secure encryption is unavailable, while clear stays available', async () => {
    const store = new OAuthCredentialStore(filePath);
    safeStorageMock.isAsyncEncryptionAvailable.mockResolvedValue(false);

    await expect(store.save(record)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(filePath, Buffer.from('stale ciphertext'), { mode: 0o600 });
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
