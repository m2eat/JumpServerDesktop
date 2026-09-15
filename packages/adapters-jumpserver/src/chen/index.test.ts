import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ApplyResult, Preview, QueryResult, ResourceContext, TableChanges } from '../../../desktop-contract/src/index';
import type { AdapterHost, AuthorizedConnection, ChenService, SocketEvent, SocketLike } from '../host';
import { createChenService } from './index';

const packetSchema = z.object({ type: z.string(), data: z.unknown().optional() }).strict();
const actionSchema = z.object({ action: z.string(), data: z.unknown().optional() });
const nodeSchema = z.object({ key: z.string(), type: z.string(), label: z.string().optional(), hasChildren: z.boolean().optional() });
const treeKeySchema = z.object({ key: z.string().min(1) });
const context: ResourceContext = {
  siteId: 'site-1',
  userId: 'user-1',
  orgId: 'org-1',
  assetId: 'asset-1',
  assetName: 'MySQL 资产',
  address: 'mysql.example.test',
  accountId: 'account-1',
  accountName: 'db-user',
  protocol: 'mysql',
  connectMethod: { value: 'web_gui', component: 'chen', type: 'web' }
};

class ChenFixtureSocket implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();

  constructor(private readonly onPacket: (packet: z.infer<typeof packetSchema>) => void) {}

  send(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.onPacket(packetSchema.parse(JSON.parse(text) as unknown));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'fixture closed' });
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) || new Set<(event: SocketEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  receive(packet: unknown): void {
    // PacketIO uses Gson without serializeNulls(): null object/map entries are absent.
    this.emit('message', { data: JSON.stringify(packet, (_key, value) => value === null ? undefined : value) });
  }

  async receiveSequence(packets: unknown[]): Promise<void> {
    for (const packet of packets) {
      await setImmediate();
      if (this.readyState === 3) return;
      this.receive(packet);
    }
  }

  private emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const tableTitle = 'DataView: app.orderschild';
const querySql = 'SELECT amount FROM orders';

// Source: Chen v4.10.19 (86abab892e34b67327dc97331d99af7c9c08e45d),
// QueryConsole, DataViewConsole, UpdateDataView, State and DataViewState.
// These release payloads have no id, consoleId, executionStatus or truncated.
function tableState(page: number, limit: number, loading: boolean) {
  return { title: tableTitle, page, limit, total: 250, pinned: false, paged: true, loading };
}

function tableData(page: number) {
  return {
    title: tableTitle,
    data: {
      editable: false,
      fields: [{ name: 'id', type: 'BIGINT', isPrimaryKey: true }],
      data: [{ id: (9007199254740992n + BigInt(page)).toString() }]
    }
  };
}

function queryResultPackets(sql: string, created = true): unknown[] {
  return [
    { type: 'update_state', data: { title: 'Query-1', loading: false, inQuery: true, canCancel: true } },
    { type: 'close_data_view', data: [] },
    ...(created ? [{ type: 'new_data_view', data: { title: sql } }] : []),
    {
      type: 'update_data_view',
      data: {
        title: sql,
        data: {
          editable: false,
          fields: [{ name: 'amount', type: 'DECIMAL', isPrimaryKey: false }, { name: 'note', type: 'VARCHAR', isPrimaryKey: false }],
          data: [{ amount: '1234567890.123456789', note: null }]
        }
      }
    },
    { type: 'update_state', data: { title: sql, loading: false, page: 1, limit: 50, total: 1, pinned: false, paged: false } },
    { type: 'update_state', data: { title: 'Query-1', loading: false, inQuery: false, canCancel: false } }
  ];
}

interface FixtureOptions {
  requiresConfirmation?: boolean;
  denyViewAction?: boolean;
  queryAction?: (socket: ChenFixtureSocket, action: z.infer<typeof actionSchema>) => void;
  tableConnect?: (socket: ChenFixtureSocket) => void;
  tableData?: (page: number) => ReturnType<typeof tableData>;
}

function createHost(options: FixtureOptions = {}): AdapterHost {
  const denyViewAction = options.denyViewAction;
  return {
    async authorizeNative() { throw new Error('Chen must not request native SSH authorization'); },
    async authorize(): Promise<AuthorizedConnection> {
      let sessionActive = false;
      let closed = false;
      return {
        tokenId: 'core-authorization-token',
        async request(path, options) {
          if (closed) throw new Error('连接授权已关闭');
          if (path === '/chen/api/auth') return { token: 'chen-session-token', lang: 'zh-CN' };
          if (!sessionActive || options?.headers?.token !== 'chen-session-token') throw new Error('401 Unauthorized');
          if (path === '/chen/api/profile') return { dbType: 'mysql', canCopy: true, canPaste: true };
          if (path === '/chen/api/resources/actions/do') {
            if (denyViewAction) throw new Error('Invalid resource action');
            const action = z.object({ action: z.literal('view_data'), node: nodeSchema }).parse(options?.body);
            return { event: 'view_data', data: action.node.key };
          }
          if (path === '/chen/api/resources/children') {
            if (options?.body === undefined) return [{ key: 'datasource:root', type: 'datasource', label: 'mysql', meta: null, hasChildren: true, children: null }];
            const node = nodeSchema.parse(options.body);
            if (node.key === 'datasource:root') return [{ key: 'datasource:root,schema:app', type: 'schema', label: 'app', meta: null }];
            if (node.key === 'datasource:root,schema:app') return [{ key: 'datasource:root,schema:app,folder:tables', type: 'folder', label: 'tables', meta: {} }];
            if (node.key === 'datasource:root,schema:app,folder:tables') return [{ key: 'datasource:root,schema:app,folder:tables,table:orders', type: 'table', label: 'orders', meta: null, hasChildren: true }];
            return [];
          }
          throw new Error(`Unexpected request ${path}`);
        },
        socket(path) {
          if (closed) throw new Error('连接授权已关闭');
          let page = 1;
          let limit = 50;
          const results = new Set<string>();
          const socket = new ChenFixtureSocket((packet) => {
            if (path === '/chen/ws/console' && packet.type === 'connect') {
              const connect = z.object({ nodeKey: z.string(), type: z.enum(['query', 'data_view']) }).parse(packet.data);
              if (connect.type === 'query') {
                socket.receive({ type: 'init', data: { title: 'Query-1' } });
              } else {
                socket.receive({ type: 'init', data: { title: 'DataView: app.orders' } });
                socket.receive({ type: 'new_data_view', data: { title: 'DataView: app.orderschild', schema: 'app', table: 'orders' } });
                if (options.tableConnect) {
                  options.tableConnect(socket);
                } else {
                  // onConnect commits loading=false before data, then commits child state again.
                  socket.receive({ type: 'update_state', data: tableState(page, limit, true) });
                  socket.receive({ type: 'update_state', data: tableState(page, limit, false) });
                  socket.receive({ type: 'update_data_view', data: options.tableData?.(page) ?? tableData(page) });
                  socket.receive({ type: 'update_state', data: tableState(page, limit, false) });
                }
              }
            }
            if (path === '/chen/ws/console' && packet.type === 'query_console_action') {
              const action = actionSchema.parse(packet.data);
              if (options.queryAction) {
                options.queryAction(socket, action);
              } else if (action.action === 'run_sql') {
                const sql = z.string().parse(action.data);
                for (const result of queryResultPackets(sql, !results.has(sql))) socket.receive(result);
                results.add(sql);
              }
            }
            if (path === '/chen/ws/console' && packet.type === 'data_view_action') {
              const action = actionSchema.parse(packet.data);
              const loading = tableState(page, limit, true);
              if (action.action === 'next_page') page += 1;
              else if (action.action === 'first_page') page = 1;
              else if (action.action === 'change_limit') {
                limit = z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(500)]).parse(action.data);
                page = 1;
              } else if (action.action !== 'refresh') throw new Error(`Unexpected table action ${action.action}`);
              // onDataViewAction sends data, a still-loading state, then the terminal state.
              void socket.receiveSequence([
                { type: 'update_state', data: loading },
                { type: 'update_data_view', data: options.tableData?.(page) ?? tableData(page) },
                { type: 'update_state', data: tableState(page, limit, true) },
                { type: 'update_state', data: tableState(page, limit, false) }
              ]);
            }
          });
          queueMicrotask(() => {
            socket.open();
            if (path !== '/chen/ws/session') return;
            if (options.requiresConfirmation) {
              socket.receive({ type: 'show_dialog', data: { title: '命令告警', body: '需要确认', buttons: [{ event: 'submit' }] } });
              return;
            }
            sessionActive = true;
            socket.receive({ type: 'set_ready', data: null });
          });
          return socket;
        },
        close() {
          closed = true;
        }
      };
    },
    assertContext() {},
    emit() {},
    update() {}
  };
}

