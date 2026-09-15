import { Buffer } from 'node:buffer';

import { expect, it } from 'vitest';

import type { DbCell, DbWriteValue, QueryResult } from '../../../desktop-contract/src/index';
import { mysqlValueSpec, validateMysqlValue } from '../../../desktop-contract/src/mysql-values';
import { createSqlTableSnapshot, tableMetadataSql, tableSearchSql } from './sql-crud';
import type { SqlTableSnapshot } from './sql-crud';

const metadataAliases = [
  'table_type',
  'engine',
  'column_name',
  'data_type',
  'column_type',
  'is_nullable',
  'column_default',
  'extra',
  'generation_expression',
  'column_key',
  'ordinal_position',
  'character_set_name',
  'numeric_precision',
  'numeric_scale',
  'character_maximum_length'
];

interface MetadataColumn {
  name: string;
  dataType: string;
  columnType: string;
  nullable: 'YES' | 'NO';
  defaultValue?: string | null;
  extra?: string;
  generationExpression?: string;
  key?: string;
  ordinal: number;
  characterSet?: string | null;
  numericPrecision?: string | null;
  numericScale?: string | null;
  maximumLength?: string | null;
}

function result(columns: string[], rows: DbCell[][]): QueryResult {
  return {
    columns: columns.map((name) => ({ name, type: 'unknown' })),
    rows,
    message: 'fixture',
    elapsedMs: 1,
    truncated: false,
    editable: false
  };
}

function metadataResult(columns: MetadataColumn[]): QueryResult {
  return result(metadataAliases, columns.map((column) => [
    'BASE TABLE',
    'InnoDB',
    column.name,
    column.dataType,
    column.columnType,
    column.nullable,
    column.defaultValue === undefined ? null : column.defaultValue,
    column.extra || '',
    column.generationExpression || '',
    column.key || '',
    String(column.ordinal),
    column.characterSet === undefined ? 'utf8mb4' : column.characterSet,
    column.numericPrecision === undefined ? null : column.numericPrecision,
    column.numericScale === undefined ? null : column.numericScale,
    column.maximumLength === undefined ? null : column.maximumLength
  ]));
}

function verifiedSnapshot(note = 'before') {
  const metadata = metadataResult([
    {
      name: 'id',
      dataType: 'bigint',
      columnType: 'bigint unsigned',
      nullable: 'NO',
      extra: 'auto_increment',
      key: 'PRI',
      ordinal: 1,
      numericPrecision: '20',
      numericScale: '0'
    },
    {
      name: 'tenant',
      dataType: 'varchar',
      columnType: 'varchar(40)',
      nullable: 'NO',
      key: 'PRI',
      ordinal: 2,
      maximumLength: '40'
    },
    {
      name: 'note',
      dataType: 'varchar',
      columnType: 'varchar(255)',
      nullable: 'YES',
      ordinal: 3,
      maximumLength: '255'
    },
    {
      name: 'state',
      dataType: 'varchar',
      columnType: 'varchar(16)',
      nullable: 'NO',
      defaultValue: 'new',
      ordinal: 4,
      maximumLength: '16'
    }
  ]);
  const table = result(['id', 'tenant', 'note', 'state'], [['18446744073709551615', 'north', note, 'new']]);
  return createSqlTableSnapshot('app', 'orders', metadata, table);
}

function snapshotId(snapshot: SqlTableSnapshot): string {
  const id = snapshot.result.snapshotId;
  if (!id) throw new Error('fixture snapshot id missing');
  return id;
}

function emptySnapshot(table: string, columns: MetadataColumn[]): SqlTableSnapshot {
  return createSqlTableSnapshot('app', table, metadataResult(columns), result(columns.map((column) => column.name), []));
}

function compileInsert(snapshot: SqlTableSnapshot, table: string, values: Record<string, DbWriteValue>): string {
  const sql = snapshot.compile({
    schema: 'app',
    table,
    snapshotId: snapshotId(snapshot),
    updates: [],
    inserts: [values],
    deletes: []
  });
  if (sql.length !== 1) throw new Error('fixture should compile one INSERT');
  return sql[0] || '';
}

