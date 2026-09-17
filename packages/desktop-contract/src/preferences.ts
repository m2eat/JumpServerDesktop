import { z } from 'zod';
import type { PreferenceSettings, Preferences } from './index';

const fontFamilySchema = z.string().trim().min(1).max(160);

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
  autoDownloadUpdates: z.boolean()
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
    autoDownloadUpdates: false
  };
}

export function defaultPreferences(): Preferences {
  return { ...defaultPreferenceSettings(), favorites: [], recent: [] };
}
