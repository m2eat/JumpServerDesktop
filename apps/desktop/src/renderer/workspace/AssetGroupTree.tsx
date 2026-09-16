import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Input } from '@heroui/react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import type { AssetGroup } from '@shared/index';
import type { AssetGroups } from './useAssetGroups';
import { useI18n } from '../i18n';
import './AssetGroupTree.css';

interface Props {
  groups: AssetGroups;
  selectedGroupId: string | null;
  onSelect(group: AssetGroup, path: AssetGroup[]): void;
  onRefresh?: () => void;
  navigationVersion?: number;
}
export function AssetGroupTree({ groups, selectedGroupId, onSelect, onRefresh, navigationVersion }: Props) {
  const { t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const selection = useRef(0);
  const tree = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { search, scope } = groups;
  useEffect(() => {
    selection.current++;
    setSelecting(null);
    setSelectionError(null);
  }, [scope, navigationVersion]);
  useEffect(() => { setDraft(''); setSearchOpen(false); }, [scope]);
  useEffect(() => {
    if (!draft.trim()) { void search(''); return; }
    const timer = window.setTimeout(() => { void search(draft); }, 220);
    return () => window.clearTimeout(timer);
  }, [draft, search]);
  useEffect(() => { if (searchOpen) input.current?.focus(); }, [searchOpen]);
  useEffect(() => () => { selection.current++; }, []);

  const select = async (group: AssetGroup) => {
    const request = ++selection.current;
    setSelecting(group.key);
    setSelectionError(null);
    const result = await groups.resolvePath(group);
    if (request !== selection.current) return;
    setSelecting(null);
    if (result.status === 'found') onSelect(result.group, result.path);
    else setSelectionError(result.status === 'error' ? result.error : t('该分组已不存在或不再可访问，请刷新分组。'));
  };
  const refresh = () => {
    selection.current++;
    setSelecting(null);
    setSelectionError(null);
    if (onRefresh) onRefresh();
    else void groups.refresh();
  };
  const focusKey = (key: string) => {
    const row = Array.from(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []).find(item => item.dataset.groupKey === key);
    row?.focus();
  };
  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>, group: AssetGroup, expandable: boolean) => {
    if ((event.target as HTMLElement).closest('[role="treeitem"]') !== event.currentTarget) return;
    // Nested disclosure/label buttons have their own Enter/Space behavior.
    if (event.target !== event.currentTarget && (event.key === 'Enter' || event.key === ' ')) return;
    const rows = Array.from(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const index = rows.indexOf(event.currentTarget);
    let target: HTMLElement | undefined;
    if (event.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') target = rows[Math.max(0, index - 1)];
    else if (event.key === 'Home') target = rows[0];
    else if (event.key === 'End') target = rows.at(-1);
    else if (event.key === 'ArrowRight') {
      if (expandable && !groups.expanded.has(group.key)) groups.toggle(group.key);
      else { const first = groups.children.get(group.key)?.[0]; if (first) focusKey(first); }
    } else if (event.key === 'ArrowLeft') {
      if (groups.expanded.has(group.key)) groups.toggle(group.key);
      else focusKey(group.parentKey);
    } else if (event.key === 'Enter' || event.key === ' ') void select(group);
    else return;
    event.preventDefault();
    event.stopPropagation();
    target?.focus();
  };
  const renderChildren = (parentKey: string, level: number): React.ReactNode => (
    (groups.children.get(parentKey) ?? []).map(key => {
      const group = groups.nodes.get(key);
      if (!group) return null;
      const state = groups.loads.get(key);
      const expanded = groups.expanded.has(key);
      const expandable = state?.stage !== 'ready' || (groups.children.get(key)?.length ?? 0) > 0;
      const selected = selectedGroupId === group.id;
      return <div key={key} role="treeitem" aria-label={group.name} aria-level={level} aria-selected={selected} aria-expanded={expandable ? expanded : undefined} tabIndex={0} data-group-key={key} onKeyDown={event => onTreeKey(event, group, expandable)}>
        <div className={`asset-group-row ${selected ? 'is-selected' : ''}`} style={{ paddingLeft: 5 + (level - 1) * 14 }}>
          {expandable ? <Button variant="tertiary" className="group-disclosure" isIconOnly aria-label={t(expanded ? '收起分组 {{name}}' : '展开分组 {{name}}', { name: group.name })} onPress={() => groups.toggle(key)} render={props => <button {...props} tabIndex={-1} />}>{state?.stage === 'loading' ? <LoaderCircle size={12} className="spin" /> : expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</Button> : <span className="group-disclosure-space" />}
          <Button variant="tertiary" className="group-name" onPress={() => void select(group)} render={props => <button {...props} tabIndex={-1} title={group.path} />}>
            {selecting === key ? <LoaderCircle size={15} className="spin" /> : expanded ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{group.name}</span>
          </Button>
        </div>
        {expanded && expandable && <div role="group">
          {state?.stage === 'loading' && <div className="group-status" style={{ paddingLeft: 24 + level * 14 }}>{t('加载中…')}</div>}
          {state?.stage === 'error' ? <div className="group-inline-error" role="alert"><span>{state.error}</span><Button variant="tertiary" onPress={() => groups.retry(key)}>{t('重试')}</Button></div> : renderChildren(key, level + 1)}
        </div>}
      </div>;
    })
  );
  const searching = draft.trim().length > 0;
  const searchPending = searching && (groups.query !== draft || groups.searchState.stage === 'loading');
  return <section className="asset-group-tree" aria-label={t('资产分组')}>
    <header className="group-tree-header">
      <Button variant="tertiary" className="group-tree-title" aria-expanded={!collapsed} onPress={() => setCollapsed(value => !value)}>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span>{t('资产分组')}</span></Button>
      <Button variant="tertiary" className="group-header-action" isIconOnly aria-label={t('搜索分组')} isDisabled={!groups.enabled} onPress={() => { setCollapsed(false); setSearchOpen(value => !value); setDraft(''); }}><Search size={14} /></Button>
      <Button variant="tertiary" className="group-header-action" isIconOnly aria-label={t('刷新分组')} isDisabled={!groups.enabled || groups.rootState.stage === 'loading'} onPress={refresh}><RefreshCw size={13} className={groups.rootState.stage === 'loading' ? 'spin' : ''} /></Button>
    </header>
    {!collapsed && <>
      {searchOpen && <div className="group-search input-frame"><Search size={13} /><Input ref={input} variant="secondary" value={draft} maxLength={256} aria-label={t('搜索分组名称或路径')} placeholder={t('搜索分组名称或路径')} onChange={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape') { setDraft(''); setSearchOpen(false); } }} />{draft && <Button variant="tertiary" className="group-header-action" isIconOnly aria-label={t('清除分组搜索')} onPress={() => setDraft('')}><X size={12} /></Button>}</div>}
      {selectionError && <div className="group-inline-error" role="alert"><span>{selectionError}</span><Button variant="tertiary" onPress={refresh}>{t('刷新分组')}</Button></div>}
      <div className="group-tree-scroll">
        {!groups.enabled ? <p className="group-status">{t('登录后浏览授权分组')}</p> : searching ? <>
          {searchPending && <p className="group-status" role="status">{t('正在搜索分组…')}</p>}
          {!searchPending && groups.searchState.stage === 'error' && <div className="group-inline-error" role="alert"><span>{groups.searchState.error}</span><Button variant="tertiary" onPress={() => void search(draft)}>{t('重试')}</Button></div>}
          {!searchPending && groups.searchState.stage === 'ready' && (groups.results.length ? <div className="group-search-results" aria-label={t('分组搜索结果')}>{groups.results.map(group => <Button key={group.id} variant="tertiary" className={`group-search-result ${selectedGroupId === group.id ? 'is-selected' : ''}`} aria-pressed={selectedGroupId === group.id} onPress={() => void select(group)} render={props => <button {...props} title={group.path} />}><Folder size={15} /><span><strong>{group.name}</strong><small>{group.path}</small></span>{selecting === group.key && <LoaderCircle size={13} className="spin" />}</Button>)}</div> : <p className="group-status">{t('没有找到匹配的分组')}</p>)}
        </> : <>
          {groups.rootState.stage === 'loading' && <p className="group-status" role="status">{t('正在读取授权分组…')}</p>}
          {groups.rootState.stage === 'error' ? <div className="group-inline-error" role="alert"><span>{groups.rootState.error}</span><Button variant="tertiary" onPress={refresh}>{t('重试')}</Button></div> : <div ref={tree} role="tree" aria-label={t('授权分组')}>{renderChildren('', 1)}</div>}
          {groups.rootState.stage === 'ready' && !groups.children.get('')?.length && <p className="group-status">{t('没有可访问的分组，仍可浏览全部资产。')}</p>}
        </>}
      </div>
    </>}
  </section>;
}
