import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponentConnection } from './component-connection';
import type { AuthorizedConnection } from '../../../../packages/adapters-jumpserver/src/host';

const network = vi.hoisted(() => ({
  fetch: vi.fn(),
  webRequest: { onBeforeRequest: vi.fn() },
  closeAllConnections: vi.fn(async () => {}),
  clearStorageData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
  clearAuthCache: vi.fn(async () => {})
}));
vi.mock('electron', () => ({ session: { fromPartition: () => network }, net: {} }));

const orgId = '00000000-0000-0000-0000-000000000002';
const actionPath = '/chen/api/resources/actions/do';
let connection: AuthorizedConnection;

beforeEach(() => {
  vi.clearAllMocks();
  network.fetch.mockImplementation(async (url: string) => url.endsWith('/auth')
    ? Response.json({ token: 'chen-session-token' })
    : new Response('Resource action denied', { status: 403 }));
  connection = createComponentConnection({
    endpointUrl: 'https://chen.example/gateway', tokenId: 'core-connection-token', orgId,
    assertCurrent() {}, onClose() {}
  });
});
afterEach(() => connection.close());

async function authenticate() {
  await connection.request('/chen/api/auth', {
    method: 'POST', body: { token: 'core-connection-token', disableAutoHash: true }
  });
}

describe('Chen component route authorization', () => {
  it('reaches server resource authorization for view_data without opening broader routes or methods', async () => {
    await authenticate();
    await expect(connection.request(actionPath, {
      method: 'POST', headers: { token: 'chen-session-token' },
      body: { action: 'view_data', node: { key: 'schema/table' } }
    })).rejects.toThrow(/HTTP 403/);

    for (const path of [actionPath + '/', actionPath + '?token=leak', '/chen/api/resources/actions/other']) {
      await expect(connection.request(path, { method: 'POST', headers: { token: 'chen-session-token' } })).rejects.toThrow();
    }
    await expect(connection.request(actionPath, { headers: { token: 'chen-session-token' } })).rejects.toThrow();
    await expect(connection.request(actionPath, { method: 'POST', headers: { token: 'another-connection' } })).rejects.toThrow();
    await expect(connection.request(actionPath, { method: 'POST', headers: { token: 'chen-session-token' }, orgId: '00000000-0000-0000-0000-000000000003' })).rejects.toThrow();
    expect(network.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://chen.example/gateway/chen/api/auth',
      'https://chen.example/gateway/chen/api/resources/actions/do'
    ]);
  });

  it('keeps the Chromium guard restricted to the bound origin and exact prefixed path', () => {
    const guard = network.webRequest.onBeforeRequest.mock.calls[0]![0];
    const decisions: boolean[] = [];
    for (const url of [
      'https://chen.example/gateway/chen/api/resources/actions/do',
      'https://other.example/gateway/chen/api/resources/actions/do',
      'https://chen.example/chen/api/resources/actions/do',
      'https://chen.example/gateway/chen/api/resources/actions/other'
    ]) guard({ url }, ({ cancel }: { cancel: boolean }) => decisions.push(cancel));
    expect(decisions).toEqual([false, true, true, true]);
  });
});
