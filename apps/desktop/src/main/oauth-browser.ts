import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { resolve } from 'node:path';
import { OAuthError } from './oauth';
import type { OAuthAuthorization } from './oauth';
import { nativeText } from '../../../../packages/desktop-contract/src/native-i18n';

/** The OS callback only completes an already-pending, state-bound authorization. */
export class OAuthBrowser {
  private pending?: { state: string; complete(url: string): void };

  receiveCallback(raw: string): boolean {
    if (!this.pending || raw.length > 32_768) return false;
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    // Browser handoffs can retain HTML-escaped query separators. Decode one
    // separator layer only; percent-encoded code/state/issuer values stay opaque.
    url.search = url.search.replaceAll('&amp;', '&');
    if (url.protocol !== 'jms:' || url.hostname !== 'auth' || url.port || url.username || url.password ||
        url.pathname !== '/callback' || url.hash || url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== this.pending.state) return false;
    this.pending.complete(url.href);
    return true;
  }

  async open(authorization: OAuthAuthorization, signal: AbortSignal, window: BrowserWindow): Promise<string> {
    if (this.pending) throw new OAuthError('protocol', '已有浏览器授权正在进行');
    const check = () => { if (signal.aborted || window.isDestroyed()) throw new OAuthError('cancelled', '浏览器授权已取消'); };
    check();
    const args = process.defaultApp && process.argv[1] ? [resolve(process.argv[1])] : [];
    if (!app.isDefaultProtocolClient('jms', process.execPath, args)) {
      if (!app.isPackaged && process.platform !== 'win32') {
        throw new OAuthError('protocol', '此平台需要从打包后的应用启动 OAuth 登录，以接收 jms:// 授权回调。');
      }
      const owner = app.getApplicationNameForProtocol('jms://auth/callback');
      const answer = await dialog.showMessageBox(window, {
        type: 'question', title: nativeText('接收 JumpServer 授权回调'),
        message: owner ? nativeText('jms:// 当前由 {{owner}} 处理。是否切换到本工作台？', { owner }) : nativeText('是否允许本工作台接收 jms:// 授权回调？'),
        detail: nativeText('这是 JumpServer 官方 OAuth 回调协议。切换会影响其他 JumpServer 客户端的登录回调；取消不会更改系统设置。'),
        buttons: [nativeText('取消'), nativeText('允许并继续')], defaultId: 0, cancelId: 0
      });
      check();
      if (answer.response !== 1) throw new OAuthError('cancelled', '未更改授权回调处理程序');
      if (!app.setAsDefaultProtocolClient('jms', process.execPath, args)) {
        throw new OAuthError('protocol', '系统未允许注册 jms:// 回调，请在系统设置中选择本工作台后重试。');
      }
    }
    check();
    return new Promise<string>((resolveCallback, reject) => {
      const finish = (url?: string, error?: OAuthError) => {
        if (this.pending !== pending) return;
        this.pending = undefined;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolveCallback(url!);
      };
      const cancel = () => finish(undefined, new OAuthError('cancelled', '浏览器授权已取消'));
      const pending = { state: authorization.state, complete: (url: string) => finish(url) };
      const timer = setTimeout(() => finish(undefined, new OAuthError('cancelled', '浏览器授权已超时，请重新登录')), 5 * 60_000);
      this.pending = pending;
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      void shell.openExternal(authorization.url).catch(() => finish(undefined, new OAuthError('protocol', '无法打开系统浏览器，请检查默认浏览器设置后重试。')));
    });
  }
}
