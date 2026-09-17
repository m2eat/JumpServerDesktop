import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import type { AppUpdateState, PreferenceSettings } from '../../../../packages/desktop-contract/src/index';
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

function updatePreferences(overrides: Partial<Pick<PreferenceSettings, 'autoCheckUpdates' | 'autoDownloadUpdates'>> = {}): Pick<PreferenceSettings, 'autoCheckUpdates' | 'autoDownloadUpdates'> {
  return { autoCheckUpdates: true, autoDownloadUpdates: false, ...overrides };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

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
    await expect(updates.check()).resolves.toMatchObject({ mode: 'manual', phase: 'error', error: expect.any(String) });
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

  it('schedules an initial automatic check once and then checks every six hours', async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const updates = automaticUpdates(updater, []);
    updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);

    updates.configure(updatePreferences());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    updates.configure(updatePreferences());
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000 - 1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('downloads updates found by opt-in automatic checks without requesting installation', async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const updates = automaticUpdates(updater, []);
    updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    updater.downloadUpdate.mockResolvedValueOnce([]);

    updates.configure(updatePreferences({ autoDownloadUpdates: true }));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updates.snapshot()).toMatchObject({ phase: 'downloaded', latestVersion: '0.2.0' });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('begins a download when the opt-in is enabled for an already available update', async () => {
    const updater = new FakeUpdater();
    const updates = automaticUpdates(updater, []);
    updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    updater.downloadUpdate.mockResolvedValueOnce([]);

    updates.configure(updatePreferences({ autoCheckUpdates: false }));
    await updates.check();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    updates.configure(updatePreferences({ autoCheckUpdates: false, autoDownloadUpdates: true }));
    await Promise.resolve();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updates.snapshot()).toMatchObject({ phase: 'downloaded', latestVersion: '0.2.0' });
  });

  it('coalesces a download requested while a check is in flight', async () => {
    const updater = new FakeUpdater();
    const updates = automaticUpdates(updater, []);
    const checking = deferred<UpdateCheckResult | null>();
    updater.checkForUpdates.mockReturnValueOnce(checking.promise);
    updater.downloadUpdate.mockResolvedValueOnce([]);

    const check = updates.check();
    const firstDownload = updates.download();
    const secondDownload = updates.download();
    expect(secondDownload).toBe(firstDownload);

    checking.resolve({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    await expect(check).resolves.toMatchObject({ phase: 'available', latestVersion: '0.2.0' });
    await expect(firstDownload).resolves.toMatchObject({ phase: 'downloaded', latestVersion: '0.2.0' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('cancels disabled automatic work and prevents a disposed check from starting a download', async () => {
    vi.useFakeTimers();
    const cancelledUpdater = new FakeUpdater();
    const cancelledUpdates = automaticUpdates(cancelledUpdater, []);
    cancelledUpdates.configure(updatePreferences());
    cancelledUpdates.configure(updatePreferences({ autoCheckUpdates: false }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cancelledUpdater.checkForUpdates).not.toHaveBeenCalled();

    const updater = new FakeUpdater();
    const updates = automaticUpdates(updater, []);
    const checking = deferred<UpdateCheckResult | null>();
    updater.checkForUpdates.mockReturnValueOnce(checking.promise);
    updates.configure(updatePreferences({ autoDownloadUpdates: true }));

    await vi.advanceTimersByTimeAsync(15_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updates.configure(updatePreferences({ autoCheckUpdates: false, autoDownloadUpdates: false }));
    checking.resolve({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    const disposedUpdater = new FakeUpdater();
    const disposedUpdates = automaticUpdates(disposedUpdater, []);
    const disposedCheck = deferred<UpdateCheckResult | null>();
    disposedUpdater.checkForUpdates.mockReturnValueOnce(disposedCheck.promise);
    disposedUpdates.configure(updatePreferences({ autoDownloadUpdates: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    disposedUpdates.dispose();
    disposedCheck.resolve({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(disposedUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('does not auto-download manual or disabled platform updates', async () => {
    vi.useFakeTimers();
    const manualUpdater = new FakeUpdater();
    const manualUpdates = new AppUpdateService({
      currentVersion: '0.1.0',
      development: false,
      platform: 'darwin',
      updater: manualUpdater as unknown as AppUpdater,
      publish: () => {},
      openExternal: async () => {}
    });
    manualUpdater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } } as UpdateCheckResult);
    manualUpdates.configure(updatePreferences({ autoDownloadUpdates: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(manualUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(manualUpdater.downloadUpdate).not.toHaveBeenCalled();

    const disabledUpdater = new FakeUpdater();
    const disabledUpdates = new AppUpdateService({
      currentVersion: '0.1.0',
      development: true,
      platform: 'win32',
      updater: disabledUpdater as unknown as AppUpdater,
      publish: () => {},
      openExternal: async () => {}
    });
    disabledUpdates.configure(updatePreferences({ autoDownloadUpdates: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(disabledUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(disabledUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});
