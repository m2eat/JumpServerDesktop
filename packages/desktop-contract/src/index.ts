export type SessionKind = 'terminal' | 'files' | 'database';
export type Phase = 'connecting' | 'active' | 'closed' | 'lost' | 'failed';
export interface Site { id: string; name: string; url: string }
export interface Identity { siteId: string; userId: string; name: string; orgId: string }
export interface Asset { id: string; name: string; address: string; orgId: string; protocols: string[]; category?: string; type?: string; comment?: string }
export interface AssetGroup { id: string; key: string; parentKey: string; name: string; path: string }
export interface Account { id: string; name: string; username: string }
export interface NativeKokoConnectMethodIdentity { value: string; component: 'koko'; type: 'native' }
export interface ChenWebConnectMethodIdentity { value: 'web_gui'; component: 'chen'; type: 'web' }
export type ConnectMethodIdentity = NativeKokoConnectMethodIdentity | ChenWebConnectMethodIdentity;
export type ConnectMethod =
  | (NativeKokoConnectMethodIdentity & { label: string; protocol: 'ssh' | 'telnet'; endpointProtocol: 'ssh' })
  | (NativeKokoConnectMethodIdentity & { label: string; protocol: 'sftp'; endpointProtocol: 'sftp' })
  | (ChenWebConnectMethodIdentity & { label: string; protocol: 'mysql'; endpointProtocol: 'http' });
export interface ResourceContextFields {
  siteId: string;
  userId: string;
  orgId: string;
  assetId: string;
  assetName: string;
  address: string;
  accountId: string;
  accountName: string;
}
export type ResourceContext =
  | (ResourceContextFields & { protocol: 'ssh' | 'telnet' | 'sftp'; connectMethod: NativeKokoConnectMethodIdentity })
  | (ResourceContextFields & { protocol: 'mysql'; connectMethod: ChenWebConnectMethodIdentity });
export function resourceContextForMethod(fields: ResourceContextFields, method: ConnectMethod): ResourceContext {
  if (method.component === 'chen') {
    return {
      ...fields,
      protocol: method.protocol,
      connectMethod: { value: method.value, component: method.component, type: method.type }
    };
  }
  return {
    ...fields,
    protocol: method.protocol,
    connectMethod: { value: method.value, component: method.component, type: method.type }
  };
}
export function sessionKindForMethod(method: ConnectMethod): SessionKind {
  return method.protocol === 'sftp' ? 'files' : method.protocol === 'mysql' ? 'database' : 'terminal';
}

