import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import type { AppUpdateState } from '../../../../packages/desktop-contract/src/index';
import { AppUpdateService } from './updater';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  disableWebInstaller = false;
  checkForUpdates = vi.fn();
  downloadUpdate = vi.fn();
  quitAndInstall = vi.fn();
}

function automaticUpdates(updater: FakeUpdater, published: AppUpdateState[], installFailed?: () => void): AppUpdateService {
  return new AppUpdateService({
    currentVersion: '0.1.0',
    development: false,
    platform: 'win32',
    updater: updater as unknown as AppUpdater,
    publish: state => published.push(state),
    installFailed,
    openExternal: async () => {}
  });
}

describe('app update lifecycle', () => {
  it('checks manual macOS updates but refuses automatic download or installation', async () => {
    const updater = new FakeUpdater();
    const updates = new AppUpdateService({
      currentVersion: '0.1.0',
      development: false,
      platform: 'darwin',
      updater: updater as unknown as AppUpdater,
      publish: () => {},
      openExternal: async () => {}
    });

    updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    await expect(updates.check()).resolves.toMatchObject({ mode: 'manual', reason: 'unsigned-macos', phase: 'available', latestVersion: '0.2.0' });
    await expect(updates.download()).resolves.toMatchObject({ mode: 'manual', phase: 'available' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updates.install()).toBe(false);

    updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    await expect(updates.check()).resolves.toMatchObject({ mode: 'manual', phase: 'not-available' });
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await expect(updates.check()).resolves.toMatchObject({ mode: 'manual', phase: 'error', error: 'offline' });
    updater.checkForUpdates.mockResolvedValueOnce(null);
    await expect(updates.check()).resolves.toMatchObject({ mode: 'manual', phase: 'error', error: '更新检查当前不可用，请稍后重试。' });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(4);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('propagates release-page failures without replacing a downloaded update', async () => {
    const updater = new FakeUpdater();
    const updates = new AppUpdateService({
      currentVersion: '0.1.0',
      development: false,
      platform: 'win32',
      updater: updater as unknown as AppUpdater,
      publish: () => {},
      openExternal: async () => { throw new Error('browser unavailable'); }
    });

    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '0.2.0' });
    updater.emit('update-downloaded', { version: '0.2.0' });
    await expect(updates.openRelease()).rejects.toThrow('browser unavailable');
    expect(updates.snapshot()).toMatchObject({ phase: 'downloaded', latestVersion: '0.2.0' });
  });

  it('coalesces update work and does not let late check events replace download state', async () => {
    const updater = new FakeUpdater();
    const published: AppUpdateState[] = [];
    const updates = automaticUpdates(updater, published);
    let finishCheck: (result: UpdateCheckResult | null) => void = () => {};
    updater.checkForUpdates.mockImplementation(() => new Promise<UpdateCheckResult | null>(resolve => { finishCheck = resolve; }));

    const firstCheck = updates.check();
    const secondCheck = updates.check();
    expect(secondCheck).toBe(firstCheck);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit('update-available', { version: '0.2.0' });
    finishCheck({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    await expect(firstCheck).resolves.toMatchObject({ phase: 'available', latestVersion: '0.2.0' });

    let finishDownload: () => void = () => {};
    updater.downloadUpdate.mockImplementation(() => new Promise<string[]>(resolve => { finishDownload = () => resolve([]); }));
    const firstDownload = updates.download();
    const secondDownload = updates.download();
    expect(secondDownload).toBe(firstDownload);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    updater.emit('download-progress', { percent: 25 });
    updater.emit('update-not-available', { version: '0.2.0' });
    expect(updates.snapshot()).toMatchObject({ phase: 'downloading', latestVersion: '0.2.0', progress: 25 });

    finishDownload();
    await expect(firstDownload).resolves.toMatchObject({ phase: 'downloaded', latestVersion: '0.2.0' });
    updater.emit('error', new Error('late updater error'));
    expect(updates.snapshot()).toMatchObject({ phase: 'downloaded', latestVersion: '0.2.0' });
    expect(published.filter(state => state.phase === 'error')).toHaveLength(0);
  });

  it('can only request installation after an explicit downloaded state', () => {
    const updater = new FakeUpdater();
    const updates = automaticUpdates(updater, []);

    expect(updates.install()).toBe(false);
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '0.2.0' });
    updater.emit('update-downloaded', { version: '0.2.0' });

    expect(updates.install()).toBe(true);
    expect(updates.install()).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('reports installer error events and allows retry after synchronous or delayed failures', () => {
    const updater = new FakeUpdater();
    const published: AppUpdateState[] = [];
    const installFailed = vi.fn();
    const updates = automaticUpdates(updater, published, installFailed);
    const ready = () => {
      updater.emit('checking-for-update');
      updater.emit('update-available', { version: '0.2.0' });
      updater.emit('update-downloaded', { version: '0.2.0' });
    };
    ready();
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit('error', new Error('Installer permission denied'));
    });
    expect(updates.install()).toBe(false);
    expect(updates.snapshot()).toMatchObject({ phase: 'error', error: 'Installer permission denied' });
    expect(published.at(-1)?.phase).toBe('error');
    expect(installFailed).toHaveBeenCalledTimes(1);

    ready();
    expect(updates.install()).toBe(true);
    updater.emit('error', new Error('Installer process could not start'));
    expect(published.at(-1)).toMatchObject({ phase: 'error', error: 'Installer process could not start' });
    expect(installFailed).toHaveBeenCalledTimes(2);
    ready();
    expect(updates.isInstallReady()).toBe(true);
  });
});
