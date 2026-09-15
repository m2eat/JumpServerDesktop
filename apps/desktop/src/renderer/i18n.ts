import { createInstance } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import type { LanguageSetting } from '@shared/index';
import { appMessages } from './locales/app';
import { settingsMessages } from './locales/settings';
import { terminalMessages } from './locales/terminal';
import { databaseMessages } from './locales/database';
import { filesMessages } from './locales/files';
import { workspaceMessages } from './locales/workspace';

type Locale = 'zh-CN' | 'en-US';
type Values = Record<string, string | number>;
const messages: Record<string, string> = {
  ...appMessages, ...settingsMessages, ...terminalMessages,
  ...databaseMessages, ...filesMessages, ...workspaceMessages
};

function systemLocale(): Locale {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: systemLocale(),
  supportedLngs: ['zh-CN', 'en-US'],
  load: 'currentOnly',
  fallbackLng: false,
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  resources: { 'zh-CN': { translation: {} }, 'en-US': { translation: messages } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false }
});

let languageSetting: LanguageSetting = 'system';
const locale = (): Locale => i18n.resolvedLanguage === 'zh-CN' || i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';

export function t(key: string, values?: Values): string {
  return i18n.t(key, { ...values, defaultValue: key });
}

export function useI18n(): { t: typeof t; locale: Locale } {
  useTranslation('translation', { i18n });
  return { t, locale: locale() };
}

export async function setLanguage(setting: LanguageSetting): Promise<void> {
  languageSetting = setting;
  const next = setting === 'system' ? systemLocale() : setting;
  await i18n.changeLanguage(next);
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    if (languageSetting === 'system') void setLanguage('system');
  });
}

// Only known local diagnostics are translated. Captured values and unknown
// server/transport details remain verbatim, including SQL and user names.
const diagnosticTemplates = Object.keys(messages).flatMap((key) => {
  const parameters = [...key.matchAll(/\{\{(\w+)\}\}/g)];
  if (parameters.length === 0) return [];
  let previous = 0;
  let pattern = '^';
  for (const parameter of parameters) {
    pattern += escapePattern(key.slice(previous, parameter.index)) + '(.*?)';
    previous = parameter.index! + parameter[0].length;
  }
  pattern += escapePattern(key.slice(previous)) + '$';
  return [{ key, names: parameters.map((parameter) => parameter[1]!), pattern: new RegExp(pattern, 's') }];
});

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function translateDiagnostic(message: string): string {
  if (locale() === 'zh-CN') return message;
  if (Object.hasOwn(messages, message)) return t(message);
  if (message.length > 16_384 || !/[\u3400-\u9fff]/.test(message)) return message;
  for (const template of diagnosticTemplates) {
    const match = template.pattern.exec(message);
    if (match) {
      const values: Values = {};
      template.names.forEach((name, index) => { values[name] = match[index + 1]!; });
      return t(template.key, values);
    }
  }
  return message;
}

const numberFormats = new Map<Locale, Intl.NumberFormat>();
const dateFormats = new Map<Locale, Intl.DateTimeFormat>();
export function formatNumber(value: number): string {
  const language = locale();
  let formatter = numberFormats.get(language);
  if (!formatter) { formatter = new Intl.NumberFormat(language); numberFormats.set(language, formatter); }
  return formatter.format(value);
}
export function formatDateTime(value: number | Date): string {
  const language = locale();
  let formatter = dateFormats.get(language);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' });
    dateFormats.set(language, formatter);
  }
  return formatter.format(value);
}
