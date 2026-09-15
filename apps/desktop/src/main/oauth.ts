import { createHash, randomBytes } from 'node:crypto';

export interface OAuthConfiguration {
  clientId: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface OAuthAuthorization {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

export type OAuthTransport = (url: string, init: RequestInit) => Promise<Response>;

export class OAuthError extends Error {
  readonly kind: 'network' | 'rejected' | 'protocol' | 'cancelled';

  constructor(kind: OAuthError['kind'], message: string) {
    super(message);
    this.name = 'OAuthError';
    this.kind = kind;
  }
}

interface OAuthMetadata {
  client_id?: unknown;
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  revocation_endpoint?: unknown;
  response_types_supported?: unknown;
  grant_types_supported?: unknown;
  scopes_supported?: unknown;
  code_challenge_methods_supported?: unknown;
}

interface SiteLocation {
  origin: string;
  prefix: string;
  baseUrl: string;
}

interface RequestScope {
  readonly signal: AbortSignal;
  check(): void;
  wait<T>(promise: Promise<T>): Promise<T>;
  dispose(): void;
}

const REDIRECT_URI = 'jms://auth/callback';
const WELL_KNOWN_PATH = '/core/auth/oauth2-provider/.well-known/oauth-authorization-server';
const AUTHORIZE_PATH = '/core/auth/oauth2-provider/authorize/';
const TOKEN_PATH = '/core/auth/oauth2-provider/token/';
const REVOKE_PATH = '/core/auth/oauth2-provider/revoke/';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_CLIENT_ID_LENGTH = 1_024;
const MAX_CALLBACK_VALUE_LENGTH = 8 * 1024;
const REFRESH_SKEW_MS = 60_000;
const KNOWN_CALLBACK_ERRORS: Record<string, true> = {
  access_denied: true,
  invalid_request: true,
  unauthorized_client: true,
  unsupported_response_type: true,
  invalid_scope: true,
  server_error: true,
  temporarily_unavailable: true
};
const CALLBACK_PARAMETERS: Record<string, true> = {
  code: true,
  state: true,
  error: true,
  error_description: true,
  error_uri: true,
  iss: true
};


function oauthError(kind: OAuthError['kind'], message: string): OAuthError {
  return new OAuthError(kind, message);
}

function requireString(value: unknown, field: string, maximumLength = MAX_SECRET_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw oauthError('protocol', `OAuth ${field} is invalid`);
  }
  return value;
}

function parseHttpsUrl(value: unknown, field: string): URL {
  const raw = requireString(value, field, 4_096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw oauthError('protocol', `OAuth ${field} is invalid`);
  }
  if (raw.includes('?') || raw.includes('#') || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw oauthError('protocol', `OAuth ${field} is not a safe HTTPS URL`);
  }
  return url;
}

function parseMetadataUrl(value: unknown, field: string): URL {
  // Core behind TLS termination can advertise HTTP. This is metadata only:
  // callers still bind the upgraded origin/path to the configured HTTPS site.
  const raw = requireString(value, field, 4_096);
  return parseHttpsUrl(raw.replace(/^http:\/\//i, 'https://'), field);
}

function normalizedPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '');
  return path === '/' ? '' : path;
}

function validatePath(pathname: string, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw oauthError('protocol', `OAuth ${field} path is invalid`);
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw oauthError('protocol', `OAuth ${field} path is invalid`);
  }
  return normalizedPath(pathname);
}

function parseSiteUrl(siteUrl: string): SiteLocation {
  const url = parseHttpsUrl(siteUrl, 'site URL');
  const prefix = validatePath(url.pathname, 'site URL');
  return { origin: url.origin, prefix, baseUrl: `${url.origin}${prefix}` };
}

function hasString(values: unknown, expected: string, field: string): void {
  if (!Array.isArray(values) || !values.some((value) => value === expected)) {
    throw oauthError('protocol', `OAuth server does not support ${field}`);
  }
}