it('opens title-only release consoles, reuses query titles and preserves exact values and NULL', async () => {
  const failed = Promise.withResolvers<never>();
  const service = createChenService({
    ...createHost(),
    update(info) {
      if (info.phase === 'failed') failed.reject(new Error(info.error));
    }
  });
  const session = await Promise.race([service.open(context), failed.promise]);

  const query = await service.invoke('db.query', { sessionId: session.id, sql: querySql });
  expect(query).toMatchObject({
    columns: [{ name: 'amount', type: 'DECIMAL' }, { name: 'note', type: 'VARCHAR' }],
    rows: [['1234567890.123456789', null]],
    editable: false
  });
  const repeated = await service.invoke('db.query', { sessionId: session.id, sql: querySql });
  expect(repeated).toMatchObject({ rows: [['1234567890.123456789', null]] });

  const root = z.array(treeKeySchema).parse(await service.invoke('db.tree', { sessionId: session.id }));
  const datasource = root[0];
  if (!datasource) throw new Error('测试协议未返回 datasource 节点');
  const schemas = z.array(treeKeySchema).parse(await service.invoke('db.tree', { sessionId: session.id, key: datasource.key }));
  const schema = schemas[0];
  if (!schema) throw new Error('测试协议未返回 schema 节点');
  const folders = z.array(treeKeySchema).parse(await service.invoke('db.tree', { sessionId: session.id, key: schema.key }));
  const folder = folders[0];
  if (!folder) throw new Error('测试协议未返回 folder 节点');
  const tables = await service.invoke('db.tree', { sessionId: session.id, key: folder.key });
  expect(tables).toMatchObject([{ name: 'orders', leaf: true, schema: 'app', table: 'orders' }]);

  const table = await Promise.race([
    service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }),
    failed.promise
  ]);
  expect(table).toMatchObject({ rows: [['9007199254740993']], editable: false });
  expect(await service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 2, limit: 50 }))
    .toMatchObject({ rows: [['9007199254740994']] });
  expect(await service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 3, limit: 100 }))
    .toMatchObject({ rows: [['9007199254740995']] });
  expect(await service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 100 }))
    .toMatchObject({ rows: [['9007199254740993']] });
  await service.closeAll();
});

