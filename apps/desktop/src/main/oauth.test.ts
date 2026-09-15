import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createOAuthAuthorization,
  discoverOAuth,
  exchangeOAuthCode,
  OAuthAccess,
  type OAuthConfiguration,
  type OAuthTransport
} from './oauth';

const configuration: OAuthConfiguration = {
  clientId: 'desktop-client',
  issuer: 'https://jump.example',
  authorizationEndpoint: 'https://jump.example/gateway/core/auth/oauth2-provider/authorize/',
  tokenEndpoint: 'https://jump.example/gateway/core/auth/oauth2-provider/token/',
  revocationEndpoint: 'https://jump.example/gateway/core/auth/oauth2-provider/revoke/'
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: configuration.clientId,
    issuer: 'https://jump.example',
    authorization_endpoint: 'https://jump.example/core/auth/oauth2-provider/authorize/',
    token_endpoint: 'https://jump.example/core/auth/oauth2-provider/token/',
    revocation_endpoint: 'https://jump.example/core/auth/oauth2-provider/revoke/',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: ['read', 'write'],
    code_challenge_methods_supported: ['S256'],
    ...overrides
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((finish) => { resolve = finish; }),
    resolve
  };
}

describe('OAuth Authorization Code + PKCE', () => {
  it('discovers only exact Core routes and restores the configured gateway prefix', async () => {
    const transport = vi.fn(async () => json(metadata()));

    await expect(discoverOAuth('https://jump.example/gateway/', transport)).resolves.toEqual(configuration);
    expect(transport).toHaveBeenCalledWith(
      'https://jump.example/gateway/core/auth/oauth2-provider/.well-known/oauth-authorization-server',
      expect.objectContaining({ credentials: 'omit', redirect: 'error' })
    );
  });

  it('uses HTTPS transport when TLS-terminated Core advertises HTTP metadata', async () => {
    const advertised = metadata({
      issuer: 'http://jump.example',
      authorization_endpoint: 'http://jump.example/core/auth/oauth2-provider/authorize/',
      token_endpoint: 'http://jump.example/core/auth/oauth2-provider/token/',
      revocation_endpoint: 'http://jump.example/core/auth/oauth2-provider/revoke/'
    });
    const config = await discoverOAuth('https://jump.example/gateway', async () => json(advertised));
    const pending = createOAuthAuthorization(config);
    expect(new URL(pending.url).origin).toBe('https://jump.example');
    const exchange = vi.fn(async (url: string) => {
      expect(url).toBe(configuration.tokenEndpoint);
      return json({ access_token: 'secure-access', token_type: 'Bearer', expires_in: 3600 });
    });
    await expect(exchangeOAuthCode(config, pending,
      `jms://auth/callback?code=code&state=${pending.state}&iss=${encodeURIComponent(advertised.issuer as string)}`,
      exchange)).resolves.toMatchObject({ accessToken: 'secure-access' });
    for (const endpoint of ['http://attacker.example/core/auth/oauth2-provider/token/', 'http://jump.example:8080/core/auth/oauth2-provider/token/', 'http://jump.example/collect']) {
      await expect(discoverOAuth('https://jump.example/gateway', async () => json({ ...advertised, token_endpoint: endpoint }))).rejects.toMatchObject({ kind: 'protocol' });
    }
  });

  it('rejects metadata endpoints that could receive credentials outside the exact Core route', async () => {
    const transport = vi.fn(async () => json(metadata({
      token_endpoint: 'https://client:secret@jump.example/core/auth/oauth2-provider/token/'
    })));

    await expect(discoverOAuth('https://jump.example/gateway', transport)).rejects.toMatchObject({ kind: 'protocol' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('uses random PKCE state and binds the authorization request to the registered deep link', () => {
    const authorization = createOAuthAuthorization(configuration);
    const url = new URL(authorization.url);

    expect(authorization.redirectUri).toBe('jms://auth/callback');
    expect(url.searchParams.get('state')).toBe(authorization.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(authorization.verifier, 'ascii').digest('base64url')
    );
  });

  it('rejects missing, wrong, or duplicate callback state before token exchange', async () => {
    const authorization = createOAuthAuthorization(configuration);
    const transport = vi.fn<OAuthTransport>();
    const callback = (query: string) => exchangeOAuthCode(configuration, authorization, `jms://auth/callback?${query}`, transport);

    await expect(callback('code=authorization-code')).rejects.toMatchObject({ kind: 'protocol' });
    await expect(callback('code=authorization-code&state=wrong')).rejects.toMatchObject({ kind: 'protocol' });
    await expect(callback(`code=authorization-code&state=${authorization.state}&state=${authorization.state}`)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(callback(`code=one&code=two&state=${authorization.state}`)).rejects.toMatchObject({ kind: 'protocol' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('preserves the advertised issuer for callback validation behind a gateway', async () => {
    const config = await discoverOAuth('https://jump.example/gateway', async () => json(metadata()));
    const authorization = createOAuthAuthorization(config);
    const transport = vi.fn(async () => json({ access_token: 'valid', token_type: 'Bearer', expires_in: 3600 }));
    const callback = `jms://auth/callback?code=code&state=${authorization.state}&iss=`;
    await expect(exchangeOAuthCode(config, authorization, callback + encodeURIComponent('https://jump.example/gateway'), transport)).rejects.toMatchObject({ kind: 'protocol' });
    expect(transport).not.toHaveBeenCalled();
    await expect(exchangeOAuthCode(config, authorization, callback + encodeURIComponent(config.issuer), transport)).resolves.toMatchObject({ accessToken: 'valid' });
  });

  it('shares one refresh and lets late 401 handlers use the rotated token', async () => {
    const refresh = deferred<Response>();
    const transport = vi.fn((_url: string, _init: RequestInit) => refresh.promise);
    const persist = vi.fn(async () => {});
    const access = new OAuthAccess(configuration, {
      accessToken: 'old-access-token', refreshToken: 'old-refresh-token', expiresAt: Date.now() + 59_000
    }, transport, { assertCurrent() {}, persist });

    const normalRequest = access.getAccessToken();
    const rejectedRequest = access.getAccessToken('old-access-token');
    expect(transport).toHaveBeenCalledTimes(1);

    refresh.resolve(json({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', token_type: 'Bearer', expires_in: 3_600 }));
    await expect(Promise.all([normalRequest, rejectedRequest])).resolves.toEqual(['new-access-token', 'new-access-token']);
    await expect(access.getAccessToken('old-access-token')).resolves.toBe('new-access-token');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('retains the previous refresh token when a successful refresh omits rotation', async () => {
    const persist = vi.fn(async () => {});
    const access = new OAuthAccess(configuration, {
      accessToken: 'old-access-token', refreshToken: 'old-refresh-token', expiresAt: Date.now()
    }, async () => json({ access_token: 'new-access-token', token_type: 'Bearer', expires_in: 3_600 }), { assertCurrent() {}, persist });

    await expect(access.getAccessToken()).resolves.toBe('new-access-token');
    expect(access.currentTokens.refreshToken).toBe('old-refresh-token');
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'new-access-token', refreshToken: 'old-refresh-token'
    }));
  });

  it('keeps local tokens on temporary failures but classifies invalid_grant as terminal rejection', async () => {
    const original = { accessToken: 'old-access-token', refreshToken: 'old-refresh-token', expiresAt: Date.now() };
    const temporaryPersist = vi.fn(async () => {});
    const temporary = new OAuthAccess(configuration, original, async () => new Response('unavailable', { status: 503 }), {
      assertCurrent() {}, persist: temporaryPersist
    });
    const rejectedPersist = vi.fn(async () => {});
    const rejected = new OAuthAccess(configuration, original, async () => json({ error: 'invalid_grant' }, 400), {
      assertCurrent() {}, persist: rejectedPersist
    });

    await expect(temporary.getAccessToken()).rejects.toMatchObject({ kind: 'network' });
    expect(temporary.currentTokens).toEqual(original);
    expect(temporaryPersist).not.toHaveBeenCalled();
    await expect(rejected.getAccessToken()).rejects.toMatchObject({ kind: 'rejected' });
    expect(rejected.currentTokens).toEqual(original);
    expect(rejectedPersist).not.toHaveBeenCalled();
  });

  it('does not persist a late refresh after the authentication epoch is cancelled', async () => {
    const controller = new AbortController();
    const refresh = deferred<Response>();
    let current = true;
    const persist = vi.fn(async () => {});
    const access = new OAuthAccess(configuration, {
      accessToken: 'old-access-token', refreshToken: 'old-refresh-token', expiresAt: Date.now()
    }, async () => refresh.promise, {
      assertCurrent() {
        if (!current) throw new Error('authentication epoch changed');
      },
      persist,
      signal: controller.signal
    });

    const pending = access.getAccessToken();
    current = false;
    controller.abort();
    refresh.resolve(json({ access_token: 'late-access-token', refresh_token: 'late-refresh-token', token_type: 'Bearer', expires_in: 3_600 }));

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(access.currentTokens.accessToken).toBe('old-access-token');
    expect(persist).not.toHaveBeenCalled();
  });
});
