import { createInstance } from 'i18next';
import type { LanguageSetting } from './index';

const messages = {
  '退出工作台': 'Quit workbench',
  '退出将丢弃未保存编辑、关闭所有连接并停止传输。': 'Quitting discards unsaved edits, closes all connections, and stops transfers.',
  '已发送的命令或数据库写入不能因断开而保证撤回。取消会保留当前工作区。': 'Disconnecting cannot guarantee cancellation of commands or database writes already sent. Cancel to keep the current workspace.',
  '继续工作': 'Keep working',
  '丢弃编辑并退出': 'Discard edits and quit',
  '退出清理未完成，窗口已保留，请检查连接状态后重试。': 'Cleanup did not finish. The window remains open; check connection status and try again.',
  '确认 Chen 组件入口': 'Confirm Chen endpoint',
  '允许连接 Core 指定的 Chen 入口？': 'Allow connection to the Chen endpoint specified by Core?',
  '站点：{{site}}\n组件：{{endpoint}}\n\n仅向此 HTTPS 入口发送本次连接令牌；Chen 使用独立 Cookie 容器，不接收 Core access token 或 refresh token。\n授权仅在本次登录内有效。请确认这是受信的 JumpServer 组件。': 'Site: {{site}}\nComponent: {{endpoint}}\n\nOnly the connection token is sent to this HTTPS endpoint. Chen uses an isolated cookie container and receives neither the Core access token nor refresh token.\nApproval lasts only for this login. Confirm this is a trusted JumpServer component.',
  '取消': 'Cancel',
  '允许连接': 'Allow connection',
  'SSH 网关主机密钥已更改': 'SSH gateway host key changed',
  '确认 SSH 网关主机密钥': 'Verify SSH gateway host key',
  'SSH 网关身份与之前记录不一致。': 'The SSH gateway identity does not match the previously recorded key.',
  '首次连接此 SSH 网关，请确认其主机密钥。': 'This is your first connection to this SSH gateway. Verify its host key.',
  '站点：{{site}}\n网关：{{host}}:{{port}}\n{{keyDetails}}': 'Site: {{site}}\nGateway: {{host}}:{{port}}\n{{keyDetails}}',
  '已记录：{{remembered}}\n新密钥：{{fingerprint}}\n\n密钥变更可能表示网关重装，也可能表示中间人攻击。仅在已通过独立渠道确认后，才信任新密钥。': 'Recorded: {{remembered}}\nNew key: {{fingerprint}}\n\nA changed key may indicate a reinstalled gateway or a man-in-the-middle attack. Trust the new key only after verifying it through an independent channel.',
  'SHA256 指纹：{{fingerprint}}\n\n请通过站点管理员或受信渠道核对此指纹后再继续。': 'SHA256 fingerprint: {{fingerprint}}\n\nVerify this fingerprint with the site administrator or another trusted channel before continuing.',
  '拒绝并关闭': 'Reject and close',
  '信任新密钥': 'Trust new key',
  '信任此密钥': 'Trust this key',
  '接收 JumpServer 授权回调': 'Receive JumpServer authorization callbacks',
  'jms:// 当前由 {{owner}} 处理。是否切换到本工作台？': 'jms:// is currently handled by {{owner}}. Switch to this workbench?',
  '是否允许本工作台接收 jms:// 授权回调？': 'Allow this workbench to receive jms:// authorization callbacks?',
  '这是 JumpServer 官方 OAuth 回调协议。切换会影响其他 JumpServer 客户端的登录回调；取消不会更改系统设置。': 'This is the official JumpServer OAuth callback protocol. Switching affects login callbacks for other JumpServer clients. Cancel leaves system settings unchanged.',
  '允许并继续': 'Allow and continue',
  '授权浏览一个本地目录': 'Allow browsing a local folder',
  '选择要上传的文件或目录': 'Choose files or folders to upload',
  '上传': 'Upload',
  '保存下载文件': 'Save download',
  '保存': 'Save',
  '安装更新并重启': 'Install update and restart',
  '已下载的更新将在关闭工作台后安装并重新打开应用。': 'The downloaded update will install after the workbench closes and the app will reopen.',
  '安装更新会丢弃未保存编辑、关闭所有连接并停止传输。': 'Installing the update discards unsaved edits, closes all connections, and stops transfers.',
  '稍后安装': 'Install later',
  '安装并重启': 'Install and restart',
  '更新安装未能启动，应用将重新打开。请重试或从发布页下载安装包。': 'The update could not start installing. The app will reopen. Retry or download the installer from the release page.'
} satisfies Record<string, string>;

// Main-process instance: never share renderer state or translate external data.
const nativeI18n = createInstance();
void nativeI18n.init({
  lng: 'zh-CN', supportedLngs: ['zh-CN', 'en-US'], load: 'currentOnly',
  fallbackLng: false, keySeparator: false, nsSeparator: false, initAsync: false,
  resources: { 'zh-CN': { translation: {} }, 'en-US': { translation: messages } },
  interpolation: { escapeValue: false }
});

export async function setNativeLanguage(setting: LanguageSetting, systemLocale: string): Promise<void> {
  const language = setting === 'system' ? (/^zh\b/i.test(systemLocale) ? 'zh-CN' : 'en-US') : setting;
  await nativeI18n.changeLanguage(language);
}

export function nativeText(key: keyof typeof messages, values?: Record<string, string | number>): string {
  return nativeI18n.t(key, { ...values, defaultValue: key });
}