it('searches the full authorized table server-side with a verified paged snapshot', async () => {
  const text = "%_'); DELETE FROM orders; --";
  const executedSql: string[] = [];
  const metadataRows = [
    {
      table_type: 'BASE TABLE', engine: 'InnoDB', column_name: 'id', data_type: 'bigint', column_type: 'bigint',
      is_nullable: 'NO', column_default: null, extra: '', generation_expression: '', column_key: 'PRI',
      ordinal_position: '1', character_set_name: null, numeric_precision: '19', numeric_scale: '0', character_maximum_length: null
    },
    {
      table_type: 'BASE TABLE', engine: 'InnoDB', column_name: 'note', data_type: 'varchar', column_type: 'varchar(255)',
      is_nullable: 'YES', column_default: null, extra: '', generation_expression: '', column_key: '',
      ordinal_position: '2', character_set_name: 'utf8mb4', numeric_precision: null, numeric_scale: null, character_maximum_length: '255'
    }
  ];
  const service = createChenService(createHost({
    tableData() {
      return {
        title: tableTitle,
        data: {
          editable: false,
          fields: [{ name: 'id', type: 'BIGINT', isPrimaryKey: true }, { name: 'note', type: 'VARCHAR', isPrimaryKey: false }],
          data: [{ id: '9007199254740992', note: 'native page' }]
        }
      };
    },
    queryAction(socket, action) {
      const sql = z.string().parse(action.data);
      executedSql.push(sql);
      if (sql.includes('information_schema')) {
        emitCrudResult(socket, sql, metadataRows);
        return;
      }
      const marker = /SELECT '([0-9a-f-]+)' AS __jms_marker/.exec(sql)?.[1];
      if (marker) {
        emitCrudResult(socket, sql, [{ __jms_marker: marker, __jms_connection: '42', __jms_autocommit: '1' }]);
        return;
      }
      if (sql.startsWith('SELECT `id`, `note`\nFROM `app`.`orders`')) {
        const offset = /OFFSET (\d+)$/.exec(sql)?.[1];
        if (offset === '0') {
          emitCrudResult(socket, sql, [{ id: '9007199254740993', note: text }]);
          return;
        }
        if (offset === '50') {
          emitCrudResult(socket, sql, [{ id: '9007199254740994', note: text }]);
          return;
        }
      }
      throw new Error(`Unexpected search fixture command: ${sql}`);
    }
  }));
  const session = await service.open(context);
  try {
    await expect(service.invoke('db.table', {
      sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50, search: { text: 'x'.repeat(513) }
    })).rejects.toThrow();
    expect(executedSql).toEqual([]);

    await loadOrders(service, session.id);
    const first = await service.invoke('db.table', {
      sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50, search: { text, column: 'note' }
    }) as QueryResult;
    expect(first).toMatchObject({ rows: [['9007199254740993', text]], editable: true });
    const changes: TableChanges = {
      schema: 'app', table: 'orders', snapshotId: first.snapshotId!,
      updates: [{ row: { id: '9007199254740993', note: text }, values: { note: 'after' } }],
      inserts: [], deletes: []
    };
    expect((await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview).sql)
      .toHaveLength(1);

    const second = await service.invoke('db.table', {
      sessionId: session.id, schema: 'app', table: 'orders', page: 2, limit: 50, search: { text, column: 'note' }
    }) as QueryResult;
    expect(second).toMatchObject({ rows: [['9007199254740994', text]], editable: true });
    await expect(service.invoke('db.preview', { sessionId: session.id, changes })).rejects.toThrow('表格基线已失效');

    const searches = executedSql.filter((sql) => sql.startsWith('SELECT `id`, `note`\nFROM `app`.`orders`'));
    expect(searches).toHaveLength(2);
    expect(searches[0]).toContain('WHERE (LOCATE(BINARY');
    expect(searches[0]).toContain('`note`');
    expect(searches[0]).toMatch(/LIMIT 50 OFFSET 0$/);
    expect(searches[1]).toMatch(/LIMIT 50 OFFSET 50$/);
  } finally {
    await service.closeAll();
  }
});

