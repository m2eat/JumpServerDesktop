import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { AppUpdateState } from '../../../../packages/desktop-contract/src/index';

const RELEASE_PAGE = 'https://github.com/m2eat/JumpServerDesktop/releases/latest';

function trustedReleasePage(): string {
  const url = new URL(RELEASE_PAGE);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.pathname !== '/m2eat/JumpServerDesktop/releases/latest') {
    throw new Error('更新发布页配置不受信任');
  }
  return url.toString();
}

export const trustedReleaseUrl = trustedReleasePage();

type UpdateMode = Pick<AppUpdateState, 'mode' | 'reason'>;
type StateDetails = Omit<AppUpdateState, 'currentVersion' | 'mode' | 'reason' | 'releaseUrl'>;

export interface AppUpdateServiceOptions {
  currentVersion: string;
  development: boolean;
  platform: NodeJS.Platform;
  appImage?: string;
  publish: (state: AppUpdateState) => void;
  openExternal: (url: string) => Promise<void>;
  installFailed?: () => void;
  updater: AppUpdater;
}

function modeFor(options: Pick<AppUpdateServiceOptions, 'development' | 'platform' | 'appImage'>): UpdateMode {
  if (options.development) return { mode: 'disabled', reason: 'development' };
  if (options.platform === 'darwin') return { mode: 'manual', reason: 'unsigned-macos' };
  if (options.platform === 'linux') return options.appImage
    ? { mode: 'automatic' }
    : { mode: 'manual', reason: 'linux-package' };
  if (options.platform === 'win32') return { mode: 'automatic' };
  return { mode: 'disabled', reason: 'unsupported-platform' };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 2_000);
  return '更新操作失败，请稍后重试。';
}

function updateVersion(info: UpdateInfo): string | undefined {
  const version = info.version;
  if (typeof version !== 'string' || version.length === 0 || version.length > 100) return undefined;
  return version;
}

/** Owns one renderer window's safe view of electron-updater. */
export class AppUpdateService {
  private readonly mode: UpdateMode;
  private state: AppUpdateState;
  private checkInFlight: Promise<AppUpdateState> | undefined;
  private downloadInFlight: Promise<AppUpdateState> | undefined;
  private installRequested = false;
  private listening = false;
  private disposed = false;

  private readonly onChecking = (): void => {
    if (this.state.phase === 'idle' || this.state.phase === 'not-available' || this.state.phase === 'error' || this.state.phase === 'available') this.replace({ phase: 'checking' });
  };
  private readonly onAvailable = (info: UpdateInfo): void => {
    if (this.state.phase !== 'checking') return;
    const latestVersion = updateVersion(info);
    if (!latestVersion) {
      this.fail(new Error('更新元数据缺少版本号'));
      return;
    }
    this.replace({ phase: 'available', latestVersion });
  };
  private readonly onNotAvailable = (): void => {
    if (this.state.phase === 'checking') this.replace({ phase: 'not-available' });
  };
  private readonly onProgress = (progress: ProgressInfo): void => {
    if (this.mode.mode !== 'automatic' || this.state.phase !== 'downloading' || !Number.isFinite(progress.percent)) return;
    this.replace({ phase: 'downloading', latestVersion: this.state.latestVersion, progress: Math.max(0, Math.min(100, progress.percent)) });
  };
  private readonly onDownloaded = (info: UpdateInfo): void => {
    if (this.mode.mode !== 'automatic' || (this.state.phase !== 'downloading' && this.state.phase !== 'available')) return;
    const latestVersion = updateVersion(info) ?? this.state.latestVersion;
    this.replace({ phase: 'downloaded', ...(latestVersion ? { latestVersion } : {}) });
  };
  private readonly onError = (error: Error): void => {
    if (this.installRequested) {
      this.installRequested = false;
      this.fail(error);
      this.options.installFailed?.();
    } else if (this.state.phase === 'checking' || this.state.phase === 'downloading') this.fail(error);
  };

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.mode = modeFor(options);
    this.state = this.makeState({ phase: 'idle' });
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    if (this.mode.mode === 'disabled') return;

