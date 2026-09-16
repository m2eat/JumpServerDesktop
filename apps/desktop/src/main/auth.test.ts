import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthRuntime } from './auth';
import type { OAuthConfiguration } from './oauth';
import type { StoredOAuthSession } from './oauth-storage';
import type { Identity, ResourceContext, Snapshot } from '../../../../packages/desktop-contract/src/index';
import type { AdapterHost } from '../../../../packages/adapters-jumpserver/src/host';

const ssh = vi.hoisted(() => {
  type NativeConfig = {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    agent?: unknown;
    privateKey?: unknown;
    tryKeyboard?: boolean;
    readyTimeout?: number;
    hostVerifier?: (key: Buffer, verify: (approved: boolean) => void) => void;
    authHandler?: (methods: unknown, partial: boolean, next: (method: unknown) => void) => void;
  };
  class Client {
    readonly end = vi.fn();
    readonly destroy = vi.fn();
    config: NativeConfig | undefined;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener);
    }

    connect(config: NativeConfig): this {
      this.config = config;
      clients.push(this);
      return this;
    }

    async verifyHostKey(key: Buffer): Promise<boolean> {
      const verifier = this.config?.hostVerifier;
      if (!verifier) throw new Error('host verifier was not configured');
      const approval = Promise.withResolvers<boolean>();
      verifier(key, approval.resolve);
      return approval.promise;
    }

    emitReady(): void {
      for (const listener of this.listeners.get('ready') ?? []) listener();
    }

    emitError(): void {
      for (const listener of this.listeners.get('error') ?? []) listener();
    }
  }
  const clients: Client[] = [];
  return { Client, clients };
});

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn() },
  session: { fromPartition: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  net: { WebSocket: vi.fn() }
}));

const oauthNetwork = vi.hoisted(() => ({
  fetch: vi.fn(),
  closeAllConnections: vi.fn(async () => {}),
  clearStorageData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
  clearAuthCache: vi.fn(async () => {}),
  webRequest: { onBeforeRequest: vi.fn() }
}));

const componentNetwork = vi.hoisted(() => ({
  fetch: vi.fn(),
  closeAllConnections: vi.fn(async () => {}),
  clearStorageData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
  clearAuthCache: vi.fn(async () => {}),
  webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() }
}));

const vault = vi.hoisted(() => ({
  record: null as unknown,
  load: vi.fn(),
  save: vi.fn(),
  clear: vi.fn()
}));

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: class BrowserWindow {},
  dialog: electron.dialog,
  net: electron.net,
  session: electron.session
}));
vi.mock('ssh2', () => ({ Client: ssh.Client }));


vi.mock('./oauth-storage', () => ({
  OAuthCredentialStore: class OAuthCredentialStore {
    load(): Promise<StoredOAuthSession | null> {
      return vault.load();
    }

    save(record: StoredOAuthSession): Promise<void> {
      return vault.save(record);
    }

    clear(): Promise<void> {
      return vault.clear();
    }
  }
}));

const siteId = '00000000-0000-4000-8000-000000000001';
const orgId = '00000000-0000-0000-0000-000000000002';
const assetId = '00000000-0000-4000-8000-000000000003';
const siteUrl = 'https://jump.example/gateway';
const identity: Identity = { siteId, userId: 'operator', name: 'Operator', orgId };
const configuration: OAuthConfiguration = {
  clientId: 'desktop-client',
  issuer: siteUrl,
  authorizationEndpoint: `${siteUrl}/core/auth/oauth2-provider/authorize/`,
  tokenEndpoint: `${siteUrl}/core/auth/oauth2-provider/token/`,
  revocationEndpoint: `${siteUrl}/core/auth/oauth2-provider/revoke/`
};

let userData = '';

interface AuthRuntime {
  host: AdapterHost;
  invoke(command: string, args: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}
const runtimes: AuthRuntime[] = [];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function storedSession(): StoredOAuthSession {
  return {
    siteId,
    siteUrl,
    identity: { ...identity },
    configuration: { ...configuration },
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000
    }
  };
}