it('does not query when Chen denies the required view_data action for a search', async () => {
  const executedSql: string[] = [];
  const service = createChenService(createHost({
    denyViewAction: true,
    queryAction(_socket, action) {
      executedSql.push(z.string().parse(action.data));
      throw new Error('view_data 拒绝后不得发送搜索 SQL');
    }
  }));
  const session = await service.open(context);
  try {
    await loadOrders(service, session.id);
    await expect(service.invoke('db.table', {
      sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50, search: { text: 'north' }
    })).rejects.toThrow('Invalid resource action');
    expect(executedSql).toEqual([]);
  } finally {
    await service.closeAll();
  }
});

it('fails closed when Chen asks for a confirmation channel the desktop bridge does not expose', async () => {
  const service = createChenService(createHost({ requiresConfirmation: true }));
  await expect(service.open(context)).rejects.toThrow('未自动确认');
});

it('rejects release SQL errors and ACL error logs without relying on executionStatus or sql_error', async () => {
  const service = createChenService(createHost({
    queryAction(socket, action) {
      const sql = z.string().parse(action.data);
      socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: true } });
      if (sql === 'SELECT missing') {
        socket.receive({ type: 'message', data: { type: 'error', title: 'Execute error', message: 'Unknown column missing' } });
      } else if (sql === 'DROP TABLE orders') {
        socket.receive({ type: 'log', data: { level: 0, message: 'Command rejected by ACL', timestamp: '1700000000000' } });
      } else if (sql === 'UPDATE orders SET amount = 1') {
        socket.receive({ type: 'log', data: { level: 3, message: '1 rows affected', timestamp: '1700000000000' } });
      } else {
        for (const packet of queryResultPackets(sql)) socket.receive(packet);
      }
      socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: false, canCancel: false } });
    }
  }));
  const session = await service.open(context);
  try {
    await expect(service.invoke('db.query', { sessionId: session.id, sql: 'SELECT missing' })).rejects.toThrow('Unknown column missing');
    await expect(service.invoke('db.query', { sessionId: session.id, sql: 'DROP TABLE orders' })).rejects.toThrow('Command rejected by ACL');
    expect(await service.invoke('db.query', { sessionId: session.id, sql: 'UPDATE orders SET amount = 1' }))
      .toMatchObject({ rows: [], columns: [], message: '1 rows affected' });
    expect(await service.invoke('db.query', { sessionId: session.id, sql: querySql }))
      .toMatchObject({ rows: [['1234567890.123456789', null]] });
  } finally {
    await service.closeAll();
  }
});