it('anchors composite primary-key mutations to every exact original field', () => {
  const snapshot = verifiedSnapshot();
  const sql = snapshot.compile({
    schema: 'app',
    table: 'orders',
    snapshotId: snapshotId(snapshot),
    updates: [{
      row: { id: '18446744073709551615', tenant: 'north', note: 'before', state: 'new' },
      values: { note: 'after' }
    }],
    inserts: [],
    deletes: []
  });

  expect(sql).toHaveLength(1);
  expect(sql[0]).toContain("`id` <=> CAST(CONVERT(X'3138343436373434303733373039353531363135' USING utf8mb4) AS UNSIGNED)");
  expect(sql[0]).toContain("BINARY CONVERT(`tenant` USING utf8mb4) <=> BINARY CONVERT(X'6e6f727468' USING utf8mb4)");
  expect(sql[0]).toContain("BINARY CONVERT(`note` USING utf8mb4) <=> BINARY CONVERT(X'6265666f7265' USING utf8mb4)");
  expect(sql[0]).toContain("BINARY CONVERT(`state` USING utf8mb4) <=> BINARY CONVERT(X'6e6577' USING utf8mb4)");
  expect(sql[0]).toMatch(/ LIMIT 1$/);
});

it('hex-encodes metadata and text rather than interpolating injected or lossy strings', () => {
  const schema = "app' OR 1=1 --";
  const table = 'orders`archive';
  const metadataSql = tableMetadataSql(schema, table);
  expect(metadataSql).toContain(`X'${Buffer.from(schema, 'utf8').toString('hex')}'`);
  expect(metadataSql).not.toContain(schema);
  expect(metadataSql).toContain('LIMIT 1025');

  const injected = "x'); DELETE FROM orders; --";
  const snapshot = verifiedSnapshot(injected);
  const sql = snapshot.compile({
    schema: 'app',
    table: 'orders',
    snapshotId: snapshotId(snapshot),
    updates: [{
      row: { id: '18446744073709551615', tenant: 'north', note: injected, state: 'new' },
      values: { note: 'safe' }
    }],
    inserts: [],
    deletes: []
  });
  expect(sql[0]).toContain(`X'${Buffer.from(injected, 'utf8').toString('hex')}'`);
  expect(sql[0]).not.toContain(injected);
  expect(() => snapshot.compile({
    schema: 'app',
    table: 'orders',
    snapshotId: snapshotId(snapshot),
    updates: [{
      row: { id: '18446744073709551615', tenant: 'north', note: injected, state: 'new' },
      values: { note: '\ud800' }
    }],
    inserts: [],
    deletes: []
  })).toThrow('UTF-16');
});

it('builds literal, column-validated, paged searches from table metadata', () => {
  const metadata = metadataResult([
    {
      name: 'id',
      dataType: 'bigint',
      columnType: 'bigint',
      nullable: 'NO',
      key: 'PRI',
      ordinal: 1,
      numericPrecision: '19',
      numericScale: '0'
    },
    {
      name: 'note',
      dataType: 'varchar',
      columnType: 'varchar(255)',
      nullable: 'YES',
      ordinal: 2,
      maximumLength: '255'
    }
  ]);
  const text = "%_'); DELETE FROM orders; --";
  const sql = tableSearchSql('app', 'orders', metadata, { text }, 2, 100);

  expect(sql).toContain(`X'${Buffer.from(text, 'utf8').toString('hex')}'`);
  expect(sql).not.toContain(text);
  expect(sql).not.toContain('LIKE');
  expect(sql).toContain('LOCATE(BINARY');
  expect(sql).toContain('ORDER BY `id` ASC');
  expect(sql).toMatch(/LIMIT 100 OFFSET 100$/);
  const columnSql = tableSearchSql('app', 'orders', metadata, { text: 'north', column: 'note' }, 1, 50);
  expect(columnSql).toContain('BINARY CONVERT(`note` USING utf8mb4)');
  expect(columnSql).not.toContain(' OR LOCATE');
  expect(() => tableSearchSql('app', 'orders', metadata, { text: 'north', column: 'missing' }, 1, 50))
    .toThrow('不属于当前表');
});

