import type { DbColumn, DbWriteValue } from './index';

export type MysqlValueSpec =
  | { kind: 'integer'; min: string; max: string }
  | { kind: 'decimal'; precision: number; scale: number; unsigned: boolean }
  | { kind: 'float'; unsigned: boolean; bits: 32 | 64 }
  | { kind: 'boolean' }
  | { kind: 'text'; multiline: boolean; maxLength?: number }
  | { kind: 'enum' | 'set'; values: readonly string[] }
  | { kind: 'json' }
  | { kind: 'date' }
  | { kind: 'datetime'; fractionalSeconds: number }
  | { kind: 'time'; fractionalSeconds: number }
  | { kind: 'year' }
  | { kind: 'unsupported'; reason: string };

interface ParsedColumnType {
  readonly name: string;
  readonly parameters: string | undefined;
  readonly attributes: readonly string[];
}

const INTEGER_LIMITS: Readonly<Record<string, readonly [string, string, string]>> = {
  tinyint: ['-128', '127', '255'],
  smallint: ['-32768', '32767', '65535'],
  mediumint: ['-8388608', '8388607', '16777215'],
  int: ['-2147483648', '2147483647', '4294967295'],
  integer: ['-2147483648', '2147483647', '4294967295'],
  bigint: ['-9223372036854775808', '9223372036854775807', '18446744073709551615']
};

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;
const FLOAT_PATTERN = /^-?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

export function mysqlValueSpec(type: string): MysqlValueSpec {
  const parsed = parseColumnType(type);
  if (!parsed) return unsupported(type, '完整类型格式无效');

  switch (parsed.name) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'integer':
    case 'bigint':
      return integerSpec(parsed, type);
    case 'decimal':
    case 'numeric':
      return decimalSpec(parsed, type);
    case 'float':
    case 'double':
      return floatSpec(parsed, type);
    case 'bool':
    case 'boolean':
      return noParameterSpec(parsed, type, { kind: 'boolean' });
    case 'char':
    case 'varchar':
      return textSpec(parsed, type);
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
      return noParameterSpec(parsed, type, { kind: 'text', multiline: true });
    case 'enum':
    case 'set':
      return choiceSpec(parsed, type);
    case 'json':
      return noParameterSpec(parsed, type, { kind: 'json' });
    case 'date':
      return noParameterSpec(parsed, type, { kind: 'date' });
    case 'datetime':
    case 'timestamp':
      return temporalSpec(parsed, type, 'datetime');
    case 'time':
      return temporalSpec(parsed, type, 'time');
    case 'year':
      return yearSpec(parsed, type);
    default:
      return unsupported(type, '该类型没有无损的编辑表示');
  }
}

export function validateMysqlValue(spec: MysqlValueSpec, value: string): string | null {
  if (!validUtf16(value)) return '包含无法编码的 UTF-16 代理项';

  switch (spec.kind) {
    case 'integer':
      return validateInteger(spec, value);
    case 'decimal':
      return validateDecimal(spec, value);
    case 'float':
      return validateFloat(spec, value);
    case 'boolean':
      return value === '0' || value === '1' ? null : '布尔值只能是 0 或 1';
    case 'text':
      return spec.maxLength !== undefined && Array.from(value).length > spec.maxLength
        ? `文本超过 ${spec.maxLength} 个字符的上限`
        : null;
    case 'enum':
      return spec.values.includes(value) ? null : '值不属于 ENUM 允许的选项';
    case 'set':
      return validSetValue(spec.values, value) ? null : '值包含不属于 SET 允许选项的成员';
    case 'json':
      return validateJson(value);
    case 'date':
      return validDate(value) ? null : '必须是有效的 YYYY-MM-DD 日期';
    case 'datetime':
      return validDateTime(value) && validFractionalSeconds(value, spec.fractionalSeconds)
        ? null
        : temporalError('日期时间', value, spec.fractionalSeconds);
    case 'time':
      return validTime(value) && validFractionalSeconds(value, spec.fractionalSeconds)
        ? null
        : temporalError('TIME 值', value, spec.fractionalSeconds);
    case 'year':
      return value === '0000' || (/^\d{4}$/.test(value) && Number(value) >= 1901 && Number(value) <= 2155)
        ? null
        : '年份必须是 0000 或 1901 至 2155';
    case 'unsupported':
      return spec.reason;
  }
}

