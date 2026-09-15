import type { Client } from 'ssh2';
import type { AppEvent, ResourceContext, SessionInfo } from '../../desktop-contract/src/index';
export interface RequestOptions { method?: string; body?: unknown; orgId?: string; query?: Record<string, string>; signal?: AbortSignal; headers?: Record<string, string> }
export interface SocketEvent { data?: unknown; code?: number; reason?: string }
export interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
}
export interface AuthorizedConnection {
  readonly tokenId: string;
  request(path: string, options?: RequestOptions): Promise<unknown>;
  socket(path: string, options?: { query?: Record<string, string>; protocols?: string[] }): SocketLike;
  close(): void;
}
export interface AuthorizedSshConnection {
  readonly client: Client;
  close(): void;
}

export interface AdapterHost {
  authorize(context: ResourceContext, kind: 'database'): Promise<AuthorizedConnection>;
  authorizeNative(context: ResourceContext, kind: 'terminal' | 'files'): Promise<AuthorizedSshConnection>;
  assertContext(context: ResourceContext): void;
  emit(event: AppEvent): void;
  update(session: SessionInfo): void;
}
export interface SshService {
  open(kind: 'terminal' | 'files', context: ResourceContext): Promise<SessionInfo>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  invoke(command: string, args: unknown): Promise<unknown>;
}
export interface ChenService {
  open(context: ResourceContext): Promise<SessionInfo>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  invoke(command: string, args: unknown): Promise<unknown>;
}