it('omits automatic columns and emits an explicit validated DEFAULT', () => {
  const snapshot = verifiedSnapshot();
  const sql = snapshot.compile({
    schema: 'app',
    table: 'orders',
    snapshotId: snapshotId(snapshot),
    updates: [],
    inserts: [{ tenant: 'south', state: { kind: 'default' } }],
    deletes: []
  });

  expect(sql).toEqual([
    "INSERT INTO `app`.`orders` (`tenant`, `state`) VALUES (CONVERT(X'736f757468' USING utf8mb4), DEFAULT)"
  ]);
});

it('rejects forged original rows and overlapping update-delete targets', () => {
  const snapshot = verifiedSnapshot();
  const original = { id: '18446744073709551615', tenant: 'north', note: 'before', state: 'new' };
  const id = snapshotId(snapshot);

  expect(() => snapshot.compile({
    schema: 'app',
    table: 'orders',
    snapshotId: id,
    updates: [{ row: { ...original, note: 'forged' }, values: { note: 'after' } }],
    inserts: [],
    deletes: []
  })).toThrow('不属于当前不可变快照');

  expect(() => snapshot.compile({
    schema: 'app',
    table: 'orders',
    snapshotId: id,
    updates: [{ row: original, values: { note: 'after' } }],
    inserts: [],
    deletes: [original]
  })).toThrow('同一主键');
});

it('preserves zero-integer-digit decimals and separates empty text from NULL', () => {
  const snapshot = createSqlTableSnapshot('app', 'fractions', metadataResult([
    { name: 'fraction', dataType: 'decimal', columnType: 'decimal(3,3)', nullable: 'NO', ordinal: 1, numericPrecision: '3', numericScale: '3' },
    { name: 'note', dataType: 'text', columnType: 'text', nullable: 'YES', ordinal: 2 }
  ]), result(['fraction', 'note'], []));
  const changes = { schema: 'app', table: 'fractions', snapshotId: snapshotId(snapshot), updates: [], deletes: [],
    inserts: [{ fraction: '0.123', note: '' }, { fraction: '0.000', note: null }] };
  const sql = snapshot.compile(changes);
  expect(sql[0]).toContain("CAST(CONVERT(X'302e313233' USING utf8mb4) AS DECIMAL(3,3))");
  expect(sql[0]).toContain("CONVERT('' USING utf8mb4)");
  expect(sql[1]).toContain(', NULL)');
  expect(() => snapshot.compile({ ...changes, inserts: [{ fraction: '1.000', note: '' }] })).toThrow();
});

it('rejects fractional timestamps MySQL would silently round', () => {
  const snapshot = createSqlTableSnapshot('app', 'times', metadataResult([
    { name: 'moment', dataType: 'datetime', columnType: 'datetime(3)', nullable: 'NO', ordinal: 1 }
  ]), result(['moment'], []));
  const changes = { schema: 'app', table: 'times', snapshotId: snapshotId(snapshot), updates: [], deletes: [],
    inserts: [{ moment: '2026-09-14 12:34:56.123456' }] };
  expect(() => snapshot.compile(changes)).toThrow('时间精度');
  expect(snapshot.compile({ ...changes, inserts: [{ moment: '2026-09-14 12:34:56.123000' }] })[0])
    .toContain(Buffer.from('2026-09-14 12:34:56.123000').toString('hex'));
});

it('keeps UINT64 exact while tinyint(1) remains an eight-bit signed integer', () => {
  const snapshot = emptySnapshot('integer_limits', [
    { name: 'id', dataType: 'bigint', columnType: 'bigint unsigned', nullable: 'NO', ordinal: 1 },
    { name: 'rating', dataType: 'tinyint', columnType: 'tinyint(1)', nullable: 'NO', ordinal: 2 }
  ]);

  expect(compileInsert(snapshot, 'integer_limits', { id: '18446744073709551615', rating: '-128' }))
    .toContain("CAST(CONVERT(X'3138343436373434303733373039353531363135' USING utf8mb4) AS UNSIGNED)");
  expect(compileInsert(snapshot, 'integer_limits', { id: '1', rating: '2' }))
    .toContain("CAST(CONVERT(X'32' USING utf8mb4) AS SIGNED)");
  expect(() => compileInsert(snapshot, 'integer_limits', { id: '18446744073709551616', rating: '0' })).toThrow('整数范围');
  expect(() => compileInsert(snapshot, 'integer_limits', { id: '1', rating: '128' })).toThrow('整数范围');
});

