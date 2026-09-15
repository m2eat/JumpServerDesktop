import { randomUUID } from 'node:crypto';
import { net, session } from 'electron';
import type { WebSocket as ElectronWebSocket } from 'electron';
import { z } from 'zod';
import type { AuthorizedConnection, SocketEvent, SocketLike } from '../../../../packages/adapters-jumpserver/src/host';

const requestSchema = z.object({
  method: z.enum(['GET', 'POST']).optional(),
  body: z.unknown().optional(),
  orgId: z.string().guid().optional(),
  query: z.record(z.string(), z.string()).optional(),
  signal: z.instanceof(AbortSignal).optional(),
  headers: z.record(z.string(), z.string()).optional()
}).strict();
const socketSchema = z.object({
  query: z.record(z.string(), z.string()).optional(),
  protocols: z.array(z.string().min(1).max(4_096)).max(1).optional()
}).strict();
const chenMethods: Readonly<Record<string, string>> = {
  '/chen/api/auth': 'POST',
  '/chen/api/profile': 'GET',
  '/chen/api/resources/children': 'POST',
  '/chen/api/resources/actions/do': 'POST'
};

function eventData(event: Event): SocketEvent {
  const data = 'data' in event ? event.data : undefined;
  const code = 'code' in event ? event.code : undefined;
  const reason = 'reason' in event ? event.reason : undefined;
  return {
    ...(data === undefined ? {} : { data }),
    ...(typeof code === 'number' ? { code } : {}),
    ...(typeof reason === 'string' ? { reason } : {})
  };
}

class ChromiumSocket implements SocketLike {
  private readonly listeners = new Map<string, Map<(event: SocketEvent) => void, EventListener>>();

  constructor(private readonly socket: ElectronWebSocket, onClose: (socket: ChromiumSocket) => void) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('close', () => onClose(this));
  }

  get readyState(): number { return this.socket.readyState; }
  get bufferedAmount(): number { return this.socket.bufferedAmount; }
  get binaryType(): string { return this.socket.binaryType; }
  set binaryType(value: string) {
    if (value !== 'arraybuffer' && value !== 'blob') throw new Error('不支持的 WebSocket 二进制类型');
    this.socket.binaryType = value;
  }
  send(data: string | Uint8Array): void { this.socket.send(data); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const perType = this.listeners.get(type) ?? new Map<(event: SocketEvent) => void, EventListener>();
    if (perType.has(listener)) return;
    const wrapped: EventListener = (event) => listener(eventData(event));
    perType.set(listener, wrapped);
    this.listeners.set(type, perType);
    this.socket.addEventListener(type, wrapped);
  }
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const perType = this.listeners.get(type);
    const wrapped = perType?.get(listener);
    if (!perType || !wrapped) return;
    this.socket.removeEventListener(type, wrapped);
    perType.delete(listener);
    if (perType.size === 0) this.listeners.delete(type);
  }
}

interface ComponentConnectionOptions {
  endpointUrl: string;
  tokenId: string;
  orgId: string;
  assertCurrent(): void;
  onClose(connection: AuthorizedConnection): void;
}