function currentRecord(): StoredOAuthSession | null {
  return vault.record as StoredOAuthSession | null;
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function defaultCoreResponse(url: string): Response {
  switch (pathOf(url)) {
    case '/gateway/api/v1/users/profile/':
      return json({ id: identity.userId, name: identity.name });
    case '/gateway/api/v1/orgs/orgs/current/':
      return json({ id: orgId, name: 'Default' });
    default:
      throw new Error(`unexpected OAuth session request: ${url}`);
  }
}

function makeRuntime() {
  const emit = vi.fn();
  const onLogout = vi.fn(async () => {});
  const authorizeInBrowser = vi.fn(async () => 'jms://auth/callback?code=unused&state=unused');
  const runtime = createAuthRuntime({
      window: {} as never,
      emit,
      update: vi.fn(),
      sessions: () => [],
      tasks: () => [],
      onLogout,
      authorizeInBrowser
    });
  runtimes.push(runtime);
  return {
    runtime,
    emit,
    onLogout,
    authorizeInBrowser
  };
}

async function saveSite(runtime: AuthRuntime): Promise<void> {
  await runtime.invoke('site.save', { id: siteId, name: 'JumpServer', url: siteUrl });
}

async function bootstrap(runtime: AuthRuntime): Promise<Snapshot> {
  return runtime.invoke('app.bootstrap', {}) as Promise<Snapshot>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  const deferred = Promise.withResolvers<T>();
  return { promise: deferred.promise, resolve: deferred.resolve };
}

function permittedNode(id: string, key: string, name: string, path: string): Record<string, unknown> {
  return {
    id,
    name,
    key,
    value: name,
    full_value: path,
    org_id: orgId,
    assets_amount: 0
  };
}

const terminalContext: ResourceContext = {
  siteId,
  userId: identity.userId,
  orgId,
  assetId,
  assetName: 'Bastion',
  address: 'bastion.example',
  accountId: 'account-1',
  accountName: 'root',
  protocol: 'ssh',
  connectMethod: { value: 'native_cli', component: 'koko', type: 'native' }
};

function nativeClientUrl(payload: unknown): string {
  return `jms://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function configureNativeAuthorization(clientUrl: string): void {
  oauthNetwork.fetch.mockImplementation(async (url: string) => {
    switch (pathOf(url)) {
      case '/gateway/api/v1/perms/users/self/assets/00000000-0000-4000-8000-000000000003/':
        return json({
          id: assetId,
          name: terminalContext.assetName,
          address: terminalContext.address,
          org_id: orgId,
          permed_protocols: [{ name: 'ssh' }],
          permed_accounts: [{ id: terminalContext.accountId, name: terminalContext.accountName }]
        });
      case '/gateway/api/v1/terminal/components/connect-methods/':
        return json({ ssh: [{ component: 'koko', type: 'native', value: 'native_cli', label: 'Native CLI', endpoint_protocol: 'ssh' }] });
      case '/gateway/api/v1/authentication/connection-token/':
        return json({ id: 'native-token', is_active: true, from_ticket: null });
      case '/gateway/api/v1/authentication/connection-token/native-token/client-url/':
        return json({ url: clientUrl });
      default:
        return defaultCoreResponse(url);
    }
  });
}

async function waitForSshClient(index: number): Promise<InstanceType<typeof ssh.Client>> {
  await vi.waitFor(() => expect(ssh.clients).toHaveLength(index + 1));
  return ssh.clients[index]!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  ssh.clients.splice(0);
  userData = await mkdtemp(join(tmpdir(), 'jumpserver-auth-runtime-'));
  electron.app.getPath.mockReturnValue(userData);
  electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  electron.session.fromPartition.mockImplementation((partition: string) =>
    partition.includes('component') ? componentNetwork : oauthNetwork
  );
  vault.record = null;
  vault.load.mockImplementation(async () => currentRecord());
  vault.save.mockImplementation(async (record: StoredOAuthSession) => {
    vault.record = structuredClone(record);
  });
  vault.clear.mockImplementation(async () => {
    vault.record = null;
  });
  oauthNetwork.fetch.mockImplementation(async (url: string) => defaultCoreResponse(url));
  componentNetwork.fetch.mockImplementation(async (url: string) => {
    throw new Error(`unexpected component request: ${url}`);
  });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await rm(userData, { recursive: true, force: true });
});

describe('desktop OAuth authentication lifecycle', () => {
  it('restores a saved identity after normal disposal, but deletes it before explicit revocation on logout', async () => {
    const order: string[] = [];
    vault.record = storedSession();
    vault.clear.mockImplementation(async () => {
      order.push('clear');
      vault.record = null;
    });
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      if (pathOf(url) === '/gateway/core/auth/oauth2-provider/revoke/') {
        order.push('revoke');
        return new Response(null, { status: 204 });
      }
      return defaultCoreResponse(url);
    });

    const first = makeRuntime();
    await saveSite(first.runtime);
    await expect(bootstrap(first.runtime)).resolves.toMatchObject({ identity });
    await first.runtime.dispose();
    await expect(bootstrap(first.runtime)).rejects.toThrow();

    expect(currentRecord()).toMatchObject({ identity });
    expect(vault.clear).not.toHaveBeenCalled();

    const second = makeRuntime();
    await expect(bootstrap(second.runtime)).resolves.toMatchObject({ identity });
    await second.runtime.invoke('auth.logout', {});

    expect(currentRecord()).toBeNull();
    expect(order).toEqual(['clear', 'revoke']);
    expect(second.emit).toHaveBeenCalledWith({ type: 'identity', identity: null });
  });

  it('keeps the active identity and saved credentials when token refresh is temporarily unavailable', async () => {
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      switch (pathOf(url)) {
        case '/gateway/api/v1/perms/users/self/assets/':
          return new Response(null, { status: 401 });
        case '/gateway/core/auth/oauth2-provider/token/':
          return new Response('unavailable', { status: 503 });
        default:
          return defaultCoreResponse(url);
      }
    });

    const { runtime, onLogout } = makeRuntime();
    await saveSite(runtime);
    await expect(bootstrap(runtime)).resolves.toMatchObject({ identity });

    await expect(runtime.invoke('assets.list', {})).rejects.toMatchObject({ kind: 'network' });
    await expect(bootstrap(runtime)).resolves.toMatchObject({ identity });
    expect(currentRecord()).toMatchObject({ identity, tokens: { accessToken: 'access-token' } });
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('clears the active identity and saved credentials when refresh is terminally rejected', async () => {
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      switch (pathOf(url)) {
        case '/gateway/api/v1/perms/users/self/assets/':
          return new Response(null, { status: 401 });
        case '/gateway/core/auth/oauth2-provider/token/':
          return json({ error: 'invalid_grant' }, 400);
        default:
          return defaultCoreResponse(url);
      }
    });

    const { runtime, emit, onLogout } = makeRuntime();
    await saveSite(runtime);
    await expect(bootstrap(runtime)).resolves.toMatchObject({ identity });

    await expect(runtime.invoke('assets.list', {})).rejects.toMatchObject({ kind: 'rejected' });
    await expect(bootstrap(runtime)).resolves.toMatchObject({ identity: null });
    expect(currentRecord()).toBeNull();
    expect(onLogout).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({ type: 'identity', identity: null });
  });

  it.each([
    ['auth.cancel', true],
    ['auth.logout', false]
  ] as const)('does not restore delayed credentials after %s invalidates a pending login', async (command, retainsCredentials) => {
    vault.record = storedSession();
    const { runtime, emit, authorizeInBrowser } = makeRuntime();
    await saveSite(runtime);

    const lateRecord = currentRecord();
    const delayedLoad = deferred<StoredOAuthSession | null>();
    vault.load.mockImplementation(() => delayedLoad.promise);

    const startup = bootstrap(runtime);
    const login = runtime.invoke('auth.login', { siteId });
    await runtime.invoke(command, {});
    delayedLoad.resolve(lateRecord);

    await expect(startup).resolves.toMatchObject({ identity: null });
    await expect(login).rejects.toMatchObject({ kind: 'cancelled' });
    expect(authorizeInBrowser).not.toHaveBeenCalled();
    expect(oauthNetwork.fetch).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ type: 'identity', identity: null });
    expect(currentRecord()).toEqual(retainsCredentials ? lateRecord : null);
  });

  it('sends the category filter through authorized and favorite searches with the filtered favorite total', async () => {
    const secondFavoriteId = '00000000-0000-4000-8000-000000000004';
    const nodeId = '00000000-0000-4000-8000-000000000005';
    const mysqlAsset = {
      id: assetId,
      name: '账务 MySQL',
      address: 'mysql.example.test',
      org_id: orgId,
      category: { value: 'database', label: 'Database' },
      type: { value: 'mysql', label: 'MySQL' }
    };
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      if (pathOf(url) === '/gateway/api/v1/perms/users/self/assets/') {
        return json({ count: 1, results: [mysqlAsset] });
      }
      return defaultCoreResponse(url);
    });

    const { runtime } = makeRuntime();
    await saveSite(runtime);
    const snapshot = await bootstrap(runtime);

    await expect(runtime.invoke('assets.list', { category: 'database', search: '账务', nodeId })).resolves.toEqual({
      assets: [{ id: assetId, name: '账务 MySQL', address: 'mysql.example.test', orgId, protocols: [], category: 'database', type: 'mysql' }],
      total: 1
    });
    await runtime.invoke('preferences.save', {
      preferences: { ...snapshot.preferences, favorites: [assetId, secondFavoriteId] }
    });
    await expect(runtime.invoke('assets.list', { category: 'database', search: '账务', nodeId, favoritesOnly: true })).resolves.toMatchObject({
      assets: [{ id: assetId, category: 'database', type: 'mysql' }],
      total: 1
    });

    const assetRequests = oauthNetwork.fetch.mock.calls
      .map(([url]) => new URL(url as string))
      .filter((url) => pathOf(url.toString()) === '/gateway/api/v1/perms/users/self/assets/');
    expect(assetRequests).toHaveLength(2);
    expect(assetRequests.map((url) => [
      url.searchParams.get('category'),
      url.searchParams.get('search'),
      url.searchParams.get('node_id')
    ])).toEqual([
      ['database', '账务', nodeId],
      ['database', '账务', nodeId]
    ]);
    expect(assetRequests[1]?.searchParams.get('id__in')).toBe(`${assetId},${secondFavoriteId}`);
  });

  it('filters only documented synthetic root nodes while preserving Core key nesting', async () => {
    const root = permittedNode('00000000-0000-4000-8000-000000000010', '1', 'Production', '/Default/Production');
    const child = permittedNode('00000000-0000-4000-8000-000000000011', '1:2', 'Web', '/Default/Production/Web');
    const grandchild = permittedNode('00000000-0000-4000-8000-000000000012', '1:2:3', 'Frontend', '/Default/Production/Web/Frontend');
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      if (pathOf(url) === '/gateway/api/v1/perms/users/self/nodes/children/') {
        return json({
          count: 4,
          results: [
            { id: 'favorite', key: 'favorite', name: 'Favorite' },
            root,
            child,
            grandchild
          ]
        });
      }
      return defaultCoreResponse(url);
    });

    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);

    await expect(runtime.invoke('assets.groups', {})).resolves.toEqual({
      groups: [
        { id: root.id, key: '1', parentKey: '', name: 'Production', path: '/Default/Production' },
        { id: child.id, key: '1:2', parentKey: '1', name: 'Web', path: '/Default/Production/Web' },
        { id: grandchild.id, key: '1:2:3', parentKey: '1:2', name: 'Frontend', path: '/Default/Production/Web/Frontend' }
      ]
    });
    const request = oauthNetwork.fetch.mock.calls
      .map(([url]) => new URL(url as string))
      .find((url) => pathOf(url.toString()) === '/gateway/api/v1/perms/users/self/nodes/children/');
    expect(request?.searchParams.get('key')).toBeNull();
  });

  it('returns global Core path-search results without loading the full node tree', async () => {
    const grandchild = permittedNode('00000000-0000-4000-8000-000000000012', '1:2:3', 'Billing', '/Default/Production/Web/Billing');
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      if (pathOf(url) === '/gateway/api/v1/perms/users/self/nodes/') {
        return json({ count: 1, results: [grandchild] });
      }
      return defaultCoreResponse(url);
    });

    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);

    await expect(runtime.invoke('assets.groups', { search: 'Billing' })).resolves.toEqual({
      groups: [
        { id: grandchild.id, key: '1:2:3', parentKey: '1:2', name: 'Billing', path: '/Default/Production/Web/Billing' }
      ]
    });
    const searches = oauthNetwork.fetch.mock.calls
      .map(([url]) => new URL(url as string))
      .filter((url) => pathOf(url.toString()) === '/gateway/api/v1/perms/users/self/nodes/')
      .map((url) => url.searchParams.get('search'));
    expect(searches).toEqual(['Billing']);
  });

  it('keeps the authorized node scope while paging filtered favorites', async () => {
    const nodeId = '00000000-0000-4000-8000-000000000013';
    const secondFavoriteId = '00000000-0000-4000-8000-000000000014';
    const firstAsset = {
      id: assetId,
      name: 'App server',
      address: 'app.example.test',
      org_id: orgId,
      category: 'host',
      type: 'linux'
    };
    const secondAsset = {
      id: secondFavoriteId,
      name: 'Database server',
      address: 'db.example.test',
      org_id: orgId,
      category: 'host',
      type: 'linux'
    };
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      if (pathOf(url) === '/gateway/api/v1/perms/users/self/assets/') {
        const request = new URL(url);
        return json(request.searchParams.get('offset') === '0'
          ? { count: 2, results: [firstAsset] }
          : { count: 2, results: [secondAsset] });
      }
      return defaultCoreResponse(url);
    });

    const { runtime } = makeRuntime();
    await saveSite(runtime);
    const snapshot = await bootstrap(runtime);
    await runtime.invoke('preferences.save', {
      preferences: { ...snapshot.preferences, favorites: [assetId, secondFavoriteId] }
    });

    await expect(runtime.invoke('assets.list', {
      nodeId,
      search: 'server',
      category: 'host',
      favoritesOnly: true
    })).resolves.toEqual({
      assets: [
        { id: assetId, name: 'App server', address: 'app.example.test', orgId, protocols: [], category: 'host', type: 'linux' },
        { id: secondFavoriteId, name: 'Database server', address: 'db.example.test', orgId, protocols: [], category: 'host', type: 'linux' }
      ],
      total: 2
    });
    const requests = oauthNetwork.fetch.mock.calls
      .map(([url]) => new URL(url as string))
      .filter((url) => pathOf(url.toString()) === '/gateway/api/v1/perms/users/self/assets/');
    expect(requests.map((url) => [
      url.searchParams.get('id__in'),
      url.searchParams.get('node_id'),
      url.searchParams.get('search'),
      url.searchParams.get('category'),
      url.searchParams.get('offset')
    ])).toEqual([
      [`${assetId},${secondFavoriteId}`, nodeId, 'server', 'host', '0'],
      [`${assetId},${secondFavoriteId}`, nodeId, 'server', 'host', '1']
    ]);
  });

  it('rejects an authorized group response that arrives after identity invalidation', async () => {
    const pendingResponse = deferred<Response>();
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      if (pathOf(url) === '/gateway/api/v1/perms/users/self/nodes/children/') return pendingResponse.promise;
      return defaultCoreResponse(url);
    });

    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);
    const groups = runtime.invoke('assets.groups', {});
    await vi.waitFor(() => expect(oauthNetwork.fetch.mock.calls.some(
      ([url]) => pathOf(url as string) === '/gateway/api/v1/perms/users/self/nodes/children/'
    )).toBe(true));
    await runtime.invoke('auth.logout', {});
    pendingResponse.resolve(json({
      count: 1,
      results: [permittedNode('00000000-0000-4000-8000-000000000015', '1', 'Production', '/Default/Production')]
    }));

    await expect(groups).rejects.toThrow('认证状态已变更');
  });

  it('refreshes after a POST 401 without replaying the connection-token request', async () => {
    vault.record = storedSession();
    oauthNetwork.fetch.mockImplementation(async (url: string) => {
      switch (pathOf(url)) {
        case '/gateway/api/v1/perms/users/self/assets/00000000-0000-4000-8000-000000000003/':
          return json({
            id: assetId,
            name: terminalContext.assetName,
            address: terminalContext.address,
            org_id: orgId,
            permed_protocols: [{ name: 'ssh' }],
            permed_accounts: [{ id: terminalContext.accountId, name: terminalContext.accountName }]
          });
        case '/gateway/api/v1/terminal/components/connect-methods/':
          return json({ ssh: [{ component: 'koko', type: 'native', value: 'native_cli', label: 'Native CLI', endpoint_protocol: 'ssh' }] });
        case '/gateway/api/v1/authentication/connection-token/':
          return new Response(null, { status: 401 });
        case '/gateway/core/auth/oauth2-provider/token/':
          return json({ access_token: 'rotated-access-token', refresh_token: 'rotated-refresh-token', token_type: 'Bearer', expires_in: 3_600 });
        default:
          return defaultCoreResponse(url);
      }
    });

    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await expect(bootstrap(runtime)).resolves.toMatchObject({ identity });

    await expect(runtime.host.authorizeNative(terminalContext, 'terminal')).rejects.toThrow('未自动重放');
    expect(oauthNetwork.fetch.mock.calls.filter(([url]) => pathOf(url as string) === '/gateway/api/v1/authentication/connection-token/')).toHaveLength(1);
    expect(currentRecord()).toMatchObject({ tokens: { accessToken: 'rotated-access-token', refreshToken: 'rotated-refresh-token' } });
  });


  it('uses only the server-bound native client URL and password authentication after host-key trust', async () => {
    vault.record = storedSession();
    configureNativeAuthorization(nativeClientUrl({
      version: 2,
      protocol: 'ssh',
      asset: { id: assetId },
      endpoint: { host: 'gateway.example', port: 2_222 },
      token: { id: 'native-token', value: 'gateway-password' },
      command: 'ignored by desktop',
      file: { content: 'ignored by desktop' }
    }));
    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);

    const pending = runtime.host.authorizeNative(terminalContext, 'terminal');
    const client = await waitForSshClient(0);
    expect(client.config).toMatchObject({
      host: 'gateway.example',
      port: 2_222,
      username: 'JMS-native-token',
      readyTimeout: 20_000,
      tryKeyboard: false
    });
    expect(client.config).not.toHaveProperty('password');
    expect(client.config).not.toHaveProperty('agent');
    expect(client.config).not.toHaveProperty('privateKey');
    if (!client.config?.authHandler) throw new Error('password-only auth handler was not configured');
    const credential = Promise.withResolvers<unknown>();
    client.config.authHandler([], false, credential.resolve);
    await expect(credential.promise).resolves.toEqual({
      type: 'password',
      username: 'JMS-native-token',
      password: 'gateway-password'
    });
    await expect(client.verifyHostKey(Buffer.from('gateway-host-key'))).resolves.toBe(true);
    client.emitReady();

    const connection = await pending;
    expect(connection).toMatchObject({ client });
    connection.close();
    const clientUrlRequest = oauthNetwork.fetch.mock.calls.find(([url]) =>
      pathOf(url as string) === '/gateway/api/v1/authentication/connection-token/native-token/client-url/');
    expect(new Headers((clientUrlRequest?.[1] as RequestInit).headers).get('Authorization')).toBe('Bearer access-token');
  });

  it.each([
    ['asset', {
      version: 2,
      protocol: 'ssh',
      asset: { id: 'foreign-asset' },
      endpoint: { host: 'gateway.example', port: 2_222 },
      token: { id: 'native-token', value: 'gateway-password' }
    }],
    ['protocol', {
      version: 2,
      protocol: 'sftp',
      asset: { id: assetId },
      endpoint: { host: 'gateway.example', port: 2_222 },
      token: { id: 'native-token', value: 'gateway-password' }
    }],
    ['token', {
      version: 2,
      protocol: 'ssh',
      asset: { id: assetId },
      endpoint: { host: 'gateway.example', port: 2_222 },
      token: { id: 'foreign-token', value: 'gateway-password' }
    }]
  ])('rejects a native client URL with a foreign %s binding before opening SSH', async (_binding, payload) => {
    vault.record = storedSession();
    configureNativeAuthorization(nativeClientUrl(payload));
    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);

    await expect(runtime.host.authorizeNative(terminalContext, 'terminal')).rejects.toThrow('不一致');
    expect(ssh.clients).toHaveLength(0);
  });

  it('requires conspicuous approval when a remembered SSH gateway key changes', async () => {
    vault.record = storedSession();
    configureNativeAuthorization(nativeClientUrl({
      version: 2,
      protocol: 'ssh',
      asset: { id: assetId },
      endpoint: { host: 'gateway.example', port: 2_222 },
      token: { id: 'native-token', value: 'gateway-password' }
    }));
    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);

    const firstPending = runtime.host.authorizeNative(terminalContext, 'terminal');
    const first = await waitForSshClient(0);
    await expect(first.verifyHostKey(Buffer.from('first gateway key'))).resolves.toBe(true);
    first.emitReady();
    (await firstPending).close();

    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    const changedPending = runtime.host.authorizeNative(terminalContext, 'terminal');
    const changed = await waitForSshClient(1);
    await expect(changed.verifyHostKey(Buffer.from('changed gateway key'))).resolves.toBe(false);
    changed.emitError();
    await expect(changedPending).rejects.toThrow('主机密钥未获信任');
    const changedPrompt = electron.dialog.showMessageBox.mock.calls.at(-1)?.[1] as { detail: string; defaultId: number; cancelId: number };
    for (const key of ['first gateway key', 'changed gateway key']) {
      expect(changedPrompt.detail).toContain(`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`);
    }
    expect(changedPrompt.defaultId).toBe(0);
    expect(changedPrompt.cancelId).toBe(0);
  });


  it('does not pin a host key when its trust prompt resolves after SSH has closed', async () => {
    vault.record = storedSession();
    configureNativeAuthorization(nativeClientUrl({
      version: 2,
      protocol: 'ssh',
      asset: { id: assetId },
      endpoint: { host: 'gateway.example', port: 2_222 },
      token: { id: 'native-token', value: 'gateway-password' }
    }));
    const delayedApproval = Promise.withResolvers<{ response: number }>();
    electron.dialog.showMessageBox.mockReturnValueOnce(delayedApproval.promise);
    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);

    const pending = runtime.host.authorizeNative(terminalContext, 'terminal');
    const rejected = expect(pending).rejects.toThrow('无法建立 SSH 网关连接');
    const client = await waitForSshClient(0);
    const hostVerification = client.verifyHostKey(Buffer.from('gateway-host-key'));
    await vi.waitFor(() => expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce());
    client.emitError();
    delayedApproval.resolve({ response: 1 });

    await expect(hostVerification).resolves.toBe(false);
    await rejected;
    await expect(readFile(join(userData, 'credentials', 'ssh-host-keys.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(client.destroy).toHaveBeenCalledOnce();
  });
  it('aborts a pending native connection on logout and rejects a late SSH ready event', async () => {
    vault.record = storedSession();
    configureNativeAuthorization(nativeClientUrl({
      version: 2,
      protocol: 'ssh',
      asset: { id: assetId },
      endpoint: { host: 'gateway.example', port: 2_222 },
      token: { id: 'native-token', value: 'gateway-password' }
    }));
    const { runtime } = makeRuntime();
    await saveSite(runtime);
    await bootstrap(runtime);

    const pending = runtime.host.authorizeNative(terminalContext, 'terminal');
    const rejected = expect(pending).rejects.toThrow('认证状态已变更');
    const client = await waitForSshClient(0);
    await expect(client.verifyHostKey(Buffer.from('gateway-host-key'))).resolves.toBe(true);
    await runtime.invoke('auth.logout', {});
    client.emitReady();

    await rejected;
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
