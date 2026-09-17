import { shortcutCommands } from '@shared/shortcuts';
import { t } from '../i18n';

export type CommandId = Extract<(typeof shortcutCommands)[number], { readonly scope: 'global' }>['id'];

export interface CommandDefinition {
  readonly id: CommandId;
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly keywords: readonly string[];
}

export const commandRegistry = [
  {
    id: 'picker.open',
    label: '打开全局搜索',
    description: '在工作区、资产和命令之间快速跳转',
    group: '导航',
    keywords: ['搜索', '跳转', '命令', 'picker', 'quick switcher']
  },
  {
    id: 'tabs.new',
    label: '新建标签页',
    description: '打开新建连接页，不会建立连接',
    group: '标签',
    keywords: ['新建', '连接', 'tab', 'new']
  },
  {
    id: 'tabs.close',
    label: '关闭当前标签页',
    description: '请求关闭当前焦点连接标签，并保留确认步骤',
    group: '标签',
    keywords: ['关闭', '连接', 'tab', 'close']
  },
  {
    id: 'tabs.next',
    label: '下一个标签页',
    description: '在已打开连接和新建标签页之间向前切换',
    group: '标签',
    keywords: ['下一个', '连接', 'tab', 'next']
  },
  {
    id: 'tabs.previous',
    label: '上一个标签页',
    description: '在已打开连接和新建标签页之间向后切换',
    group: '标签',
    keywords: ['上一个', '连接', 'tab', 'previous']
  },
  {
    id: 'tabs.1',
    label: '切换到第 1 个连接标签',
    description: '选择第 1 个已打开的连接标签',
    group: '标签',
    keywords: ['第 1 个', '连接', 'tab', 'first']
  },
  {
    id: 'tabs.2',
    label: '切换到第 2 个连接标签',
    description: '选择第 2 个已打开的连接标签',
    group: '标签',
    keywords: ['第 2 个', '连接', 'tab', 'second']
  },
  {
    id: 'tabs.3',
    label: '切换到第 3 个连接标签',
    description: '选择第 3 个已打开的连接标签',
    group: '标签',
    keywords: ['第 3 个', '连接', 'tab', 'third']
  },
  {
    id: 'tabs.4',
    label: '切换到第 4 个连接标签',
    description: '选择第 4 个已打开的连接标签',
    group: '标签',
    keywords: ['第 4 个', '连接', 'tab', 'fourth']
  },
  {
    id: 'tabs.5',
    label: '切换到第 5 个连接标签',
    description: '选择第 5 个已打开的连接标签',
    group: '标签',
    keywords: ['第 5 个', '连接', 'tab', 'fifth']
  },
  {
    id: 'tabs.6',
    label: '切换到第 6 个连接标签',
    description: '选择第 6 个已打开的连接标签',
    group: '标签',
    keywords: ['第 6 个', '连接', 'tab', 'sixth']
  },
  {
    id: 'tabs.7',
    label: '切换到第 7 个连接标签',
    description: '选择第 7 个已打开的连接标签',
    group: '标签',
    keywords: ['第 7 个', '连接', 'tab', 'seventh']
  },
  {
    id: 'tabs.8',
    label: '切换到第 8 个连接标签',
    description: '选择第 8 个已打开的连接标签',
    group: '标签',
    keywords: ['第 8 个', '连接', 'tab', 'eighth']
  },
  {
    id: 'tabs.9',
    label: '切换到最后一个连接标签',
    description: '选择最后一个已打开的连接标签',
    group: '标签',
    keywords: ['最后', '连接', 'tab', 'last']
  },
  {
    id: 'settings.open',
    label: '打开工作台设置',
    description: '修改应用设置与显示偏好',
    group: '视图',
    keywords: ['设置', '外观', '字体', 'settings']
  },
  {
    id: 'shortcuts.open',
    label: '打开快捷键设置',
    description: '管理当前平台的应用快捷键',
    group: '视图',
    keywords: ['快捷键', '按键', 'keybindings', 'shortcuts']
  },
  {
    id: 'sidebar.toggle',
    label: '切换资产侧栏',
    description: '显示或隐藏资产导航侧栏',
    group: '视图',
    keywords: ['侧栏', '资产', '导航', 'sidebar']
  },
  {
    id: 'assets.focus-search',
    label: '搜索授权资产',
    description: '将焦点移到当前身份可访问的资产搜索框',
    group: '导航',
    keywords: ['资产', '搜索', 'resource', 'search']
  },
  {
    id: 'workspace.prepare-split',
    label: '选择标签用于分屏',
    description: '从另一个已打开标签中选择副窗格，不会建立新连接',
    group: '工作区',
    keywords: ['分屏', '窗口', 'pane', 'split']
  },
  {
    id: 'workspace.focus-primary',
    label: '聚焦主窗格',
    description: '结束当前分屏显示，不会关闭连接',
    group: '工作区',
    keywords: ['聚焦', '窗口', 'focus']
  },
  {
    id: 'tasks.toggle',
    label: '切换任务抽屉',
    description: '查看当前身份的真实传输任务与取消状态',
    group: '视图',
    keywords: ['任务', '上传', '下载', 'transfer']
  },
  {
    id: 'site.add',
    label: '添加站点',
    description: '配置经过批准的 HTTPS JumpServer 入口',
    group: '站点与身份',
    keywords: ['站点', '环境', 'https', '新增']
  },
  {
    id: 'auth.login',
    label: '登录当前站点',
    description: '使用该站点配置发起真实认证流程',
    group: '站点与身份',
    keywords: ['登录', '认证', 'login']
  },
  {
    id: 'auth.logout',
    label: '注销当前身份',
    description: '关闭用户会话并从界面清理身份相关状态',
    group: '站点与身份',
    keywords: ['注销', '退出', 'logout']
  },
  {
    id: 'app.quit',
    label: '退出工作台',
    description: '请求退出；未保存内容或远程操作仍会先确认',
    group: '应用',
    keywords: ['退出', '关闭', 'quit', 'exit']
  }
] as const satisfies readonly CommandDefinition[];

export function translateCommandDefinition(command: CommandDefinition, translate: typeof t = t): CommandDefinition {
  return {
    ...command,
    label: translate(command.label),
    description: translate(command.description),
    group: translate(command.group)
  };
}

export function searchCommands(query: string): CommandDefinition[] {
  const normalized = query.trim().toLocaleLowerCase();
  const commands = commandRegistry.map((command) => ({
    source: command,
    translated: translateCommandDefinition(command)
  }));
  if (!normalized) {
    return commands.map(({ translated }) => translated);
  }

  return commands.filter(({ source, translated }) => {
    const searchable = [
      source.label,
      source.description,
      source.group,
      ...source.keywords,
      translated.label,
      translated.description,
      translated.group
    ].join(' ').toLocaleLowerCase();
    return searchable.includes(normalized);
  }).map(({ translated }) => translated);
}