export function validateDbWriteValue(column: DbColumn, value: DbWriteValue | undefined, allowOmit: boolean): string | null {
  if (value === undefined) {
    if (!allowOmit) return '当前操作不能省略该字段';
    if (column.generated || column.autoIncrement || column.nullable || column.hasDefault) return null;
    return '新增缺少必填字段';
  }

  if (column.generated || column.autoIncrement) return '字段由数据库自动生成，不能指定值';
  if (isDefaultValue(value)) return column.hasDefault ? null : '字段不支持 DEFAULT';
  if (value === null) return column.nullable ? null : '字段不允许 NULL';

  const spec = mysqlValueSpec(column.type);
  if (typeof value === 'boolean') {
    return spec.kind === 'integer' || spec.kind === 'decimal' || spec.kind === 'float' || spec.kind === 'boolean'
      ? validateMysqlValue(spec, value ? '1' : '0')
      : '字段不接受布尔值';
  }
  if (typeof value !== 'string') return '字段值类型无效';
  return validateMysqlValue(spec, value);
}

function parseColumnType(type: string): ParsedColumnType | null {
  if (typeof type !== 'string' || !validUtf16(type)) return null;
  let offset = 0;
  while (isWhitespace(type[offset])) offset += 1;
  const nameStart = offset;
  while (type[offset] !== undefined && /[A-Za-z]/.test(type[offset])) offset += 1;
  if (offset === nameStart) return null;
  const name = type.slice(nameStart, offset).toLowerCase();

  while (isWhitespace(type[offset])) offset += 1;
  let parameters: string | undefined;
  if (type[offset] === '(') {
    const group = parenthesizedGroup(type, offset);
    if (!group) return null;
    parameters = group.content;
    offset = group.next;
    while (isWhitespace(type[offset])) offset += 1;
  }

  const remainder = type.slice(offset);
  if (remainder.length > 0 && !/^\s*(?:[A-Za-z]+\s*)*$/.test(remainder)) return null;
  const attributes = remainder.trim().length === 0
    ? []
    : remainder.trim().toLowerCase().split(/\s+/);
  return { name, parameters, attributes };
}

function integerSpec(parsed: ParsedColumnType, type: string): MysqlValueSpec {
  const width = parsed.parameters === undefined ? 1 : safeSmallInteger(parsed.parameters);
  if (width === undefined || width < 1 || width > 255 || !validNumericAttributes(parsed.attributes)) {
    return unsupported(type, '整数类型元数据无效');
  }
  const limits = INTEGER_LIMITS[parsed.name];
  if (!limits) return unsupported(type, '整数类型元数据无效');
  const unsigned = parsed.attributes.includes('unsigned') || parsed.attributes.includes('zerofill');
  return unsigned
    ? { kind: 'integer', min: '0', max: limits[2] }
    : { kind: 'integer', min: limits[0], max: limits[1] };
}

function decimalSpec(parsed: ParsedColumnType, type: string): MysqlValueSpec {
  if (!validNumericAttributes(parsed.attributes) || parsed.parameters === undefined) {
    return unsupported(type, 'DECIMAL 精度元数据无效');
  }
  const match = /^(\d+)\s*,\s*(\d+)$/.exec(parsed.parameters);
  if (!match) return unsupported(type, 'DECIMAL 精度元数据无效');
  const precision = safeSmallInteger(match[1]);
  const scale = safeSmallInteger(match[2]);
  if (precision === undefined || scale === undefined || precision < 1 || precision > 65 || scale > 30 || scale > precision) {
    return unsupported(type, 'DECIMAL 精度元数据无效');
  }
  return {
    kind: 'decimal',
    precision,
    scale,
    unsigned: parsed.attributes.includes('unsigned') || parsed.attributes.includes('zerofill')
  };
}

function floatSpec(parsed: ParsedColumnType, type: string): MysqlValueSpec {
  if (!validNumericAttributes(parsed.attributes)) return unsupported(type, '浮点类型元数据无效');
  if (parsed.parameters !== undefined) {
    const match = /^(\d+)(?:\s*,\s*(\d+))?$/.exec(parsed.parameters);
    if (!match) return unsupported(type, '浮点类型元数据无效');
    const first = safeSmallInteger(match[1]);
    if (first === undefined) return unsupported(type, '浮点类型元数据无效');
    if (match[2] === undefined) {
      if (first > 53) return unsupported(type, '浮点类型元数据无效');
    } else {
      const second = safeSmallInteger(match[2]);
      if (second === undefined || first > 255 || second > 30 || second > first) {
        return unsupported(type, '浮点类型元数据无效');
      }
    }
  }
  return {
    kind: 'float',
    bits: parsed.name === 'float' ? 32 : 64,
    unsigned: parsed.attributes.includes('unsigned') || parsed.attributes.includes('zerofill')
  };
}

