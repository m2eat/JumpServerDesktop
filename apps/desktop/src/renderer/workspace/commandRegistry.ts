import { t } from '../i18n';

export type CommandId =
  | 'assets.focus-search'
  | 'site.add'
  | 'auth.login'
  | 'auth.logout'
  | 'workspace.prepare-split'
  | 'workspace.focus-primary'
  | 'tasks.toggle'
  | 'settings.open';

export interface CommandDefinition {
  readonly id: CommandId;
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly keywords: readonly string[];
}

export const commandRegistry: readonly CommandDefinition[] = [
  {
    id: 'assets.focus-search',
    label: '搜索授权资产',
    description: '将焦点移到当前身份可访问的资产搜索框',
    group: '工作区',
    keywords: ['资产', '搜索', 'resource']
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
    id: 'settings.open',
    label: '打开工作台设置',
    description: '修改终端字体、字号和回滚缓冲区',
    group: '视图',
    keywords: ['设置', '字体', 'scrollback']
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
  }
];

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
