import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button, Input, ListBox, Modal, Select } from '@heroui/react';
import Editor from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Folder,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Square,
  Table2,
  Trash2,
  X
} from 'lucide-react';
import { z } from 'zod';
import type {
  ApplyResult,
  DbCell,
  DbNode,
  DbWriteValue,
  DesktopBridge,
  Preferences,
  Preview,
  QueryResult,
  SessionInfo,
  TableChanges
} from '@shared/index';
import { validateDbWriteValue } from '@shared/mysql-values';
import DatabaseCellEditor from './DatabaseCellEditor';
import { formatDateTime, t as translate, translateDiagnostic, useI18n } from '../i18n';
import { triggerMonacoShortcut } from '../monaco-shortcuts';
import { useShortcutScope, shortcutLabel } from '../shortcuts';
import { useTheme } from '../themes';
import './DatabasePane.css';

const initialSql = '';

const dbCellSchema = z.union([z.string(), z.boolean(), z.null()]);
const dbColumnSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  primaryKey: z.boolean().optional(),
  editable: z.boolean().optional(),
  insertable: z.boolean().optional(),
  nullable: z.boolean().optional(),
  hasDefault: z.boolean().optional(),
  generated: z.boolean().optional(),
  autoIncrement: z.boolean().optional()
}).strict();
const dbNodeSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['database', 'schema', 'table', 'view', 'column', 'other']),
  leaf: z.boolean(),
  schema: z.string().optional(),
  table: z.string().optional()
}).strict();
const queryResultSchema = z.object({
  columns: z.array(dbColumnSchema),
  rows: z.array(z.array(dbCellSchema)),
  message: z.string(),
  elapsedMs: z.number().finite().nonnegative(),
  truncated: z.boolean(),
  editable: z.boolean(),
  insertable: z.boolean().optional(),
  readonlyReason: z.string().optional(),
  snapshotId: z.string().min(1).optional()
}).strict();
const previewSchema = z.object({
  id: z.string().min(1),
  sql: z.array(z.string()),
  expiresAt: z.number().finite(),
  schema: z.string().min(1),
  table: z.string().min(1),
  mode: z.literal('sequential'),
  counts: z.object({
    updates: z.number().int().nonnegative(),
    inserts: z.number().int().nonnegative(),
    deletes: z.number().int().nonnegative()
  }).strict(),
  warnings: z.array(z.string())
}).strict();
const applyResultSchema = z.object({
  outcome: z.enum(['committed', 'partial', 'not-started', 'unknown']),
  applied: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  failedIndex: z.number().int().nonnegative().optional(),
  failure: z.enum(['conflict', 'rejected']).optional(),
  message: z.string()
}).strict();
const dbNodesSchema = z.array(dbNodeSchema);

export interface DatabasePaneProps {
  session: SessionInfo;
  preferences: Preferences;
  onDirtyChange?: (dirty: boolean) => void;
  onReconnect?: () => void;
  reconnecting?: boolean;
}

interface TableSearch {
  text: string;
  column?: string;
}

interface TableResult {
  schema: string;
  table: string;
  page: number;
  limit: 50 | 100 | 200 | 500;
  search?: TableSearch;
}

interface DisplayResult {
  value: QueryResult;
  source: 'query' | 'table';
  table?: TableResult;
}

interface CellEditor {
  target: 'update' | 'insert';
  rowIndex: number;
  column: string;
  initialValue: DbWriteValue | undefined;
}

interface DraftUpdate {
  rowIndex: number;
  row: Record<string, DbCell>;
  values: Record<string, DbWriteValue>;
}

interface DraftDelete {
  rowIndex: number;
  row: Record<string, DbCell>;
}

interface TableDraft {
  updates: DraftUpdate[];
  inserts: Array<Record<string, DbWriteValue>>;
  deletes: DraftDelete[];
}

interface ApplyReport {
  preview: Preview;
  result: ApplyResult;
  refresh: 'pending' | 'refreshed' | 'failed' | 'not-needed';
}
type DraftDiscardAction =
  | { kind: 'execute'; selectionOnly: boolean }
  | { kind: 'table'; node: DbNode; page: number; limit: 50 | 100 | 200 | 500; search?: TableSearch }
  | { kind: 'clear' }
  | { kind: 'refresh' }
  | { kind: 'reload' };



function bridge(): DesktopBridge {
  if (!window.desktop) throw new Error(translate('桌面桥接尚未就绪。'));
  return window.desktop;
}

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
}

function newDraft(): TableDraft {
  return { updates: [], inserts: [], deletes: [] };
}

function isDefaultValue(value: DbWriteValue): value is { kind: 'default' } {
  return typeof value === 'object' && value !== null && value.kind === 'default';
}

function hasOwnValue(values: Record<string, DbWriteValue>, column: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, column);
}

function valueText(value: DbWriteValue): string {
  if (isDefaultValue(value)) return 'DEFAULT';
  if (value === null) return 'NULL';
  return typeof value === 'boolean' ? String(value) : value;
}

function displayValueText(value: DbWriteValue | undefined, unsetText: string, emptyStringText: string): string {
  if (value === undefined) return unsetText;
  const text = valueText(value);
  return text === '' ? emptyStringText : text;
}

function writeValueMatchesOriginal(value: DbWriteValue, original: DbCell): boolean {
  return !isDefaultValue(value) && value === original;
}

function tableChanges(table: TableResult | undefined, result: QueryResult | undefined, draft: TableDraft): TableChanges | null {
  if (!table || !result?.snapshotId) return null;
  return {
    schema: table.schema,
    table: table.table,
    snapshotId: result.snapshotId,
    updates: draft.updates.map(({ row, values }) => ({ row, values })),
    inserts: draft.inserts,
    deletes: draft.deletes.map(({ row }) => row)
  };
}

type ReviewedPreview = Preview & { reviewedChanges: TableChanges; reviewedSearch?: TableSearch };

function freezePreview(preview: Preview, changes: TableChanges, search?: TableSearch): ReviewedPreview {
  const reviewedChanges = Object.freeze({
    ...changes,
    updates: Object.freeze(changes.updates.map(({ row, values }) => Object.freeze({
      row: Object.freeze({ ...row }),
      values: Object.freeze(Object.fromEntries(Object.entries(values).map(([column, value]) => [
        column,
        isDefaultValue(value) ? Object.freeze({ ...value }) : value
      ])))
    }))),
    inserts: Object.freeze(changes.inserts.map((values) => Object.freeze(Object.fromEntries(Object.entries(values).map(([column, value]) => [
      column,
      isDefaultValue(value) ? Object.freeze({ ...value }) : value
    ]))))),
    deletes: Object.freeze(changes.deletes.map((row) => Object.freeze({ ...row })))
  }) as unknown as TableChanges;
  return Object.freeze({
    ...preview,
    sql: Object.freeze([...preview.sql]) as unknown as string[],
    counts: Object.freeze({ ...preview.counts }),
    warnings: Object.freeze([...preview.warnings]) as unknown as string[],
    ...(search ? { reviewedSearch: Object.freeze({ ...search }) as TableSearch } : {}),
    reviewedChanges
  }) as ReviewedPreview;
}

function nodeIcon(node: DbNode): ReactNode {
  switch (node.kind) {
    case 'database':
      return <Database size={15} />;
    case 'table':
    case 'view':
      return <Table2 size={15} />;
    case 'column':
      return <PanelLeftClose size={14} />;
    default:
      return <Folder size={14} />;
  }
}

interface DatabaseResultRowProps {
  row: DbCell[];
  rowIndex: number;
  columns: QueryResult['columns'];
  values: Record<string, DbWriteValue> | undefined;
  deleted: boolean;
  hasActions: boolean;
  canUpdateOrDelete: boolean;
  disabled: boolean;
  editor: CellEditor | null;
  expandedCells: ReadonlySet<string>;
  onEdit: (target: CellEditor['target'], rowIndex: number, column: string, value?: DbWriteValue) => void;
  onUpdate: (rowIndex: number, column: string, value: DbWriteValue) => void;
  onDelete: (rowIndex: number) => void;
  onCancel: () => void;
  onExpand: (cellKey: string) => void;
  onCopy: (text: string, confirmation: string) => Promise<void>;
}

