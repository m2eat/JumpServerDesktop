import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type {
  ApplyResult,
  Capability,
  DbCell,
  DbColumn,
  DbNode,
  Preview,
  QueryResult,
  ResourceContext,
  SessionInfo,
} from '../../../desktop-contract/src/index';
import type { AdapterHost, AuthorizedConnection, ChenService, SocketEvent, SocketLike } from '../host';
import { createSqlTableSnapshot, tableMetadataSql, tableSearchSql } from './sql-crud';
import type { SqlTableSnapshot } from './sql-crud';

const CONNECT_TIMEOUT_MS = 30_000;
const SESSION_READY_TIMEOUT_MS = 120_000;
const CONSOLE_READY_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_SQL_LENGTH = 1_000_000;
const SQL_CHUNK_SIZE = 4096;
const MAX_RESULT_ROWS = 5_000;
const MAX_TABLE_PAGE_STEPS = 1_000;

const QUERY_READONLY = '普通 SQL 查询结果只读；请从资源树打开基础表以编辑。';
const SQL_CRUD_REASON = '客户端生成 SQL，经 Chen ACL 与审计逐条提交；不是原子批次，提交未确认时禁止重试。';
const PREVIEW_TTL_MS = 5 * 60_000;
const CRUD_QUERY_TIMEOUT_MS = 45_000;

const authResponseSchema = z.object({
  token: z.string().min(1),
  lang: z.string().min(1)
}).passthrough();

const profileSchema = z.object({
  dbType: z.string().min(1),
  canCopy: z.boolean(),
  canPaste: z.boolean()
}).passthrough();

const wireTreeNodeSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  label: z.string().optional(),
  hasChildren: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional()
}).passthrough();

const wirePacketSchema = z.object({
  type: z.string().min(1),
  data: z.unknown().optional()
}).strict();

const wireFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  isPrimaryKey: z.boolean().optional(),
}).passthrough();

const wireDataViewSchema = z.object({
  fields: z.array(wireFieldSchema),
  data: z.array(z.record(z.string(), z.unknown()))
}).passthrough();

// Release QueryConsole/ResultBar and DataView route by title, not development-only ids.
const wireDataViewUpdateSchema = z.object({
  title: z.string().min(1),
  data: wireDataViewSchema
}).passthrough();

const wireStateSchema = z.object({
  title: z.string().optional(),
  loading: z.boolean().optional(),
  inQuery: z.boolean().optional(),
  canCancel: z.boolean().optional(),
  executionStatus: z.string().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  total: z.number().int().optional(),
  truncated: z.boolean().optional(),
  rowLimit: z.number().int().optional()
}).passthrough();

// Chen v4.10.19 sends only title; newer consoleId metadata is not used by this adapter.
const wireConsoleInitSchema = z.object({
  title: z.string().min(1)
}).passthrough();

const wireDataViewCreatedSchema = z.object({
  title: z.string().min(1),
}).passthrough();

const wireViewDataActionSchema = z.object({
  event: z.literal('view_data'),
  data: z.string().min(1)
}).passthrough();

const wireSqlErrorSchema = z.object({
  message: z.string().min(1),
  title: z.string().optional(),
  kind: z.string().optional(),
  sqlState: z.string().optional(),
  vendorCode: z.number().int().optional()
}).passthrough();

const dbTreeArgsSchema = z.object({
  sessionId: z.string().min(1),
  key: z.string().min(1).optional()
}).strict();

const dbQueryArgsSchema = z.object({
  sessionId: z.string().min(1),
  sql: z.string().min(1).max(MAX_SQL_LENGTH)
}).strict();

const dbCancelArgsSchema = z.object({
  sessionId: z.string().min(1)
}).strict();

const dbTableSearchSchema = z.object({
  text: z.string().max(512),
  column: z.string().min(1).optional()
}).strict();

const dbTableArgsSchema = z.object({
  sessionId: z.string().min(1),
  schema: z.string().min(1),
  table: z.string().min(1),
  page: z.number().int().positive(),
  limit: z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(500)]),
  search: dbTableSearchSchema.optional()
}).strict();

const cellValueSchema = z.union([z.string().max(MAX_SQL_LENGTH), z.boolean(), z.null()]);
const writeValueSchema = z.union([cellValueSchema, z.object({ kind: z.literal('default') }).strict()]);
const dbPreviewArgsSchema = z.object({
  sessionId: z.string().min(1),
  changes: z.object({
    schema: z.string().min(1),
    table: z.string().min(1),
    snapshotId: z.string().uuid(),
    updates: z.array(z.object({
      row: z.record(z.string(), cellValueSchema),
      values: z.record(z.string(), writeValueSchema)
    }).strict()).max(100),
    inserts: z.array(z.record(z.string(), writeValueSchema)).max(100),
    deletes: z.array(z.record(z.string(), cellValueSchema)).max(100)
  }).strict()
}).strict();

const dbApplyArgsSchema = z.object({
  sessionId: z.string().min(1),
  previewId: z.string().min(1)
}).strict();

type WirePacket = z.infer<typeof wirePacketSchema>;
type WireTreeNode = z.infer<typeof wireTreeNodeSchema>;
type WireState = z.infer<typeof wireStateSchema>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

interface QueryDataView {
  data?: z.infer<typeof wireDataViewSchema>;
  state?: WireState;
}

interface ActiveQuery {
  startedAt: number;
  running: boolean;
  results: Map<string, QueryDataView>;
  messages: string[];
  error?: string;
  affectedRows?: number;
  deferred: Deferred<QueryResult>;
  cancelDeferred?: Deferred<void>;
  terminal: boolean;
}

interface QueryConsole {
  socket: SocketLike;
  title: string;
  ready: Deferred<void>;
  active?: ActiveQuery;
  connectionId?: string;
  lastAffectedRows?: number;
  heartbeat?: NodeJS.Timeout;
}

interface TableConsole {
  key: string;
  schema: string;
  table: string;
  socket: SocketLike;
  error?: Error;
  dataViewTitle?: string;
  lastData?: z.infer<typeof wireDataViewSchema>;
  lastState: WireState;
  awaiting?: Deferred<QueryResult>;
  startedAt: number;
  heartbeat?: NodeJS.Timeout;
  tail: Promise<void>;
}

