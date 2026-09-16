import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { mysqlValueSpec, validateDbWriteValue, validateMysqlValue, type MysqlValueSpec } from '../../../desktop-contract/src/mysql-values';
import type { DbCell, DbColumn, DbWriteValue, QueryResult, TableChanges } from '../../../desktop-contract/src/index';
const METADATA_ALIASES = [
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
] as const;

const MAX_BATCH_STATEMENTS = 100;
const MAX_BATCH_SQL_BYTES = 1_000_000;
const MAX_TABLE_SEARCH_PAGE = 1_000;
const MAX_TABLE_SEARCH_OFFSET = MAX_TABLE_SEARCH_PAGE * 500;
const ORIGINAL_TEXT_SPEC = { kind: 'text', multiline: true } as const;

const dbCellSchema = z.union([z.string(), z.boolean(), z.null()]);
const dbWriteValueSchema = z.union([dbCellSchema, z.object({ kind: z.literal('default') }).strict()]);
const queryResultSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()),
  rows: z.array(z.array(dbCellSchema)),
  message: z.string(),
  elapsedMs: z.number().finite().nonnegative(),
  truncated: z.boolean(),
  editable: z.boolean()
}).passthrough();
const tableChangesSchema = z.object({
  schema: z.string(),
  table: z.string(),
  snapshotId: z.string(),
  updates: z.array(z.object({
    row: z.record(z.string(), dbCellSchema),
    values: z.record(z.string(), dbWriteValueSchema)
  }).strict()),
  inserts: z.array(z.record(z.string(), dbWriteValueSchema)),
  deletes: z.array(z.record(z.string(), dbCellSchema))
}).strict();

type ParsedQueryResult = z.infer<typeof queryResultSchema>;

type MetadataAlias = typeof METADATA_ALIASES[number];
type MetadataRow = Record<MetadataAlias, string | null>;

interface ColumnMetadata {
  readonly name: string;
  readonly type: string;
  readonly dataType: string;
  readonly spec: MysqlValueSpec;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly autoIncrement: boolean;
  readonly primaryKey: boolean;
  readonly ordinal: number;
  readonly metadata: MetadataRow;
}

interface VisibleTable {
  readonly columns: readonly DbColumn[];
  readonly rows: readonly (readonly DbCell[])[];
  readonly originals: readonly Readonly<Record<string, DbCell>>[];
}

interface VerifiedTable {
  readonly columns: readonly ColumnMetadata[];
  readonly byName: ReadonlyMap<string, ColumnMetadata>;
  readonly primaryColumns: readonly ColumnMetadata[];
  readonly originalRows: ReadonlyMap<string, Readonly<Record<string, DbCell>>>;
}

export interface SqlTableSnapshot {
  readonly result: QueryResult;
  readonly metadataFingerprint: string;
  compile(changes: TableChanges): string[];
}

/**
 * Builds the one metadata read used to verify a table snapshot. Values are encoded
 * as UTF-8 hex literals so no connection SQL mode can reinterpret quoted text.
 */
export function tableMetadataSql(schema: string, table: string): string {
  const schemaValue = utf8Expression(schema, '数据库名');
  const tableValue = utf8Expression(table, '表名');
  return [
    'SELECT',
    '  t.TABLE_TYPE AS table_type,',
    '  t.ENGINE AS engine,',
    '  c.COLUMN_NAME AS column_name,',
    '  c.DATA_TYPE AS data_type,',
    '  c.COLUMN_TYPE AS column_type,',
    '  c.IS_NULLABLE AS is_nullable,',
    '  c.COLUMN_DEFAULT AS column_default,',
    '  c.EXTRA AS extra,',
    '  c.GENERATION_EXPRESSION AS generation_expression,',
    '  c.COLUMN_KEY AS column_key,',
    '  c.ORDINAL_POSITION AS ordinal_position,',
    '  c.CHARACTER_SET_NAME AS character_set_name,',
    '  c.NUMERIC_PRECISION AS numeric_precision,',
    '  c.NUMERIC_SCALE AS numeric_scale,',
    '  c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length',
    'FROM information_schema.TABLES AS t',
    'INNER JOIN information_schema.COLUMNS AS c',
    '  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME',
    `WHERE BINARY CONVERT(t.TABLE_SCHEMA USING utf8mb4) = BINARY ${schemaValue}`,
    `  AND BINARY CONVERT(t.TABLE_NAME USING utf8mb4) = BINARY ${tableValue}`,
    'ORDER BY c.ORDINAL_POSITION ASC',
    'LIMIT 1025'
  ].join('\n');
}

