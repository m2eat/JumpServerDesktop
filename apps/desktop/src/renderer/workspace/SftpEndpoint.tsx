import { useEffect, useRef, useState } from 'react';
import { AlertDialog, Button, Dropdown } from '@heroui/react';
import { ChevronDown, Folder, FolderOpen, HardDrive, LoaderCircle, LogOut, Server } from 'lucide-react';
import type { FileListing, Identity, LocalListing, Preferences, ResourceContext, SessionInfo, TransferTask } from '@shared/index';
import FilesPane from '../components/FilesPane';
import type { FileTransferTarget } from '../components/FilesPane';
import LocalBrowser from '../components/LocalBrowser';
import SftpHostPicker from './SftpHostPicker';
import './SftpWorkspace.css';
import { translateDiagnostic, useI18n } from '../i18n';

export type EndpointSide = 'left' | 'right' | 'quick';

export interface SftpEndpointProps {
  side: EndpointSide;
  identity: Identity | null;
  preferences: Preferences;
  session: SessionInfo | null;
  local?: boolean;
  allowLocal?: boolean;
  compact?: boolean;
  dirty: boolean;
  connecting?: boolean;
  connectionError?: string;
  initialContext?: ResourceContext;
  transferTarget?: FileTransferTarget;
  onConnect: (context: ResourceContext) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onUseLocal?: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onRemoteLocationChange?: (listing: FileListing | null) => void;
  onLocalLocationChange?: (listing: LocalListing | null) => void;
  onTransferTasksCreated?: (tasks: TransferTask[]) => void;
}

type EndpointAction = 'choose' | 'local' | 'disconnect';