export function sessionKindForContext(context: ResourceContext): SessionKind {
  if (context.connectMethod.component === 'chen') return 'database';
  return context.protocol === 'sftp' ? 'files' : 'terminal';
}
export interface Capability { state: 'supported' | 'unsupported' | 'unknown'; reason: string }
export interface SessionInfo { id: string; generation: number; kind: SessionKind; phase: Phase; detached: boolean; context: ResourceContext; error?: string; capabilities: Record<string, Capability> }
export interface RemoteFile { name: string; path: string; type: 'file' | 'directory' | 'link'; size: string; modified: string; permissions: string; version?: string }
export interface FileListing { path: string; entries: RemoteFile[] }
export interface LocalEntry { name: string; relativePath: string; type: 'file' | 'directory' | 'link'; size: string; modified: string }
export interface LocalListing { grantId: string; directoryName: string; directoryPath: string; relativePath: string; entries: LocalEntry[] }
export interface TextFile { path: string; content: string; version: string; writable: boolean; reason?: string }
export interface TransferTask { id: string; sessionId: string; sourceSessionId?: string; name: string; direction: 'upload' | 'download'; phase: 'queued' | 'transferring' | 'completed' | 'canceled' | 'failed' | 'unknown'; cancelRequested?: boolean; transferred: number; total?: number; error?: string }
export interface DbNode { key: string; name: string; kind: 'database' | 'schema' | 'table' | 'view' | 'column' | 'other'; leaf: boolean; schema?: string; table?: string }
export interface DbColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  editable?: boolean;
  insertable?: boolean;
  nullable?: boolean;
  hasDefault?: boolean;
  generated?: boolean;
  autoIncrement?: boolean;
}
export type DbCell = string | boolean | null;
export type DbWriteValue = DbCell | { kind: 'default' };
export interface QueryResult {
  columns: DbColumn[];
  rows: DbCell[][];
  message: string;
  elapsedMs: number;
  truncated: boolean;
  editable: boolean;
  insertable?: boolean;
  readonlyReason?: string;
  snapshotId?: string;
}
export interface TableChanges {
  schema: string;
  table: string;
  snapshotId: string;
  updates: Array<{ row: Record<string, DbCell>; values: Record<string, DbWriteValue> }>;
  inserts: Array<Record<string, DbWriteValue>>;
  deletes: Array<Record<string, DbCell>>;
}
export interface Preview {
  id: string;
  sql: string[];
  expiresAt: number;
  schema: string;
  table: string;
  mode: 'sequential';
  counts: { updates: number; inserts: number; deletes: number };
  warnings: string[];
}
export interface ApplyResult {
  outcome: 'committed' | 'partial' | 'not-started' | 'unknown';
  applied: number;
  total: number;
  failedIndex?: number;
  failure?: 'conflict' | 'rejected';
  message: string;
}
export type ThemeId = 'jumpserver' | 'catppuccin-mocha' | 'dracula' | 'nord' | 'tokyo-night' | 'solarized-dark' | 'solarized-light' | 'github-light';
export type ThemeSetting = ThemeId | 'system';
export type LanguageSetting = 'system' | 'zh-CN' | 'en-US';
export interface Preferences {
  fontSize: number;
  terminalFont: string;
  scrollback: number;
  terminalCursorStyle: 'block' | 'underline' | 'bar';
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalCopyOnSelect: boolean;
  editorFont: string;
  editorFontSize: number;
  editorTabSize: 2 | 4 | 8;
  fileWordWrap: boolean;
  databasePageSize: 50 | 100 | 200 | 500;
  databaseWordWrap: boolean;
  databaseShowLineNumbers: boolean;
  databaseResultFontSize: number;
  databaseRowDensity: 'comfortable' | 'compact';
  theme: ThemeSetting;
  language: LanguageSetting;
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
  favorites: string[];
  recent: ResourceContext[];
}
export type PreferenceSettings = Omit<Preferences, 'favorites' | 'recent'>;
export interface AppUpdateState {
  currentVersion: string;
  latestVersion?: string;
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  mode: 'automatic' | 'manual' | 'disabled';
  reason?: 'development' | 'unsigned-macos' | 'linux-package' | 'unsupported-platform';
  progress?: number;
  error?: string;
  releaseUrl?: string;
}

export interface Snapshot { sites: Site[]; identity: Identity | null; preferences: Preferences; sessions: SessionInfo[]; tasks: TransferTask[]; authNotice?: string; rememberedSiteId?: string }
export interface Commands {
  'app.fonts': { args: { refresh?: boolean }; result: string[] };
  'app.updates': { args: Record<string, never>; result: AppUpdateState };
  'app.checkUpdate': { args: Record<string, never>; result: AppUpdateState };
  'app.downloadUpdate': { args: Record<string, never>; result: AppUpdateState };
  'app.installUpdate': { args: Record<string, never>; result: void };
  'app.openRelease': { args: Record<string, never>; result: void };

