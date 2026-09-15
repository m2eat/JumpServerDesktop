import { useId, useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Button, Checkbox, Input, Label, ListBox, Select, TextArea } from '@heroui/react';
import type { DbColumn, DbWriteValue } from '@shared/index';
import { mysqlValueSpec, validateDbWriteValue, validateMysqlValue } from '@shared/mysql-values';
import type { MysqlValueSpec } from '@shared/mysql-values';
import { translateDiagnostic, useI18n } from '../i18n';
import './DatabaseCellEditor.css';

export interface DatabaseCellEditorProps {
  column: DbColumn;
  initialValue: DbWriteValue | undefined;
  allowOmit: boolean;
  disabled: boolean;
  onSave: (value: DbWriteValue | undefined) => void;
  onCancel: () => void;
  onRevert: () => void;
}

const dateOnlySpec: MysqlValueSpec = { kind: 'date' };

type EditorMode = 'value' | 'null' | 'default' | 'omit';

interface DateDraft {
  date: string;
  structured: boolean;
}

interface DateTimeDraft {
  date: string;
  time: string;
  separator: string;
  structured: boolean;
}

function isDefaultValue(value: DbWriteValue | undefined): value is { kind: 'default' } {
  return typeof value === 'object' && value !== null && value.kind === 'default';
}

function modeForValue(value: DbWriteValue | undefined): EditorMode {
  if (value === undefined) return 'omit';
  if (value === null) return 'null';
  if (isDefaultValue(value)) return 'default';
  return 'value';
}

function initialText(value: DbWriteValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value === true) return '1';
  if (value === false) return '0';
  return '';
}

function isDateInputValue(value: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value);
}

function createDateDraft(raw: string): DateDraft {
  return { date: raw, structured: raw === '' || isDateInputValue(raw) };
}

function createDateTimeDraft(raw: string): DateTimeDraft {
  if (raw === '') return { date: '', time: '', separator: ' ', structured: true };
  const matched = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))([ T])(.*)$/.exec(raw);
  if (!matched) return { date: '', time: '', separator: ' ', structured: false };
  return { date: matched[1]!, time: matched[3]!, separator: matched[2]!, structured: true };
}

function composeDateTime(date: string, time: string, separator: string): string {
  return `${date}${separator}${time}`;
}

function setChoices(values: readonly string[], value: string): string[] | null {
  if (value === '') return [];
  const selected = value.split(',');
  if (selected.some((item) => !values.includes(item)) || new Set(selected).size !== selected.length) return null;
  return selected;
}

function writeValue(mode: EditorMode, value: string, initialValue: DbWriteValue | undefined, booleanType: boolean): DbWriteValue | undefined {
  if (mode === 'omit') return undefined;
  if (mode === 'null') return null;
  if (mode === 'default') return { kind: 'default' };
  if (typeof initialValue === 'boolean' && value === initialText(initialValue)) return initialValue;
  if (booleanType && (value === '0' || value === '1')) {
    if (typeof initialValue === 'string' && (initialValue === '0' || initialValue === '1')) return value;
    return value === '1';
  }
  return value;
}

function inputHint(kind: MysqlValueSpec, t: (key: string, values?: Record<string, string | number>) => string): string | null {
  switch (kind.kind) {
    case 'integer':
      return t('允许范围：{{min}} 至 {{max}}', { min: kind.min, max: kind.max });
    case 'decimal':
      return kind.unsigned
        ? t('精度 {{precision}}，小数位 {{scale}}，无符号', { precision: kind.precision, scale: kind.scale })
        : t('精度 {{precision}}，小数位 {{scale}}', { precision: kind.precision, scale: kind.scale });
    case 'float':
      return t(kind.unsigned ? '无符号浮点数；保留输入的精确文本。' : '浮点数；保留输入的精确文本。');
    case 'text':
      return kind.maxLength === undefined ? null : t('最多 {{count}} 个字符。', { count: kind.maxLength });
    case 'datetime':
      return t('日期与时间分开编辑；秒的小数部分最多 {{count}} 位。', { count: kind.fractionalSeconds });
    case 'time':
      return t('MySQL 时长格式：[-]HH:MM:SS{{fraction}}，范围 -838:59:59 至 838:59:59。', { fraction: kind.fractionalSeconds > 0 ? `.${'0'.repeat(kind.fractionalSeconds)}` : '' });
    case 'year':
      return t('请输入 0000 或 1901 至 2155 的四位年份。');
    default:
      return null;
  }
}