function textSpec(parsed: ParsedColumnType, type: string): MysqlValueSpec {
  if (parsed.attributes.length > 0 || parsed.parameters === undefined) return unsupported(type, '字符长度元数据无效');
  const maxLength = safeSmallInteger(parsed.parameters);
  const limit = parsed.name === 'char' ? 255 : 65_535;
  if (maxLength === undefined || maxLength < 1 || maxLength > limit) {
    return unsupported(type, '字符长度元数据无效');
  }
  return { kind: 'text', multiline: false, maxLength };
}

function choiceSpec(parsed: ParsedColumnType, type: string): MysqlValueSpec {
  if (parsed.attributes.length > 0 || parsed.parameters === undefined) return unsupported(type, '选项类型元数据无效');
  const values = parseQuotedValues(parsed.parameters);
  if (!values || values.length === 0 || new Set(values).size !== values.length
    || (parsed.name === 'set' && (values.length > 64 || values.some((value) => value.includes(','))))) {
    return unsupported(type, '选项类型元数据无效');
  }
  if (parsed.name === 'set' && values.includes('')) {
    return unsupported(type, 'SET 空成员与空集合无法通过文本结果无损区分');
  }
  return parsed.name === 'enum'
    ? { kind: 'enum', values: Object.freeze(values) }
    : { kind: 'set', values: Object.freeze(values) };
}

function temporalSpec(parsed: ParsedColumnType, type: string, kind: 'datetime' | 'time'): MysqlValueSpec {
  if (parsed.attributes.length > 0) return unsupported(type, '时间精度元数据无效');
  const fractionalSeconds = parsed.parameters === undefined ? 0 : safeSmallInteger(parsed.parameters);
  if (fractionalSeconds === undefined || fractionalSeconds > 6) return unsupported(type, '时间精度元数据无效');
  return kind === 'datetime'
    ? { kind: 'datetime', fractionalSeconds }
    : { kind: 'time', fractionalSeconds };
}

function yearSpec(parsed: ParsedColumnType, type: string): MysqlValueSpec {
  if (parsed.attributes.length > 0 || (parsed.parameters !== undefined && parsed.parameters !== '4')) {
    return unsupported(type, 'YEAR 类型元数据无效');
  }
  return { kind: 'year' };
}

function noParameterSpec(parsed: ParsedColumnType, type: string, spec: MysqlValueSpec): MysqlValueSpec {
  return parsed.parameters === undefined && parsed.attributes.length === 0
    ? spec
    : unsupported(type, '类型元数据包含不支持的修饰符');
}

function validNumericAttributes(attributes: readonly string[]): boolean {
  if (attributes.length > 2 || attributes.some((attribute) => attribute !== 'unsigned' && attribute !== 'zerofill')) return false;
  return attributes.length < 2 || attributes[0] !== attributes[1];
}

function parseQuotedValues(value: string): string[] | null {
  const values: string[] = [];
  let offset = 0;
  while (isWhitespace(value[offset])) offset += 1;

  while (offset < value.length) {
    if (value[offset] !== "'") return null;
    offset += 1;
    let member = '';
    let closed = false;
    while (offset < value.length) {
      const character = value[offset];
      if (character === "'") {
        if (value[offset + 1] === "'") {
          member += "'";
          offset += 2;
          continue;
        }
        offset += 1;
        closed = true;
        break;
      }
      if (character === '\\') {
        const escaped = value[offset + 1];
        if (escaped === undefined) return null;
        member += decodeMysqlEscape(escaped);
        offset += 2;
        continue;
      }
      member += character;
      offset += 1;
    }
    if (!closed || !validUtf16(member)) return null;
    values.push(member);
    while (isWhitespace(value[offset])) offset += 1;
    if (offset === value.length) return values;
    if (value[offset] !== ',') return null;
    offset += 1;
    while (isWhitespace(value[offset])) offset += 1;
  }

  return null;
}

function decodeMysqlEscape(character: string): string {
  switch (character) {
    case '0': return '\0';
    case 'b': return '\b';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'Z': return '\x1a';
    default: return character;
  }
}

