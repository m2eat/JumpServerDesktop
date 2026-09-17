import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal } from '@heroui/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { ArrowDown, ArrowUp, FolderOpen, RefreshCw, Search, ShieldAlert, Square, X } from 'lucide-react';
import type { Preferences, SessionInfo } from '@shared/index';
import { useI18n } from '../i18n';
import { useShortcutScope, shortcutLabel } from '../shortcuts';
import { attachTerminal } from '../terminal/streams';
import { useTheme } from '../themes';
import '@xterm/xterm/css/xterm.css';
import './TerminalPane.css';

interface TerminalError {
  key: string;
  message?: string;
}

function errorMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message.trim() || undefined;
  if (typeof cause === 'string') return cause.trim() || undefined;
  if (cause === null || cause === undefined) return undefined;
  const message = String(cause).trim();
  return message || undefined;
}

function operationError(key: string, cause: unknown): TerminalError {
  const message = errorMessage(cause);
  return message === undefined ? { key } : { key, message };
}

export default function TerminalPane({ session, preferences, onToggleSftp, sftpOpen = false, onReconnect, reconnecting }: { session: SessionInfo; preferences: Preferences; onToggleSftp?: () => void; sftpOpen?: boolean; onReconnect: () => void; reconnecting: boolean }) {
  const { t, locale } = useI18n();
  const theme = useTheme(preferences.theme);
  const container = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const copyOnSelect = useRef(preferences.terminalCopyOnSelect);
  const [searching, setSearching] = useState(false);
  const [term, setTerm] = useState('');
  const [paste, setPaste] = useState<string | null>(null);
  const [error, setError] = useState<TerminalError | null>(null);
  const [match, setMatch] = useState(true);
  const phase = useRef(session.phase);
  phase.current = session.phase;
  copyOnSelect.current = preferences.terminalCopyOnSelect;

  useEffect(() => {
    Terminal.strings.promptLabel = t('终端输入');
    Terminal.strings.tooMuchOutput = t('终端输出过多，已停止朗读。');
    terminal.current?.textarea?.setAttribute('aria-label', t('终端输入'));
  }, [locale, t]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const instance = new Terminal({
      cursorBlink: preferences.terminalCursorBlink,
      cursorStyle: preferences.terminalCursorStyle,
      fontSize: preferences.fontSize,
      fontFamily: preferences.terminalFont,
      scrollback: preferences.scrollback,
      lineHeight: preferences.terminalLineHeight,
      allowProposedApi: false,
      disableStdin: phase.current !== 'active',
      theme: { ...theme.terminal }
    });
    const fit = new FitAddon();
    const finder = new SearchAddon();
    instance.loadAddon(fit);
    instance.loadAddon(finder);
    instance.open(element);
    terminal.current = instance;
    search.current = finder;

    let disposed = false;
    let scheduled = 0;
    let lastSize = '';
    let lastCopiedSelection = '';
    const resize = () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        if (disposed || !element.offsetWidth || !element.offsetHeight) return;
        fit.fit();
        const size = `${instance.cols}:${instance.rows}`;
        if (size === lastSize || phase.current !== 'active') return;
        lastSize = size;
        void window.desktop.invoke('terminal.resize', { sessionId: session.id, cols: instance.cols, rows: instance.rows }).catch(reason => {
          if (!disposed) setError(operationError('无法调整终端大小：{{message}}', reason));
        });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    window.addEventListener('resize', resize);

    const detach = attachTerminal(session.id, session.generation, data => {
      if (disposed) return;
      instance.write(data, () => {
        if (!disposed) {
          void window.desktop.invoke('terminal.ack', { sessionId: session.id, bytes: data.byteLength }).catch(reason => {
            if (!disposed && phase.current === 'active') setError(operationError('无法确认终端输出：{{message}}', reason));
          });
        }
      });
    });
    const input = instance.onData(data => {
      if (phase.current !== 'active') return;
      void window.desktop.invoke('terminal.input', { sessionId: session.id, data }).catch(reason => {
        if (!disposed) setError(operationError('无法向终端发送输入：{{message}}', reason));
      });
    });
    const selection = instance.onSelectionChange(() => {
      if (!copyOnSelect.current) {
        lastCopiedSelection = '';
        return;
      }
      const selectedText = instance.getSelection();
      if (!selectedText) {
        lastCopiedSelection = '';
        return;
      }
      if (selectedText === lastCopiedSelection) return;
      lastCopiedSelection = selectedText;
      if (!navigator.clipboard?.writeText) {
        setError({ key: '系统剪贴板不可用。' });
        return;
      }
      void navigator.clipboard.writeText(selectedText).catch(reason => {
        if (!disposed) setError(operationError('无法复制选中的终端文本：{{message}}', reason));
      });
    });
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (text && /[\r\n]/.test(text)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPaste(text);
      }
    };
    element.addEventListener('paste', onPaste, true);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(scheduled);
      detach();
      input.dispose();
      selection.dispose();
      element.removeEventListener('paste', onPaste, true);
      instance.dispose();
      terminal.current = null;
      search.current = null;
    };
  }, [session.id, session.generation]);

  useEffect(() => {
    const instance = terminal.current;
    if (!instance) return;
    instance.options.cursorBlink = preferences.terminalCursorBlink;
    instance.options.cursorStyle = preferences.terminalCursorStyle;
    instance.options.fontSize = preferences.fontSize;
    instance.options.fontFamily = preferences.terminalFont;
    instance.options.scrollback = preferences.scrollback;
    instance.options.lineHeight = preferences.terminalLineHeight;
    instance.options.disableStdin = session.phase !== 'active';
    instance.options.theme = { ...theme.terminal };
  }, [preferences.fontSize, preferences.scrollback, preferences.terminalCursorBlink, preferences.terminalCursorStyle, preferences.terminalFont, preferences.terminalLineHeight, session.phase, theme]);

  useEffect(() => {
    const instance = terminal.current;
    if (!instance) return;
    let cancelled = false;
    const refit = () => {
      if (!cancelled && terminal.current === instance) window.dispatchEvent(new Event('resize'));
    };
    refit();
    void Promise.all([document.fonts.ready, document.fonts.load(`${preferences.fontSize}px ${preferences.terminalFont}`)]).then(refit, refit);
    return () => { cancelled = true; };
  }, [preferences.fontSize, preferences.terminalFont, preferences.terminalLineHeight]);

  const openSearch = (): boolean => {
    if (terminal.current) {
      setSearching(true);
      window.requestAnimationFrame(() => pane.current?.querySelector<HTMLInputElement>('.terminal-search input')?.focus());
    }
    return true;
  };
  const find = (backwards = false): boolean => {
    if (!search.current) return true;
    if (!term) {
      setSearching(true);
      return true;
    }
    setMatch(backwards ? search.current.findPrevious(term) : search.current.findNext(term));
    return true;
  };
  const copySelection = (): boolean => {
    const selectedText = terminal.current?.getSelection();
    if (!selectedText) return true;
    if (!navigator.clipboard?.writeText) {
      setError({ key: '系统剪贴板不可用。' });
      return true;
    }
    void navigator.clipboard.writeText(selectedText).catch(reason => setError(operationError('无法复制选中的终端文本：{{message}}', reason)));
    return true;
  };
  const requestPaste = (): boolean => {
    if (phase.current === 'active') {
      void window.desktop.invoke('app.edit', { action: 'paste' }).catch(reason => setError(operationError('无法粘贴到终端：{{message}}', reason)));
    }
    return true;
  };
  const selectAll = (): boolean => {
    terminal.current?.selectAll();
    return true;
  };
  const clearTerminal = (): boolean => {
    terminal.current?.clear();
    return true;
  };
  const sendInterrupt = () => {
    if (phase.current !== 'active') return;
    void window.desktop.invoke('terminal.input', { sessionId: session.id, data: '\u0003' }).catch(reason => setError(operationError('无法向终端发送中断：{{message}}', reason)));
  };
  const cancelPaste = () => {
    setPaste(null);
    window.requestAnimationFrame(() => terminal.current?.focus());
  };
  const confirmPaste = () => {
    if (phase.current !== 'active' || paste === null) return;
    terminal.current?.paste(paste);
    cancelPaste();
  };
  const displayedError = error === null ? null : t(error.key, { message: error.message ?? t('未知错误。') });
  const reconnectable = session.phase === 'failed' || session.phase === 'lost' || session.phase === 'closed';
  const disconnectedMessage = session.phase === 'connecting'
    ? t('正在建立受授权连接…')
    : session.error
      ? t('终端连接已断开：{{message}}', { message: session.error })
      : t('连接已断开。重新连接不会重放输入。');

  useShortcutScope(container, {
    'terminal.copy': copySelection,
    'terminal.paste': requestPaste,
    'terminal.select-all': selectAll,
    'terminal.clear': clearTerminal,
    'terminal.interrupt': () => {
      if (phase.current === 'active') sendInterrupt();
      return true;
    },
  });
  useShortcutScope(pane, {
    'terminal.search': openSearch,
    'terminal.find-next': () => find(),
    'terminal.find-previous': () => find(true),
    'terminal.reconnect': () => {
      if (reconnectable && !reconnecting) onReconnect();
      return true;
    },
    'terminal.sftp': () => {
      onToggleSftp?.();
      return true;
    },
  });

  return <section ref={pane} className="terminal-pane" aria-label={t('{{name}} 终端', { name: session.context.assetName })}>
    <div className="terminal-toolbar" role="toolbar" aria-label={t('终端操作')}>
      {onToggleSftp && <Button className="terminal-sftp-button" type="button" variant="ghost" aria-label={t('切换快速 SFTP')} aria-expanded={sftpOpen}  onPress={onToggleSftp} render={(buttonProps) => <button {...buttonProps} title={`${t('快速上传和下载文件')} (${shortcutLabel('terminal.sftp', preferences.shortcuts)})`} />} > <FolderOpen size={15} /><span>SFTP</span></Button>}
      <Button isIconOnly type="button" variant="ghost" aria-label={t('搜索终端输出')}  onPress={openSearch} render={(buttonProps) => <button {...buttonProps} title={`${t('搜索当前缓冲')} (${shortcutLabel('terminal.search', preferences.shortcuts)})`} />} > <Search size={15} /></Button>
      <Button isIconOnly type="button" variant="ghost" aria-label={t('向终端发送中断')}  isDisabled={session.phase !== 'active'} onPress={sendInterrupt} render={(buttonProps) => <button {...buttonProps} title={`${t('发送中断')} (${shortcutLabel('terminal.interrupt', preferences.shortcuts)})`} />} > <Square size={13} /></Button>
    </div>
    {searching && <form className="terminal-search input-frame" onSubmit={event => { event.preventDefault(); find(); }}>
      <Search size={14} />
      <Input autoFocus aria-label={t('搜索当前终端')} value={term} onChange={event => { setTerm(event.target.value); setMatch(true); }} onKeyDown={event => { if (event.key === 'Escape') { setSearching(false); terminal.current?.focus(); } if (event.nativeEvent.isComposing && event.key === 'Enter') event.preventDefault(); }} placeholder={t('搜索当前缓冲…')} />
      <Button isIconOnly type="button" variant="ghost" aria-label={t('上一个匹配')} onPress={() => find(true)} render={(buttonProps) => <button {...buttonProps} title={`${t('上一个匹配')} (${shortcutLabel('terminal.find-previous', preferences.shortcuts)})`} />}><ArrowUp size={14} /></Button>
      <Button isIconOnly type="submit" variant="ghost" aria-label={t('下一个匹配')} render={(buttonProps) => <button {...buttonProps} title={`${t('下一个匹配')} (${shortcutLabel('terminal.find-next', preferences.shortcuts)})`} />}><ArrowDown size={14} /></Button>
      <Button isIconOnly type="button" variant="ghost" aria-label={t('关闭搜索')} onPress={() => { setSearching(false); terminal.current?.focus(); }}><X size={14} /></Button>
      {!match && <small>{t('没有匹配')}</small>}
    </form>}
    {displayedError && <div className="terminal-error" role="alert">{displayedError}<Button isIconOnly type="button" variant="ghost" aria-label={t('关闭错误')} onPress={() => setError(null)}><X size={13} /></Button></div>}
    <div className="terminal-surface" ref={container} />
    {session.phase !== 'active' && <div className="terminal-disconnected">
      <div className="terminal-disconnected-message" role="status">
        <span>{disconnectedMessage}</span>
        {reconnectable && <small>{t('旧终端输出保留在此标签。重新连接将在新标签页建立授权会话，不会恢复原 shell 或重放输入。')}</small>}
      </div>
      {reconnectable && <Button type="button" variant="secondary" isDisabled={reconnecting} onPress={onReconnect} render={(buttonProps) => <button {...buttonProps} title={`${t('重新连接')} (${shortcutLabel('terminal.reconnect', preferences.shortcuts)})`} />}>
        <RefreshCw size={14} />{reconnecting ? t('正在建立新会话…') : t('重新连接')}
      </Button>}
    </div>}
    {paste !== null && <Modal isOpen onOpenChange={(isOpen) => { if (!isOpen) cancelPaste(); }}>
      <Modal.Backdrop className="terminal-modal-backdrop" isDismissable={false} isKeyboardDismissDisabled>
        <Modal.Container className="terminal-paste-container" placement="center">
          <Modal.Dialog className="terminal-paste" aria-labelledby="paste-title">
            <ShieldAlert size={24} />
            <h3 id="paste-title">{t('确认多行粘贴')}</h3>
            <p>{t('目标：{{asset}} · {{account}}', { asset: session.context.assetName, account: session.context.accountName })}</p>
            <p>{t('换行可能立即执行命令，请检查内容。')}</p>
            <pre>{paste}</pre>
            <div>
              <Button autoFocus type="button" variant="secondary" onPress={cancelPaste}>{t('取消')}</Button>
              <Button className="terminal-paste-confirm" type="button" variant="primary" isDisabled={session.phase !== 'active'} onPress={confirmPaste}>{t('发送这段内容')}</Button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>}
  </section>;
}
