import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, shell } from 'electron';
import type { MessagePortMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { join, resolve } from 'node:path';
import { createAuthRuntime } from './auth';
import { listInstalledFonts } from './fonts';
import { OAuthBrowser } from './oauth-browser';
import { LocalFiles } from './local-files';
import { SessionRegistry } from './session-registry';
import { createAppUpdateService } from './updater';
import { createSshService } from '../../../../packages/adapters-jumpserver/src/ssh/index';
import { createChenService } from '../../../../packages/adapters-jumpserver/src/chen/index';
import { parseContext } from '../../../../packages/adapters-jumpserver/src/core/schemas';
import type { AppEvent, CommandName, SessionInfo } from '../../../../packages/desktop-contract/src/index';
import type { Preferences, Snapshot } from '../../../../packages/desktop-contract/src/index';
import { nativeText, setNativeLanguage } from '../../../../packages/desktop-contract/src/native-i18n';
import { z } from 'zod';

const sessionArgs = z.object({ sessionId: z.string().min(1).max(200) });
const emptyArgs = z.object({}).strict();
const contextSchema = z.unknown().transform(parseContext);
const commands: Readonly<Record<CommandName, true>> = {
  'app.bootstrap': true,
  'app.fonts': true,
  'app.updates': true,
  'app.checkUpdate': true,
  'app.downloadUpdate': true,
  'app.installUpdate': true,
  'app.openRelease': true,
  'site.save': true,
  'site.remove': true,
  'auth.login': true,
  'auth.cancel': true,
  'auth.logout': true,
  'assets.list': true,
  'assets.options': true,
  'session.open': true,
  'session.close': true,
  'session.detach': true,
  'session.attach': true,
  'session.dirty': true,
  'terminal.input': true,
  'terminal.resize': true,
  'terminal.ack': true,
  'files.list': true,
  'files.mkdir': true,
  'files.rename': true,
  'files.remove': true,
  'files.upload': true,
  'files.download': true,
  'files.uploadLocal': true,
  'files.downloadLocal': true,
  'files.copy': true,
  'files.readText': true,
  'files.saveText': true,
  'local.pick': true,
  'local.home': true,
  'local.navigate': true,
  'local.list': true,
  'tasks.cancel': true,
  'db.tree': true,
  'db.query': true,
  'db.cancel': true,
  'db.table': true,
  'db.preview': true,
  'db.apply': true,
  'preferences.save': true
};
const development = !app.isPackaged || process.env.JMS_DEV_MODE === '1';
app.setName(development ? 'JumpServer Desktop Dev' : 'JumpServer Desktop');
if (development) {
  const profile = process.env.JMS_DEV_USER_DATA ? resolve(process.env.JMS_DEV_USER_DATA) : join(app.getPath('appData'), 'JumpServer Desktop Dev');
  app.setPath('userData', profile);
  app.setPath('sessionData', join(profile, 'Chromium'));
}
if (process.env.JMS_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.JMS_DEBUG_PORT);
const oauthBrowser = new OAuthBrowser();
const primaryInstance = app.requestSingleInstanceLock();
// Electron handles SIGTERM natively; async close cleanup cannot finish during a watched restart.
if (development) app.on('before-quit', () => {
  app.releaseSingleInstanceLock();
  app.exit(0);
});
const receiveCallback = (url: string) => {
  if (!oauthBrowser.receiveCallback(url)) return;
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
};
// macOS can deliver open-url before ready. Unsolicited callbacks never start a login.
app.on('open-url', (event, url) => { event.preventDefault(); receiveCallback(url); });
app.on('second-instance', (_event, args) => {
  for (const arg of args) if (arg.startsWith('jms:')) receiveCallback(arg);
});
if (primaryInstance) for (const arg of process.argv) if (arg.startsWith('jms:')) receiveCallback(arg);
if (!primaryInstance) app.quit();

async function createWindow(): Promise<void> {
  await setNativeLanguage('system', app.getLocale());
  const window = new BrowserWindow({ width: 1440, height: 900, minWidth: 1024, minHeight: 680, show: false, backgroundColor: '#1e2031', title: 'JumpServer Desktop', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 21 } } : {}), webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  const localFiles = new LocalFiles();
  let eventPort: MessagePortMain | undefined;
  const registry = new SessionRegistry(
    session => session.kind === 'database' ? chen.close(session.id) : ssh.close(session.id),
    event => {
      if (!window.isDestroyed()) eventPort?.postMessage(event);
    }
  );
  const emit = (event: AppEvent): void => registry.accept(event);
  let installRecoveryRequested = false;
  const recoverFromInstallFailure = (): void => {
    if (installRecoveryRequested) return;
    installRecoveryRequested = true;
    // Authentication storage is already closed; restart rather than unlock a disposed runtime.
    dialog.showErrorBox(nativeText('安装更新并重启'), nativeText('更新安装未能启动，应用将重新打开。请重试或从发布页下载安装包。'));
    app.relaunch();
    app.exit(1);
  };
  const appUpdates = createAppUpdateService({
    currentVersion: app.getVersion(),
    development,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    publish: update => emit({ type: 'update', update }),
    openExternal: url => shell.openExternal(url),
    installFailed: recoverFromInstallFailure
  });
  let exitApproved = false;
  let closePromptPending = false;
  let exitCleanupPending = false;
  const update = (session: SessionInfo): void => emit({ type: 'session', session });
  const auth = createAuthRuntime({ window, emit, update, authorizeInBrowser: (authorization, signal) => oauthBrowser.open(authorization, signal, window), sessions: () => registry.listSessions(), tasks: () => registry.listTasks(), onLogout: async () => {
    localFiles.clear();
    await Promise.allSettled([ssh.closeAll(), chen.closeAll()]);
    registry.clear();
  } });
  const ssh = createSshService(auth.host);
  const chen = createChenService(auth.host);
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  ipcMain.on('desktop:subscribe', event => {
    if (!trusted(event)) return;
    eventPort?.close();
    const channel = new MessageChannelMain();
    eventPort = channel.port1;
    eventPort.start();
    event.senderFrame?.postMessage('desktop:port', null, [channel.port2]);
    eventPort.postMessage({ type: 'update', update: appUpdates.snapshot() });
  });
  ipcMain.handle('desktop:invoke', async (event, command: unknown, raw: unknown) => {
    if (!trusted(event) || typeof command !== 'string' || !Object.hasOwn(commands, command)) throw new Error('请求来源或命令不受信任');
    if (exitCleanupPending) throw new Error('工作台正在为更新关闭，不能执行新的操作');
    if (command === 'app.updates') {
      emptyArgs.parse(raw);
      return appUpdates.snapshot();
    }
    if (command === 'app.checkUpdate') {
      emptyArgs.parse(raw);
      return appUpdates.check();
    }
    if (command === 'app.downloadUpdate') {
      emptyArgs.parse(raw);
      return appUpdates.download();
    }
    if (command === 'app.openRelease') {
      emptyArgs.parse(raw);
      return appUpdates.openRelease();
    }
    if (command === 'app.installUpdate') {
      emptyArgs.parse(raw);
      if (closePromptPending) return;
      closePromptPending = true;
      try {
        if (!appUpdates.isInstallReady()) return;
        const confirmInstall = async (workspaceWillBeDiscarded: boolean): Promise<boolean> => {
          const answer = await dialog.showMessageBox(window, {
            type: 'warning',
            title: nativeText('安装更新并重启'),
            message: nativeText(workspaceWillBeDiscarded ? '安装更新会丢弃未保存编辑、关闭所有连接并停止传输。' : '已下载的更新将在关闭工作台后安装并重新打开应用。'),
            detail: workspaceWillBeDiscarded ? nativeText('已发送的命令或数据库写入不能因断开而保证撤回。取消会保留当前工作区。') : undefined,
            buttons: [nativeText('稍后安装'), nativeText('安装并重启')],
            defaultId: 0,
            cancelId: 0
          });
          return answer.response === 1;
        };
        const workspaceWillBeDiscarded = registry.needsExitConfirmation;
        if (!await confirmInstall(workspaceWillBeDiscarded)) return;
        if (!workspaceWillBeDiscarded && registry.needsExitConfirmation && !await confirmInstall(true)) return;
        if (!appUpdates.isInstallReady()) return;
        exitCleanupPending = true;
        try {
          await auth.dispose();
        } catch {
          emit({ type: 'notice', message: nativeText('退出清理未完成，窗口已保留，请检查连接状态后重试。') });
          return;
        }
        exitApproved = true;
        if (!appUpdates.install()) recoverFromInstallFailure();
      } finally {
        if (!exitApproved) {
          exitCleanupPending = false;
          closePromptPending = false;
        }
      }
      return;
    }
    if (command === 'app.fonts') {
      const args = z.object({ refresh: z.boolean().optional() }).strict().parse(raw);
      return listInstalledFonts(args);
    }
    if (command === 'session.open') {
      const args = z.object({ kind: z.enum(['terminal', 'files', 'database']), context: contextSchema }).strict().parse(raw);
      auth.host.assertContext(args.context);
      if (registry.activeCount >= 16) throw new Error('已达到 16 个活动连接上限，请先关闭其他连接');
      return args.kind === 'database' ? chen.open(args.context) : ssh.open(args.kind, args.context);
    }
    if (command === 'session.close' || command === 'session.detach' || command === 'session.attach' || command === 'session.dirty') {
      const { sessionId } = sessionArgs.parse(raw);
      const session = registry.get(sessionId);
      if (command === 'session.dirty') {
        const { dirty } = sessionArgs.extend({ dirty: z.boolean() }).strict().parse(raw);
        if (session) auth.host.assertContext(session.context);
        registry.setDirty(sessionId, dirty);
        return;
      }
      if (!session && command === 'session.close') return;
      if (!session) throw new Error('会话不存在或已经失效');
      auth.host.assertContext(session.context);
      if (command === 'session.attach') return registry.attach(sessionId);
      if (command === 'session.detach') return registry.detach(sessionId);
      return registry.close(sessionId);
    }
    if (command === 'local.pick') {
      emptyArgs.parse(raw);
      return localFiles.pick(window);
    }
    if (command === 'local.home') {
      emptyArgs.parse(raw);
      return localFiles.home(app.getPath('home'));
    }
    if (command === 'local.navigate') {
      const args = z.object({ grantId: z.string().uuid(), relativePath: z.string().max(4096), path: z.string().max(4096) }).strict().parse(raw);
      return localFiles.navigate(window, args.grantId, args.relativePath, args.path);
    }
    if (command === 'local.list') {
      const args = z.object({ grantId: z.string().uuid(), relativePath: z.string().max(4096) }).strict().parse(raw);
      return localFiles.list(args.grantId, args.relativePath);
    }
    if (command.startsWith('terminal.') || command.startsWith('files.') || command.startsWith('db.')) {
      const { sessionId } = sessionArgs.parse(raw);
      const session = registry.get(sessionId);
      if (!session) throw new Error('会话不存在或已经失效');
      auth.host.assertContext(session.context);
      if (session.phase !== 'active' && command !== 'terminal.ack') throw new Error('连接尚未就绪或已经断开');
      if (command.startsWith('terminal.') && session.kind !== 'terminal') throw new Error('不是终端会话');
      if (command.startsWith('files.') && session.kind !== 'files') throw new Error('不是文件会话');
      if (command.startsWith('db.') && session.kind !== 'database') throw new Error('不是数据库会话');
      if (command === 'files.uploadLocal') {
        const args = sessionArgs.extend({ grantId: z.string().uuid(), relativePaths: z.array(z.string().min(1).max(4096)).min(1).max(1000), path: z.string().min(1).max(4096) }).strict().parse(raw);
        const localPaths = await Promise.all(args.relativePaths.map(path => localFiles.resolve(args.grantId, path)));
        auth.host.assertContext(session.context);
        const current = registry.get(sessionId);
        if (!current || current.kind !== 'files' || current.phase !== 'active') throw new Error('文件会话已经结束');
        return ssh.invoke('files.uploadPaths', { sessionId, path: args.path, localPaths });
      }
      if (command === 'files.downloadLocal') {
        const args = sessionArgs.extend({ grantId: z.string().uuid(), relativePath: z.string().max(4096), path: z.string().min(1).max(4096), name: z.string().min(1).max(255) }).strict().parse(raw);
        const targetPath = await localFiles.downloadTarget(args.grantId, args.relativePath, args.name);
        auth.host.assertContext(session.context);
        const current = registry.get(sessionId);
        if (!current || current.kind !== 'files' || current.phase !== 'active') throw new Error('文件会话已经结束');
        return ssh.invoke(command, { sessionId, path: args.path, name: args.name, targetPath });
      }
      if (command === 'files.copy') {
        const args = sessionArgs.extend({ targetSessionId: z.string().uuid(), path: z.string().min(1).max(4096), targetPath: z.string().min(1).max(4096), name: z.string().min(1).max(255) }).strict().parse(raw);
        const target = registry.get(args.targetSessionId);
        if (!target || target.kind !== 'files' || target.phase !== 'active') throw new Error('目标文件会话不存在、尚未就绪或已经断开');
        auth.host.assertContext(target.context);
        return ssh.invoke(command, args);
      }
      return command.startsWith('db.') ? chen.invoke(command, raw) : ssh.invoke(command, raw);
    }
    if (command === 'tasks.cancel') return ssh.invoke(command, raw);
    const result = await auth.invoke(command, raw);
    if (command === 'app.bootstrap') await setNativeLanguage((result as Snapshot).preferences.language, app.getLocale());
    else if (command === 'preferences.save') await setNativeLanguage((result as Preferences).language, app.getLocale());
    return result;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Only the trusted workbench's main frame may write. Clipboard reads and all other permissions stay denied.
  window.webContents.session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    webContents === window.webContents && permission === 'clipboard-sanitized-write' &&
    details.isMainFrame && details.requestingUrl === window.webContents.getURL()
  );
  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === window.webContents && permission === 'clipboard-sanitized-write' &&
      details.isMainFrame && details.requestingUrl === window.webContents.getURL());
  });
  window.on('close', event => {
    if (exitApproved) return;
    event.preventDefault();
    if (closePromptPending || exitCleanupPending) return;
    closePromptPending = true;
    void (async () => {
      try {
        if (registry.needsExitConfirmation) {
          const answer = await dialog.showMessageBox(window, { type: 'warning', title: nativeText('退出工作台'), message: nativeText('退出将丢弃未保存编辑、关闭所有连接并停止传输。'), detail: nativeText('已发送的命令或数据库写入不能因断开而保证撤回。取消会保留当前工作区。'), buttons: [nativeText('继续工作'), nativeText('丢弃编辑并退出')], defaultId: 0, cancelId: 0 });
          if (answer.response !== 1) return;
        }
        exitCleanupPending = true;
        await auth.dispose();
        exitApproved = true;
        window.close();
      } catch {
        emit({ type: 'notice', message: nativeText('退出清理未完成，窗口已保留，请检查连接状态后重试。') });
      } finally {
        if (!exitApproved) exitCleanupPending = false;
        closePromptPending = false;
      }
    })();
  });
  window.on('closed', () => {
    appUpdates.dispose();
    eventPort?.close();
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.removeAllListeners('desktop:subscribe');
  });
  window.once('ready-to-show', () => window.show());
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

if (primaryInstance) {
  void app.whenReady().then(createWindow);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