function normalizeIssuer(value: unknown, site: SiteLocation): string {
  const issuer = parseMetadataUrl(value, 'issuer');
  if (issuer.origin !== site.origin) throw oauthError('protocol', 'OAuth issuer is outside the configured site');
  const path = validatePath(issuer.pathname, 'issuer');
  // Core's metadata is built from request.get_host(), so reverse proxies can omit
  // the configured gateway prefix. Only the root or the exact configured prefix is valid.
  if (path !== '' && path !== site.prefix) throw oauthError('protocol', 'OAuth issuer is outside the configured gateway');
  return requireString(value, 'issuer', 4_096);
}

function normalizeEndpoint(value: unknown, field: string, route: string, site: SiteLocation): string {
  const endpoint = parseMetadataUrl(value, field);
  if (endpoint.origin !== site.origin) throw oauthError('protocol', `OAuth ${field} is outside the configured site`);
  const expected = `${site.prefix}${route}`;
  // Core may advertise its unprefixed reverse() route. Do not accept any other
  // same-origin path: it could turn metadata into a credential exfiltration route.
  if (endpoint.pathname !== route && endpoint.pathname !== expected) {
    throw oauthError('protocol', `OAuth ${field} does not match the Core route`);
  }
  return `${site.baseUrl}${route}`;
}

function configurationFromMetadata(metadata: OAuthMetadata, site: SiteLocation): OAuthConfiguration {
  hasString(metadata.response_types_supported, 'code', 'authorization code responses');
  hasString(metadata.grant_types_supported, 'authorization_code', 'authorization-code grants');
  hasString(metadata.grant_types_supported, 'refresh_token', 'refresh-token grants');
  hasString(metadata.scopes_supported, 'read', 'the read scope');
  hasString(metadata.scopes_supported, 'write', 'the write scope');
  hasString(metadata.code_challenge_methods_supported, 'S256', 'PKCE S256');

  return {
    clientId: requireString(metadata.client_id, 'client ID', MAX_CLIENT_ID_LENGTH),
    issuer: normalizeIssuer(metadata.issuer, site),
    authorizationEndpoint: normalizeEndpoint(metadata.authorization_endpoint, 'authorization endpoint', AUTHORIZE_PATH, site),
    tokenEndpoint: normalizeEndpoint(metadata.token_endpoint, 'token endpoint', TOKEN_PATH, site),
    revocationEndpoint: normalizeEndpoint(metadata.revocation_endpoint, 'revocation endpoint', REVOKE_PATH, site)
  };
}


function validateConfiguration(configuration: OAuthConfiguration): OAuthConfiguration {
  const clientId = requireString(configuration.clientId, 'client ID', MAX_CLIENT_ID_LENGTH);
  const authorization = parseHttpsUrl(configuration.authorizationEndpoint, 'authorization endpoint');
  if (!authorization.pathname.endsWith(AUTHORIZE_PATH)) throw oauthError('protocol', 'OAuth authorization endpoint does not match the Core route');
  const prefix = validatePath(authorization.pathname.slice(0, -AUTHORIZE_PATH.length), 'gateway');
  const site = parseSiteUrl(`${authorization.origin}${prefix}`);
  const issuer = normalizeIssuer(configuration.issuer, site);
  const endpoint = (value: string, field: string, route: string): string => {
    const url = parseHttpsUrl(value, field);
    if (url.origin !== site.origin || url.pathname !== `${site.prefix}${route}`) {
      throw oauthError('protocol', `OAuth ${field} is outside the configured gateway`);
    }
    return url.toString();
  };
  return {
    clientId,
    issuer,
    authorizationEndpoint: endpoint(configuration.authorizationEndpoint, 'authorization endpoint', AUTHORIZE_PATH),
    tokenEndpoint: endpoint(configuration.tokenEndpoint, 'token endpoint', TOKEN_PATH),
    revocationEndpoint: endpoint(configuration.revocationEndpoint, 'revocation endpoint', REVOKE_PATH)
  };
}

function validateTokens(tokens: OAuthTokens): OAuthTokens {
  const accessToken = requireString(tokens.accessToken, 'access token');
  const refreshToken = tokens.refreshToken === undefined ? undefined : requireString(tokens.refreshToken, 'refresh token');
  if (!Number.isFinite(tokens.expiresAt) || !Number.isSafeInteger(tokens.expiresAt)) {
    throw oauthError('protocol', 'OAuth token expiry is invalid');
  }
  return refreshToken === undefined ? { accessToken, expiresAt: tokens.expiresAt } : { accessToken, refreshToken, expiresAt: tokens.expiresAt };
}

