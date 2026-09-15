import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, session } from 'electron';
import type { Session as ElectronSession } from 'electron';
import { Client } from 'ssh2';
import { z } from 'zod';
import {
  assetsListArgsSchema,
  assetsOptionsArgsSchema,
  authLoginArgsSchema,
  emptyArgsSchema,
  parseApiError,
  parseConnectionToken,
  parseContext,
  parseIdentity,
  parsePaginatedAssets,
  parsePermittedAsset,
  preferencesSchema,
  siteRemoveArgsSchema,
  toAccounts,
  toAsset,
  toDesktopConnectMethods
} from '../../../../packages/adapters-jumpserver/src/core/schemas';
import type { DesktopConnectMethods, PermittedAsset } from '../../../../packages/adapters-jumpserver/src/core/schemas';
import { AuthStorage } from '../../../../packages/adapters-jumpserver/src/core/storage';
import type { AdapterHost, AuthorizedConnection, AuthorizedSshConnection, RequestOptions } from '../../../../packages/adapters-jumpserver/src/host';
import { nativeText } from '../../../../packages/desktop-contract/src/native-i18n';
import { createComponentConnection } from './component-connection';
import { resolveComponentEndpoint } from './component-endpoint';
import { HostKeyStore } from './host-key-store';
import { OAuthAccess, OAuthError, createOAuthAuthorization, discoverOAuth, exchangeOAuthCode, revokeOAuth } from './oauth';
import type { OAuthAuthorization, OAuthConfiguration, OAuthTokens, OAuthTransport } from './oauth';
import { OAuthCredentialStore } from './oauth-storage';
import type { StoredOAuthSession } from './oauth-storage';
import type {
  AppEvent,
  Asset,
  Identity,
  Preferences,
  ResourceContext,
  SessionInfo,
  SessionKind,
  Site,
  Snapshot,
  TransferTask
} from '../../../../packages/desktop-contract/src/index';

const PROFILE_PATH = '/api/v1/users/profile/';
const CURRENT_ORG_PATH = '/api/v1/orgs/orgs/current/';
const PERMITTED_ASSETS_PATH = '/api/v1/perms/users/self/assets/';
const CONNECT_METHODS_PATH = '/api/v1/terminal/components/connect-methods/';
const CONNECTION_TOKEN_PATH = '/api/v1/authentication/connection-token/';
const SMART_ENDPOINT_PATH = '/api/v1/terminal/endpoints/smart/';
const SSH_READY_TIMEOUT_MS = 20_000;
const MAX_CLIENT_URL_BYTES = 64 * 1024;

const apiMethods: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  [PROFILE_PATH]: { GET: true },
  '/api/v1/users/profile/permissions/': { GET: true },
  [CURRENT_ORG_PATH]: { GET: true },
  [PERMITTED_ASSETS_PATH]: { GET: true },
  [CONNECT_METHODS_PATH]: { GET: true },
  [CONNECTION_TOKEN_PATH]: { POST: true },
  [SMART_ENDPOINT_PATH]: { GET: true }
};


const connectionTokenIdSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9-]+$/);
const nativeClientUrlResponseSchema = z.object({ url: z.string().min(7).max(MAX_CLIENT_URL_BYTES) }).passthrough();
const nativeClientPayloadSchema = z.object({
  version: z.literal(2),
  protocol: z.enum(['ssh', 'telnet', 'sftp']),
  asset: z.object({ id: connectionTokenIdSchema }).passthrough(),
  endpoint: z.object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535)
  }).passthrough(),
  token: z.object({
    id: connectionTokenIdSchema,
    value: z.string().min(1).max(4_096)
  }).passthrough()
}).passthrough();

interface NativeGatewayCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

function parseNativeGatewayCredentials(
  value: unknown,
  expected: { assetId: string; protocol: 'ssh' | 'telnet' | 'sftp'; tokenId: string }
): NativeGatewayCredentials {
  const response = nativeClientUrlResponseSchema.safeParse(value);
  if (!response.success) throw new Error('Core 返回的原生连接地址无效');
  const encoded = response.data.url.slice('jms://'.length);
  if (!response.data.url.startsWith('jms://') || encoded.length === 0 || encoded.length > MAX_CLIENT_URL_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Core 返回的原生连接地址无效');
  }
  let decoded: Buffer;
  let parsed: unknown;
  try {
    decoded = Buffer.from(encoded, 'base64');
    if (decoded.length === 0 || decoded.length > MAX_CLIENT_URL_BYTES || decoded.toString('base64') !== encoded) {
      throw new Error('invalid client URL');
    }
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Core 返回的原生连接地址无效');
  }
  const payload = nativeClientPayloadSchema.safeParse(parsed);
  if (!payload.success || payload.data.asset.id !== expected.assetId || payload.data.protocol !== expected.protocol ||
      payload.data.token.id !== expected.tokenId) {
    throw new Error('Core 返回的原生连接信息与本次授权不一致');
  }
  const host = payload.data.endpoint.host;
  if (host !== host.trim() || (isIP(host) === 0 && !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host))) {
    throw new Error('Core 返回的原生网关地址无效');
  }
  return {
    host,
    port: payload.data.endpoint.port,
    username: `JMS-${payload.data.token.id}`,
    password: payload.data.token.value
  };
}

