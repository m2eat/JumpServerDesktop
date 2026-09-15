import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal } from '@heroui/react';
import { ArrowUp, ChevronLeft, ChevronRight, Copy, Download, File, Folder, Link, RefreshCw, Upload } from 'lucide-react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { z } from 'zod';
import type {
  Capability,
  DesktopBridge,
  FileListing,
  Preferences,
  RemoteFile,
  SessionInfo,
  TransferTask,
} from '@shared/index';
import { formatNumber, t as translate, translateDiagnostic, useI18n } from '../i18n';
import { useTheme } from '../themes';
import './FilesPane.css';

const remoteFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'directory', 'link']),
  size: z.string(),
  modified: z.string(),
  permissions: z.string(),
  version: z.string().optional(),
});

const fileListingSchema = z.object({
  path: z.string(),
  entries: z.array(remoteFileSchema),
});

const textFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  version: z.string(),
  writable: z.boolean(),
  reason: z.string().optional(),
});

const transferTaskSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  direction: z.enum(['upload', 'download']),
  phase: z.enum(['queued', 'transferring', 'completed', 'canceled', 'failed', 'unknown']),
  cancelRequested: z.boolean().optional(),
  sourceSessionId: z.string().optional(),
  transferred: z.number().finite().nonnegative(),
  total: z.number().finite().nonnegative().optional(),
  error: z.string().optional(),
});
const transferTasksSchema = z.array(transferTaskSchema);

type EditorPhase = 'clean' | 'dirty' | 'saving' | 'conflict' | 'unknown' | 'error';

interface RemoteRevision {
  content: string;
  version: string;
  writable: boolean;
  reason?: string;
}

interface EditorTab {
  id: string;
  path: string;
  title: string;
  content: string;
  baseline: string;
  version: string;
  writable: boolean;
  reason?: string;
  revision: number;
  savingRevision?: number;
  phase: EditorPhase;
  message?: string;
  remoteRevision?: RemoteRevision;
}

type DialogState =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: RemoteFile }
  | { kind: 'remove'; entry: RemoteFile }
  | { kind: 'save-editor'; editorId: string }
  | { kind: 'close-editor'; editorId: string }
  | { kind: 'adopt-remote'; editorId: string };

export type FileTransferTarget =
  | { kind: 'local'; grantId: string; relativePath: string }
  | { kind: 'remote'; sessionId: string; path: string; label: string };

export interface FilesPaneProps {
  session: SessionInfo;
  preferences: Preferences;
  compact?: boolean;
  transferTarget?: FileTransferTarget;
  onLocationChange?: (listing: FileListing | null) => void;
  onTransferTasksCreated?: (tasks: TransferTask[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function bridge(): DesktopBridge {
  if (typeof window.desktop === 'undefined') {
    throw new Error(translate('桌面桥接尚未就绪。'));
  }
  return window.desktop;
}

function plainText(value: string, maximum = 280): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '�').trim();
  return sanitized.length > maximum ? `${sanitized.slice(0, maximum)}…` : sanitized;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = plainText(error.message, 320);
    return message ? translateDiagnostic(message) : fallback;
  }
  return fallback;
}

function isPermissionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('permission') || normalized.includes('forbidden') || normalized.includes('access denied') || normalized.includes('403') || message.includes('权限');
}

