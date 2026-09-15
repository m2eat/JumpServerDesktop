import { useSyncExternalStore } from 'react';
import type { ITheme } from '@xterm/xterm';
import type { ThemeId, ThemeSetting } from '@shared/index';
import type * as Monaco from 'monaco-editor';

export interface AppTheme {
  id: ThemeId;
  name: string;
  mode: 'dark' | 'light';
  terminal: ITheme;
  colors: Readonly<Record<string, string>>;
}

type TerminalPalette = Required<Pick<ITheme,
  'foreground' | 'background' | 'cursor' | 'cursorAccent' | 'selectionBackground' | 'selectionForeground'
  | 'selectionInactiveBackground' | 'scrollbarSliderBackground' | 'scrollbarSliderHoverBackground'
  | 'scrollbarSliderActiveBackground' | 'overviewRulerBorder' | 'black' | 'red' | 'green' | 'yellow'
  | 'blue' | 'magenta' | 'cyan' | 'white' | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow'
  | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
>>;

interface ThemeSeed {
  id: ThemeId;
  name: string;
  mode: 'dark' | 'light';
  canvas: string;
  surface: string;
  surface2: string;
  raised: string;
  raisedHover: string;
  hover: string;
  border: string;
  text: string;
  muted: string;
  dim: string;
  accent: string;
  accentHover: string;
  textOnAccent: string;
  danger: string;
  warning: string;
  success: string;
  info: string;
  terminal: TerminalPalette;
}

function alpha(color: string, opacity: string): string {
  return `${color}${opacity}`;
}

function createColors(seed: ThemeSeed): Readonly<Record<string, string>> {
  const dark = seed.mode === 'dark';
  return Object.freeze({
    '--canvas': seed.canvas,
    '--surface': seed.surface,
    '--surface-2': seed.surface2,
    '--raised': seed.raised,
    '--raised-hover': seed.raisedHover,
    '--hover': seed.hover,
    '--selected': alpha(seed.accent, dark ? '26' : '1C'),
    '--border': seed.border,
    '--border-soft': alpha(seed.muted, dark ? '2E' : '36'),
    '--text': seed.text,
    '--text-on-accent': seed.textOnAccent,
    '--muted': seed.muted,
    '--dim': seed.dim,
    '--accent': seed.accent,
    '--accent-hover': seed.accentHover,
    '--accent-soft': alpha(seed.accent, dark ? '20' : '18'),
    '--accent-border': alpha(seed.accent, dark ? '94' : 'A3'),
    '--danger': seed.danger,
    '--danger-text': dark ? '#FFD3DC' : '#A40E26',
    '--danger-soft': alpha(seed.danger, dark ? '20' : '17'),
    '--danger-border': alpha(seed.danger, dark ? '85' : '8C'),
    '--warning': seed.warning,
    '--warning-text': dark ? '#2D250F' : '#FFFFFF',
    '--warning-soft': alpha(seed.warning, dark ? '20' : '1C'),
    '--warning-border': alpha(seed.warning, dark ? '8A' : '92'),
    '--success': seed.success,
    '--success-text': dark ? '#C6F6D8' : '#126B38',
    '--success-soft': alpha(seed.success, dark ? '20' : '18'),
    '--success-border': alpha(seed.success, dark ? '85' : '90'),
    '--info': seed.info,
    '--info-text': dark ? '#C9E5FF' : '#0759A6',
    '--info-soft': alpha(seed.info, dark ? '20' : '18'),
    '--info-border': alpha(seed.info, dark ? '85' : '90'),
    '--input-background': dark ? seed.canvas : seed.surface,
    '--code-background': seed.terminal.background,
    '--table-header': seed.surface2,
    '--selection': seed.terminal.selectionBackground,
    '--overlay': dark ? '#080A10B3' : '#1F2328A3',
    '--overlay-subtle': dark ? '#080A1066' : '#1F23284D',
    '--shadow': dark ? '#080A1066' : '#1F232826',
    '--scrollbar': alpha(seed.muted, dark ? '86' : '75'),
    '--focus-ring': alpha(seed.accent, 'C9'),
    '--terminal-background': seed.terminal.background,
    '--terminal-foreground': seed.terminal.foreground,
    '--terminal-selection': seed.terminal.selectionBackground,
    '--terminal-selection-inactive': seed.terminal.selectionInactiveBackground,
    '--terminal-cursor': seed.terminal.cursor,
    '--terminal-cursor-accent': seed.terminal.cursorAccent,
    '--icon-terminal': seed.terminal.green,
    '--icon-terminal-soft': alpha(seed.terminal.green, dark ? '24' : '20'),
    '--icon-files': seed.terminal.blue,
    '--icon-files-soft': alpha(seed.terminal.blue, dark ? '24' : '20'),
    '--icon-database': seed.terminal.yellow,
    '--icon-database-soft': alpha(seed.terminal.yellow, dark ? '24' : '20'),
    '--icon-remote': seed.terminal.magenta,
    '--icon-remote-soft': alpha(seed.terminal.magenta, dark ? '24' : '20'),
    '--icon-command': seed.terminal.cyan,
    '--icon-command-soft': alpha(seed.terminal.cyan, dark ? '24' : '20')
  });
}

