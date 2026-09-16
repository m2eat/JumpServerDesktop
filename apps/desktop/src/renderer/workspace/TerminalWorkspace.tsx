import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { FolderOpen, X } from 'lucide-react';
import { resourceContextForMethod, sessionKindForMethod } from '@shared/index';
import type { Identity, Preferences, ResourceContext, SessionInfo, TransferTask } from '@shared/index';
import TerminalPane from '../components/TerminalPane';
import SftpEndpoint from './SftpEndpoint';
import { useI18n } from '../i18n';

export interface TerminalWorkspaceProps {
  session: SessionInfo;
  identity: Identity | null;
  preferences: Preferences;
  fileSession: SessionInfo | null;
  dirty: boolean;
  onConnect: (context: ResourceContext) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onFileDirtyChange: (dirty: boolean) => void;
  onTransferTasksCreated: (tasks: TransferTask[]) => void;
  onReconnect: () => void;
  reconnecting: boolean;
}

export default function TerminalWorkspace({ session, identity, preferences, fileSession, dirty, onConnect, onDisconnect, onFileDirtyChange, onTransferTasksCreated, onReconnect, reconnecting }: TerminalWorkspaceProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const connectCurrent = async () => {
    if (inFlight.current || !identity) return;
    inFlight.current = true; setConnecting(true); setError('');
    try {
      const options = await window.desktop.invoke('assets.options', { assetId: session.context.assetId, orgId: session.context.orgId });
      if (!alive.current) return;
      const account = options.accounts.find((candidate) => candidate.id === session.context.accountId);
      const method = options.methods.find((candidate) => sessionKindForMethod(candidate) === 'files');
      if (!account || !method) throw new Error('当前终端账号没有可用的 SFTP 授权，请选择主机和文件账号。');
      await onConnect(resourceContextForMethod({
        siteId: session.context.siteId,
        userId: session.context.userId,
        orgId: session.context.orgId,
        assetId: session.context.assetId,
        assetName: session.context.assetName,
        address: session.context.address,
        accountId: account.id,
        accountName: account.name
      }, method));
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) { inFlight.current = false; setConnecting(false); }
    }
  };
  const toggle = () => {
    setOpen((value) => !value);
    if (!open && !fileSession && !inFlight.current) void connectCurrent();
  };

  return <div className={`terminal-workspace ${open ? 'has-quick-sftp' : ''}`}>
    <div className="terminal-workspace-console"><TerminalPane session={session} preferences={preferences} onToggleSftp={toggle} sftpOpen={open} onReconnect={onReconnect} reconnecting={reconnecting} /></div>
    <aside className={`quick-sftp-sidebar ${open ? '' : 'is-inactive'}`} aria-label={t('{{assetName}} 快速 SFTP', { assetName: session.context.assetName })} aria-hidden={!open} inert={!open}>
      <header className="quick-sftp-title"><span><FolderOpen size={16} />{t('快速 SFTP')}</span><Button isIconOnly type="button" variant="ghost" className="icon-button" aria-label={t('收起快速 SFTP')} onPress={() => setOpen(false)}><X size={18} /></Button></header>
      <SftpEndpoint side="quick" compact identity={identity} preferences={preferences} session={fileSession} initialContext={session.context} dirty={dirty} connecting={connecting} connectionError={error}
        onConnect={async (context) => { await onConnect(context); setError(''); }} onDisconnect={onDisconnect} onDirtyChange={onFileDirtyChange} onTransferTasksCreated={onTransferTasksCreated} />
    </aside>
  </div>;
}
