import { z } from 'zod';

export type ShortcutPlatform = 'darwin' | 'win32' | 'linux';
export type ShortcutScope = 'global' | 'terminal' | 'editor' | 'file' | 'database';

// Bind physical keys so Option-generated characters and input methods cannot change a binding.
export const shortcutCommands = [
  { id: 'picker.open', label: '打开全局搜索', scope: 'global', mac: 'Meta+KeyK', windows: 'Ctrl+Shift+KeyK' },
  { id: 'tabs.new', label: '新建标签页', scope: 'global', mac: 'Meta+KeyT', windows: 'Ctrl+Shift+KeyT' },
  { id: 'tabs.close', label: '关闭当前标签页', scope: 'global', mac: 'Meta+KeyW', windows: 'Ctrl+Shift+KeyW' },
  { id: 'tabs.next', label: '下一个标签页', scope: 'global', mac: 'Ctrl+Tab', windows: 'Ctrl+Tab' },
  { id: 'tabs.previous', label: '上一个标签页', scope: 'global', mac: 'Ctrl+Shift+Tab', windows: 'Ctrl+Shift+Tab' },
  { id: 'tabs.1', label: '切换到第 1 个连接标签', scope: 'global', mac: 'Meta+Digit1', windows: 'Alt+Digit1' },
  { id: 'tabs.2', label: '切换到第 2 个连接标签', scope: 'global', mac: 'Meta+Digit2', windows: 'Alt+Digit2' },
  { id: 'tabs.3', label: '切换到第 3 个连接标签', scope: 'global', mac: 'Meta+Digit3', windows: 'Alt+Digit3' },
  { id: 'tabs.4', label: '切换到第 4 个连接标签', scope: 'global', mac: 'Meta+Digit4', windows: 'Alt+Digit4' },
  { id: 'tabs.5', label: '切换到第 5 个连接标签', scope: 'global', mac: 'Meta+Digit5', windows: 'Alt+Digit5' },
  { id: 'tabs.6', label: '切换到第 6 个连接标签', scope: 'global', mac: 'Meta+Digit6', windows: 'Alt+Digit6' },
  { id: 'tabs.7', label: '切换到第 7 个连接标签', scope: 'global', mac: 'Meta+Digit7', windows: 'Alt+Digit7' },
  { id: 'tabs.8', label: '切换到第 8 个连接标签', scope: 'global', mac: 'Meta+Digit8', windows: 'Alt+Digit8' },
  { id: 'tabs.9', label: '切换到最后一个连接标签', scope: 'global', mac: 'Meta+Digit9', windows: 'Alt+Digit9' },
  { id: 'settings.open', label: '打开工作台设置', scope: 'global', mac: 'Meta+Comma', windows: 'Ctrl+Comma' },
  { id: 'shortcuts.open', label: '打开快捷键设置', scope: 'global', mac: 'Shift+Meta+Comma', windows: 'Ctrl+Shift+Comma' },
  { id: 'sidebar.toggle', label: '切换资产侧栏', scope: 'global', mac: 'Meta+KeyB', windows: 'Ctrl+Shift+KeyB' },
  { id: 'assets.focus-search', label: '搜索授权资产', scope: 'global', mac: 'Alt+Meta+KeyL', windows: 'Ctrl+Shift+KeyL' },
  { id: 'workspace.prepare-split', label: '选择标签用于分屏', scope: 'global', mac: 'Meta+Backslash', windows: 'Ctrl+Shift+Backslash' },
  { id: 'workspace.focus-primary', label: '聚焦主窗格', scope: 'global', mac: 'Shift+Meta+Backslash', windows: null },
  { id: 'tasks.toggle', label: '切换任务抽屉', scope: 'global', mac: 'Shift+Meta+KeyU', windows: 'Ctrl+Shift+KeyU' },
  { id: 'site.add', label: '添加站点', scope: 'global', mac: null, windows: null },
  { id: 'auth.login', label: '登录当前站点', scope: 'global', mac: null, windows: null },
  { id: 'auth.logout', label: '注销当前身份', scope: 'global', mac: null, windows: null },
  { id: 'app.quit', label: '退出工作台', scope: 'global', mac: 'Meta+KeyQ', windows: 'Ctrl+Shift+KeyQ' },
  { id: 'terminal.search', label: '搜索终端输出', scope: 'terminal', mac: 'Meta+KeyF', windows: 'Ctrl+Shift+KeyF' },
  { id: 'terminal.find-next', label: '终端下一个匹配', scope: 'terminal', mac: 'Meta+KeyG', windows: 'F3' },
  { id: 'terminal.find-previous', label: '终端上一个匹配', scope: 'terminal', mac: 'Shift+Meta+KeyG', windows: 'Shift+F3' },
  { id: 'terminal.copy', label: '复制终端选区', scope: 'terminal', mac: 'Meta+KeyC', windows: 'Ctrl+Shift+KeyC' },
  { id: 'terminal.paste', label: '粘贴到终端', scope: 'terminal', mac: 'Meta+KeyV', windows: 'Ctrl+Shift+KeyV' },
  { id: 'terminal.select-all', label: '选择全部终端输出', scope: 'terminal', mac: 'Meta+KeyA', windows: 'Ctrl+Shift+KeyA' },
  { id: 'terminal.clear', label: '清除终端缓冲', scope: 'terminal', mac: 'Shift+Meta+KeyK', windows: 'Ctrl+Shift+Backspace' },
  { id: 'terminal.reconnect', label: '重新连接终端', scope: 'terminal', mac: 'Shift+Meta+KeyR', windows: 'Ctrl+Shift+KeyR' },
  { id: 'terminal.sftp', label: '切换快速 SFTP', scope: 'terminal', mac: 'Shift+Meta+KeyE', windows: 'Ctrl+Shift+KeyE' },
  { id: 'terminal.interrupt', label: '向终端发送中断', scope: 'terminal', mac: null, windows: null },
  { id: 'file.save', label: '保存当前远端文件', scope: 'file', mac: 'Meta+KeyS', windows: 'Ctrl+KeyS' },
  { id: 'file.refresh', label: '刷新远端目录', scope: 'file', mac: 'F5', windows: 'F5' },
  { id: 'database.execute', label: '执行 SQL', scope: 'database', mac: 'Meta+Enter', windows: 'Ctrl+Enter' },
  { id: 'database.cancel', label: '取消 SQL 查询', scope: 'database', mac: null, windows: null },
  { id: 'database.refresh', label: '刷新当前数据表', scope: 'database', mac: 'F5', windows: 'F5' },
  { id: 'database.preview', label: '核对数据库变更', scope: 'database', mac: 'Shift+Meta+Enter', windows: 'Ctrl+Shift+Enter' },
  { id: 'editor.find', label: '编辑器查找', scope: 'editor', mac: 'Meta+KeyF', windows: 'Ctrl+KeyF' },
  { id: 'editor.replace', label: '编辑器替换', scope: 'editor', mac: 'Alt+Meta+KeyF', windows: 'Ctrl+KeyH' },
  { id: 'editor.format', label: '格式化文档', scope: 'editor', mac: 'Alt+Shift+KeyF', windows: 'Alt+Shift+KeyF' },
  { id: 'editor.comment', label: '切换行注释', scope: 'editor', mac: 'Meta+Slash', windows: 'Ctrl+Slash' },
  { id: 'editor.command-palette', label: '编辑器命令面板', scope: 'editor', mac: 'F1', windows: 'F1' }
] as const satisfies readonly { id: string; label: string; scope: ShortcutScope; mac: string | null; windows: string | null }[];