it('enforces unsigned DECIMAL precision without coercing its text input', () => {
  const snapshot = emptySnapshot('prices', [
    { name: 'amount', dataType: 'decimal', columnType: 'decimal(5,2) unsigned', nullable: 'NO', ordinal: 1 }
  ]);

  expect(compileInsert(snapshot, 'prices', { amount: '999.99' }))
    .toContain("CAST(CONVERT(X'3939392e3939' USING utf8mb4) AS DECIMAL(5,2))");
  expect(() => compileInsert(snapshot, 'prices', { amount: '-0.01' })).toThrow('无符号 DECIMAL');
  expect(() => compileInsert(snapshot, 'prices', { amount: '1000.00' })).toThrow('DECIMAL(5,2)');
  expect(() => compileInsert(snapshot, 'prices', { amount: '1e2' })).toThrow('不含指数');
});

it('accepts calendar-valid six-digit timestamps and signed MySQL TIME durations only', () => {
  const snapshot = emptySnapshot('temporal_values', [
    { name: 'day', dataType: 'date', columnType: 'date', nullable: 'NO', ordinal: 1 },
    { name: 'moment', dataType: 'datetime', columnType: 'datetime(6)', nullable: 'NO', ordinal: 2 },
    { name: 'span', dataType: 'time', columnType: 'time(6)', nullable: 'NO', ordinal: 3 }
  ]);
  const valid = { day: '2024-02-29', moment: '2024-02-29 23:59:59.123456', span: '-838:59:58.123456' };

  expect(compileInsert(snapshot, 'temporal_values', valid))
    .toContain(Buffer.from(valid.moment).toString('hex'));
  expect(() => compileInsert(snapshot, 'temporal_values', { ...valid, day: '2025-02-29' })).toThrow('YYYY-MM-DD');
  expect(() => compileInsert(snapshot, 'temporal_values', { ...valid, moment: '2024-02-29 23:59:59.1234567' })).toThrow('时间精度');
  expect(() => compileInsert(snapshot, 'temporal_values', { ...valid, span: '-839:00:00' })).toThrow('TIME');
  expect(() => compileInsert(snapshot, 'temporal_values', { ...valid, span: '-838:59:59.000001' })).toThrow();
  expect(compileInsert(snapshot, 'temporal_values', { ...valid, span: '838:59:59.000000' }))
    .toContain(Buffer.from('838:59:59.000000').toString('hex'));
});

it('parses escaped ENUM and SET members before enforcing membership', () => {
  const enumSpec = mysqlValueSpec("enum('plain','a,b','O''Brien','slash\\\\path','')");
  const setSpec = mysqlValueSpec("set('a','c','quote''d')");

  expect(enumSpec).toEqual({ kind: 'enum', values: ['plain', 'a,b', "O'Brien", 'slash\\path', ''] });
  expect(validateMysqlValue(enumSpec, "O'Brien")).toBeNull();
  expect(validateMysqlValue(enumSpec, '')).toBeNull();
  expect(validateMysqlValue(enumSpec, 'missing')).not.toBeNull();
  expect(validateMysqlValue(setSpec, "a,quote'd")).toBeNull();
  expect(validateMysqlValue(setSpec, 'a,missing')).not.toBeNull();
  expect(validateMysqlValue(setSpec, 'a,a')).not.toBeNull();
  expect(validateMysqlValue(mysqlValueSpec("set('a,b','c')"), 'a,b')).not.toBeNull();
  const ambiguous = emptySnapshot('empty_set', [
    { name: 'labels', dataType: 'set', columnType: "set('','a')", nullable: 'NO', ordinal: 1 }
  ]);
  expect(() => compileInsert(ambiguous, 'empty_set', { labels: '' })).toThrow();
});

it('counts VARCHAR code points and keeps large JSON numeric text unchanged in generated SQL', () => {
  const snapshot = emptySnapshot('unicode_json', [
    { name: 'name', dataType: 'varchar', columnType: 'varchar(2)', nullable: 'NO', ordinal: 1 },
    { name: 'document', dataType: 'json', columnType: 'json', nullable: 'NO', ordinal: 2 }
  ]);
  const document = '{"n":123456789012345678901234567890}';

  expect(compileInsert(snapshot, 'unicode_json', { name: '😀a', document }))
    .toContain(Buffer.from(document).toString('hex'));
  expect(() => compileInsert(snapshot, 'unicode_json', { name: '😀ab', document })).toThrow('2 个字符');
});