function createTheme(seed: ThemeSeed): AppTheme {
  return Object.freeze({
    id: seed.id,
    name: seed.name,
    mode: seed.mode,
    terminal: Object.freeze(seed.terminal),
    colors: createColors(seed)
  });
}

const jumpserver = createTheme({
  id: 'jumpserver', name: 'JumpServer', mode: 'dark',
  canvas: '#1E2031', surface: '#252838', surface2: '#2B2E40', raised: '#34384A', raisedHover: '#41465A', hover: '#3A3E51', border: '#45495E', text: '#F0F0F6', muted: '#A2A4B7', dim: '#777B92', accent: '#31C48D', accentHover: '#50D09C', textOnAccent: '#102C21', danger: '#F47D96', warning: '#EDC477', success: '#31C48D', info: '#75A7F6',
  terminal: {
    background: '#2D313F', foreground: '#E4E5EB', cursor: '#31C48D', cursorAccent: '#2D313F', selectionBackground: '#59607499', selectionForeground: '#F7F8FC', selectionInactiveBackground: '#454B5D99', scrollbarSliderBackground: '#A2A4B74D', scrollbarSliderHoverBackground: '#A2A4B780', scrollbarSliderActiveBackground: '#A2A4B7A6', overviewRulerBorder: '#45495E',
    black: '#3A3F51', red: '#F47D96', green: '#7EDCAF', yellow: '#EDC477', blue: '#91A8E8', magenta: '#C4A7EB', cyan: '#8CC9D1', white: '#E4E5EB', brightBlack: '#777B92', brightRed: '#FF9BAE', brightGreen: '#9AEBBF', brightYellow: '#F3D598', brightBlue: '#B0C1F2', brightMagenta: '#D2BDF1', brightCyan: '#A7DCE3', brightWhite: '#F7F8FC'
  }
});

const catppuccinMocha = createTheme({
  id: 'catppuccin-mocha', name: 'Catppuccin Mocha', mode: 'dark',
  canvas: '#11111B', surface: '#181825', surface2: '#1E1E2E', raised: '#313244', raisedHover: '#45475A', hover: '#292A3C', border: '#45475A', text: '#CDD6F4', muted: '#A6ADC8', dim: '#7F849C', accent: '#94E2D5', accentHover: '#B5F1E6', textOnAccent: '#10211E', danger: '#F38BA8', warning: '#F9E2AF', success: '#A6E3A1', info: '#89B4FA',
  terminal: {
    background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC', cursorAccent: '#1E1E2E', selectionBackground: '#585B70CC', selectionForeground: '#CDD6F4', selectionInactiveBackground: '#45475AAA', scrollbarSliderBackground: '#A6ADC84D', scrollbarSliderHoverBackground: '#A6ADC880', scrollbarSliderActiveBackground: '#A6ADC8A6', overviewRulerBorder: '#45475A',
    black: '#45475A', red: '#F38BA8', green: '#A6E3A1', yellow: '#F9E2AF', blue: '#89B4FA', magenta: '#F5C2E7', cyan: '#94E2D5', white: '#BAC2DE', brightBlack: '#585B70', brightRed: '#F38BA8', brightGreen: '#A6E3A1', brightYellow: '#F9E2AF', brightBlue: '#89B4FA', brightMagenta: '#F5C2E7', brightCyan: '#94E2D5', brightWhite: '#CDD6F4'
  }
});