export default function SftpEndpoint({ side, identity, preferences, session, local = false, allowLocal = false, compact = false, dirty, connecting = false, connectionError, initialContext, transferTarget, onConnect, onDisconnect, onUseLocal, onDirtyChange, onRemoteLocationChange, onLocalLocationChange, onTransferTasksCreated }: SftpEndpointProps) {
  const { t } = useI18n();
  const sideLabel = side === 'left' ? t('左侧') : side === 'right' ? t('右侧') : t('快捷');
  const [pickerOpen, setPickerOpen] = useState(() => !local && session === null && !connecting);
  const [pendingAction, setPendingAction] = useState<EndpointAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousSessionIdRef = useRef<string | null>(session?.id ?? null);
  const previousConnectingRef = useRef(connecting);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    const nextSessionId = session?.id ?? null;
    const connectionFinishedWithoutSession = previousConnectingRef.current && !connecting && nextSessionId === null;
    previousSessionIdRef.current = nextSessionId;
    previousConnectingRef.current = connecting;
    if (nextSessionId !== null && previousSessionId === null) {
      setPickerOpen(false);
    } else if (connectionFinishedWithoutSession) {
      setPickerOpen(true);
    }
  }, [connecting, session?.id]);

  const closePicker = () => {
    setPickerOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const perform = async (action: EndpointAction) => {
    setPendingAction(null); setError('');
    if (action === 'choose') { setPickerOpen(true); return; }
    setBusy(true);
    try {
      if (action === 'local') {
        await onUseLocal?.();
        if (alive.current) setPickerOpen(false);
      } else {
        await onDisconnect();
        if (alive.current) setPickerOpen(true);
      }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const request = (action: EndpointAction) => {
    if (dirty && session) setPendingAction(action);
    else void perform(action);
  };
  const showingPicker = pickerOpen && !connecting;
  const selector = <Dropdown>
    <Dropdown.Trigger ref={triggerRef} type="button" className="sftp-endpoint-trigger" aria-label={t('{{side}}文件位置', { side: sideLabel })} isDisabled={busy || connecting}>
      <span className={`sftp-endpoint-icon ${local ? 'is-local' : ''}`}>{connecting ? <LoaderCircle size={17} className="spin" /> : local ? <HardDrive size={17} /> : <FolderOpen size={17} />}</span>
      <span>{local ? t('本地') : session?.context.assetName ?? t('远程主机')}</span><ChevronDown size={15} />
    </Dropdown.Trigger>
    <Dropdown.Popover className="sftp-endpoint-menu" placement="bottom start">
      <Dropdown.Menu aria-label={t('{{side}}位置选择', { side: sideLabel })} onAction={(key) => {
        if (key === 'local') {
          if (local) closePicker();
          else request('local');
        } else if (key === 'choose') {
          request('choose');
        } else if (key === 'disconnect') {
          request('disconnect');
        }
      }}>
        {allowLocal && <Dropdown.Item id="local"><HardDrive size={16} />{t('本地文件')}{local && <small>{t('当前')}</small>}</Dropdown.Item>}
        <Dropdown.Item id="choose"><Server size={16} />{t('选择远程主机…')}</Dropdown.Item>
        {!local && session && <Dropdown.Item id="disconnect"><LogOut size={16} />{t('断开此文件连接')}</Dropdown.Item>}
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;

  return <section className={`sftp-endpoint ${compact ? 'is-compact' : ''}`} aria-label={t('{{side}}文件窗格', { side: sideLabel })}>
    {allowLocal && <div className={`sftp-local-surface ${!local || showingPicker ? 'is-inactive' : ''}`} inert={!local || showingPicker} aria-hidden={!local || showingPicker}>
      <LocalBrowser header={local && !showingPicker ? selector : undefined} target={transferTarget?.kind === 'remote' ? transferTarget : undefined} onLocationChange={onLocalLocationChange} onTransferTasksCreated={onTransferTasksCreated} />
    </div>}
    {(!local || showingPicker) && <>
      {!showingPicker && <header className="sftp-endpoint-header">{selector}{session && <span className="sftp-endpoint-account" title={`${session.context.accountName}@${session.context.address}`}><i className={`is-${session.phase}`} />{session.context.accountName}</span>}</header>}
      <div className={`sftp-remote-surface ${showingPicker ? 'is-inactive' : ''}`} inert={showingPicker} aria-hidden={showingPicker}>
        {session ? <FilesPane key={`${session.id}:${session.generation}`} session={session} preferences={preferences} compact={compact} onDirtyChange={onDirtyChange} transferTarget={transferTarget} onLocationChange={onRemoteLocationChange} onTransferTasksCreated={onTransferTasksCreated} /> : <div className="sftp-connect-empty">
          <span className="sftp-empty-icon">{connecting ? <LoaderCircle className="spin" size={31} /> : <Folder size={33} fill="currentColor" strokeWidth={1.5} />}</span>
          <h2>{connecting ? t('正在连接…') : t('连接到远程主机')}</h2>
          <p>{connecting ? t('正在确认当前账号的 SFTP 授权。') : t('选择一台已授权主机，通过 SFTP 管理和传输文件。')}</p>
          <Button className="app-action button-quiet" type="button" variant="secondary" isDisabled={connecting || !identity} onPress={() => request('choose')}>{t('选择主机')}</Button>
          {!identity && <small>{t('请先在资产库登录 JumpServer 站点')}</small>}
        </div>}
      </div>
      {showingPicker && <SftpHostPicker identity={identity} initialContext={session?.context ?? initialContext} canReturn={local || session !== null} onSelect={onConnect} onClose={closePicker} />}
    </>}
    {(error || connectionError) && <p className="sftp-endpoint-error" role="alert">{translateDiagnostic(error || connectionError || '')}</p>}
    {pendingAction && <AlertDialog isOpen>
      <AlertDialog.Backdrop className="sftp-change-confirmation-backdrop" isDismissable={false} isKeyboardDismissDisabled>
        <AlertDialog.Container placement="center">
          <AlertDialog.Dialog className="modal-card sftp-change-confirmation" aria-label={t('切换文件位置确认')}>
            <h2>{t('离开当前文件连接？')}</h2>
            <p>{t('未保存的编辑会被丢弃。进行中的传输会保留在后台，不会因切换位置而取消。')}</p>
            <div className="modal-actions">
              <Button autoFocus className="app-action button-quiet" type="button" variant="secondary" onPress={() => setPendingAction(null)}>{t('继续编辑')}</Button>
              <Button className="app-action button-danger" type="button" variant="danger" onPress={() => void perform(pendingAction)}>{t('丢弃编辑并继续')}</Button>
            </div>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>}
  </section>;
}
