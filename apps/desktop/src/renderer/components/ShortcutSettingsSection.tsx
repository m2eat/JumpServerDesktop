import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Input } from '@heroui/react';
import { CircleAlert, Keyboard, RotateCcw, Search, Unlink, X } from 'lucide-react';
import {
  defaultShortcut,
  formatShortcut,
  resolveShortcuts,
  shortcutBindingError,
  shortcutCommands,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutPlatform,
  type ShortcutCommandId,
  type ShortcutConflict,
  type ShortcutPlatform,
  type ShortcutPreferences
} from '@shared/shortcuts';
import { useI18n } from '../i18n';
import './ShortcutSettingsSection.css';

interface ShortcutSettingsSectionProps {
  preferences: ShortcutPreferences;
  disabled: boolean;
  onChange: (preferences: ShortcutPreferences) => void;
}

const platforms: readonly ShortcutPlatform[] = ['darwin', 'win32', 'linux'];
const modifierCodes: Record<string, true> = {
  ControlLeft: true, ControlRight: true, AltLeft: true, AltRight: true,
  ShiftLeft: true, ShiftRight: true, MetaLeft: true, MetaRight: true
};

function platformLabel(platform: ShortcutPlatform, t: (key: string) => string): string {
  if (platform === 'darwin') return t('macOS');
  if (platform === 'win32') return t('Windows');
  return t('Linux');
}

function scopeLabel(scope: typeof shortcutCommands[number]['scope'], t: (key: string) => string): string {
  return t(scope === 'global' ? '全局' : scope === 'terminal' ? '终端范围' : scope === 'editor' ? '编辑器范围' : scope === 'file' ? '文件范围' : '数据库范围');
}

function shortcutName(id: ShortcutCommandId, t: (key: string) => string): string {
  return t(shortcutCommands.find((command) => command.id === id)!.label);
}

function conflictMessage(issue: ShortcutConflict, platform: ShortcutPlatform, t: (key: string, values?: Record<string, string | number>) => string): string {
  const binding = formatShortcut(issue.binding, platform);
  const action = shortcutName(issue.command, t);
  if (issue.reason === 'conflict' && issue.other) {
    return t('“{{action}}”与“{{other}}”都使用 {{binding}}。', { action, other: shortcutName(issue.other, t), binding });
  }
  if (issue.reason === 'reserved') return t('“{{action}}”使用了系统保留的 {{binding}}。', { action, binding });
  if (issue.reason === 'unmodified') return t('“{{action}}”的 {{binding}} 缺少必要的修饰键。', { action, binding });
  return t('“{{action}}”的 {{binding}} 无效。', { action, binding });
}

function nextOverride(preferences: ShortcutPreferences, platform: ShortcutPlatform, id: ShortcutCommandId, binding: string | null | undefined): ShortcutPreferences {
  const overrides = { ...preferences[platform] };
  if (binding === undefined) delete overrides[id];
  else overrides[id] = binding;
  return { ...preferences, [platform]: overrides };
}

function isModifierOnly(event: KeyboardEvent): boolean {
  return modifierCodes[event.code] === true;
}
const darwinModifierSymbols: Readonly<Record<string, string>> = {
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Meta: '⌘'
};