interface ChenSession {
  info: SessionInfo;
  connection?: AuthorizedConnection;
  token: string;
  closed: boolean;
  primary?: SocketLike;
  primaryReady?: Deferred<void>;
  primaryHeartbeat?: NodeJS.Timeout;
  rootKey?: string;
  nodes: Map<string, WireTreeNode>;
  query?: QueryConsole;
  tables: Map<string, TableConsole>;
  writer?: QueryConsole;
  crudBusy: boolean;
  snapshot?: SqlTableSnapshot;
  preview?: { view: Preview; snapshot: SqlTableSnapshot };
  writeBlocked?: string;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(errorMessage(reason)));
      }
    );
  });
}

function decodeSocketData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  throw new Error('Chen WebSocket 收到非文本数据帧');
}

function parsePacket(event: SocketEvent): WirePacket {
  const raw = decodeSocketData(event.data);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Chen WebSocket 收到格式错误的 JSON 数据');
  }
  return wirePacketSchema.parse(decoded);
}

function sendPacket(socket: SocketLike, type: string, data?: unknown): void {
  if (socket.readyState !== 1) throw new Error('Chen WebSocket 未连接');
  socket.send(JSON.stringify(data === undefined ? { type } : { type, data }));
}

function waitForSocketOpen(socket: SocketLike, label: string): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  const ready = deferred<void>();
  const onOpen = () => {
    cleanup();
    ready.resolve();
  };
  const onClose = (event: SocketEvent) => {
    cleanup();
    ready.reject(new Error(`${label}已关闭：${event.reason || String(event.code || '')}`));
  };
  const onError = () => {
    cleanup();
    ready.reject(new Error(`${label}连接失败`));
  };
  const cleanup = () => {
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
  };
  socket.addEventListener('open', onOpen);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  return withTimeout(ready.promise, CONNECT_TIMEOUT_MS, label);
}