const dracula = createTheme({
  id: 'dracula', name: 'Dracula', mode: 'dark',
  canvas: '#1E1F29', surface: '#282A36', surface2: '#30323F', raised: '#44475A', raisedHover: '#565A70', hover: '#383A4A', border: '#505365', text: '#F8F8F2', muted: '#B8B8C5', dim: '#8B8C9D', accent: '#BD93F9', accentHover: '#D2B6FF', textOnAccent: '#211B2F', danger: '#FF5555', warning: '#F1FA8C', success: '#50FA7B', info: '#8BE9FD',
  terminal: {
    background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2', cursorAccent: '#282A36', selectionBackground: '#44475ACC', selectionForeground: '#F8F8F2', selectionInactiveBackground: '#44475A99', scrollbarSliderBackground: '#B8B8C54D', scrollbarSliderHoverBackground: '#B8B8C580', scrollbarSliderActiveBackground: '#B8B8C5A6', overviewRulerBorder: '#505365',
    black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C', blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2', brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94', brightYellow: '#FFFFA5', brightBlue: '#D6ACFF', brightMagenta: '#FF92DF', brightCyan: '#A4FFFF', brightWhite: '#FFFFFF'
  }
});

const nord = createTheme({
  id: 'nord', name: 'Nord', mode: 'dark',
  canvas: '#242933', surface: '#2E3440', surface2: '#3B4252', raised: '#434C5E', raisedHover: '#4C566A', hover: '#394150', border: '#4C566A', text: '#ECEFF4', muted: '#D8DEE9', dim: '#8F9AAC', accent: '#88C0D0', accentHover: '#A3D5E2', textOnAccent: '#10242C', danger: '#BF616A', warning: '#EBCB8B', success: '#A3BE8C', info: '#81A1C1',
  terminal: {
    background: '#2E3440', foreground: '#D8DEE9', cursor: '#D8DEE9', cursorAccent: '#2E3440', selectionBackground: '#4C566ACC', selectionForeground: '#ECEFF4', selectionInactiveBackground: '#434C5E99', scrollbarSliderBackground: '#D8DEE94D', scrollbarSliderHoverBackground: '#D8DEE980', scrollbarSliderActiveBackground: '#D8DEE9A6', overviewRulerBorder: '#4C566A',
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B', blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0', brightBlack: '#4C566A', brightRed: '#D06F79', brightGreen: '#B1D196', brightYellow: '#F0D399', brightBlue: '#8FBCBB', brightMagenta: '#C49DBD', brightCyan: '#8FBCBB', brightWhite: '#ECEFF4'
  }
});

const tokyoNight = createTheme({
  id: 'tokyo-night', name: 'Tokyo Night', mode: 'dark',
  canvas: '#16161E', surface: '#1A1B26', surface2: '#24283B', raised: '#2F354D', raisedHover: '#3B4261', hover: '#292E42', border: '#3B4261', text: '#C0CAF5', muted: '#A9B1D6', dim: '#6F789E', accent: '#7AA2F7', accentHover: '#9AB8FF', textOnAccent: '#141B2D', danger: '#F7768E', warning: '#E0AF68', success: '#9ECE6A', info: '#7DCFFF',
  terminal: {
    background: '#1A1B26', foreground: '#C0CAF5', cursor: '#C0CAF5', cursorAccent: '#1A1B26', selectionBackground: '#33467CCC', selectionForeground: '#C0CAF5', selectionInactiveBackground: '#2F354D99', scrollbarSliderBackground: '#A9B1D64D', scrollbarSliderHoverBackground: '#A9B1D680', scrollbarSliderActiveBackground: '#A9B1D6A6', overviewRulerBorder: '#3B4261',
    black: '#32344A', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68', blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#C0CAF5', brightBlack: '#565F89', brightRed: '#FF899D', brightGreen: '#B9F27C', brightYellow: '#F9C879', brightBlue: '#8DB8FF', brightMagenta: '#C9AEFF', brightCyan: '#A4DAFF', brightWhite: '#D5DDFE'
  }
});