export type ShortcutCommandId = typeof shortcutCommands[number]['id'];
export type ShortcutOverrides = Partial<Record<ShortcutCommandId, string | null>>;
export type ShortcutPreferences = Record<ShortcutPlatform, ShortcutOverrides>;
export type ResolvedShortcuts = Record<ShortcutCommandId, string | null>;

export function defaultShortcutPreferences(): ShortcutPreferences {
  return { darwin: {}, win32: {}, linux: {} };
}

export function shortcutPlatform(platform: string): ShortcutPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

export function defaultShortcut(command: typeof shortcutCommands[number], platform: ShortcutPlatform): string | null {
  return platform === 'darwin' ? command.mac : command.windows;
}

export function resolveShortcuts(preferences: ShortcutPreferences, platform: ShortcutPlatform): ResolvedShortcuts {
  const overrides = preferences[platform];
  return Object.fromEntries(shortcutCommands.map(command => [command.id,
    Object.hasOwn(overrides, command.id) && overrides[command.id] !== undefined ? overrides[command.id] : defaultShortcut(command, platform)
  ])) as ResolvedShortcuts;
}

const codePattern = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Arrow(?:Up|Down|Left|Right)|Enter|Tab|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Comma|Period|Slash|Backslash|Semicolon|Quote|BracketLeft|BracketRight|Backquote|Minus|Equal|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter))$/;
const modifierNames = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

