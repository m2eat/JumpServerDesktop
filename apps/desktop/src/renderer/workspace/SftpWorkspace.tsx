import { useState } from 'react';
import type { FileListing, Identity, LocalListing, Preferences, ResourceContext, SessionInfo, TransferTask } from '@shared/index';
import type { FileTransferTarget } from '../components/FilesPane';
import SftpEndpoint from './SftpEndpoint';
import { useI18n } from '../i18n';

export type SftpSide = 'left' | 'right';
export interface SftpWorkspaceProps {
  identity: Identity | null;
  preferences: Preferences;
  leftLocal: boolean;
  leftSession: SessionInfo | null;
  rightSession: SessionInfo | null;
  dirtySessionIds: string[];
  onConnect: (side: SftpSide, context: ResourceContext) => Promise<void>;
  onDisconnect: (side: SftpSide) => Promise<void>;
  onUseLocal: () => Promise<void>;
  getDirtyHandler: (sessionId: string) => (dirty: boolean) => void;
  onTransferTasksCreated: (tasks: TransferTask[]) => void;
}
const ignoreDirty = () => {};

export default function SftpWorkspace({ identity, preferences, leftLocal, leftSession, rightSession, dirtySessionIds, onConnect, onDisconnect, onUseLocal, getDirtyHandler, onTransferTasksCreated }: SftpWorkspaceProps) {
  const { t } = useI18n();
  const [localListing, setLocalListing] = useState<LocalListing | null>(null);
  const [leftListing, setLeftListing] = useState<FileListing | null>(null);
  const [rightListing, setRightListing] = useState<FileListing | null>(null);
  const leftTarget: FileTransferTarget | undefined = rightSession?.phase === 'active' && rightListing
    ? { kind: 'remote', sessionId: rightSession.id, path: rightListing.path, label: rightSession.context.assetName } : undefined;
  const rightTarget: FileTransferTarget | undefined = leftLocal
    ? localListing ? { kind: 'local', grantId: localListing.grantId, relativePath: localListing.relativePath } : undefined
    : leftSession?.phase === 'active' && leftListing ? { kind: 'remote', sessionId: leftSession.id, path: leftListing.path, label: leftSession.context.assetName } : undefined;

  return <div className="sftp-workspace" aria-label={t('SFTP 双栏工作区')}>
    <SftpEndpoint side="left" identity={identity} preferences={preferences} session={leftSession} local={leftLocal} allowLocal dirty={leftSession !== null && dirtySessionIds.includes(leftSession.id)} transferTarget={leftTarget}
      onConnect={(context) => onConnect('left', context)} onDisconnect={() => onDisconnect('left')} onUseLocal={onUseLocal}
      onDirtyChange={leftSession ? getDirtyHandler(leftSession.id) : ignoreDirty} onRemoteLocationChange={setLeftListing} onLocalLocationChange={setLocalListing} onTransferTasksCreated={onTransferTasksCreated} />
    <SftpEndpoint side="right" identity={identity} preferences={preferences} session={rightSession} dirty={rightSession !== null && dirtySessionIds.includes(rightSession.id)} transferTarget={rightTarget}
      onConnect={(context) => onConnect('right', context)} onDisconnect={() => onDisconnect('right')}
      onDirtyChange={rightSession ? getDirtyHandler(rightSession.id) : ignoreDirty} onRemoteLocationChange={setRightListing} onTransferTasksCreated={onTransferTasksCreated} />
  </div>;
}