async function loadOrders(service: ChenService, sessionId: string): Promise<void> {
  for (const key of ['datasource:root', 'datasource:root,schema:app', 'datasource:root,schema:app,folder:tables']) {
    await service.invoke('db.tree', { sessionId, key });
  }
}

it('does not turn an initial table error into successful empty data', async () => {
  const service = createChenService(createHost({
    tableConnect(socket) {
      socket.receive({ type: 'update_state', data: tableState(1, 50, true) });
      socket.receive({ type: 'message', data: { type: 'error', title: 'Fetch error', message: 'SELECT permission denied' } });
      socket.receive({ type: 'update_state', data: tableState(1, 50, false) });
      socket.receive({ type: 'update_data_view', data: { title: tableTitle, data: { fields: [], data: [] } } });
      socket.receive({ type: 'update_state', data: tableState(1, 50, false) });
    }
  }));
  const session = await service.open(context);
  try {
    await loadOrders(service, session.id);
    await expect(service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }))
      .rejects.toThrow('SELECT permission denied');
  } finally {
    await service.closeAll();
  }
});

it('ignores informational messages and other view titles while loading a table', async () => {
  const service = createChenService(createHost({
    tableConnect(socket) {
      socket.receive({ type: 'message', data: { type: 'info', title: 'Notice', message: 'Read only' } });
      socket.receive({ type: 'update_data_view', data: { ...tableData(7), title: 'another view' } });
      socket.receive({ type: 'update_state', data: { ...tableState(7, 50, false), title: 'another view' } });
      socket.receive({ type: 'update_data_view', data: tableData(1) });
      socket.receive({ type: 'update_state', data: tableState(1, 50, false) });
    }
  }));
  const session = await service.open(context);
  try {
    await loadOrders(service, session.id);
    expect(await service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }))
      .toMatchObject({ rows: [['9007199254740993']] });
  } finally {
    await service.closeAll();
  }
});

it('rejects a table closed by a release close packet before the first result', async () => {
  const service = createChenService(createHost({
    tableConnect(socket) {
      socket.receive({ type: 'close', data: null });
    }
  }));
  const session = await service.open(context);
  try {
    await loadOrders(service, session.id);
    await expect(service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }))
      .rejects.toThrow('关闭');
  } finally {
    await service.closeAll();
  }
});

it('honors the server resource action rejection before browsing a table', async () => {
  const service = createChenService(createHost({ denyViewAction: true }));
  const session = await service.open(context);
  try {
    await loadOrders(service, session.id);
    await expect(service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }))
      .rejects.toThrow('Invalid resource action');
  } finally {
    await service.closeAll();
  }
});