function requestScope(externalSignal?: AbortSignal): RequestScope {
  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const cancel = (): void => {
    cancelled = true;
    controller.abort();
  };
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const failure = (): OAuthError =>
    cancelled ? oauthError('cancelled', 'OAuth operation was cancelled') : oauthError('network', 'OAuth request timed out');
  const check = (): void => {
    if (cancelled || timedOut || controller.signal.aborted) throw failure();
  };

  return {
    signal: controller.signal,
    check,
    wait<T>(promise: Promise<T>): Promise<T> {
      check();
      return new Promise<T>((resolve, reject) => {
        const abort = (): void => {
          controller.signal.removeEventListener('abort', abort);
          reject(failure());
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        promise.then(
          (value) => {
            controller.signal.removeEventListener('abort', abort);
            resolve(value);
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', abort);
            reject(error);
          }
        );
      });
    },
    dispose(): void {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', cancel);
    }
  };
}

async function withRequestScope<T>(signal: AbortSignal | undefined, action: (scope: RequestScope) => Promise<T>): Promise<T> {
  const scope = requestScope(signal);
  try {
    scope.check();
    return await action(scope);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    try {
      scope.check();
    } catch (scopeError) {
      throw scopeError;
    }
    throw oauthError('network', 'OAuth network request failed');
  } finally {
    scope.dispose();
  }
}

async function readBoundedText(response: Response, scope: RequestScope): Promise<string> {
  scope.check();
  const length = response.headers.get('content-length');
  if (length !== null) {
    const parsedLength = Number(length);
    if (Number.isSafeInteger(parsedLength) && parsedLength > MAX_RESPONSE_BYTES) {
      throw oauthError('protocol', 'OAuth response is too large');
    }
  }
  if (!response.body) {
    scope.check();
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    for (;;) {
      const item = await scope.wait(reader.read());
      if (item.done) {
        completed = true;
        chunks.push(decoder.decode());
        scope.check();
        return chunks.join('');
      }
      byteLength += item.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) throw oauthError('protocol', 'OAuth response is too large');
      chunks.push(decoder.decode(item.value, { stream: true }));
      scope.check();
    }
  } catch (error) {
    if (!completed) void reader.cancel().catch(() => undefined);
    if (error instanceof OAuthError) throw error;
    throw oauthError('protocol', 'OAuth response is invalid');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation can leave a pending reader; the body has already been discarded.
    }
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw oauthError('protocol', 'OAuth response is not valid JSON');
  }
}

function classifyOAuthFailure(status: number, payload: Record<string, unknown> | null): OAuthError {
  const error = typeof payload?.error === 'string' ? payload.error : '';
  if (status === 429 || status >= 500 || error === 'temporarily_unavailable' || error === 'server_error') {
    return oauthError('network', 'OAuth server is temporarily unavailable');
  }
  if (status === 401 || error === 'invalid_grant' || error === 'invalid_token' || error === 'access_denied' || error === 'invalid_client') {
    return oauthError('rejected', 'OAuth credentials were rejected');
  }
  return oauthError('protocol', 'OAuth server rejected an invalid request');
}

function parseTokenResponse(response: Response, text: string): OAuthTokens {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = parseJson(text);
  } catch (error) {
    if (response.status === 429 || response.status >= 500) throw oauthError('network', 'OAuth server is temporarily unavailable');
    if (!response.ok && response.status === 401) throw oauthError('rejected', 'OAuth credentials were rejected');
    throw error;
  }
  if (!response.ok || typeof payload.error === 'string') throw classifyOAuthFailure(response.status, payload);
    if (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer') {
      throw oauthError('protocol', 'OAuth server did not issue a Bearer token');
    }

  const accessToken = requireString(payload.access_token, 'access token');
  const refreshToken = payload.refresh_token === undefined ? undefined : requireString(payload.refresh_token, 'refresh token');
  const expiresIn = payload.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 0 || expiresIn > 315_360_000) {
    throw oauthError('protocol', 'OAuth token expiry is invalid');
  }
  const expiresAt = Date.now() + Math.floor(expiresIn * 1_000);
  if (!Number.isSafeInteger(expiresAt)) throw oauthError('protocol', 'OAuth token expiry is invalid');
  return refreshToken === undefined ? { accessToken, expiresAt } : { accessToken, refreshToken, expiresAt };
}