export default function ShortcutSettingsSection({ preferences, disabled, onChange }: ShortcutSettingsSectionProps): ReactNode {
  const { t } = useI18n();
  const currentPlatform = shortcutPlatform(window.desktop.platform);
  const [platform, setPlatform] = useState<ShortcutPlatform>(currentPlatform);
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<ShortcutCommandId | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const resolved = useMemo(() => resolveShortcuts(preferences, platform), [platform, preferences]);
  const conflictsByPlatform = useMemo(() => ({
    darwin: shortcutConflicts(preferences, 'darwin'),
    win32: shortcutConflicts(preferences, 'win32'),
    linux: shortcutConflicts(preferences, 'linux')
  }), [preferences]);
  const platformConflicts = conflictsByPlatform[platform];
  const allConflicts = platforms.flatMap((item) => conflictsByPlatform[item].map((issue) => ({ platform: item, issue })));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCommands = useMemo(() => shortcutCommands.filter((command) => {
    if (!normalizedQuery) return true;
    return command.label.toLocaleLowerCase().includes(normalizedQuery)
      || t(command.label).toLocaleLowerCase().includes(normalizedQuery)
      || scopeLabel(command.scope, t).toLocaleLowerCase().includes(normalizedQuery);
  }), [normalizedQuery, t]);

  const updateBinding = useCallback((id: ShortcutCommandId, binding: string | null | undefined) => {
    onChange(nextOverride(preferences, platform, id, binding));
  }, [onChange, platform, preferences]);

  useEffect(() => {
    if (recording === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.getModifierState('AltGraph')) return;
      if (event.key === 'Escape') {
        setRecording(null);
        setRecordingError(null);
        return;
      }
      const binding = shortcutFromEvent(event);
      if (binding === null) {
        if (!isModifierOnly(event)) setRecordingError(t('请按一个可用的物理按键与修饰键。'));
        return;
      }
      const error = shortcutBindingError(binding, platform);
      if (error) {
        setRecordingError(error === 'reserved'
          ? t('此组合键由操作系统保留。')
          : error === 'unmodified'
            ? t('请加入 Ctrl、Alt、Shift 或 Meta 修饰键。')
            : t('此组合键无效。'));
        return;
      }
      updateBinding(recording, binding);
      setRecording(null);
      setRecordingError(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, t, updateBinding]);

  const selectPlatform = (next: ShortcutPlatform) => {
    setPlatform(next);
    setRecording(null);
    setRecordingError(null);
  };

  const counterpartFor = (id: ShortcutCommandId): ShortcutCommandId | null => {
    const issue = platformConflicts.find((item) => item.reason === 'conflict' && (item.command === id || item.other === id));
    if (!issue) return null;
    return issue.command === id ? issue.other ?? null : issue.command;
  };

  return <section className="settings-section shortcut-settings" aria-labelledby="shortcut-settings-title" data-shortcut-recording={recording !== null ? '' : undefined}>
    <div className="settings-section-heading shortcut-settings-heading">
      <div>
        <h2 id="shortcut-settings-title" tabIndex={-1}>{t('键盘快捷键')}</h2>
        <p>{t('按平台分别保存。快捷键按键盘物理位置记录，因此切换键盘布局不会改变绑定。范围决定动作在何处可用；系统保留组合键和原生输入操作不会被拦截。')}</p>
      </div>
      <Button className="app-action button-quiet shortcut-settings-restore-platform" isDisabled={disabled} type="button" variant="tertiary" onPress={() => onChange({ ...preferences, [platform]: {} })}>
        <RotateCcw size={15} aria-hidden="true" />{t('恢复 {{platform}} 默认值', { platform: platformLabel(platform, t) })}
      </Button>
    </div>

    <div className="shortcut-platform-selector" role="group" aria-label={t('快捷键平台')}>
      {platforms.map((item) => <Button
        key={item}
        aria-pressed={platform === item}
        className={platform === item ? 'shortcut-platform-button is-selected' : 'shortcut-platform-button'}
        isDisabled={disabled}
        type="button"
        variant="tertiary"
        onPress={() => selectPlatform(item)}
      >
        <span>{platformLabel(item, t)}</span>{item === currentPlatform && <small>{t('当前设备')}</small>}
      </Button>)}
    </div>

    <label className="shortcut-settings-search" htmlFor="shortcut-settings-search">
      <span>{t('搜索快捷键')}</span>
      <span className="shortcut-settings-search-input"><Search size={15} aria-hidden="true" /><Input id="shortcut-settings-search" disabled={disabled} placeholder={t('按操作或范围搜索')} type="search" value={query} variant="secondary" onChange={(event) => setQuery(event.target.value)} />{query && <Button aria-label={t('清除快捷键搜索')} isDisabled={disabled} isIconOnly type="button" variant="ghost" onPress={() => setQuery('')}><X size={15} aria-hidden="true" /></Button>}</span>
    </label>

    {allConflicts.length > 0 && <div className="shortcut-settings-summary" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      <div><strong>{t('保存前请解决所有平台的快捷键问题。')}</strong><ul>{allConflicts.map(({ platform: item, issue }) => <li key={`${item}:${issue.command}:${issue.other ?? ''}:${issue.binding}:${issue.reason}`}><b>{platformLabel(item, t)}：</b>{conflictMessage(issue, item, t)}</li>)}</ul></div>
    </div>}

    <div className="shortcut-settings-list" id="shortcut-settings-list">
      {visibleCommands.length === 0 && <p className="shortcut-settings-empty">{t('没有匹配的快捷键。')}</p>}
      {visibleCommands.map((command) => {
        const isOverridden = Object.hasOwn(preferences[platform], command.id);
        const binding = resolved[command.id];
        const defaultBinding = defaultShortcut(command, platform);
        const counterpart = counterpartFor(command.id);
        const rowIssues = platformConflicts.filter((issue) => issue.command === command.id || issue.other === command.id);
        const isRecording = recording === command.id;
        return <article className={`shortcut-settings-row${rowIssues.length > 0 ? ' has-issue' : ''}`} key={command.id}>
          <div className="shortcut-settings-action"><strong>{t(command.label)}</strong><span>{scopeLabel(command.scope, t)}</span></div>
          <div className="shortcut-settings-binding">
            {binding === null
              ? <span className="shortcut-settings-unbound">{t('未绑定')}</span>
              : <span className="shortcut-keycaps" role="group" aria-label={formatShortcut(binding, platform)}>
                {binding.split('+').map((token, index) => {
                  const modifierSymbol = platform === 'darwin' ? darwinModifierSymbols[token] : undefined;
                  return <kbd aria-hidden="true" className={`shortcut-keycap${modifierSymbol ? ' is-symbol' : ''}`} key={`${token}:${index}`}>
                    {modifierSymbol ?? formatShortcut(token, platform)}
                  </kbd>;
                })}
              </span>}
            {binding !== null && <span className={isOverridden ? 'shortcut-binding-state is-custom' : 'shortcut-binding-state is-default'}>{isOverridden ? t('自定义') : t('默认值')}</span>}
            {isOverridden && <small>{t('默认：{{binding}}', { binding: formatShortcut(defaultBinding, platform) || t('未绑定') })}</small>}
          </div>
          <div className="shortcut-settings-actions">
            <Button data-shortcut-recorder aria-describedby={isRecording ? 'shortcut-recording-instructions' : undefined} className={isRecording ? 'shortcut-record-button is-recording' : 'shortcut-record-button'} isDisabled={disabled} type="button" variant="secondary" onPress={() => { setRecording(command.id); setRecordingError(null); }}>
              <Keyboard size={15} aria-hidden="true" />{isRecording ? t('正在记录…') : binding === null ? t('记录绑定') : t('重新绑定')}
            </Button>
            {isRecording && <Button data-shortcut-recorder className="shortcut-cancel-recording" isDisabled={disabled} type="button" variant="tertiary" onPress={() => { setRecording(null); setRecordingError(null); }}>{t('取消记录')}</Button>}
            <Button aria-label={t('取消绑定 {{action}}', { action: t(command.label) })} isDisabled={disabled || binding === null} isIconOnly type="button" variant="tertiary" onPress={() => updateBinding(command.id, null)}><Unlink size={15} aria-hidden="true" /></Button>
            {isOverridden && <Button aria-label={t('恢复 {{action}} 默认快捷键', { action: t(command.label) })} isDisabled={disabled} isIconOnly type="button" variant="tertiary" onPress={() => updateBinding(command.id, undefined)}><RotateCcw size={15} aria-hidden="true" /></Button>}
          </div>
          {isRecording && <p className="shortcut-recording-instructions" id="shortcut-recording-instructions" role="status">{recordingError ?? t('按下要使用的组合键，或按 Escape 取消。')}</p>}
          {rowIssues.map((issue) => {
            const other = issue.command === command.id ? issue.other : issue.command;
            return <p className="shortcut-settings-issue" key={`${issue.command}:${issue.other ?? ''}:${issue.binding}:${issue.reason}`} role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{conflictMessage(issue, platform, t)}</span>{issue.reason === 'conflict' && counterpart === other && other && <Button className="shortcut-unbind-conflict" isDisabled={disabled} type="button" variant="tertiary" onPress={() => updateBinding(other, null)}>{t('取消绑定 {{action}}', { action: shortcutName(other, t) })}</Button>}</p>;
          })}
        </article>;
      })}
    </div>
  </section>;
}