it('still rejects incomplete table data instead of accepting a partial result', async () => {
  const service = createChenService(createHost({
    tableConnect(socket) {
      socket.receive({ type: 'update_data_view', data: { title: tableTitle, data: { data: [] } } });
    }
  }));
  const session = await service.open(context);
  try {
    await loadOrders(service, session.id);
    await expect(service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }))
      .rejects.toThrow('协议错误');
  } finally {
    await service.closeAll();
  }
});

async function settles<T>(operation: Promise<T>): Promise<T> {
  // Query fixtures synchronously deliver their terminal packet; drain the promise
  // microtasks before asserting that the consumer received a terminal outcome.
  return Promise.race([operation, setImmediate().then(() => {
    throw new Error('Chen operation remained pending after its terminal packet');
  })]);
}

it('decodes omitted Gson NULL cells without blocking the query session', async () => {
  const service = createChenService(createHost({
    queryAction(socket, action) {
      const sql = z.string().parse(action.data);
      emitCrudResult(socket, sql, [{ column_default: null, empty: '', present: '42' }]);
    }
  }));
  const session = await service.open(context);
  try {
    expect(await settles(service.invoke('db.query', { sessionId: session.id, sql: 'SELECT nullable_metadata' })))
      .toMatchObject({ rows: [[null, '', '42']] });
    expect(await settles(service.invoke('db.query', { sessionId: session.id, sql: 'SELECT again' })))
      .toMatchObject({ rows: [[null, '', '42']] });
  } finally { await service.closeAll(); }
});

it('settles a result conversion error and permits another query on the same session', async () => {
  const service = createChenService(createHost({
    queryAction(socket, action) {
      const sql = z.string().parse(action.data);
      if (sql === 'SELECT invalid_value') {
        socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: true } });
        socket.receive({ type: 'update_data_view', data: {
          title: sql, data: { fields: [{ name: 'value', type: 'VARCHAR' }], data: [{ value: { unexpected: true } }] }
        } });
        socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: false } });
      } else {
        for (const packet of queryResultPackets(sql)) socket.receive(packet);
      }
    }
  }));
  const session = await service.open(context);
  try {
    await expect(settles(service.invoke('db.query', { sessionId: session.id, sql: 'SELECT invalid_value' })))
      .rejects.toThrow('无法安全表示');
    expect(await settles(service.invoke('db.query', { sessionId: session.id, sql: querySql })))
      .toMatchObject({ rows: [['1234567890.123456789', null]] });
  } finally { await service.closeAll(); }
});

it('closes a late Chen authorization without issuing traffic after closeAll', async () => {
  let resolveAuthorization!: (connection: AuthorizedConnection) => void;
  const authorization = new Promise<AuthorizedConnection>((resolve) => {
    resolveAuthorization = resolve;
  });
  let requestCount = 0;
  let socketCount = 0;
  let closeCount = 0;
  const connection: AuthorizedConnection = {
    tokenId: 'late-token',
    async request() {
      requestCount += 1;
      return {};
    },
    socket() {
      socketCount += 1;
      throw new Error('关闭后不得创建 Chen WebSocket');
    },
    close() {
      closeCount += 1;
    }
  };
  const service = createChenService({ ...createHost(), authorize: () => authorization });
  const opening = service.open(context);
  await Promise.resolve();
  await service.closeAll();
  resolveAuthorization(connection);
  await expect(opening).rejects.toThrow('数据库会话已关闭');
  expect(requestCount).toBe(0);
  expect(socketCount).toBe(0);
  expect(closeCount).toBe(1);
});

function emitCrudResult(socket: ChenFixtureSocket, sql: string, rows: Array<Record<string, unknown>>): void {
  const fields = Object.keys(rows[0] ?? {}).map(name => ({ name, type: 'VARCHAR' }));
  socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: true } });
  socket.receive({ type: 'new_data_view', data: { title: sql } });
  socket.receive({ type: 'update_data_view', data: { title: sql, data: { fields, data: rows } } });
  socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: false } });
}

