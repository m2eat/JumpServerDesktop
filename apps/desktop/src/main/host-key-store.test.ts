import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostKeyStore, HostKeyStoreError } from './host-key-store';

const firstFingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const secondFingerprint = 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jumpserver-host-keys-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SSH host-key trust store', () => {
  it('atomically preserves concurrent site-and-endpoint fingerprint approvals without credentials', async () => {
    const path = join(root, 'credentials', 'ssh-host-keys.json');
    const store = new HostKeyStore(path);
    const firstKey = 'https://jump.example/gateway\u0000gateway.example\u00002222';
    const secondKey = 'https://jump.example/gateway\u0000gateway.example\u00002223';

    const firstWrite = store.remember(firstKey, firstFingerprint);
    const observedDuringWrite = store.fingerprintFor(firstKey);
    const secondWrite = store.remember(secondKey, secondFingerprint);
    await Promise.all([firstWrite, secondWrite]);

    await expect(observedDuringWrite).resolves.toBe(firstFingerprint);
    const restored = new HostKeyStore(path);
    await expect(restored.fingerprintFor(firstKey)).resolves.toBe(firstFingerprint);
    await expect(restored.fingerprintFor(secondKey)).resolves.toBe(secondFingerprint);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored).toEqual({
      version: 1,
      fingerprints: { [firstKey]: firstFingerprint, [secondKey]: secondFingerprint }
    });
    if (process.platform !== 'win32') {
      expect((await lstat(path)).mode & 0o077).toBe(0);
    }
  });


  it('does not trust a fingerprint when its atomic write fails', async () => {
    const path = join(root, 'ssh-host-keys.json');
    const store = new HostKeyStore(path);
    await store.fingerprintFor('https://jump.example\u0000gateway.example\u00002222');
    await mkdir(path);

    await expect(store.remember('https://jump.example\u0000gateway.example\u00002222', firstFingerprint))
      .rejects.toBeInstanceOf(HostKeyStoreError);
    await expect(store.fingerprintFor('https://jump.example\u0000gateway.example\u00002222')).resolves.toBeUndefined();
  });
  it('rejects a symbolic-link credentials directory instead of writing a trust record outside it', async () => {
    const credentials = join(root, 'credentials');
    const outside = join(root, 'outside');
    const path = join(credentials, 'ssh-host-keys.json');
    await mkdir(outside);
    await symlink(outside, credentials, process.platform === 'win32' ? 'junction' : 'dir');

    const store = new HostKeyStore(path);
    await expect(store.fingerprintFor('https://jump.example\u0000gateway.example\u00002222'))
      .rejects.toBeInstanceOf(HostKeyStoreError);
    await expect(store.remember('https://jump.example\u0000gateway.example\u00002222', firstFingerprint))
      .rejects.toBeInstanceOf(HostKeyStoreError);
    await expect(readFile(join(outside, 'ssh-host-keys.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symbolic-link trust record instead of following it', async () => {
    const path = join(root, 'ssh-host-keys.json');
    const target = join(root, 'outside.json');
    await writeFile(target, JSON.stringify({ version: 1, fingerprints: {} }));
    await symlink(target, path);

    await expect(new HostKeyStore(path).fingerprintFor('https://jump.example\u0000gateway.example\u00002222'))
      .rejects.toBeInstanceOf(HostKeyStoreError);
  });
});