/**
 * Builds the read-only query used to search a table after Chen has authorized
 * its data view. Search text stays a UTF-8 value, never SQL syntax.
 */
export function tableSearchSql(
  schema: string,
  table: string,
  metadataResult: QueryResult,
  search: { readonly text: string; readonly column?: string },
  page: number,
  limit: number
): string {
  assertUtf16(schema, '数据库名');
  assertUtf16(table, '表名');
  if (schema.length === 0 || table.length === 0) throw new Error('数据库名和表名不能为空');
  assertUtf16(search.text, '搜索文本');
  if (search.text.length === 0 || search.text.length > 512) throw new Error('搜索文本长度必须为 1 到 512 个 UTF-16 代码单元');
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_TABLE_SEARCH_PAGE) {
    throw new Error(`搜索页码必须在 1 到 ${MAX_TABLE_SEARCH_PAGE} 之间`);
  }
  if (limit !== 50 && limit !== 100 && limit !== 200 && limit !== 500) throw new Error('搜索分页大小无效');
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > MAX_TABLE_SEARCH_OFFSET) throw new Error('搜索分页偏移量超出安全范围');

  const metadata = parseMetadataResult(queryResultSchema.parse(metadataResult));
  let columns: readonly ColumnMetadata[];
  if (search.column === undefined) {
    columns = metadata.filter((column) => column.spec.kind !== 'unsupported');
  } else {
    const column = metadata.find((candidate) => candidate.name === search.column);
    if (!column) throw new Error(`搜索字段 ${search.column} 不属于当前表`);
    if (column.spec.kind === 'unsupported') throw new Error(`搜索字段 ${search.column} 没有可安全使用的文本表示`);
    columns = [column];
  }
  if (columns.length === 0) throw new Error('当前表没有可安全搜索的字段');

  const needle = utf8Expression(search.text, '搜索文本');
  const predicates = columns.map((column) => {
    const identifier = quoteIdentifier(column.name, `字段 ${column.name}`);
    return `LOCATE(BINARY ${needle}, BINARY CONVERT(${identifier} USING utf8mb4)) > 0`;
  });
  const primaryColumns = metadata.filter((column) => column.primaryKey);
  const order = primaryColumns.length === 0
    ? undefined
    : `ORDER BY ${primaryColumns.map((column) => `${quoteIdentifier(column.name, `字段 ${column.name}`)} ASC`).join(', ')}`;
  const fields = metadata.map((column) => quoteIdentifier(column.name, `字段 ${column.name}`));
  return [
    `SELECT ${fields.join(', ')}`,
    `FROM ${quoteIdentifier(schema, '数据库名')}.${quoteIdentifier(table, '表名')}`,
    `WHERE (${predicates.join(' OR ')})`,
    ...(order ? [order] : []),
    `LIMIT ${limit} OFFSET ${offset}`
  ].join('\n');
}

/**
 * Verifies metadata and a Chen table page before making its rows usable as DML
 * targets. Any uncertainty returns a read-only snapshot rather than emitting SQL.
 */