async function openCrudFixture(fault?: 'conflict' | 'second-error' | 'lost-commit' | 'invalid-metadata-once') {
  const state = { attempts: 0, commits: 0, rollbacks: 0, changedSchema: false, autocommit: '1', metadataReads: 0 };
  const service = createChenService(createHost({
    tableData(page) {
      return {
        title: tableTitle,
        data: {
          editable: false,
          fields: [
            { name: 'id', type: 'BIGINT', isPrimaryKey: true },
            { name: 'note', type: 'VARCHAR', isPrimaryKey: false }
          ],
          data: [{ id: (9007199254740992n + BigInt(page)).toString(), note: 'before' }]
        }
      };
    },
    queryAction(socket, action) {
      const sql = z.string().parse(action.data);
      // onSQL and onAction both publish a terminal state in the release. The
      // second state can arrive after the client has queued its next command.
      socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: false } });
      if (sql.includes('information_schema')) {
        state.metadataReads += 1;
        const base = {
          table_type: 'BASE TABLE', engine: 'InnoDB', is_nullable: 'NO',
          column_default: fault === 'invalid-metadata-once' && state.metadataReads === 1 ? { unsupported: true } : null,
          extra: '', generation_expression: '', character_set_name: null, numeric_precision: '19',
          numeric_scale: '0', character_maximum_length: null
        };
        emitCrudResult(socket, sql, [
          { ...base, column_name: 'id', data_type: 'bigint', column_type: 'bigint', column_key: 'PRI', ordinal_position: '1' },
          { ...base, column_name: 'note', data_type: 'varchar', column_type: state.changedSchema ? 'varchar(100)' : 'varchar(255)',
            column_key: '', ordinal_position: '2', is_nullable: 'YES', character_set_name: 'utf8mb4',
            character_maximum_length: state.changedSchema ? '100' : '255', numeric_precision: null, numeric_scale: null }
        ]);
        return;
      }
      const marker = /SELECT '([0-9a-f-]+)' AS __jms_marker/.exec(sql)?.[1];
      if (marker) {
        emitCrudResult(socket, sql, [{ __jms_marker: marker, __jms_connection: '42', __jms_autocommit: state.autocommit }]);
        return;
      }
      socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: true } });
      let affected = 0;
      if (/^(UPDATE|INSERT|DELETE) /.test(sql)) {
        state.attempts += 1;
        if (fault === 'second-error' && state.attempts === 2) {
          socket.receive({ type: 'message', data: { type: 'error', message: 'Duplicate entry rejected' } });
        } else {
          affected = fault === 'conflict' ? 0 : 1;
        }
      } else if (sql === 'COMMIT') {
        state.commits += 1;
        if (fault === 'lost-commit') { socket.close(); return; }
      } else if (sql === 'ROLLBACK') {
        state.rollbacks += 1;
      } else if (sql === 'SET SESSION autocommit = 0') {
        state.autocommit = '0';
      } else if (sql === 'SET SESSION autocommit = 1') {
        state.autocommit = '1';
      } else {
        throw new Error(`Unexpected CRUD fixture command: ${sql}`);
      }
      socket.receive({ type: 'log', data: { level: 3, message: `${affected} rows affected in 1 ms` } });
      socket.receive({ type: 'update_state', data: { title: 'Query-1', inQuery: false } });
    }
  }));
  const session = await service.open(context);
  await loadOrders(service, session.id);
  const table = await service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }) as QueryResult;
  const changes: TableChanges = {
    schema: 'app', table: 'orders', snapshotId: table.snapshotId!,
    updates: [{ row: { id: '9007199254740993', note: 'before' }, values: { note: 'after' } }],
    inserts: [], deletes: []
  };
  return { service, session, table, changes, state };
}

it('commits a consumed preview once and rejects attempts to replay it', async () => {
  const { service, session, changes, state } = await openCrudFixture();
  try {
    const preview = await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview;
    preview.sql[0] = 'DELETE FROM unrelated';
    const result = await service.invoke('db.apply', { sessionId: session.id, previewId: preview.id }) as ApplyResult;
    expect(result).toMatchObject({ outcome: 'committed', applied: 1, total: 1 });
    await expect(service.invoke('db.apply', { sessionId: session.id, previewId: preview.id })).rejects.toThrow();
    expect(state).toMatchObject({ attempts: 1, commits: 1, rollbacks: 0 });
  } finally { await service.closeAll(); }
});

