import { z } from 'zod';
import type { PreferenceSettings, Preferences, ProxySettings } from './index';
import { defaultShortcutPreferences, shortcutPreferencesSchema } from './shortcuts';

const fontFamilySchema = z.string().trim().min(1).max(160);

export const proxySettingsSchema = z.object({
  mode: z.enum(['system', 'direct', 'custom']),
  server: z.string().trim().max(2_048).regex(/^[^\u0000-\u001f\u007f]*$/),
  bypass: z.string().trim().max(2_048).regex(/^[^\u0000-\u001f\u007f]*$/)
}).strict().superRefine((proxy, context) => {
  if (proxy.mode !== 'custom' && !proxy.server) return;
  // A single proxy endpoint, not Chromium's rule/fallback language or a credential URL.
  const match = /^(?:https?|socks5):\/\/(?:\[[0-9a-f:.]+\]|[^:/?#@\s;,=\\%]+):([0-9]+)\/?$/i.exec(proxy.server);
  let valid = Boolean(match && Number(match[1]) >= 1 && Number(match[1]) <= 65_535);
  try {
    const url = new URL(proxy.server);
    valid &&= Boolean(url.hostname && !url.username && !url.password && !url.search && !url.hash);
  } catch {
    valid = false;
  }
  if (!valid) context.addIssue({ code: 'custom', path: ['server'], message: '代理地址必须是含有效端口的 HTTP、HTTPS 或 SOCKS5 地址，且不能包含账号、密码或路径。' });
}) satisfies z.ZodType<ProxySettings>;

export const preferenceSettingsSchema = z.object({
  fontSize: z.number().int().min(8).max(32),
  terminalFont: fontFamilySchema,
  scrollback: z.number().int().min(100).max(200_000),
  terminalCursorStyle: z.enum(['block', 'underline', 'bar']),
  terminalCursorBlink: z.boolean(),
  terminalLineHeight: z.number().min(1).max(2).finite(),
  terminalCopyOnSelect: z.boolean(),
  editorFont: fontFamilySchema,
  editorFontSize: z.number().int().min(8).max(32),
  editorTabSize: z.union([z.literal(2), z.literal(4), z.literal(8)]),
  fileWordWrap: z.boolean(),
  databasePageSize: z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(500)]),
  databaseWordWrap: z.boolean(),
  databaseShowLineNumbers: z.boolean(),
  databaseResultFontSize: z.number().int().min(10).max(24),
  databaseRowDensity: z.enum(['comfortable', 'compact']),
  theme: z.enum([
    'jumpserver',
    'catppuccin-mocha',
    'dracula',
    'nord',
    'tokyo-night',
    'solarized-dark',
    'solarized-light',
    'github-light',
    'system'
  ]),
  language: z.enum(['system', 'zh-CN', 'en-US']),
  autoCheckUpdates: z.boolean(),
  autoDownloadUpdates: z.boolean(),
  proxy: proxySettingsSchema,
  shortcuts: shortcutPreferencesSchema
}).strict() satisfies z.ZodType<PreferenceSettings>;

export function defaultPreferenceSettings(): PreferenceSettings {
  const terminalFont = 'Menlo, Monaco, Consolas, monospace';
  return {
    fontSize: 14,
    terminalFont,
    scrollback: 10_000,
    terminalCursorStyle: 'bar',
    terminalCursorBlink: true,
    terminalLineHeight: 1.22,
    terminalCopyOnSelect: false,
    editorFont: terminalFont,
    editorFontSize: 14,
    editorTabSize: 2,
    fileWordWrap: false,
    databasePageSize: 200,
    databaseWordWrap: true,
    databaseShowLineNumbers: true,
    databaseResultFontSize: 12,
    databaseRowDensity: 'comfortable',
    theme: 'jumpserver',
    language: 'system',
    autoCheckUpdates: true,
    autoDownloadUpdates: false,
    proxy: { mode: 'system', server: '', bypass: '' },
    shortcuts: defaultShortcutPreferences()
  };
}

export function defaultPreferences(): Preferences {
  return { ...defaultPreferenceSettings(), favorites: [], recent: [] };
}
