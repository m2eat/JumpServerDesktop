import { useMemo, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Button, Input } from '@heroui/react';
import { Database, FolderOpen, Link, MonitorUp, Search, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { ResourceContext } from '@shared/index';
import { useI18n } from '../i18n';
import './NewTabPage.css';

export interface NewTabPageProps {
  recent: ResourceContext[];
  siteName: string;
  onConnect: (context: ResourceContext) => void;
  onSearch: (query: string) => void;
  onBrowseHosts: () => void;
}

interface ProtocolPresentation {
  Icon: LucideIcon;
  tone: 'terminal' | 'files' | 'database' | 'remote' | 'default';
}

function protocolPresentation(protocol: string): ProtocolPresentation {
  switch (protocol.toLocaleLowerCase()) {
    case 'ssh':
    case 'telnet':
      return { Icon: TerminalSquare, tone: 'terminal' };
    case 'sftp':
    case 'scp':
    case 'ftp':
      return { Icon: FolderOpen, tone: 'files' };
    case 'mysql':
    case 'mariadb':
    case 'postgresql':
    case 'postgres':
    case 'oracle':
    case 'mssql':
    case 'redis':
      return { Icon: Database, tone: 'database' };
    case 'rdp':
    case 'vnc':
      return { Icon: MonitorUp, tone: 'remote' };
    default:
      return { Icon: Link, tone: 'default' };
  }
}

export function NewTabPage({ recent, siteName, onConnect, onSearch, onBrowseHosts }: NewTabPageProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingRecent = useMemo(() => {
    if (normalizedQuery.length === 0) {
      return recent;
    }

    return recent.filter((context) => [
      context.assetName,
      context.accountName,
      context.protocol,
      context.address,
      siteName
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
  }, [normalizedQuery, recent, siteName]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch(query);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'Escape' && query.length > 0) {
      event.preventDefault();
      setQuery('');
    }
  };

  return (
    <main className="new-tab-page" aria-label={t('新标签页')}>
      <div className="new-tab-page-content">
        <form className="new-tab-search input-frame" role="search" onSubmit={onSubmit}>
          <Search size={18} aria-hidden="true" />
          <Input
            aria-label={t('搜索授权资产')}
            placeholder={t('搜索资产、账户或地址')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <span className="new-tab-search-hint"><kbd>↵</kbd> {t('搜索')}</span>
        </form>

        <section className="new-tab-recents" aria-labelledby="new-tab-recents-title">
          <header className="new-tab-recents-header">
            <h1 id="new-tab-recents-title">{t('最近连接')}</h1>
            {siteName.length > 0 && <span>{siteName}</span>}
          </header>

          {recent.length === 0 ? (
            <div className="new-tab-recents-empty">
              <p>{t('还没有最近连接。')}</p>
              <Button className="app-action new-tab-browse-host" type="button" variant="secondary" onPress={onBrowseHosts}><MonitorUp size={15} aria-hidden="true" />{t('浏览资产')}</Button>
            </div>
          ) : matchingRecent.length === 0 ? (
            <div className="new-tab-recents-no-match" role="status">{t('最近连接中没有匹配项。按 Enter 搜索全部已授权资产。')}</div>
          ) : (
            <div className="new-tab-recent-list">
              {matchingRecent.map((context) => {
                const { Icon, tone } = protocolPresentation(context.protocol);
                return (
                  <Button className="new-tab-recent-row" type="button" variant="ghost" key={`${context.assetId}:${context.accountId}:${context.protocol}:${context.connectMethod.component}:${context.connectMethod.type}:${context.connectMethod.value}`} onPress={() => onConnect(context)}>
                    <span className={`new-tab-recent-icon is-${tone}`}><Icon size={17} aria-hidden="true" /></span>
                    <span className="new-tab-recent-name"><strong>{context.assetName}</strong></span>
                    <span className="new-tab-recent-context"><span>{context.accountName} · {context.protocol.toUpperCase()}</span><small>{siteName}</small></span>
                  </Button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default NewTabPage;