function hostKeyRecordKey(site: Site, host: string, port: number): string {
  return `${site.url}\u0000${host.toLowerCase()}\u0000${port}`;
}

function allowsNativeClientUrl(path: string, method: string): boolean {
  if (method !== 'GET') return false;
  const matched = /^\/api\/v1\/authentication\/connection-token\/([^/]+)\/client-url\/$/.exec(path);
  if (!matched) return false;
  try {
    return connectionTokenIdSchema.safeParse(decodeURIComponent(matched[1])).success;
  } catch {
    return false;
  }
}

const requestOptionsSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).optional(),
    body: z.unknown().optional(),
    orgId: z.string().guid().optional(),
    query: z.record(z.string(), z.string()).optional(),
    signal: z.instanceof(AbortSignal).optional(),
    headers: z.record(z.string(), z.string()).optional()
  })
  .strict();


const runtimeCommandSchema = z.string().trim().min(1).max(128);

interface CreateAuthRuntimeOptions {
  window: BrowserWindow;
  emit: (event: AppEvent) => void;
  update: (session: SessionInfo) => void;
  sessions: () => SessionInfo[];
  tasks: () => TransferTask[];
  onLogout: () => Promise<void>;
  authorizeInBrowser: (authorization: OAuthAuthorization, signal: AbortSignal) => Promise<string>;
}

interface AuthenticatedNetworkState {
  site: Site;
  identity: Identity;
  networkSession: ElectronSession;
  epoch: number;
  configuration: OAuthConfiguration;
  oauth: OAuthAccess;
}

class CoreApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, details: { code?: string; detail: string }) {
    super(details.detail);
    this.name = 'CoreApiError';
    this.status = status;
    this.code = details.code;
  }
}
function allowsApiRequest(path: string, method: string): boolean {
  if (apiMethods[path]?.[method] || allowsNativeClientUrl(path, method)) return true;
  if (method !== 'GET' || !path.startsWith(PERMITTED_ASSETS_PATH) || !path.endsWith('/')) return false;
  const id = path.slice(PERMITTED_ASSETS_PATH.length, -1);
  return z.string().guid().safeParse(id).success;
}


function siteBasePath(site: Site): string {
  const path = new URL(site.url).pathname.replace(/\/+$/, '');
  return path === '/' ? '' : path;
}

function resolveSitePath(site: Site, path: string, webSocket = false): URL {
  if (!path.startsWith('/') || path.startsWith('//') || /%2f|%5c|\\/i.test(path)) {
    throw new Error('请求路径不合法');
  }
  const decodedPath = decodeURIComponent(path);
  if (decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('请求路径不能包含目录跳转');
  }
  const base = new URL(site.url);
  const target = new URL(`${siteBasePath(site)}${path}`, base.origin);
  if (target.origin !== base.origin || target.protocol !== 'https:') {
    throw new Error('请求目标不在已配置的 HTTPS 站点内');
  }
  if (webSocket) target.protocol = 'wss:';
  return target;
}

function isSameAllowedOrigin(site: Site, value: string): boolean {
  try {
    const target = new URL(value);
    return target.protocol === 'https:' && target.origin === new URL(site.url).origin;
  } catch {
    return false;
  }
}