function formRequest(values: Record<string, string>): RequestInit {
  const body = new URLSearchParams(values).toString();
  return {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store'
  };
}

async function tokenRequest(
  configuration: OAuthConfiguration,
  values: Record<string, string>,
  transport: OAuthTransport,
  signal?: AbortSignal,
  assertCurrent?: () => void
): Promise<OAuthTokens> {
  return withRequestScope(signal, async (scope) => {
    assertCurrent?.();
    scope.check();
    const response = await scope.wait(transport(configuration.tokenEndpoint, { ...formRequest(values), signal: scope.signal }));
    assertCurrent?.();
    const text = await readBoundedText(response, scope);
    assertCurrent?.();
    return parseTokenResponse(response, text);
  });
}

function callbackParameter(params: URLSearchParams, name: string, required = false): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1 || (required && values.length !== 1) || (values.length === 1 && (!values[0] || values[0].length > MAX_CALLBACK_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(values[0])))) {
    throw oauthError('protocol', 'OAuth callback parameters are invalid');
  }
  return values[0];
}

function parseCallback(configuration: OAuthConfiguration, authorization: OAuthAuthorization, callbackUrl: string): string {
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw oauthError('protocol', 'OAuth callback URL is invalid');
  }
  if (callback.protocol !== 'jms:' || callback.hostname !== 'auth' || callback.port || callback.username || callback.password || callback.pathname !== '/callback' || callback.hash) {
    throw oauthError('protocol', 'OAuth callback URL is invalid');
  }

  for (const name of callback.searchParams.keys()) {
    if (!Object.hasOwn(CALLBACK_PARAMETERS, name)) throw oauthError('protocol', 'OAuth callback parameters are invalid');
  }

  const state = callbackParameter(callback.searchParams, 'state', true);
  if (state !== authorization.state) throw oauthError('protocol', 'OAuth callback state does not match');
  const issuer = callbackParameter(callback.searchParams, 'iss');
  if (issuer !== undefined && issuer !== configuration.issuer) throw oauthError('protocol', 'OAuth callback issuer does not match');
  const code = callbackParameter(callback.searchParams, 'code');
  const error = callbackParameter(callback.searchParams, 'error');
  if ((code === undefined && error === undefined) || (code !== undefined && error !== undefined)) {
    throw oauthError('protocol', 'OAuth callback must contain one result');
  }
  if (error !== undefined) {
    if (!Object.hasOwn(KNOWN_CALLBACK_ERRORS, error)) throw oauthError('protocol', 'OAuth callback returned an unknown error');
    if (error === 'access_denied') throw oauthError('rejected', 'OAuth authorization was denied');
    if (error === 'temporarily_unavailable' || error === 'server_error') throw oauthError('network', 'OAuth server is temporarily unavailable');
    throw oauthError('protocol', 'OAuth callback was rejected');
  }
  return code!;
}

function validateAuthorization(authorization: OAuthAuthorization): OAuthAuthorization {
  if (authorization.redirectUri !== REDIRECT_URI || !/^[A-Za-z0-9_-]{32,128}$/.test(authorization.state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(authorization.verifier)) {
    throw oauthError('protocol', 'OAuth authorization state is invalid');
  }
  return authorization;
}

export async function discoverOAuth(siteUrl: string, transport: OAuthTransport, signal?: AbortSignal): Promise<OAuthConfiguration> {
  const site = parseSiteUrl(siteUrl);
  const discoveryUrl = `${site.baseUrl}${WELL_KNOWN_PATH}`;
  return withRequestScope(signal, async (scope) => {
    const response = await scope.wait(transport(discoveryUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: scope.signal
    }));
    const text = await readBoundedText(response, scope);
    if (!response.ok) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = parseJson(text);
      } catch {
        // HTTP status remains the only safe diagnostic.
      }
      throw classifyOAuthFailure(response.status, payload);
    }
    return configurationFromMetadata(parseJson(text) as OAuthMetadata, site);
  });
}

