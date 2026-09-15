import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { Button, ComboBox, Input, Label, ListBox, Select, Switch } from '@heroui/react';
import { Check, CircleAlert, LoaderCircle, RefreshCw, RotateCcw, Save } from 'lucide-react';
import type { PreferenceSettings, Preferences } from '@shared/index';
import { defaultPreferenceSettings, preferenceSettingsSchema } from '@shared/preferences';
import { useI18n } from '../i18n';
import { themes } from '../themes';
import AppUpdateSection from './AppUpdateSection';
import './SettingsPage.css';

interface SettingsPageProps {
  preferences: Preferences;
  onSave: (settings: PreferenceSettings) => Promise<boolean>;
  onNotify: (message: string, tone: 'success' | 'error') => void;
  siteSection?: ReactNode;
}

type FontLoadState =
  | { stage: 'loading'; fonts: readonly string[] }
  | { stage: 'ready'; fonts: readonly string[] }
  | { stage: 'empty'; fonts: readonly string[] }
  | { stage: 'error'; fonts: readonly string[]; detail: string };

type SettingsDraft = Omit<PreferenceSettings, 'fontSize' | 'scrollback' | 'terminalLineHeight' | 'editorFontSize' | 'databaseResultFontSize'> & {
  fontSize: string;
  scrollback: string;
  terminalLineHeight: string;
  editorFontSize: string;
  databaseResultFontSize: string;
};

type Translate = (key: string, values?: Record<string, string | number>) => string;

const terminalCursorStyles = ['block', 'underline', 'bar'] as const;
const editorTabSizes = [2, 4, 8] as const;
const databasePageSizes = [50, 100, 200, 500] as const;

function settingsFromPreferences(preferences: Preferences): PreferenceSettings {
  const { favorites: _favorites, recent: _recent, ...settings } = preferences;
  return settings;
}

function draftFromSettings(settings: PreferenceSettings): SettingsDraft {
  return {
    ...settings,
    fontSize: String(settings.fontSize),
    scrollback: String(settings.scrollback),
    terminalLineHeight: String(settings.terminalLineHeight),
    editorFontSize: String(settings.editorFontSize),
    databaseResultFontSize: String(settings.databaseResultFontSize)
  };
}

function settingsEqual(left: PreferenceSettings, right: PreferenceSettings): boolean {
  return left.fontSize === right.fontSize
    && left.terminalFont === right.terminalFont
    && left.scrollback === right.scrollback
    && left.terminalCursorStyle === right.terminalCursorStyle
    && left.terminalCursorBlink === right.terminalCursorBlink
    && left.terminalLineHeight === right.terminalLineHeight
    && left.terminalCopyOnSelect === right.terminalCopyOnSelect
    && left.editorFont === right.editorFont
    && left.editorFontSize === right.editorFontSize
    && left.editorTabSize === right.editorTabSize
    && left.fileWordWrap === right.fileWordWrap
    && left.databasePageSize === right.databasePageSize
    && left.databaseWordWrap === right.databaseWordWrap
    && left.databaseShowLineNumbers === right.databaseShowLineNumbers
    && left.databaseResultFontSize === right.databaseResultFontSize
    && left.databaseRowDensity === right.databaseRowDensity
    && left.theme === right.theme
    && left.language === right.language;
}

function integerInRange(value: string, min: number, max: number): number | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