export function createSqlTableSnapshot(
  schema: string,
  table: string,
  metadataResult: QueryResult,
  tableResult: QueryResult
): SqlTableSnapshot {
  const snapshotId = randomUUID();
  const fallbackFingerprint = hashMetadata(schema, table, []);

  try {
    assertUtf16(schema, '数据库名');
    assertUtf16(table, '表名');
    if (schema.length === 0 || table.length === 0) throw new Error('数据库名和表名不能为空');

    const metadataSource = queryResultSchema.parse(metadataResult);
    const tableSource = queryResultSchema.parse(tableResult);
    const metadataColumns = parseMetadataResult(metadataSource);
    const visible = verifyVisibleTable(tableSource, metadataColumns);
    const fingerprint = hashMetadata(schema, table, metadataColumns.map((column) => column.metadata));
    const tableWritable = metadataColumns[0]?.metadata.table_type === 'BASE TABLE'
      && metadataColumns[0]?.metadata.engine?.toLowerCase() === 'innodb';

    if (!tableWritable) {
      const reason = '仅已验证的 InnoDB 基础表允许编辑；当前对象已设为只读。';
      return readOnlySnapshot(readOnlyResult(tableSource, snapshotId, reason), fingerprint, reason);
    }

    const unsupported = metadataColumns.find((column) => column.spec.kind === 'unsupported');
    if (unsupported) {
      const reason = `字段 ${unsupported.name} 的类型 ${unsupported.dataType} 没有无损的 Chen 线协议表示，表已设为只读。`;
      return readOnlySnapshot(readOnlyResult(tableSource, snapshotId, reason), fingerprint, reason);
    }

    const metadataByName = new Map(metadataColumns.map((column) => [column.name, column]));
    const primaryColumns = metadataColumns.filter((column) => column.primaryKey);
    const originals = new Map<string, Readonly<Record<string, DbCell>>>();
    const primaryKeys = new Set<string>();
    for (const row of visible.originals) {
      for (const column of metadataColumns) renderCell(column, row[column.name], '原始快照');
      const rowKey = recordKey(metadataColumns, row);
      if (primaryColumns.length > 0 && originals.has(rowKey)) throw new Error('表数据包含重复的完整原始行，无法安全定位记录');
      originals.set(rowKey, row);
      if (primaryColumns.length > 0) {
        const primaryKey = recordKey(primaryColumns, row);
        if (primaryKeys.has(primaryKey)) throw new Error('表数据包含重复的主键，无法安全编辑');
        primaryKeys.add(primaryKey);
      }
    }

    const verified: VerifiedTable = {
      columns: metadataColumns,
      byName: metadataByName,
      primaryColumns,
      originalRows: originals
    };
    return {
      result: verifiedResult(tableSource, visible, metadataColumns, primaryColumns.length > 0, snapshotId),
      metadataFingerprint: fingerprint,
      compile: (changes) => compileChanges(schema, table, snapshotId, verified, changes)
    };
  } catch (cause) {
    const detail = cause instanceof z.ZodError ? '结果格式无效' : cause instanceof Error ? cause.message : '未知错误';
    const reason = `表数据或元数据未通过安全验证，已设为只读：${detail}`;
    return readOnlySnapshot(readOnlyResult(tableResult, snapshotId, reason), fallbackFingerprint, reason);
  }
}

function parseMetadataResult(result: ParsedQueryResult): readonly ColumnMetadata[] {
  const columns = result.columns;
  const rows = result.rows;
  if (result.truncated) throw new Error('元数据结果被截断');
  if (columns.length !== METADATA_ALIASES.length) throw new Error('元数据列不完整');

  const indexes = new Map<MetadataAlias, number>();
  for (let index = 0; index < columns.length; index += 1) {
    const name = columns[index]?.name;
    const alias = METADATA_ALIASES.find((candidate) => candidate === name);
    if (alias === undefined || indexes.has(alias)) throw new Error('元数据列名称不完整或重复');
    indexes.set(alias, index);
  }
  if (indexes.size !== METADATA_ALIASES.length) throw new Error('元数据列不完整或重复');
  if (rows.length === 0) throw new Error('未找到表元数据');
  if (rows.length > 1024) throw new Error('表字段数量超过安全上限');

  const seenNames = new Set<string>();
  const parsed = rows.map((rawRow) => {
    if (rawRow.length !== columns.length) throw new Error('元数据行格式无效');
    const values = {} as MetadataRow;
    for (const alias of METADATA_ALIASES) {
      const index = indexes.get(alias);
      if (index === undefined) throw new Error('元数据列不完整');
      values[alias] = metadataCell(rawRow[index], `元数据 ${alias}`);
    }

    const name = requiredMetadata(values.column_name, '字段名');
    if (name.includes('\u0000')) throw new Error('字段名包含无效字符');
    if (seenNames.has(name)) throw new Error(`元数据中字段 ${name} 重复`);
    seenNames.add(name);

    const dataType = requiredMetadata(values.data_type, `字段 ${name} 的类型`).toLowerCase();
    const type = requiredMetadata(values.column_type, `字段 ${name} 的完整类型`);
    const nullableToken = requiredMetadata(values.is_nullable, `字段 ${name} 的空值属性`);
    if (nullableToken !== 'YES' && nullableToken !== 'NO') throw new Error(`字段 ${name} 的空值属性无效`);

    const ordinal = decimalInteger(requiredMetadata(values.ordinal_position, `字段 ${name} 的序号`), `字段 ${name} 的序号`);
    const extra = values.extra || '';
    const generationExpression = values.generation_expression || '';
    const generated = generationExpression.length > 0 || /\bGENERATED\b/i.test(extra);
    const autoIncrement = /\bAUTO_INCREMENT\b/i.test(extra);
    const spec = mysqlValueSpec(type);

    return Object.freeze({
      name,
      type,
      dataType,
      spec,
      nullable: nullableToken === 'YES',
      hasDefault: values.column_default !== null || nullableToken === 'YES',
      generated,
      autoIncrement,
      ordinal,
      primaryKey: values.column_key === 'PRI',
      metadata: Object.freeze(values)
    });
  });

  parsed.sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1]?.ordinal === parsed[index]?.ordinal) throw new Error('元数据字段序号重复');
  }
  const first = parsed[0];
  if (!first) throw new Error('未找到表字段');
  for (const column of parsed) {
    if (column.metadata.table_type !== first.metadata.table_type || column.metadata.engine !== first.metadata.engine) {
      throw new Error('同一表的元数据不一致');
    }
  }
  return Object.freeze(parsed);
}