// Unrelated toolbar/sheet state must not re-render thousands of cell controls.
const DatabaseResultRow = memo(function DatabaseResultRow({
  row, rowIndex, columns, values, deleted, hasActions, canUpdateOrDelete,
  disabled, editor, expandedCells, onEdit, onUpdate, onDelete, onCancel, onExpand, onCopy
}: DatabaseResultRowProps) {
  const { t } = useI18n();
  const [hoveredColumn, setHoveredColumn] = useState<string | null>(null);
  const [focusedColumn, setFocusedColumn] = useState<string | null>(null);
  return (
    <tr className={deleted ? 'db-row-deleted' : ''}>
      {hasActions && (
        <td className="db-grid-actions">
          {canUpdateOrDelete && <button aria-label={deleted ? t('撤销删除草稿') : t('将此行加入删除草稿（不会执行 SQL）')} disabled={disabled} type="button" onClick={() => onDelete(rowIndex)} title={deleted ? t('撤销删除草稿') : t('将此行加入删除草稿（不会执行 SQL）')}>
            {deleted ? <RotateCcw size={14} /> : <Trash2 size={14} />}
          </button>}
        </td>
      )}
      {columns.map((column, columnIndex) => {
        const original = row[columnIndex] ?? null;
        const value = values && hasOwnValue(values, column.name) ? values[column.name]! : original;
        const cellKey = `${rowIndex}:${column.name}`;
        const isExpanded = expandedCells.has(cellKey);
        const isEditing = editor?.column === column.name;
        const editable = canUpdateOrDelete && column.editable && !column.primaryKey && !column.generated && !column.autoIncrement && !deleted;
        const long = typeof value === 'string' && value.length > 140;
        const showActions = hoveredColumn === column.name || focusedColumn === column.name;
        return (
          <td key={column.name} className={`${value === null ? 'db-null-cell' : ''}${isDefaultValue(value) ? ' db-default-cell' : ''}`}>
            {isEditing && editor !== null ? (
              <DatabaseCellEditor
                key={`update:${rowIndex}:${column.name}`}
                column={column}
                initialValue={editor.initialValue}
                allowOmit={false}
                disabled={disabled}
                onSave={(nextValue) => { if (nextValue !== undefined) onUpdate(rowIndex, column.name, nextValue); }}
                onCancel={onCancel}
                onRevert={() => onUpdate(rowIndex, column.name, original)}
              />
            ) : (
              <div
                className={`db-cell ${isExpanded ? 'db-cell-expanded' : ''}`}
                tabIndex={editable ? undefined : 0}
                onMouseEnter={() => setHoveredColumn(column.name)}
                onMouseLeave={() => setHoveredColumn(null)}
                onFocusCapture={() => setFocusedColumn(column.name)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedColumn(null);
                }}
              >
                {editable
                  ? <button className="db-cell-value db-cell-value-editable" type="button" disabled={disabled} onDoubleClick={() => onEdit('update', rowIndex, column.name, value)} title={t('双击编辑本地变更草稿；不会执行 SQL')}>{displayValueText(value, t('未设置'), t('空字符串'))}</button>
                  : <span className="db-cell-value">{displayValueText(value, t('未设置'), t('空字符串'))}</span>}
                {long && <button className="db-cell-expand" type="button" onClick={() => onExpand(cellKey)}>{isExpanded ? t('收起') : t('展开')}</button>}
                <span className={`db-cell-actions${editable ? ' db-cell-actions-editable' : ''}`}>
                  {showActions && <>
                    {editable && <button className="db-cell-draft" aria-label={t('编辑 {{column}}', { column: column.name })} disabled={disabled} type="button" onClick={() => onEdit('update', rowIndex, column.name, value)} title={t('双击编辑本地变更草稿；不会执行 SQL')}><Pencil size={13} /></button>}
                    <button className="db-cell-copy" aria-label={t('复制 {{column}} 的精确值', { column: column.name })} type="button" onClick={() => void onCopy(valueText(value), t('已复制精确单元格值。'))} title={t('复制精确值')}><Copy size={13} /></button>
                  </>}
                </span>
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
});

export default function DatabasePane({ session, preferences, onDirtyChange, onReconnect, reconnecting = false }: DatabasePaneProps) {
  const { t } = useI18n();
  const theme = useTheme(preferences.theme);
  const sessionKey = `${session.id}:${session.generation}`;
  const pane = useRef<HTMLElement | null>(null);
  const sqlEditorScope = useRef<HTMLDivElement | null>(null);
  const resultsScope = useRef<HTMLElement | null>(null);
  const draftScope = useRef<HTMLElement | null>(null);
  const sidebarDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const editorDrag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(230);
  const [editorHeight, setEditorHeight] = useState(260);
  const [paneWidth, setPaneWidth] = useState(0);
  const [paneHeight, setPaneHeight] = useState(0);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [resizingEditor, setResizingEditor] = useState(false);
  const sidebarMin = 150;
  const sidebarMax = paneWidth > 0 ? Math.max(sidebarMin, Math.min(520, Math.floor(paneWidth / 2))) : 520;
  const visibleSidebarWidth = Math.min(sidebarWidth, sidebarMax);
  const editorMin = 150;
  const resultsMin = 150;
  const editorMax = paneHeight > 0 ? Math.max(editorMin, Math.min(720, paneHeight - resultsMin - 82)) : 720;
  const visibleEditorHeight = Math.max(editorMin, Math.min(editorHeight, editorMax));
  const defaultPageSize = preferences.databasePageSize;

  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    const resize = () => {
      setPaneWidth(element.clientWidth);
      setPaneHeight(element.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, []);

  const editor = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const saveButton = useRef<HTMLButtonElement | null>(null);
  const sheetDialog = useRef<HTMLDivElement | null>(null);
  const sheetClose = useRef<HTMLButtonElement | null>(null);
  const treeRequestEpochs = useRef(new Map<string, number>());
  const treeSessionEpoch = useRef(0);
  const currentSession = useRef(sessionKey);
  const activeDataOperation = useRef<number | null>(null);
  const dataOperationSequence = useRef(0);
  const previewEpoch = useRef(0);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const reportedDirtyRef = useRef<boolean | null>(null);
  const dirtySessionRef = useRef(sessionKey);
  const sessionPhaseRef = useRef<{ key: string; phase: SessionInfo['phase'] } | null>(null);
  const pendingApplyRef = useRef<{ operation: number; sessionKey: string; preview: Preview; result?: ApplyResult } | null>(null);
  const sessionChanged = dirtySessionRef.current !== sessionKey;
  currentSession.current = session.phase === 'active' ? sessionKey : `${sessionKey}:${session.phase}`;
  if (sessionChanged) {
    dirtySessionRef.current = sessionKey;
  }
  const [tree, setTree] = useState<DbNode[]>([]);
  const [children, setChildren] = useState<Record<string, DbNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeLoadingKeys, setTreeLoadingKeys] = useState<Set<string>>(() => new Set());
  const [sql, setSql] = useState(initialSql);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<ReviewedPreview | null>(null);
  const [previewClock, setPreviewClock] = useState(Date.now());
  const [applyReport, setApplyReport] = useState<ApplyReport | null>(null);
  const [baselineAcknowledged, setBaselineAcknowledged] = useState(false);
  const [writeFrozen, setWriteFrozen] = useState(false);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expandedCells, setExpandedCells] = useState<Set<string>>(() => new Set());
  const [cellEditor, setCellEditor] = useState<CellEditor | null>(null);
  const [draft, setDraft] = useState<TableDraft>(newDraft);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [discardAction, setDiscardAction] = useState<DraftDiscardAction | null>(null);
  const [tableSearchText, setTableSearchText] = useState('');
  const [tableSearchColumn, setTableSearchColumn] = useState('');

  const invalidatePreview = useCallback(() => {
    previewEpoch.current += 1;
    setPreview(null);
  }, []);

  useEffect(() => {
    if (reportedDirtyRef.current === true) {
      onDirtyChangeRef.current?.(false);
    }
    reportedDirtyRef.current = null;
  }, [sessionKey]);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  const canUseDatabase = session.phase === 'active';
  const activeTable = result?.source === 'table' ? result.table : undefined;
  const activeTableResult = result?.source === 'table' ? result.value : undefined;
  const sqlCrudSupported = session.capabilities.sqlCrud?.state === 'supported';
  const canUpdateOrDelete = Boolean(sqlCrudSupported && activeTable && activeTableResult?.snapshotId && activeTableResult.editable);
  const canInsert = Boolean(sqlCrudSupported && activeTable && activeTableResult?.snapshotId && activeTableResult.insertable);
  const dataBusy = running || previewing || applying;
  const requiresBaseline = Boolean(
    applyReport
      && !baselineAcknowledged
      && (applyReport.result.outcome === 'partial' || applyReport.result.outcome === 'not-started')
  );
  const changes = useMemo(() => tableChanges(activeTable, activeTableResult, draft), [activeTable, activeTableResult, draft]);
  const draftCount = draft.updates.length + draft.inserts.length + draft.deletes.length;
  const tableDraftDirty = draftCount > 0 || cellEditor !== null || previewing || applying || writeFrozen || requiresBaseline;
  const databaseDirty = !sessionChanged && (sql !== initialSql || tableDraftDirty || running);
  const previewExpired = preview !== null && preview.expiresAt <= previewClock;
  const sheetContentAvailable = preview !== null || applyReport !== null;
  const sheetVisible = sheetOpen && sheetContentAvailable;

  useEffect(() => {
    if (!preview) return;
    const timeout = window.setTimeout(() => setPreviewClock(Date.now()), Math.max(0, preview.expiresAt - Date.now()) + 1);
    return () => window.clearTimeout(timeout);
  }, [preview]);

  useEffect(() => {
    if (!sheetVisible) return;
    const dialog = sheetDialog.current;
    const frame = window.requestAnimationFrame(() => sheetClose.current?.focus({ preventScroll: true }));
    return () => {
      window.cancelAnimationFrame(frame);
      if (document.activeElement === document.body || dialog?.contains(document.activeElement)) {
        saveButton.current?.focus({ preventScroll: true });
      }
    };
  }, [applyReport, preview, sheetVisible]);
  const closeSheet = () => {
    if (applying) return;
    setSheetOpen(false);
    setSheetExpanded(false);
  };

  useEffect(() => {
    if (reportedDirtyRef.current === databaseDirty) {
      return;
    }
    reportedDirtyRef.current = databaseDirty;
    onDirtyChangeRef.current?.(databaseDirty);
  }, [databaseDirty, sessionKey]);

  useEffect(() => () => {
    reportedDirtyRef.current = null;
    onDirtyChangeRef.current?.(false);
  }, []);

  const loadTree = useCallback(async (key?: string) => {
    if (session.phase !== 'active') return;
    const requestSession = currentSession.current;
    const sessionEpoch = treeSessionEpoch.current;
    const requestKey = key === undefined ? 'roots' : `node:${key}`;
    const request = (treeRequestEpochs.current.get(requestKey) || 0) + 1;
    treeRequestEpochs.current.set(requestKey, request);
    const isCurrentRequest = () => treeSessionEpoch.current === sessionEpoch
      && currentSession.current === requestSession
      && treeRequestEpochs.current.get(requestKey) === request;
    if (key === undefined) setTreeLoading(true);
    else setTreeLoadingKeys((current) => new Set(current).add(key));
    setError('');
    try {
      const payload = key === undefined
        ? await bridge().invoke('db.tree', { sessionId: session.id })
        : await bridge().invoke('db.tree', { sessionId: session.id, key });
      const nodes = dbNodesSchema.parse(payload);
      if (!isCurrentRequest()) return;
      if (key === undefined) setTree(nodes);
      else setChildren((current) => ({ ...current, [key]: nodes }));
    } catch (cause) {
      if (isCurrentRequest()) {
        setError(errorText(cause, translate('无法加载 Chen 元数据树。')));
      }
    } finally {
      if (isCurrentRequest()) {
        if (key === undefined) setTreeLoading(false);
        else setTreeLoadingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }, [session.generation, session.id, session.phase]);

  useEffect(() => {
    treeSessionEpoch.current += 1;
    treeRequestEpochs.current.clear();
    activeDataOperation.current = null;
    pendingApplyRef.current = null;
    previewEpoch.current += 1;
    setTree([]);
    setTreeLoading(false);
    setTreeLoadingKeys(new Set());
    setChildren({});
    setExpanded(new Set());
    setSql(initialSql);
    setRunning(false);
    setCancelling(false);
    setPreviewing(false);
    setApplying(false);
    setPreview(null);
    setApplyReport(null);
    setBaselineAcknowledged(false);
    setWriteFrozen(false);
    setResult(null);
    setDraft(newDraft());
    setCellEditor(null);
    setExpandedCells(new Set());
    setSheetOpen(false);
    setSheetExpanded(false);
    setDiscardAction(null);
    setTableSearchText('');
    setTableSearchColumn('');
    setError('');
    setNotice('');
  }, [sessionKey]);

  useEffect(() => {
    const previous = sessionPhaseRef.current;
    sessionPhaseRef.current = { key: sessionKey, phase: session.phase };
    const leftActive = previous !== null
      && previous.key === sessionKey
      && previous.phase === 'active'
      && session.phase !== 'active';
    if (leftActive) {
      treeSessionEpoch.current += 1;
      treeRequestEpochs.current.clear();
      const pendingOperation = activeDataOperation.current !== null;
      const pendingApply = pendingApplyRef.current?.sessionKey === sessionKey ? pendingApplyRef.current : null;
      dataOperationSequence.current += 1;
      activeDataOperation.current = null;
      pendingApplyRef.current = null;
      previewEpoch.current += 1;
      setTreeLoading(false);
      setTreeLoadingKeys(new Set());
      setRunning(false);
      setCancelling(false);
      setPreviewing(false);
      setApplying(false);
      setPreview(null);
      setNotice('');
      if (pendingApply?.result) {
        setApplyReport({ preview: pendingApply.preview, result: pendingApply.result, refresh: 'failed' });
        setError(translate('变更已确认提交，但 Chen 会话在重新读取表前断开。不会回滚或自动重试。'));
      } else if (pendingApply) {
        const message = session.error || translate('Chen 会话在提交期间不可用。');
        setApplyReport({
          preview: pendingApply.preview,
          result: { outcome: 'unknown', applied: 0, total: pendingApply.preview.sql.length, message },
          refresh: 'not-needed'
        });
        setWriteFrozen(true);
        setError(translate('无法确认提交终态：{{message}} 本会话表格写入已冻结；请重新连接并核验，绝不重复提交。', { message }));
      } else if (pendingOperation) {
        setError(session.error || translate('Chen 会话已不可用，正在进行的操作已停止等待；不会自动重试。'));
      }
    }
    if (session.phase === 'active') {
      void loadTree();
    }
  }, [loadTree, session.error, session.phase, sessionKey]);

  const toggleNode = useCallback((node: DbNode) => {
    if (node.leaf) return;
    const opening = !expanded.has(node.key);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node.key)) {
        next.delete(node.key);
      } else {
        next.add(node.key);
      }
      return next;
    });
    if (opening && !children[node.key] && !treeLoadingKeys.has(node.key)) {
      void loadTree(node.key);
    }
  }, [children, expanded, loadTree, treeLoadingKeys]);

  const execute = useCallback(async (selectionOnly: boolean) => {
    if (!canUseDatabase || dataBusy || activeDataOperation.current !== null) {
      return;
    }
    const currentEditor = editor.current;
    const selection = currentEditor?.getSelection();
    const selectedSql = selection && currentEditor?.getModel()
      ? currentEditor.getModel()?.getValueInRange(selection) || ''
      : '';
    const statement = selectionOnly && selectedSql.trim() ? selectedSql : sql;
    if (!statement.trim()) {
      setError(translate('请输入 SQL，或在编辑器中选中一段 SQL。'));
      return;
    }
    invalidatePreview();
    const requestSession = currentSession.current;
    const operation = dataOperationSequence.current + 1;
    dataOperationSequence.current = operation;
    activeDataOperation.current = operation;
    setRunning(true);
    setCancelling(false);
    setError('');
    setNotice(translate('正在等待 Chen 的执行终态…'));
    try {
      const payload = await bridge().invoke('db.query', { sessionId: session.id, sql: statement });
      const parsed = queryResultSchema.parse(payload);
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      setResult({ value: parsed, source: 'query' });
      if (!writeFrozen) {
        setDraft(newDraft());
        setCellEditor(null);
        setApplyReport(null);
        setBaselineAcknowledged(false);
      }
      setExpandedCells(new Set());
      setNotice(parsed.message);
    } catch (cause) {
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      const text = errorText(cause, translate('Chen 未返回查询结果。'));
      if (text.includes('取消')) {
        setNotice(text);
      } else {
        setNotice('');
        setError(text);
      }
    } finally {
      if (currentSession.current === requestSession && activeDataOperation.current === operation) {
        activeDataOperation.current = null;
        setRunning(false);
        setCancelling(false);
      }
    }
  }, [canUseDatabase, dataBusy, invalidatePreview, session.id, sql, writeFrozen]);

  const cancelQuery = useCallback(async () => {
    if (!running || cancelling || activeDataOperation.current === null) {
      return;
    }
    const requestSession = currentSession.current;
    const operation = activeDataOperation.current;
    if (operation === null) {
      return;
    }
    setCancelling(true);
    setNotice(translate('正在请求 Chen 取消查询；等待服务器确认…'));
    try {
      await bridge().invoke('db.cancel', { sessionId: session.id });
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      setNotice(translate('Chen 已确认取消请求。'));
    } catch (cause) {
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      setNotice('');
      setError(errorText(cause, translate('Chen 未确认取消请求。')));
    } finally {
      if (currentSession.current === requestSession && activeDataOperation.current === operation) {
        setCancelling(false);
      }
    }
  }, [cancelling, running, session.id]);

  const openTable = useCallback(async (
    node: DbNode,
    page = 1,
    limit: 50 | 100 | 200 | 500 = defaultPageSize,
    search?: TableSearch,
    preserveReport = false
  ) => {
    if (!canUseDatabase || dataBusy || activeDataOperation.current !== null) {
      return;
    }
    if (!node.schema || !node.table) {
      setError(translate('该 Chen 节点没有可验证的架构和表上下文，不能打开表浏览。'));
      return;
    }
    invalidatePreview();
    const requestSession = currentSession.current;
    const operation = dataOperationSequence.current + 1;
    dataOperationSequence.current = operation;
    activeDataOperation.current = operation;
    setRunning(true);
    setCancelling(false);
    setError('');
    setNotice(translate('正在通过 Chen data_view 打开 {{schema}}.{{table}}…', { schema: node.schema, table: node.table }));
    if (preserveReport) {
      setApplyReport((current) => current?.result.outcome === 'committed'
        ? { ...current, refresh: 'pending' }
        : current);
    }
    try {
      const payload = await bridge().invoke('db.table', {
        sessionId: session.id,
        schema: node.schema,
        table: node.table,
        page,
        limit,
        ...(search ? { search } : {})
      });
      const parsed = queryResultSchema.parse(payload);
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      const table: TableResult = { schema: node.schema, table: node.table, page, limit, search };
      setResult({ value: parsed, source: 'table', table });
      setTableSearchText(search?.text || '');
      setTableSearchColumn(search?.column || '');
      if (!writeFrozen) {
        setDraft(newDraft());
        setCellEditor(null);
        if (preserveReport) {
          setBaselineAcknowledged(true);
          setApplyReport((current) => current?.result.outcome === 'committed'
            ? { ...current, refresh: 'refreshed' }
            : current);
        } else {
          setApplyReport(null);
          setBaselineAcknowledged(false);
        }
      }
      setNotice(parsed.message);
    } catch (cause) {
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      setNotice('');
      if (preserveReport) {
        setApplyReport((current) => current?.result.outcome === 'committed'
          ? { ...current, refresh: 'failed' }
          : current);
      }
      setError(errorText(cause, translate('无法通过 Chen 打开表浏览。')));
    } finally {
      if (currentSession.current === requestSession && activeDataOperation.current === operation) {
        activeDataOperation.current = null;
        setRunning(false);
        setCancelling(false);
      }
    }
  }, [canUseDatabase, dataBusy, defaultPageSize, invalidatePreview, session.id, writeFrozen]);

  const requestExecute = useCallback((selectionOnly: boolean) => {
    if (!canUseDatabase || dataBusy || activeDataOperation.current !== null) {
      return;
    }
    if (tableDraftDirty && !writeFrozen) {
      setDiscardAction({ kind: 'execute', selectionOnly });
      return;
    }
    void execute(selectionOnly);
  }, [canUseDatabase, dataBusy, execute, tableDraftDirty, writeFrozen]);

  const requestOpenTable = useCallback((
    node: DbNode,
    page = 1,
    limit: 50 | 100 | 200 | 500 = defaultPageSize,
    search?: TableSearch
  ) => {
    if (!canUseDatabase || dataBusy || activeDataOperation.current !== null) {
      return;
    }
    if (tableDraftDirty && !writeFrozen) {
      setDiscardAction({ kind: 'table', node, page, limit, search });
      return;
    }
    const preserveReport = Boolean(
      applyReport
      && activeTable
      && activeTable.schema === node.schema
      && activeTable.table === node.table
    );
    void openTable(node, page, limit, search, preserveReport);
  }, [activeTable, applyReport, canUseDatabase, dataBusy, defaultPageSize, openTable, tableDraftDirty, writeFrozen]);

  const confirmDraftDiscard = () => {
    if (discardAction === null || dataBusy || activeDataOperation.current !== null) {
      return;
    }
    const action = discardAction;
    if ((action.kind === 'reload' || action.kind === 'refresh') && !activeTable) {
      return;
    }
    invalidatePreview();
    setDraft(newDraft());
    setCellEditor(null);
    setDiscardAction(null);
    if (action.kind === 'execute') {
      void execute(action.selectionOnly);
      return;
    }
    if (action.kind === 'table') {
      void openTable(action.node, action.page, action.limit, action.search);
      return;
    }
    if ((action.kind === 'reload' || action.kind === 'refresh') && activeTable) {
      void openTable(
        { key: '', name: activeTable.table, kind: 'table', leaf: true, schema: activeTable.schema, table: activeTable.table },
        activeTable.page,
        activeTable.limit,
        activeTable.search,
        action.kind === 'reload'
      );
    }
  };

  const requestTableRefresh = useCallback(() => {
    if (!activeTable || !canUseDatabase || dataBusy || activeDataOperation.current !== null) {
      return;
    }
    if (requiresBaseline) {
      setDiscardAction({ kind: 'reload' });
      return;
    }
    if (tableDraftDirty && !writeFrozen) {
      setDiscardAction({ kind: 'refresh' });
      return;
    }
    void openTable(
      { key: '', name: activeTable.table, kind: 'table', leaf: true, schema: activeTable.schema, table: activeTable.table },
      activeTable.page,
      activeTable.limit,
      activeTable.search,
      Boolean(applyReport)
    );
  }, [activeTable, applyReport, canUseDatabase, dataBusy, openTable, requiresBaseline, tableDraftDirty, writeFrozen]);

  const changePage = useCallback((page: number, limit = activeTable?.limit) => {
    if (!activeTable || !result) {
      return;
    }
    void requestOpenTable(
      { key: '', name: activeTable.table, kind: 'table', leaf: true, schema: activeTable.schema, table: activeTable.table },
      Math.max(1, page),
      limit || activeTable.limit,
      activeTable.search
    );
  }, [activeTable, requestOpenTable, result]);

  const applyTableSearch = useCallback(() => {
    if (!activeTable || !canUseDatabase || dataBusy || activeDataOperation.current !== null) {
      return;
    }
    const search = tableSearchText.length > 0
      ? { text: tableSearchText, ...(tableSearchColumn ? { column: tableSearchColumn } : {}) }
      : undefined;
    if (
      search?.text === activeTable.search?.text
      && search?.column === activeTable.search?.column
    ) {
      return;
    }
    void requestOpenTable(
      { key: '', name: activeTable.table, kind: 'table', leaf: true, schema: activeTable.schema, table: activeTable.table },
      1,
      activeTable.limit,
      search
    );
  }, [activeTable, canUseDatabase, dataBusy, requestOpenTable, tableSearchColumn, tableSearchText]);

  const clearTableSearch = useCallback(() => {
    setTableSearchText('');
    setTableSearchColumn('');
    if (!activeTable?.search) {
      return;
    }
    void requestOpenTable(
      { key: '', name: activeTable.table, kind: 'table', leaf: true, schema: activeTable.schema, table: activeTable.table },
      1,
      activeTable.limit
    );
  }, [activeTable, requestOpenTable]);

  const updateDraft = useCallback((rowIndex: number, column: string, value: DbWriteValue) => {
    if (dataBusy || activeDataOperation.current !== null || writeFrozen || requiresBaseline || !activeTable || !activeTableResult || !canUpdateOrDelete) {
      return;
    }
    const rowValues = activeTableResult.rows[rowIndex];
    if (!rowValues) {
      return;
    }
    const row = Object.fromEntries(activeTableResult.columns.map((item, index) => [item.name, rowValues[index] ?? null]));
    const original = row[column] ?? null;
    invalidatePreview();
    setApplyReport(null);
    setBaselineAcknowledged(false);
    setDraft((current) => {
      if (current.deletes.some((item) => item.rowIndex === rowIndex)) {
        return current;
      }
      const currentUpdate = current.updates.find((item) => item.rowIndex === rowIndex);
      if (currentUpdate) {
        const values = { ...currentUpdate.values };
        if (writeValueMatchesOriginal(value, original)) {
          delete values[column];
        } else {
          values[column] = value;
        }
        if (Object.keys(values).length === 0) {
          return { ...current, updates: current.updates.filter((item) => item.rowIndex !== rowIndex) };
        }
        return {
          ...current,
          updates: current.updates.map((item) => item.rowIndex === rowIndex
            ? { ...item, values }
            : item)
        };
      }
      if (writeValueMatchesOriginal(value, original)) {
        return current;
      }
      return { ...current, updates: [...current.updates, { rowIndex, row, values: { [column]: value } }] };
    });
    setCellEditor(null);
  }, [activeTable, activeTableResult, canUpdateOrDelete, dataBusy, invalidatePreview, requiresBaseline, writeFrozen]);

  const draftValuesByRow = useMemo(() => new Map(draft.updates.map((update) => [update.rowIndex, update.values])), [draft.updates]);
  const deletedRows = useMemo(() => new Set(draft.deletes.map((deleted) => deleted.rowIndex)), [draft.deletes]);
  const cancelCellEdit = useCallback(() => setCellEditor(null), []);
  const toggleExpandedCell = useCallback((cellKey: string) => {
    setExpandedCells((current) => {
      const next = new Set(current);
      if (next.has(cellKey)) next.delete(cellKey);
      else next.add(cellKey);
      return next;
    });
  }, []);

  const copyText = useCallback(async (text: string, confirmation: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(confirmation);
    } catch (cause) {
      setError(errorText(cause, translate('无法访问系统剪贴板。')));
    }
  }, []);

  const createInsertDraft = useCallback(() => {
    if (dataBusy || activeDataOperation.current !== null || writeFrozen || requiresBaseline || !canInsert) {
      return;
    }
    invalidatePreview();
    setApplyReport(null);
    setBaselineAcknowledged(false);
    setDraft((current) => ({ ...current, inserts: [...current.inserts, {}] }));
  }, [canInsert, dataBusy, invalidatePreview, requiresBaseline, writeFrozen]);

  const updateInsertDraft = useCallback((insertIndex: number, column: string, value: DbWriteValue | undefined) => {
    if (dataBusy || activeDataOperation.current !== null || writeFrozen || requiresBaseline || !canInsert) {
      return;
    }
    invalidatePreview();
    setApplyReport(null);
    setBaselineAcknowledged(false);
    setDraft((current) => {
      const insert = current.inserts[insertIndex];
      if (!insert) {
        return current;
      }
      const values = { ...insert };
      if (value === undefined) {
        delete values[column];
      } else {
        values[column] = value;
      }
      return {
        ...current,
        inserts: current.inserts.map((item, index) => index === insertIndex ? values : item)
      };
    });
    setCellEditor(null);
  }, [canInsert, dataBusy, invalidatePreview, requiresBaseline, writeFrozen]);

  const removeInsertDraft = useCallback((insertIndex: number) => {
    if (dataBusy || activeDataOperation.current !== null || writeFrozen || requiresBaseline || !canInsert) {
      return;
    }
    invalidatePreview();
    setApplyReport(null);
    setBaselineAcknowledged(false);
    setDraft((current) => ({ ...current, inserts: current.inserts.filter((_, index) => index !== insertIndex) }));
    setCellEditor((current) => current?.target === 'insert' ? null : current);
  }, [canInsert, dataBusy, invalidatePreview, requiresBaseline, writeFrozen]);

  const markDeleted = useCallback((rowIndex: number) => {
    if (dataBusy || activeDataOperation.current !== null || writeFrozen || requiresBaseline || !activeTableResult || !canUpdateOrDelete) {
      return;
    }
    const rowValues = activeTableResult.rows[rowIndex];
    if (!rowValues) {
      return;
    }
    const row = Object.fromEntries(activeTableResult.columns.map((column, index) => [column.name, rowValues[index] ?? null]));
    invalidatePreview();
    setApplyReport(null);
    setBaselineAcknowledged(false);
    setDraft((current) => current.deletes.some((item) => item.rowIndex === rowIndex)
      ? { ...current, deletes: current.deletes.filter((item) => item.rowIndex !== rowIndex) }
      : {
        ...current,
        updates: current.updates.filter((item) => item.rowIndex !== rowIndex),
        deletes: [...current.deletes, { rowIndex, row }]
      });
    setCellEditor((current) => current?.target === 'update' && current.rowIndex === rowIndex ? null : current);
  }, [activeTableResult, canUpdateOrDelete, dataBusy, invalidatePreview, requiresBaseline, writeFrozen]);

  const beginCellEdit = useCallback((target: CellEditor['target'], rowIndex: number, column: string, initialValue?: DbWriteValue) => {
    if (dataBusy || activeDataOperation.current !== null || writeFrozen || requiresBaseline) {
      return;
    }
    invalidatePreview();
    setCellEditor({
      target,
      rowIndex,
      column,
      initialValue
    });
  }, [dataBusy, invalidatePreview, requiresBaseline, writeFrozen]);

  const requestPreview = useCallback(async () => {
    if (!canUseDatabase || dataBusy || activeDataOperation.current !== null || !changes || draftCount === 0 || writeFrozen || requiresBaseline) {
      return;
    }
    if (cellEditor !== null) {
      setError(translate('请先保留或取消当前单元格编辑，再保存表格更改。'));
      return;
    }
    for (let index = 0; index < changes.inserts.length; index += 1) {
      const insert = changes.inserts[index];
      for (const column of activeTableResult?.columns || []) {
        const issue = validateDbWriteValue(column, hasOwnValue(insert, column.name) ? insert[column.name] : undefined, true);
        if (issue) {
          setError(translate('新增第 {{index}} 行，字段 {{column}}：{{message}}', { index: index + 1, column: column.name, message: translateDiagnostic(issue) }));
          return;
        }
      }
    }
    const previewChanges = changes;
    invalidatePreview();
    const expectedPreviewEpoch = previewEpoch.current;
    const requestSession = currentSession.current;
    const operation = dataOperationSequence.current + 1;
    dataOperationSequence.current = operation;
    activeDataOperation.current = operation;
    setPreviewing(true);
    setError('');
    setNotice(translate('正在验证表结构并生成一次性 SQL 预览…'));
    try {
      const payload = await bridge().invoke('db.preview', { sessionId: session.id, changes: previewChanges });
      const parsed = previewSchema.parse(payload) as Preview;
      if (
        currentSession.current !== requestSession
        || activeDataOperation.current !== operation
        || previewEpoch.current !== expectedPreviewEpoch
      ) {
        return;
      }
      if (parsed.schema !== previewChanges.schema || parsed.table !== previewChanges.table) {
        setNotice('');
        setError(translate('Chen 返回的预览不属于当前表，已拒绝显示。'));
        return;
      }
      setPreview(freezePreview(parsed, previewChanges, activeTable?.search));
      setPreviewClock(Date.now());
      setSheetOpen(true);
      setApplyReport(null);
      setBaselineAcknowledged(false);
      setNotice('');
    } catch (cause) {
      if (currentSession.current === requestSession && activeDataOperation.current === operation) {
        setNotice('');
        setError(errorText(cause, translate('Chen 无法生成 SQL 预览。')));
      }
    } finally {
      if (currentSession.current === requestSession && activeDataOperation.current === operation) {
        activeDataOperation.current = null;
        setPreviewing(false);
      }
    }
  }, [activeTable, activeTableResult, canUseDatabase, cellEditor, changes, dataBusy, draftCount, invalidatePreview, requiresBaseline, session.id, writeFrozen]);

  const submitPreview = useCallback(async () => {
    if (!canUseDatabase || dataBusy || activeDataOperation.current !== null || !preview || writeFrozen || requiresBaseline) {
      return;
    }
    if (preview.expiresAt <= Date.now()) {
      invalidatePreview();
      setError(translate('该 SQL 预览已过期；请在重新读取表后重新生成预览。不会自动重试。'));
      return;
    }
    const submittedPreview = preview;
    const tableToRefresh = activeTable;
    if (!tableToRefresh) {
      setError(translate('当前没有可刷新的表上下文，拒绝提交预览。'));
      return;
    }
    previewEpoch.current += 1;
    const requestSession = currentSession.current;
    const operation = dataOperationSequence.current + 1;
    dataOperationSequence.current = operation;
    activeDataOperation.current = operation;
    pendingApplyRef.current = { operation, sessionKey: requestSession, preview: submittedPreview };
    setApplying(true);
    setError('');
    setNotice(translate('正在按预览顺序逐条提交；这不是原子批次。'));
    try {
      const payload = await bridge().invoke('db.apply', { sessionId: session.id, previewId: submittedPreview.id });
      const parsed = applyResultSchema.parse(payload) as ApplyResult;
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      if (parsed.outcome === 'committed') {
        pendingApplyRef.current = { operation, sessionKey: requestSession, preview: submittedPreview, result: parsed };
      }
      if (parsed.outcome !== 'committed') {
        setApplyReport({ preview: submittedPreview, result: parsed, refresh: 'not-needed' });
        if (parsed.outcome === 'unknown') setWriteFrozen(true);
        setNotice('');
        return;
      }
      setDraft(newDraft());
      setCellEditor(null);
      setApplyReport({ preview: submittedPreview, result: parsed, refresh: 'pending' });
      setNotice(translate('Chen 已确认提交；正在显式重新读取表。'));
      try {
        const refreshPayload = await bridge().invoke('db.table', {
          sessionId: session.id,
          schema: tableToRefresh.schema,
          table: tableToRefresh.table,
          page: tableToRefresh.page,
          limit: tableToRefresh.limit,
          ...(tableToRefresh.search ? { search: tableToRefresh.search } : {})
        });
        const refreshed = queryResultSchema.parse(refreshPayload);
        if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
          return;
        }
        setResult({ value: refreshed, source: 'table', table: tableToRefresh });
        setExpandedCells(new Set());
        setApplyReport({ preview: submittedPreview, result: parsed, refresh: 'refreshed' });
        setNotice(translate('已提交并已从 Chen 重新读取表。'));
      } catch (cause) {
        if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
          return;
        }
        setNotice('');
        setApplyReport({ preview: submittedPreview, result: parsed, refresh: 'failed' });
        setError(translate('变更已提交，但表刷新失败：{{message}} 不会回滚或重试。', { message: errorText(cause, translate('Chen 未返回新表数据。')) }));
      }
    } catch (cause) {
      if (currentSession.current !== requestSession || activeDataOperation.current !== operation) {
        return;
      }
      const message = errorText(cause, translate('Chen 未返回提交终态。'));
      setApplyReport({
        preview: submittedPreview,
        result: { outcome: 'unknown', applied: 0, total: submittedPreview.sql.length, message },
        refresh: 'not-needed'
      });
      setNotice('');
      setWriteFrozen(true);
      setError(translate('无法确认提交终态：{{message}} 本会话表格写入已冻结；请重新连接并核验，绝不重复提交。', { message }));
    } finally {
      if (currentSession.current === requestSession && activeDataOperation.current === operation) {
        if (pendingApplyRef.current?.operation === operation && pendingApplyRef.current.sessionKey === requestSession) {
          pendingApplyRef.current = null;
        }
        activeDataOperation.current = null;
        setPreview(null);
        setApplying(false);
      }
    }
  }, [activeTable, canUseDatabase, dataBusy, invalidatePreview, preview, requiresBaseline, session.id, writeFrozen]);

  const cancelRunningQuery = (): boolean => {
    if (running && !cancelling && activeDataOperation.current !== null) void cancelQuery();
    return true;
  };
  const refreshCurrentTable = (): boolean => {
    if (activeTable && canUseDatabase && !dataBusy && activeDataOperation.current === null) {
      requestTableRefresh();
    }
    return true;
  };
  const previewTableChanges = (): boolean => {
    if (dataBusy) return true;
    if (preview !== null || applyReport !== null) {
      setSheetOpen(true);
      return true;
    }
    if (
      canUseDatabase
      && activeDataOperation.current === null
      && changes
      && draftCount > 0
      && cellEditor === null
      && !writeFrozen
      && !requiresBaseline
    ) void requestPreview();
    return true;
  };

  useShortcutScope(sqlEditorScope, {
    'database.execute': () => {
      if (editor.current?.hasTextFocus() && canUseDatabase && !dataBusy && activeDataOperation.current === null) requestExecute(true);
      return true;
    },
    'database.cancel': cancelRunningQuery,
    'editor.find': () => {
      triggerMonacoShortcut(editor.current, 'editor.find');
      return true;
    },
    'editor.replace': () => {
      if (!dataBusy) triggerMonacoShortcut(editor.current, 'editor.replace');
      return true;
    },
    'editor.format': () => {
      if (!dataBusy) triggerMonacoShortcut(editor.current, 'editor.format');
      return true;
    },
    'editor.comment': () => {
      if (!dataBusy) triggerMonacoShortcut(editor.current, 'editor.comment');
      return true;
    },
    'editor.command-palette': () => {
      triggerMonacoShortcut(editor.current, 'editor.command-palette');
      return true;
    },
  });
  const tableShortcutHandlers = {
    'database.cancel': cancelRunningQuery,
    'database.refresh': refreshCurrentTable,
    'database.preview': previewTableChanges,
  };
  useShortcutScope(resultsScope, tableShortcutHandlers);
  useShortcutScope(draftScope, tableShortcutHandlers);

  const renderTree = (nodes: DbNode[], depth: number): ReactNode[] => nodes.flatMap((node) => {
    const opened = expanded.has(node.key);
    const loading = treeLoadingKeys.has(node.key);
    const canOpenTable = (node.kind === 'table' || node.kind === 'view') && Boolean(node.schema && node.table);
    return [
      <div className={`db-tree-row ${canOpenTable ? 'db-tree-openable' : ''}`} key={node.key} style={{ paddingLeft: 10 + depth * 16 }}>
        <Button className="db-tree-toggle" aria-label={opened ? t('折叠 {{name}}', { name: node.name }) : t('展开 {{name}}', { name: node.name })} isDisabled={node.leaf} isIconOnly type="button" variant="tertiary" onPress={() => toggleNode(node)}>
          {!node.leaf && (loading ? <LoaderCircle className="db-spin" size={14} /> : opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </Button>
        <Button className="db-tree-name" type="button" variant="tertiary" onDoubleClick={() => { if (canOpenTable) requestOpenTable(node); }} onClick={() => { if (!node.leaf) toggleNode(node); }} render={(buttonProps) => <button {...buttonProps} title={canOpenTable ? t('双击打开真实 Chen 表浏览') : node.name} />} > {nodeIcon(node)}<span>{node.name}</span>{node.kind === 'view' && <em>{t('视图')}</em>}</Button>
        {canOpenTable && <Button className="db-tree-table-action" isDisabled={!canUseDatabase || dataBusy} isIconOnly type="button" variant="tertiary" onPress={() => requestOpenTable(node)} render={(buttonProps) => <button {...buttonProps} title={t('打开表浏览')} />} > <Table2 size={14} /></Button>}
      </div>,
      ...(opened ? renderTree(children[node.key] || [], depth + 1) : [])
    ];
  });
  const displayRows = result?.value.rows || [];
  const displayColumns = result?.value.columns || [];
  const appliedSearch = activeTable?.search;
  const tableSearchPending = Boolean(
    activeTable
      && (
        tableSearchText !== (appliedSearch?.text || '')
        || (tableSearchText.length > 0 && tableSearchColumn !== (appliedSearch?.column || ''))
      )
  );
  const gridHasActions = canUpdateOrDelete || canInsert;
  const partialFailedCount = applyReport?.result.outcome === 'partial' && applyReport.result.failedIndex !== undefined ? 1 : 0;
  const partialNotExecuted = applyReport?.result.outcome === 'partial'
    ? Math.max(0, applyReport.result.total - applyReport.result.applied - partialFailedCount)
    : 0;
  const reviewedValueText = (value: DbWriteValue | undefined): string => {
    if (value === undefined) return t('未设置');
    if (isDefaultValue(value)) return 'DEFAULT';
    if (value === null) return 'NULL';
    return JSON.stringify(value);
  };
  const reviewedRowIdentity = (row: Record<string, DbCell>): string => {
    const primaryKeys = displayColumns.filter((column) => column.primaryKey).map((column) => column.name);
    const names = primaryKeys.length > 0 ? primaryKeys : Object.keys(row);
    return names.map((name) => `${name} = ${reviewedValueText(row[name])}`).join(' · ');
  };
  const reconnectable = session.phase === 'failed' || session.phase === 'lost' || session.phase === 'closed';
  const sessionState = session.phase === 'connecting'
    ? { title: t('正在建立受授权 Chen 会话…'), detail: session.error || t('连接完成前不会执行 SQL 或重放任何命令。') }
    : session.phase === 'failed'
      ? { title: t('Chen 会话已失效'), detail: session.error || t('Chen 数据库会话因错误停止，请重新连接。') }
      : session.phase === 'lost'
        ? { title: t('Chen 会话已断开'), detail: session.error || t('Chen 数据库会话意外断开。') }
        : { title: t('Chen 会话已关闭'), detail: session.error || t('Chen 数据库会话已经关闭。') };

  return <section ref={pane} className={`database-pane db-pane${resizingSidebar ? ' db-pane-resizing-sidebar' : ''}${resizingEditor ? ' db-pane-resizing-editor' : ''}`} data-row-density={preferences.databaseRowDensity} style={{ '--db-sidebar-width': `${visibleSidebarWidth}px`, '--db-editor-height': `${visibleEditorHeight}px`, '--db-result-font-size': `${preferences.databaseResultFontSize}px` } as CSSProperties} aria-label={`${session.context.assetName} ${t('数据库工作台')}`}>
    <aside id={`db-explorer-${session.id}`} className="db-explorer">
      <div className="db-explorer-heading"><div><Database size={17} /><strong>{t('数据库资源')}</strong></div><Button aria-label={t('刷新 Chen 元数据树')} isDisabled={!canUseDatabase || treeLoading || dataBusy} isIconOnly type="button" variant="tertiary" onPress={() => void loadTree()} render={(buttonProps) => <button {...buttonProps} title={t('刷新 Chen 元数据树')} />} > <RefreshCw size={15} /></Button></div>
      <p className="db-explorer-context">{session.context.accountName}@{session.context.address}</p>
      {treeLoading && tree.length === 0 ? <div className="db-tree-status"><LoaderCircle className="db-spin" size={16} /> {t('正在读取 Chen 元数据…')}</div> : null}
      {!treeLoading && tree.length === 0 && !error ? <div className="db-tree-status">{canUseDatabase ? t('元数据树为空。') : t('等待数据库会话就绪。')}</div> : null}
      <div className="db-tree" role="tree">{renderTree(tree, 0)}</div>
    </aside>
    <div
      className="db-sidebar-resizer"
      role="separator"
      aria-label={t('数据库资源侧栏宽度')}
      aria-orientation="vertical"
      aria-valuemin={sidebarMin}
      aria-valuemax={sidebarMax}
      aria-valuenow={visibleSidebarWidth}
      aria-controls={`db-explorer-${session.id}`}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        sidebarDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: visibleSidebarWidth };
        setResizingSidebar(true);
      }}
      onPointerMove={(event) => {
        const drag = sidebarDrag.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setSidebarWidth(Math.max(sidebarMin, Math.min(sidebarMax, drag.startWidth + event.clientX - drag.startX)));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        sidebarDrag.current = null;
        setResizingSidebar(false);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 50 : 10;
        const next = event.key === 'ArrowLeft' ? visibleSidebarWidth - step
          : event.key === 'ArrowRight' ? visibleSidebarWidth + step
            : event.key === 'Home' ? sidebarMin : event.key === 'End' ? sidebarMax : null;
        if (next === null) return;
        event.preventDefault();
        setSidebarWidth(Math.max(sidebarMin, Math.min(sidebarMax, next)));
      }}
    />

    <main id={`db-workbench-${session.id}`} className="db-workbench">
      <header className="db-toolbar">
        <div className="db-connection"><span className={`db-phase ${session.phase}`} /> <strong>{session.context.assetName}</strong><span>{session.context.protocol.toUpperCase()} · {session.context.accountName}</span></div>
        <div className="db-toolbar-actions">
          <Button isDisabled={!canUseDatabase || dataBusy} type="button" variant="secondary" onPress={() => requestExecute(true)} render={(buttonProps) => <button {...buttonProps} title={`${t('执行编辑器选中 SQL；未选中时执行全文')} (${shortcutLabel('database.execute', preferences.shortcuts)})`} />} > <Play size={15} />{t('执行选中')}</Button>
          <Button className="db-primary-action" isDisabled={!canUseDatabase || dataBusy} type="button" variant="primary" onPress={() => requestExecute(false)}><Play size={15} />{t('执行')}</Button>
          <Button className="db-danger-action" isDisabled={!running || cancelling} type="button" variant="danger-soft" onPress={() => void cancelQuery()} render={(buttonProps) => <button {...buttonProps} title={`${t('取消')} (${shortcutLabel('database.cancel', preferences.shortcuts)})`} />}><Square size={14} />{cancelling ? t('取消中…') : t('取消')}</Button>
        </div>
      </header>

      <div ref={sqlEditorScope} id={`db-sql-editor-${session.id}`} className="db-editor-wrap">
        <Editor
          height="100%"
          defaultLanguage="sql"
          value={sql}
          theme={theme.id}
          onChange={(value) => {
            invalidatePreview();
            setSql(value || '');
          }}
          onMount={((instance) => { editor.current = instance; }) satisfies OnMount}
          options={{
            ariaLabel: t('SQL 编辑器'),
            fontFamily: preferences.editorFont,
            fontSize: preferences.editorFontSize,
            tabSize: preferences.editorTabSize,
            minimap: { enabled: false },
            wordWrap: preferences.databaseWordWrap ? 'on' : 'off',
            lineNumbers: preferences.databaseShowLineNumbers ? 'on' : 'off',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            readOnly: dataBusy,
            padding: { top: 12, bottom: 12 }
          }}
        />
      </div>
      <div
        className="db-editor-resizer"
        role="separator"
        aria-label={t('SQL 编辑器和结果区域高度')}
        aria-orientation="horizontal"
        aria-valuemin={editorMin}
        aria-valuemax={editorMax}
        aria-valuenow={visibleEditorHeight}
        aria-controls={`db-sql-editor-${session.id} db-results-${session.id}`}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          editorDrag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: visibleEditorHeight };
          setResizingEditor(true);
        }}
        onPointerMove={(event) => {
          const drag = editorDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setEditorHeight(Math.max(editorMin, Math.min(editorMax, drag.startHeight + event.clientY - drag.startY)));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          editorDrag.current = null;
          setResizingEditor(false);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 50 : 10;
          const next = event.key === 'ArrowUp' ? visibleEditorHeight - step
            : event.key === 'ArrowDown' ? visibleEditorHeight + step
              : event.key === 'Home' ? editorMin : event.key === 'End' ? editorMax : null;
          if (next === null) return;
          event.preventDefault();
          setEditorHeight(Math.max(editorMin, Math.min(editorMax, next)));
        }}
      />

      <div className="db-status-messages">
      {error && <div className="db-alert db-error" role="alert"><AlertTriangle size={16} /><span>{error}</span><Button aria-label={t('关闭错误')} isIconOnly type="button" variant="tertiary" onPress={() => setError('')}><X size={14} /></Button></div>}
      {notice && <div className="db-alert db-notice"><span>{notice}</span><Button aria-label={t('关闭提示')} isIconOnly type="button" variant="tertiary" onPress={() => setNotice('')}><X size={14} /></Button></div>}
      {discardAction !== null && (
        <div className="db-alert db-discard-confirmation" role="alert">
          <AlertTriangle size={16} />
          <span>{discardAction.kind === 'clear'
            ? t('将永久清空当前表的所有本地变更草稿。')
            : discardAction.kind === 'reload'
              ? t('将放弃未保存的修改并刷新表格；提交报告会保留。')
              : discardAction.kind === 'table' && discardAction.search
                ? t('将丢弃当前表的所有本地变更草稿，并将服务器端搜索应用为 {{column}} 包含 {{text}}。', { column: discardAction.search.column || t('全部列'), text: JSON.stringify(discardAction.search.text) })
                : t('继续操作会丢弃当前表的所有本地变更草稿；数据库和 Chen 均不会收到这些草稿。')}</span>
          <Button type="button" variant="tertiary" onPress={() => setDiscardAction(null)}>{t('保留草稿')}</Button>
          <Button className="db-discard-confirmation__confirm" type="button" variant="primary" onPress={confirmDraftDiscard}>{discardAction.kind === 'reload' || discardAction.kind === 'refresh' ? t('丢弃并重新读取') : t('放弃草稿并继续')}</Button>
        </div>
      )}
      {session.phase !== 'active' && (
        <section className={`db-session-state db-session-${session.phase}`} role={session.phase === 'connecting' ? 'status' : 'alert'}>
          {session.phase === 'connecting' ? <LoaderCircle className="db-spin" size={22} /> : <AlertTriangle size={22} />}
          <div>
            <strong>{sessionState.title}</strong>
            <span>{sessionState.detail}</span>
            {reconnectable && <small>{t('此标签中的 SQL、表草稿和提交报告会保留。重新连接将在新标签页建立受授权会话，绝不会重放 SQL 或提交。')}</small>}
          </div>
          {reconnectable && <Button type="button" isDisabled={!onReconnect || reconnecting} variant="secondary" onPress={onReconnect}>
            <RefreshCw className={reconnecting ? 'db-spin' : ''} size={14} />{reconnecting ? t('正在建立新会话…') : t('重新连接')}
          </Button>}
        </section>
      )}
      </div>

      <section ref={resultsScope} id={`db-results-${session.id}`} className="db-results" aria-live="polite">
        <div className="db-results-heading">
          <div>
            <Table2 size={16} />
            <strong>{activeTable ? `${activeTable.schema}.${activeTable.table}` : t('查询结果')}</strong>
            {result && <span>{t('{{count}} 行 · {{elapsed}} ms{{truncated}}', { count: displayRows.length, elapsed: result.value.elapsedMs, truncated: result.value.truncated ? t(' · 已截断') : '' })}</span>}
          </div>
          {activeTable && (
            <div className="db-results-controls">
              <div className="db-table-actions">
                <Button aria-label={t('刷新表格')} isDisabled={!canUseDatabase || dataBusy} type="button" variant="tertiary" onPress={requestTableRefresh} render={(buttonProps) => <button {...buttonProps} title={`${t('刷新表格')} (${shortcutLabel('database.refresh', preferences.shortcuts)})`} />}>
                  <RefreshCw className={running ? 'db-spin' : ''} size={14} />{t('刷新')}
                </Button>
                {canInsert && <Button isDisabled={dataBusy || writeFrozen || requiresBaseline} type="button" variant="secondary" onPress={createInsertDraft}>
                  <Plus size={14} />{t('新建记录')}
                </Button>}
              </div>
              <div className="db-table-search input-frame">
                <Search size={14} aria-hidden="true" />
                <Input
                  aria-label={t('搜索表记录')}
                  className="db-table-search-input"
                  disabled={!canUseDatabase || dataBusy}
                  fullWidth
                  maxLength={512}
                  placeholder={t('搜索整个表')}
                  title={t('区分大小写的字面文本搜索；% 和 _ 不是通配符')}
                  type="text"
                  value={tableSearchText}
                  variant="secondary"
                  onChange={(event) => setTableSearchText(event.target.value.slice(0, 512))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      applyTableSearch();
                    }
                  }}
                />
                <Select aria-label={t('搜索列')} className="db-table-search-select" isDisabled={!canUseDatabase || dataBusy} selectedKey={tableSearchColumn === '' ? 'all' : `column-${displayColumns.findIndex((column) => column.name === tableSearchColumn)}`} variant="secondary" onSelectionChange={(key) => {
                  if (key === 'all') {
                    setTableSearchColumn('');
                    return;
                  }
                  const index = /^column-(\d+)$/.exec(String(key))?.[1];
                  if (index !== undefined) setTableSearchColumn(displayColumns[Number(index)]?.name || '');
                }}>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover className="db-table-search-select-popover"><ListBox><ListBox.Item id="all">{t('全部列')}</ListBox.Item>{displayColumns.map((column, index) => <ListBox.Item key={`column-${index}`} id={`column-${index}`}>{column.name}</ListBox.Item>)}</ListBox></Select.Popover>
                </Select>
                <Button isDisabled={!canUseDatabase || dataBusy || !tableSearchPending} type="button" variant="tertiary" onPress={applyTableSearch}>{t('应用')}</Button>
                <Button isDisabled={!canUseDatabase || dataBusy || (!tableSearchText && !appliedSearch)} type="button" variant="tertiary" onPress={clearTableSearch}>{t('清除')}</Button>
              </div>
              <div className="db-pagination">
                <span>{t('每页')}</span>
                <Select aria-label={t('每页')} className="db-pagination-select" isDisabled={!canUseDatabase || dataBusy} selectedKey={String(activeTable.limit)} variant="secondary" onSelectionChange={(key) => {
                  if (key === null) return;
                  const limit = String(key);
                  changePage(1, limit === '50' ? 50 : limit === '100' ? 100 : limit === '200' ? 200 : 500);
                }}>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover className="db-pagination-select-popover"><ListBox><ListBox.Item id="50">50</ListBox.Item><ListBox.Item id="100">100</ListBox.Item><ListBox.Item id="200">200</ListBox.Item><ListBox.Item id="500">500</ListBox.Item></ListBox></Select.Popover>
                </Select>
                <Button isDisabled={!canUseDatabase || dataBusy || activeTable.page <= 1} type="button" variant="tertiary" onPress={() => changePage(activeTable.page - 1)}>{t('上一页')}</Button>
                <span>{t('第 {{page}} 页', { page: activeTable.page })}</span>
                <Button isDisabled={!canUseDatabase || dataBusy || displayRows.length < activeTable.limit} type="button" variant="tertiary" onPress={() => changePage(activeTable.page + 1)}>{t('下一页')}</Button>
              </div>
            </div>
          )}
        </div>
        {activeTable && (
          <div className={`db-search-feedback${tableSearchPending ? ' db-search-pending' : ''}`} role="status">
            {tableSearchPending
              ? t('输入条件尚未应用；当前行仍{{filter}}。', { filter: appliedSearch ? t('按 {{column}} 包含 {{text}} 筛选', { column: appliedSearch.column || t('全部列'), text: JSON.stringify(appliedSearch.text) }) : t('显示未筛选记录') })
              : appliedSearch
                ? t('已应用服务器端搜索：{{column}} 包含 {{text}}。', { column: appliedSearch.column || t('全部列'), text: JSON.stringify(appliedSearch.text) })
                : t('未应用表搜索；当前行来自未筛选的服务器端结果。')}
          </div>
        )}
        {activeTable && !canUpdateOrDelete && !canInsert && activeTableResult?.readonlyReason && (
          <div className="db-table-readonly" role="status"><AlertTriangle size={14} /><span>{activeTableResult.readonlyReason}</span></div>
        )}
        {result?.source === 'query' && (
          <div className="db-crud-blocked">
            <AlertTriangle size={15} />
            <div><p>{t('普通 SQL 查询结果始终只读；请从资源树打开表，且仅在 Chen 返回可写表元数据和快照时编辑。')}</p>{result.value.readonlyReason && <p>{result.value.readonlyReason}</p>}</div>
          </div>
        )}
        {result?.value.truncated && <div className="db-truncation"><AlertTriangle size={14} />{t('服务器或桌面已截断本次结果；未展示的行不会被视为已读取。')}</div>}
        {!result ? (
          <div className="db-empty-result">{t('执行 SQL 或在资源树中双击表，结果将由 Chen 实际返回。')}</div>
        ) : displayColumns.length === 0 ? (
          <div className="db-empty-result">{result.value.message}</div>
        ) : (
          <div className="db-grid-wrap">
            <table className="db-grid">
              <thead>
                <tr>
                  {gridHasActions && <th className="db-grid-actions">{t('操作')}</th>}
                  {displayColumns.map((column) => (
                    <th key={column.name} title={[
                      column.primaryKey && t('主键不可编辑'),
                      column.generated && t('生成列不可编辑'),
                      column.autoIncrement && t('自增列不可编辑'),
                      column.editable && t('可更新'),
                      column.insertable && t('可新增'),
                      column.nullable && t('允许 NULL'),
                      column.hasDefault && t('支持 DEFAULT')
                    ].filter(Boolean).join('；') || undefined}>
                      <span>{column.name}</span>
                      <small>{column.type}</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, rowIndex) => (
                  <DatabaseResultRow
                    key={`${activeTable?.page || 'query'}-${rowIndex}`}
                    row={row}
                    rowIndex={rowIndex}
                    columns={displayColumns}
                    values={activeTable ? draftValuesByRow.get(rowIndex) : undefined}
                    deleted={deletedRows.has(rowIndex)}
                    hasActions={gridHasActions}
                    canUpdateOrDelete={canUpdateOrDelete}
                    disabled={!canUseDatabase || dataBusy || writeFrozen || requiresBaseline}
                    editor={cellEditor?.target === 'update' && cellEditor.rowIndex === rowIndex ? cellEditor : null}
                    expandedCells={expandedCells}
                    onEdit={beginCellEdit}
                    onUpdate={updateDraft}
                    onDelete={markDeleted}
                    onCancel={cancelCellEdit}
                    onExpand={toggleExpandedCell}
                    onCopy={copyText}
                  />
                ))}
                {activeTable && draft.inserts.map((insert, insertIndex) => (
                  <tr className="db-row-insert" key={`insert-${insertIndex}`}>
                    {gridHasActions && <td className="db-grid-actions"><button aria-label={t('移除此新增草稿')} disabled={dataBusy || writeFrozen || requiresBaseline} type="button" onClick={() => removeInsertDraft(insertIndex)} title={t('移除此新增草稿')}><Trash2 size={14} /></button></td>}
                    {displayColumns.map((column) => {
                      const supplied = hasOwnValue(insert, column.name);
                      const value = supplied ? insert[column.name] : undefined;
                      const editable = canInsert && column.insertable && !column.generated && !column.autoIncrement;
                      const isEditing = cellEditor?.target === 'insert' && cellEditor.rowIndex === insertIndex && cellEditor.column === column.name;
                      return (
                        <td key={column.name} className={`${value === null ? 'db-null-cell' : ''}${value !== undefined && isDefaultValue(value) ? ' db-default-cell' : ''}`}>
                          {!editable ? <div className="db-insert-readonly">{t('不可新增')}</div> : isEditing && cellEditor !== null ? (
                            <DatabaseCellEditor
                              key={`insert:${insertIndex}:${column.name}`}
                              column={column}
                              initialValue={cellEditor.initialValue}
                              allowOmit
                              disabled={!canUseDatabase || dataBusy || writeFrozen || requiresBaseline}
                              onSave={(nextValue) => updateInsertDraft(insertIndex, column.name, nextValue)}
                              onCancel={() => setCellEditor(null)}
                              onRevert={() => updateInsertDraft(insertIndex, column.name, undefined)}
                            />
                          ) : (
                            <div className="db-cell">
                              <button className="db-cell-value db-cell-value-editable" type="button" disabled={dataBusy || writeFrozen || requiresBaseline} onDoubleClick={() => beginCellEdit('insert', insertIndex, column.name, value)} title={t('双击编辑新增行的本地草稿')}>{displayValueText(value, t('未设置'), t('空字符串'))}</button>
                              <button className="db-cell-draft" aria-label={t('编辑新增行的 {{column}}', { column: column.name })} disabled={dataBusy || writeFrozen || requiresBaseline} type="button" onClick={() => beginCellEdit('insert', insertIndex, column.name, value)} title={t('双击编辑新增行的本地草稿')}><Pencil size={13} /></button>
                              <button className="db-cell-copy" aria-label={t('复制新增行 {{column}} 的精确值', { column: column.name })} disabled={value === undefined} type="button" onClick={() => { if (value !== undefined) void copyText(valueText(value), t('已复制新增草稿值。')); }} title={t('复制精确值')}><Copy size={13} /></button>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {activeTable && (draftCount > 0 || preview !== null || applyReport !== null) && (
        <section ref={draftScope} className={`db-draft-bar${applyReport ? ` db-draft-bar--${applyReport.result.outcome}` : ''}`} aria-label={t('更改与提交报告')}>
          <div>
            <Save size={15} />
            <strong>{applyReport
              ? t('提交报告：{{outcome}}', { outcome: applyReport.result.outcome === 'committed' ? t('已提交') : applyReport.result.outcome === 'partial' ? t('部分完成') : applyReport.result.outcome === 'not-started' ? t('未提交任何更改') : t('状态未知') })
              : t('{{count}} 项变更', { count: draftCount })}
            </strong>
            {applyReport?.result.outcome === 'unknown' && <span>{t('写入已冻结')}</span>}
            {requiresBaseline && <span>{t('需要重新读取')}</span>}
          </div>
          <div>
            <Button
              ref={saveButton}
              isDisabled={!applyReport && (!canUseDatabase || dataBusy || cellEditor !== null || !changes || draftCount === 0 || writeFrozen || requiresBaseline)}
              type="button"
              variant="primary"
              onPress={() => {
                if (preview || applyReport) {
                  setSheetOpen(true);
                } else {
                  void requestPreview();
                }
              }}
              render={(buttonProps) => <button {...buttonProps} title={`${applyReport ? t('查看提交报告') : t('查看并保存更改')} (${shortcutLabel('database.preview', preferences.shortcuts)})`} />}
            >
              {previewing ? <LoaderCircle className="db-spin" size={13} /> : <Save size={13} />}
              {applyReport ? t('查看提交报告') : t('查看并保存更改')}
            </Button>
            {draftCount > 0 && !preview && !applyReport && <Button isDisabled={dataBusy || writeFrozen || requiresBaseline} type="button" variant="tertiary" onPress={() => setDiscardAction({ kind: 'clear' })}><RotateCcw size={14} />{t('清空')}</Button>}
          </div>
        </section>
      )}
    </main>
    {sheetContentAvailable && (
      <Modal isOpen={sheetVisible} onOpenChange={(isOpen) => {
        if (!isOpen && !applying) closeSheet();
      }}>
        <Modal.Backdrop className="db-sheet-backdrop" isDismissable={!applying} isKeyboardDismissDisabled={applying}>
          <Modal.Container className="db-sheet-container" placement="bottom" scroll="inside">
            <Modal.Dialog className={`db-sheet${sheetExpanded ? ' db-sheet--expanded' : ''}${previewExpired && preview && !applying ? ' db-preview-expired' : ''}`} aria-describedby={preview ? `db-sheet-description-${session.id}` : undefined}>
              <div ref={sheetDialog} className="db-sheet-content" aria-busy={applying}>
                <Modal.Header className="db-sheet-header">
                  <div>
                    <Modal.Heading id={`db-sheet-title-${session.id}`}>{preview ? t('确认数据库更改') : t('提交报告')}</Modal.Heading>
                    {preview && <p id={`db-sheet-description-${session.id}`}>{t('核对草稿变更和 SQL；关闭不会丢失任何草稿或报告。')}</p>}
                  </div>
                  <div className="db-sheet-header-actions">
                    <Button aria-label={sheetExpanded ? t('收起变更面板') : t('展开变更面板')} aria-pressed={sheetExpanded} isIconOnly type="button" variant="tertiary" onPress={() => setSheetExpanded((expanded) => !expanded)}>
                      {sheetExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                    </Button>
                    <Button ref={sheetClose} aria-label={t('关闭变更面板')} isDisabled={applying} isIconOnly type="button" variant="tertiary" onPress={closeSheet}><X size={19} /></Button>
                  </div>
                </Modal.Header>
                <Modal.Body className="db-sheet-body" aria-label={preview ? t('将提交的字段变更') : t('提交报告')}>
                  {preview ? (
                    <>
                      <dl className="db-sheet-context">
                        <div><dt>{t('环境')}</dt><dd>{session.context.assetName}@{session.context.address}</dd></div>
                        <div><dt>{t('账户')}</dt><dd>{session.context.accountName}</dd></div>
                        <div><dt>{t('架构 / 表')}</dt><dd>{preview.schema}.{preview.table}</dd></div>
                        {preview.reviewedSearch && <div><dt>{t('表搜索')}</dt><dd>{t('{{column}} 包含 {{text}}', { column: preview.reviewedSearch.column || t('全部列'), text: JSON.stringify(preview.reviewedSearch.text) })}</dd></div>}
                        <div><dt>{t('更新')}</dt><dd>{preview.counts.updates}</dd></div>
                        <div><dt>{t('新增')}</dt><dd>{preview.counts.inserts}</dd></div>
                        <div><dt>{t('删除')}</dt><dd>{preview.counts.deletes}</dd></div>
                      </dl>
                      <p className="db-sequential-warning">{t('非原子提交：语句按顺序逐条提交；后续失败不会回滚之前的提交。')}</p>
                      {preview.warnings.length > 0 && <ul className="db-preview-warnings">{preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}
                      <section className="db-review-diff" aria-label={t('将提交的字段变更')}>
                        <h4>{t('将确认提交的字段变更')}</h4>
                        {preview.reviewedChanges.updates.map((change, index) => (
                          <article key={`update-${index}`}>
                            <header><strong>{t('更新 #{{index}}', { index: index + 1 })}</strong><span>{t('行标识：')}<code>{reviewedRowIdentity(change.row)}</code></span></header>
                            <dl>
                              {Object.entries(change.values).map(([column, value]) => (
                                <div key={column}>
                                  <dt>{column}</dt>
                                  <dd><span>{t('旧')} <code>{reviewedValueText(change.row[column])}</code></span><b>→</b><span>{t('新')} <code>{reviewedValueText(value)}</code></span></dd>
                                </div>
                              ))}
                            </dl>
                          </article>
                        ))}
                        {preview.reviewedChanges.inserts.map((values, index) => (
                          <article key={`insert-${index}`}>
                            <header><strong>{t('新增 #{{index}}', { index: index + 1 })}</strong><span>{t('仅下列明确值会写入；未列出的列将被省略。')}</span></header>
                            {Object.keys(values).length > 0 ? (
                              <dl>
                                {Object.entries(values).map(([column, value]) => (
                                  <div key={column}><dt>{column}</dt><dd><code>{reviewedValueText(value)}</code></dd></div>
                                ))}
                              </dl>
                            ) : <p>{t('不提供明确列值；Chen 将按表默认值处理。')}</p>}
                          </article>
                        ))}
                        {preview.reviewedChanges.deletes.map((row, index) => (
                          <article key={`delete-${index}`}>
                            <header><strong>{t('删除 #{{index}}', { index: index + 1 })}</strong><span>{t('行标识：')}<code>{reviewedRowIdentity(row)}</code></span></header>
                            <p>{t('将使用 Chen 已验证的快照和此行标识删除该行。')}</p>
                          </article>
                        ))}
                      </section>
                      <details className="db-sheet-sql">
                        <summary>{t('显示 SQL（{{count}} 条）', { count: preview.sql.length })}</summary>
                        <pre>{preview.sql.join('\n\n')}</pre>
                      </details>
                    </>
                  ) : applyReport && (
                    <section className={`db-apply-report db-apply-${applyReport.result.outcome}`} role={applyReport.result.outcome === 'unknown' ? 'alert' : undefined}>
                      <div className="db-preview-heading"><strong>{t('提交报告：{{outcome}}', { outcome: applyReport.result.outcome === 'committed' ? t('已提交') : applyReport.result.outcome === 'partial' ? t('部分完成') : applyReport.result.outcome === 'not-started' ? t('未提交任何更改') : t('状态未知') })}</strong></div>
                      <p className="db-report-message">{applyReport.result.message}</p>
                      <p className="db-sequential-warning">{t('非原子提交：语句按顺序逐条提交；后续失败不会回滚之前的提交。')}</p>
                      {applyReport.result.outcome === 'partial' && <dl className="db-report-summary">
                        <div><dt>{t('已提交')}</dt><dd>{t('{{count}} 条语句', { count: applyReport.result.applied })}</dd></div>
                        <div><dt>{t('失败')}</dt><dd>{t('{{count}} 条语句', { count: partialFailedCount })}</dd></div>
                        <div><dt>{t('未执行')}</dt><dd>{t('{{count}} 条语句', { count: partialNotExecuted })}</dd></div>
                        {applyReport.result.failedIndex !== undefined && <div><dt>{t('失败序号')}</dt><dd>{applyReport.result.failedIndex + 1}</dd></div>}
                        {applyReport.result.failure && <div><dt>{t('失败类型')}</dt><dd>{applyReport.result.failure === 'conflict' ? t('冲突') : t('被拒绝')}</dd></div>}
                      </dl>}
                      {applyReport.result.outcome === 'committed' && <dl className="db-report-summary">
                        <div><dt>{t('已提交')}</dt><dd>{t('{{count}} 条语句', { count: applyReport.result.applied })}</dd></div>
                        <div><dt>{t('刷新')}</dt><dd>{applyReport.refresh === 'pending' ? t('重新读取中') : applyReport.refresh === 'refreshed' ? t('已重新读取') : applyReport.refresh === 'failed' ? t('提交已确认，刷新失败') : t('不适用')}</dd></div>
                      </dl>}
                      {applyReport.result.outcome === 'unknown' && <p className="db-report-action">{t('提交终态未知，本会话表格写入和草稿编辑均已冻结。请重新连接并核验数据库，绝不重新提交此预览。')}</p>}
                      {requiresBaseline && <p className="db-report-action">{t('请先放弃未保存的修改并刷新表格，再重新编辑。')}</p>}
                      {applyReport.result.outcome === 'committed' && applyReport.refresh === 'failed' && <p className="db-report-action">{t('提交已经确认；刷新失败不会触发回滚或自动重试。')}</p>}
                      <details className="db-sheet-sql">
                        <summary>{t('显示 SQL（{{count}} 条）', { count: applyReport.preview.sql.length })}</summary>
                        <ol>{applyReport.preview.sql.map((sql, index) => (
                          <li key={index}>
                            <strong>{index < applyReport.result.applied ? t('已提交')
                              : applyReport.result.outcome === 'unknown' ? t('状态未知')
                                : index === applyReport.result.failedIndex ? t('失败') : t('未执行')}</strong>
                            <pre>{sql}</pre>
                          </li>
                        ))}</ol>
                      </details>
                    </section>
                  )}
                </Modal.Body>
                <Modal.Footer className="db-sheet-footer">
                  {preview ? (
                    <>
                      <span className="db-sheet-status" role="status">{applying ? t('正在提交，请勿重复操作…') : previewExpired ? t('预览已过期，请重新生成后确认。') : t('预览有效至 {{time}}', { time: formatDateTime(preview.expiresAt) })}</span>
                      <div className="db-sheet-actions">
                        <Button type="button" variant="tertiary" onPress={() => void copyText(preview.sql.join('\n\n'), t('已复制预览 SQL。'))}><Copy size={13} />{t('复制 SQL')}</Button>
                        <Button isDisabled={applying} type="button" variant="tertiary" onPress={closeSheet}>{t('关闭，保留草稿和报告')}</Button>
                        {previewExpired && !applying
                          ? <Button isDisabled={!canUseDatabase || dataBusy || writeFrozen || requiresBaseline} type="button" variant="secondary" onPress={() => void requestPreview()}>{t('重新生成预览')}</Button>
                          : <Button className="db-primary-submit" isDisabled={!canUseDatabase || dataBusy || writeFrozen || requiresBaseline} type="button" variant="primary" onPress={() => void submitPreview()}>{applying ? <LoaderCircle className="db-spin" size={13} /> : <Save size={13} />}{applying ? t('正在提交…') : t('确认并执行 SQL')}</Button>}
                      </div>
                    </>
                  ) : applyReport && (
                    <div className="db-sheet-actions db-sheet-actions--report">
                      <Button type="button" variant="tertiary" onPress={() => void copyText(applyReport.preview.sql.join('\n\n'), t('已复制提交报告中的 SQL。'))}><Copy size={13} />{t('复制 SQL')}</Button>
                      {applyReport.result.outcome === 'committed' && applyReport.refresh === 'failed' && <Button isDisabled={!canUseDatabase || dataBusy} type="button" variant="secondary" onPress={requestTableRefresh}><RefreshCw size={13} />{t('重试刷新')}</Button>}
                      {requiresBaseline && <Button isDisabled={!canUseDatabase || dataBusy} type="button" variant="secondary" onPress={() => { closeSheet(); setDiscardAction({ kind: 'reload' }); }}><RefreshCw size={13} />{t('丢弃草稿并重新读取')}</Button>}
                      {applyReport.result.outcome === 'unknown' && <Button isDisabled={!onReconnect || reconnecting} type="button" variant="secondary" onPress={onReconnect}><RefreshCw className={reconnecting ? 'db-spin' : ''} size={13} />{reconnecting ? t('正在建立新会话…') : t('重新连接')}</Button>}
                      <Button type="button" variant="tertiary" onPress={closeSheet}>{t('关闭')}</Button>
                    </div>
                  )}
                </Modal.Footer>
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    )}
  </section>;
}