const solarizedDark = createTheme({
  id: 'solarized-dark', name: 'Solarized Dark', mode: 'dark',
  canvas: '#00212B', surface: '#002B36', surface2: '#073642', raised: '#164854', raisedHover: '#1F5A66', hover: '#0B3A46', border: '#2A5964', text: '#EEE8D5', muted: '#B8B09A', dim: '#839496', accent: '#2AA198', accentHover: '#4ABDB3', textOnAccent: '#002B36', danger: '#DC322F', warning: '#B58900', success: '#859900', info: '#268BD2',
  terminal: {
    background: '#002B36', foreground: '#839496', cursor: '#93A1A1', cursorAccent: '#002B36', selectionBackground: '#586E75B3', selectionForeground: '#EEE8D5', selectionInactiveBackground: '#395A62A6', scrollbarSliderBackground: '#93A1A14D', scrollbarSliderHoverBackground: '#93A1A180', scrollbarSliderActiveBackground: '#93A1A1A6', overviewRulerBorder: '#2A5964',
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5', brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3'
  }
});

const solarizedLight = createTheme({
  id: 'solarized-light', name: 'Solarized Light', mode: 'light',
  canvas: '#FDF6E3', surface: '#FFFDF5', surface2: '#EEE8D5', raised: '#E6DFC9', raisedHover: '#DCD3BA', hover: '#F4EEDC', border: '#CFC6AC', text: '#073642', muted: '#586E75', dim: '#657B83', accent: '#268BD2', accentHover: '#1674B5', textOnAccent: '#FFFFFF', danger: '#DC322F', warning: '#9A7400', success: '#5D7600', info: '#268BD2',
  terminal: {
    background: '#FDF6E3', foreground: '#657B83', cursor: '#586E75', cursorAccent: '#FDF6E3', selectionBackground: '#B8C9C3B3', selectionForeground: '#073642', selectionInactiveBackground: '#D6D1C3AA', scrollbarSliderBackground: '#586E754D', scrollbarSliderHoverBackground: '#586E7580', scrollbarSliderActiveBackground: '#586E75A6', overviewRulerBorder: '#CFC6AC',
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#586E75', brightBlack: '#839496', brightRed: '#CB4B16', brightGreen: '#657B83', brightYellow: '#839496', brightBlue: '#93A1A1', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#073642'
  }
});

const githubLight = createTheme({
  id: 'github-light', name: 'GitHub Light', mode: 'light',
  canvas: '#F6F8FA', surface: '#FFFFFF', surface2: '#F0F3F6', raised: '#EAEFF4', raisedHover: '#DDE4EB', hover: '#F3F4F6', border: '#D0D7DE', text: '#1F2328', muted: '#57606A', dim: '#6E7781', accent: '#0969DA', accentHover: '#0757B9', textOnAccent: '#FFFFFF', danger: '#CF222E', warning: '#9A6700', success: '#1A7F37', info: '#0969DA',
  terminal: {
    background: '#FFFFFF', foreground: '#24292F', cursor: '#0969DA', cursorAccent: '#FFFFFF', selectionBackground: '#B6D7FFB3', selectionForeground: '#1F2328', selectionInactiveBackground: '#D8E9FCAA', scrollbarSliderBackground: '#57606A4D', scrollbarSliderHoverBackground: '#57606A80', scrollbarSliderActiveBackground: '#57606AA6', overviewRulerBorder: '#D0D7DE',
    black: '#24292F', red: '#CF222E', green: '#1A7F37', yellow: '#9A6700', blue: '#0969DA', magenta: '#8250DF', cyan: '#1B7C83', white: '#57606A', brightBlack: '#6E7781', brightRed: '#A40E26', brightGreen: '#116329', brightYellow: '#7A4B00', brightBlue: '#0550AE', brightMagenta: '#6639BA', brightCyan: '#0E6168', brightWhite: '#1F2328'
  }
});