export interface ShortcutKeyEvent {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  key?: string;
  getModifierState?: (key: string) => boolean;
}

export function shortcutFromEvent(event: ShortcutKeyEvent): string | null {
  if (event.isComposing || event.key === 'Dead' || event.getModifierState?.('AltGraph') || !codePattern.test(event.code)) return null;
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code].filter(Boolean).join('+');
}

/** Null means accepted. Bare typing/navigation and OS-reserved combinations cannot be bound. */
export function shortcutBindingError(binding: string, platform: ShortcutPlatform): 'invalid' | 'unmodified' | 'reserved' | null {
  const parts = binding.split('+');
  const code = parts.pop() ?? '';
  const modifiers = modifierNames.filter(modifier => parts.includes(modifier));
  if (!codePattern.test(code) || [...modifiers, code].join('+') !== binding) return 'invalid';
  if (!parts.some(part => part !== 'Shift') && !/^F\d+$/.test(code)) return 'unmodified';
  const has = (modifier: string) => parts.includes(modifier);
  if (platform !== 'darwin' && has('Meta')) return 'reserved';
  if (platform === 'darwin' && has('Meta') && (code === 'Tab' || code === 'Space')) return 'reserved';
  if (platform === 'darwin' && has('Ctrl') && (code === 'Space' || code.startsWith('Arrow'))) return 'reserved';
  if (has('Alt') && (code === 'Tab' || code === 'F4')) return 'reserved';
  if (has('Ctrl') && has('Alt') && code === 'Delete') return 'reserved';
  return null;
}

export function shortcutScopesOverlap(left: ShortcutScope, right: ShortcutScope): boolean {
  if (left === 'global' || right === 'global' || left === right) return true;
  return (left === 'editor' && (right === 'file' || right === 'database')) ||
    (right === 'editor' && (left === 'file' || left === 'database'));
}

export interface ShortcutConflict { command: ShortcutCommandId; other?: ShortcutCommandId; binding: string; reason: 'invalid' | 'unmodified' | 'reserved' | 'conflict' }

export function shortcutConflicts(preferences: ShortcutPreferences, platform: ShortcutPlatform): ShortcutConflict[] {
  const resolved = resolveShortcuts(preferences, platform);
  const issues: ShortcutConflict[] = [];
  for (let index = 0; index < shortcutCommands.length; index++) {
    const command = shortcutCommands[index];
    const binding = resolved[command.id];
    if (binding === null) continue;
    const error = shortcutBindingError(binding, platform);
    if (error) issues.push({ command: command.id, binding, reason: error });
    for (let previous = 0; previous < index; previous++) {
      const other = shortcutCommands[previous];
      if (resolved[other.id] === binding && shortcutScopesOverlap(command.scope, other.scope)) {
        issues.push({ command: command.id, other: other.id, binding, reason: 'conflict' });
      }
    }
  }
  return issues;
}

const commandIds = shortcutCommands.map(command => command.id) as [ShortcutCommandId, ...ShortcutCommandId[]];
const overridesSchema = z.partialRecord(z.enum(commandIds), z.string().max(80).nullable());
export const shortcutPreferencesSchema = z.object({ darwin: overridesSchema, win32: overridesSchema, linux: overridesSchema }).strict().superRefine((preferences, context) => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    for (const issue of shortcutConflicts(preferences, platform)) {
      context.addIssue({ code: 'custom', path: [platform, issue.command], message: `Shortcut ${issue.reason}: ${issue.command}${issue.other ? ` / ${issue.other}` : ''}` });
    }
  }
});

const keyLabels: Readonly<Record<string, string>> = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Backspace: 'Backspace'
};

export function formatShortcut(binding: string | null | undefined, platform: ShortcutPlatform): string {
  if (!binding) return '';
  const parts = binding.split('+');
  const code = parts.pop()!;
  const key = keyLabels[code] ?? code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ');
  if (platform !== 'darwin') return [...parts, key].join('+');
  const symbols: Readonly<Record<string, string>> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
  return parts.map(part => symbols[part] ?? part).join('') + key;
}
