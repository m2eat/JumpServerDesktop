import { useEffect, useRef, useState } from 'react';
import { Button, Label, Switch } from '@heroui/react';
import { ClipboardCopy, Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import type { AppUpdateState, PreferenceSettings } from '@shared/index';
import { useI18n } from '../i18n';

const macOSQuarantineCommand = 'xattr -dr com.apple.quarantine "/Applications/JumpServer Desktop.app"';

type UpdatePreferences = Pick<PreferenceSettings, 'autoCheckUpdates' | 'autoDownloadUpdates'>;

interface AppUpdateSectionProps {
  update: AppUpdateState | null;
  loadError: boolean;
  preferences: UpdatePreferences;
  pending: boolean;
  installBlocked: boolean;
  onPreferencesChange: (changes: Partial<UpdatePreferences>) => void;
  onNotify: (message: string, tone: 'success' | 'error') => void;
}

export default function AppUpdateSection({ update, loadError, preferences, pending: settingsPending, installBlocked, onPreferencesChange, onNotify }: AppUpdateSectionProps) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = async (command: 'app.checkUpdate' | 'app.downloadUpdate' | 'app.installUpdate' | 'app.openRelease') => {
    if (busy.current || settingsPending || (command === 'app.installUpdate' && installBlocked)) return;
    busy.current = true;
    setPending(true);
    try {
      // The ordered update event stream owns state; a command reply can lag a newer download event.
      await window.desktop.invoke(command, {});
    } catch (error: unknown) {
      if (mounted.current) onNotify(t('更新操作失败：{{detail}}', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const copyMacOSQuarantineCommand = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t('系统剪贴板不可用。'));
      await navigator.clipboard.writeText(macOSQuarantineCommand);
      onNotify(t('命令已复制到剪贴板。'), 'success');
    } catch (error: unknown) {
      onNotify(t('无法复制命令：{{detail}}', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    }
  };

  const working = pending || update?.phase === 'checking' || update?.phase === 'downloading';
  const downloadUnsupported = update?.mode !== 'automatic';
  const checksDisabled = update?.mode === 'disabled';
  const status = update ? {
    idle: t('尚未检查更新。'),
    checking: t('正在检查 GitHub Releases…'),
    available: t('发现新版本 {{version}}。', { version: update.latestVersion ?? '' }),
    'not-available': t('当前已是最新稳定版本。'),
    downloading: t('正在下载更新…'),
    downloaded: t('更新已下载，确认后重启安装。'),
    error: t('无法完成更新：{{detail}}', { detail: update.error ?? t('请稍后重试。') })
  }[update.phase] : t('正在读取应用版本…');

  return <section className="settings-section settings-update" aria-labelledby="app-update-title">
    <div className="settings-section-heading"><div>
      <h2 id="app-update-title">{t('关于与更新')}</h2>
      <p>{update ? t('当前版本 {{version}} · 稳定更新通道', { version: update.currentVersion }) : t('JumpServer Desktop 社区客户端')}</p>
    </div></div>
    <div className="settings-stack">
      <p className="settings-update-status" role="status" aria-live="polite">{loadError ? t('无法读取更新状态，请重试。') : status}</p>
      <div className="settings-update-preferences">
        <Switch isDisabled={settingsPending || checksDisabled} isSelected={preferences.autoCheckUpdates} size="sm" onChange={(autoCheckUpdates) => onPreferencesChange({ autoCheckUpdates })}>
          <Switch.Content><span><Label>{t('自动检查更新')}</Label><small>{t('启用后会在启动 15 秒后检查，然后每 6 小时检查一次。')}</small></span><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
        </Switch>
        <Switch isDisabled={settingsPending || downloadUnsupported} isSelected={preferences.autoDownloadUpdates} size="sm" onChange={(autoDownloadUpdates) => onPreferencesChange({ autoDownloadUpdates })}>
          <Switch.Content><span><Label>{t('自动下载更新')}</Label><small>{downloadUnsupported ? t('此安装方式需手动下载更新；此偏好不会被更改。') : t('开启后自动下载新版；关闭不会取消已开始的下载，安装仍需确认。')}</small></span><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
        </Switch>
      </div>
      {update?.phase === 'downloading' && <progress className="settings-update-progress" aria-label={t('更新下载进度')} max={100} value={update.progress ?? 0} />}
      {update?.reason === 'development' && <p className="settings-update-note">{t('开发模式不检查或安装更新，请使用正式安装包。')}</p>}
      {update?.reason === 'unsigned-macos' && <>
        <p className="settings-update-note">{t('macOS 安装包尚未签名或公证，需要手动下载并替换应用。')}</p>
        <div className="settings-update-command">
          <code>{macOSQuarantineCommand}</code>
          <Button className="app-action button-quiet" type="button" variant="tertiary" isDisabled={settingsPending} onPress={() => void copyMacOSQuarantineCommand()}><ClipboardCopy size={15} aria-hidden="true" />{t('复制命令')}</Button>
        </div>
        <p className="settings-update-note">{t('先从本仓库正式发布页下载并核对 SHA-256。若放入“应用程序”后仍被 macOS 隔离拦截，可手动运行上方命令，仅移除此应用的隔离属性；这不等于获得 Apple 信任。请勿关闭全局 Gatekeeper。遇到权限错误时先检查文件权限，不要直接改用 sudo。')}</p>
      </>}
      {update?.reason === 'linux-package' && <p className="settings-update-note">{t('此 Linux 安装方式需手动更新；AppImage 支持应用内下载和安装。')}</p>}
      {update?.reason === 'unsupported-platform' && <p className="settings-update-note">{t('此平台不支持应用内安装，请查看发布页的可用安装包。')}</p>}
      <div className="settings-update-actions">
        <Button className="app-action" type="button" variant="secondary" isDisabled={working || settingsPending || update?.mode === 'disabled' || update?.phase === 'downloaded'} onPress={() => void run('app.checkUpdate')}>
          {update?.phase === 'checking' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}{t('检查更新')}
        </Button>
        {update?.mode === 'automatic' && update.phase === 'available' && <Button className="app-action button-primary" type="button" variant="primary" isDisabled={working || settingsPending} onPress={() => void run('app.downloadUpdate')}><Download size={15} aria-hidden="true" />{t('下载更新')}</Button>}
        {update?.mode === 'automatic' && update.phase === 'downloaded' && <Button className="app-action button-primary" type="button" variant="primary" isDisabled={working || installBlocked} onPress={() => void run('app.installUpdate')}><RotateCw size={15} aria-hidden="true" />{t('重启并安装')}</Button>}
        <Button className="app-action button-quiet" type="button" variant="tertiary" isDisabled={pending || settingsPending} onPress={() => void run('app.openRelease')}><ExternalLink size={15} aria-hidden="true" />{t('查看更新说明')}</Button>
      </div>
      {update?.phase === 'downloaded' && installBlocked && <p className="settings-update-note">{t('请先保存或恢复当前设置，再安装更新。')}</p>}
      <p className="settings-update-note">{t('稳定版本仅从 m2eat/JumpServerDesktop 获取。启用自动下载后才会后台下载；不会在退出时安装，安装前始终要求确认并会提示连接、传输和未保存编辑。')}</p>
      <p className="settings-update-note">{t('非官方社区项目 · GPL-3.0-or-later · 不提供担保。源代码和完整许可随 GitHub 发布版本提供。')}</p>
    </div>
  </section>;
}