function timezoneOffset(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(minutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0');
  const remainingMinutes = String(absoluteMinutes % 60).padStart(2, '0');
  return `${sign}${hours}:${remainingMinutes}`;
}


export function createAuthRuntime(options: CreateAuthRuntimeOptions): {
  host: AdapterHost;
  invoke(command: string, args: unknown): Promise<unknown>;
  dispose(): Promise<void>;
} {
  const storage = new AuthStorage(join(app.getPath('userData'), 'jumpserver-desktop.sqlite'));
  let active: AuthenticatedNetworkState | null = null;
  const credentials = new OAuthCredentialStore(join(app.getPath('userData'), 'credentials', 'oauth-session.bin'));
  const connections = new Set<AuthorizedConnection>();
  const nativeConnections = new Set<AuthorizedSshConnection>();
  const endpointApprovals = new Map<string, Promise<boolean>>();
  const hostKeys = new HostKeyStore(join(app.getPath('userData'), 'credentials', 'ssh-host-keys.json'));
  let loginInFlight = false;
  let initialized = false;
  let restoreInFlight: Promise<void> | undefined;
  let authNotice: string | undefined;
  let rememberedSiteId: string | undefined;
  let lifecycle = new AbortController();
  let epoch = 0;
  let authOperation = 0;
  let rejection: { epoch: number; result: Promise<never> } | undefined;
  const assertOperation = (expected: number): void => {
    if (authOperation !== expected) throw new OAuthError('cancelled', '登录操作已取消');
  };

  const currentState = (): AuthenticatedNetworkState => {
    if (!active) throw new Error('尚未登录，请先在已配置站点完成认证');
    return active;
  };

  const assertCurrentEpoch = (expected: number): void => {
    if (epoch !== expected || lifecycle.signal.aborted) {
      throw new Error('认证状态已变更，已取消过期请求');
    }
  };

  const clearNetworkState = async (): Promise<void> => {
    const staleSession = active?.networkSession;
    lifecycle.abort();
    lifecycle = new AbortController();
    epoch += 1;
    const clearedEpoch = epoch;
    active = null;

    endpointApprovals.clear();
    for (const connection of [...connections]) connection.close();
    connections.clear();
    for (const connection of [...nativeConnections]) connection.close();
    nativeConnections.clear();

    try {
      await options.onLogout();
    } finally {
      if (staleSession) {
        await Promise.allSettled([staleSession.closeAllConnections(), staleSession.clearStorageData(), staleSession.clearCache()]);
      }
      if (epoch === clearedEpoch) options.emit({ type: 'identity', identity: null });
    }
  };

  const transportFor = (network: ElectronSession): OAuthTransport =>
    (url, init) => network.fetch(url, init);

  const forgetRejectedSession = (state: AuthenticatedNetworkState): Promise<never> => {
    if (rejection?.epoch === state.epoch) return rejection.result;
    assertCurrentEpoch(state.epoch);
    const result = (async (): Promise<never> => {
      authNotice = '登录授权已被服务端拒绝或撤销，请重新在浏览器完成认证。';
      rememberedSiteId = undefined;
      initialized = true;
      const clearing = clearNetworkState();
      await credentials.clear();
      await clearing;
      throw new OAuthError('rejected', authNotice);
    })();
    rejection = { epoch: state.epoch, result };
    return result;
  };

  const accessTokenFor = async (state: AuthenticatedNetworkState, rejectedToken?: string): Promise<string> => {
    assertCurrentEpoch(state.epoch);
    try {
      const token = await state.oauth.getAccessToken(rejectedToken);
      assertCurrentEpoch(state.epoch);
      return token;
    } catch (cause) {
      if (cause instanceof OAuthError && cause.kind === 'rejected') return forgetRejectedSession(state);
      assertCurrentEpoch(state.epoch);
      throw cause;
    }
  };

  const requestJson = async (
    state: AuthenticatedNetworkState,
    path: string,
    rawOptions: RequestOptions = {}
  ): Promise<unknown> => {
    const safePath = z.string().min(1).max(2_048).parse(path);
    const request = requestOptionsSchema.parse(rawOptions);
    const method = request.method ?? 'GET';
    if (!allowsApiRequest(safePath, method)) {
      throw new Error('该 Core API 路由或方法不在桌面客户端允许列表中');
    }
    const url = resolveSitePath(state.site, safePath);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
    const orgId = request.orgId ?? state.identity.orgId;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Referer: new URL(state.site.url).origin,
      'X-TZ': timezoneOffset(),
      ...(orgId ? { 'X-JMS-ORG': orgId } : {})
    };
    if (Object.keys(request.headers ?? {}).length) throw new Error('Core 请求不允许覆盖认证请求头');
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    const token = await accessTokenFor(state);
    const fetchWithToken = async (bearer: string): Promise<Response> => {
      assertCurrentEpoch(state.epoch);
      try {
        return await state.networkSession.fetch(url.toString(), {
          method,
          headers: { ...headers, Authorization: `Bearer ${bearer}` },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: 'manual',
          credentials: 'omit',
          signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30_000), ...(request.signal ? [request.signal] : [])])
        });
      } catch {
        assertCurrentEpoch(state.epoch);
        if (request.signal?.aborted) throw new OAuthError('cancelled', '请求已取消');
        throw new OAuthError('network', '暂时无法连接到站点，已保留登录凭据和现有连接；请检查网络后重试。');
      }
    };
    let response = await fetchWithToken(token);
    assertCurrentEpoch(state.epoch);
    if (response.status === 401) {
      await response.body?.cancel();
      const refreshed = await accessTokenFor(state, token);
      // Only read-only Core requests are replayed; connection creation is retried by the user.
      if (method !== 'GET') throw new Error('登录令牌已刷新；本次操作未自动重放，请重新操作。');
      response = await fetchWithToken(refreshed);
      assertCurrentEpoch(state.epoch);
      if (response.status === 401) {
        await response.body?.cancel();
        return forgetRejectedSession(state);
      }
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new OAuthError('protocol', 'Core API 返回了重定向；为保护 OAuth 凭据，未跟随跳转，登录凭据已保留。');
    }
    let text: string;
    try { text = await response.text(); }
    catch {
      assertCurrentEpoch(state.epoch);
      throw new OAuthError('network', '站点响应接收中断，登录凭据已保留，请重试。');
    }
    assertCurrentEpoch(state.epoch);
    if (!response.ok) {
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { detail: `Core 请求失败（HTTP ${response.status}）` }; }
      throw new CoreApiError(response.status, parseApiError(data));
    }
    if (!text.trim()) return null;
    try {
      return z.unknown().parse(JSON.parse(text));
    } catch {
      throw new Error('Core API 返回了无效 JSON');
    }
  };

  const readAssetDetail = async (state: AuthenticatedNetworkState, assetId: string, orgId: string) => {
    const payload = await requestJson(state, `${PERMITTED_ASSETS_PATH}${encodeURIComponent(assetId)}/`, { orgId });
    return parsePermittedAsset(payload);
  };

  const allowedMethodFor = (
    context: ResourceContext,
    kind: SessionKind,
    methods: DesktopConnectMethods
  ) => {
    const selected = context.connectMethod;
    const method = methods.find((candidate) => candidate.protocol === context.protocol &&
      candidate.value === selected.value && candidate.component === selected.component && candidate.type === selected.type);
    if (!method) throw new Error('所选连接方式已不在当前授权范围内，请重新选择资产、账号和方式');
    if (
      kind === 'terminal' &&
      (!['ssh', 'telnet'].includes(method.protocol) || method.component !== 'koko' || method.type !== 'native' || method.endpointProtocol !== 'ssh')
    ) {
      throw new Error('终端仅支持 Core 返回的 KoKo 原生 SSH 网关连接方式');
    }
    if (kind === 'files' && (method.protocol !== 'sftp' || method.component !== 'koko' || method.type !== 'native' || method.endpointProtocol !== 'sftp')) {
      throw new Error('文件工作区仅支持 Core 返回的 KoKo 原生 SFTP 网关连接方式');
    }
    if (kind === 'database' && (method.protocol !== 'mysql' || method.component !== 'chen' || method.type !== 'web' || method.value !== 'web_gui' || method.endpointProtocol !== 'http')) {
      throw new Error('数据库工作区仅支持 Core 返回的 Chen web_gui 连接方式');
    }
    return method;
  };

  const authorizeResource = async (rawContext: ResourceContext, kind: SessionKind): Promise<{
    state: AuthenticatedNetworkState;
    requestEpoch: number;
    context: ResourceContext;
    asset: PermittedAsset;
    method: DesktopConnectMethods[number];
    token: { tokenId: string; active: boolean; pending: boolean };
  }> => {
    const context = parseContext(rawContext);
    const state = currentState();
    const requestEpoch = state.epoch;
    assertContext(context);
    const asset = await readAssetDetail(state, context.assetId, context.orgId);
    assertCurrentEpoch(requestEpoch);
    if (asset.org_id !== context.orgId || asset.name !== context.assetName || asset.address !== context.address) {
      throw new Error('资产信息已变化，请重新从授权资产列表中选择');
    }
    const account = (asset.permed_accounts ?? []).find(
      (candidate) =>
        candidate.id === context.accountId ||
        candidate.alias === context.accountId ||
        candidate.username === context.accountId
    );
    const connectionAccountId = account?.id ?? account?.alias;
    if (!account || !connectionAccountId || account.name !== context.accountName) {
      throw new Error('所选账号已不在当前授权范围内，请重新选择');
    }

    const methodsPayload = await requestJson(state, CONNECT_METHODS_PATH, { orgId: context.orgId });
    assertCurrentEpoch(requestEpoch);
    const method = allowedMethodFor(context, kind, toDesktopConnectMethods(asset, methodsPayload));

    let tokenPayload: unknown;
    try {
      tokenPayload = await requestJson(state, CONNECTION_TOKEN_PATH, {
        method: 'POST',
        orgId: context.orgId,
        body: {
          asset: asset.id,
          account: connectionAccountId,
          protocol: context.protocol,
          connect_method: method.value
        }
      });
    } catch (error) {
      if (error instanceof CoreApiError) {
        if (error.code === 'acl_reject') throw new Error('服务器 ACL 已拒绝本次连接，桌面客户端不会绕过该策略');
        if (error.code === 'acl_review') throw new Error('本次连接需要服务器审批；请在 JumpServer 完成审批后重新发起，桌面客户端不会绕过');
        if (error.code === 'acl_face_verify' || error.code === 'acl_face_online') {
          throw new Error('本次连接需要服务器人脸验证；当前桌面客户端不会绕过该验证');
        }
      }
      throw error;
    }
    assertCurrentEpoch(requestEpoch);
    const parsedToken = parseConnectionToken(tokenPayload);
    const token = { ...parsedToken, tokenId: connectionTokenIdSchema.parse(parsedToken.tokenId) };
    if (!token.active || token.pending) {
      throw new Error('服务器将该连接标记为待审批或待验证；桌面客户端不会在未激活时使用连接令牌');
    }
    return { state, requestEpoch, context, asset, method, token };
  };

  const authorize = async (rawContext: ResourceContext, kind: 'database'): Promise<AuthorizedConnection> => {
    const authorization = await authorizeResource(rawContext, kind);
    const { state, requestEpoch, context, asset, method, token } = authorization;
    if (method.endpointProtocol !== 'http') throw new Error('Core 返回的连接方式没有受支持的 HTTPS Chen 组件入口');
    const endpointPayload = await requestJson(state, SMART_ENDPOINT_PATH, {
      orgId: context.orgId,
      query: { protocol: 'https', asset_id: asset.id, token: token.tokenId }
    });
    assertCurrentEpoch(requestEpoch);
    const endpointUrl = resolveComponentEndpoint(state.site.url, endpointPayload);
    const endpointOrigin = new URL(endpointUrl).origin;
    if (endpointOrigin !== new URL(state.site.url).origin) {
      const approvalKey = `chen\u0000${endpointOrigin}`;
      let approval = endpointApprovals.get(approvalKey);
      if (!approval) {
        approval = dialog.showMessageBox(options.window, {
          type: 'warning',
          title: nativeText('确认 Chen 组件入口'),
          message: nativeText('允许连接 Core 指定的 Chen 入口？'),
          detail: nativeText('站点：{{site}}\n组件：{{endpoint}}\n\n仅向此 HTTPS 入口发送本次连接令牌；Chen 使用独立 Cookie 容器，不接收 Core access token 或 refresh token。\n授权仅在本次登录内有效。请确认这是受信的 JumpServer 组件。', { site: new URL(state.site.url).origin, endpoint: endpointOrigin }),
          buttons: [nativeText('取消'), nativeText('允许连接')],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        }).then(({ response }) => response === 1);
        endpointApprovals.set(approvalKey, approval);
      }
      const approved = await approval;
      assertCurrentEpoch(requestEpoch);
      if (!approved) {
        endpointApprovals.delete(approvalKey);
        throw new Error('未授权连接此 Chen 组件入口');
      }
    }
    const connection = createComponentConnection({
      endpointUrl,
      tokenId: token.tokenId,
      orgId: context.orgId,
      assertCurrent: () => assertCurrentEpoch(requestEpoch),
      onClose: (value) => connections.delete(value)
    });
    connections.add(connection);
    return connection;
  };

  const confirmNativeHostKey = async (
    site: Site,
    host: string,
    port: number,
    fingerprint: string,
    assertPending: () => void
  ): Promise<void> => {
    assertPending();
    const key = hostKeyRecordKey(site, host, port);
    const remembered = await hostKeys.fingerprintFor(key);
    assertPending();
    if (remembered === fingerprint) return;

    const changed = remembered !== undefined;
    const approval = await dialog.showMessageBox(options.window, {
      type: 'warning',
      title: nativeText(changed ? 'SSH 网关主机密钥已更改' : '确认 SSH 网关主机密钥'),
      message: nativeText(changed ? 'SSH 网关身份与之前记录不一致。' : '首次连接此 SSH 网关，请确认其主机密钥。'),
      detail: nativeText('站点：{{site}}\n网关：{{host}}:{{port}}\n{{keyDetails}}', {
        site: new URL(site.url).origin, host, port,
        keyDetails: changed
          ? nativeText('已记录：{{remembered}}\n新密钥：{{fingerprint}}\n\n密钥变更可能表示网关重装，也可能表示中间人攻击。仅在已通过独立渠道确认后，才信任新密钥。', { remembered, fingerprint })
          : nativeText('SHA256 指纹：{{fingerprint}}\n\n请通过站点管理员或受信渠道核对此指纹后再继续。', { fingerprint })
      }),
      buttons: changed ? [nativeText('拒绝并关闭'), nativeText('信任新密钥')] : [nativeText('取消'), nativeText('信任此密钥')],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    assertPending();
    if (approval.response !== 1) throw new Error('SSH 网关主机密钥未获信任');
    await hostKeys.remember(key, fingerprint);
    assertPending();
  };

  const connectNative = async (
    gateway: NativeGatewayCredentials,
    site: Site,
    requestEpoch: number
  ): Promise<AuthorizedSshConnection> => {
    const client = new Client();
    const host = gateway.host;
    const port = gateway.port;
    const username = gateway.username;
    let secret: string | undefined = gateway.password;
    gateway.password = '';
    let closed = false;
    let trustFailure: Error | undefined;
    let settled = false;
    let connection: AuthorizedSshConnection;
    const close = () => {
      if (closed) return;
      closed = true;
      secret = undefined;
      nativeConnections.delete(connection);
      try {
        client.end();
      } catch {
        // ssh2 can synchronously reject closing an already-destroyed transport.
      }
      try {
        client.destroy();
      } catch {
        // ssh2 may already have released its socket after an error or timeout.
      }
    };
    connection = { client, close };
    nativeConnections.add(connection);

    try {
      const completion = Promise.withResolvers<void>();
      let finish: (failure?: Error) => void;
      const assertPending = () => {
        assertCurrentEpoch(requestEpoch);
        if (closed || settled) throw new Error('SSH 连接已关闭或过期');
      };
      const abort = () => {
        finish(new Error('认证状态已变更，已取消 SSH 连接'));
        close();
      };
      finish = (failure?: Error) => {
        if (settled) return;
        settled = true;
        lifecycle.signal.removeEventListener('abort', abort);
        secret = undefined;
        if (failure) completion.reject(failure);
        else completion.resolve();
      };
      client.once('ready', () => {
        if (closed || settled) return;
        try {
          assertPending();
          finish();
        } catch {
          finish(new Error('认证状态已变更，已取消 SSH 连接'));
          close();
        }
      });
      client.on('error', () => {
        if (!settled) finish(trustFailure ?? new Error('无法建立 SSH 网关连接'));
        close();
      });
      client.on('close', () => {
        if (!closed) {
          closed = true;
          secret = undefined;
          nativeConnections.delete(connection);
        }
        if (!settled) finish(trustFailure ?? new Error('SSH 网关连接在认证完成前关闭'));
      });
      lifecycle.signal.addEventListener('abort', abort, { once: true });
      try {
        client.connect({
          host,
          port,
          username,
          readyTimeout: SSH_READY_TIMEOUT_MS,
          tryKeyboard: false,
          authHandler: (_methods, _partial, next) => {
            const password = secret;
            secret = undefined;
            if (!password) {
              close();
              return;
            }
            next({ type: 'password', username, password });
          },
          hostVerifier: (serverKey: Buffer, verify: (trusted: boolean) => void) => {
            void (async () => {
              try {
                if (!Buffer.isBuffer(serverKey) || serverKey.length === 0 || serverKey.length > 16 * 1024) {
                  throw new Error('SSH 网关主机密钥无效');
                }
                const fingerprint = `SHA256:${createHash('sha256').update(serverKey).digest('base64').replace(/=+$/, '')}`;
                await confirmNativeHostKey(site, host, port, fingerprint, assertPending);
                assertPending();
                verify(true);
              } catch (cause) {
                trustFailure = cause instanceof Error ? cause : new Error('SSH 网关主机密钥未获信任');
                verify(false);
              }
            })();
          }
        });
      } catch {
        finish(new Error('无法建立 SSH 网关连接'));
      }
      await completion.promise;
      assertCurrentEpoch(requestEpoch);
      return connection;
    } catch (cause) {
      close();
      throw cause;
    }
  };

  const authorizeNative = async (
    rawContext: ResourceContext,
    kind: 'terminal' | 'files'
  ): Promise<AuthorizedSshConnection> => {
    const authorization = await authorizeResource(rawContext, kind);
    const { state, requestEpoch, context, asset, token } = authorization;
    const expectedProtocol = z.enum(['ssh', 'telnet', 'sftp']).parse(context.protocol);
    let clientUrlPayload: unknown;
    try {
      clientUrlPayload = await requestJson(
        state,
        `${CONNECTION_TOKEN_PATH}${encodeURIComponent(token.tokenId)}/client-url/`,
        { orgId: context.orgId }
      );
    } catch (cause) {
      assertCurrentEpoch(requestEpoch);
      if (cause instanceof OAuthError) throw cause;
      throw new Error('无法读取 Core 原生连接地址');
    }
    assertCurrentEpoch(requestEpoch);
    const gateway = parseNativeGatewayCredentials(clientUrlPayload, {
      assetId: asset.id,
      protocol: expectedProtocol,
      tokenId: token.tokenId
    });
    assertCurrentEpoch(requestEpoch);
    return connectNative(gateway, state.site, requestEpoch);
  };

  const assertContext = (rawContext: ResourceContext): void => {
    const context = parseContext(rawContext);
    const state = currentState();
    if (context.siteId !== state.identity.siteId || context.userId !== state.identity.userId) {
      throw new Error('连接上下文不属于当前已登录身份');
    }
  };

  const host: AdapterHost = {
    // Network capabilities are only available after authorization and are bound to one connection.
    authorize,
    authorizeNative,
    assertContext,
    emit: options.emit,
    update: options.update
  };

  const persistSession = async (state: AuthenticatedNetworkState, tokens: OAuthTokens): Promise<void> => {
    assertCurrentEpoch(state.epoch);
    if (!state.identity.userId) return;
    try {
      await credentials.save({
        siteId: state.site.id, siteUrl: state.site.url, identity: state.identity,
        configuration: state.configuration, tokens
      });
      assertCurrentEpoch(state.epoch);
      rememberedSiteId = state.site.id;
    } catch (cause) {
      assertCurrentEpoch(state.epoch);
      // Rotated tokens remain usable in memory. Never pretend failed secure persistence succeeded.
      authNotice = '当前登录可用，但系统安全存储不可用，无法保证重启后恢复；未写入明文凭据。';
      options.emit({ type: 'notice', message: authNotice });
    }
  };

  const establishIdentity = async (
    site: Site, network: ElectronSession, configuration: OAuthConfiguration, tokens: OAuthTokens,
    expectedEpoch: number, expectedIdentity?: Identity
  ): Promise<Identity> => {
    const state = {
      site, networkSession: network, configuration, epoch: expectedEpoch,
      identity: expectedIdentity ?? { siteId: site.id, userId: '', name: '', orgId: '' }
    } as AuthenticatedNetworkState;
    state.oauth = new OAuthAccess(configuration, tokens, transportFor(network), {
      assertCurrent: () => assertCurrentEpoch(expectedEpoch),
      persist: (updated) => persistSession(state, updated),
      signal: lifecycle.signal
    });
    const [profile, org] = await Promise.all([
      requestJson(state, PROFILE_PATH), requestJson(state, CURRENT_ORG_PATH)
    ]);
    assertCurrentEpoch(expectedEpoch);
    const identity = parseIdentity(site.id, profile, org);
    if (expectedIdentity && identity.userId !== expectedIdentity.userId) {
      await credentials.clear();
      throw new OAuthError('rejected', '恢复凭据对应的用户发生变化，已拒绝复用，请重新认证。');
    }
    state.identity = identity;
    active = state;
    await persistSession(state, state.oauth.currentTokens);
    assertCurrentEpoch(expectedEpoch);
    options.emit({ type: 'identity', identity });
    return identity;
  };

  const restoreSession = async (saved: StoredOAuthSession): Promise<Identity | null> => {
    const site = storage.getSite(saved.siteId);
    if (!site || site.url !== saved.siteUrl) {
      await credentials.clear();
      rememberedSiteId = undefined;
      return null;
    }
    rememberedSiteId = site.id;
    const expectedEpoch = epoch;
    const network = session.fromPartition(`memory:jumpserver-oauth-${randomUUID()}`, { cache: false });
    try {
      return await establishIdentity(site, network, saved.configuration, saved.tokens, expectedEpoch, saved.identity);
    } catch (cause) {
      if (active?.networkSession !== network) await network.closeAllConnections();
      throw cause;
    }
  };

  const restoreOnStartup = async (): Promise<void> => {
    if (initialized || loginInFlight) return;
    if (restoreInFlight) return restoreInFlight;
    const operation = authOperation;
    restoreInFlight = (async () => {
      try {
        const saved = await credentials.load();
        assertOperation(operation);
        if (saved) await restoreSession(saved);
      } catch (cause) {
        if (authOperation === operation) authNotice ??= cause instanceof OAuthError && cause.kind === 'rejected'
          ? '保存的登录授权已失效，请重新在浏览器完成认证。'
          : '暂时无法恢复登录；已保留安全存储中的凭据，点击登录可重试恢复。';
      } finally {
        initialized = true;
        restoreInFlight = undefined;
      }
    })();
    return restoreInFlight;
  };

  const login = async (siteId: string, operation: number): Promise<Identity> => {
    const site = storage.getSite(siteId);
    if (!site) throw new Error('找不到该站点配置；请重新保存 HTTPS 站点地址');
    if (restoreInFlight) await restoreInFlight;
    assertOperation(operation);
    await clearNetworkState();
    assertOperation(operation);
    initialized = true;
    authNotice = undefined;
    let saved: StoredOAuthSession | null = null;
    try { saved = await credentials.load(); }
    catch { options.emit({ type: 'notice', message: '无法读取已保存凭据，将重新在浏览器认证；不会改用明文存储。' }); }
    assertOperation(operation);
    if (saved?.siteId === site.id && saved.siteUrl === site.url) {
      try {
        const restored = await restoreSession(saved);
        if (restored) return restored;
      } catch (cause) {
        if (!(cause instanceof OAuthError) || cause.kind !== 'rejected') throw cause;
        assertOperation(operation);
        // Only an explicit authentication rejection warrants another interactive authorization.
      }
    }
    assertOperation(operation);
    const expectedEpoch = epoch;
    const signal = lifecycle.signal;
    const network = session.fromPartition(`memory:jumpserver-oauth-${randomUUID()}`, { cache: false });
    const transport = transportFor(network);
    try {
      const configuration = await discoverOAuth(site.url, transport, signal);
      assertCurrentEpoch(expectedEpoch);
      const authorization = createOAuthAuthorization(configuration);
      const callbackUrl = await options.authorizeInBrowser(authorization, signal);
      assertCurrentEpoch(expectedEpoch);
      const tokens = await exchangeOAuthCode(configuration, authorization, callbackUrl, transport, signal);
      assertCurrentEpoch(expectedEpoch);
      return await establishIdentity(site, network, configuration, tokens, expectedEpoch);
    } finally {
      if (active?.networkSession !== network) await network.closeAllConnections();
    }
  };

  const logout = async (): Promise<void> => {
    authOperation += 1;
    const previous = active;
    const clearing = clearNetworkState();
    initialized = true;
    authNotice = undefined;
    rememberedSiteId = undefined;
    // Queue deletion after already-started writes; aborted refreshes cannot enqueue new writes.
    await credentials.clear();
    await clearing;
    if (previous) {
      try {
        await revokeOAuth(previous.configuration, previous.oauth.currentTokens,
          transportFor(previous.networkSession), AbortSignal.timeout(10_000));
      } catch {
        options.emit({ type: 'notice', message: '本地凭据已删除，但服务端令牌撤销未获确认；可在 JumpServer 中管理已授权客户端。' });
      }
    }
  };

  const invoke = async (command: string, args: unknown): Promise<unknown> => {
    const parsedCommand = runtimeCommandSchema.parse(command);
    if (parsedCommand === 'app.bootstrap') {
      emptyArgsSchema.parse(args);
      await restoreOnStartup();
      const identity = active?.identity ?? null;
      const preferences = storage.getPreferences(identity);
      const snapshot: Snapshot = {
        sites: storage.listSites(),
        identity,
        preferences,
        sessions: options.sessions(),
        tasks: options.tasks(),
        authNotice, rememberedSiteId
      };
      return snapshot;
    }
    if (parsedCommand === 'site.save') {
      const saved = storage.saveSite(args);
      if (active?.site.id === saved.id && active.site.url !== saved.url) await logout();
      const remembered = await credentials.load().catch(() => null);
      if (remembered?.siteId === saved.id && remembered.siteUrl !== saved.url) await credentials.clear();
      return saved;
    }
    if (parsedCommand === 'site.remove') {
      const { siteId } = siteRemoveArgsSchema.parse(args);
      if (active?.site.id === siteId) await logout();
      const remembered = await credentials.load().catch(() => null);
      if (remembered?.siteId === siteId) await credentials.clear();
      storage.removeSite(siteId);
      return;
    }
    if (parsedCommand === 'auth.login') {
      const { siteId } = authLoginArgsSchema.parse(args);
      if (loginInFlight) throw new Error('已有登录流程正在进行，请先完成或取消浏览器授权');
      loginInFlight = true;
      try {
        return await login(siteId, ++authOperation);
      } finally {
        loginInFlight = false;
      }
    }
    if (parsedCommand === 'auth.cancel') {
      emptyArgsSchema.parse(args);
      if (loginInFlight) {
        authOperation += 1;
        await clearNetworkState();
      }
      return;
    }
    if (parsedCommand === 'auth.logout') {
      emptyArgsSchema.parse(args);
      await logout();
      return;
    }
    if (parsedCommand === 'assets.list') {
      const input = assetsListArgsSchema.parse(args);
      const state = currentState();
      const requestEpoch = state.epoch;
      if (input.favoritesOnly) {
        const ids = storage.getPreferences(state.identity).favorites;
        const permitted = new Map<string, Asset>();
        // Bound URL length, and retain Core authorization filtering rather than reading cached asset details.
        for (let start = 0; start < ids.length; start += 100) {
          const batch = ids.slice(start, start + 100);
          const expected = new Set(batch);
          let offset = 0;
          let total = 0;
          do {
            const payload = await requestJson(state, PERMITTED_ASSETS_PATH, {
              query: {
                'id__in': batch.join(','),
                ...(input.search ? { search: input.search } : {}),
                ...(input.category ? { category: input.category } : {}),
                offset: String(offset),
                limit: '100',
                ordering: 'name'
              }
            });
            assertCurrentEpoch(requestEpoch);
            const page = parsePaginatedAssets(payload);
            total = page.total;
            if (total > batch.length || (page.values.length === 0 && offset < total)) throw new Error('Core 未提供完整的授权收藏筛选结果，请刷新重试');
            for (const value of page.values) {
              const asset = toAsset(value);
              if (!expected.has(asset.id)) throw new Error('当前 Core 不支持安全的收藏 ID 筛选，未展示未筛选结果');
              permitted.set(asset.id, asset);
            }
            offset += page.values.length;
          } while (offset < total);
        }
        const assets = [...permitted.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const offset = input.offset ?? 0;
        return { assets: assets.slice(offset, offset + (input.limit ?? 50)), total: assets.length };
      }
      const payload = await requestJson(state, PERMITTED_ASSETS_PATH, {
        query: {
          ...(input.search ? { search: input.search } : {}),
          ...(input.category ? { category: input.category } : {}),
          offset: String(input.offset ?? 0),
          limit: String(input.limit ?? 50),
          ordering: 'name'
        }
      });
      assertCurrentEpoch(requestEpoch);
      const page = parsePaginatedAssets(payload);
      return { assets: page.values.map(toAsset), total: page.total };
    }
    if (parsedCommand === 'assets.options') {
      const input = assetsOptionsArgsSchema.parse(args);
      const state = currentState();
      const requestEpoch = state.epoch;
      const asset = await readAssetDetail(state, input.assetId, input.orgId);
      assertCurrentEpoch(requestEpoch);
      if (asset.org_id !== input.orgId) throw new Error('资产不属于所请求的组织，已拒绝读取选项');
      const methods = await requestJson(state, CONNECT_METHODS_PATH, { orgId: input.orgId });
      assertCurrentEpoch(requestEpoch);
      return { accounts: toAccounts(asset.permed_accounts ?? []), methods: toDesktopConnectMethods(asset, methods) };
    }
    if (parsedCommand === 'preferences.save') {
      const payload = z.object({ preferences: preferencesSchema }).strict().parse(args);
      return storage.savePreferences(active?.identity ?? null, payload.preferences);
    }
    throw new Error(`认证运行时不处理命令：${parsedCommand}`);
  };

  return { host, invoke, dispose: async () => { authOperation += 1; await clearNetworkState(); } };
}
