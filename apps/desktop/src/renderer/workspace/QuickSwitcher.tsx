import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  Database,
  FolderOpen,
  LayoutPanelLeft,
  MonitorUp,
  Search,
  SlidersHorizontal,
  TerminalSquare,
  type LucideIcon
} from 'lucide-react';
import { Button, Input, Modal } from '@heroui/react';
import { useI18n } from '../i18n';
import './QuickSwitcher.css';

export interface QuickSwitcherEntry {
  key: string;
  section: string;
  title: string;
  detail?: string;
  kind: 'terminal' | 'files' | 'database' | 'asset' | 'command' | 'library';
  hint?: string;
}

export interface QuickSwitcherProps {
  entries: QuickSwitcherEntry[];
  index: number;
  query: string;
  loading: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onIndexChange: (index: number) => void;
  onActivate: (key: string) => void;
  onClose: () => void;
  onCompositionChange: (composing: boolean) => void;
}

interface QuickSwitcherGroup {
  section: string;
  entries: Array<{ entry: QuickSwitcherEntry; index: number }>;
}

const entryIcons: Record<QuickSwitcherEntry['kind'], LucideIcon> = {
  terminal: TerminalSquare,
  files: FolderOpen,
  database: Database,
  asset: MonitorUp,
  command: SlidersHorizontal,
  library: LayoutPanelLeft
};


export function QuickSwitcher({
  entries,
  index,
  query,
  loading,
  inputRef,
  onQueryChange,
  onIndexChange,
  onActivate,
  onClose,
  onCompositionChange
}: QuickSwitcherProps) {
  const { t } = useI18n();
  const composingRef = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const listboxId = useId();
  const activeIndex = entries.length === 0 ? -1 : Math.min(Math.max(index, 0), entries.length - 1);
  const activeDescendant = activeIndex === -1 ? undefined : `${listboxId}-option-${activeIndex}`;

  const groups = useMemo<QuickSwitcherGroup[]>(() => {
    const nextGroups: QuickSwitcherGroup[] = [];

    entries.forEach((entry, entryIndex) => {
      const previousGroup = nextGroups.at(-1);
      if (previousGroup === undefined || previousGroup.section !== entry.section) {
        nextGroups.push({ section: entry.section, entries: [{ entry, index: entryIndex }] });
        return;
      }
      previousGroup.entries.push({ entry, index: entryIndex });
    });

    return nextGroups;
  }, [entries]);

  useEffect(() => {
    if (activeDescendant) {
      document.getElementById(activeDescendant)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeDescendant]);

  const moveSelection = (offset: number) => {
    if (entries.length === 0) {
      return;
    }
    onIndexChange((activeIndex + offset + entries.length) % entries.length);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Enter' && activeIndex !== -1) {
      event.preventDefault();
      onActivate(entries[activeIndex].key);
    }
  };

  return (
    <Modal isOpen onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <Modal.Backdrop className="quick-switcher-backdrop" isKeyboardDismissDisabled={isComposing}>
        <Modal.Container className="quick-switcher-container" placement="top">
          <Modal.Dialog className="quick-switcher" aria-label={t('快速跳转')}>
            <div className="quick-switcher-search input-frame">
              <Search size={18} aria-hidden="true" />
              <Input
                ref={inputRef}
                autoFocus
                role="combobox"
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-activedescendant={activeDescendant}
                aria-expanded="true"
                aria-label={t('快速跳转搜索')}
                placeholder={t('搜索工作区、资产或命令')}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={onInputKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                  setIsComposing(true);
                  onCompositionChange(true);
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                  setIsComposing(false);
                  onCompositionChange(false);
                }}
              />
              <span className="quick-switcher-jump-chip">{t('跳转到')}</span>
            </div>

            <div id={listboxId} className="quick-switcher-results" role="listbox" aria-label={t('快速跳转结果')}>
              {loading && <div className="quick-switcher-loading" role="status"><i aria-hidden="true" />{t('正在加载…')}</div>}
              {!loading && entries.length === 0 && <div className="quick-switcher-empty"><Search size={18} aria-hidden="true" /><span>{t('没有匹配项')}</span></div>}
              {groups.map((group, groupIndex) => (
                <section className="quick-switcher-group" key={`${group.section}-${groupIndex}`} aria-label={group.section}>
                  <h2>{group.section}</h2>
                  {group.entries.map(({ entry, index: entryIndex }) => {
                    const Icon = entryIcons[entry.kind];
                    return (
                      <Button id={`${listboxId}-option-${entryIndex}`}
                                            className={entryIndex === activeIndex ? 'quick-switcher-entry is-selected' : 'quick-switcher-entry'}
                                            type="button"
                                            variant="ghost"
                                            
                                            
                                            key={entry.key}
                                            onMouseMove={() => {
                                              if (entryIndex !== activeIndex) {
                                                onIndexChange(entryIndex);
                                              }
                                            }}
                                            onClick={() => onActivate(entry.key)} render={(buttonProps) => <button {...buttonProps} role="option" tabIndex={-1}  aria-selected={entryIndex === activeIndex} />} > <span className={`quick-switcher-entry-icon is-${entry.kind}`}><Icon size={16} aria-hidden="true" /></span>
                                            <span className="quick-switcher-entry-copy">
                                              <strong>{entry.title}</strong>
                                              {entry.detail !== undefined && <small>{entry.detail}</small>}
                                            </span>
                                            {entry.hint !== undefined && <kbd>{entry.hint}</kbd>}</Button>
                    );
                  })}
                </section>
              ))}
            </div>

            <footer className="quick-switcher-help">
              <span><kbd>↑ ↓</kbd> {t('选择')}</span>
              <span><kbd>Enter</kbd> {t('打开')}</span>
              <span><kbd>Esc</kbd> {t('关闭')}</span>
            </footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export default QuickSwitcher;
