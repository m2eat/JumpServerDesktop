import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import {
  defaultShortcut, formatShortcut, resolveShortcuts, shortcutCommands, shortcutFromEvent, shortcutPlatform,
  type ShortcutCommandId, type ShortcutPreferences
} from '@shared/shortcuts';

export type ShortcutHandlers = Partial<Record<ShortcutCommandId, () => boolean | void>>;
type Registration = { root: RefObject<HTMLElement | null>; handlers: { current: ShortcutHandlers } };
const registrations = new Set<Registration>();

/** Register only actions that belong to this focusable surface; mounted background panes never run. */
export function useShortcutScope(root: RefObject<HTMLElement | null>, handlers: ShortcutHandlers): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const registration = { root, handlers: current };
    registrations.add(registration);
    return () => { registrations.delete(registration); };
  }, [root]);
}

export function shortcutLabel(id: ShortcutCommandId, preferences: ShortcutPreferences, platform = window.desktop.platform): string {
  const target = shortcutPlatform(platform);
  const command = shortcutCommands.find(command => command.id === id)!;
  const binding = preferences[target][id];
  return formatShortcut(binding === undefined ? defaultShortcut(command, target) : binding, target);
}

/** One capture listener owns application shortcuts before xterm/Monaco or native text handling. */
export function useAppShortcuts(preferences: ShortcutPreferences, handlers: ShortcutHandlers): void {
  const platform = shortcutPlatform(window.desktop.platform);
  const resolved = useMemo(() => resolveShortcuts(preferences, platform), [preferences, platform]);
  const latest = useRef({ resolved, handlers });
  latest.current = { resolved, handlers };

  useEffect(() => {
    let composing = false;
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => { composing = false; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || composing || event.keyCode === 229) return;
      if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d+$/.test(event.code)) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (!target || target.closest('[inert]') || document.querySelector('[data-shortcut-recording]')) return;
      // Modal navigation and its own Enter/Escape handling take precedence over workstation actions.
      if (document.querySelector('[data-slot="modal-dialog"], [role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
      const binding = shortcutFromEvent(event);
      if (!binding) return;
      const { resolved: current, handlers: global } = latest.current;
      const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      const execute = (actions: ShortcutHandlers): boolean => {
        for (const command of shortcutCommands) {
          const action = actions[command.id];
          if (action && current[command.id] === binding && (event.repeat || action() !== false)) { consume(); return true; }
        }
        return false;
      };
      // Scoped actions get first refusal; conflict validation forbids ambiguous global/local bindings.
      for (const registration of registrations) {
        if (registration.root.current?.contains(target) && execute(registration.handlers.current)) return;
      }
      if (execute(global)) return;
      for (const command of shortcutCommands) {
        if (global[command.id] && defaultShortcut(command, platform) === binding && current[command.id] !== binding) {
          consume();
          return;
        }
      }
      // Rebound/cleared editor and terminal defaults must not leak to the embedded widget's keymap.
      for (const registration of registrations) {
        if (!registration.root.current?.contains(target)) continue;
        for (const command of shortcutCommands) {
          if (registration.handlers.current[command.id] && defaultShortcut(command, platform) === binding && current[command.id] !== binding) {
            consume();
            return;
          }
        }
      }
    };
    // macOS normally routes text editing through menu accelerators. Keep it native after
    // application/widget handlers have declined the chord, without restoring menu precedence.
    const onNativeEdit = (event: KeyboardEvent) => {
      if (platform !== 'darwin' || event.defaultPrevented || event.isComposing || composing || !event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || (!target.matches('input, textarea') && !target.isContentEditable && window.getSelection()?.isCollapsed !== false)) return;
      const action = event.code === 'KeyZ' ? (event.shiftKey ? 'redo' : 'undo')
        : event.shiftKey ? null
        : event.code === 'KeyA' ? 'selectAll' : event.code === 'KeyC' ? 'copy'
        : event.code === 'KeyX' ? 'cut' : event.code === 'KeyV' ? 'paste' : null;
      if (!action) return;
      event.preventDefault();
      void window.desktop.invoke('app.edit', { action }).catch(error => console.error('Native text editing failed', error));
    };
    window.addEventListener('compositionstart', compositionStart, true);
    window.addEventListener('compositionend', compositionEnd, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onNativeEdit);
    return () => {
      window.removeEventListener('compositionstart', compositionStart, true);
      window.removeEventListener('compositionend', compositionEnd, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keydown', onNativeEdit);
    };
  }, [platform]);
}
