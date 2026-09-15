import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Input } from '@heroui/react';
import { z } from 'zod';
import { ArrowUp, ChevronLeft, ChevronRight, File, Folder, FolderOpen, Link, RefreshCw, Search, Upload, X } from 'lucide-react';
import type { LocalListing, TransferTask } from '@shared/index';
import type { FileTransferTarget } from './FilesPane';
import { formatDateTime, formatNumber, t as translate, translateDiagnostic, useI18n } from '../i18n';
import './LocalBrowser.css';

export interface LocalBrowserProps {
  header?: ReactNode;
  target?: Extract<FileTransferTarget, { kind: 'remote' }>;
  onLocationChange?: (listing: LocalListing | null) => void;
  onTransferTasksCreated?: (tasks: TransferTask[]) => void;
}

interface LocalLocation {
  grantId: string;
  relativePath: string;
}

const localListingSchema: z.ZodType<LocalListing> = z.object({
  grantId: z.string(), directoryName: z.string(), directoryPath: z.string(), relativePath: z.string(),
  entries: z.array(z.object({ name: z.string(), relativePath: z.string(), type: z.enum(['file', 'directory', 'link']), size: z.string(), modified: z.string() }))
});
const remoteDropSchema = z.object({ sessionId: z.string(), path: z.string(), name: z.string(), type: z.literal('file') });
const rowHeight = 44;
const readableSize = (size: string, numberFormatter: Intl.NumberFormat) => {
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return size;
  if (bytes < 1024) return translate('{{size}} B', { size: numberFormatter.format(bytes) });
  if (bytes < 1024 ** 2) return translate('{{size}} KB', { size: numberFormatter.format(bytes / 1024) });
  return translate('{{size}} MB', { size: numberFormatter.format(bytes / 1024 ** 2) });
};

function localModified(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : formatDateTime(timestamp);
}