export const themes: readonly AppTheme[] = Object.freeze([
  jumpserver,
  catppuccinMocha,
  dracula,
  nord,
  tokyoNight,
  solarizedDark,
  solarizedLight,
  githubLight
]);

const themesById: Readonly<Record<ThemeId, AppTheme>> = Object.freeze({
  jumpserver,
  'catppuccin-mocha': catppuccinMocha,
  dracula,
  nord,
  'tokyo-night': tokyoNight,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  'github-light': githubLight
});

export function getTheme(id: ThemeId): AppTheme {
  return themesById[id];
}

function systemPrefersDark(): boolean {
  return typeof window === 'undefined' || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function subscribeToSystemColorScheme(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

export function useTheme(setting: ThemeSetting): AppTheme {
  const prefersDark = useSyncExternalStore(subscribeToSystemColorScheme, systemPrefersDark, () => true);
  return setting === 'system' ? (prefersDark ? jumpserver : githubLight) : getTheme(setting);
}

export function applyTheme(theme: AppTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.colors)) root.style.setProperty(name, value);
  root.dataset.theme = theme.id;
  root.dataset.colorMode = theme.mode;
  root.style.colorScheme = theme.mode;
}

function monacoColor(value: string): string {
  return value.slice(1, 7);
}

export function registerMonacoThemes(monaco: typeof Monaco): void {
  for (const theme of themes) {
    const colors = theme.colors;
    const terminal = theme.terminal;
    monaco.editor.defineTheme(theme.id, {
      base: theme.mode === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: monacoColor(colors['--dim']) },
        { token: 'string', foreground: monacoColor(terminal.green || colors['--success']) },
        { token: 'number', foreground: monacoColor(terminal.yellow || colors['--warning']) },
        { token: 'keyword', foreground: monacoColor(terminal.magenta || colors['--icon-remote']) },
        { token: 'type.identifier', foreground: monacoColor(terminal.cyan || colors['--info']) },
        { token: 'delimiter', foreground: monacoColor(colors['--muted']) }
      ],
      colors: {
        'editor.background': colors['--code-background'],
        'editor.foreground': colors['--terminal-foreground'],
        'editorCursor.foreground': colors['--accent'],
        'editor.selectionBackground': colors['--terminal-selection'],
        'editor.inactiveSelectionBackground': colors['--terminal-selection-inactive'],
        'editor.lineHighlightBackground': colors['--surface-2'],
        'editorLineNumber.foreground': colors['--dim'],
        'editorLineNumber.activeForeground': colors['--muted'],
        'editorGutter.background': colors['--code-background'],
        'editorIndentGuide.background1': colors['--border-soft'],
        'editorIndentGuide.activeBackground1': colors['--border'],
        'editorWidget.background': colors['--surface'],
        'editorWidget.border': colors['--border'],
        'editorSuggestWidget.background': colors['--surface'],
        'editorSuggestWidget.border': colors['--border'],
        'editorSuggestWidget.selectedBackground': colors['--selected'],
        'editorHoverWidget.background': colors['--surface'],
        'editorHoverWidget.border': colors['--border'],
        'editorGroupHeader.tabsBackground': colors['--surface-2'],
        'editorGroup.border': colors['--border'],
        'focusBorder': colors['--focus-ring'],
        'scrollbarSlider.background': terminal.scrollbarSliderBackground || colors['--scrollbar'],
        'scrollbarSlider.hoverBackground': terminal.scrollbarSliderHoverBackground || colors['--scrollbar'],
        'scrollbarSlider.activeBackground': terminal.scrollbarSliderActiveBackground || colors['--scrollbar']
      }
    });
  }
}