    options.updater.allowPrerelease = false;
    options.updater.allowDowngrade = false;
    options.updater.disableWebInstaller = true;
    options.updater.on('checking-for-update', this.onChecking);
    options.updater.on('update-available', this.onAvailable);
    options.updater.on('update-not-available', this.onNotAvailable);
    options.updater.on('download-progress', this.onProgress);
    options.updater.on('update-downloaded', this.onDownloaded);
    options.updater.on('error', this.onError);
    this.listening = true;
  }

  snapshot(): AppUpdateState {
    return { ...this.state };
  }

  isInstallReady(): boolean {
    return this.mode.mode === 'automatic' && this.state.phase === 'downloaded' && !this.installRequested;
  }

  check(): Promise<AppUpdateState> {
    if (this.checkInFlight) return this.checkInFlight;
    if (this.mode.mode === 'disabled' || this.state.phase === 'downloading' || this.state.phase === 'downloaded') return Promise.resolve(this.snapshot());

    const inFlight = this.runCheck();
    this.checkInFlight = inFlight;
    void inFlight.then(() => {
      if (this.checkInFlight === inFlight) this.checkInFlight = undefined;
    });
    return inFlight;
  }

  download(): Promise<AppUpdateState> {
    if (this.downloadInFlight) return this.downloadInFlight;
    if (this.mode.mode !== 'automatic' || this.state.phase === 'downloaded' || this.state.phase === 'downloading') return Promise.resolve(this.snapshot());
    if (this.checkInFlight) return this.checkInFlight.then(() => this.download());
    if (this.state.phase !== 'available') return Promise.resolve(this.snapshot());

    const inFlight = this.runDownload();
    this.downloadInFlight = inFlight;
    void inFlight.then(() => {
      if (this.downloadInFlight === inFlight) this.downloadInFlight = undefined;
    });
    return inFlight;
  }

  install(): boolean {
    if (!this.isInstallReady()) return false;
    this.installRequested = true;
    try {
      this.options.updater.quitAndInstall(false, true);
      return this.installRequested;
    } catch (error) {
      this.installRequested = false;
      this.fail(error);
      this.options.installFailed?.();
      return false;
    }
  }

  openRelease(): Promise<void> {
    return this.options.openExternal(trustedReleaseUrl);
  }

  dispose(): void {
    if (this.listening) {
      this.options.updater.removeListener('checking-for-update', this.onChecking);
      this.options.updater.removeListener('update-available', this.onAvailable);
      this.options.updater.removeListener('update-not-available', this.onNotAvailable);
      this.options.updater.removeListener('download-progress', this.onProgress);
      this.options.updater.removeListener('update-downloaded', this.onDownloaded);
      this.options.updater.removeListener('error', this.onError);
    }
    this.listening = false;
    this.disposed = true;
  }

  private async runCheck(): Promise<AppUpdateState> {
    this.replace({ phase: 'checking' });
    try {
      const result = await this.options.updater.checkForUpdates();
      if (this.state.phase === 'checking') {
        if (!result) this.fail(new Error('更新检查当前不可用，请稍后重试。'));
        else {
          const latestVersion = result.isUpdateAvailable ? updateVersion(result.updateInfo) : undefined;
          if (result.isUpdateAvailable && !latestVersion) this.fail(new Error('更新元数据缺少版本号'));
          else this.replace(latestVersion ? { phase: 'available', latestVersion } : { phase: 'not-available' });
        }
      }
    } catch (error) {
      if (this.state.phase === 'checking') this.fail(error);
    }
    return this.snapshot();
  }

  private async runDownload(): Promise<AppUpdateState> {
    const latestVersion = this.state.latestVersion;
    this.replace({ phase: 'downloading', ...(latestVersion ? { latestVersion } : {}), progress: 0 });
    try {
      await this.options.updater.downloadUpdate();
      if (this.state.phase === 'downloading') this.replace({ phase: 'downloaded', ...(latestVersion ? { latestVersion } : {}) });
    } catch (error) {
      if (this.state.phase === 'downloading') this.fail(error);
    }
    return this.snapshot();
  }

  private fail(error: unknown): void {
    const message = errorMessage(error);
    if (this.state.phase === 'error' && this.state.error === message) return;
    this.replace({ phase: 'error', ...(this.state.latestVersion ? { latestVersion: this.state.latestVersion } : {}), error: message });
  }

  private makeState(details: StateDetails): AppUpdateState {
    return {
      currentVersion: this.options.currentVersion,
      mode: this.mode.mode,
      ...(this.mode.reason ? { reason: this.mode.reason } : {}),
      ...(this.mode.mode !== 'disabled' ? { releaseUrl: trustedReleaseUrl } : {}),
      ...details
    };
  }

  private replace(details: StateDetails): void {
    this.state = this.makeState(details);
    if (!this.disposed) this.options.publish(this.snapshot());
  }
}

export function createAppUpdateService(options: Omit<AppUpdateServiceOptions, 'updater'>): AppUpdateService {
  // electron-updater is CommonJS; its default import keeps Electron's ESM output compatible.
  const { autoUpdater } = electronUpdater;
  return new AppUpdateService({ ...options, updater: autoUpdater });
}
