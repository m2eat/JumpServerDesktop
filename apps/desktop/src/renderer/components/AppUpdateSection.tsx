import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import type { AppUpdateState } from '@shared/index';
import { appUpdateStateSchema } from '@shared/updates';
import { useI18n } from '../i18n';

interface AppUpdateSectionProps {
  installBlocked: boolean;
  onNotify: (message: string, tone: 'success' | 'error') => void;
}

export default function AppUpdateSection({ installBlocked, onNotify }: AppUpdateSectionProps) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<AppUpdateState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const unsubscribe = window.desktop.subscribe((event) => {
      if (event.type !== 'update') return;
      const parsed = appUpdateStateSchema.safeParse(event.update);
      if (!parsed.success) return;
      revision.current++;
      setUpdate(parsed.data);
      setLoadError(false);
    });
    const requestRevision = revision.current;
    void window.desktop.invoke('app.updates', {}).then((state) => {
      if (!active || requestRevision !== revision.current) return;
      setUpdate(appUpdateStateSchema.parse(state));
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, []);

  const run = async (command: 'app.checkUpdate' | 'app.downloadUpdate' | 'app.installUpdate' | 'app.openRelease') => {
    if (busy.current || (command === 'app.installUpdate' && installBlocked)) return;
    busy.current = true;
    setPending(true);
    const requestRevision = revision.current;
    try {
      const state = await window.desktop.invoke(command, {});
      if (mounted.current && state && requestRevision === revision.current) {
        setUpdate(appUpdateStateSchema.parse(state));
        setLoadError(false);
      }
    } catch (error: unknown) {
      if (mounted.current) onNotify(t('更新操作失败：{{detail}}', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const working = pending || update?.phase === 'checking' || update?.phase === 'downloading';
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
      {update?.phase === 'downloading' && <progress className="settings-update-progress" aria-label={t('更新下载进度')} max={100} value={update.progress ?? 0} />}
      {update?.reason === 'development' && <p className="settings-update-note">{t('开发模式不检查或安装更新，请使用正式安装包。')}</p>}
      {update?.reason === 'unsigned-macos' && <p className="settings-update-note">{t('macOS 当前提供未签名安装包，请从发布页下载并手动替换应用；不会绕过系统签名检查。')}</p>}
      {update?.reason === 'linux-package' && <p className="settings-update-note">{t('此 Linux 安装方式需手动更新；AppImage 支持应用内下载和安装。')}</p>}
      {update?.reason === 'unsupported-platform' && <p className="settings-update-note">{t('此平台不支持应用内安装，请查看发布页的可用安装包。')}</p>}
      <div className="settings-update-actions">
        <Button className="app-action" type="button" variant="secondary" isDisabled={working || update?.mode === 'disabled' || update?.phase === 'downloaded'} onPress={() => void run('app.checkUpdate')}>
          {update?.phase === 'checking' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}{t('检查更新')}
        </Button>
        {update?.mode === 'automatic' && update.phase === 'available' && <Button className="app-action button-primary" type="button" variant="primary" isDisabled={working} onPress={() => void run('app.downloadUpdate')}><Download size={15} aria-hidden="true" />{t('下载更新')}</Button>}
        {update?.mode === 'automatic' && update.phase === 'downloaded' && <Button className="app-action button-primary" type="button" variant="primary" isDisabled={working || installBlocked} onPress={() => void run('app.installUpdate')}><RotateCw size={15} aria-hidden="true" />{t('重启并安装')}</Button>}
        <Button className="app-action button-quiet" type="button" variant="tertiary" isDisabled={pending} onPress={() => void run('app.openRelease')}><ExternalLink size={15} aria-hidden="true" />{t('GitHub 发布页')}</Button>
      </div>
      {update?.phase === 'downloaded' && installBlocked && <p className="settings-update-note">{t('请先保存或恢复当前设置，再安装更新。')}</p>}
      <p className="settings-update-note">{t('仅从 m2eat/JumpServerDesktop 获取稳定版本，不自动下载或在退出时安装。安装前会确认关闭连接、传输和未保存编辑。')}</p>
      <p className="settings-update-note">{t('非官方社区项目 · GPL-3.0-or-later · 不提供担保。源代码和完整许可随 GitHub 发布版本提供。')}</p>
    </div>
  </section>;
}