export default function DatabaseCellEditor({
  column,
  initialValue,
  allowOmit,
  disabled,
  onSave,
  onCancel,
  onRevert
}: DatabaseCellEditorProps) {
  const { t } = useI18n();
  const spec = useMemo(() => mysqlValueSpec(column.type), [column.type]);
  const initialTextValue = initialText(initialValue);
  const [mode, setMode] = useState<EditorMode>(() => initialValue === undefined && !allowOmit ? 'value' : modeForValue(initialValue));
  const [value, setValue] = useState<string>(() => initialTextValue);
  const [dateDraft, setDateDraft] = useState<DateDraft>(() => createDateDraft(initialTextValue));
  const [dateTimeDraft, setDateTimeDraft] = useState<DateTimeDraft>(() => createDateTimeDraft(initialTextValue));
  const [composing, setComposing] = useState(false);
  const controlId = useId();
  const modeId = `${controlId}-mode`;
  const valueId = `${controlId}-value`;
  const errorId = `${controlId}-error`;
  const hintId = `${controlId}-hint`;
  const booleanType = spec.kind === 'boolean';
  const candidate = writeValue(mode, value, initialValue, booleanType);
  const validationError = validateDbWriteValue(column, candidate, allowOmit);
  const unsupportedError = spec.kind === 'unsupported' && mode === 'value'
    ? t('此列类型无法安全编辑：{{reason}}', { reason: translateDiagnostic(spec.reason) })
    : null;
  const error = unsupportedError ?? (validationError ? translateDiagnostic(validationError) : null);
  const hint = inputHint(spec, t);
  const describedBy = error && hint ? `${errorId} ${hintId}` : error ? errorId : hint ? hintId : undefined;
  const invalid = error ? true : undefined;
  const booleanUsesSelect = spec.kind === 'boolean' && (value === '' || value === '0' || value === '1');
  const enumUsesSelect = spec.kind === 'enum' && (value === '' || spec.values.includes(value));
  const valueUsesSelect = booleanUsesSelect || enumUsesSelect;
  const valueLabel = spec.kind === 'json' ? t('JSON 文本') : t('值（{{type}}）', { type: column.type });

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || composing) return;
    const nextValue = writeValue(mode, value, initialValue, booleanType);
    const nextValidationError = validateDbWriteValue(column, nextValue, allowOmit);
    if (nextValidationError || (spec.kind === 'unsupported' && mode === 'value')) return;
    onSave(nextValue);
  };

  const preventImeSubmit = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (composing || event.nativeEvent.isComposing)) event.preventDefault();
  };

  const changeDate = (nextDate: string) => {
    setDateDraft({ date: nextDate, structured: true });
    setValue(nextDate);
  };

  const changeDateTimeDate = (nextDate: string) => {
    const raw = composeDateTime(nextDate, dateTimeDraft.time, dateTimeDraft.separator);
    setDateTimeDraft({ ...dateTimeDraft, date: nextDate, structured: true });
    setValue(raw);
  };

  const changeDateTimeTime = (nextTime: string) => {
    const raw = composeDateTime(dateTimeDraft.date, nextTime, dateTimeDraft.separator);
    setDateTimeDraft({ ...dateTimeDraft, time: nextTime, structured: true });
    setValue(raw);
  };

  const controlProps = { disabled, 'aria-invalid': invalid, 'aria-describedby': describedBy };
  const valueControl = (() => {
    switch (spec.kind) {
      case 'integer':
        return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" inputMode="numeric" value={value} variant="secondary" onChange={(event) => setValue(event.target.value)} />;
      case 'decimal':
      case 'float':
        return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" inputMode="decimal" value={value} variant="secondary" onChange={(event) => setValue(event.target.value)} />;
      case 'boolean': {
        if (!booleanUsesSelect) {
          return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" inputMode="numeric" value={value} variant="secondary" onChange={(event) => setValue(event.target.value)} />;
        }
        return (
          <Select aria-label={valueLabel} aria-describedby={describedBy} aria-invalid={invalid} autoFocus className="database-cell-editor__control database-cell-editor__select" fullWidth id={valueId} isDisabled={disabled} selectedKey={value === '' ? null : value} variant="secondary" onSelectionChange={(key) => {
            if (key !== null) setValue(String(key));
          }}>
            <Select.Trigger><Select.Value>{value === '' ? t('请选择 0 或 1') : undefined}</Select.Value><Select.Indicator /></Select.Trigger>
            <Select.Popover className="database-cell-editor__select-popover"><ListBox><ListBox.Item id="0">{t('0（否）')}</ListBox.Item><ListBox.Item id="1">{t('1（是）')}</ListBox.Item></ListBox></Select.Popover>
          </Select>
        );
      }
      case 'enum': {
        if (!enumUsesSelect) {
          return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" value={value} variant="secondary" onChange={(event) => setValue(event.target.value)} />;
        }
        const selectedIndex = spec.values.findIndex((option) => option === value);
        return (
          <Select aria-label={valueLabel} aria-describedby={describedBy} aria-invalid={invalid} autoFocus className="database-cell-editor__control database-cell-editor__select" fullWidth id={valueId} isDisabled={disabled} selectedKey={selectedIndex === -1 ? null : `enum-${selectedIndex}`} variant="secondary" onSelectionChange={(key) => {
            const index = /^enum-(\d+)$/.exec(String(key))?.[1];
            if (index !== undefined) setValue(spec.values[Number(index)]!);
          }}>
            <Select.Trigger><Select.Value>{selectedIndex === -1 ? t('请选择枚举值') : undefined}</Select.Value><Select.Indicator /></Select.Trigger>
            <Select.Popover className="database-cell-editor__select-popover"><ListBox>{spec.values.map((option, index) => <ListBox.Item key={`enum-${index}`} id={`enum-${index}`}>{option === '' ? t('（空字符串）') : option}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
        );
      }
      case 'set': {
        const selected = setChoices(spec.values, value);
        if (selected === null) {
          return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" value={value} variant="secondary" onChange={(event) => setValue(event.target.value)} />;
        }
        return (
          <fieldset className="database-cell-editor__set" aria-describedby={describedBy} aria-invalid={invalid}>
            <legend>{t('选择成员')}</legend>
            <div className="database-cell-editor__set-options">
              {spec.values.map((option, index) => (
                <Checkbox
                  key={`set-${index}`}
                  aria-label={option === '' ? t('（空字符串）') : option}
                  className="database-cell-editor__set-option"
                  id={`${valueId}-set-${index}`}
                  isDisabled={disabled}
                  isSelected={selected.includes(option)}
                  variant="secondary"
                  onChange={(isSelected) => {
                    const next = isSelected
                      ? spec.values.filter((item) => selected.includes(item) || item === option)
                      : spec.values.filter((item) => selected.includes(item) && item !== option);
                    setValue(next.join(','));
                  }}
                >
                  <Checkbox.Content>
                    <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                    <Label>{option === '' ? t('（空字符串）') : option}</Label>
                  </Checkbox.Content>
                </Checkbox>
              ))}
            </div>
          </fieldset>
        );
      }
      case 'json':
        return <TextArea {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth value={value} placeholder={'{"key": "value"}'} variant="secondary" onChange={(event) => setValue(event.target.value)} />;
      case 'text': {
        const multiline = spec.multiline || value.includes('\n') || value.includes('\r');
        return multiline
          ? <TextArea {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth value={value} variant="secondary" onChange={(event) => setValue(event.target.value)} />
          : <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" value={value} variant="secondary" onChange={(event) => setValue(event.target.value)} />;
      }
      case 'date':
        if (!dateDraft.structured || (dateDraft.date !== '' && validateMysqlValue(dateOnlySpec, dateDraft.date) !== null)) {
          return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" value={value} placeholder="YYYY-MM-DD" variant="secondary" onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            setDateDraft(createDateDraft(next));
          }} />;
        }
        return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="date" value={dateDraft.date} variant="secondary" onChange={(event) => changeDate(event.target.value)} />;
      case 'datetime':
        if (!dateTimeDraft.structured || (dateTimeDraft.date !== '' && validateMysqlValue(dateOnlySpec, dateTimeDraft.date) !== null)) {
          return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" value={value} placeholder="YYYY-MM-DD HH:MM:SS.ffffff" variant="secondary" onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            setDateTimeDraft(createDateTimeDraft(next));
          }} />;
        }
        return (
          <div className="database-cell-editor__datetime-fields">
            <div>
              <label htmlFor={`${valueId}-date`}>{t('日期')}</label>
              <Input {...controlProps} id={`${valueId}-date`} autoFocus className="database-cell-editor__control" fullWidth type="date" value={dateTimeDraft.date} variant="secondary" onChange={(event) => changeDateTimeDate(event.target.value)} />
            </div>
            <div>
              <label htmlFor={`${valueId}-time`}>{t('时间和秒的小数部分')}</label>
              <Input {...controlProps} id={`${valueId}-time`} className="database-cell-editor__control" fullWidth type="text" inputMode="numeric" value={dateTimeDraft.time} placeholder="HH:MM:SS.ffffff" variant="secondary" onChange={(event) => changeDateTimeTime(event.target.value)} />
            </div>
          </div>
        );
      case 'time':
        return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" inputMode="text" value={value} placeholder="[-]HH:MM:SS.ffffff" variant="secondary" onChange={(event) => setValue(event.target.value)} />;
      case 'year':
        return <Input {...controlProps} id={valueId} autoFocus className="database-cell-editor__control" fullWidth type="text" inputMode="numeric" pattern="[0-9]{4}" value={value} placeholder="YYYY" variant="secondary" onChange={(event) => setValue(event.target.value)} />;
      case 'unsupported':
        return <TextArea {...controlProps} id={valueId} className="database-cell-editor__control" fullWidth readOnly value={value} aria-label={t('不支持的原始值')} variant="secondary" />;
      default:
        return null;
    }
  })();

  return (
    <form
      className="db-cell-editor database-cell-editor"
      noValidate
      onSubmit={save}
      onKeyDown={preventImeSubmit}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
    >
      <div className="database-cell-editor__mode">
        <Select aria-describedby={describedBy} aria-invalid={invalid} autoFocus={mode !== 'value'} className="database-cell-editor__control database-cell-editor__select" fullWidth id={modeId} isDisabled={disabled} selectedKey={mode} variant="secondary" onSelectionChange={(key) => {
          if (key !== null) setMode(String(key) as EditorMode);
        }}>
          <Label>{t('写入方式')}</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover className="database-cell-editor__select-popover"><ListBox>{allowOmit && <ListBox.Item id="omit">{t('未设置（省略列）')}</ListBox.Item>}<ListBox.Item id="value">{t('明确值（空内容是空字符串）')}</ListBox.Item>{column.nullable && <ListBox.Item id="null">NULL</ListBox.Item>}{column.hasDefault && <ListBox.Item id="default">DEFAULT</ListBox.Item>}</ListBox></Select.Popover>
        </Select>
      </div>

      {mode === 'value' && (
        <div className="database-cell-editor__value">
          {(spec.kind === 'datetime' || spec.kind === 'set' || valueUsesSelect)
            ? <span>{valueLabel}</span>
            : <label htmlFor={valueId}>{valueLabel}</label>}
          {valueControl}
          {spec.kind === 'json' && <small className="database-cell-editor__json-note">{t('必须是有效 JSON；保存前不会格式化或改写文本。')}</small>}
        </div>
      )}

      {hint && <small id={hintId} className="database-cell-editor__hint">{hint}</small>}
      {error && <p id={errorId} className="database-cell-editor__error" role="alert">{error}</p>}

      <div className="database-cell-editor__actions">
        <Button className="app-action button-quiet" isDisabled={disabled || (allowOmit && mode === 'omit')} type="button" variant="tertiary" onPress={onRevert}>{t(allowOmit ? '移除此值' : '撤销本格')}</Button>
        <Button className="app-action button-quiet" isDisabled={disabled} type="button" variant="tertiary" onPress={onCancel}>{t('取消')}</Button>
        <Button className="app-action button-primary" isDisabled={disabled} type="submit" variant="primary">{t('保留草稿')}</Button>
      </div>
    </form>
  );
}
