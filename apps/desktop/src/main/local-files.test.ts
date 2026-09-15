import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSafeLocalDownloadName, LocalFiles } from './local-files';

const nativeDialog = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: nativeDialog }));

let root: string;
let allowed: string;
const window = {} as BrowserWindow;
beforeEach(async () => {
  nativeDialog.showOpenDialog.mockClear();
  root = await realpath(await mkdtemp(join(tmpdir(), 'jms-local-grant-')));
  allowed = join(root, 'allowed');
  await mkdir(allowed);
  await writeFile(join(allowed, 'readme.txt'), 'within grant');
  await writeFile(join(root, 'private.txt'), 'outside grant');
  nativeDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [allowed] });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });


describe('local directory authorization', () => {
  it('opens and reuses a canonical home grant without a directory dialog', async () => {
    const files = new LocalFiles();
    const first = await files.home(allowed);
    const second = await files.home(allowed);

    expect(first.directoryPath).toBe(allowed);
    expect(second.grantId).toBe(first.grantId);
    expect(nativeDialog.showOpenDialog).not.toHaveBeenCalled();

    files.clear();
    await expect(files.list(first.grantId, '')).rejects.toThrow();
  });

  it('navigates relative and absolute paths within a grant, and leaves it unchanged when outside selection is canceled', async () => {
    await mkdir(join(allowed, 'nested'));
    const files = new LocalFiles();
    const initial = await files.pick(window);
    const nested = await files.navigate(window, initial!.grantId, initial!.relativePath, 'nested');
    const absolute = await files.navigate(window, initial!.grantId, nested!.relativePath, join(allowed, 'nested'));

    expect(nested).toMatchObject({ grantId: initial!.grantId, directoryPath: join(allowed, 'nested'), relativePath: 'nested' });
    expect(absolute).toMatchObject({ grantId: initial!.grantId, directoryPath: join(allowed, 'nested'), relativePath: 'nested' });
    await expect(files.navigate(window, initial!.grantId, nested!.relativePath, 'missing')).rejects.toThrow();

    nativeDialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(files.navigate(window, initial!.grantId, initial!.relativePath, '..')).resolves.toBeNull();
    expect(nativeDialog.showOpenDialog).toHaveBeenLastCalledWith(window, expect.objectContaining({ defaultPath: root }));
    expect((await files.list(initial!.grantId, initial!.relativePath)).directoryPath).toBe(allowed);
  });
  it('lists authorized files but rejects traversal and symlink escape', async () => {
    await symlink(join(root, 'private.txt'), join(allowed, 'external-link'));
    const files = new LocalFiles();
    const listing = await files.pick(window);
    expect(listing?.entries.map(entry => [entry.name, entry.type])).toEqual([
      ['external-link', 'link'], ['readme.txt', 'file']
    ]);
    const grantId = listing!.grantId;
    expect(await files.resolve(grantId, 'readme.txt')).toBe(join(allowed, 'readme.txt'));
    await expect(files.resolve(grantId, '../private.txt')).rejects.toThrow();
    await expect(files.resolve(grantId, 'external-link')).rejects.toThrow();
    await expect(files.resolve(grantId, join(root, 'private.txt'))).rejects.toThrow();
  });
  it('rejects Windows device and namespace names before constructing a local download target', () => {
    for (const name of ['CON', 'nul.txt', 'COM1.log', 'COM¹', 'LPT9', 'LPT³.txt', 'notes:final', 'notes?.txt', 'trailing.']) {
      expect(isSafeLocalDownloadName(name, 'win32')).toBe(false);
    }
    expect(isSafeLocalDownloadName('notes.txt', 'win32')).toBe(true);
  });

  it('downloads only new names into existing authorized directories', async () => {
    await symlink(root, join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const files = new LocalFiles();
    const listing = await files.pick(window);
    const grantId = listing!.grantId;
    expect(await files.downloadTarget(grantId, '', 'download.txt')).toBe(join(allowed, 'download.txt'));
    await expect(files.downloadTarget(grantId, '', 'readme.txt')).rejects.toThrow();
    await expect(files.downloadTarget(grantId, '', '../private.txt')).rejects.toThrow();
    await expect(files.downloadTarget(grantId, 'escape', 'download.txt')).rejects.toThrow();
    await expect(files.downloadTarget(grantId, 'readme.txt', 'download.txt')).rejects.toThrow();
    files.clear();
    await expect(files.downloadTarget(grantId, '', 'download.txt')).rejects.toThrow();
  });

  it('scopes grants to the window and revokes them on identity change', async () => {
    const files = new LocalFiles();
    const first = await files.pick(window);
    const second = await files.pick(window);
    expect((await files.list(first!.grantId, '')).entries[0]?.name).toBe('readme.txt');
    expect((await files.list(second!.grantId, '')).entries[0]?.name).toBe('readme.txt');
    files.clear();
    await expect(files.list(first!.grantId, '')).rejects.toThrow();
    await expect(files.list(second!.grantId, '')).rejects.toThrow();
  });
});