function decimalInRange(value: string, min: number, max: number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

function validateDraft(draft: SettingsDraft, t: Translate): { settings: PreferenceSettings | null; error: string | null } {
  const terminalFont = draft.terminalFont.trim();
  const editorFont = draft.editorFont.trim();
  if (terminalFont.length === 0 || terminalFont.length > 160) {
    return { settings: null, error: t('终端字体必须为 1 到 160 个字符。') };
  }
  if (editorFont.length === 0 || editorFont.length > 160) {
    return { settings: null, error: t('编辑器字体必须为 1 到 160 个字符。') };
  }
  if (!CSS.supports('font-family', terminalFont) || !CSS.supports('font-family', editorFont)) {
    return { settings: null, error: t('请输入有效的字体名称或 CSS 字体列表。') };
  }

  const fontSize = integerInRange(draft.fontSize, 8, 32);
  if (fontSize === null) return { settings: null, error: t('“{{name}}”必须是 {{min}} 到 {{max}} 之间的整数。', { name: t('终端字号'), min: 8, max: 32 }) };

  const scrollback = integerInRange(draft.scrollback, 100, 200000);
  if (scrollback === null) return { settings: null, error: t('“{{name}}”必须是 {{min}} 到 {{max}} 之间的整数。', { name: t('回滚行数'), min: 100, max: 200000 }) };

  const terminalLineHeight = decimalInRange(draft.terminalLineHeight, 1, 2);
  if (terminalLineHeight === null) return { settings: null, error: t('终端行高必须是 1 到 2 之间的数字。') };

  const editorFontSize = integerInRange(draft.editorFontSize, 8, 32);
  if (editorFontSize === null) return { settings: null, error: t('“{{name}}”必须是 {{min}} 到 {{max}} 之间的整数。', { name: t('编辑器字号'), min: 8, max: 32 }) };

  const databaseResultFontSize = integerInRange(draft.databaseResultFontSize, 10, 24);
  if (databaseResultFontSize === null) return { settings: null, error: t('“{{name}}”必须是 {{min}} 到 {{max}} 之间的整数。', { name: t('结果字号'), min: 10, max: 24 }) };

  if (!terminalCursorStyles.includes(draft.terminalCursorStyle)) {
    return { settings: null, error: t('请选择有效的终端光标样式。') };
  }
  if (!editorTabSizes.includes(draft.editorTabSize)) {
    return { settings: null, error: t('请选择有效的编辑器制表符宽度。') };
  }
  if (!databasePageSizes.includes(draft.databasePageSize)) {
    return { settings: null, error: t('请选择有效的 MySQL 页面大小。') };
  }
  if (draft.databaseRowDensity !== 'comfortable' && draft.databaseRowDensity !== 'compact') {
    return { settings: null, error: t('请选择有效的结果行密度。') };
  }
  if (draft.language !== 'system' && draft.language !== 'zh-CN' && draft.language !== 'en-US') {
    return { settings: null, error: t('请选择有效的显示语言。') };
  }
  if (draft.theme !== 'system' && !themes.some((theme) => theme.id === draft.theme)) {
    return { settings: null, error: t('请选择有效的应用主题。') };
  }

  const parsed = preferenceSettingsSchema.safeParse({
    ...draft,
    fontSize,
    scrollback,
    terminalLineHeight,
    editorFontSize,
    databaseResultFontSize,
    terminalFont,
    editorFont
  });
  if (!parsed.success) return { settings: null, error: t('设置包含无效值。') };
  return { settings: parsed.data, error: null };
}

function fontOptionValue(name: string): string {
  return `${JSON.stringify(name)}, monospace`;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return String(error);
}

interface FontFamilyControlProps {
  id: string;
  label: string;
  locale: 'zh-CN' | 'en-US';
  value: string;
  fonts: readonly string[];
  state: FontLoadState;
  pending: boolean;
  onChange: (value: string) => void;
  onRetry: () => void;
  t: Translate;
}

function FontFamilyControl({ id, label, locale, value, fonts, state, pending, onChange, onRetry, t }: FontFamilyControlProps): ReactNode {
  const selectedFontInList = fonts.some((font) => fontOptionValue(font) === value);
  const choices = useMemo(() => {
    const localFonts = fonts.map((font) => ({ id: fontOptionValue(font), label: font, isCurrent: false }));
    return selectedFontInList || value.trim().length === 0
      ? localFonts
      : [{ id: value, label: t('当前字体：{{font}}', { font: value }), isCurrent: true }, ...localFonts];
  }, [fonts, locale, selectedFontInList, t, value]);
  const filteredChoices = useMemo(() => {
    if (selectedFontInList) return choices;
    const query = value.trim().toLocaleLowerCase();
    return query.length === 0
      ? choices
      : choices.filter((choice) => choice.isCurrent || choice.label.toLocaleLowerCase().includes(query));
  }, [choices, selectedFontInList, value]);

  return <div className="settings-font-control">
    <ComboBox
      allowsCustomValue
      allowsEmptyCollection
      aria-label={label}
      className="settings-font-combobox"
      defaultFilter={() => true}
      inputValue={value}
      isDisabled={pending}
      menuTrigger="focus"
      selectedKey={value}
      onInputChange={onChange}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
    >
      <ComboBox.InputGroup className="settings-font-entry">
        <Input id={id} aria-label={label} className="settings-font-input" fullWidth maxLength={160} type="text" variant="secondary" />
        <ComboBox.Trigger aria-label={t('选择本机字体')} isDisabled={pending} />
      </ComboBox.InputGroup>
      <ComboBox.Popover className="settings-font-picker">
        {state.stage === 'loading' && <p className="settings-font-status" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" />{t('正在读取本机字体…')}</p>}
        {state.stage === 'error' && <div className="settings-font-status is-error" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>{t('无法读取本机字体：{{detail}}', { detail: state.detail })}</span><Button className="settings-font-retry" isDisabled={pending} type="button" variant="ghost" onPress={onRetry}><RefreshCw size={14} aria-hidden="true" />{t('重试')}</Button></div>}
        {state.stage === 'empty' && <div className="settings-font-status"><span>{t('未找到可用的本机字体。')}</span><Button className="settings-font-retry" isDisabled={pending} type="button" variant="ghost" onPress={onRetry}><RefreshCw size={14} aria-hidden="true" />{t('重试')}</Button></div>}
        {state.stage === 'ready' && (filteredChoices.length === 0
          ? <p className="settings-font-status">{t('没有匹配的本机字体。')}</p>
          : <ListBox aria-label={t('本机字体列表')} className="settings-font-options" disabledKeys={pending ? choices.map((choice) => choice.id) : undefined}>
            {filteredChoices.map((choice) => <ListBox.Item key={choice.id} id={choice.id} textValue={choice.id}>
              <span className="settings-font-option-copy"><span className="settings-font-option-title">{choice.label}</span>{choice.isCurrent && <span className="settings-font-option-note">{t('保留的当前值')}</span>}</span><ListBox.ItemIndicator />
            </ListBox.Item>)}
          </ListBox>)}
      </ComboBox.Popover>
    </ComboBox>
    <p className="settings-font-preview" style={{ '--settings-font-preview': value } as CSSProperties}>{t('字体预览：Aa 中文 0123456789')}</p>
  </div>;
}

export default function SettingsPage({ preferences, onNotify, onSave, siteSection }: SettingsPageProps): ReactNode {
  const { t, locale } = useI18n();
  const incomingSettings = useMemo(() => settingsFromPreferences(preferences), [
    preferences.databasePageSize,
    preferences.databaseResultFontSize,
    preferences.databaseRowDensity,
    preferences.databaseShowLineNumbers,
    preferences.databaseWordWrap,
    preferences.editorFont,
    preferences.editorFontSize,
    preferences.editorTabSize,
    preferences.fileWordWrap,
    preferences.fontSize,
    preferences.language,
    preferences.scrollback,
    preferences.terminalCopyOnSelect,
    preferences.terminalCursorBlink,
    preferences.terminalCursorStyle,
    preferences.terminalFont,
    preferences.terminalLineHeight,
    preferences.theme
  ]);
  const [savedBaseline, setSavedBaseline] = useState<PreferenceSettings>(() => incomingSettings);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(incomingSettings));
  const [pending, setPending] = useState(false);
  const [fontState, setFontState] = useState<FontLoadState>({ stage: 'loading', fonts: [] });
  const fontRequest = useRef(0);

  useEffect(() => {
    setSavedBaseline((previous) => {
      if (settingsEqual(previous, incomingSettings)) return previous;
      setDraft((current) => {
        const currentValidation = validateDraft(current, t);
        const isDirty = currentValidation.settings === null || !settingsEqual(currentValidation.settings, previous);
        return isDirty ? current : draftFromSettings(incomingSettings);
      });
      return incomingSettings;
    });
  }, [incomingSettings]);

  const loadFonts = useCallback(async (refresh = false) => {
    const request = ++fontRequest.current;
    setFontState({ stage: 'loading', fonts: [] });
    try {
      const result = await window.desktop.invoke('app.fonts', refresh ? { refresh: true } : {});
      if (request !== fontRequest.current) return;
      const fonts = [...new Set(result.filter((font) => typeof font === 'string').map((font) => font.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
      setFontState(fonts.length === 0 ? { stage: 'empty', fonts } : { stage: 'ready', fonts });
    } catch (error: unknown) {
      if (request === fontRequest.current) setFontState({ stage: 'error', fonts: [], detail: errorDetail(error) });
    }
  }, []);

  useEffect(() => {
    void loadFonts();
    return () => { fontRequest.current++; };
  }, [loadFonts]);

  const validation = useMemo(() => validateDraft(draft, t), [draft, locale, t]);
  const dirty = validation.settings === null || !settingsEqual(validation.settings, savedBaseline);

  const updateDraft = useCallback((update: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, ...update }));
  }, []);

  const restoreDefaults = () => {
    updateDraft(draftFromSettings(defaultPreferenceSettings()));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    if (validation.settings === null) return;
    setPending(true);
    try {
      const didSave = await onSave(validation.settings);
      if (!didSave) return;
      setSavedBaseline(validation.settings);
      setDraft(draftFromSettings(validation.settings));
      onNotify(t('设置已保存并应用。'), 'success');
    } catch {
      onNotify(t('设置未保存。请检查连接后重试。'), 'error');
    } finally {
      setPending(false);
    }
  };

  return <section className="settings-page preferences-screen" aria-labelledby="settings-page-title">
    <header className="preferences-header">
      <div className="preferences-header-copy">
        <h1 id="settings-page-title">{t('设置')}</h1>
        <p>{t('这些设备设置会在登录状态变化后继续保留。')}</p>
        {validation.error && <p className="settings-validation" role="alert"><CircleAlert size={15} aria-hidden="true" />{validation.error}</p>}
      </div>
      <div className="settings-header-actions">
        {dirty && <span className="preferences-dirty" aria-live="polite">{t('有未保存的更改。')}</span>}
        <div>
          <Button className="app-action button-quiet" form="settings-preferences-form" isDisabled={pending} type="button" variant="tertiary" onPress={restoreDefaults}><RotateCcw size={15} aria-hidden="true" />{t('恢复默认值')}</Button>
          <Button className="app-action button-primary" form="settings-preferences-form" isDisabled={pending || !dirty || validation.settings === null} type="submit" variant="primary">{pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}{pending ? t('正在保存设置…') : t('保存并应用')}</Button>
        </div>
      </div>
    </header>
    <AppUpdateSection installBlocked={dirty || pending} onNotify={onNotify} />

    <form id="settings-preferences-form" className="preferences-form" onSubmit={(event) => void submit(event)} aria-busy={pending} noValidate>
      <fieldset className="settings-controls" disabled={pending}>
      <section className="settings-section" aria-labelledby="appearance-settings-title">
        <div className="settings-section-heading"><div><h2 id="appearance-settings-title">{t('外观与语言')}</h2><p>{t('选择应用主题和显示语言。主题将在保存后应用。')}</p></div></div>
        <div className="settings-grid">
          <Select className="settings-field settings-select" fullWidth isDisabled={pending} selectedKey={draft.language} variant="secondary" onSelectionChange={(key) => {
            if (key !== null) updateDraft({ language: String(key) as SettingsDraft['language'] });
          }}>
            <Label>{t('显示语言')}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover className="settings-select-popover"><ListBox disabledKeys={pending ? ['system', 'zh-CN', 'en-US'] : undefined}><ListBox.Item id="system">{t('跟随系统')}</ListBox.Item><ListBox.Item id="zh-CN">{t('简体中文')}</ListBox.Item><ListBox.Item id="en-US">{t('English')}</ListBox.Item></ListBox></Select.Popover>
          </Select>
          <Select className="settings-field settings-select" fullWidth isDisabled={pending} selectedKey={draft.theme} variant="secondary" onSelectionChange={(key) => {
            if (key !== null) updateDraft({ theme: String(key) as SettingsDraft['theme'] });
          }}>
            <Label>{t('应用主题')}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover className="settings-select-popover"><ListBox disabledKeys={pending ? ['system', ...themes.map((theme) => theme.id)] : undefined}><ListBox.Item id="system">{t('跟随系统')}</ListBox.Item>{themes.map((theme) => <ListBox.Item key={theme.id} id={theme.id}>{theme.name}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
        </div>
        <div className="settings-theme-cards" aria-label={t('应用主题')}>
          {themes.map((theme) => <Button key={theme.id} aria-pressed={draft.theme === theme.id} className={draft.theme === theme.id ? 'settings-theme-card is-selected' : 'settings-theme-card'} isDisabled={pending} type="button" variant="secondary" onPress={() => updateDraft({ theme: theme.id })}>
            <div className="settings-theme-preview" style={theme.colors as CSSProperties} aria-hidden="true"><div><i /><b /><em /></div><span><strong>JumpServer</strong><small>$ echo ready</small></span></div>
            <span className="settings-theme-name">{theme.name}</span>{draft.theme === theme.id && <Check size={15} aria-label={t('已选择')} />}
          </Button>)}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="terminal-settings-title">
        <div className="settings-section-heading"><div><h2 id="terminal-settings-title">{t('终端')}</h2><p>{t('控制新建和已打开终端的字体、光标与缓冲行为。')}</p></div></div>
        <div className="settings-stack">
          <div className="settings-field is-wide"><label htmlFor="settings-terminal-font">{t('终端字体')}</label><FontFamilyControl id="settings-terminal-font" label={t('终端字体')} locale={locale} value={draft.terminalFont} fonts={fontState.fonts} state={fontState} pending={pending} onChange={(terminalFont) => updateDraft({ terminalFont })} onRetry={() => void loadFonts(true)} t={t} /></div>
          <div className="settings-grid">
            <label className="settings-field" htmlFor="settings-terminal-size"><span>{t('终端字号')}</span><Input id="settings-terminal-size" aria-invalid={integerInRange(draft.fontSize, 8, 32) === null} fullWidth inputMode="numeric" disabled={pending} type="text" value={draft.fontSize} variant="secondary" onChange={(event) => updateDraft({ fontSize: event.target.value })} /></label>
            <Select className="settings-field settings-select" fullWidth isDisabled={pending} selectedKey={draft.terminalCursorStyle} variant="secondary" onSelectionChange={(key) => {
              if (key !== null) updateDraft({ terminalCursorStyle: String(key) as SettingsDraft['terminalCursorStyle'] });
            }}>
              <Label>{t('光标样式')}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover className="settings-select-popover"><ListBox disabledKeys={pending ? [...terminalCursorStyles] : undefined}><ListBox.Item id="block">{t('方块')}</ListBox.Item><ListBox.Item id="underline">{t('下划线')}</ListBox.Item><ListBox.Item id="bar">{t('竖线')}</ListBox.Item></ListBox></Select.Popover>
            </Select>
            <label className="settings-field" htmlFor="settings-line-height"><span>{t('终端行高')}</span><Input id="settings-line-height" aria-invalid={decimalInRange(draft.terminalLineHeight, 1, 2) === null} fullWidth inputMode="decimal" disabled={pending} type="text" value={draft.terminalLineHeight} variant="secondary" onChange={(event) => updateDraft({ terminalLineHeight: event.target.value })} /></label>
            <label className="settings-field" htmlFor="settings-scrollback"><span>{t('回滚行数')}</span><Input id="settings-scrollback" aria-invalid={integerInRange(draft.scrollback, 100, 200000) === null} fullWidth inputMode="numeric" disabled={pending} type="text" value={draft.scrollback} variant="secondary" onChange={(event) => updateDraft({ scrollback: event.target.value })} /></label>
          </div>
          <div className="settings-toggle-row">
            <Switch isDisabled={pending} isSelected={draft.terminalCursorBlink} size="sm" onChange={(terminalCursorBlink) => updateDraft({ terminalCursorBlink })}><Switch.Content><Label>{t('光标闪烁')}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>
            <Switch isDisabled={pending} isSelected={draft.terminalCopyOnSelect} size="sm" onChange={(terminalCopyOnSelect) => updateDraft({ terminalCopyOnSelect })}><Switch.Content><Label>{t('选中时复制')}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="database-settings-title">
        <div className="settings-section-heading"><div><h2 id="database-settings-title">{t('MySQL')}</h2><p>{t('设置查询结果、表格与 SQL 编辑行为。')}</p></div></div>
        <div className="settings-stack">
        <div className="settings-grid">
          <Select className="settings-field settings-select" fullWidth isDisabled={pending} selectedKey={draft.databasePageSize} variant="secondary" onSelectionChange={(key) => {
            if (key !== null) updateDraft({ databasePageSize: Number(key) as SettingsDraft['databasePageSize'] });
          }}>
            <Label>{t('每页结果数')}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover className="settings-select-popover"><ListBox disabledKeys={pending ? [...databasePageSizes] : undefined}>{databasePageSizes.map((size) => <ListBox.Item key={size} id={size}>{t('{{count}} 行', { count: size })}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
          <label className="settings-field" htmlFor="settings-result-size"><span>{t('结果字号')}</span><Input id="settings-result-size" aria-invalid={integerInRange(draft.databaseResultFontSize, 10, 24) === null} fullWidth inputMode="numeric" disabled={pending} type="text" value={draft.databaseResultFontSize} variant="secondary" onChange={(event) => updateDraft({ databaseResultFontSize: event.target.value })} /></label>
          <Select className="settings-field settings-select" fullWidth isDisabled={pending} selectedKey={draft.databaseRowDensity} variant="secondary" onSelectionChange={(key) => {
            if (key !== null) updateDraft({ databaseRowDensity: String(key) as SettingsDraft['databaseRowDensity'] });
          }}>
            <Label>{t('结果行密度')}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover className="settings-select-popover"><ListBox disabledKeys={pending ? ['comfortable', 'compact'] : undefined}><ListBox.Item id="comfortable">{t('舒适')}</ListBox.Item><ListBox.Item id="compact">{t('紧凑')}</ListBox.Item></ListBox></Select.Popover>
          </Select>
        </div>
        <div className="settings-toggle-row">
          <Switch isDisabled={pending} isSelected={draft.databaseWordWrap} size="sm" onChange={(databaseWordWrap) => updateDraft({ databaseWordWrap })}><Switch.Content><Label>{t('SQL 自动换行')}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>
          <Switch isDisabled={pending} isSelected={draft.databaseShowLineNumbers} size="sm" onChange={(databaseShowLineNumbers) => updateDraft({ databaseShowLineNumbers })}><Switch.Content><Label>{t('显示 SQL 行号')}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>
        </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="editor-settings-title">
        <div className="settings-section-heading"><div><h2 id="editor-settings-title">{t('文件与代码编辑器')}</h2><p>{t('SQL 与远程文件编辑器共享字体、字号和缩进设置。')}</p></div></div>
        <div className="settings-stack">
          <div className="settings-field is-wide"><label htmlFor="settings-editor-font">{t('编辑器字体')}</label><FontFamilyControl id="settings-editor-font" label={t('编辑器字体')} locale={locale} value={draft.editorFont} fonts={fontState.fonts} state={fontState} pending={pending} onChange={(editorFont) => updateDraft({ editorFont })} onRetry={() => void loadFonts(true)} t={t} /></div>
          <div className="settings-grid">
            <label className="settings-field" htmlFor="settings-editor-size"><span>{t('编辑器字号')}</span><Input id="settings-editor-size" aria-invalid={integerInRange(draft.editorFontSize, 8, 32) === null} fullWidth inputMode="numeric" disabled={pending} type="text" value={draft.editorFontSize} variant="secondary" onChange={(event) => updateDraft({ editorFontSize: event.target.value })} /></label>
            <Select className="settings-field settings-select" fullWidth isDisabled={pending} selectedKey={draft.editorTabSize} variant="secondary" onSelectionChange={(key) => {
              if (key !== null) updateDraft({ editorTabSize: Number(key) as SettingsDraft['editorTabSize'] });
            }}>
              <Label>{t('制表符宽度')}</Label>
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover className="settings-select-popover"><ListBox disabledKeys={pending ? [...editorTabSizes] : undefined}>{editorTabSizes.map((size) => <ListBox.Item key={size} id={size}>{t('{{count}} 个空格', { count: size })}</ListBox.Item>)}</ListBox></Select.Popover>
            </Select>
          </div>
          <div className="settings-toggle-row">
            <Switch isDisabled={pending} isSelected={draft.fileWordWrap} size="sm" onChange={(fileWordWrap) => updateDraft({ fileWordWrap })}><Switch.Content><Label>{t('文件自动换行')}</Label><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>
          </div>
        </div>
      </section>
      {siteSection && <div className="settings-site-slot">{siteSection}</div>}
      </fieldset>

    </form>
  </section>;
}