function validateInteger(spec: Extract<MysqlValueSpec, { kind: 'integer' }>, value: string): string | null {
  if (!/^-?\d+$/.test(value)) return '必须是十进制整数';
  const integer = BigInt(value);
  if (integer < BigInt(spec.min) || integer > BigInt(spec.max)) return `超出 ${spec.min} 到 ${spec.max} 的整数范围`;
  return null;
}

function validateDecimal(spec: Extract<MysqlValueSpec, { kind: 'decimal' }>, value: string): string | null {
  if (!DECIMAL_PATTERN.test(value)) return '必须是不含指数的十进制数';
  if (spec.unsigned && value.startsWith('-') && /[1-9]/.test(value)) return '无符号 DECIMAL 不能为负数';

  const [integerPart, fractionalPart = ''] = value.replace(/^-/, '').split('.');
  const significantInteger = integerPart.replace(/^0+/, '');
  if (significantInteger.length > spec.precision - spec.scale || fractionalPart.length > spec.scale) {
    return `超出 DECIMAL(${spec.precision},${spec.scale}) 的范围`;
  }
  return null;
}

function validateFloat(spec: Extract<MysqlValueSpec, { kind: 'float' }>, value: string): string | null {
  if (!FLOAT_PATTERN.test(value)) return '必须是有限浮点数';
  const numeric = spec.bits === 32 ? Math.fround(Number(value)) : Number(value);
  const significantDigits = value.replace(/[eE].*$/, '').replace(/[+\-.0]/g, '');
  if (!Number.isFinite(numeric) || (numeric === 0 && significantDigits.length > 0)) return '超出可安全表示的浮点范围';
  if (spec.unsigned && numeric < 0) return '无符号浮点数不能为负数';
  return null;
}

function validateJson(value: string): string | null {
  try {
    JSON.parse(value, (key, parsed) => {
      if (!validUtf16(key) || (typeof parsed === 'string' && !validUtf16(parsed))) {
        throw new Error('invalid UTF-16');
      }
      return parsed;
    });
    return null;
  } catch (cause) {
    return cause instanceof Error && cause.message === 'invalid UTF-16'
      ? 'JSON 包含无法编码的 UTF-16 代理项'
      : '不是有效 JSON';
  }
}

function validSetValue(values: readonly string[], value: string): boolean {
  if (value === '') return true;
  const members = value.split(',');
  return new Set(members).size === members.length
    && members.every((member) => member !== '' && values.includes(member));
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] || 0);
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match || !validDate(match[1] || '')) return false;
  return Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59;
}

function validTime(value: string): boolean {
  const match = /^-?(\d{1,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match || Number(match[1]) > 838) return false;
  return Number(match[1]) !== 838 || match[2] !== '59' || match[3] !== '59' || !/[1-9]/.test(match[4] ?? '');
}

function validFractionalSeconds(value: string, precision: number): boolean {
  const fraction = /\.(\d+)$/.exec(value)?.[1] ?? '';
  return fraction.replace(/0+$/, '').length <= precision;
}

function temporalError(label: string, value: string, precision: number): string {
  const fraction = /\.(\d+)$/.exec(value)?.[1] ?? '';
  if (fraction.replace(/0+$/, '').length > precision) return `超出时间精度：最多 ${precision} 位小数秒`;
  return `必须是有效的${label}`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parenthesizedGroup(value: string, start: number): { content: string; next: number } | null {
  let depth = 0;
  let quoted = false;
  for (let offset = start; offset < value.length; offset += 1) {
    const character = value[offset];
    if (quoted) {
      if (character === '\\') {
        offset += 1;
        if (offset >= value.length) return null;
      } else if (character === "'") {
        if (value[offset + 1] === "'") offset += 1;
        else quoted = false;
      }
      continue;
    }
    if (character === "'") {
      quoted = true;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return { content: value.slice(start + 1, offset), next: offset + 1 };
      if (depth < 0) return null;
    }
  }
  return null;
}

function safeSmallInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value) || value.length > 15) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validUtf16(value: string): boolean {
  for (let offset = 0; offset < value.length; offset += 1) {
    const code = value.charCodeAt(offset);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(offset + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      offset += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

function isDefaultValue(value: DbWriteValue): value is { kind: 'default' } {
  return typeof value === 'object' && value !== null && value.kind === 'default';
}

function unsupported(type: string, reason: string): MysqlValueSpec {
  const display = typeof type === 'string' && type.length > 0 ? type : '未知类型';
  return { kind: 'unsupported', reason: `${reason}（${display}）` };
}
