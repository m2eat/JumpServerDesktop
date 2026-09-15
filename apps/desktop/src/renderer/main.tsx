import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@react-aria/i18n';
import './heroui.css';
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import App from './App';
import { initializeTerminalStreams } from './terminal/streams';
import { registerMonacoThemes } from './themes';
import { t, useI18n } from './i18n';
self.MonacoEnvironment = { getWorker(_workerId: string, label: string) { return label === 'json' ? new JsonWorker() : new EditorWorker(); } };
loader.config({ monaco });
registerMonacoThemes(monaco);
function LocalizedApp() {
  const { locale } = useI18n();
  return <I18nProvider locale={locale}><App /></I18nProvider>;
}
const root = document.getElementById('root');
if (!root) throw new Error(t('工作台根节点不存在'));
if (!window.desktop) {
  root.textContent = t('请使用 pnpm dev 或 pnpm start 启动桌面程序。此页面不提供模拟连接或浏览器凭据代理。');
} else {
  initializeTerminalStreams();
  createRoot(root).render(<React.StrictMode><LocalizedApp /></React.StrictMode>);
}