function verifyVisibleTable(result: ParsedQueryResult, metadataColumns: readonly ColumnMetadata[]): VisibleTable {
  const sourceColumns = result.columns;
  const sourceRows = result.rows;
  if (sourceColumns.length !== metadataColumns.length) throw new Error('可见结果列与表元数据不完全一致');

  const metadataByName = new Map(metadataColumns.map((column) => [column.name, column]));
  const visibleColumns: DbColumn[] = [];
  const indexesByName = new Map<string, number>();
  for (let index = 0; index < sourceColumns.length; index += 1) {
    const rawColumn = sourceColumns[index];
    const name = rawColumn?.name;
    const type = rawColumn?.type;
    if (typeof name !== 'string' || typeof type !== 'string' || !metadataByName.has(name) || indexesByName.has(name)) {
      throw new Error('可见结果列缺失、重复或不是表字段');
    }
    assertUtf16(name, '可见结果字段名');
    indexesByName.set(name, index);
    visibleColumns.push({ name, type });
  }
  if (indexesByName.size !== metadataColumns.length) throw new Error('可见结果缺少表字段');

  const rows: DbCell[][] = [];
  const originals: Readonly<Record<string, DbCell>>[] = [];
  for (const rawRow of sourceRows) {
    if (rawRow.length !== visibleColumns.length) throw new Error('可见结果行不完整');
    const copied = rawRow.map((value) => {
      if (typeof value === 'string') assertUtf16(value, '可见结果值');
      return value;
    });
    const original: Record<string, DbCell> = Object.create(null);
    for (const column of metadataColumns) {
      const index = indexesByName.get(column.name);
      if (index === undefined) throw new Error('可见结果缺少表字段');
      original[column.name] = copied[index];
    }
    rows.push(copied);
    originals.push(Object.freeze(original));
  }

  return Object.freeze({
    columns: Object.freeze(visibleColumns),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    originals: Object.freeze(originals)
  });
}

function verifiedResult(
  source: ParsedQueryResult,
  visible: VisibleTable,
  metadataColumns: readonly ColumnMetadata[],
  hasPrimaryKey: boolean,
  snapshotId: string
): QueryResult {
  const metadataByName = new Map(metadataColumns.map((column) => [column.name, column]));
  const writableColumns = visible.columns.map((visibleColumn) => {
    const metadata = metadataByName.get(visibleColumn.name);
    if (!metadata || metadata.spec.kind === 'unsupported') throw new Error('表字段元数据不完整');
    return {
      name: metadata.name,
      type: metadata.type,
      primaryKey: metadata.primaryKey,
      editable: hasPrimaryKey && !metadata.primaryKey && !metadata.generated && !metadata.autoIncrement,
      insertable: !metadata.generated && !metadata.autoIncrement,
      nullable: metadata.nullable,
      hasDefault: metadata.hasDefault,
      generated: metadata.generated,
      autoIncrement: metadata.autoIncrement
    };
  });

  return {
    columns: writableColumns,
    rows: visible.rows.map((row) => [...row]),
    message: source.message,
    elapsedMs: source.elapsedMs,
    truncated: source.truncated,
    editable: hasPrimaryKey,
    insertable: true,
    snapshotId
  };
}

