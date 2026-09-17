import type { editor as MonacoEditor } from 'monaco-editor';
import type { ShortcutCommandId } from '@shared/shortcuts';

type MonacoShortcutCommand = Extract<ShortcutCommandId, `editor.${string}`>;

const monacoActions: Readonly<Record<MonacoShortcutCommand, string>> = {
  'editor.find': 'actions.find',
  'editor.replace': 'editor.action.startFindReplaceAction',
  'editor.format': 'editor.action.formatDocument',
  'editor.comment': 'editor.action.commentLine',
  'editor.command-palette': 'editor.action.quickCommand',
};

/** Runs Monaco's own action without installing another keybinding. */
export function triggerMonacoShortcut(editor: MonacoEditor.IStandaloneCodeEditor | null, command: MonacoShortcutCommand): boolean {
  const action = editor?.getAction(monacoActions[command]);
  if (!editor || !editor.hasTextFocus() || !action) return false;
  editor.trigger('shortcut', monacoActions[command], null);
  return true;
}
