import { describe, expect, it } from 'vitest';
import { defaultShortcutPreferences, resolveShortcuts, shortcutBindingError, shortcutConflicts, shortcutFromEvent, shortcutPreferencesSchema } from './shortcuts';

describe('application shortcut bindings', () => {
  it('keeps every platform default free of overlapping commands and reserved keys', () => {
    const preferences = defaultShortcutPreferences();
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(shortcutConflicts(preferences, platform)).toEqual([]);
    }
    expect(shortcutPreferencesSchema.safeParse(preferences).success).toBe(true);
  });

  it('distinguishes removal from inheritance and isolates platform overrides', () => {
    const preferences = defaultShortcutPreferences();
    const original = resolveShortcuts(preferences, 'win32');
    preferences.darwin['picker.open'] = 'Shift+Meta+KeyP';
    preferences.win32['picker.open'] = null;
    preferences.win32['tabs.new'] = undefined;
    expect(resolveShortcuts(preferences, 'darwin')['picker.open']).toBe('Shift+Meta+KeyP');
    expect(resolveShortcuts(preferences, 'win32')['picker.open']).toBeNull();
    expect(resolveShortcuts(preferences, 'win32')['tabs.new']).toBe(original['tabs.new']);
    expect(resolveShortcuts(preferences, 'linux')['picker.open']).toBe(original['picker.open']);
    delete preferences.win32['picker.open'];
    expect(resolveShortcuts(preferences, 'win32')).toEqual(original);
  });

  it('rejects global and editor overlap while allowing independent surfaces', () => {
    const preferences = defaultShortcutPreferences();
    preferences.win32 = { 'terminal.search': 'F8', 'editor.find': 'F8', 'file.refresh': 'F9', 'database.refresh': 'F9' };
    expect(shortcutConflicts(preferences, 'win32')).toEqual([]);
    preferences.win32['picker.open'] = 'F8';
    expect(shortcutConflicts(preferences, 'win32')).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'terminal.search', other: 'picker.open', reason: 'conflict' }),
      expect.objectContaining({ command: 'editor.find', other: 'picker.open', reason: 'conflict' })
    ]));
    delete preferences.win32['picker.open'];
    preferences.win32['file.save'] = 'F8';
    expect(shortcutConflicts(preferences, 'win32')).toEqual([
      expect.objectContaining({ command: 'editor.find', other: 'file.save', reason: 'conflict' })
    ]);
    expect(shortcutPreferencesSchema.safeParse(preferences).success).toBe(false);
  });

  it('rejects malformed, typing-only and operating-system bindings', () => {
    for (const binding of ['Shift+Ctrl+KeyK', 'Ctrl+Ctrl+KeyK', 'Control+KeyK', 'Ctrl+Escape']) {
      expect(shortcutBindingError(binding, 'win32')).toBe('invalid');
    }
    for (const binding of ['KeyK', 'Shift+KeyK', 'Tab', 'Enter']) {
      expect(shortcutBindingError(binding, 'win32')).toBe('unmodified');
    }
    for (const binding of ['Meta+KeyK', 'Alt+F4', 'Alt+Tab', 'Ctrl+Alt+Delete']) {
      expect(shortcutBindingError(binding, 'win32')).toBe('reserved');
    }
    for (const binding of ['Meta+Tab', 'Meta+Space', 'Ctrl+Space', 'Ctrl+ArrowLeft']) {
      expect(shortcutBindingError(binding, 'darwin')).toBe('reserved');
    }
    expect(shortcutBindingError('Shift+F3', 'win32')).toBeNull();
  });

  it('records physical keys without consuming composition or AltGraph input', () => {
    const event = { code: 'KeyF', key: 'ƒ', ctrlKey: false, altKey: true, shiftKey: false, metaKey: true };
    expect(shortcutFromEvent(event)).toBe('Alt+Meta+KeyF');
    expect(shortcutFromEvent({ ...event, isComposing: true })).toBeNull();
    expect(shortcutFromEvent({ ...event, key: 'Dead' })).toBeNull();
    expect(shortcutFromEvent({ ...event, getModifierState: key => key === 'AltGraph' })).toBeNull();
    expect(shortcutFromEvent({ ...event, code: 'MetaLeft' })).toBeNull();
  });

  it('rejects unknown action names rather than silently losing saved bindings', () => {
    expect(shortcutPreferencesSchema.safeParse({ ...defaultShortcutPreferences(), win32: { 'tabs.typo': 'F8' } }).success).toBe(false);
  });
});