function readOnlySnapshot(result: QueryResult, metadataFingerprint: string, reason: string): SqlTableSnapshot {
  return {
    result,
    metadataFingerprint,
    compile: () => {
      throw new Error(reason);
    }
  };
}

function readOnlyResult(source: QueryResult, snapshotId: string, reason: string): QueryResult {
  const parsed = queryResultSchema.safeParse(source);
  if (!parsed.success) {
    return {
      columns: [],
      rows: [],
      message: '表数据结果无效',
      elapsedMs: 0,
      truncated: false,
      editable: false,
      insertable: false,
      readonlyReason: reason,
      snapshotId
    };
  }
  return {
    columns: parsed.data.columns.map((column) => ({ name: column.name, type: column.type, editable: false, insertable: false })),
    rows: parsed.data.rows.map((row) => [...row]),
    message: parsed.data.message,
    elapsedMs: parsed.data.elapsedMs,
    truncated: parsed.data.truncated,
    editable: false,
    insertable: false,
    readonlyReason: reason,
    snapshotId
  };
}

function compileChanges(
  schema: string,
  table: string,
  snapshotId: string,
  verified: VerifiedTable,
  changes: TableChanges
): string[] {
  const parsed = tableChangesSchema.safeParse(changes);
  if (!parsed.success) throw new Error('修改请求格式无效');
  const input = parsed.data;
  if (input.schema !== schema || input.table !== table) throw new Error('修改请求的数据库或表与快照不一致');
  if (input.snapshotId !== snapshotId) throw new Error('修改请求的快照已过期或不属于当前表');
  const count = input.updates.length + input.inserts.length + input.deletes.length;
  if (count === 0) throw new Error('至少需要一项有效修改');
  if (count > MAX_BATCH_STATEMENTS) throw new Error(`一次最多预览 ${MAX_BATCH_STATEMENTS} 条修改`);

  if ((input.updates.length > 0 || input.deletes.length > 0) && verified.primaryColumns.length === 0) {
    throw new Error('该表没有主键，不能更新或删除已有记录；仍可新增记录');
  }

  const tableName = `${quoteIdentifier(schema, '数据库名')}.${quoteIdentifier(table, '表名')}`;
  const usedTargets = new Set<string>();
  const statements: string[] = [];
  for (const update of input.updates) {
    const original = snapshotRow(verified, update.row, '更新原始行');
    claimTarget(verified, original, usedTargets, '更新');
    const assignments = updateAssignments(verified, original, update.values);
    // Protect every assigned field without conflicting on unrelated concurrent edits.
    const guardColumns = verified.columns.filter((column) => column.primaryKey || Object.hasOwn(update.values, column.name));
    statements.push(`UPDATE ${tableName} SET ${assignments} WHERE ${whereClause(guardColumns, original)} LIMIT 1`);
  }

  for (const values of input.inserts) statements.push(insertStatement(tableName, verified, values));

  for (const deleted of input.deletes) {
    const original = snapshotRow(verified, deleted, '删除原始行');
    claimTarget(verified, original, usedTargets, '删除');
    statements.push(`DELETE FROM ${tableName} WHERE ${whereClause(verified.columns, original)} LIMIT 1`);
  }

  const bytes = statements.reduce((total, statement) => total + Buffer.byteLength(statement, 'utf8'), 0);
  if (bytes > MAX_BATCH_SQL_BYTES) throw new Error('预览 SQL 总大小超过 1 MB 限制');
  return statements;
}