it('rolls back an original-value mismatch without committing or continuing', async () => {
  const { service, session, changes, state } = await openCrudFixture('conflict');
  try {
    changes.inserts.push({ id: '2', note: 'must not run' });
    const preview = await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview;
    expect(await service.invoke('db.apply', { sessionId: session.id, previewId: preview.id }))
      .toMatchObject({ outcome: 'not-started', failure: 'conflict', applied: 0, total: 2, failedIndex: 0 });
    expect(state).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
  } finally { await service.closeAll(); }
});

it('reports prior committed rows separately when a later row fails and rolls back', async () => {
  const { service, session, changes, state } = await openCrudFixture('second-error');
  try {
    changes.inserts.push({ id: '2', note: 'duplicate' }, { id: '3', note: 'must not run' });
    const preview = await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview;
    expect(await service.invoke('db.apply', { sessionId: session.id, previewId: preview.id }))
      .toMatchObject({ outcome: 'partial', failure: 'rejected', applied: 1, total: 3, failedIndex: 1 });
    expect(state).toMatchObject({ attempts: 2, commits: 1, rollbacks: 1 });
  } finally { await service.closeAll(); }
});

it('freezes a lost commit acknowledgement rather than replaying the committed statement', async () => {
  const { service, session, changes, state } = await openCrudFixture('lost-commit');
  try {
    const preview = await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview;
    expect(await service.invoke('db.apply', { sessionId: session.id, previewId: preview.id }))
      .toMatchObject({ outcome: 'unknown', applied: 0, total: 1, failedIndex: 0 });
    await expect(service.invoke('db.apply', { sessionId: session.id, previewId: preview.id })).rejects.toThrow();
    expect(state).toMatchObject({ attempts: 1, commits: 1 });
  } finally { await service.closeAll(); }
});

it('invalidates a preview when metadata changes and never sends its DML', async () => {
  const { service, session, changes, state } = await openCrudFixture();
  try {
    const preview = await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview;
    state.changedSchema = true;
    expect(await service.invoke('db.apply', { sessionId: session.id, previewId: preview.id }))
      .toMatchObject({ outcome: 'not-started', applied: 0, failure: 'rejected' });
    expect(state.attempts).toBe(0);
  } finally { await service.closeAll(); }
});

it('expires a confirmed preview before any write can start', async () => {
  const { service, session, changes, state } = await openCrudFixture();
  try {
    const preview = await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt);
    try {
      await expect(service.invoke('db.apply', { sessionId: session.id, previewId: preview.id })).rejects.toThrow();
      expect(state.attempts).toBe(0);
    } finally { clock.mockRestore(); }
  } finally { await service.closeAll(); }
});

it('keeps table browsing usable after a metadata conversion error and releases its operation lock', async () => {
  const { service, session, table } = await openCrudFixture('invalid-metadata-once');
  try {
    expect(table).toMatchObject({ rows: [['9007199254740993', 'before']], editable: false });
    const recovered = await service.invoke('db.table', { sessionId: session.id, schema: 'app', table: 'orders', page: 1, limit: 50 }) as QueryResult;
    expect(recovered).toMatchObject({ rows: [['9007199254740993', 'before']], editable: true });
    const changes: TableChanges = {
      schema: 'app', table: 'orders', snapshotId: recovered.snapshotId!,
      updates: [{ row: { id: '9007199254740993', note: 'before' }, values: { note: 'after' } }],
      inserts: [], deletes: []
    };
    const preview = await service.invoke('db.preview', { sessionId: session.id, changes }) as Preview;
    expect(await service.invoke('db.apply', { sessionId: session.id, previewId: preview.id }))
      .toMatchObject({ outcome: 'committed', applied: 1 });
  } finally { await service.closeAll(); }
});