export function createComponentConnection(options: ComponentConnectionOptions): AuthorizedConnection {
  const endpoint = new URL(options.endpointUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('组件入口必须是受信的 HTTPS 地址');
  }
  const prefix = endpoint.pathname.replace(/\/+$/, '');
  const network = session.fromPartition(`memory:jumpserver-component-${randomUUID()}`, { cache: false });
  const abort = new AbortController();
  const sockets = new Set<ChromiumSocket>();
  let closed = false;
  let chenToken: string | undefined;
  const socketPaths = ['/chen/ws/session', '/chen/ws/console'];
  const allowedPaths = [...socketPaths, ...Object.keys(chenMethods)].map((path) => `${prefix}${path}`);
  const assertOpen = () => {
    if (closed) throw new Error('组件连接已关闭');
    options.assertCurrent();
  };
  const targetUrl = (path: string, websocket = false) => {
    assertOpen();
    if (!(websocket ? socketPaths.includes(path) : Object.hasOwn(chenMethods, path))) {
      throw new Error('请求不属于此连接允许的组件路由');
    }
    const target = new URL(`${prefix}${path}`, endpoint.origin);
    if (websocket) target.protocol = 'wss:';
    return target;
  };
  // Also constrain Chromium's redirects and authentication retries, not just initial URLs.
  network.webRequest.onBeforeRequest((details, callback) => {
    try {
      assertOpen();
      const target = new URL(details.url);
      const origin = target.protocol === 'wss:' ? `https://${target.host}` : target.origin;
      callback({ cancel: !['https:', 'wss:'].includes(target.protocol) || origin !== endpoint.origin || !allowedPaths.includes(target.pathname) });
    } catch {
      callback({ cancel: true });
    }
  });

  const connection: AuthorizedConnection = {
    tokenId: options.tokenId,
    request: async (path, rawOptions = {}) => {
      const target = targetUrl(path);
      const request = requestSchema.parse(rawOptions);
      const method = request.method ?? 'GET';
      if (method !== chenMethods[path]) throw new Error('组件请求方法不在允许列表中');
      if (request.orgId !== undefined && request.orgId !== options.orgId) throw new Error('组件请求组织与连接不一致');
      if (Object.keys(request.query ?? {}).length) throw new Error('此组件请求不接受查询参数');
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
        Referer: endpoint.origin,
        Origin: endpoint.origin,
        'X-JMS-ORG': options.orgId
      };
      if (path === '/chen/api/auth') {
        const body = z.object({ token: z.literal(options.tokenId), disableAutoHash: z.boolean() }).strict().parse(request.body);
        if (chenToken || Object.keys(request.headers ?? {}).length) throw new Error('Chen 认证请求不能复用会话或覆盖请求头');
        request.body = body;
      } else {
        if (!chenToken || request.headers?.token !== chenToken || Object.keys(request.headers).length !== 1) {
          throw new Error('Chen 请求令牌不属于此连接');
        }
        headers.token = chenToken;
      }
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      let response: Response;
      try {
        response = await network.fetch(target.toString(), {
          method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          credentials: 'include',
          redirect: 'error',
          signal: request.signal ? AbortSignal.any([abort.signal, request.signal]) : abort.signal
        });
      } catch {
        assertOpen();
        throw new Error('组件请求失败或返回了不允许的重定向');
      }
      assertOpen();
      if (response.status >= 300 && response.status < 400) throw new Error('组件请求不允许重定向');
      if (!response.ok) throw new Error(`组件请求失败（HTTP ${response.status}）`);
      const text = await response.text();
      assertOpen();
      let result: unknown;
      try { result = text.trim() ? JSON.parse(text) : null; }
      catch { throw new Error('组件返回了无效 JSON'); }
      if (path === '/chen/api/auth') chenToken = z.object({ token: z.string().min(1) }).parse(result).token;
      return result;
    },
    socket: (path, rawOptions = {}) => {
      const target = targetUrl(path, true);
      const input = socketSchema.parse(rawOptions);
      if (!chenToken || input.protocols?.length !== 1 || input.protocols[0] !== chenToken || Object.keys(input.query ?? {}).length) {
        throw new Error('Chen WebSocket 令牌不属于此连接');
      }
      const socket = new net.WebSocket(target.toString(), {
        protocols: input.protocols,
        origin: endpoint.origin,
        useSessionCookies: true,
        session: network
      });
      const wrapped = new ChromiumSocket(socket, (value) => sockets.delete(value));
      sockets.add(wrapped);
      return wrapped;
    },
    close: () => {
      if (closed) return;
      closed = true;
      chenToken = undefined;
      abort.abort();
      for (const socket of sockets) socket.close(1000, 'connection closed');
      sockets.clear();
      options.onClose(connection);
      // Invalidated immediately; drain HTTP work before purging any late Set-Cookie writes.
      void Promise.allSettled([network.closeAllConnections()]).then(() =>
        Promise.allSettled([network.clearStorageData(), network.clearCache(), network.clearAuthCache()]));
    }
  };
  return connection;
}