it('keeps legacy ENUM snapshot values usable while rejecting that value as a new write', () => {
  const snapshot = createSqlTableSnapshot('app', 'legacy_enum', metadataResult([
    { name: 'id', dataType: 'int', columnType: 'int', nullable: 'NO', key: 'PRI', ordinal: 1 },
    { name: 'state', dataType: 'enum', columnType: "enum('ready')", nullable: 'NO', ordinal: 2 },
    { name: 'note', dataType: 'varchar', columnType: 'varchar(20)', nullable: 'NO', ordinal: 3 }
  ]), result(['id', 'state', 'note'], [['1', '', 'before']]));
  const id = snapshotId(snapshot);

  expect(snapshot.compile({
    schema: 'app',
    table: 'legacy_enum',
    snapshotId: id,
    updates: [{ row: { id: '1', state: '', note: 'before' }, values: { note: 'after' } }],
    inserts: [],
    deletes: []
  })[0]).toContain("BINARY CONVERT(`state` USING utf8mb4) <=> BINARY CONVERT('' USING utf8mb4)");
  expect(() => compileInsert(snapshot, 'legacy_enum', { id: '2', state: '', note: 'new' })).toThrow('ENUM');
});

it('distinguishes required insert omissions, NULL, DEFAULT, and automatic columns', () => {
  const snapshot = emptySnapshot('write_modes', [
    { name: 'required', dataType: 'varchar', columnType: 'varchar(10)', nullable: 'NO', ordinal: 1 },
    { name: 'nullable', dataType: 'varchar', columnType: 'varchar(10)', nullable: 'YES', ordinal: 2 },
    { name: 'with_default', dataType: 'varchar', columnType: 'varchar(10)', nullable: 'NO', defaultValue: 'x', ordinal: 3 },
    { name: 'generated_id', dataType: 'int', columnType: 'int', nullable: 'NO', extra: 'auto_increment', ordinal: 4 }
  ]);

  expect(compileInsert(snapshot, 'write_modes', { required: 'ok' }))
    .toContain("INSERT INTO `app`.`write_modes` (`required`) VALUES (CONVERT(X'6f6b' USING utf8mb4))");
  expect(() => compileInsert(snapshot, 'write_modes', {})).toThrow('新增缺少必填字段');
  expect(() => compileInsert(snapshot, 'write_modes', { required: null })).toThrow('不允许 NULL');
  expect(() => compileInsert(snapshot, 'write_modes', { required: { kind: 'default' } })).toThrow('不支持 DEFAULT');
  expect(() => compileInsert(snapshot, 'write_modes', { required: 'ok', generated_id: '1' })).toThrow('不能在新增时指定');
});

it('rejects unencodable JSON strings and numeric storage overflows before preview', () => {
  const snapshot = emptySnapshot('edge_values', [
    { name: 'fraction', dataType: 'decimal', columnType: 'decimal(3,3)', nullable: 'NO', ordinal: 1 },
    { name: 'document', dataType: 'json', columnType: 'json', nullable: 'NO', ordinal: 2 },
    { name: 'rating', dataType: 'float', columnType: 'float', nullable: 'NO', ordinal: 3 },
    { name: 'year', dataType: 'year', columnType: 'year', nullable: 'NO', ordinal: 4 }
  ]);
  const valid = { fraction: '0.123', document: '{"ok":true}', rating: '1.25', year: '0000' };
  expect(compileInsert(snapshot, 'edge_values', valid)).toContain("CAST(CONVERT(X'312e3235' USING utf8mb4) AS FLOAT)");
  for (const values of [
    { ...valid, fraction: true },
    { ...valid, document: '"\\ud800"' },
    { ...valid, rating: '1e39' },
    { ...valid, rating: '1e-99' },
    { ...valid, year: '2156' }
  ]) expect(() => compileInsert(snapshot, 'edge_values', values)).toThrow();
  expect(validateMysqlValue(mysqlValueSpec('varchar(4)'), '\ud800')).not.toBeNull();
});