  'app.bootstrap': { args: Record<string, never>; result: Snapshot };
  'site.save': { args: { id?: string; name: string; url: string }; result: Site };
  'site.remove': { args: { siteId: string }; result: void };
  'auth.login': { args: { siteId: string }; result: Identity };
  'auth.cancel': { args: Record<string, never>; result: void };
  'auth.logout': { args: Record<string, never>; result: void };
  'assets.list': { args: { search?: string; offset?: number; limit?: number; favoritesOnly?: boolean; category?: string; nodeId?: string }; result: { assets: Asset[]; total: number } };
  'assets.groups': { args: { parentKey?: string; search?: string }; result: { groups: AssetGroup[] } };
  'assets.options': { args: { assetId: string; orgId: string }; result: { accounts: Account[]; methods: ConnectMethod[] } };
  'session.open': { args: { kind: SessionKind; context: ResourceContext }; result: SessionInfo };
  'session.close': { args: { sessionId: string }; result: void };
  'session.detach': { args: { sessionId: string }; result: void };
  'session.attach': { args: { sessionId: string }; result: SessionInfo };
  'session.dirty': { args: { sessionId: string; dirty: boolean }; result: void };
  'terminal.input': { args: { sessionId: string; data: string }; result: void };
  'terminal.resize': { args: { sessionId: string; cols: number; rows: number }; result: void };
  'terminal.ack': { args: { sessionId: string; bytes: number }; result: void };
  'files.list': { args: { sessionId: string; path: string }; result: FileListing };
  'files.mkdir': { args: { sessionId: string; path: string }; result: void };
  'files.rename': { args: { sessionId: string; path: string; newName: string }; result: void };
  'files.remove': { args: { sessionId: string; path: string; directory: boolean }; result: void };
  'local.pick': { args: Record<string, never>; result: LocalListing | null };
  'local.home': { args: Record<string, never>; result: LocalListing };
  'local.navigate': { args: { grantId: string; relativePath: string; path: string }; result: LocalListing | null };
  'local.list': { args: { grantId: string; relativePath: string }; result: LocalListing };
  'files.uploadLocal': { args: { sessionId: string; grantId: string; relativePaths: string[]; path: string }; result: TransferTask[] };
  'files.downloadLocal': { args: { sessionId: string; grantId: string; relativePath: string; path: string; name: string }; result: TransferTask };
  'files.copy': { args: { sessionId: string; targetSessionId: string; path: string; targetPath: string; name: string }; result: TransferTask };
  'files.upload': { args: { sessionId: string; path: string }; result: TransferTask[] };
  'files.download': { args: { sessionId: string; path: string; name: string }; result: TransferTask | null };
  'files.readText': { args: { sessionId: string; path: string }; result: TextFile };
  'files.saveText': { args: { sessionId: string; path: string; content: string; version: string }; result: TextFile };
  'tasks.cancel': { args: { taskId: string }; result: void };
  'db.tree': { args: { sessionId: string; key?: string }; result: DbNode[] };
  'db.query': { args: { sessionId: string; sql: string }; result: QueryResult };
  'db.cancel': { args: { sessionId: string }; result: void };
  'db.table': { args: { sessionId: string; schema: string; table: string; page: number; limit: number; search?: { text: string; column?: string } }; result: QueryResult };
  'db.preview': { args: { sessionId: string; changes: TableChanges }; result: Preview };
  'db.apply': { args: { sessionId: string; previewId: string }; result: ApplyResult };
  'preferences.save': { args: { preferences: Preferences }; result: Preferences };
}
export type CommandName = keyof Commands;
export type AppEvent =
  | { type: 'identity'; identity: Identity | null }
  | { type: 'session'; session: SessionInfo }
  | { type: 'terminal'; sessionId: string; generation: number; data: Uint8Array }
  | { type: 'task'; task: TransferTask }
  | { type: 'notice'; message: string }
  | { type: 'update'; update: AppUpdateState };
export interface DesktopBridge {
  invoke<K extends CommandName>(command: K, args: Commands[K]['args']): Promise<Commands[K]['result']>;
  subscribe(listener: (event: AppEvent) => void): () => void;
  platform: string;
}
declare global { interface Window { desktop: DesktopBridge } }