function toDbCell(value: unknown, columnName: string): DbCell {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Chen 返回了无效数值列：${columnName}`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`Chen 将精确整数以 JSON number 返回，无法保证列 ${columnName} 的精度`);
    }
    return String(value);
  }
  throw new Error(`Chen 返回了无法安全表示的列 ${columnName}`);
}

function resultFromDataView(
  data: z.infer<typeof wireDataViewSchema>,
  state: WireState | undefined,
  startedAt: number,
  message: string
): QueryResult {
  const columns: DbColumn[] = data.fields.map((field) => ({
    name: field.name,
    type: field.type || 'unknown',
    primaryKey: field.isPrimaryKey === true,
    editable: false
  }));
  const clientTruncated = data.data.length > MAX_RESULT_ROWS;
  const sourceRows = clientTruncated ? data.data.slice(0, MAX_RESULT_ROWS) : data.data;
  const rows = sourceRows.map((row) => columns.map((column) => {
    if (!Object.prototype.hasOwnProperty.call(row, column.name)) return null;
    return toDbCell(row[column.name], column.name);
  }));
  const truncation = state?.truncated === true || clientTruncated;
  const suffix = clientTruncated ? `；客户端仅展示前 ${MAX_RESULT_ROWS} 行` : '';
  return {
    columns,
    rows,
    message: `${message}${suffix}`,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    truncated: truncation,
    editable: false,
    readonlyReason: QUERY_READONLY
  };
}

function emptyResult(startedAt: number, message: string): QueryResult {
  return {
    columns: [],
    rows: [],
    message,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    truncated: false,
    editable: false,
    readonlyReason: QUERY_READONLY
  };
}

function capability(state: Capability['state'], reason: string): Capability {
  return { state, reason };
}

function sessionInfo(id: string, generation: number, context: ResourceContext): SessionInfo {
  return {
    id,
    generation,
    kind: 'database',
    phase: 'connecting',
    detached: false,
    context,
    capabilities: {
      query: capability('supported', '经 Chen 主会话和查询控制台执行，保留服务端 ACL 与审计。'),
      tableBrowse: capability('supported', '经 Chen data_view 控制台分页读取。'),
      sqlCrud: capability('supported', SQL_CRUD_REASON)
    }
  };
}

function mapNodeKind(type: string): DbNode['kind'] {
  switch (type) {
    case 'datasource':
    case 'database':
      return 'database';
    case 'schema':
      return 'schema';
    case 'table':
      return 'table';
    case 'view':
      return 'view';
    case 'field':
      return 'column';
    default:
      return 'other';
  }
}

function contextFromTreeKey(key: string): { schema?: string; table?: string } {
  const parts = key.split(',');
  let schema: string | undefined;
  let table: string | undefined;
  for (const part of parts) {
    const separator = part.indexOf(':');
    if (separator < 1) continue;
    const type = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (type === 'schema') schema = value;
    if (type === 'table' || type === 'view') table = value;
  }
  return { schema, table };
}

function dbNodeFromWire(node: WireTreeNode): DbNode {
  const context = contextFromTreeKey(node.key);
  return {
    key: node.key,
    name: node.label || node.key,
    kind: mapNodeKind(node.type),
    leaf: node.type === 'table' || node.hasChildren === false,
    schema: context.schema,
    table: context.table
  };
}

function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    if ('message' in data && typeof data.message === 'string') return data.message;
    if ('body' in data && typeof data.body === 'string') return data.body;
    if ('title' in data && typeof data.title === 'string') return data.title;
  }
  return 'Chen 服务器发送了无法解析的消息';
}

function isErrorMessage(data: unknown): boolean {
  return data !== null && typeof data === 'object' &&
    (('type' in data && data.type === 'error') || ('level' in data && data.level === 0));
}

function dialogNeedsConfirmation(data: unknown): boolean {
  const parsed = z.object({ buttons: z.array(z.unknown()).optional() }).passthrough().safeParse(data);
  if (!parsed.success) return true;
  return (parsed.data.buttons?.length || 0) > 0;
}

function tableKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

export function createChenService(host: AdapterHost): ChenService {
  const sessions = new Map<string, ChenSession>();
  let generation = 0;

  function owns(record: ChenSession): boolean {
    return sessions.get(record.info.id) === record && !record.closed;
  }

  function publish(record: ChenSession): void {
    if (owns(record)) host.update(record.info);
  }

  function announce(record: ChenSession, message: string): void {
    if (owns(record)) host.emit({ type: 'notice', message });
  }

  function stopHeartbeat(timer: NodeJS.Timeout | undefined): void {
    clearInterval(timer);
  }

  function rejectActiveQuery(query: QueryConsole | undefined, reason: Error): void {
    if (!query?.active) return;
    query.active.deferred.reject(reason);
    query.active.cancelDeferred?.reject(reason);
    query.active = undefined;
  }

  function rejectTableWaiters(record: ChenSession, reason: Error): void {
    for (const table of record.tables.values()) {
      table.awaiting?.reject(reason);
      table.awaiting = undefined;
    }
  }

  function stopRecordSockets(record: ChenSession): void {
    stopHeartbeat(record.primaryHeartbeat);
    stopHeartbeat(record.query?.heartbeat);
    stopHeartbeat(record.writer?.heartbeat);
    for (const table of record.tables.values()) stopHeartbeat(table.heartbeat);
    record.query?.socket.close(1000, 'Chen 会话结束');
    record.writer?.socket.close(1000, 'Chen 会话结束');
    for (const table of record.tables.values()) table.socket.close(1000, 'Chen 会话结束');
    record.primary?.close(1000, 'Chen 会话结束');
    record.connection?.close();
    record.connection = undefined;
  }

  function fail(record: ChenSession, reason: string): void {
    if (!owns(record)) return;
    record.closed = true;
    sessions.delete(record.info.id);
    record.info = { ...record.info, phase: 'failed', error: reason };
    host.update(record.info);
    host.emit({ type: 'notice', message: `数据库会话已阻止：${reason}` });
    record.primaryReady?.reject(new Error(reason));
    record.query?.ready.reject(new Error(reason));
    record.writer?.ready.reject(new Error(reason));
    rejectActiveQuery(record.query, new Error(reason));
    rejectActiveQuery(record.writer, new Error(reason));
    rejectTableWaiters(record, new Error(reason));
    stopRecordSockets(record);
  }

  function assertActive(record: ChenSession): void {
    if (!owns(record) || record.info.phase !== 'active') throw new Error('数据库会话已结束或失效');
    host.assertContext(record.info.context);
  }

  async function chenRequest(
    record: ChenSession,
    path: string,
    method: 'GET' | 'POST',
    body?: unknown
  ): Promise<unknown> {
    if (!owns(record)) throw new Error('数据库会话已结束或失效');
    if (method === 'GET' && body !== undefined) throw new Error('Chen GET 请求不能包含请求体');
    host.assertContext(record.info.context);
    const connection = record.connection;
    if (!connection) throw new Error('数据库会话未获得连接授权');
    const options = body === undefined
      ? { method, orgId: record.info.context.orgId, headers: { token: record.token } }
      : { method, body, orgId: record.info.context.orgId, headers: { token: record.token } };
    return connection.request(path, options);
  }

  function cacheNodes(record: ChenSession, nodes: WireTreeNode[]): DbNode[] {
    for (const node of nodes) record.nodes.set(node.key, node);
    return nodes.map(dbNodeFromWire);
  }

  async function loadTree(record: ChenSession, key?: string): Promise<DbNode[]> {
    assertActive(record);
    const parent = key === undefined ? undefined : record.nodes.get(key);
    if (key !== undefined && !parent) throw new Error('请求的数据库节点不属于当前会话元数据树');
    const response = await chenRequest(record, '/chen/api/resources/children', 'POST', parent);
    const nodes = z.array(wireTreeNodeSchema).parse(response);
    if (!owns(record)) throw new Error('数据库会话已在加载元数据时结束');
    return cacheNodes(record, nodes);
  }

  function startPrimaryHeartbeat(record: ChenSession): void {
    stopHeartbeat(record.primaryHeartbeat);
    record.primaryHeartbeat = setInterval(() => {
      const primary = record.primary;
      if (!owns(record) || !primary || primary.readyState !== 1) return;
      try {
        sendPacket(primary, 'ping');
      } catch {
        fail(record, 'Chen 主会话心跳发送失败');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function onPrimaryPacket(record: ChenSession, packet: WirePacket): void {
    if (!owns(record)) return;
    switch (packet.type) {
      case 'pong':
      case 'close_dialog':
        return;
      case 'set_ready':
        startPrimaryHeartbeat(record);
        record.primaryReady?.resolve();
        return;
      case 'show_message':
      case 'global_message':
        announce(record, `Chen：${messageText(packet.data)}`);
        return;
      case 'show_dialog': {
        const message = messageText(packet.data);
        if (dialogNeedsConfirmation(packet.data)) {
          fail(record, `Chen 要求受控确认（${message}），但桌面桥接未提供确认协议，未自动确认。`);
        } else {
          announce(record, `Chen 提示：${message}`);
        }
        return;
      }
      case 'session_close':
      case 'close_session':
        fail(record, `Chen 服务端关闭会话：${messageText(packet.data)}`);
        return;
      default:
        announce(record, `Chen 主会话收到未映射消息：${packet.type}`);
    }
  }

  function attachPrimary(record: ChenSession): void {
    const primary = record.primary;
    if (!primary) throw new Error('Chen 主会话尚未创建');
    primary.addEventListener('message', (event) => {
      try {
        onPrimaryPacket(record, parsePacket(event));
      } catch (cause) {
        fail(record, `Chen 主会话协议错误：${errorMessage(cause)}`);
      }
    });
    primary.addEventListener('close', (event) => {
      if (owns(record)) fail(record, `Chen 主会话已关闭：${event.reason || String(event.code || '')}`);
    });
    primary.addEventListener('error', () => {
      if (owns(record)) fail(record, 'Chen 主会话网络错误');
    });
  }

  function finishQuery(query: QueryConsole, active: ActiveQuery): boolean {
    if (query.active !== active || active.terminal) return false;
    active.terminal = true;
    query.active = undefined;
    query.lastAffectedRows = active.affectedRows;
    if (active.cancelDeferred) {
      active.cancelDeferred.reject(new Error('Chen 未确认取消；查询已按服务器终态完成。'));
      active.cancelDeferred = undefined;
    }
    return true;
  }

  function resolveQueryResult(query: QueryConsole, active: ActiveQuery): void {
    if (query.active !== active || active.terminal) return;
    const results = [...active.results.values()].filter((result) => result.data !== undefined);
    if (results.length > 1) {
      if (finishQuery(query, active)) {
        active.deferred.reject(new Error('Chen 返回了多个结果集；当前 db.query 契约只能安全表示单个结果集。'));
      }
      return;
    }
    const result = results[0];
    let resolved: QueryResult;
    try {
      resolved = result?.data
        ? resultFromDataView(result.data, result.state, active.startedAt, active.messages.at(-1) || 'Chen 查询完成')
        : emptyResult(active.startedAt, active.messages.at(-1) || 'Chen 查询已完成，未返回表格结果。');
    } catch (cause) {
      if (finishQuery(query, active)) {
        active.deferred.reject(cause instanceof Error ? cause : new Error(errorMessage(cause)));
      }
      return;
    }
    if (finishQuery(query, active)) active.deferred.resolve(resolved);
  }

  function rejectQuery(record: ChenSession, query: QueryConsole, reason: string): void {
    const active = query.active;
    if (!active) return;
    query.active = undefined;
    active.terminal = true;
    const error = new Error(reason);
    active.cancelDeferred?.reject(error);
    active.deferred.reject(error);
  }

  function queryResultFor(query: QueryConsole, title: string): QueryDataView {
    const active = query.active;
    if (!active) throw new Error('Chen 返回了不属于当前查询的结果');
    const existing = active.results.get(title);
    if (existing) return existing;
    const result: QueryDataView = {};
    active.results.set(title, result);
    return result;
  }

  function onQueryPacket(record: ChenSession, query: QueryConsole, packet: WirePacket): void {
    if (!owns(record)) return;
    if (packet.type === 'init') {
      const init = wireConsoleInitSchema.parse(packet.data);
      query.title = init.title;
      query.ready.resolve();
      return;
    }
    if (packet.type === 'pong') return;
    if (packet.type === 'log' || packet.type === 'message') {
      const text = messageText(packet.data);
      if (query.active) {
        query.active.messages.push(text);
        if (isErrorMessage(packet.data)) query.active.error = text;
        // Chen v4.10.19 Logger.success(SQLQueryResult) emits this non-localized level-3
        // acknowledgement. Do not infer write success from a generic completion or UI wording.
        const log = z.object({ level: z.number(), message: z.string() }).safeParse(packet.data);
        const count = packet.type === 'log' && log.success && log.data.level === 3
          ? /^(\d+) rows affected in \d+ ms$/.exec(log.data.message) : null;
        if (count) {
          const value = Number(count[1]);
          query.active.affectedRows = query.active.affectedRows === undefined && Number.isSafeInteger(value) ? value : -1;
        }
      }
      if (packet.type === 'log') return;
      announce(record, `Chen：${text}`);
      return;
    }
    if (packet.type === 'sql_error') {
      const error = wireSqlErrorSchema.parse(packet.data);
      if (query.active) query.active.error = error.message;
      return;
    }
    if (packet.type === 'new_data_view') {
      const created = wireDataViewCreatedSchema.parse(packet.data);
      if (query.active) queryResultFor(query, created.title);
      return;
    }
    if (packet.type === 'update_data_view') {
      const update = wireDataViewUpdateSchema.parse(packet.data);
      if (!query.active) return;
      const result = queryResultFor(query, update.title);
      result.data = update.data;
      return;
    }
    if (packet.type === 'update_state') {
      const state = wireStateSchema.parse(packet.data);
      const active = query.active;
      if (!active) return;
      if (state.title === query.title) {
        if (state.inQuery === true) active.running = true;
        if (state.executionStatus === 'cancelled' && active.cancelDeferred) active.cancelDeferred.resolve();
        if (state.inQuery === false && active.running) {
          if (state.executionStatus === 'cancelled') {
            query.active = undefined;
            active.terminal = true;
            active.cancelDeferred?.resolve();
            active.deferred.reject(new Error('查询已由 Chen 服务端取消'));
          } else if (active.error || state.executionStatus === 'error') {
            rejectQuery(record, query, active.error || active.messages.at(-1) || 'Chen 拒绝或未能执行查询');
          } else {
            resolveQueryResult(query, active);
          }
        }
        return;
      }
      if (state.title) {
        const result = active.results.get(state.title);
        if (result) result.state = state;
      }
      return;
    }
    if (packet.type === 'close_data_view') return;
    if (packet.type === 'close') {
      fail(record, 'Chen 服务端关闭查询控制台');
      return;
    }
    announce(record, `Chen 查询控制台收到未映射消息：${packet.type}`);
  }

  function startConsoleHeartbeat(record: ChenSession, console: QueryConsole | TableConsole): void {
    stopHeartbeat(console.heartbeat);
    console.heartbeat = setInterval(() => {
      if (!owns(record) || console.socket.readyState !== 1) return;
      try {
        sendPacket(console.socket, 'ping');
      } catch {
        if (console === record.query || console === record.writer) fail(record, 'Chen 查询控制台心跳发送失败');
        else if ('awaiting' in console) console.awaiting?.reject(new Error('Chen 表浏览控制台心跳发送失败'));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  async function openQueryConsole(record: ChenSession, nodeKey: string, writer = false): Promise<QueryConsole> {
    const connection = record.connection;
    if (!owns(record) || !connection) throw new Error('数据库会话已结束或未获得连接授权');
    const socket = connection.socket('/chen/ws/console', { protocols: [record.token] });
    const query: QueryConsole = { socket, title: '', ready: deferred<void>() };
    if (writer) record.writer = query;
    else record.query = query;
    socket.addEventListener('message', (event) => {
      try {
        onQueryPacket(record, query, parsePacket(event));
      } catch (cause) {
        rejectQuery(record, query, `Chen 查询控制台协议错误：${errorMessage(cause)}`);
        fail(record, `Chen 查询控制台协议错误：${errorMessage(cause)}`);
      }
    });
    socket.addEventListener('close', (event) => {
      if (owns(record)) fail(record, `Chen 查询控制台已关闭：${event.reason || String(event.code || '')}`);
    });
    socket.addEventListener('error', () => {
      if (owns(record)) fail(record, 'Chen 查询控制台网络错误');
    });
    await withTimeout(Promise.all([
      query.ready.promise,
      waitForSocketOpen(socket, 'Chen 查询控制台').then(() => {
        if (!owns(record)) throw new Error('数据库会话已结束或失效');
        sendPacket(socket, 'connect', { nodeKey, type: 'query' });
      })
    ]), CONSOLE_READY_TIMEOUT_MS, 'Chen 查询控制台初始化');
    startConsoleHeartbeat(record, query);
    return query;
  }

  async function runQuery(record: ChenSession, query: QueryConsole, sql: string, bounded = false): Promise<QueryResult> {
    assertActive(record);
    query.lastAffectedRows = undefined;
    if (query.active) throw new Error('当前 Chen 控制台已有运行中的查询。');
    const active: ActiveQuery = {
      startedAt: Date.now(), running: false, results: new Map(), messages: [],
      deferred: deferred<QueryResult>(), terminal: false
    };
    query.active = active;
    // send() may synchronously trigger a socket failure before this function returns its waiter.
    void active.deferred.promise.catch(() => {});
    try {
      if (sql.length <= SQL_CHUNK_SIZE) {
        sendPacket(query.socket, 'query_console_action', { action: 'run_sql', data: sql });
      } else {
        const requestId = randomUUID();
        const total = Math.ceil(sql.length / SQL_CHUNK_SIZE);
        for (let index = 0; index < total; index += 1) {
          sendPacket(query.socket, 'query_console_action', {
            action: 'run_sql_chunk',
            data: { requestId, chunk: sql.slice(index * SQL_CHUNK_SIZE, (index + 1) * SQL_CHUNK_SIZE), index, total }
          });
        }
        sendPacket(query.socket, 'query_console_action', { action: 'run_sql_complete', data: { requestId, total } });
      }
    } catch (cause) {
      query.active = undefined;
      throw cause;
    }
    if (!bounded) return active.deferred.promise;
    try {
      return await withTimeout(active.deferred.promise, CRUD_QUERY_TIMEOUT_MS, 'Chen 表格操作');
    } catch (cause) {
      // A timed-out console cannot be reused: its late completion could satisfy another operation.
      if (query.active === active) fail(record, '表格操作超时，连接已停用；未确认的写入不得重试。');
      throw cause;
    }
  }

  async function exclusiveTableOperation<T>(record: ChenSession, operation: () => Promise<T>): Promise<T> {
    assertActive(record);
    if (record.crudBusy || record.query?.active) throw new Error('当前会话已有查询或表格操作，请等待完成。');
    record.crudBusy = true;
    try { return await operation(); }
    finally { record.crudBusy = false; }
  }

  function assertWritable(record: ChenSession): void {
    assertActive(record);
    if (record.writeBlocked) throw new Error(record.writeBlocked);
  }

  function markerSql(marker: string): string {
    return `SELECT '${marker}' AS __jms_marker, CAST(CONNECTION_ID() AS CHAR) AS __jms_connection, CAST(@@session.autocommit AS CHAR) AS __jms_autocommit LIMIT 1`;
  }

  function readMarker(result: QueryResult, marker: string, connectionId?: string): Record<string, DbCell> {
    if (result.truncated || result.rows.length !== 1) throw new Error('Chen 未返回唯一的执行确认。');
    const row = Object.fromEntries(result.columns.map((column, index) => [column.name, result.rows[0]?.[index] ?? null]));
    if (row.__jms_marker !== marker || typeof row.__jms_connection !== 'string' || !/^\d+$/.test(row.__jms_connection)) {
      throw new Error('Chen 执行确认缺失或被脱敏，不能据此判断提交结果。');
    }
    if (connectionId !== undefined && row.__jms_connection !== connectionId) throw new Error('执行过程中数据库连接发生变化。');
    return row;
  }

  async function getWriter(record: ChenSession): Promise<QueryConsole> {
    if (!record.rootKey) throw new Error('Chen 缺少当前数据源上下文。');
    const writer = record.writer ?? await openQueryConsole(record, record.rootKey, true);
    if (!writer.connectionId) {
      const marker = randomUUID();
      const result = await runQuery(record, writer,
        `SET SESSION autocommit = 1; SET SESSION innodb_lock_wait_timeout = 10; SET SESSION sql_mode = CONCAT_WS(',', @@session.sql_mode, 'STRICT_ALL_TABLES'); ${markerSql(marker)}`, true);
      const state = readMarker(result, marker);
      if (state.__jms_autocommit !== '1') throw new Error('Chen 执行连接未处于已确认的自动提交模式。');
      writer.connectionId = state.__jms_connection as string;
    }
    return writer;
  }

  async function verifyTransactionMode(record: ChenSession, writer: QueryConsole, mode: '0' | '1'): Promise<void> {
    const marker = randomUUID();
    const result = await runQuery(record, writer, markerSql(marker), true);
    if (readMarker(result, marker, writer.connectionId).__jms_autocommit !== mode) {
      throw new Error('Chen 或数据库改变了事务模式，无法保证本条的回滚范围。');
    }
  }

  async function rollbackCurrent(record: ChenSession, writer: QueryConsole): Promise<void> {
    await runQuery(record, writer, 'ROLLBACK', true);
    if (writer.lastAffectedRows !== 0) throw new Error('Chen 未确认回滚指令。');
    await runQuery(record, writer, 'SET SESSION autocommit = 1', true);
    await verifyTransactionMode(record, writer, '1');
  }

  function unknownApply(record: ChenSession, applied: number, total: number, failedIndex: number, reason: string): ApplyResult {
    const message = `已确认提交 ${applied}/${total} 条；第 ${failedIndex + 1} 条结果未知。${reason} 请核实实际数据后重新连接，禁止直接重试该批次。`;
    record.writeBlocked = message;
    record.preview = undefined;
    record.snapshot = undefined;
    record.info = {
      ...record.info,
      capabilities: { ...record.info.capabilities, sqlCrud: capability('unsupported', message) }
    };
    publish(record);
    return { outcome: 'unknown', applied, total, failedIndex, message };
  }

  async function applyPreview(record: ChenSession, plan: NonNullable<ChenSession['preview']>): Promise<ApplyResult> {
    const total = plan.view.sql.length;
    let writer: QueryConsole;
    try {
      writer = await getWriter(record);
      const metadata = await runQuery(record, writer, tableMetadataSql(plan.view.schema, plan.view.table), true);
      const current = createSqlTableSnapshot(plan.view.schema, plan.view.table, metadata, plan.snapshot.result);
      if (current.metadataFingerprint !== plan.snapshot.metadataFingerprint) throw new Error('表结构已改变，请刷新后重新编辑。');
    } catch (cause) {
      return { outcome: 'not-started', applied: 0, total, failure: 'rejected', message: `未发送修改：${errorMessage(cause)}` };
    }
    let applied = 0;
    for (let index = 0; index < total; index += 1) {
      const sql = plan.view.sql[index]!;
      let affected: number | undefined;
      let sent = false;
      try {
        await runQuery(record, writer, 'SET SESSION autocommit = 0', true);
        await verifyTransactionMode(record, writer, '0');
        // The DML is the entire ACL input, not hidden behind transaction prefixes or a
        // trailing SELECT. Anchored command rules must see exactly the previewed statement.
        sent = true;
        await runQuery(record, writer, sql, true);
        affected = writer.lastAffectedRows;
        await verifyTransactionMode(record, writer, '0');
      } catch (cause) {
        try {
          if (sent) await verifyTransactionMode(record, writer, '0');
          await rollbackCurrent(record, writer);
        } catch {
          try { await rollbackCurrent(record, writer); } catch { /* Best-effort lock cleanup only. */ }
          return unknownApply(record, applied, total, index, `事务状态或回滚未获确认：${errorMessage(cause)}`);
        }
        return {
          outcome: applied ? 'partial' : 'not-started', applied, total, failedIndex: index, failure: 'rejected',
          message: `已提交 ${applied}/${total} 条；当前条已回滚并停止，后续未执行。${errorMessage(cause)}`
        };
      }
      if (affected !== 1) {
        try { await rollbackCurrent(record, writer); }
        catch (cause) { return unknownApply(record, applied, total, index, `回滚未确认：${errorMessage(cause)}`); }
        const conflict = affected === 0;
        return {
          outcome: applied ? 'partial' : 'not-started', applied, total, failedIndex: index,
          failure: conflict ? 'conflict' : 'rejected',
          message: `已提交 ${applied}/${total} 条；当前条已回滚，后续未执行。${conflict
            ? '原值条件未匹配或数据库未产生变更；请刷新核对，不能据此断言记录已删除。'
            : 'Chen 未返回可验证的单行影响数，已拒绝继续提交。'}`
        };
      }
      try {
        await runQuery(record, writer, 'COMMIT', true);
        if (writer.lastAffectedRows !== 0) throw new Error('Chen 未确认提交指令。');
      } catch (cause) {
        // Even a confirmed cleanup rollback cannot prove that the earlier COMMIT did not succeed.
        try { await rollbackCurrent(record, writer); } catch { /* Frozen below regardless of cleanup outcome. */ }
        return unknownApply(record, applied, total, index, `提交确认丢失：${errorMessage(cause)}`);
      }
      applied += 1;
      try {
        await runQuery(record, writer, 'SET SESSION autocommit = 1', true);
        await verifyTransactionMode(record, writer, '1');
      } catch (cause) {
        record.writeBlocked = `已提交 ${applied} 条，但执行连接清理失败；请重新连接。${errorMessage(cause)}`;
        record.info = {
          ...record.info,
          capabilities: { ...record.info.capabilities, sqlCrud: capability('unsupported', record.writeBlocked) }
        };
        publish(record);
        return {
          outcome: applied === total ? 'committed' : 'partial', applied, total,
          message: record.writeBlocked
        };
      }
    }
    return { outcome: 'committed', applied, total, message: `已确认逐条提交 ${applied} 条修改；这不是原子批次。` };
  }

  function finishTableResult(table: TableConsole): void {
    if (!table.awaiting || !table.lastData || table.lastState.loading !== false) return;
    if (table.error) {
      table.awaiting.reject(table.error);
      table.awaiting = undefined;
      return;
    }
    const waiter = table.awaiting;
    table.awaiting = undefined;
    try {
      waiter.resolve(resultFromDataView(table.lastData, table.lastState, table.startedAt, 'Chen 表浏览完成'));
    } catch (cause) {
      waiter.reject(cause instanceof Error ? cause : new Error(errorMessage(cause)));
    }
  }

  function onTablePacket(record: ChenSession, table: TableConsole, packet: WirePacket): void {
    if (!owns(record)) return;
    if (packet.type === 'init') {
      wireConsoleInitSchema.parse(packet.data);
      startConsoleHeartbeat(record, table);
      return;
    }
    if (packet.type === 'pong') return;
    if (packet.type === 'new_data_view') {
      const created = wireDataViewCreatedSchema.parse(packet.data);
      table.dataViewTitle = created.title;
      return;
    }
    if (packet.type === 'update_data_view') {
      const update = wireDataViewUpdateSchema.parse(packet.data);
      if (update.title !== table.dataViewTitle) return;
      table.lastData = update.data;
      finishTableResult(table);
      return;
    }
    if (packet.type === 'update_state') {
      const state = wireStateSchema.parse(packet.data);
      if (state.title !== table.dataViewTitle) return;
      table.lastState = { ...table.lastState, ...state };
      finishTableResult(table);
      return;
    }
    if (packet.type === 'message' || packet.type === 'show_message') {
      const text = messageText(packet.data);
      announce(record, `Chen 表浏览：${text}`);
      if (isErrorMessage(packet.data)) rejectTable(table, new Error(text));
      return;
    }
    if (packet.type === 'sql_error') {
      const error = wireSqlErrorSchema.parse(packet.data);
      rejectTable(table, new Error(error.message));
      return;
    }
    if (packet.type === 'close') {
      rejectTable(table, new Error('Chen 服务端关闭表浏览控制台'));
      table.socket.close(1000, 'Chen 服务端关闭表浏览控制台');
      return;
    }
    if (packet.type === 'log') return;
    announce(record, `Chen 表浏览控制台收到未映射消息：${packet.type}`);
  }

  function rejectTable(table: TableConsole, error: Error): void {
    table.error = error;
    table.awaiting?.reject(error);
    table.awaiting = undefined;
  }

  async function openTableConsole(record: ChenSession, rawNode: WireTreeNode, schema: string, tableName: string): Promise<TableConsole> {
      const action = wireViewDataActionSchema.parse(await chenRequest(record, '/chen/api/resources/actions/do', 'POST', {
        node: rawNode,
        action: 'view_data'
      }));
      if (action.data !== rawNode.key) throw new Error('Chen 表浏览动作返回了不同的资源节点');
    const connection = record.connection;
    if (!owns(record) || !connection) throw new Error('数据库会话已结束或未获得连接授权');
    const socket = connection.socket('/chen/ws/console', { protocols: [record.token] });
    const table: TableConsole = {
      key: rawNode.key,
      schema,
      table: tableName,
      socket,
      lastState: {},
      startedAt: Date.now(),
      tail: Promise.resolve()
    };
    const key = tableKey(schema, tableName);
    record.tables.set(key, table);
    socket.addEventListener('message', (event) => {
      try {
        onTablePacket(record, table, parsePacket(event));
      } catch (cause) {
        const reason = `Chen 表浏览控制台协议错误：${errorMessage(cause)}`;
        rejectTable(table, new Error(reason));
        fail(record, reason);
      }
    });
    socket.addEventListener('close', (event) => {
      if (!owns(record)) return;
      const reason = `Chen 表浏览控制台已关闭：${event.reason || String(event.code || '')}`;
      stopHeartbeat(table.heartbeat);
      rejectTable(table, new Error(reason));
      record.tables.delete(tableKey(table.schema, table.table));
    });
    socket.addEventListener('error', () => {
      if (!owns(record)) return;
      const error = new Error('Chen 表浏览控制台网络错误');
      stopHeartbeat(table.heartbeat);
      rejectTable(table, error);
      record.tables.delete(tableKey(table.schema, table.table));
    });
    try {
      await waitForSocketOpen(socket, 'Chen 表浏览控制台');
      if (!owns(record)) throw new Error('数据库会话已结束或失效');
      sendPacket(socket, 'connect', { nodeKey: action.data, type: 'data_view' });
      if (table.error) throw table.error;
      return table;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(errorMessage(cause));
      rejectTable(table, error);
      stopHeartbeat(table.heartbeat);
      record.tables.delete(key);
      socket.close(1000, 'Chen 表浏览初始化失败');
      throw error;
    }
  }

  function requestTableAction(table: TableConsole, action: string, data?: number): Promise<QueryResult> {
    if (!table.dataViewTitle) throw new Error('Chen 表浏览尚未初始化数据视图');
    if (table.awaiting) throw new Error('Chen 表浏览请求仍在执行');
    const waiter = deferred<QueryResult>();
    table.awaiting = waiter;
    table.startedAt = Date.now();
    table.error = undefined;
    table.lastData = undefined;
    table.lastState = { ...table.lastState, loading: true };
    try {
      sendPacket(table.socket, 'data_view_action', {
        action,
        dataView: table.dataViewTitle,
        ...(data === undefined ? {} : { data })
      });
    } catch (cause) {
      table.awaiting = undefined;
      waiter.reject(cause instanceof Error ? cause : new Error(errorMessage(cause)));
    }
    return waiter.promise;
  }

  async function waitForInitialTable(table: TableConsole): Promise<QueryResult> {
    if (table.error) throw table.error;
    if (table.lastData && table.lastState.loading === false) {
      return resultFromDataView(table.lastData, table.lastState, table.startedAt, 'Chen 表浏览完成');
    }
    if (table.awaiting) return table.awaiting.promise;
    const waiter = deferred<QueryResult>();
    table.awaiting = waiter;
    return waiter.promise;
  }

  function queueTable<T>(table: TableConsole, operation: () => Promise<T>): Promise<T> {
    const next = table.tail.then(operation, operation);
    table.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async function moveTablePage(table: TableConsole, page: number, limit: 50 | 100 | 200 | 500): Promise<QueryResult> {
    let result = await waitForInitialTable(table);
    if (table.lastState.limit !== limit) result = await requestTableAction(table, 'change_limit', limit);
    let currentPage = table.lastState.page || 1;
    if (currentPage === page) return result;
    const steps = Math.abs(page - currentPage) + (page < currentPage && currentPage !== 1 ? 1 : 0);
    if (steps > MAX_TABLE_PAGE_STEPS) {
      throw new Error('Chen 协议仅支持逐页导航；请求跳转过远，已阻止。');
    }
    if (page < currentPage) {
      result = await requestTableAction(table, 'first_page');
      currentPage = table.lastState.page || 1;
    }
    while (currentPage < page) {
      result = await requestTableAction(table, 'next_page');
      const nextPage = table.lastState.page || currentPage;
      if (nextPage <= currentPage) throw new Error('Chen 未确认表浏览分页推进');
      currentPage = nextPage;
    }
    return result;
  }

  function findTableNode(record: ChenSession, schema: string, tableName: string): WireTreeNode {
    for (const node of record.nodes.values()) {
      if (node.type !== 'table' && node.type !== 'view') continue;
      const context = contextFromTreeKey(node.key);
      if (context.schema === schema && context.table === tableName) return node;
    }
    throw new Error('目标表尚未加载到 Chen 元数据树；请先在树中展开对应架构。');
  }

  async function open(context: ResourceContext): Promise<SessionInfo> {
    host.assertContext(context);
    const id = randomUUID();
    const info = sessionInfo(id, ++generation, context);
    const record: ChenSession = {
      info,
      token: '',
      closed: false,
      nodes: new Map(),
      crudBusy: false,
      tables: new Map()
    };
    sessions.set(id, record);
    publish(record);
    try {
      const connection = await host.authorize(context, 'database');
      if (!owns(record)) {
        connection.close();
        throw new Error('数据库会话已关闭');
      }
      record.connection = connection;
      const auth = authResponseSchema.parse(await connection.request('/chen/api/auth', {
        method: 'POST',
        body: { token: connection.tokenId, disableAutoHash: false },
        orgId: context.orgId
      }));
      if (!owns(record)) throw new Error('数据库会话已关闭');
      record.token = auth.token;
      const primary = connection.socket('/chen/ws/session', { protocols: [record.token] });
      record.primary = primary;
      record.primaryReady = deferred<void>();
      attachPrimary(record);
      await Promise.all([
        waitForSocketOpen(primary, 'Chen 主会话'),
        withTimeout(record.primaryReady.promise, SESSION_READY_TIMEOUT_MS, 'Chen 主会话初始化')
      ]);
      const profile = profileSchema.parse(await chenRequest(record, '/chen/api/profile', 'GET'));
      if (profile.dbType.toLowerCase() !== 'mysql') {
        throw new Error(`当前 Chen 会话数据库类型为 ${profile.dbType}，数据库工作台仅支持 MySQL。`);
      }
      record.info = { ...record.info, phase: 'active' };
      publish(record);
      const roots = await loadTree(record);
      const root = roots.find((node) => record.nodes.get(node.key)?.type === 'datasource');
      if (!root) throw new Error('Chen 未返回可用于查询的 datasource 根节点');
      record.rootKey = root.key;
      await openQueryConsole(record, root.key);
      announce(record, 'Chen 数据库会话已就绪；基础表编辑按元数据校验后开放，采用逐条确认提交。');
      return record.info;
    } catch (cause) {
      const reason = errorMessage(cause);
      fail(record, reason);
      throw new Error(reason);
    }
  }

  async function close(sessionId: string): Promise<void> {
    const record = sessions.get(sessionId);
    if (!record) return;
    record.closed = true;
    sessions.delete(sessionId);
    record.info = { ...record.info, phase: 'closed' };
    host.update(record.info);
    record.primaryReady?.reject(new Error('数据库会话已关闭'));
    record.query?.ready.reject(new Error('数据库会话已关闭'));
    record.writer?.ready.reject(new Error('数据库会话已关闭'));
    rejectActiveQuery(record.query, new Error('数据库会话已关闭'));
    rejectActiveQuery(record.writer, new Error('数据库会话已关闭'));
    rejectTableWaiters(record, new Error('数据库会话已关闭'));
    stopRecordSockets(record);
  }

  async function invoke(command: string, args: unknown): Promise<unknown> {
    switch (command) {
      case 'db.tree': {
        const input = dbTreeArgsSchema.parse(args);
        const record = sessions.get(input.sessionId);
        if (!record) throw new Error('数据库会话不存在');
        return loadTree(record, input.key);
      }
      case 'db.query': {
        const input = dbQueryArgsSchema.parse(args);
        const record = sessions.get(input.sessionId);
        if (!record) throw new Error('数据库会话不存在');
        assertActive(record);
        if (record.crudBusy) throw new Error('表格操作正在执行，请等待完成。');
        record.preview = undefined;
        record.snapshot = undefined;
        const query = record.query;
        if (!query) throw new Error('Chen 查询控制台尚未就绪');
        return runQuery(record, query, input.sql);
      }
      case 'db.cancel': {
        const input = dbCancelArgsSchema.parse(args);
        const record = sessions.get(input.sessionId);
        if (!record) throw new Error('数据库会话不存在');
        assertActive(record);
        const query = record.query;
        const active = query?.active;
        if (!query || !active) throw new Error('当前没有可取消的 Chen 查询');
        if (active.cancelDeferred) return active.cancelDeferred.promise;
        active.cancelDeferred = deferred<void>();
        try {
          sendPacket(query.socket, 'query_console_action', { action: 'cancel' });
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(errorMessage(cause));
          active.cancelDeferred.reject(error);
          active.cancelDeferred = undefined;
          throw error;
        }
        return active.cancelDeferred.promise;
      }
      case 'db.table': {
        const input = dbTableArgsSchema.parse(args);
        const record = sessions.get(input.sessionId);
        if (!record) throw new Error('数据库会话不存在');
        assertActive(record);
        return exclusiveTableOperation(record, async () => {
          record.preview = undefined;
          record.snapshot = undefined;
          const search = input.search?.text ? input.search : undefined;
          const key = tableKey(input.schema, input.table);
          let table = record.tables.get(key);
          const existing = table !== undefined;
          if (!table) {
            const node = findTableNode(record, input.schema, input.table);
            table = await openTableConsole(record, node, input.schema, input.table);
          }
          const current = table;
          if (search) {
            // v4.10.19 has no DataView filter action. Wait for the ACL-authorized
            // data view before sending our equivalent read through QueryConsole.
            await queueTable(current, () => waitForInitialTable(current));
            const query = record.query;
            if (!query) throw new Error('Chen 查询控制台尚未就绪');
            const metadata = await runQuery(record, query, tableMetadataSql(input.schema, input.table));
            const result = await runQuery(record, query,
              tableSearchSql(input.schema, input.table, metadata, search, input.page, input.limit));
            if (record.writeBlocked) return { ...result, readonlyReason: record.writeBlocked };
            const snapshot = createSqlTableSnapshot(input.schema, input.table, metadata, result);
            record.snapshot = snapshot;
            return snapshot.result;
          }
          const result = await queueTable(current, async () => {
            if (existing && current.lastState.page === input.page && current.lastState.limit === input.limit) {
              return requestTableAction(current, 'refresh');
            }
            return moveTablePage(current, input.page, input.limit);
          });
          if (record.writeBlocked) return { ...result, readonlyReason: record.writeBlocked };
          try {
            const writer = await getWriter(record);
            const metadata = await runQuery(record, writer, tableMetadataSql(input.schema, input.table), true);
            const snapshot = createSqlTableSnapshot(input.schema, input.table, metadata, result);
            record.snapshot = snapshot;
            return snapshot.result;
          } catch (cause) {
            assertActive(record);
            return { ...result, readonlyReason: `表数据可读，但无法验证编辑元数据：${errorMessage(cause)}` };
          }
        });
      }
      case 'db.preview': {
        const input = dbPreviewArgsSchema.parse(args);
        const record = sessions.get(input.sessionId);
        if (!record) throw new Error('数据库会话不存在');
        return exclusiveTableOperation(record, async () => {
          assertWritable(record);
          record.preview = undefined;
          const snapshot = record.snapshot;
          if (!snapshot || snapshot.result.snapshotId !== input.changes.snapshotId) throw new Error('表格基线已失效，请刷新后重新编辑。');
          const sql = snapshot.compile(input.changes);
          const writer = await getWriter(record);
          const metadata = await runQuery(record, writer, tableMetadataSql(input.changes.schema, input.changes.table), true);
          const verified = createSqlTableSnapshot(input.changes.schema, input.changes.table, metadata, snapshot.result);
          if (verified.metadataFingerprint !== snapshot.metadataFingerprint) throw new Error('表结构已改变，请刷新后重新编辑。');
          const view: Preview = {
            id: randomUUID(), sql, expiresAt: Date.now() + PREVIEW_TTL_MS,
            schema: input.changes.schema, table: input.changes.table, mode: 'sequential',
            counts: { updates: input.changes.updates.length, inserts: input.changes.inserts.length, deletes: input.changes.deletes.length },
            warnings: [
              '逐条独立事务提交，不是原子批次；后续失败不会撤销之前已提交的记录。',
              '每条 DML 单独交给 Chen ACL 与审计。核验影响行数和事务状态，冲突时回滚当前条并停止。',
              '无法确认提交时冻结写入；必须核实数据库实际状态后重新连接，不能直接重试。',
              '回滚保证仅覆盖事务性副作用；触发器、外部系统和自增序列不属于全量回滚保证。'
            ]
          };
          record.preview = { view, snapshot };
          return structuredClone(view);
        });
      }
      case 'db.apply': {
        const input = dbApplyArgsSchema.parse(args);
        const record = sessions.get(input.sessionId);
        if (!record) throw new Error('数据库会话不存在');
        return exclusiveTableOperation(record, async () => {
          assertWritable(record);
          const plan = record.preview;
          if (!plan || plan.view.id !== input.previewId) throw new Error('预览不存在、已失效或已提交；不能重复执行。');
          record.preview = undefined;
          record.snapshot = undefined;
          if (Date.now() >= plan.view.expiresAt) throw new Error('预览已过期，请重新读取并预览。');
          return applyPreview(record, plan);
        });
      }
      default:
        throw new Error(`Chen 不支持命令：${command}`);
    }
  }

  return {
    open,
    close,
    async closeAll(): Promise<void> {
      await Promise.all([...sessions.keys()].map((sessionId) => close(sessionId)));
    },
    invoke
  };
}