export function createOAuthAuthorization(configuration: OAuthConfiguration): OAuthAuthorization {
  const config = validateConfiguration(configuration);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'read write');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, verifier, redirectUri: REDIRECT_URI };
}

export async function exchangeOAuthCode(
  configuration: OAuthConfiguration,
  authorization: OAuthAuthorization,
  callbackUrl: string,
  transport: OAuthTransport,
  signal?: AbortSignal
): Promise<OAuthTokens> {
  const config = validateConfiguration(configuration);
  const pending = validateAuthorization(authorization);
  const code = parseCallback(config, pending, callbackUrl);
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: config.clientId,
    code_verifier: pending.verifier
  }, transport, signal);
}

export async function revokeOAuth(
  configuration: OAuthConfiguration,
  tokens: OAuthTokens,
  transport: OAuthTransport,
  signal?: AbortSignal
): Promise<void> {
  const config = validateConfiguration(configuration);
  const tokenSet = validateTokens(tokens);
  const token = tokenSet.refreshToken ?? tokenSet.accessToken;
  const tokenType = tokenSet.refreshToken ? 'refresh_token' : 'access_token';
  await withRequestScope(signal, async (scope) => {
    const response = await scope.wait(transport(config.revocationEndpoint, {
      ...formRequest({ token, token_type_hint: tokenType, client_id: config.clientId }),
      signal: scope.signal
    }));
    const text = await readBoundedText(response, scope);
    if (!response.ok) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = parseJson(text);
      } catch {
        // Do not expose a revocation response body.
      }
      throw classifyOAuthFailure(response.status, payload);
    }
  });
}

export class OAuthAccess {
  private tokens: OAuthTokens;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly configuration: OAuthConfiguration,
    tokens: OAuthTokens,
    private readonly transport: OAuthTransport,
    private readonly options: { assertCurrent(): void; persist(tokens: OAuthTokens): Promise<void>; signal?: AbortSignal }
  ) {
    this.configuration = validateConfiguration(configuration);
    this.tokens = validateTokens(tokens);
  }

  get currentTokens(): OAuthTokens {
    return { ...this.tokens };
  }

  async getAccessToken(rejectedToken?: string): Promise<string> {
    this.assertCurrent();
    const current = this.tokens;
    const rejectedCurrentToken = rejectedToken !== undefined && rejectedToken === current.accessToken;
    if (!rejectedCurrentToken && current.expiresAt > Date.now() + REFRESH_SKEW_MS) return current.accessToken;
    return this.refresh();
  }

  private assertCurrent(): void {
    if (this.options.signal?.aborted) throw oauthError('cancelled', 'OAuth operation was cancelled');
    try {
      this.options.assertCurrent();
    } catch {
      throw oauthError('cancelled', 'OAuth operation was cancelled');
    }
  }

  private refresh(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    let pending: Promise<string>;
    pending = this.performRefresh().finally(() => {
      if (this.refreshPromise === pending) this.refreshPromise = null;
    });
    this.refreshPromise = pending;
    return pending;
  }

  private async performRefresh(): Promise<string> {
    this.assertCurrent();
    const previous = this.tokens;
    if (!previous.refreshToken) throw oauthError('rejected', '服务端未签发可续期凭据，请重新认证');
    const refreshed = await tokenRequest(this.configuration, {
      grant_type: 'refresh_token',
      refresh_token: previous.refreshToken,
      client_id: this.configuration.clientId
    }, this.transport, this.options.signal, () => this.assertCurrent());
    const next: OAuthTokens = refreshed.refreshToken === undefined
      ? { accessToken: refreshed.accessToken, refreshToken: previous.refreshToken, expiresAt: refreshed.expiresAt }
      : refreshed;
    this.assertCurrent();
    await this.options.persist(next);
    this.assertCurrent();
    this.tokens = next;
    return next.accessToken;
  }
}