export default function LocalBrowser({ header, target, onLocationChange, onTransferTasksCreated }: LocalBrowserProps) {
  const { t, locale } = useI18n();
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const [listing, setListing] = useState<LocalListing | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState('');
  const [history, setHistory] = useState<LocalLocation[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(700);
  const requestRef = useRef(0);
  const mounted = useRef(true);
  const listingRef = useRef(listing);
  const historyRef = useRef<LocalLocation[]>([]);
  const historyIndexRef = useRef(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const transferringRef = useRef(false);
  listingRef.current = listing;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busyRef.current = false;
      requestRef.current++;
    };
  }, []);
  useEffect(() => { onLocationChange?.(listing); }, [listing, onLocationChange]);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const resize = () => setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, [listing !== null]);

  const requestListing = useCallback(async (operation: () => Promise<LocalListing | null>, mode: 'push' | 'keep' = 'push') => {
    if (busyRef.current) return false;
    busyRef.current = true;
    const requestId = ++requestRef.current;
    setError('');
    setBusy(true);
    try {
      const response = await operation();
      if (!mounted.current || requestId !== requestRef.current || response === null) return false;
      const next = localListingSchema.parse(response);
      const current = listingRef.current;
      listingRef.current = next;
      setListing(next);
      setSelected(new Set());
      setScrollTop(0);
      setEditingPath(false);
      if (listRef.current) listRef.current.scrollTop = 0;
      if (mode === 'push' && (!current || current.grantId !== next.grantId || current.relativePath !== next.relativePath)) {
        const nextHistory = [...historyRef.current.slice(0, historyIndexRef.current + 1), { grantId: next.grantId, relativePath: next.relativePath }];
        historyRef.current = nextHistory;
        historyIndexRef.current = nextHistory.length - 1;
        setHistory(nextHistory);
        setHistoryIndex(nextHistory.length - 1);
      }
      return true;
    } catch (reason) {
      if (mounted.current && requestId === requestRef.current) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      if (mounted.current && requestId === requestRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  const openHome = useCallback(() => requestListing(() => window.desktop.invoke('local.home', {})), [requestListing]);
  const pickDirectory = useCallback(() => requestListing(() => window.desktop.invoke('local.pick', {})), [requestListing]);
  const navigatePath = useCallback((path: string) => {
    const current = listingRef.current;
    if (!current) return Promise.resolve(false);
    return requestListing(() => window.desktop.invoke('local.navigate', {
      grantId: current.grantId,
      relativePath: current.relativePath,
      path
    }));
  }, [requestListing]);
  const refresh = useCallback(() => {
    const current = listingRef.current;
    if (!current) return Promise.resolve(false);
    return requestListing(() => window.desktop.invoke('local.list', {
      grantId: current.grantId,
      relativePath: current.relativePath
    }), 'keep');
  }, [requestListing]);

  useEffect(() => { void openHome(); }, [openHome]);
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = window.desktop.subscribe((event) => {
      if (event.type !== 'task' || event.task.phase !== 'completed' || !listingRef.current) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => { if (listingRef.current) void refresh(); }, 150);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const transfer = async (remoteDrop?: z.infer<typeof remoteDropSchema>) => {
    const current = listingRef.current;
    if (!current || transferringRef.current || (!remoteDrop && (!target || selected.size === 0))) return;
    transferringRef.current = true;
    setTransferring(true);
    setError('');
    try {
      const tasks = remoteDrop
        ? [await window.desktop.invoke('files.downloadLocal', { sessionId: remoteDrop.sessionId, path: remoteDrop.path, name: remoteDrop.name, grantId: current.grantId, relativePath: current.relativePath })]
        : await window.desktop.invoke('files.uploadLocal', { sessionId: target!.sessionId, grantId: current.grantId, relativePaths: [...selected], path: target!.path });
      if (mounted.current) {
        onTransferTasksCreated?.(tasks);
        setSelected(new Set());
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) {
        transferringRef.current = false;
        setTransferring(false);
      }
    }
  };

  const entries = useMemo(
    () => listing?.entries.filter((entry) => entry.name.toLocaleLowerCase(locale).includes(filter.toLocaleLowerCase(locale))) ?? [],
    [filter, listing, locale],
  );
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const visible = entries.slice(start, start + Math.ceil(viewportHeight / rowHeight) + 6);
  const moveHistory = (offset: number) => {
    const index = historyIndexRef.current + offset;
    const location = historyRef.current[index];
    if (!location || busyRef.current) return;
    void requestListing(() => window.desktop.invoke('local.list', location), 'keep').then((navigated) => {
      if (!navigated) return;
      historyIndexRef.current = index;
      setHistoryIndex(index);
    });
  };
  const cancelPathEdit = () => {
    setEditingPath(false);
    setPathDraft(listingRef.current?.directoryPath ?? '');
  };
  const commitPathEdit = () => {
    void navigatePath(pathDraft).then((navigated) => {
      if (navigated && mounted.current) setEditingPath(false);
    });
  };

  return <section className="local-browser" aria-label={t('本地文件')} onDragOver={(event) => {
    if (listing && event.dataTransfer.types.includes('application/x-jms-remote')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }} onDrop={(event) => {
    const payload = event.dataTransfer.getData('application/x-jms-remote');
    if (!payload) return;
    event.preventDefault();
    try { void transfer(remoteDropSchema.parse(JSON.parse(payload))); }
    catch { setError(t('只支持将远程普通文件下载到本地目录。')); }
  }}>
    <header className="local-browser-header">
      <div className="local-browser-label">{header ?? <><FolderOpen size={19} />{t('本地')}</>}</div>
      <Button type="button" variant="ghost" className="local-header-action" aria-label={t('筛选本地文件')} aria-pressed={filtering} onPress={() => setFiltering((value) => !value)}><Search size={17} /><span>{t('筛选')}</span></Button>
      <Button type="button" variant="ghost" className="local-header-action" aria-label={t('选择本地目录')} isDisabled={busy} onPress={() => void pickDirectory()}><FolderOpen size={17} /><span>{t('选择目录')}</span></Button>
    </header>
    {filtering && <label className="local-browser-filter input-frame"><Search size={15} /><Input autoFocus aria-label={t('本地文件筛选')} placeholder={t('按名称筛选…')} value={filter} onChange={(event) => { setFilter(event.target.value); setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0; }} /><Button type="button" variant="ghost" aria-label={t('清除本地筛选')} onPress={() => { setFilter(''); setFiltering(false); }}><X size={15} /></Button></label>}
    {listing === null ? <div className="local-browser-empty">
      <span className="local-empty-icon"><FolderOpen size={33} strokeWidth={1.5} /></span><h2>{t('本地文件')}</h2>
      <p>{busy ? t('正在打开本地主目录…') : t('无法打开本地主目录。')}</p>
      <Button type="button" variant="secondary" isDisabled={busy} onPress={() => void openHome()}>{t('打开主目录')}</Button>
    </div> : <>
      <nav className="local-browser-path" aria-label={t('本地路径')}>
        <Button type="button" variant="ghost" aria-label={t('本地后退')} isDisabled={historyIndex <= 0 || busy} onPress={() => moveHistory(-1)}><ChevronLeft size={17} /></Button>
        <Button type="button" variant="ghost" aria-label={t('本地前进')} isDisabled={historyIndex >= history.length - 1 || busy} onPress={() => moveHistory(1)}><ChevronRight size={17} /></Button>
        <Button type="button" variant="ghost" aria-label={t('本地上级目录')} isDisabled={!listing.relativePath || busy} onPress={() => void navigatePath('..')}><ArrowUp size={16} /></Button>
        <Button type="button" variant="ghost" aria-label={t('打开本地主目录')}  isDisabled={busy} onPress={() => void openHome()} render={(buttonProps) => <button {...buttonProps} title={t('打开主目录')} />} > <FolderOpen size={16} /></Button>
        {editingPath
          ? <Input className="local-browser-path-input" aria-label={t('本地路径')} autoFocus value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} onBlur={cancelPathEdit} onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitPathEdit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelPathEdit();
              event.currentTarget.blur();
            }
          }} />
          : <Button type="button" variant="ghost" className="local-browser-path-location"  onPress={() => {
                      setPathDraft(listing.directoryPath);
                      setEditingPath(true);
                    }} render={(buttonProps) => <button {...buttonProps} title={listing.directoryPath} />} > <Folder size={17} />{listing.directoryPath}</Button>}
        <Button type="button" variant="ghost" aria-label={t('刷新本地目录')} isDisabled={busy} onPress={() => void refresh()}><RefreshCw size={15} /></Button>
      </nav>
      <div className="local-browser-table-head" aria-hidden="true"><span>{t('名称')}</span><span>{t('修改时间')}</span><span>{t('大小')}</span><span>{t('类型')}</span></div>
      <div className="local-browser-list" ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: entries.length * rowHeight, position: 'relative' }}>
          {visible.map((entry, index) => <Button type="button" variant="ghost" key={entry.relativePath}
                      className={`local-browser-row ${selected.has(entry.relativePath) ? 'selected' : ''}`}
                      style={{ position: 'absolute', top: (start + index) * rowHeight, height: rowHeight }}
                      aria-pressed={selected.has(entry.relativePath)} isDisabled={entry.type === 'link' || busy}
                       
                      
                      onClick={(event) => setSelected((current) => {
                        const next = event.metaKey || event.ctrlKey ? new Set(current) : new Set<string>();
                        if (next.has(entry.relativePath)) next.delete(entry.relativePath);
                        else next.add(entry.relativePath);
                        return next;
                      })}
                      onDoubleClick={() => { if (entry.type === 'directory') void navigatePath(entry.name); }} render={(buttonProps) => <button {...buttonProps} draggable={entry.type !== 'link'} title={entry.type === 'link' ? t('符号链接不跟随，不参与递归上传') : entry.name} onDragStart={(event) => event.dataTransfer.setData('application/x-jms-local', JSON.stringify({ grantId: listing.grantId, relativePaths: selected.has(entry.relativePath) ? [...selected] : [entry.relativePath] }))} />} > <span className={`local-file-name ${entry.type === 'directory' ? 'local-directory-name' : ''}`}>{entry.type === 'directory' ? <Folder size={20} fill="currentColor" /> : entry.type === 'link' ? <Link size={18} /> : <File size={18} />}<span>{entry.name}</span></span>
          <span className="local-file-modified">{localModified(entry.modified)}</span>
          <span>{entry.type === 'file' ? readableSize(entry.size, numberFormatter) : '—'}</span><span>{entry.type === 'directory' ? t('文件夹') : entry.type === 'link' ? t('链接') : t('文件')}</span></Button>)}
        </div>
        {entries.length === 0 && <div className="local-no-files">{filter ? t('没有匹配的文件') : t('此目录为空')}</div>}
      </div>
      <footer>
        <small>
          {t('共有 {{count}} 项', { count: formatNumber(entries.length) })}
          {selected.size > 0 && <> · {t('已选 {{count}} 项', { count: formatNumber(selected.size) })}</>}
        </small>
        <Button type="button" variant="primary" isDisabled={!target || selected.size === 0 || transferring || busy}  onPress={() => void transfer()} render={(buttonProps) => <button {...buttonProps} title={target ? t('上传到 {{target}}', { target: `${target.label}:${target.path}` }) : t('先连接另一侧远程主机')} />} > <Upload size={15} />{t('上传选中')}</Button>
      </footer>
    </>}
    {error && <p className="local-browser-error" role="alert">{translateDiagnostic(error)}</p>}
    {(busy || transferring) && <small className="local-browser-status" role="status">{transferring ? t('正在创建传输任务…') : t('正在读取目录…')}</small>}
  </section>;
}