function snapshotRow(
  verified: VerifiedTable,
  submitted: Record<string, DbCell>,
  label: string
): Readonly<Record<string, DbCell>> {
  assertExactColumnKeys(submitted, verified.columns, label);
  const key = recordKey(verified.columns, submitted);
  const original = verified.originalRows.get(key);
  if (!original) throw new Error(`${label}不属于当前不可变快照，不能执行修改`);
  return original;
}

function claimTarget(
  verified: VerifiedTable,
  original: Readonly<Record<string, DbCell>>,
  usedTargets: Set<string>,
  operation: string
): void {
  const key = recordKey(verified.primaryColumns, original);
  if (usedTargets.has(key)) throw new Error(`同一主键不能同时出现在多个更新或删除操作中（${operation}）`);
  usedTargets.add(key);
}

function updateAssignments(
  verified: VerifiedTable,
  original: Readonly<Record<string, DbCell>>,
  values: Record<string, DbWriteValue>
): string {
  const names = Object.keys(values);
  if (names.length === 0) throw new Error('更新内容不能为空');
  const assigned = new Set<string>();
  let hasChange = false;

  for (const name of names) {
    const column = verified.byName.get(name);
    if (!column) throw new Error(`更新包含未知字段：${name}`);
    if (column.primaryKey || column.generated || column.autoIncrement) {
      throw new Error(`字段 ${name} 不能被更新`);
    }
    const value = values[name];
    if (isDefaultValue(value) || value !== original[name]) hasChange = true;
    assigned.add(name);
  }
  if (!hasChange) throw new Error('更新内容与原始值相同，不生成空操作');

  return [...assigned]
    .map((name) => verified.byName.get(name))
    .filter((column): column is ColumnMetadata => column !== undefined)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((column) => `${quoteIdentifier(column.name, '字段名')} = ${renderWriteValue(column, values[column.name], '更新')}`)
    .join(', ');
}

function insertStatement(tableName: string, verified: VerifiedTable, values: Record<string, DbWriteValue>): string {
  const supplied = new Set(Object.keys(values));
  for (const name of supplied) {
    const column = verified.byName.get(name);
    if (!column) throw new Error(`新增包含未知字段：${name}`);
    if (column.generated || column.autoIncrement) throw new Error(`字段 ${name} 不能在新增时指定`);
  }

  for (const column of verified.columns) {
    if (supplied.has(column.name)) continue;
    const validation = validateDbWriteValue(column, undefined, true);
    if (validation) throw new Error(`新增字段 ${column.name} ${validation}`);
  }

  const ordered = verified.columns.filter((column) => supplied.has(column.name));
  if (ordered.length === 0) return `INSERT INTO ${tableName} () VALUES ()`;
  const names = ordered.map((column) => quoteIdentifier(column.name, '字段名')).join(', ');
  const rendered = ordered.map((column) => renderWriteValue(column, values[column.name], '新增')).join(', ');
  return `INSERT INTO ${tableName} (${names}) VALUES (${rendered})`;
}

function whereClause(columns: readonly ColumnMetadata[], original: Readonly<Record<string, DbCell>>): string {
  return columns.map((column) => `${predicate(column, original[column.name])}`).join(' AND ');
}

function predicate(column: ColumnMetadata, value: DbCell): string {
  const identifier = quoteIdentifier(column.name, '字段名');
  if (value === null) {
    if (!column.nullable) throw new Error(`原始快照中的字段 ${column.name} 违反非空约束`);
    return `${identifier} <=> NULL`;
  }
  if (column.spec.kind === 'text' || column.spec.kind === 'enum' || column.spec.kind === 'set' || column.spec.kind === 'json') {
    if (typeof value !== 'string') throw new Error(`原始快照字段 ${column.name} 不接受布尔值`);
    return `BINARY CONVERT(${identifier} USING utf8mb4) <=> BINARY ${utf8Expression(value, `原始快照字段 ${column.name}`)}`;
  }
  return `${identifier} <=> ${renderCell(column, value, '原始快照')}`;
}

function renderWriteValue(column: ColumnMetadata, value: DbWriteValue, operation: string): string {
  const validation = validateDbWriteValue(column, value, false);
  if (validation) throw new Error(`${operation}字段 ${column.name} ${validation}`);
  if (isDefaultValue(value)) return 'DEFAULT';
  if (value === null) return 'NULL';
  return renderValidatedCell(column, value, operation);
}

