import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthBrowser } from './oauth-browser';
import type { OAuthAuthorization } from './oauth';

const electron = vi.hoisted(() => ({
  app: {
    isDefaultProtocolClient: vi.fn(),
    getApplicationNameForProtocol: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
    isPackaged: true
  },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() }
}));
vi.mock('electron', () => electron);

const window = { isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;

function authorization(state: string): OAuthAuthorization {
  return {
    state,
    url: `https://jump.example/authorize?state=${state}`,
    verifier: 'pkce-verifier',
    redirectUri: 'jms://auth/callback'
  };
}

function callback(state: string, code = 'authorization-code'): string {
  return `jms://auth/callback?code=${code}&state=${state}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.app.isPackaged = true;
  electron.app.isDefaultProtocolClient.mockReturnValue(true);
  electron.app.getApplicationNameForProtocol.mockReturnValue('');
  electron.app.setAsDefaultProtocolClient.mockReturnValue(true);
  electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });
  electron.shell.openExternal.mockResolvedValue(undefined);
});

describe('OAuthBrowser callback ownership', () => {
  it('ignores unsolicited and wrong-state callbacks, then completes the matching authorization', async () => {
    const browser = new OAuthBrowser();
    const request = authorization('active-state');
    const validCallback = callback(request.state);

    expect(browser.receiveCallback(validCallback)).toBe(false);

    const pending = browser.open(request, new AbortController().signal, window);
    expect(browser.receiveCallback(callback('other-state'))).toBe(false);
    expect(browser.receiveCallback(validCallback)).toBe(true);
    await expect(pending).resolves.toBe(validCallback);
  });

  it('accepts HTML-escaped query separators without decoding entities inside code values', async () => {
    const browser = new OAuthBrowser();
    const request = authorization('active-state');
    const controller = new AbortController();
    const pending = browser.open(request, controller.signal, window).catch(error => error);
    const code = 'opaque&state=other&amp;tail';
    const issuer = 'http://jump.example';
    const raw = `jms://auth/callback?code=${encodeURIComponent(code)}&amp;state=${request.state}&amp;iss=${encodeURIComponent(issuer)}`;
    try {
      expect(browser.receiveCallback(raw)).toBe(true);
      const received = new URL(await pending);
      expect([...received.searchParams]).toEqual([
        ['code', code], ['state', request.state], ['iss', issuer]
      ]);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it('rejects escaped wrong states and mixed duplicate states without consuming the pending login', async () => {
    const browser = new OAuthBrowser();
    const request = authorization('active-state');
    const controller = new AbortController();
    const pending = browser.open(request, controller.signal, window).catch(error => error);
    try {
      expect(browser.receiveCallback('jms://auth/callback?code=code&amp;state=other')).toBe(false);
      expect(browser.receiveCallback(`${callback(request.state)}&amp;state=other`)).toBe(false);
      expect(browser.receiveCallback(`jms://auth/callback?code=code&amp;state=other&state=${request.state}`)).toBe(false);
      expect(browser.receiveCallback(callback(request.state))).toBe(true);
      await expect(pending).resolves.toBe(callback(request.state));
    } finally {
      controller.abort();
      await pending;
    }
  });

  it('does not let a cancelled authorization callback complete a later authorization', async () => {
    const browser = new OAuthBrowser();
    const abandoned = authorization('abandoned-state');
    const aborted = new AbortController();
    const first = browser.open(abandoned, aborted.signal, window);

    aborted.abort();
    await expect(first).rejects.toMatchObject({ name: 'OAuthError', kind: 'cancelled' });

    const current = authorization('current-state');
    const pending = browser.open(current, new AbortController().signal, window);
    expect(browser.receiveCallback(callback(abandoned.state, 'late-code'))).toBe(false);

    const validCallback = callback(current.state, 'current-code');
    expect(browser.receiveCallback(validCallback)).toBe(true);
    await expect(pending).resolves.toBe(validCallback);
  });

  it('keeps the current protocol owner and does not launch a browser when switching is refused', async () => {
    const browser = new OAuthBrowser();
    let protocolOwner = 'Existing JumpServer Client';
    electron.app.isDefaultProtocolClient.mockImplementation(() => protocolOwner === 'JumpServer Desktop');
    electron.app.getApplicationNameForProtocol.mockImplementation(() => protocolOwner);
    electron.app.setAsDefaultProtocolClient.mockImplementation(() => {
      protocolOwner = 'JumpServer Desktop';
      return true;
    });
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });

    await expect(browser.open(authorization('refused-state'), new AbortController().signal, window))
      .rejects.toMatchObject({ name: 'OAuthError', kind: 'cancelled' });

    expect(protocolOwner).toBe('Existing JumpServer Client');
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });
});