function joinRemotePath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory.replace(/\/+$/, '')}/${name}`;
}

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '') || '/';
  if (normalized === '/') {
    return '/';
  }
  const boundary = normalized.lastIndexOf('/');
  return boundary <= 0 ? '/' : normalized.slice(0, boundary);
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const boundary = normalized.lastIndexOf('/');
  return boundary < 0 ? normalized : normalized.slice(boundary + 1);
}

function validateRemoteName(value: string): string | null {
  if (!value.trim()) {
    return translate('请输入名称。');
  }
  if (value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    return translate('名称不能包含路径分隔符或控制字符。');
  }
  if (value === '.' || value === '..') {
    return translate('名称不能是 . 或 ..。');
  }
  return null;
}

function upsertTask(tasks: TransferTask[], task: TransferTask): TransferTask[] {
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index < 0) {
    return [task, ...tasks];
  }
  const previous = tasks[index];
  const next = [...tasks];
  next[index] = task.cancelRequested === undefined
    && previous.cancelRequested === true
    && task.phase !== 'completed'
    && task.phase !== 'canceled'
    && task.phase !== 'failed'
    && task.phase !== 'unknown'
    ? { ...task, cancelRequested: true }
    : task;
  return next;
}

function taskPhaseLabel(phase: TransferTask['phase']): string {
  const labels: Record<TransferTask['phase'], string> = {
    queued: translate('排队中'),
    transferring: translate('传输中'),
    completed: translate('已完成'),
    canceled: translate('已取消'),
    failed: translate('失败'),
    unknown: translate('状态未知'),
  };
  return labels[phase];
}

function editorPhaseLabel(phase: EditorPhase): string {
  const labels: Record<EditorPhase, string> = {
    clean: translate('已保存'),
    dirty: translate('有未保存修改'),
    saving: translate('保存中'),
    conflict: translate('远端冲突'),
    unknown: translate('保存结果未知'),
    error: translate('保存失败'),
  };
  return labels[phase];
}

function progressLabel(task: TransferTask): string {
  if (task.total === undefined) {
    return translate('{{transferred}} 字节', { transferred: formatNumber(task.transferred) });
  }
  return translate('{{transferred}} / {{total}} 字节', {
    transferred: formatNumber(task.transferred),
    total: formatNumber(task.total),
  });
}

function isTerminalTask(task: TransferTask): boolean {
  return task.phase === 'completed' || task.phase === 'canceled' || task.phase === 'failed' || task.phase === 'unknown';
}


function saveFailurePhase(error: unknown): EditorPhase {
  if (error instanceof z.ZodError) {
    return 'unknown';
  }
  const message = errorMessage(error, '').toLowerCase();
  if (message.includes('conflict') || message.includes('409') || message.includes('版本冲突')) {
    return 'conflict';
  }
  if (message.includes('unknown') || message.includes('timeout') || message.includes('network') || message.includes('connection') || message.includes('disconnect') || message.includes('断开') || message.includes('超时')) {
    return 'unknown';
  }
  return 'error';
}


function mutationDialogTitle(dialog: DialogState): string {
  switch (dialog.kind) {
    case 'mkdir':
      return translate('新建远端目录');
    case 'rename':
      return translate('重命名远端项目');
    case 'remove':
      return translate('确认删除远端项目');
    case 'save-editor':
      return translate('确认保存到远端');
    case 'close-editor':
      return translate('关闭未保存文件');
    case 'adopt-remote':
      return translate('以新远端版本继续');
  }
}

export default function FilesPane({
  session,
  preferences,
  compact = false,
  transferTarget,
  onLocationChange,
  onTransferTasksCreated,
  onDirtyChange,
}: FilesPaneProps) {
  const { t, locale } = useI18n();
  const theme = useTheme(preferences.theme);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [pathInput, setPathInput] = useState('/');
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(['/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  const [cancelingTaskIds, setCancelingTaskIds] = useState<string[]>([]);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [editors, setEditors] = useState<EditorTab[]>([]);
  const [activeEditorId, setActiveEditorId] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogInput, setDialogInput] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationOutcomeUnknown, setMutationOutcomeUnknown] = useState(false);
  const mutationBusyRef = useRef(mutationBusy);

  const listRequestRef = useRef(0);
  const textReadRequestRef = useRef(0);
  const remoteReadRequestRef = useRef(0);
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  const activePathRef = useRef('/');
  const editorsRef = useRef(editors);
  const startedSessionRef = useRef<string | null>(null);
  const sessionKey = `${session.id}:${session.generation}`;
  const currentSessionRef = useRef(sessionKey);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onLocationChangeRef = useRef(onLocationChange);
  const onTransferTasksCreatedRef = useRef(onTransferTasksCreated);
  const reportedDirtyRef = useRef<boolean | null>(null);
  const dirtySessionRef = useRef(session.id);
  const sessionChanged = dirtySessionRef.current !== session.id;

  currentSessionRef.current = sessionKey;
  if (sessionChanged) {
    dirtySessionRef.current = session.id;
  }

  useEffect(() => {
    if (reportedDirtyRef.current === true) {
      onDirtyChangeRef.current?.(false);
    }
    reportedDirtyRef.current = null;
  }, [session.id]);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  useEffect(() => {
    onLocationChangeRef.current = onLocationChange;
  }, [onLocationChange]);

  useEffect(() => {
    onTransferTasksCreatedRef.current = onTransferTasksCreated;
  }, [onTransferTasksCreated]);

  useEffect(() => () => {
    reportedDirtyRef.current = null;
    onDirtyChangeRef.current?.(false);
    onLocationChangeRef.current?.(null);
  }, []);

  useEffect(() => {
    mutationBusyRef.current = mutationBusy;
  }, [mutationBusy]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  useEffect(() => {
    editorsRef.current = editors;
  }, [editors]);

  const sessionReady = session.phase === 'active';
  const saveCapability = session.capabilities.textSave ?? {
    state: 'unknown',
    reason: t('当前服务端没有声明文本保存能力。'),
  };
  const conditionalSaveCapability = session.capabilities.conditionalSave ?? {
    state: 'unknown',
    reason: t('当前服务端没有声明条件保存能力。'),
  };
  const atomicCompareAndSwapCapability = session.capabilities.atomicCompareAndSwap ?? {
    state: 'unknown',
    reason: t('当前服务端没有声明全局原子比较并替换能力。'),
  };
  const editorOptions = useMemo(() => ({
    ariaLabel: t('远端文本编辑器'),
    fontFamily: preferences.editorFont,
    fontSize: preferences.editorFontSize,
    tabSize: preferences.editorTabSize,
    wordWrap: preferences.fileWordWrap ? 'on' as const : 'off' as const,
    minimap: { enabled: false },
  }), [locale, preferences.editorFont, preferences.editorFontSize, preferences.editorTabSize, preferences.fileWordWrap, t]);
  const fileTypeLabels = useMemo(() => ({
    link: t('符号链接'),
    directory: t('目录'),
    file: t('普通文件'),
  }), [locale, t]);
  const transferDirectionLabels = useMemo(() => ({
    copy: t('远端复制'),
    upload: t('上传到远端'),
    download: t('下载到已选位置'),
  }), [locale, t]);

  const updateEditor = useCallback((editorId: string, update: (current: EditorTab) => EditorTab) => {
    setEditors((current) => current.map((editor) => (editor.id === editorId ? update(editor) : editor)));
  }, []);

  const loadDirectory = useCallback(async (requestedPath: string, historyMode: 'push' | 'keep' = 'push'): Promise<boolean> => {
    if (session.phase !== 'active') {
      setPageError(t('文件会话尚未就绪，无法读取远端目录。'));
      return false;
    }

    const requestId = listRequestRef.current + 1;
    const requestSession = sessionKey;
    listRequestRef.current = requestId;
    setLoading(true);
    setPageError(null);
    setNotice(null);

    try {
      const result = await bridge().invoke('files.list', { sessionId: session.id, path: requestedPath });
      const parsed = fileListingSchema.parse(result);
      if (requestId !== listRequestRef.current || currentSessionRef.current !== requestSession) {
        return false;
      }

      setListing(parsed);
      onLocationChangeRef.current?.(parsed);
      activePathRef.current = parsed.path;
      setPathInput(parsed.path);
      setSelectedPath(null);
      if (historyMode === 'push') {
        const previous = historyRef.current;
        const previousIndex = historyIndexRef.current;
        if (previous[previousIndex] !== parsed.path) {
          const next = [...previous.slice(0, previousIndex + 1), parsed.path];
          historyRef.current = next;
          historyIndexRef.current = next.length - 1;
          setHistory(next);
          setHistoryIndex(next.length - 1);
        }
      }
      return true;
    } catch (error) {
      if (requestId === listRequestRef.current && currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t('无法读取远端目录。')));
      }
      return false;
    } finally {
      if (requestId === listRequestRef.current && currentSessionRef.current === requestSession) {
        setLoading(false);
      }
    }
  }, [session.id, session.phase, sessionKey, t]);

  useEffect(() => {
    listRequestRef.current += 1;
    textReadRequestRef.current += 1;
    remoteReadRequestRef.current += 1;
    historyRef.current = ['/'];
    historyIndexRef.current = 0;
    activePathRef.current = '/';
    startedSessionRef.current = null;
    setListing(null);
    onLocationChangeRef.current?.(null);
    setPathInput('/');
    setHistory(['/']);
    setHistoryIndex(0);
    setSelectedPath(null);
    setTasks([]);
    setCancelingTaskIds([]);
    setOpeningPath(null);
    setEditors([]);
    setActiveEditorId(null);
    setShowDiff(false);
    setDialog(null);
    setDialogInput('');
    setDialogError(null);
    mutationBusyRef.current = false;
    setMutationBusy(false);
    setMutationOutcomeUnknown(false);
    setPageError(null);
    setNotice(null);
  }, [session.id]);

  useEffect(() => {
    textReadRequestRef.current += 1;
    remoteReadRequestRef.current += 1;
    setOpeningPath(null);
    if (!sessionChanged) {
      setEditors((current) => {
        if (!current.some((editor) => editor.phase === 'saving')) {
          return current;
        }
        return current.map((editor) => (
          editor.phase === 'saving'
            ? {
              ...editor,
              phase: 'unknown',
              savingRevision: undefined,
              message: t('文件会话已变化，保存结果未知；本地草稿已保留且不会自动重试。'),
            }
            : editor
        ));
      });
      if (mutationBusyRef.current) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
        setMutationOutcomeUnknown(true);
        setDialogError(t('文件会话已变化，远端请求结果未知。请先关闭对话框并刷新确认，勿盲目重试。'));
      }
    }
  }, [sessionChanged, sessionKey, t]);

  useEffect(() => {
    if (!sessionReady) {
      listRequestRef.current += 1;
      setLoading(false);
      startedSessionRef.current = null;
      return;
    }
    if (startedSessionRef.current === sessionKey) {
      return;
    }
    startedSessionRef.current = sessionKey;
    void loadDirectory(activePathRef.current, 'keep');
  }, [loadDirectory, sessionKey, sessionReady]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = bridge().subscribe((event) => {
        if (event.type !== 'task' || currentSessionRef.current !== sessionKey) {
          return;
        }
        const parsed = transferTaskSchema.safeParse(event.task);
        if (!parsed.success) {
          setPageError(t('收到无效的传输任务状态，已忽略该更新。'));
          return;
        }
        const task = parsed.data;
        if (task.sessionId !== session.id && task.sourceSessionId !== session.id) {
          return;
        }
        setTasks((current) => upsertTask(current, task));
        if (task.direction === 'upload' && task.sessionId === session.id && task.phase === 'completed') {
          void loadDirectory(activePathRef.current, 'keep');
        }
      });
    } catch (error) {
      setPageError(errorMessage(error, t('无法订阅传输任务状态。')));
    }
    return () => {
      unsubscribe?.();
    };
  }, [loadDirectory, session.id, sessionKey, t]);

  const selectedEntry = useMemo(
    () => listing?.entries.find((entry) => entry.path === selectedPath) ?? null,
    [listing, selectedPath],
  );

  const activeEditor = useMemo(
    () => editors.find((editor) => editor.id === activeEditorId) ?? null,
    [activeEditorId, editors],
  );

  const editorDirty = !sessionChanged && editors.some((editor) => (
    editor.content !== editor.baseline
    || editor.phase === 'saving'
    || editor.phase === 'unknown'
  ));

  useEffect(() => {
    if (reportedDirtyRef.current === editorDirty) {
      return;
    }
    reportedDirtyRef.current = editorDirty;
    onDirtyChangeRef.current?.(editorDirty);
  }, [editorDirty, session.id]);

  const registerTransferTasks = useCallback((payload: unknown): boolean => {
    const parsed = transferTasksSchema.safeParse(payload);
    if (!parsed.success) {
      setPageError(t('收到无效的传输任务响应，已拒绝该响应。'));
      return false;
    }
    if (parsed.data.length === 0) {
      setPageError(t('服务端未创建传输任务，已保留当前本地选择。'));
      return false;
    }
    if (parsed.data.some((task) => task.sessionId !== session.id && task.sourceSessionId !== session.id)) {
      setPageError(t('传输响应包含无关文件会话的任务，已拒绝该响应。'));
      return false;
    }
    setTasks((current) => parsed.data.reduce(upsertTask, current));
    onTransferTasksCreatedRef.current?.(parsed.data);
    return true;
  }, [session.id, t]);

  const breadcrumbs = useMemo(() => {
    const currentPath = listing?.path ?? activePathRef.current;
    const parts = currentPath.split('/').filter((part) => part.length > 0);
    let path = '';
    return [
      { label: '/', path: '/' },
      ...parts.map((part) => {
        path = `${path}/${part}`;
        return { label: part, path };
      }),
    ];
  }, [listing]);


  const openDialog = (nextDialog: DialogState, initialValue = '') => {
    setDialog(nextDialog);
    setDialogInput(initialValue);
    setDialogError(null);
    setMutationOutcomeUnknown(false);
  };

  const closeDialog = () => {
    if (!mutationBusy) {
      setDialog(null);
      setDialogInput('');
      setDialogError(null);
      setMutationOutcomeUnknown(false);
    }
  };


  const navigateTo = (path: string) => {
    void loadDirectory(path, 'push');
  };

  const navigateBack = async () => {
    const nextIndex = historyIndexRef.current - 1;
    if (nextIndex < 0) {
      return;
    }
    const target = historyRef.current[nextIndex];
    if (target === undefined) {
      return;
    }
    if (await loadDirectory(target, 'keep')) {
      historyIndexRef.current = nextIndex;
      setHistoryIndex(nextIndex);
    }
  };

  const navigateForward = async () => {
    const nextIndex = historyIndexRef.current + 1;
    const target = historyRef.current[nextIndex];
    if (target === undefined) {
      return;
    }
    if (await loadDirectory(target, 'keep')) {
      historyIndexRef.current = nextIndex;
      setHistoryIndex(nextIndex);
    }
  };

  const openTextFile = async (entry: RemoteFile) => {
    if (entry.type !== 'file' || openingPath !== null || !sessionReady) {
      return;
    }
    const existing = editorsRef.current.find((editor) => editor.path === entry.path);
    if (existing !== undefined) {
      setActiveEditorId(existing.id);
      setShowDiff(false);
      return;
    }

    const requestId = textReadRequestRef.current + 1;
    const requestSession = sessionKey;
    textReadRequestRef.current = requestId;
    setOpeningPath(entry.path);
    setPageError(null);
    try {
      const result = await bridge().invoke('files.readText', { sessionId: session.id, path: entry.path });
      const parsed = textFileSchema.parse(result);
      if (requestId !== textReadRequestRef.current || currentSessionRef.current !== requestSession) {
        return;
      }
      if (parsed.path !== entry.path) {
        throw new Error(t('读取响应的远端路径与请求不一致。'));
      }
      const alreadyOpen = editorsRef.current.find((editor) => editor.path === parsed.path);
      if (alreadyOpen !== undefined) {
        setActiveEditorId(alreadyOpen.id);
        return;
      }
      const editor: EditorTab = {
        id: `remote:${parsed.path}:${requestId}`,
        path: parsed.path,
        title: basename(parsed.path) || parsed.path,
        content: parsed.content,
        baseline: parsed.content,
        version: parsed.version,
        writable: parsed.writable,
        reason: parsed.reason,
        revision: 0,
        phase: 'clean',
      };
      setEditors((current) => [...current, editor]);
      setActiveEditorId(editor.id);
      setShowDiff(false);
    } catch (error) {
      if (requestId === textReadRequestRef.current && currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t('无法以文本方式打开该远端文件。文件可能是二进制、过大或没有读取权限。')));
      }
    } finally {
      if (requestId === textReadRequestRef.current && currentSessionRef.current === requestSession) {
        setOpeningPath(null);
      }
    }
  };

  const startUpload = async () => {
    if (listing === null || !sessionReady) {
      return;
    }
    const requestSession = sessionKey;
    const path = listing.path;
    setPageError(null);
    setNotice(null);
    try {
      const result = await bridge().invoke('files.upload', { sessionId: session.id, path });
      const parsed = transferTasksSchema.parse(result);
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      if (parsed.length === 0) {
        setNotice(t('未创建上传任务：系统文件选择可能已取消。'));
        return;
      }
      if (!registerTransferTasks(parsed)) {
        return;
      }
      setNotice(t('已创建 {{count}} 个上传任务，传输状态将在下方更新。', { count: parsed.length }));
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t('无法创建上传任务。')));
      }
    }
  };

  const startDroppedUpload = async (grantId: string, relativePaths: string[], path: string) => {
    if (!sessionReady) {
      return;
    }
    const requestSession = sessionKey;
    setPageError(null);
    setNotice(null);
    try {
      const result = await bridge().invoke('files.uploadLocal', { sessionId: session.id, grantId, relativePaths, path });
      const parsed = transferTasksSchema.parse(result);
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      if (parsed.length === 0) {
        setPageError(t('服务端未为拖入的已授权文件创建传输任务。'));
        return;
      }
      if (!registerTransferTasks(parsed)) {
        return;
      }
      setNotice(t('已创建 {{count}} 个本地上传任务，传输状态将在下方更新。', { count: parsed.length }));
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t('上传未开始。')));
      }
    }
  };

  const startDownload = async () => {
    if (selectedEntry === null || selectedEntry.type !== 'file' || !sessionReady) {
      return;
    }
    const requestSession = sessionKey;
    const entry = selectedEntry;
    setPageError(null);
    setNotice(null);
    try {
      const result = await bridge().invoke('files.download', {
        sessionId: session.id,
        path: entry.path,
        name: entry.name,
      });
      const parsed = transferTaskSchema.nullable().parse(result);
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      if (parsed === null) {
        setNotice(t('未创建下载任务：系统保存位置选择可能已取消。'));
        return;
      }
      if (!registerTransferTasks([parsed])) {
        return;
      }
      setNotice(t('已创建下载任务，传输状态将在下方更新。'));
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t('无法创建下载任务。')));
      }
    }
  };

  const startTargetTransfer = async () => {
    if (selectedEntry === null || selectedEntry.type !== 'file' || transferTarget === undefined || !sessionReady) {
      return;
    }
    const requestSession = sessionKey;
    const entry = selectedEntry;
    setPageError(null);
    setNotice(null);
    try {
      const result = transferTarget.kind === 'local'
        ? await bridge().invoke('files.downloadLocal', {
          sessionId: session.id,
          grantId: transferTarget.grantId,
          relativePath: transferTarget.relativePath,
          path: entry.path,
          name: entry.name,
        })
        : await bridge().invoke('files.copy', {
          sessionId: session.id,
          targetSessionId: transferTarget.sessionId,
          path: entry.path,
          targetPath: transferTarget.path,
          name: entry.name,
        });
      const parsed = transferTaskSchema.parse(result);
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      if (!registerTransferTasks([parsed])) {
        return;
      }
      setNotice(transferTarget.kind === 'local'
        ? t('已创建到已授权本地目录的下载任务。')
        : t('已创建到“{{name}}”的远端复制任务。', { name: plainText(transferTarget.label, 80) }));
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t(transferTarget.kind === 'local' ? '无法创建本地下载任务。' : '无法创建远端复制任务。')));
      }
    }
  };

  const startDroppedRemoteCopy = async (source: { sessionId: string; path: string; name: string; type: 'file' | 'directory' | 'link' }, targetPath: string) => {
    if (!sessionReady || source.type !== 'file') {
      return;
    }
    const requestSession = sessionKey;
    setPageError(null);
    setNotice(null);
    try {
      const result = await bridge().invoke('files.copy', {
        sessionId: source.sessionId,
        targetSessionId: session.id,
        path: source.path,
        targetPath,
        name: source.name,
      });
      const parsed = transferTaskSchema.parse(result);
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      if (!registerTransferTasks([parsed])) {
        return;
      }
      setNotice(t('已创建“{{name}}”的远端文件复制任务。', { name: plainText(source.name, 80) }));
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t('远端文件复制未开始。')));
      }
    }
  };

  const cancelTask = async (task: TransferTask) => {
    if (isTerminalTask(task) || task.cancelRequested === true || cancelingTaskIds.includes(task.id)) {
      return;
    }
    const requestSession = sessionKey;
    setCancelingTaskIds((current) => [...current, task.id]);
    setPageError(null);
    try {
      await bridge().invoke('tasks.cancel', { taskId: task.id });
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      setTasks((current) => current.map((candidate) => (
        candidate.id === task.id ? { ...candidate, cancelRequested: true } : candidate
      )));
      setNotice(t('已发送取消“{{name}}”的请求，等待服务端任务状态确认。', { name: plainText(task.name) }));
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setPageError(errorMessage(error, t('无法请求取消传输任务。')));
      }
    } finally {
      if (currentSessionRef.current === requestSession) {
        setCancelingTaskIds((current) => current.filter((id) => id !== task.id));
      }
    }
  };

  const submitMkdir = async () => {
    if (listing === null) {
      return;
    }
    const name = dialogInput.trim();
    const validationError = validateRemoteName(name);
    if (validationError !== null) {
      setDialogError(validationError);
      return;
    }
    const requestSession = sessionKey;
    const path = listing.path;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      await bridge().invoke('files.mkdir', { sessionId: session.id, path: joinRemotePath(path, name) });
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      setDialog(null);
      setDialogInput('');
      const refreshed = await loadDirectory(path, 'keep');
      if (currentSessionRef.current === requestSession) {
        setNotice(refreshed ? t('远端目录已创建。') : t('创建请求已确认，但目录刷新失败。'));
      }
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setDialogError(errorMessage(error, t('无法创建远端目录。')));
      }
    } finally {
      if (currentSessionRef.current === requestSession) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  };

  const submitRename = async (entry: RemoteFile) => {
    const name = dialogInput.trim();
    const validationError = validateRemoteName(name);
    if (validationError !== null) {
      setDialogError(validationError);
      return;
    }
    if (name === entry.name) {
      setDialogError(t('新名称与当前名称相同。'));
      return;
    }
    const requestSession = sessionKey;
    const path = entry.path;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      await bridge().invoke('files.rename', { sessionId: session.id, path, newName: name });
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      setDialog(null);
      setDialogInput('');
      const refreshed = await loadDirectory(activePathRef.current, 'keep');
      if (currentSessionRef.current === requestSession) {
        setNotice(refreshed ? t('远端项目已重命名。') : t('重命名请求已确认，但目录刷新失败。'));
      }
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setDialogError(errorMessage(error, t('无法重命名远端项目。')));
      }
    } finally {
      if (currentSessionRef.current === requestSession) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  };

  const submitRemove = async (entry: RemoteFile) => {
    if (dialogInput !== entry.name) {
      setDialogError(t('请输入完全一致的项目名称以确认删除。'));
      return;
    }
    const requestSession = sessionKey;
    const path = entry.path;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      await bridge().invoke('files.remove', { sessionId: session.id, path, directory: entry.type === 'directory' });
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      setDialog(null);
      setDialogInput('');
      const refreshed = await loadDirectory(activePathRef.current, 'keep');
      if (currentSessionRef.current === requestSession) {
        setNotice(refreshed ? t('远端项目已删除。') : t('删除请求已确认，但目录刷新失败。'));
      }
    } catch (error) {
      if (currentSessionRef.current === requestSession) {
        setDialogError(errorMessage(error, t('无法删除远端项目。')));
      }
    } finally {
      if (currentSessionRef.current === requestSession) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  };

  const saveEditor = async (editorId: string) => {
    const snapshot = editorsRef.current.find((editor) => editor.id === editorId);
    if (snapshot === undefined) {
      return;
    }
    if (saveCapability.state !== 'supported' || !snapshot.writable || snapshot.content === snapshot.baseline || snapshot.phase === 'saving') {
      return;
    }

    const requestSession = sessionKey;
    const savingRevision = snapshot.revision;
    updateEditor(editorId, (current) => ({
      ...current,
      phase: 'saving',
      savingRevision,
      message: t('正在等待服务端确认条件保存。'),
    }));

    try {
      const result = await bridge().invoke('files.saveText', {
        sessionId: session.id,
        path: snapshot.path,
        content: snapshot.content,
        version: snapshot.version,
      });
      const saved = textFileSchema.parse(result);
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      if (saved.path !== snapshot.path) {
        throw new Error(t('保存响应的远端路径与请求不一致。'));
      }
      updateEditor(editorId, (current) => {
        const latestChangedDuringSave = current.revision !== savingRevision;
        return {
          ...current,
          path: saved.path,
          title: basename(saved.path) || saved.path,
          content: latestChangedDuringSave ? current.content : saved.content,
          baseline: saved.content,
          version: saved.version,
          writable: saved.writable,
          reason: saved.reason,
          savingRevision: undefined,
          phase: latestChangedDuringSave ? 'dirty' : 'clean',
          message: latestChangedDuringSave ? t('服务端已确认先前版本；保存期间的后续编辑仍未保存。') : t('服务端已确认保存。'),
          remoteRevision: undefined,
        };
      });
    } catch (error) {
      if (currentSessionRef.current !== requestSession) {
        return;
      }
      const phase = saveFailurePhase(error);
      const fallback = phase === 'conflict'
        ? t('远端文件已变化，未覆盖本地草稿。')
        : phase === 'unknown'
          ? t('保存结果未知，未丢弃本地草稿。')
          : t('保存失败，未丢弃本地草稿。');
      updateEditor(editorId, (current) => ({
        ...current,
        savingRevision: undefined,
        phase,
        message: errorMessage(error, fallback),
      }));
    }
  };

  const readRemoteRevision = async (editorId: string) => {
    const snapshot = editorsRef.current.find((editor) => editor.id === editorId);
    if (snapshot === undefined || snapshot.phase === 'saving') {
      return;
    }
    const requestId = remoteReadRequestRef.current + 1;
    const requestSession = sessionKey;
    remoteReadRequestRef.current = requestId;
    updateEditor(editorId, (current) => ({ ...current, message: t('正在重新读取远端版本。') }));
    try {
      const result = await bridge().invoke('files.readText', { sessionId: session.id, path: snapshot.path });
      const remote = textFileSchema.parse(result);
      if (requestId !== remoteReadRequestRef.current || currentSessionRef.current !== requestSession) {
        return;
      }
      if (remote.path !== snapshot.path) {
        throw new Error(t('重新读取响应的远端路径与请求不一致。'));
      }
      const latest = editorsRef.current.find((editor) => editor.id === editorId);
      if (latest?.version !== snapshot.version) {
        return;
      }
      updateEditor(editorId, (current) => {
        if (current.version !== snapshot.version) {
          return current;
        }
        if (remote.content === current.content) {
          return {
            ...current,
            baseline: remote.content,
            version: remote.version,
            writable: remote.writable,
            reason: remote.reason,
            phase: 'clean',
            message: t('已确认远端内容与当前草稿一致。'),
            remoteRevision: undefined,
          };
        }
        return {
          ...current,
          phase: current.phase === 'unknown' ? 'unknown' : 'conflict',
          message: t('已读取新远端版本；本地草稿和原始基线均被保留。请比较后明确选择后续操作。'),
          remoteRevision: {
            content: remote.content,
            version: remote.version,
            writable: remote.writable,
            reason: remote.reason,
          },
        };
      });
      setShowDiff(true);
    } catch (error) {
      if (requestId === remoteReadRequestRef.current && currentSessionRef.current === requestSession) {
        updateEditor(editorId, (current) => ({
          ...current,
          message: errorMessage(error, t('无法重新读取远端版本；本地草稿仍在。')),
        }));
      }
    }
  };

  const adoptRemoteRevision = (editorId: string) => {
    updateEditor(editorId, (current) => {
      const remote = current.remoteRevision;
      if (remote === undefined) {
        return current;
      }
      return {
        ...current,
        baseline: remote.content,
        version: remote.version,
        writable: remote.writable,
        reason: remote.reason,
        phase: current.content === remote.content ? 'clean' : 'dirty',
        message: current.content === remote.content
          ? t('当前内容与新远端版本一致。')
          : t('已将新远端版本设为保存基线；本地草稿未修改。'),
        remoteRevision: undefined,
      };
    });
    setDialog(null);
    setDialogError(null);
  };

  const closeEditor = (editorId: string) => {
    setEditors((current) => current.filter((editor) => editor.id !== editorId));
    setActiveEditorId((current) => {
      if (current !== editorId) {
        return current;
      }
      const remaining = editorsRef.current.filter((editor) => editor.id !== editorId);
      return remaining.at(-1)?.id ?? null;
    });
    setShowDiff(false);
    setDialog(null);
    setDialogError(null);
  };

  const submitDialog = () => {
    if (dialog === null || mutationBusy || mutationOutcomeUnknown) {
      return;
    }
    switch (dialog.kind) {
      case 'mkdir':
        void submitMkdir();
        return;
      case 'rename':
        void submitRename(dialog.entry);
        return;
      case 'remove':
        void submitRemove(dialog.entry);
        return;
      case 'save-editor':
        setDialog(null);
        setDialogError(null);
        void saveEditor(dialog.editorId);
        return;
      case 'close-editor':
        closeEditor(dialog.editorId);
        return;
      case 'adopt-remote':
        adoptRemoteRevision(dialog.editorId);
    }
  };

  const onEditorChange = (value: string | undefined) => {
    if (activeEditorId === null) {
      return;
    }
    const content = value ?? '';
    updateEditor(activeEditorId, (current) => {
      if (current.content === content) {
        return current;
      }
      const phase = current.phase === 'saving' || current.phase === 'conflict' || current.phase === 'unknown'
        ? current.phase
        : content === current.baseline ? 'clean' : 'dirty';
      return {
        ...current,
        content,
        revision: current.revision + 1,
        phase,
        message: current.phase === 'saving' ? t('保存请求仍在进行；后续编辑会保留为未保存草稿。') : current.message,
      };
    });
  };

  const canSaveActiveEditor = activeEditor !== null
    && activeEditor.content !== activeEditor.baseline
    && activeEditor.writable
    && activeEditor.phase !== 'saving'
    && activeEditor.phase !== 'conflict'
    && activeEditor.phase !== 'unknown'
    && saveCapability.state === 'supported';

  const dialogPrimaryLabel = mutationOutcomeUnknown
    ? t('请先关闭并刷新核验')
    : dialog?.kind === 'remove'
      ? t('删除')
      : dialog?.kind === 'close-editor'
        ? t('放弃草稿并关闭')
        : dialog?.kind === 'save-editor'
          ? t('保存到远端')
          : dialog?.kind === 'adopt-remote'
            ? t('继续并保留草稿')
            : t('确认');

  const sessionProblem = session.phase === 'failed'
    ? session.error || t('文件会话建立失败。')
    : session.phase === 'lost'
      ? t('文件会话已断开。重新连接后再继续操作。')
      : session.phase === 'closed'
        ? t('文件会话已关闭。')
        : session.phase === 'connecting'
          ? t('正在建立已授权的文件会话。')
          : null;

  return (
    <section className={`files-pane ${compact ? 'files-pane--compact' : ''}`} aria-label={t('远端文件工作区')}>{sessionProblem !== null && (
      <div className="files-pane__state files-pane__state--connection" role="status">
        {plainText(sessionProblem)}
      </div>
    )}
    
    {pageError !== null && (
      <div className="files-pane__state files-pane__state--error" role="alert">
        <strong>{isPermissionError(pageError) ? t('无权访问此远端路径') : t('远端操作未完成')}</strong>
        <span>{plainText(pageError, 360)}</span>
        {isPermissionError(pageError) && <small>{t('请确认当前资产、账号和文件权限后重试；应用不会改走终端命令绕过授权。')}</small>}
      </div>
    )}
    
    {notice !== null && (
      <div className="files-pane__state files-pane__state--notice" role="status">{plainText(notice, 360)}</div>
    )}
    
    <div
      className="files-pane__remote-panel"
      onDragOver={(event) => {
        const acceptsLocal = event.dataTransfer.types.includes('application/x-jms-local');
        const acceptsRemote = event.dataTransfer.types.includes('application/x-jms-remote');
        if (listing !== null && sessionReady && (acceptsLocal || acceptsRemote)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event) => {
        if (listing === null || !sessionReady) {
          return;
        }
        const localPayload = event.dataTransfer.getData('application/x-jms-local');
        if (localPayload) {
          event.preventDefault();
          try {
            const grant = z.object({
              grantId: z.string().uuid(),
              relativePaths: z.array(z.string().min(1).max(4096)).min(1).max(1000),
            }).strict().parse(JSON.parse(localPayload));
            void startDroppedUpload(grant.grantId, grant.relativePaths, listing.path);
          } catch {
            setPageError(t('拖入数据不合法，请从已授权本地目录重新选择文件。'));
          }
          return;
        }
    
        const remotePayload = event.dataTransfer.getData('application/x-jms-remote');
        if (!remotePayload) {
          return;
        }
        event.preventDefault();
        try {
          const source = z.object({
            sessionId: z.string().min(1).max(200),
            path: z.string().min(1).max(4096),
            name: z.string().min(1).max(1024),
            type: z.enum(['file', 'directory', 'link']),
          }).strict().parse(JSON.parse(remotePayload));
          if (source.type !== 'file') {
            setPageError(t('远端拖放仅支持普通文件；目录和符号链接不能复制。'));
            return;
          }
          void startDroppedRemoteCopy(source, listing.path);
        } catch {
          setPageError(t('拖入的远端文件数据无效，请从已授权远端文件列表重新拖动。'));
        }
      }}
    >
      <nav className="files-pane__breadcrumbs" aria-label={t('远端路径面包屑')}>
        {breadcrumbs.map((crumb, index) => (
          <span className="files-pane__breadcrumb-item" key={crumb.path}>
            {index > 0 && <span aria-hidden="true">/</span>}
            <Button type="button" variant="ghost" onPress={() => navigateTo(crumb.path)} isDisabled={!sessionReady || loading}>{plainText(crumb.label)}</Button>
          </span>
        ))}
      </nav>
      <form className="files-pane__path-form" onSubmit={(event) => {
        event.preventDefault();
        const path = pathInput.trim();
        if (path) {
          navigateTo(path);
        }
      }}>
        <Button type="button" variant="ghost" aria-label={t('后退')} onPress={() => void navigateBack()} isDisabled={!sessionReady || loading || historyIndex <= 0}><ChevronLeft size={16} /></Button>
        <Button type="button" variant="ghost" aria-label={t('前进')} onPress={() => void navigateForward()} isDisabled={!sessionReady || loading || historyIndex >= history.length - 1}><ChevronRight size={16} /></Button>
        <Button type="button" variant="ghost" aria-label={t('上级目录')} onPress={() => navigateTo(parentPath(listing?.path ?? pathInput))} isDisabled={!sessionReady || loading || (listing?.path ?? '/') === '/'}><ArrowUp size={16} /></Button>
        <Input variant="secondary" aria-label={t('远端路径')} value={pathInput} onChange={(event) => setPathInput(event.target.value)} disabled={!sessionReady || loading} spellCheck={false} />
        <Button className="files-pane__path-go" type="submit" variant="secondary" isDisabled={!sessionReady || loading}>{t('前往')}</Button>
        <Button type="button" variant="ghost" aria-label={t('刷新远端目录')} onPress={() => void loadDirectory(activePathRef.current, 'keep')} isDisabled={!sessionReady || loading}><RefreshCw size={15} /></Button>
      </form>
      <div className="files-pane__remote-actions" role="toolbar" aria-label={t('远端文件操作')}>
        <Button className="files-pane__toolbar-button" type="button" variant="secondary" onPress={() => void startUpload()} isDisabled={!sessionReady || listing === null}><Upload size={15} />{t('上传…')}</Button>
        <Button className="files-pane__toolbar-button" type="button" variant="secondary" onPress={() => void startDownload()} isDisabled={!sessionReady || selectedEntry?.type !== 'file'}><Download size={15} />{t('下载…')}</Button>
        {transferTarget !== undefined && (
          <Button className="files-pane__toolbar-button"
          type="button"
          variant="secondary"
          
          onPress={() => void startTargetTransfer()}
          isDisabled={!sessionReady || selectedEntry?.type !== 'file'} render={(buttonProps) => <button {...buttonProps} title={transferTarget.kind === 'local'
             ? t('下载到当前已授权本地目录')
             : t('复制到 {{name}}', { name: plainText(transferTarget.label, 120) })} />} > {transferTarget.kind === 'local' ? <Download size={15} /> : <Copy size={15} />}
          {transferTarget.kind === 'local'
            ? t('传输到本地')
            : t('复制到 {{name}}', { name: plainText(transferTarget.label, 28) })}</Button>
        )}
        <Button type="button" variant="secondary" onPress={() => openDialog({ kind: 'mkdir' })} isDisabled={!sessionReady || listing === null || loading}>{t('新建目录')}</Button>
        <Button type="button" variant="secondary" onPress={() => selectedEntry !== null && openDialog({ kind: 'rename', entry: selectedEntry }, selectedEntry.name)} isDisabled={!sessionReady || selectedEntry === null || loading}>{t('重命名')}</Button>
        <Button type="button" variant="danger" onPress={() => selectedEntry !== null && openDialog({ kind: 'remove', entry: selectedEntry })} isDisabled={!sessionReady || selectedEntry === null || loading}>{t('删除')}</Button>
        <Button type="button" variant="secondary" onPress={() => selectedEntry !== null && void openTextFile(selectedEntry)} isDisabled={!sessionReady || selectedEntry?.type !== 'file' || openingPath !== null}>{openingPath === selectedEntry?.path ? t('正在打开…') : t('编辑文本')}</Button>
        <span className="files-pane__entry-count" aria-live="polite">{listing === null ? t('未读取') : t('共有 {{count}} 项', { count: formatNumber(listing.entries.length) })}</span>
      </div>
    
      <div className="files-pane__table" role="table" aria-label={t('远端文件列表')}>
        <div className="files-pane__file-head" role="row">
          <span role="columnheader">{t('名称')}</span>
          <span role="columnheader">{t('大小')}</span>
          <span role="columnheader">{t('修改时间')}</span>
          <span role="columnheader">{t('权限')}</span>
          <span role="columnheader">{t('类型')}</span>
        </div>
        {loading && listing === null && <div className="files-pane__listing-state" role="status">{t('正在读取已授权远端目录…')}</div>}
        {!loading && listing !== null && listing.entries.length === 0 && <div className="files-pane__listing-state">{t('此远端目录为空。')}</div>}
        {listing?.entries.map((entry) => (
          <Button className={`files-pane__file-row ${entry.path === selectedPath ? 'files-pane__file-row--selected' : ''}`}
          type="button"
          variant="ghost"
          
          key={entry.path}
          aria-pressed={entry.path === selectedPath}
          
          
          onClick={() => setSelectedPath(entry.path)}
          onDoubleClick={() => {
            if (entry.type === 'directory') {
              navigateTo(entry.path);
            } else {
              void openTextFile(entry);
            }
          }} render={(buttonProps) => <button {...buttonProps} role="row" draggable onDragStart={(event) => {
             event.dataTransfer.effectAllowed = 'copy';
             event.dataTransfer.setData('application/x-jms-remote', JSON.stringify({
               sessionId: session.id,
               path: entry.path,
               name: entry.name,
               type: entry.type,
             }));
           }} />} > <span className="files-pane__file-name" role="cell" title={plainText(entry.path)}>
            <span className={`files-pane__entry-type files-pane__entry-type--${entry.type}`} aria-hidden="true">{entry.type === 'directory' ? <Folder size={16} /> : entry.type === 'link' ? <Link size={16} /> : <File size={16} />}</span>
            {plainText(entry.name)}
          </span>
          <span role="cell">{plainText(entry.size, 60)}</span>
          <span role="cell">{plainText(entry.modified, 80)}</span>
          <span role="cell">{plainText(entry.permissions, 60)}</span>
          <span role="cell">{fileTypeLabels[entry.type]}</span></Button>
        ))}
      </div>
    
      {tasks.length > 0 && (
        <section className="files-pane__task-section" aria-label={t('相关传输任务')}>
          <div className="files-pane__task-heading">
            <span>{t('传输任务')}</span>
            <small>{t('共有 {{count}} 个传输任务', { count: formatNumber(tasks.length) })}</small>
          </div>
          <div className="files-pane__task-list" aria-live="polite">
            {tasks.map((task) => {
              const percentage = task.total === undefined || task.total === 0 ? null : Math.min(100, Math.round((task.transferred / task.total) * 100));
              const cancellationPending = !isTerminalTask(task) && (task.cancelRequested === true || cancelingTaskIds.includes(task.id));
              const phaseClass = cancellationPending ? 'cancel-requested' : task.phase;
              const direction = task.sourceSessionId !== undefined
                ? transferDirectionLabels.copy
                : task.direction === 'upload'
                  ? transferDirectionLabels.upload
                  : transferDirectionLabels.download;
              return (
                <article className="files-pane__task" key={task.id}>
                  <div className="files-pane__task-topline">
                    <span className="files-pane__task-name" title={plainText(task.name)}>{plainText(task.name, 80)}</span>
                    <span className={`files-pane__task-phase files-pane__task-phase--${phaseClass}`}>{cancellationPending ? t('取消请求待确认') : taskPhaseLabel(task.phase)}</span>
                  </div>
                  <span className="files-pane__task-direction">{direction} · {progressLabel(task)}</span>
                  {percentage !== null && <progress className="files-pane__task-progress" value={percentage} max="100">{percentage}%</progress>}
                  {task.error !== undefined && <span className="files-pane__task-error">{plainText(translateDiagnostic(task.error), 180)}</span>}
                  {!isTerminalTask(task) && (
                    <Button className="files-pane__text-button" type="button" variant="ghost" isDisabled={cancellationPending} onPress={() => void cancelTask(task)}>{cancellationPending ? t('取消请求待确认') : t('取消任务')}</Button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
    
    {editors.length > 0 && <section className="files-pane__editor-area" aria-label={t('远端文本编辑器')}>
      <div className="files-pane__editor-heading">
        <div>
          <span>{t('文本编辑器')}</span>
        </div>
        {activeEditor !== null && (
          <div className="files-pane__editor-actions">
            <Button type="button" variant="secondary" onPress={() => setShowDiff((current) => !current)}>{showDiff ? t('返回编辑') : t('比较基线')}</Button>
            <Button type="button" variant="secondary" onPress={() => openDialog({ kind: 'save-editor', editorId: activeEditor.id })} isDisabled={!canSaveActiveEditor}>{t('保存到远端')}</Button>
          </div>
        )}
      </div>
    
      {editors.length > 0 && (
        <div className="files-pane__editor-tabs" role="tablist" aria-label={t('已打开远端文件')}>
          {editors.map((editor) => (
            <div className={`files-pane__editor-tab ${editor.id === activeEditorId ? 'files-pane__editor-tab--active' : ''}`} key={editor.id}>
              <Button type="button" variant="ghost"   onPress={() => { setActiveEditorId(editor.id); setShowDiff(false); }} render={(buttonProps) => <button {...buttonProps} role="tab"  aria-selected={editor.id === activeEditorId} />} > <span>{editor.phase === 'dirty' || editor.phase === 'saving' || editor.phase === 'conflict' || editor.phase === 'unknown' || editor.phase === 'error' ? '● ' : ''}</span>
              {plainText(editor.title, 48)}</Button>
              <Button className="files-pane__editor-close" type="button" variant="ghost" aria-label={t('关闭 {{name}}', { name: plainText(editor.title) })} onPress={() => {
                if (editor.content !== editor.baseline || editor.phase === 'saving' || editor.phase === 'conflict' || editor.phase === 'unknown' || editor.phase === 'error') {
                  openDialog({ kind: 'close-editor', editorId: editor.id });
                } else {
                  closeEditor(editor.id);
                }
              }}>×</Button>
            </div>
          ))}
        </div>
      )}
    
      {activeEditor === null ? (
        <div className="files-pane__editor-empty">{t('选择远端普通文件后点击“文本打开”。文件内容只通过已授权文件会话读取。')}</div>
      ) : (
        <div className="files-pane__editor-panel">
          <div className={`files-pane__editor-status files-pane__editor-status--${activeEditor.phase}`}>
            <strong>{editorPhaseLabel(activeEditor.phase)}</strong>
            <span>{activeEditor.message === undefined ? t('当前草稿仅保留在此已挂载文件面板中。') : plainText(translateDiagnostic(activeEditor.message), 300)}</span>
          </div>
          {!activeEditor.writable && (
            <div className="files-pane__editor-warning" role="status">{t('此文件为只读：{{reason}}', { reason: plainText(translateDiagnostic(activeEditor.reason || t('服务端未授予写入权限。'))) })}</div>
          )}
          {activeEditor.writable && activeEditor.reason !== undefined && (
            <div className="files-pane__editor-warning" role="status">{plainText(translateDiagnostic(activeEditor.reason))}</div>
          )}
          {activeEditor.writable && saveCapability.state !== 'supported' && (
            <div className="files-pane__editor-warning" role="status">{t('已禁用保存：{{reason}}', { reason: plainText(translateDiagnostic(saveCapability.reason || t('服务端未声明可验证的条件保存能力。'))) })}</div>
          )}
          {activeEditor.writable && saveCapability.state === 'supported' && conditionalSaveCapability.state !== 'supported' && (
            <div className="files-pane__editor-warning" role="status">{t('保存可用，但未声明条件保存保障：{{reason}}', { reason: plainText(translateDiagnostic(conditionalSaveCapability.reason || t('会话间并发修改无法由客户端承诺安全合并。'))) })}</div>
          )}
          {activeEditor.writable && saveCapability.state === 'supported' && atomicCompareAndSwapCapability.state !== 'supported' && (
            <div className="files-pane__editor-warning" role="status">{t('未声明全局原子比较并替换：{{reason}}', { reason: plainText(translateDiagnostic(atomicCompareAndSwapCapability.reason || t('多个服务端实例或外部编辑器之间不能承诺原子保存。'))) })}</div>
          )}
          {activeEditor.phase === 'conflict' && (
            <div className="files-pane__editor-recovery" role="alert">
              <span>{t('检测到远端版本冲突。本地草稿未覆盖远端。')}</span>
              <Button type="button" variant="ghost" onPress={() => void readRemoteRevision(activeEditor.id)}>{t('重新读取远端并保留草稿')}</Button>
              {activeEditor.remoteRevision !== undefined && <Button type="button" variant="ghost" onPress={() => openDialog({ kind: 'adopt-remote', editorId: activeEditor.id })}>{t('以新远端版本继续解决')}</Button>}
            </div>
          )}
          {activeEditor.phase === 'unknown' && (
            <div className="files-pane__editor-recovery" role="alert">
              <span>{t('保存结果未知。为避免无提示覆盖，未自动重试，草稿已保留。')}</span>
              <Button type="button" variant="ghost" onPress={() => void readRemoteRevision(activeEditor.id)}>{t('重新读取远端并保留草稿')}</Button>
              {activeEditor.remoteRevision !== undefined && <Button type="button" variant="ghost" onPress={() => openDialog({ kind: 'adopt-remote', editorId: activeEditor.id })}>{t('核对后以远端版本继续')}</Button>}
            </div>
          )}
          {activeEditor.phase === 'error' && (
            <div className="files-pane__editor-recovery" role="alert">
              <span>{t('保存失败；可以继续编辑后重新确认保存。本地草稿未丢失。')}</span>
            </div>
          )}
          <div className="files-pane__monaco-shell">
            {showDiff ? (
              <DiffEditor
                height="360px"
                language="plaintext"
                original={activeEditor.remoteRevision?.content ?? activeEditor.baseline}
                modified={activeEditor.content}
                theme={theme.id}
                options={{ ...editorOptions, readOnly: true, originalEditable: false }}
              />
            ) : (
              <Editor
                height="360px"
                language="plaintext"
                value={activeEditor.content}
                theme={theme.id}
                onChange={onEditorChange}
                options={{ ...editorOptions, readOnly: activeEditor.phase === 'saving' ? false : !activeEditor.writable || saveCapability.state !== 'supported' }}
              />
            )}
          </div>
        </div>
      )}
    </section>}
    
    {dialog !== null && (
      <Modal.Backdrop
        className="files-pane__dialog-backdrop"
        isOpen
        isDismissable={!mutationBusy}
        isKeyboardDismissDisabled={mutationBusy}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeDialog();
        }}
      >
        <Modal.Container className="files-pane__dialog-container" placement="center">
          <Modal.Dialog className="files-pane__dialog">
            <Modal.Heading id="files-pane-dialog-title">{mutationDialogTitle(dialog)}</Modal.Heading>
            {dialog.kind === 'mkdir' && <p>{t('将在 {{path}} 创建一个远端目录。', { path: plainText(listing?.path ?? '/') })}</p>}
            {dialog.kind === 'rename' && <p>{t('将重命名 {{path}}。远端是否允许同名或大小写变更由服务端确认。', { path: plainText(dialog.entry.path) })}</p>}
            {dialog.kind === 'remove' && (
              <>
                <p>{t('将删除 {{path}}。远端不假设存在回收站。', { path: plainText(dialog.entry.path) })}</p>
                {dialog.entry.type === 'directory' && <p>{t('还将删除服务端允许删除的内容。')}</p>}
              </>
            )}
            {dialog.kind === 'save-editor' && (
              <p>{t('将按当前已读取的远端版本进行条件保存。若服务端报告冲突或结果未知，草稿会保留且不会自动重试。')}</p>
            )}
            {dialog.kind === 'close-editor' && <p>{t('此文件有未保存内容或未确认的保存结果。关闭会丢弃此标签内的本地草稿，远端传输任务不会被取消。')}</p>}
            {dialog.kind === 'adopt-remote' && <p>{t('会保留当前本地草稿，但将刚读取的远端版本作为新的保存基线。请先在差异预览中核对修改。')}</p>}
            {(dialog.kind === 'mkdir' || dialog.kind === 'rename' || dialog.kind === 'remove') && (
              <label className="files-pane__dialog-field">
                {dialog.kind === 'remove' ? t('请输入“{{name}}”确认删除', { name: plainText(dialog.entry.name) }) : t('名称')}
                <Input
                  autoFocus
                  variant="secondary"
                  value={dialogInput}
                  onChange={(event) => { setDialogInput(event.target.value); setDialogError(null); }}
                  disabled={mutationBusy || mutationOutcomeUnknown}
                  spellCheck={false}
                />
              </label>
            )}
            {dialogError !== null && <p className="files-pane__dialog-error" role="alert">{plainText(translateDiagnostic(dialogError), 300)}</p>}
            <div className="files-pane__dialog-actions">
              <Button type="button" variant="ghost" onPress={closeDialog} isDisabled={mutationBusy}>{t('取消')}</Button>
              <Button className={dialog.kind === 'remove' ? 'files-pane__danger-button' : 'files-pane__primary-button'} type="button" variant={dialog.kind === 'remove' ? 'danger' : 'primary'} onPress={submitDialog} isDisabled={mutationBusy || mutationOutcomeUnknown}>{mutationBusy ? t('正在请求…') : dialogPrimaryLabel}</Button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    )}</section>
  );
}