function renderCell(column: ColumnMetadata, value: DbCell, context: string): string {
  if (column.spec.kind === 'unsupported') throw new Error(`字段 ${column.name} 的类型 ${column.type} 不受支持`);
  if (value === null) {
    if (!column.nullable) throw new Error(`${context}字段 ${column.name} 不允许 NULL`);
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    if (column.spec.kind !== 'integer' && column.spec.kind !== 'decimal' && column.spec.kind !== 'float' && column.spec.kind !== 'boolean') {
      throw new Error(`${context}字段 ${column.name} 不接受布尔值`);
    }
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value !== 'string') throw new Error(`${context}字段 ${column.name} 的值类型无效`);

  const originalSpec = column.spec.kind === 'text' || column.spec.kind === 'enum' || column.spec.kind === 'set'
    ? ORIGINAL_TEXT_SPEC
    : column.spec;
  const validation = validateMysqlValue(originalSpec, value);
  if (validation) throw new Error(`${context}字段 ${column.name} ${validation}`);
  return renderValidatedCell(column, value, context);
}

function renderValidatedCell(column: ColumnMetadata, value: Exclude<DbCell, null>, context: string): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const literal = utf8Expression(value, `${context}字段 ${column.name}`);
  switch (column.spec.kind) {
    case 'integer':
      return `CAST(${literal} AS ${column.spec.min === '0' ? 'UNSIGNED' : 'SIGNED'})`;
    case 'decimal':
      return `CAST(${literal} AS DECIMAL(${column.spec.precision},${column.spec.scale}))`;
    case 'float':
      return `CAST(${literal} AS ${column.dataType === 'float' ? 'FLOAT' : 'DOUBLE'})`;
    case 'boolean':
      return `CAST(${literal} AS SIGNED)`;
    case 'json':
      return `CAST(${literal} AS JSON)`;
    case 'date':
    case 'datetime':
    case 'time':
    case 'year':
    case 'text':
    case 'enum':
    case 'set':
      return literal;
    case 'unsupported':
      throw new Error(`字段 ${column.name} 的类型 ${column.type} 不受支持`);
  }
}

function metadataCell(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} 不是字符串或 NULL`);
  assertUtf16(value, label);
  return value;
}

function requiredMetadata(value: string | null, label: string): string {
  if (value === null || value.length === 0) throw new Error(`${label} 缺失`);
  return value;
}

function decimalInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value) && value !== '0') throw new Error(`${label} 不是十进制整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} 超出安全范围`);
  return parsed;
}

function isDefaultValue(value: DbWriteValue): value is { kind: 'default' } {
  return typeof value === 'object' && value !== null && value.kind === 'default';
}

function assertExactColumnKeys(record: Record<string, DbCell>, columns: readonly ColumnMetadata[], label: string): void {
  const names = Object.keys(record);
  if (names.length !== columns.length) throw new Error(`${label} 必须包含完整的原始行`);
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(record, column.name)) {
      throw new Error(`${label} 必须包含字段 ${column.name} 的原始值`);
    }
  }
}

function recordKey(columns: readonly ColumnMetadata[], row: Record<string, DbCell> | Readonly<Record<string, DbCell>>): string {
  return JSON.stringify(columns.map((column) => row[column.name]));
}

function quoteIdentifier(identifier: string, label: string): string {
  assertUtf16(identifier, label);
  if (identifier.includes('\u0000')) throw new Error(`${label} 包含无效字符`);
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function utf8Expression(value: string, label: string): string {
  assertUtf16(value, label);
  // Chen's pinned Druid rewrites X'' to invalid bare 0x. Empty quoted text has no
  // escaping ambiguity in either MySQL string mode.
  if (value.length === 0) return "CONVERT('' USING utf8mb4)";
  return `CONVERT(X'${Buffer.from(value, 'utf8').toString('hex')}' USING utf8mb4)`;
}

function assertUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} 包含无法编码的 UTF-16 代理项`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} 包含无法编码的 UTF-16 代理项`);
    }
  }
}

function hashMetadata(schema: string, table: string, metadata: readonly MetadataRow[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ schema, table, metadata }))
    .digest('hex');
}
