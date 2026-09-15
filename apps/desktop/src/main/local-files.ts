import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { LocalListing } from '../../../../packages/desktop-contract/src/index';
import { nativeText } from '../../../../packages/desktop-contract/src/native-i18n';

interface LocalGrant {
  root: string;
}
const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

export function isSafeLocalDownloadName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/\u0000-\u001f\u007f]/.test(name) &&
    (
      platform !== 'win32' ||
      (!/[<>:"|?*]/.test(name) && !/[. ]$/.test(name) && !windowsReservedName.test(name))
    )
  );
}


export class LocalFiles {
  private grants = new Map<string, LocalGrant>();
  private generation = 0;
  private homeGrantId: string | undefined;

  clear(): void {
    this.generation++;
    this.grants.clear();
    this.homeGrantId = undefined;
  }

  async home(homePath = homedir()): Promise<LocalListing> {
    const generation = this.generation;
    const root = await realpath(homePath);
    this.assertGeneration(generation);
    const grantId = this.homeGrantId;
    const grant = grantId ? this.grants.get(grantId) : undefined;
    if (grant?.root === root) return this.list(grantId!, '');

    const listing = await this.authorize(root, generation);
    this.homeGrantId = listing.grantId;
    return listing;
  }

  async pick(window: BrowserWindow, defaultPath?: string, expectedGeneration = this.generation): Promise<LocalListing | null> {
    this.assertGeneration(expectedGeneration);
    const selection = await dialog.showOpenDialog(window, {
      title: nativeText('授权浏览一个本地目录'),
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    this.assertGeneration(expectedGeneration);
    const root = await realpath(selection.filePaths[0]);
    this.assertGeneration(expectedGeneration);
    return this.authorize(root, expectedGeneration);
  }

  async navigate(window: BrowserWindow, grantId: string, relativePath: string, path: string): Promise<LocalListing | null> {
    const generation = this.generation;
    const grant = this.requireGrant(grantId);
    const currentDirectory = await this.resolve(grantId, relativePath);
    if (generation !== this.generation || this.grants.get(grantId) !== grant) throw new Error('本地目录授权已失效');
    const candidate = this.navigationTarget(currentDirectory, path);
    if (!this.isWithin(grant.root, candidate)) return this.pick(window, candidate, generation);

    const target = await realpath(candidate);
    if (generation !== this.generation || this.grants.get(grantId) !== grant) throw new Error('本地目录授权已失效');
    if (!this.isWithin(grant.root, target)) return this.pick(window, target, generation);
    return this.list(grantId, relative(grant.root, target));
  }

  async resolve(grantId: string, path: string): Promise<string> {
    const grant = this.requireGrant(grantId);
    if (isAbsolute(path) || /[\u0000-\u001f]/.test(path)) throw new Error('本地路径不合法');
    const candidate = resolve(grant.root, path);
    if (!this.isWithin(grant.root, candidate)) throw new Error('拒绝访问授权目录之外的路径');
    const target = await realpath(candidate);
    if (!this.isWithin(grant.root, target)) throw new Error('拒绝访问授权目录之外的路径');
    if (this.grants.get(grantId) !== grant) throw new Error('本地目录授权已失效');
    return target;
  }

  async downloadTarget(grantId: string, relativePath: string, name: string): Promise<string> {
    const generation = this.generation;
    const directory = await this.resolve(grantId, relativePath);
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error('本地目录授权已失效');
    if (!isSafeLocalDownloadName(name)) throw new Error('下载文件名不合法');
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('下载目标必须是授权目录内的现有目录');
    const target = resolve(directory, name);
    if (relative(directory, target) !== name) throw new Error('下载目标不在授权目录内');
    try {
      await lstat(target);
      throw new Error('本地已有同名文件，未覆盖');
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
        // The worker performs the authoritative atomic no-overwrite commit after this early conflict check.
      } else {
        throw cause;
      }
    }
    if (generation !== this.generation || this.grants.get(grantId) !== grant) throw new Error('本地目录授权已失效');
    return target;
  }

  async list(grantId: string, path: string): Promise<LocalListing> {
    const generation = this.generation;
    const directory = await this.resolve(grantId, path);
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error('本地目录授权已失效');
    const entries: LocalListing['entries'] = [];
    for await (const entry of await opendir(directory)) {
      if (entries.length >= 10000) throw new Error('目录超过 10,000 项，请选择更小的目录范围');
      const full = resolve(directory, entry.name);
      const info = await lstat(full, { bigint: true });
      entries.push({ name: entry.name, relativePath: relative(grant.root, full), type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file', size: info.size.toString(), modified: new Date(Number(info.mtimeMs)).toISOString() });
    }
    if (generation !== this.generation || this.grants.get(grantId) !== grant) throw new Error('本地目录授权已失效');
    entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
    return {
      grantId,
      directoryName: basename(grant.root) || grant.root,
      directoryPath: directory,
      relativePath: relative(grant.root, directory),
      entries
    };
  }

  private async authorize(root: string, generation: number): Promise<LocalListing> {
    this.assertGeneration(generation);
    const grantId = randomUUID();
    const grant = { root };
    this.grants.set(grantId, grant);
    try {
      return await this.list(grantId, '');
    } catch (cause) {
      if (this.grants.get(grantId) === grant) this.grants.delete(grantId);
      throw cause;
    }
  }

  private navigationTarget(currentDirectory: string, path: string): string {
    if (path.length === 0 || /[\u0000-\u001f]/.test(path)) throw new Error('本地路径不合法');
    if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2));
    return isAbsolute(path) ? resolve(path) : resolve(currentDirectory, path);
  }

  private requireGrant(grantId: string): LocalGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error('本地目录授权已失效');
    return grant;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('身份已变化，请重新选择目录');
  }


  private isWithin(root: string, target: string): boolean {
    const delta = relative(root, target);
    return delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
  }
}
