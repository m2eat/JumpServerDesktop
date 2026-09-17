import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { z } from 'zod';
import { AlertDialog, Button, Input, Modal, Popover, Radio, RadioGroup } from '@heroui/react';
import {
  ArrowRight, Bell, Check, ChevronRight, CircleAlert, Database, FolderOpen,
  History, KeyRound, LayoutGrid, LayoutPanelLeft, List, LoaderCircle, LogIn,
  LogOut, PanelRight, Plus, RefreshCw, Search, Server, Settings, ShieldCheck,
  SlidersHorizontal, Star, TerminalSquare, X, Download, type LucideIcon
} from 'lucide-react';
import type {
  Account,
  AppEvent,
  AppUpdateState,
  Asset,
  AssetGroup,
  Capability,
  ConnectMethod,
  Identity,
  Preferences,
  PreferenceSettings,
  ResourceContext,
  SessionInfo,
  SessionKind,
  Site,
  Snapshot,
  TransferTask
} from '@shared/index';
import TerminalWorkspace from './workspace/TerminalWorkspace';
import SftpWorkspace from './workspace/SftpWorkspace';
import type { SftpSide } from './workspace/SftpWorkspace';
import DatabasePane from './components/DatabasePane';
import { hasMoreAssetPages } from './workspace/assetPagination';
import { assetsResultSchema, readSavedAssetGroup, useAssetBrowser } from './workspace/useAssetBrowser';
import { AssetGroupTree } from './workspace/AssetGroupTree';
import { useAssetGroups } from './workspace/useAssetGroups';
import { searchCommands } from './workspace/commandRegistry';
import type { CommandDefinition, CommandId } from './workspace/commandRegistry';
import NewTabPage from './workspace/NewTabPage';
import QuickSwitcher from './workspace/QuickSwitcher';
import type { QuickSwitcherEntry } from './workspace/QuickSwitcher';
import { resourceContextForMethod, sessionKindForContext, sessionKindForMethod } from '@shared/index';
import { defaultPreferences, preferenceSettingsSchema } from '@shared/preferences';
import { appUpdateStateSchema } from '@shared/updates';
import SettingsPage from './components/SettingsPage';
import { applyTheme, useTheme } from './themes';
import { t, useI18n, setLanguage, translateDiagnostic, formatNumber } from './i18n';
import './App.css';

const siteSchema: z.ZodType<Site> = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string()
});

const identitySchema: z.ZodType<Identity> = z.object({
  siteId: z.string(),
  userId: z.string(),
  name: z.string(),
  orgId: z.string()
});


const accountSchema: z.ZodType<Account> = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string()
});

const nativeKokoConnectMethodIdentitySchema = z.object({
  value: z.string(),
  component: z.literal('koko'),
  type: z.literal('native')
}).strict();

const chenWebConnectMethodIdentitySchema = z.object({
  value: z.literal('web_gui'),
  component: z.literal('chen'),
  type: z.literal('web')
}).strict();


const connectMethodSchema: z.ZodType<ConnectMethod> = z.union([
  nativeKokoConnectMethodIdentitySchema.extend({
    label: z.string(),
    protocol: z.enum(['ssh', 'telnet']),
    endpointProtocol: z.literal('ssh')
  }),
  nativeKokoConnectMethodIdentitySchema.extend({
    label: z.string(),
    protocol: z.literal('sftp'),
    endpointProtocol: z.literal('sftp')
  }),
  chenWebConnectMethodIdentitySchema.extend({
    label: z.string(),
    protocol: z.literal('mysql'),
    endpointProtocol: z.literal('http')
  })
]);

const resourceContextFields = {
  siteId: z.string(),
  userId: z.string(),
  orgId: z.string(),
  assetId: z.string(),
  assetName: z.string(),
  address: z.string(),
  accountId: z.string(),
  accountName: z.string()
};

const resourceContextSchema: z.ZodType<ResourceContext> = z.union([
  z.object({ ...resourceContextFields, protocol: z.enum(['ssh', 'telnet', 'sftp']), connectMethod: nativeKokoConnectMethodIdentitySchema }).strict(),
  z.object({ ...resourceContextFields, protocol: z.literal('mysql'), connectMethod: chenWebConnectMethodIdentitySchema }).strict()
]);

const capabilitySchema: z.ZodType<Capability> = z.object({
  state: z.enum(['supported', 'unsupported', 'unknown']),
  reason: z.string()
});

const sessionSchema: z.ZodType<SessionInfo> = z.object({
  id: z.string(),
  generation: z.number().int(),
  kind: z.enum(['terminal', 'files', 'database']),
  phase: z.enum(['connecting', 'active', 'closed', 'lost', 'failed']),
  detached: z.boolean(),
  context: resourceContextSchema,
  error: z.string().optional(),
  capabilities: z.record(z.string(), capabilitySchema)
});

const transferTaskSchema: z.ZodType<TransferTask> = z.object({
  id: z.string(),
  sessionId: z.string(),
  sourceSessionId: z.string().optional(),
  name: z.string(),
  direction: z.enum(['upload', 'download']),
  phase: z.enum(['queued', 'transferring', 'completed', 'canceled', 'failed', 'unknown']),
  transferred: z.number(),
  total: z.number().optional(),
  cancelRequested: z.boolean().optional(),
  error: z.string().optional()
});

const preferencesSchema: z.ZodType<Preferences> = preferenceSettingsSchema.extend({
  favorites: z.array(z.string()),
  recent: z.array(resourceContextSchema)
});

const snapshotSchema: z.ZodType<Snapshot> = z.object({
  sites: z.array(siteSchema),
  identity: identitySchema.nullable(),
  preferences: preferencesSchema,
  sessions: z.array(sessionSchema),
  tasks: z.array(transferTaskSchema),
  authNotice: z.string().optional(),
  rememberedSiteId: z.string().uuid().optional()
});

const assetOptionsSchema = z.object({ accounts: z.array(accountSchema), methods: z.array(connectMethodSchema) });

const appEventSchema: z.ZodType<AppEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('identity'), identity: identitySchema.nullable() }),
  z.object({ type: z.literal('session'), session: sessionSchema }),
  z.object({ type: z.literal('terminal'), sessionId: z.string(), generation: z.number().int(), data: z.instanceof(Uint8Array) }),
  z.object({ type: z.literal('task'), task: transferTaskSchema }),
  z.object({ type: z.literal('update'), update: appUpdateStateSchema }),
  z.object({ type: z.literal('notice'), message: z.string() })
]);

interface WorkspaceTab {
  id: string;
  sessionId: string;
  title: string;
}

interface Toast {
  id: number;
  message: string;
  tone: 'error' | 'info' | 'success';
}

interface AssetOptionsState {
  stage: 'idle' | 'loading' | 'ready' | 'error';
  accounts: Account[];
  methods: ConnectMethod[];
  error: string | null;
}


type BootstrapState = 'loading' | 'ready' | 'error';
type SidebarView = 'assets' | 'recent' | 'settings';
type Screen = 'library' | 'sftp' | 'new' | 'session';
type PaneFocus = 'primary' | 'secondary';
type PickerEntry =
  | { key: string; kind: 'command'; command: CommandDefinition }
  | { key: string; kind: 'tab'; tab: WorkspaceTab; session: SessionInfo }
  | { key: string; kind: 'asset'; asset: Asset }
  | { key: string; kind: 'library'; view: 'assets' | 'files'; title: string };
const sessionKinds: ReadonlyArray<{ kind: SessionKind; label: string; Icon: LucideIcon }> = [
  { kind: 'terminal', label: '打开终端', Icon: TerminalSquare },
  { kind: 'files', label: '打开文件', Icon: FolderOpen },
  { kind: 'database', label: '打开数据库', Icon: Database }
];

function sameConnectMethod(left: ResourceContext['connectMethod'], right: ResourceContext['connectMethod']): boolean {
  return left.value === right.value && left.component === right.component && left.type === right.type;
}


const assetCategoryLabels: Readonly<Record<string, string>> = {
  host: '主机',
  database: '数据库',
  device: '设备',
  cloud: '云服务',
  web: 'Web',
  ds: '目录服务',
  custom: '自定义'
};

const databaseAssetTypes: Readonly<Record<string, true>> = {
  mysql: true,
  mariadb: true,
  postgresql: true,
  redis: true,
  sqlserver: true,
  oracle: true
};



function getScopeKey(identity: Identity | null): string {
  if (identity === null) {
    return 'signed-out';
  }
  return JSON.stringify([identity.siteId, identity.userId, identity.orgId]);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return t('服务端返回的数据不符合工作台契约，请检查目标部署兼容性。');
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return translateDiagnostic(error.message);
  }
  return t('请求未完成，未收到可用的错误说明。');
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${formatNumber(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function tabTitle(session: SessionInfo): string {
  const kindLabel = session.kind === 'terminal' ? t('终端') : session.kind === 'files' ? t('文件') : t('数据库');
  return `${session.context.assetName} · ${session.context.accountName} · ${kindLabel}`;
}

function phaseLabel(phase: SessionInfo['phase']): string {
  const labels: Record<SessionInfo['phase'], string> = {
    connecting: t('连接中'),
    active: t('已连接'),
    closed: t('已关闭'),
    lost: t('连接丢失'),
    failed: t('连接失败')
  };
  return labels[phase];
}

function taskPhaseLabel(phase: TransferTask['phase']): string {
  const labels: Record<TransferTask['phase'], string> = {
    queued: t('排队中'),
    transferring: t('传输中'),
    completed: t('已完成'),
    canceled: t('已取消'),
    failed: t('失败'),
    unknown: t('结果未知')
  };
  return labels[phase];
}

export default function App() {
  const { locale } = useI18n();
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>('loading');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const preferenceSaveSequence = useRef(0);
  const theme = useTheme(preferences.theme);
  useLayoutEffect(() => applyTheme(theme), [theme]);
  useEffect(() => { void setLanguage(preferences.language); }, [preferences.language]);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [assetOptions, setAssetOptions] = useState<AssetOptionsState>({ stage: 'idle', accounts: [], methods: [], error: null });
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [fileSlots, setFileSlots] = useState<Record<string, string>>({});
  const [leftLocal, setLeftLocal] = useState(true);
  const [pendingFileSession, setPendingFileSession] = useState<SessionInfo | null>(null);
  const [replacingFile, setReplacingFile] = useState(false);
  const [secondaryTabId, setSecondaryTabId] = useState<string | null>(null);
  const [paneFocus, setPaneFocus] = useState<PaneFocus>('primary');
  const [choosingSplitTarget, setChoosingSplitTarget] = useState(false);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [closingTabId, setClosingTabId] = useState<string | null>(null);
  const [dirtySessionIds, setDirtySessionIds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  const [openingSessionKinds, setOpeningSessionKinds] = useState<SessionKind[]>([]);
  const [cancelingTaskIds, setCancelingTaskIds] = useState<string[]>([]);
  const [attachingSessionIds, setAttachingSessionIds] = useState<string[]>([]);
  const [screen, setScreen] = useState<Screen>('library');
  const [assetLayout, setAssetLayout] = useState<'grid' | 'list'>('grid');
  const [siteMenuOpen, setSiteMenuOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [groupScopeError, setGroupScopeError] = useState<string | null>(null);
  const [pendingIdentityAction, setPendingIdentityAction] = useState<{ siteId: string | null } | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('assets');
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [siteForm, setSiteForm] = useState({ id: '', name: '', url: '', error: '' });
  const [removeSiteId, setRemoveSiteId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerAssets, setPickerAssets] = useState<Asset[]>([]);
  const [pickerAssetState, setPickerAssetState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState | null>(null);
  const [appUpdateLoadError, setAppUpdateLoadError] = useState(false);

  const identityRef = useRef<Identity | null>(null);
  const fileSlotsRef = useRef<Record<string, string>>({});
  const openingFileSlotsRef = useRef(new Set<string>());
  const closingTerminalIdsRef = useRef(new Set<string>());
  const scopeRef = useRef('signed-out');
  const assetOptionsRequestRef = useRef(0);
  const pickerAssetRequestRef = useRef(0);
  const attachingSessionIdsRef = useRef(new Set<string>());
  const openingSessionKindsRef = useRef(new Set<SessionKind>());
  const cancelingTaskIdsRef = useRef(new Set<string>());
  const closingTabIdRef = useRef<string | null>(null);
  const dirtySessionStateRef = useRef(new Map<string, boolean>());
  const dirtyHandlerRef = useRef(new Map<string, (dirty: boolean) => void>());
  const dirtyGenerationRef = useRef(0);
  const toastSequenceRef = useRef(0);
  const toastTimerRef = useRef(new Set<number>());
  const pickerInputRef = useRef<HTMLInputElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const assetSearchRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const identityBusyRef = useRef(false);
  const groupNavigationRef = useRef(0);
  const pendingGroupRestoreRef = useRef<Pick<AssetGroup, 'id' | 'key'> | null>(null);
  const appUpdateRevisionRef = useRef(0);
  const applyAppUpdate = useCallback((update: AppUpdateState) => {
    appUpdateRevisionRef.current++;
    setAppUpdate(update);
    setAppUpdateLoadError(false);
  }, []);
  const closeAssetDetails = useCallback(() => {
    groupNavigationRef.current++;
    pendingGroupRestoreRef.current = null;
    setGroupScopeError(null);
    assetOptionsRequestRef.current++;
    setSelectedAsset(null);
    setSelectedAccountId(null);
    setAssetOptions({ stage: 'idle', accounts: [], methods: [], error: null });
  }, []);
  const assetBrowser = useAssetBrowser(identity, closeAssetDetails);
  const groups = useAssetGroups(identity);
  const {
    query: { search: assetSearch, category: assetCategory, favoritesOnly, groupPath },
    pagination: assetPagination, stage: assetLoadState, pageStage: assetPageLoadState,
    setSearch: changeAssetSearch, setCategory: changeAssetCategory, setFavorites: changeFavoritesOnly,
    clear: clearAssetBrowser, resetAll: resetAssetBrowser, selectGroup: selectBrowserGroup,
    refresh: refreshAssetBrowser, refreshFavorites, loadMore: requestNextAssetPage
  } = assetBrowser;
  const selectedGroup = groupPath.at(-1) ?? null;
  const assetError = assetBrowser.error ? getErrorMessage(assetBrowser.error) : null;
  const assetPageError = assetBrowser.pageError ? getErrorMessage(assetBrowser.pageError) : null;

  const selectedSite = useMemo(() => sites.find((site) => site.id === selectedSiteId) ?? null, [selectedSiteId, sites]);
  const selectedAccount = useMemo(
    () => assetOptions.accounts.find((account) => account.id === selectedAccountId) ?? null,
    [assetOptions.accounts, selectedAccountId]
  );
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const assetCategories = useMemo(() => {
    const others = new Set<string>(assetCategory && assetCategory !== 'host' && assetCategory !== 'database' ? [assetCategory] : []);
    for (const asset of assetPagination.assets) {
      if (asset.category && asset.category !== 'host' && asset.category !== 'database') {
        others.add(asset.category);
      }
    }
    return [
      { value: undefined, label: t('全部'), Icon: LayoutGrid },
      { value: 'host', label: t(assetCategoryLabels.host), Icon: TerminalSquare },
      { value: 'database', label: t(assetCategoryLabels.database), Icon: Database },
      ...Array.from(others).sort((left, right) => left.localeCompare(right)).map((category) => ({
        value: category,
        label: assetCategoryLabels[category] ? t(assetCategoryLabels[category]) : category,
        Icon: Server
      }))
    ];
  }, [assetCategory, assetPagination.assets, locale]);
  const secondaryTab = useMemo(() => tabs.find((tab) => tab.id === secondaryTabId) ?? null, [secondaryTabId, tabs]);
  const secondarySession = secondaryTab === null ? null : sessionById.get(secondaryTab.sessionId) ?? null;
  const taskSummary = useMemo(
    () => tasks.filter((task) => task.phase === 'queued' || task.phase === 'transferring'),
    [tasks]
  );
  const globalUpdate = useMemo(() => appUpdate?.phase === 'available' || appUpdate?.phase === 'downloaded' ? appUpdate : null, [appUpdate]);
  const scopedRecent = useMemo(() => {
    if (identity === null) {
      return [];
    }
    return preferences.recent.filter((recent) => (
      recent.siteId === identity.siteId
      && recent.userId === identity.userId
      && recent.orgId === identity.orgId
    )).slice(0, 16);
  }, [identity, preferences.recent]);

  const addToast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastSequenceRef.current;
    setToasts((current) => [...current, { id, message, tone }].slice(-4));
    const timer = window.setTimeout(() => {
      toastTimerRef.current.delete(timer);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5200);

    toastTimerRef.current.add(timer);
  }, []);
  const openUpdateSettings = useCallback(() => {
    setSidebarView('settings');
    setScreen('library');
  }, []);
  const groupScope = getScopeKey(identity);
  const { restoreGroup, refreshPath, resolvePath, refresh: refreshGroups } = groups;
  useEffect(() => {
    if (!identity) return;
    const saved = readSavedAssetGroup(identity);
    if (!saved) return;
    const navigation = groupNavigationRef.current;
    let cancelled = false;
    void restoreGroup(saved).then(result => {
      if (cancelled || navigation !== groupNavigationRef.current) return;
      if (result.status === 'found') selectBrowserGroup(result.path);
      else if (result.status === 'unavailable') {
        resetAssetBrowser();
        addToast(t('原分组已不存在或不再可访问，已返回全部资产。'));
      } else {
        pendingGroupRestoreRef.current = saved;
        setGroupScopeError(result.error);
      }
    });
    return () => { cancelled = true; };
  }, [groupScope, restoreGroup, selectBrowserGroup, resetAssetBrowser, addToast]);

  const refreshAssetLibrary = useCallback(async () => {
    const navigation = groupNavigationRef.current;
    const reference = selectedGroup ?? pendingGroupRestoreRef.current;
    if (!reference) {
      setGroupScopeError(null);
      refreshAssetBrowser();
      await refreshGroups();
      return;
    }
    await refreshGroups();
    if (navigation !== groupNavigationRef.current) return;
    const result = await resolvePath(reference);
    if (navigation !== groupNavigationRef.current) return;
    if (result.status === 'found') selectBrowserGroup(result.path);
    else if (result.status === 'unavailable') {
      resetAssetBrowser();
      addToast(t('原分组已不存在或不再可访问，已返回全部资产。'));
    } else setGroupScopeError(result.error);
  }, [selectedGroup, resolvePath, refreshGroups, refreshAssetBrowser, selectBrowserGroup, resetAssetBrowser, addToast]);

  useEffect(() => {
    if (!selectedGroup || assetLoadState !== 'ready' || assetPagination.total !== 0 || assetSearch || assetCategory) return;
    let cancelled = false;
    const navigation = groupNavigationRef.current;
    void refreshPath(selectedGroup).then(result => {
      if (cancelled || navigation !== groupNavigationRef.current) return;
      if (result.status === 'unavailable') {
        resetAssetBrowser();
        addToast(t('原分组已不存在或不再可访问，已返回全部资产。'));
      } else if (result.status === 'error') setGroupScopeError(result.error);
    });
    return () => { cancelled = true; };
  }, [selectedGroup, assetLoadState, assetPagination.total, assetSearch, assetCategory, refreshPath, resetAssetBrowser, addToast]);

  const storeFileSlots = useCallback((next: Record<string, string>) => {
    fileSlotsRef.current = next;
    setFileSlots(next);
  }, []);

  const clearScopedMemory = useCallback(() => {
    clearAssetBrowser();
    pickerAssetRequestRef.current += 1;
    assetOptionsRequestRef.current += 1;
    openingSessionKindsRef.current.clear();
    attachingSessionIdsRef.current.clear();
    cancelingTaskIdsRef.current.clear();
    closingTabIdRef.current = null;
    dirtyGenerationRef.current += 1;
    dirtySessionStateRef.current.clear();
    dirtyHandlerRef.current.clear();
    setOpeningSessionKinds([]);
    setPickerAssets([]);
    setPickerAssetState('idle');
    setSelectedAsset(null);
    setAssetOptions({ stage: 'idle', accounts: [], methods: [], error: null });
    setSelectedAccountId(null);
    setSessions([]);
    storeFileSlots({});
    openingFileSlotsRef.current.clear();
    closingTerminalIdsRef.current.clear();
    setLeftLocal(true);
    setPendingFileSession(null);
    setReplacingFile(false);
    setTabs([]);
    setActiveTabId(null);
    setSecondaryTabId(null);
    setPaneFocus('primary');
    setScreen('library');
    setSidebarView('assets');
    setChoosingSplitTarget(false);
    setPendingCloseTabId(null);
    setClosingTabId(null);
    setDirtySessionIds([]);
    setTasks([]);
    setCancelingTaskIds([]);
    setAttachingSessionIds([]);
    setPreferences((current) => ({ ...current, favorites: [], recent: [] }));
  }, [clearAssetBrowser, storeFileSlots]);


  const applySnapshot = useCallback((snapshot: Snapshot) => {
    const nextScope = getScopeKey(snapshot.identity);
    if (scopeRef.current !== nextScope) {
      clearScopedMemory();
    }
    scopeRef.current = nextScope;
    identityRef.current = snapshot.identity;
    const restorableSessions = snapshot.sessions.filter((session) => session.kind !== 'files' && !session.detached && session.phase !== 'closed');
    setSites(snapshot.sites);
    setIdentity(snapshot.identity);
    setAuthNotice(snapshot.authNotice ?? null);
    setPreferences(snapshot.preferences);
    setSessions(snapshot.sessions);
    const files = snapshot.sessions.filter((session) => session.kind === 'files' && !session.detached && session.phase !== 'closed');
    const nextSlots = Object.fromEntries(Object.entries(fileSlotsRef.current).filter(([, id]) => files.some((session) => session.id === id)));
    if (!nextSlots.right && files.length > 0) nextSlots.right = files.find((session) => !Object.values(nextSlots).includes(session.id))?.id ?? '';
    if (!nextSlots.right) delete nextSlots.right;
    storeFileSlots(nextSlots);
    for (const session of files) {
      if (!Object.values(nextSlots).includes(session.id)) void window.desktop.invoke('session.detach', { sessionId: session.id }).catch((error) => addToast(getErrorMessage(error), 'error'));
    }
    setTabs((current) => restorableSessions.map((session) => {
      const existing = current.find((tab) => tab.sessionId === session.id);
      return existing ?? { id: `${session.id}:${session.generation}`, sessionId: session.id, title: tabTitle(session) };
    }));
    setTasks(snapshot.tasks);
    setSelectedSiteId((current) => {
      if (snapshot.identity !== null) {
        return snapshot.identity.siteId;
      }
      if (current !== null && snapshot.sites.some((site) => site.id === current)) {
        return current;
      }
      return snapshot.rememberedSiteId ?? snapshot.sites[0]?.id ?? null;
    });
    setBootstrapState('ready');
    setBootstrapError(null);
  }, [addToast, clearScopedMemory, storeFileSlots]);

  const loadSnapshot = useCallback(async () => {
    setBootstrapState('loading');
    setBootstrapError(null);
    try {
      const response: unknown = await window.desktop.invoke('app.bootstrap', {});
      applySnapshot(snapshotSchema.parse(response));
    } catch (error: unknown) {
      setBootstrapState('error');
      setBootstrapError(getErrorMessage(error));
    }
  }, [applySnapshot]);

  const applyIdentity = useCallback((nextIdentity: Identity | null) => {
    const oldScope = scopeRef.current;
    const nextScope = getScopeKey(nextIdentity);
    scopeRef.current = nextScope;
    identityRef.current = nextIdentity;
    if (oldScope !== nextScope) {
      clearScopedMemory();
    }
    setIdentity(nextIdentity);
    if (nextIdentity !== null) {
      setSelectedSiteId(nextIdentity.siteId);
    }
    void loadSnapshot();
  }, [clearScopedMemory, loadSnapshot]);

  const selectAsset = useCallback(async (asset: Asset) => {
    groupNavigationRef.current++;
    const currentIdentity = identityRef.current;
    if (currentIdentity === null) {
      addToast(t('请先登录站点，再读取可授权的账号和连接方式。'), 'error');
      return;
    }
    const requestScope = getScopeKey(currentIdentity);
    const requestId = ++assetOptionsRequestRef.current;
    setSelectedAsset(asset);
    setScreen('library');
    setSelectedAccountId(null);
    setAssetOptions({ stage: 'loading', accounts: [], methods: [], error: null });
    try {
      const response: unknown = await window.desktop.invoke('assets.options', { assetId: asset.id, orgId: asset.orgId });
      const parsed = assetOptionsSchema.parse(response);
      if (requestId !== assetOptionsRequestRef.current || scopeRef.current !== requestScope || identityRef.current?.orgId !== currentIdentity.orgId) {
        return;
      }
      setAssetOptions({ stage: 'ready', accounts: parsed.accounts, methods: parsed.methods, error: null });
    } catch (error: unknown) {
      if (requestId !== assetOptionsRequestRef.current || scopeRef.current !== requestScope) {
        return;
      }
      const message = getErrorMessage(error);
      setAssetOptions({ stage: 'error', accounts: [], methods: [], error: message });
      addToast(t('无法读取“{{name}}”的连接选项：{{message}}', { name: asset.name, message: message }), 'error');
    }
  }, [addToast]);

  const requestPickerAssets = useCallback(async (nextIdentity: Identity, query: string) => {
    const requestId = ++pickerAssetRequestRef.current;
    setPickerAssetState('loading');
    try {
      const response: unknown = await window.desktop.invoke('assets.list', { search: query.trim() || undefined, offset: 0, limit: 30 });
      const parsed = assetsResultSchema.parse(response);
      if (requestId !== pickerAssetRequestRef.current || getScopeKey(nextIdentity) !== scopeRef.current) {
        return;
      }
      setPickerAssets(parsed.assets);
      setPickerAssetState('ready');
    } catch (error: unknown) {
      if (requestId !== pickerAssetRequestRef.current || getScopeKey(nextIdentity) !== scopeRef.current) {
        return;
      }
      setPickerAssets([]);
      setPickerAssetState('error');
      addToast(t('Picker 无法读取资产：{{error}}', { error: getErrorMessage(error) }), 'error');
    }
  }, [addToast]);

  const persistPreferences = useCallback(async (nextPreferences: Preferences): Promise<Preferences | null> => {
    const requestScope = scopeRef.current;
    const request = ++preferenceSaveSequence.current;
    try {
      const response: unknown = await window.desktop.invoke('preferences.save', { preferences: nextPreferences });
      const parsed = preferencesSchema.parse(response);
      if (scopeRef.current !== requestScope || request !== preferenceSaveSequence.current) {
        return null;
      }
      preferencesRef.current = parsed;
      setPreferences(parsed);
      return parsed;
    } catch (error: unknown) {
      addToast(t('无法保存偏好设置：{{error}}', { error: getErrorMessage(error) }), 'error');
      return null;
    }
  }, [addToast]);

  const setSessionDirty = useCallback((sessionId: string, dirty: boolean) => {
    const currentDirty = dirtySessionStateRef.current.get(sessionId);
    if (currentDirty === dirty || (currentDirty === undefined && !dirty)) {
      return;
    }
    dirtySessionStateRef.current.set(sessionId, dirty);
    setDirtySessionIds((current) => {
      const contains = current.includes(sessionId);
      if (dirty === contains) {
        return current;
      }
      return dirty ? [...current, sessionId] : current.filter((id) => id !== sessionId);
    });
    const requestScope = scopeRef.current;
    void window.desktop.invoke('session.dirty', { sessionId, dirty }).then((response: unknown) => {
      z.void().parse(response);
    }).catch((error: unknown) => {
      if (scopeRef.current === requestScope) {
        addToast(t('无法更新未保存内容状态：{{error}}', { error: getErrorMessage(error) }), 'error');
      }
    });
  }, [addToast]);

  const getDirtyHandler = useCallback((sessionId: string) => {
    const existing = dirtyHandlerRef.current.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const generation = dirtyGenerationRef.current;
    const handler = (dirty: boolean) => {
      if (generation === dirtyGenerationRef.current && dirtyHandlerRef.current.get(sessionId) === handler) {
        setSessionDirty(sessionId, dirty);
      }
    };
    dirtyHandlerRef.current.set(sessionId, handler);
    return handler;
  }, [setSessionDirty]);

  const releaseFileSlot = useCallback(async (slot: string) => {
    const sessionId = fileSlotsRef.current[slot];
    if (!sessionId) return;
    const requestScope = scopeRef.current;
    await window.desktop.invoke('session.detach', { sessionId });
    if (requestScope !== scopeRef.current) return;
    setSessionDirty(sessionId, false);
    dirtyHandlerRef.current.delete(sessionId);
    if (fileSlotsRef.current[slot] === sessionId) {
      const next = { ...fileSlotsRef.current };
      delete next[slot];
      storeFileSlots(next);
    }
  }, [setSessionDirty, storeFileSlots]);

  const adoptFileSlot = useCallback(async (slot: string, session: SessionInfo) => {
    const requestScope = scopeRef.current;
    const currentIdentity = identityRef.current;
    if (!currentIdentity || session.context.siteId !== currentIdentity.siteId || session.context.userId !== currentIdentity.userId) throw new Error(t('文件连接不属于当前身份'));
    if (fileSlotsRef.current[slot] !== session.id) await releaseFileSlot(slot);
    if (scopeRef.current !== requestScope) throw new Error(t('身份已变化，文件连接已取消'));
    if (slot.startsWith('quick:') && closingTerminalIdsRef.current.has(slot.slice(6))) throw new Error(t('终端已关闭，快捷文件连接已取消'));
    storeFileSlots({ ...fileSlotsRef.current, [slot]: session.id });
    setSessions((current) => current.some((item) => item.id === session.id) ? current.map((item) => item.id === session.id ? session : item) : [...current, session]);
    if (slot === 'left') setLeftLocal(false);
  }, [releaseFileSlot, storeFileSlots]);

  const openFileSlot = useCallback(async (slot: string, context: ResourceContext) => {
    if (openingFileSlotsRef.current.has(slot)) throw new Error(t('此文件窗格正在连接'));
    const requestScope = scopeRef.current;
    openingFileSlotsRef.current.add(slot);
    let opened: SessionInfo | undefined;
    try {
      opened = sessionSchema.parse(await window.desktop.invoke('session.open', { kind: 'files', context }));
      if (slot.startsWith('quick:') && closingTerminalIdsRef.current.has(slot.slice(6))) throw new Error(t('终端已关闭，快捷文件连接已取消'));
      if (scopeRef.current !== requestScope) throw new Error(t('身份已变化，文件连接已取消'));
      await adoptFileSlot(slot, opened);
      const recent = preferences.recent.filter((item) => !(item.assetId === context.assetId && item.accountId === context.accountId && item.protocol === context.protocol && sameConnectMethod(item.connectMethod, context.connectMethod)));
      void persistPreferences({ ...preferences, recent: [context, ...recent].slice(0, 16) });
    } catch (error) {
      if (opened) await window.desktop.invoke('session.close', { sessionId: opened.id }).catch(() => {});
      throw error;
    } finally {
      if (scopeRef.current === requestScope) openingFileSlotsRef.current.delete(slot);
    }
  }, [adoptFileSlot, persistPreferences, preferences]);

  const registerTransferTasks = useCallback((created: TransferTask[]) => {
    const parsed = z.array(transferTaskSchema).parse(created);
    setTasks((current) => {
      const next = new Map(current.map((task) => [task.id, task]));
      for (const task of parsed) next.set(task.id, task);
      return [...next.values()];
    });
  }, []);

  const addSessionTab = useCallback((session: SessionInfo) => {
    if (session.kind === 'files') {
      const current = fileSlotsRef.current.right;
      if (current && dirtySessionStateRef.current.get(current)) {
        setPendingFileSession(session);
      } else {
        void adoptFileSlot('right', session).then(() => setScreen('sftp')).catch((error) => {
          addToast(getErrorMessage(error), 'error');
          void window.desktop.invoke('session.close', { sessionId: session.id }).catch(() => {});
        });
      }
      return;
    }
    const tabId = `${session.id}:${session.generation}`;
    setSessions((current) => {
      const existing = current.findIndex((item) => item.id === session.id);
      if (existing === -1) {
        return [...current, session];
      }
      return current.map((item) => item.id === session.id ? session : item);
    });
    setTabs((current) => current.some((tab) => tab.sessionId === session.id) ? current : [...current, { id: tabId, sessionId: session.id, title: tabTitle(session) }]);
    setActiveTabId(tabId);
    setScreen('session');
    setPaneFocus('primary');
  }, [addToast, adoptFileSlot]);

  const attachSession = useCallback(async (sessionId: string) => {
    if (attachingSessionIdsRef.current.has(sessionId)) {
      return;
    }
    attachingSessionIdsRef.current.add(sessionId);
    setAttachingSessionIds(Array.from(attachingSessionIdsRef.current));
    const requestScope = scopeRef.current;
    try {
      const response: unknown = await window.desktop.invoke('session.attach', { sessionId });
      const session = sessionSchema.parse(response);
      if (session.detached) {
        throw new Error(t('服务端未重新附着该后台文件工作区。'));
      }
      if (scopeRef.current !== requestScope) {
        return;
      }
      addSessionTab(session);
      addToast(t('已重新打开“{{value}}”。', { value: tabTitle(session) }), 'success');
    } catch (error: unknown) {
      if (scopeRef.current === requestScope) {
        addToast(t('无法重新打开后台文件工作区：{{error}}', { error: getErrorMessage(error) }), 'error');
      }
    } finally {
      attachingSessionIdsRef.current.delete(sessionId);
      setAttachingSessionIds(Array.from(attachingSessionIdsRef.current));
    }
  }, [addSessionTab, addToast]);

  const openRecent = useCallback(async (context: ResourceContext) => {
    const currentIdentity = identityRef.current;
    if (currentIdentity === null || context.siteId !== currentIdentity.siteId || context.userId !== currentIdentity.userId || context.orgId !== currentIdentity.orgId) return;
    const kind = sessionKindForContext(context);
    if (openingSessionKindsRef.current.has(kind)) return;
    openingSessionKindsRef.current.add(kind);
    setOpeningSessionKinds(Array.from(openingSessionKindsRef.current));
    const requestScope = scopeRef.current;
    try {
      const result = sessionSchema.parse(await window.desktop.invoke('session.open', { kind, context }));
      if (requestScope === scopeRef.current) addSessionTab(result);
    } catch (error) {
      if (requestScope === scopeRef.current) addToast(t('无法重新连接：{{error}}', { error: getErrorMessage(error) }), 'error');
    } finally {
      openingSessionKindsRef.current.delete(kind);
      setOpeningSessionKinds(Array.from(openingSessionKindsRef.current));
    }
  }, [addSessionTab, addToast]);

  const transitionIdentity = useCallback(async (nextSiteId: string | null) => {
    if (identityBusyRef.current) return;
    identityBusyRef.current = true;
    setIdentityBusy(true);
    setSiteMenuOpen(false);
    try {
      const wasAuthenticated = identityRef.current !== null;
      if (wasAuthenticated) z.void().parse(await window.desktop.invoke('auth.logout', {}));
      identityRef.current = null;
      scopeRef.current = 'signed-out';
      clearScopedMemory();
      setIdentity(null);
      if (nextSiteId !== null) setSelectedSiteId(nextSiteId);
      if (wasAuthenticated && nextSiteId !== null) {
        applyIdentity(identitySchema.parse(await window.desktop.invoke('auth.login', { siteId: nextSiteId })));
      }
    } catch (error) {
      addToast(t('站点切换未完成：{{error}}', { error: getErrorMessage(error) }), 'error');
    } finally {
      identityBusyRef.current = false;
      setIdentityBusy(false);
      setPendingIdentityAction(null);
    }
  }, [addToast, applyIdentity, clearScopedMemory]);

  const requestIdentityTransition = useCallback((nextSiteId: string | null) => {
    if (identityBusyRef.current) return;
    if (nextSiteId === selectedSiteId) { setSiteMenuOpen(false); return; }
    if (tabs.length > 0 || Object.keys(fileSlotsRef.current).length > 0 || taskSummary.length > 0 || dirtySessionIds.length > 0) {
      setSiteMenuOpen(false);
      setPendingIdentityAction({ siteId: nextSiteId });
    } else {
      void transitionIdentity(nextSiteId);
    }
  }, [dirtySessionIds.length, selectedSiteId, tabs.length, taskSummary.length, transitionIdentity]);

  const openSession = useCallback(async (kind: SessionKind, method: ConnectMethod) => {
    const currentIdentity = identityRef.current;
    if (openingSessionKindsRef.current.has(kind)) {
      return;
    }
    if (currentIdentity === null || selectedAsset === null || selectedAccount === null) {
      addToast(t('请选择当前身份、授权资产和明确账号后再建立连接。'), 'error');
      return;
    }
    const expected = sessionKinds.find((item) => item.kind === kind);
    if (expected === undefined || sessionKindForMethod(method) !== kind) {
      addToast(t('服务端返回的连接方式不适用于所选工作区，未建立连接。'), 'error');
      return;
    }
    openingSessionKindsRef.current.add(kind);
    setOpeningSessionKinds(Array.from(openingSessionKindsRef.current));

    const context = resourceContextForMethod({
      siteId: currentIdentity.siteId,
      userId: currentIdentity.userId,
      orgId: selectedAsset.orgId,
      assetId: selectedAsset.id,
      assetName: selectedAsset.name,
      address: selectedAsset.address,
      accountId: selectedAccount.id,
      accountName: selectedAccount.name
    }, method);
    const requestScope = getScopeKey(currentIdentity);
    try {
      const response: unknown = await window.desktop.invoke('session.open', { kind, context });
      const session = sessionSchema.parse(response);
      if (scopeRef.current !== requestScope) {
        return;
      }
      addSessionTab(session);
      const scopedRecent = preferences.recent.filter((recent) => (
        recent.siteId === currentIdentity.siteId
        && recent.userId === currentIdentity.userId
        && recent.orgId === currentIdentity.orgId
        && !(recent.assetId === context.assetId && recent.accountId === context.accountId && recent.protocol === context.protocol && sameConnectMethod(recent.connectMethod, context.connectMethod))
      ));
      void persistPreferences({ ...preferences, recent: [context, ...scopedRecent].slice(0, 16) });
    } catch (error: unknown) {
      addToast(t('无法建立{{value}}：{{error}}', { value: t(expected?.label ?? '工作区'), error: getErrorMessage(error) }), 'error');
    } finally {
      openingSessionKindsRef.current.delete(kind);
      setOpeningSessionKinds(Array.from(openingSessionKindsRef.current));
    }
  }, [addSessionTab, addToast, persistPreferences, preferences, selectedAccount, selectedAsset]);

  const executeCommand = useCallback((id: CommandId) => {
    switch (id) {
      case 'assets.focus-search':
        setSidebarView('assets');
        setScreen('library');
        window.requestAnimationFrame(() => assetSearchRef.current?.focus());
        return;
      case 'site.add':
        setSiteMenuOpen(false);
        setSiteForm({ id: '', name: '', url: '', error: '' });
        setSiteDialogOpen(true);
        return;
      case 'auth.login':
        if (selectedSite === null) { addToast(t('请先添加一个 JumpServer 站点。'), 'error'); return; }
        if (identityBusyRef.current) return;
        identityBusyRef.current = true;
        setIdentityBusy(true);
        setAuthNotice(null);
        void (async () => {
          try {
            applyIdentity(identitySchema.parse(await window.desktop.invoke('auth.login', { siteId: selectedSite.id })));
          } catch (error) {
            addToast(t('登录未完成：{{error}}', { error: getErrorMessage(error) }), 'error');
            setAuthNotice(t('登录未完成：{{error}}', { error: getErrorMessage(error) }));
          } finally {
            identityBusyRef.current = false;
            setIdentityBusy(false);
          }
        })();
        return;
      case 'auth.logout':
        if (identityRef.current !== null) requestIdentityTransition(null);
        return;
      case 'workspace.prepare-split':
        if (tabs.length < 2) { addToast(t('先打开另一个连接，再选择要分屏的标签。')); return; }
        setScreen('session');
        setChoosingSplitTarget(true);
        return;
      case 'workspace.focus-primary':
        setSecondaryTabId(null);
        setPaneFocus('primary');
        setChoosingSplitTarget(false);
        return;
      case 'tasks.toggle':
        setTaskDrawerOpen((open) => !open);
        return;
      case 'settings.open':
        setSidebarView('settings');
        setScreen('library');
        return;
    }
  }, [addToast, applyIdentity, requestIdentityTransition, selectedSite, tabs.length]);

  const closeTab = useCallback(async (tabId: string) => {
    if (closingTabIdRef.current !== null) {
      return;
    }
    const tab = tabs.find((item) => item.id === tabId);
    if (tab === undefined) {
      return;
    }
    const session = sessionById.get(tab.sessionId);
    if (session === undefined) {
      setTabs((current) => current.filter((item) => item.id !== tabId));
      setPendingCloseTabId(null);
      return;
    }
    closingTerminalIdsRef.current.add(session.id);
    closingTabIdRef.current = tabId;
    setClosingTabId(tabId);
    try {
      await releaseFileSlot(`quick:${session.id}`);
      z.void().parse(await window.desktop.invoke('session.close', { sessionId: session.id }));
      setSessionDirty(session.id, false);
      dirtyHandlerRef.current.delete(session.id);
      dirtySessionStateRef.current.delete(session.id);
      setDirtySessionIds((current) => current.filter((id) => id !== session.id));
      setTabs((current) => current.filter((item) => item.id !== tabId));
      setPendingCloseTabId(null);
    } catch (error: unknown) {
      closingTerminalIdsRef.current.delete(session.id);
      addToast(t('无法关闭“{{title}}”：{{error}}', { title: tab.title, error: getErrorMessage(error) }), 'error');
    } finally {
      closingTabIdRef.current = null;
      setClosingTabId(null);
    }
  }, [addToast, releaseFileSlot, sessionById, setSessionDirty, tabs]);

  const cancelTask = useCallback(async (task: TransferTask) => {
    if (task.cancelRequested || cancelingTaskIdsRef.current.has(task.id)) {
      return;
    }
    cancelingTaskIdsRef.current.add(task.id);
    setCancelingTaskIds(Array.from(cancelingTaskIdsRef.current));
    try {
      const response: unknown = await window.desktop.invoke('tasks.cancel', { taskId: task.id });
      z.void().parse(response);
      setTasks((current) => current.map((currentTask) => currentTask.id === task.id ? { ...currentTask, cancelRequested: true } : currentTask));
      addToast(t('已提交“{{name}}”的取消请求，等待服务端返回最终状态。', { name: task.name }), 'info');
    } catch (error: unknown) {
      addToast(t('无法取消“{{name}}”：{{error}}', { name: task.name, error: getErrorMessage(error) }), 'error');
    } finally {
      cancelingTaskIdsRef.current.delete(task.id);
      setCancelingTaskIds(Array.from(cancelingTaskIdsRef.current));
    }
  }, [addToast]);

  const pickerEntries = useMemo<PickerEntry[]>(() => {
    const normalized = pickerQuery.trim();
    if (normalized.startsWith('>')) {
      return searchCommands(normalized.slice(1)).map((command) => ({ key: `command:${command.id}`, kind: 'command', command }));
    }
    const needle = normalized.toLocaleLowerCase();
    const openTabs = tabs.flatMap((tab) => {
      const session = sessionById.get(tab.sessionId);
      if (session === undefined) {
        return [];
      }
      const searchable = `${tab.title} ${session.context.address} ${session.context.protocol}`.toLocaleLowerCase();
      return needle.length === 0 || searchable.includes(needle) ? [{ key: `tab:${tab.id}`, kind: 'tab' as const, tab, session }] : [];
    });
    const assetEntries = pickerAssets.map((asset) => ({ key: `asset:${asset.id}`, kind: 'asset' as const, asset }));
    const libraries: PickerEntry[] = [
      { key: 'library:assets', kind: 'library', view: 'assets', title: t('资产库') },
      { key: 'library:files', kind: 'library', view: 'files', title: 'SFTP' }
    ];
    return [...libraries.filter((entry) => entry.kind === 'library' && (!needle || entry.title.toLowerCase().includes(needle))), ...openTabs, ...assetEntries];
  }, [locale, pickerAssets, pickerQuery, sessionById, tabs]);

  const activatePickerEntry = useCallback((entry: PickerEntry) => {
    if (entry.kind === 'command') {
      executeCommand(entry.command.id);
    }
    if (entry.kind === 'tab') {
      if (entry.tab.id === secondaryTabId && activeTabId !== null) {
        setSecondaryTabId(activeTabId);
      }
      setActiveTabId(entry.tab.id);
      setScreen('session');
      setPaneFocus('primary');
      setChoosingSplitTarget(false);
    }
    if (entry.kind === 'asset') {
      resetAssetBrowser();
      setSidebarView('assets');
      setScreen('library');
      void selectAsset(entry.asset);
    }
    if (entry.kind === 'library') {
      if (entry.view === 'files') setScreen('sftp');
      else { setSidebarView('assets'); setScreen('library'); }
    }
    setPickerOpen(false);
    setPickerQuery('');
    window.requestAnimationFrame(() => pickerTriggerRef.current?.focus());
  }, [activeTabId, executeCommand, secondaryTabId, selectAsset, resetAssetBrowser]);


  useEffect(() => {
    identityRef.current = identity;
    scopeRef.current = getScopeKey(identity);
  }, [identity]);

  useEffect(() => {
    void loadSnapshot();
    return () => {
      toastTimerRef.current.forEach((timer) => window.clearTimeout(timer));
      toastTimerRef.current.clear();
    };
  }, [loadSnapshot]);

  useEffect(() => {
    let active = true;
    const requestRevision = appUpdateRevisionRef.current;
    void window.desktop.invoke('app.updates', {}).then((response) => {
      if (!active || requestRevision !== appUpdateRevisionRef.current) return;
      const parsed = appUpdateStateSchema.safeParse(response);
      if (!parsed.success) {
        setAppUpdateLoadError(true);
        return;
      }
      setAppUpdate(parsed.data);
      setAppUpdateLoadError(false);
    }).catch(() => {
      if (active && requestRevision === appUpdateRevisionRef.current) setAppUpdateLoadError(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const unsubscribe = window.desktop.subscribe((event) => {
      const parsed = appEventSchema.safeParse(event);
      if (!parsed.success) {
        addToast(t('收到无法识别的桌面事件，已忽略该事件。'), 'error');
        return;
      }
      if (parsed.data.type === 'update') {
        applyAppUpdate(parsed.data.update);
        return;
      }
      if (parsed.data.type === 'identity') {
        applyIdentity(parsed.data.identity);
        return;
      }
      if (parsed.data.type === 'session') {
        const nextSession = parsed.data.session;
        setSessions((current) => {
          const index = current.findIndex((session) => session.id === nextSession.id);
          if (index === -1) {
            return [...current, nextSession];
          }
          return current.map((session) => session.id === nextSession.id ? nextSession : session);
        });
        return;
      }
      if (parsed.data.type === 'task') {
        const nextTask = parsed.data.task;
        setTasks((current) => {
          const index = current.findIndex((task) => task.id === nextTask.id);
          if (index === -1) {
            return [...current, nextTask];
          }
          return current.map((task) => task.id === nextTask.id ? nextTask : task);
        });
        return;
      }
      if (parsed.data.type === 'notice') {
        addToast(parsed.data.message, 'info');
      }
    });
    return unsubscribe;
  }, [addToast, applyAppUpdate, applyIdentity]);


  useEffect(() => {
    if (!pickerOpen || identity === null || pickerQuery.trim().startsWith('>')) {
      return;
    }
    const timer = window.setTimeout(() => {
      void requestPickerAssets(identity, pickerQuery);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [identity, pickerOpen, pickerQuery, requestPickerAssets]);

  useEffect(() => {
    setPickerIndex((current) => pickerEntries.length === 0 ? 0 : Math.min(current, pickerEntries.length - 1));
  }, [pickerEntries.length]);

  useEffect(() => {
    setActiveTabId((current) => current !== null && tabs.some((tab) => tab.id === current) ? current : tabs[0]?.id ?? null);
    setSecondaryTabId((current) => current !== null && tabs.some((tab) => tab.id === current) ? current : null);
    if (tabs.length === 0) setScreen((current) => current === 'session' ? 'new' : current);
  }, [tabs]);

  useEffect(() => {
    if (secondaryTabId === null && paneFocus === 'secondary') {
      setPaneFocus('primary');
    }
  }, [paneFocus, secondaryTabId]);

  useEffect(() => {
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        const session = sessionById.get(tab.sessionId);
        const title = session ? tabTitle(session) : tab.title;
        if (title === tab.title) return tab;
        changed = true;
        return { ...tab, title };
      });
      return changed ? next : current;
    });
  }, [locale, sessionById]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || composingRef.current) {
        return;
      }
      if (event.key.toLocaleLowerCase() === 'k' && (event.metaKey || (event.ctrlKey && event.shiftKey))) {
        event.preventDefault();
        setPickerOpen(true);
        window.requestAnimationFrame(() => pickerInputRef.current?.focus());
        return;
      }
      if (event.key === 'Escape' && pickerOpen) {
        event.preventDefault();
        setPickerOpen(false);
        setPickerQuery('');
        window.requestAnimationFrame(() => pickerTriggerRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen]);


  const saveSite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = siteForm.name.trim();
    const rawUrl = siteForm.url.trim();
    if (name.length === 0 || rawUrl.length === 0) {
      setSiteForm((current) => ({ ...current, error: t('请填写站点名称和 HTTPS 地址。') }));
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      setSiteForm((current) => ({ ...current, error: t('请输入有效的 HTTPS 站点地址。') }));
      return;
    }
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
      setSiteForm((current) => ({ ...current, error: t('站点必须是无凭据、无片段的 HTTPS 入口地址。') }));
      return;
    }
    try {
      const response: unknown = await window.desktop.invoke('site.save', { id: siteForm.id || undefined, name, url: url.toString().replace(/\/$/, '') });
      const saved = siteSchema.parse(response);
      setSites((current) => {
        const previous = current.find((site) => site.id === saved.id);
        return previous === undefined ? [...current, saved] : current.map((site) => site.id === saved.id ? saved : site);
      });
      if (identityRef.current === null) setSelectedSiteId(saved.id);
      setSiteDialogOpen(false);
      addToast(t('已保存站点“{{name}}”。', { name: saved.name }), 'success');
    } catch (error: unknown) {
      setSiteForm((current) => ({ ...current, error: getErrorMessage(error) }));
    }
  };

  const saveSettings = useCallback(async (settings: PreferenceSettings): Promise<boolean> => {
    return (await persistPreferences({ ...preferencesRef.current, ...settings })) !== null;
  }, [persistPreferences]);

  const toggleFavorite = async (asset: Asset) => {
    const alreadyFavorite = preferences.favorites.includes(asset.id);
    const favorites = alreadyFavorite
      ? preferences.favorites.filter((id) => id !== asset.id)
      : [...preferences.favorites, asset.id];
    const savedPreferences = await persistPreferences({ ...preferences, favorites });
    if (savedPreferences !== null) refreshFavorites();
  };

  const pickTab = (tabId: string) => {
    setScreen('session');
    if (choosingSplitTarget) {
      if (tabId === activeTabId) {
        addToast(t('副窗格需要选择另一个标签，不能镜像同一个终端实例。'), 'error');
        return;
      }
      setSecondaryTabId(tabId);
      setPaneFocus('secondary');
      setChoosingSplitTarget(false);
      return;
    }
    if (tabId === secondaryTabId && activeTabId !== null) {
      setSecondaryTabId(activeTabId);
      setActiveTabId(tabId);
      setPaneFocus('primary');
      return;
    }
    setActiveTabId(tabId);
    setPaneFocus('primary');
  };

  const closeRequestedTab = pendingCloseTabId === null ? null : tabs.find((tab) => tab.id === pendingCloseTabId) ?? null;
  const closeRequestedSession = closeRequestedTab === null ? null : sessionById.get(closeRequestedTab.sessionId) ?? null;
  const closeNeedsWarning = closeRequestedSession?.phase === 'connecting';
  const closingQuickId = closeRequestedSession ? fileSlots[`quick:${closeRequestedSession.id}`] : undefined;
  const closeHasActiveTransfer = !!closingQuickId && tasks.some((task) => (
    (task.sessionId === closingQuickId || task.sourceSessionId === closingQuickId) && (task.phase === 'queued' || task.phase === 'transferring')
  ));
  const closeHasDirtyContents = closeRequestedSession !== null && (dirtySessionIds.includes(closeRequestedSession.id) || (!!closingQuickId && dirtySessionIds.includes(closingQuickId)));
  const detachedFileSessions = sessions.filter((session) => session.detached && session.kind === 'files' && session.phase === 'active');
  const selectedAssetMethods = selectedAsset === null ? [] : assetOptions.methods;
  const quickEntries: QuickSwitcherEntry[] = pickerEntries.map((entry) => {
    if (entry.kind === 'library') return { key: entry.key, section: t('工作区'), title: entry.title, kind: 'library' };
    if (entry.kind === 'command') return { key: entry.key, section: entry.command.group, title: entry.command.label, detail: entry.command.description, kind: 'command' };
    if (entry.kind === 'tab') return { key: entry.key, section: t('已打开标签'), title: entry.session.context.assetName, detail: `${entry.session.context.accountName} · ${phaseLabel(entry.session.phase)}`, kind: entry.session.kind };
    const visualKind = assetVisualKind(entry.asset);
    return {
      key: entry.key,
      section: t('授权资产'),
      title: entry.asset.name,
      detail: entry.asset.address,
      kind: visualKind === 'database' ? 'database' : visualKind === 'host' ? 'terminal' : 'asset'
    };
  });
  const openPicker = (query = '') => { setPickerQuery(query); setPickerIndex(0); setPickerOpen(true); };
  const browseHosts = () => { setScreen('library'); setSidebarView('assets'); };
  const libraryTitle = sidebarView === 'recent' ? t('最近连接') : sidebarView === 'settings' ? t('设置') : favoritesOnly ? t('收藏的资产') : selectedGroup?.name ?? t('全部资产');
  const browseAllAssets = () => { assetBrowser.resetAll(); setSidebarView('assets'); setScreen('library'); };
  const selectAssetGroup = (_group: AssetGroup, path: AssetGroup[]) => {
    assetBrowser.selectGroup(path);
    setSidebarView('assets');
    setScreen('library');
  };

  if (bootstrapState === 'loading') {
    return (
      <main className="startup-screen" aria-live="polite">
        <div className="startup-mark"><TerminalSquare size={30} /></div>
        <strong>{t('正在连接桌面工作台')}</strong>
        <span>{t('读取本地站点并从系统安全存储恢复授权…')}</span>
      </main>
    );
  }

  if (bootstrapState === 'error') {
    return (
      <main className="startup-screen" aria-live="assertive">
        <div className="startup-mark is-error"><CircleAlert size={30} /></div>
        <strong>{t('无法初始化工作台')}</strong>
        <span>{bootstrapError}</span>
        <Button variant="primary" className="app-action button-primary" type="button" onPress={() => void loadSnapshot()}><RefreshCw size={15} />{t('重新尝试')}</Button>
      </main>
    );
  }


  return (
    <main className={`desktop-shell platform-${window.desktop.platform}`}>
      <header className="desktop-tabs">
        <div className="library-tabs" role="tablist" aria-label={t('资源工作区')}>
          <Button variant="tertiary" type="button"  className={screen === 'library' ? 'library-tab is-selected' : 'library-tab'}  onPress={browseHosts} render={(buttonProps) => <button {...buttonProps} role="tab"  aria-selected={screen === 'library'} />} > <ShieldCheck size={17} /><span>{t('资产库')}</span></Button>
          <Button variant="tertiary" type="button"  className={screen === 'sftp' ? 'library-tab is-selected' : 'library-tab'}  onPress={() => setScreen('sftp')} render={(buttonProps) => <button {...buttonProps} role="tab"  aria-selected={screen === 'sftp'} />} > <FolderOpen size={17} /><span>SFTP</span>{[fileSlots.left, fileSlots.right].some((id) => id && dirtySessionIds.includes(id)) && <i className="tab-dirty" aria-label={t('SFTP 有未保存内容')} />}</Button>
        </div>
        <div className="connection-tabs" role="tablist" aria-label={t('已打开工作标签')}>
          {tabs.map((tab) => {
            const session = sessionById.get(tab.sessionId);
            if (!session) return null;
            const selected = screen === 'session' && (tab.id === activeTabId || tab.id === secondaryTabId);
            return <div className={`connection-tab ${selected ? 'is-selected' : ''}`} key={tab.id}>
              <Button variant="tertiary" type="button"   onPress={() => pickTab(tab.id)} render={(buttonProps) => <button {...buttonProps} role="tab" title={`${tab.title} · ${phaseLabel(session.phase)}`}  aria-selected={selected} />} > <span className={`tab-protocol is-${session.kind}`}><SessionIcon kind={session.kind} size={15} /><i className={`is-${session.phase}`} /></span>
              <span>{session.context.assetName}</span>{tab.id === secondaryTabId && <small>{t('分屏')}</small>}
              {(dirtySessionIds.includes(session.id) || dirtySessionIds.includes(fileSlots[`quick:${session.id}`])) && <span className="tab-dirty" aria-label={t('未保存')} />}</Button>
              <Button variant="tertiary" className="tab-close" type="button" isIconOnly aria-label={t('关闭 {{title}}', { title: tab.title })} isDisabled={closingTabId !== null} onPress={() => setPendingCloseTabId(tab.id)}><X size={14} /></Button>
            </div>;
          })}
          {screen === 'new' && <div className="connection-tab is-selected new-tab-label"><span>{t('新标签页')}</span><Button variant="tertiary" className="tab-close" type="button" isIconOnly aria-label={t('关闭新标签页')} onPress={browseHosts}><X size={14} /></Button></div>}
        </div>
        <Button variant="tertiary" className="chrome-button new-tab-button" type="button" isIconOnly aria-label={t('新建标签页')}  onPress={() => setScreen('new')} render={(buttonProps) => <button {...buttonProps} title={t('新建标签页')} />} > <Plus size={22} /></Button>
        {globalUpdate && <Button variant="tertiary" className="update-entry" type="button" onPress={openUpdateSettings} render={(buttonProps) => <button {...buttonProps} title={globalUpdate.phase === 'downloaded' ? t('更新 {{version}} 已下载，打开设置', { version: globalUpdate.latestVersion ?? '' }) : t('更新 {{version}} 可用，打开设置', { version: globalUpdate.latestVersion ?? '' })} />}>
          <Download size={16} aria-hidden="true" /><span>{globalUpdate.phase === 'downloaded' ? t('更新 {{version}} 已下载，打开设置', { version: globalUpdate.latestVersion ?? '' }) : t('更新 {{version}} 可用，打开设置', { version: globalUpdate.latestVersion ?? '' })}</span>
        </Button>}
        <div className="window-actions">
          <Button variant="tertiary" className="chrome-button" type="button" isIconOnly ref={pickerTriggerRef}  aria-label={t('打开全局 Picker')} onPress={() => openPicker()} render={(buttonProps) => <button {...buttonProps} title={t('快速跳转 · ⌘K')} />} > <Search size={18} /></Button>
          <Popover.Root isOpen={taskDrawerOpen} onOpenChange={setTaskDrawerOpen}>
            <Button variant="tertiary" className={`chrome-button ${taskDrawerOpen ? 'is-active' : ''}`} type="button" isIconOnly  aria-label={t('切换传输任务')} render={(buttonProps) => <button {...buttonProps} title={t('传输任务')} />} > <Bell size={18} />{taskSummary.length > 0 && <i className="activity-dot" />}</Button>
            <Popover.Content className="task-drawer" placement="bottom end" offset={7}>
              <Popover.Dialog className="task-drawer-dialog" aria-label={t('传输任务')}>
                <TaskDrawer tasks={tasks} detachedSessions={detachedFileSessions} attachingSessionIds={attachingSessionIds} cancelingTaskIds={cancelingTaskIds} onAttach={(sessionId) => void attachSession(sessionId)} onCancel={(task) => void cancelTask(task)} onClose={() => setTaskDrawerOpen(false)} />
              </Popover.Dialog>
            </Popover.Content>
          </Popover.Root>
          <Button variant="tertiary" className={`chrome-button ${choosingSplitTarget ? 'is-active' : ''}`} type="button" isIconOnly aria-label={secondaryTabId ? t('聚焦主窗格') : t('选择分屏标签')}  isDisabled={tabs.length < 2} onPress={() => executeCommand(secondaryTabId ? 'workspace.focus-primary' : 'workspace.prepare-split')} render={(buttonProps) => <button {...buttonProps} title={secondaryTabId ? t('结束分屏') : t('分屏')} />} > {secondaryTabId ? <LayoutPanelLeft size={18} /> : <PanelRight size={18} />}</Button>
        </div>
      </header>

      <div className="desktop-body">
        <section className={`library-layout ${sidebarHidden ? 'sidebar-hidden' : ''} ${screen !== 'library' ? 'is-inactive' : ''} ${selectedAsset && sidebarView !== 'recent' && sidebarView !== 'settings' ? 'has-details' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties} aria-label={t('资产库')} aria-hidden={screen !== 'library'} inert={screen !== 'library'}>
          <aside className="library-sidebar">
            <nav aria-label={t('主导航')}>
              <Button variant="tertiary" className={sidebarView === 'assets' && !favoritesOnly && !selectedGroup ? 'nav-item is-selected' : 'nav-item'} type="button" onPress={browseAllAssets}><Server size={18} /><span>{t('全部资产')}</span></Button>
              <Button variant="tertiary" className={sidebarView === 'assets' && favoritesOnly ? 'nav-item is-selected' : 'nav-item'} type="button" onPress={() => { setSidebarView('assets'); changeFavoritesOnly(true); }}><Star size={18} /><span>{t('收藏')}</span>{preferences.favorites.length > 0 && <small>{preferences.favorites.length}</small>}</Button>
              <Button variant="tertiary" className={sidebarView === 'recent' ? 'nav-item is-selected' : 'nav-item'} type="button" onPress={() => setSidebarView('recent')}><History size={18} /><span>{t('最近连接')}</span></Button>
            </nav>
            <div className="library-group-slot"><AssetGroupTree groups={groups} selectedGroupId={sidebarView === 'assets' ? selectedGroup?.id ?? null : null} onSelect={selectAssetGroup} onRefresh={() => void refreshAssetLibrary()} navigationVersion={groupNavigationRef.current} /></div>
            <nav className="sidebar-bottom-nav" aria-label={t('工作台工具')}>
              <Button variant="tertiary" className="nav-item" type="button" onPress={() => executeCommand('tasks.toggle')}><List size={18} /><span>{t('传输任务')}</span>{taskSummary.length > 0 && <small>{taskSummary.length}</small>}</Button>
              <Button variant="tertiary" className={sidebarView === 'settings' ? 'nav-item is-selected' : 'nav-item'} type="button" onPress={() => executeCommand('settings.open')}><Settings size={18} /><span>{t('设置')}</span></Button>
            </nav>
            <div className="sidebar-identity"><i className={identity ? 'is-connected' : ''} /><span>{identity?.name ?? t('尚未登录')}<small>{selectedSite?.name ?? 'JumpServer Desktop'}</small></span>{identity && <Button variant="tertiary" className="icon-button" type="button" isIconOnly  aria-label={t('注销')} isDisabled={identityBusy} onPress={() => executeCommand('auth.logout')} render={(buttonProps) => <button {...buttonProps} title={t('注销')} />} > <LogOut size={16} /></Button>}</div>
            <div className="sidebar-resizer" role="separator" aria-label={t('调整侧栏宽度')} aria-orientation="vertical" aria-valuemin={200} aria-valuemax={340} aria-valuenow={sidebarWidth} tabIndex={0}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                setSidebarWidth(width => Math.max(200, Math.min(340, width + (event.key === 'ArrowRight' ? 16 : -16))));
              }}
              onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) setSidebarWidth(Math.max(200, Math.min(340, event.clientX - event.currentTarget.parentElement!.getBoundingClientRect().left)));
              }}
              onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); }}
            />
          </aside>

          <section className="library-main">
            {sidebarView === 'settings' && <Button variant="tertiary" className="sidebar-toggle-settings toolbar-button" onPress={() => setSidebarHidden(value => !value)}><LayoutPanelLeft size={16} />{t(sidebarHidden ? '显示侧栏' : '收起侧栏')}</Button>}
            {sidebarView !== 'settings' && <div className="library-tools">
              {sidebarView === 'assets' ? <div className="host-search input-frame"><Search size={18} /><Input variant="secondary" ref={assetSearchRef} value={assetSearch} onChange={(event) => changeAssetSearch(event.currentTarget.value)} placeholder={selectedGroup ? t('在「{{name}}」中搜索名称或地址…', { name: selectedGroup.name }) : favoritesOnly ? t('搜索收藏的资产…') : t('查找资产名称或地址…')} aria-label={t('搜索授权资产')} />{assetSearch && <Button variant="tertiary" type="button" className="icon-button" isIconOnly aria-label={t('清除搜索')} onPress={() => changeAssetSearch('')}><X size={15} /></Button>}<kbd>{t('搜索资产')}</kbd></div> : <div className="library-page-title"><h1>{libraryTitle}</h1><span>{selectedSite?.name ?? 'JumpServer Desktop'}</span></div>}
              <div className="host-toolbar">
                <div className="host-toolbar-actions">
                  <Button variant="tertiary" className="icon-button" isIconOnly aria-label={t(sidebarHidden ? '显示侧栏' : '收起侧栏')} aria-expanded={!sidebarHidden} onPress={() => setSidebarHidden(value => !value)}><LayoutPanelLeft size={17} /></Button>
                  <Button variant="secondary" className="toolbar-button" type="button" isDisabled={identityBusy || assetLoadState === 'loading'} onPress={() => identity ? void refreshAssetLibrary() : executeCommand(selectedSite ? 'auth.login' : 'site.add')}>{identityBusy || assetLoadState === 'loading' ? <LoaderCircle className="spin" size={15} /> : identity ? <RefreshCw size={15} /> : <LogIn size={15} />}{identity ? t('刷新资产') : selectedSite ? t('登录站点') : t('添加站点')}</Button>
                  <Button variant="secondary" className="toolbar-button" type="button" onPress={() => setScreen('new')}><TerminalSquare size={16} />{t('新建连接')}</Button>
                </div>
                <div className="host-toolbar-options">
                  {sidebarView === 'assets' && <div className="view-switch" role="group" aria-label={t('资产视图')}>
                    <Button variant="tertiary" className={assetLayout === 'grid' ? 'icon-button is-active' : 'icon-button'} type="button" isIconOnly aria-label={t('网格视图')} aria-pressed={assetLayout === 'grid'} onPress={() => setAssetLayout('grid')}><LayoutGrid size={19} /></Button>
                    <Button variant="tertiary" className={assetLayout === 'list' ? 'icon-button is-active' : 'icon-button'} type="button" isIconOnly aria-label={t('列表视图')} aria-pressed={assetLayout === 'list'} onPress={() => setAssetLayout('list')}><List size={20} /></Button>
                  </div>}
                  <div className="site-picker">
                    <Popover.Root isOpen={siteMenuOpen} onOpenChange={setSiteMenuOpen}>
                      <Button variant="tertiary" className={`site-avatar ${identity?.siteId === selectedSiteId ? 'is-authenticated' : ''}`} type="button" isIconOnly aria-label={t('切换 JumpServer 站点')} aria-haspopup="listbox"  isDisabled={identityBusy} render={(buttonProps) => <button {...buttonProps} title={selectedSite?.name ?? t('选择 JumpServer 站点')} />} > {identityBusy ? <LoaderCircle className="spin" size={18} /> : selectedSite?.name.slice(0, 1).toUpperCase() ?? 'J'}</Button>
                      <Popover.Content className="site-popover" placement="bottom end" offset={9}>
                        <Popover.Dialog aria-label={t('JumpServer 站点')}>
                          <header><strong>{t('JumpServer 站点')}</strong><small>{t('切换站点以浏览对应的授权资产')}</small></header>
                          <div role="listbox" aria-label={t('已配置站点')}>{sites.map((site, index) => <Button variant="tertiary" className={site.id === selectedSiteId ? 'site-option is-selected' : 'site-option'} type="button" key={site.id}   onPress={() => requestIdentityTransition(site.id)} render={(buttonProps) => <button {...buttonProps} role="option"  aria-selected={site.id === selectedSiteId} />} > <span className={`site-option-avatar tone-${index % 4}`}>{site.name.slice(0, 1).toUpperCase()}</span><span><strong>{site.name}</strong><small>{site.url}</small></span>{site.id === selectedSiteId && <Check size={17} />}</Button>)}</div>
                          <footer><Button variant="tertiary" type="button" onPress={() => executeCommand('site.add')}><Plus size={17} />{t('添加 JumpServer 站点')}</Button>{selectedSite && <Button variant="tertiary" type="button" onPress={() => { setSiteMenuOpen(false); setSiteForm({ ...selectedSite, error: '' }); setSiteDialogOpen(true); }}><SlidersHorizontal size={17} />{t('编辑当前站点')}</Button>}</footer>
                        </Popover.Dialog>
                      </Popover.Content>
                    </Popover.Root>
                    <Button variant="tertiary" className="site-add-button" type="button" isIconOnly  aria-label={t('添加站点')} onPress={() => executeCommand('site.add')} render={(buttonProps) => <button {...buttonProps} title={t('添加站点')} />} > <Plus size={23} /></Button>
                  </div>
                </div>
              </div>
            </div>}

            <div className="library-content">
              {sidebarView === 'settings' ? <SettingsPage preferences={preferences} update={appUpdate} updateLoadError={appUpdateLoadError} onSave={saveSettings} onNotify={addToast} siteSection={
                <section className="settings-site">
                  <h2>{t('当前站点')}</h2>
                  <strong>{selectedSite?.name ?? t('未配置站点')}</strong>
                  {selectedSite && <p>{selectedSite.url}</p>}
                  <div>
                    <Button variant="secondary" className="app-action button-quiet" type="button" onPress={() => executeCommand('site.add')}><Plus size={15} />{t('添加站点')}</Button>
                    <Button variant="secondary" className="app-action button-quiet" type="button" isDisabled={!selectedSite} onPress={() => selectedSite && (setSiteForm({ ...selectedSite, error: '' }), setSiteDialogOpen(true))}><SlidersHorizontal size={15} />{t('编辑站点')}</Button>
                    <Button variant="danger" className="app-action button-danger" type="button" isDisabled={!selectedSite} onPress={() => setRemoveSiteId(selectedSite?.id ?? null)}>{t('删除站点')}</Button>
                  </div>
                </section>
              } /> : sidebarView === 'recent' ? <NewTabPage recent={scopedRecent} siteName={selectedSite?.name ?? ''} onConnect={(context) => void openRecent(context)} onSearch={openPicker} onBrowseHosts={browseHosts} /> : <>
                {identity === null ? <section className="library-welcome">
                  <span className="welcome-symbol"><Server size={30} strokeWidth={1.5} /></span>
                  <h1>{selectedSite ? t('连接到 {{name}}', { name: selectedSite.name }) : t('你的资产，从这里开始')}</h1>
                  <p>{selectedSite ? t('优先恢复已保存授权；需要认证时打开系统浏览器，复用站点的 SSO 与 MFA。') : t('添加 JumpServer 站点，将资产、终端和文件放在同一个工作区。')}</p>
                  {selectedSite && <span className="welcome-address">{selectedSite.url}</span>}
                  {authNotice && <p role="status">{authNotice}</p>}
                  <Button variant="primary" className="app-action button-primary" type="button" isDisabled={identityBusy} onPress={() => executeCommand(selectedSite ? 'auth.login' : 'site.add')}>{identityBusy ? <LoaderCircle className="spin" size={16} /> : selectedSite ? <LogIn size={16} /> : <Plus size={16} />}{identityBusy ? t('正在恢复或等待浏览器授权…') : selectedSite ? t('登录站点') : t('添加站点')}</Button>
                  {identityBusy && <Button variant="secondary" className="app-action button-quiet" type="button" onPress={() => void window.desktop.invoke('auth.cancel', {}).catch((error) => addToast(getErrorMessage(error), 'error'))}>{t('取消登录')}</Button>}
                  <small><ShieldCheck size={13} />{t('OAuth 凭据由系统密钥库加密；不保存目标主机密码')}</small>
                </section> : <>
                  <nav className="asset-breadcrumb" aria-label={t('资产分组路径')}>
                    <Button variant="tertiary" onPress={browseAllAssets}>{t('全部资产')}</Button>
                    {favoritesOnly && <><ChevronRight size={13} /><span aria-current="page">{t('收藏')}</span></>}
                    {groupPath.map((group, index) => <span className="asset-breadcrumb-segment" key={group.id}>
                      <ChevronRight size={13} />
                      {index === groupPath.length - 1 ? <span aria-current="page" title={group.path}>{group.name}</span> : <Button variant="tertiary" onPress={() => selectAssetGroup(group, groupPath.slice(0, index + 1))}>{group.name}</Button>}
                    </span>)}
                  </nav>
                  {groupScopeError && <InlineError message={groupScopeError} onRetry={() => void refreshAssetLibrary()} />}
                  {assetSearch.length === 0 && !favoritesOnly && !selectedGroup && sidebarView === 'assets' && <section className="collections-section"><h2>{t('快速访问')}</h2><div className="collection-grid">
                    <Button variant="tertiary" className="collection-card" type="button" onPress={() => changeFavoritesOnly(true)}><span className="collection-symbol is-favorite"><Star size={24} /></span><span><strong>{t('收藏的资产')}</strong><small>{t('{{count}} 个收藏', { count: preferences.favorites.length })}</small></span></Button>
                    <Button variant="tertiary" className="collection-card" type="button" onPress={() => setSidebarView('recent')}><span className="collection-symbol is-recent"><History size={24} /></span><span><strong>{t('最近连接')}</strong><small>{t('{{count}} 条连接记录', { count: scopedRecent.length })}</small></span></Button>
                    <Button variant="tertiary" className="collection-card" type="button" onPress={() => setScreen('sftp')}><span className="collection-symbol is-files"><FolderOpen size={24} /></span><span><strong>{t('文件工作区')}</strong><small>{t('{{count}} 个活动连接', { count: sessions.filter((session) => session.kind === 'files' && session.phase === 'active').length })}</small></span></Button>
                  </div></section>}
                  <div className="asset-category-strip" role="group" aria-label={t('资产类别')}>
                    {assetCategories.map(({ value, label, Icon }) => <Button variant="tertiary" className={assetCategory === value ? 'is-selected' : ''} type="button" key={value ?? 'all'} aria-pressed={assetCategory === value} onPress={() => changeAssetCategory(value)}><Icon size={15} /><span>{label}</span></Button>)}
                  </div>
                  <div className="hosts-heading"><h2>{libraryTitle}</h2><span>{assetLoadState === 'ready' ? t('{{count}} 项资产', { count: assetPagination.total }) : ''}</span>{selectedGroup && <small className="group-descendant-note">{t('含子分组')}</small>}{(selectedGroup || favoritesOnly) && <Button variant="tertiary" className="text-button" type="button" onPress={assetBrowser.searchAll}>{t('搜索全部资产')}<ArrowRight size={13} /></Button>}</div>
                  {assetLoadState === 'loading' && <LoadingRows label={t('正在读取授权资产…')} />}
                  {assetLoadState === 'error' && <InlineError message={assetError ?? t('资产加载失败')} onRetry={() => void refreshAssetLibrary()} />}
                  {assetLoadState === 'ready' && assetPagination.assets.length === 0 && <EmptyAssetState icon={<Search size={25} />} title={favoritesOnly ? t('还没有可用的收藏') : t('没有找到资产')} detail={assetSearch || assetCategory ? t('试试其他名称、地址或资产类型。') : favoritesOnly ? t('点击资产卡片上的星标，将常用资产放在这里。') : selectedGroup ? t('当前分组及子分组中没有可访问的资产。') : t('当前身份尚未获得资产授权。')} />}
                  <div className={`host-grid ${assetLayout === 'list' ? 'is-list' : ''}`} aria-label={t('授权资产')} aria-live="polite">{assetPagination.assets.map((asset) => {
                    const favorite = preferences.favorites.includes(asset.id);
                    return <article className={selectedAsset?.id === asset.id ? 'host-card is-selected' : 'host-card'} key={asset.id}>
                      <Button variant="tertiary" className="host-card-main" type="button" aria-pressed={selectedAsset?.id === asset.id} onPress={() => void selectAsset(asset)} render={(buttonProps) => <button {...buttonProps} title={`${asset.name} · ${asset.address}`} />} > <AssetSymbol category={asset.category} type={asset.type} /><span className="host-card-copy"><strong>{asset.name}</strong><small>{asset.type && <>{asset.type} · </>}{asset.address}</small></span></Button>
                      <Button variant="tertiary" className={`host-favorite ${favorite ? 'is-active' : ''}`} type="button" isIconOnly aria-label={`${favorite ? t('取消收藏') : t('收藏')} ${asset.name}`} onPress={() => void toggleFavorite(asset)}><Star size={15} fill={favorite ? 'currentColor' : 'none'} /></Button>
                    </article>;
                  })}</div>
                  {assetLoadState === 'ready' && assetPageLoadState === 'error' && <InlineError message={assetPageError ?? t('无法读取更多资产')} onRetry={() => void requestNextAssetPage()} />}
                  {assetLoadState === 'ready' && hasMoreAssetPages(assetPagination) && <div className="asset-load-more"><span>{t('已显示 {{count}} / {{total}} 项资产', { count: assetPagination.assets.length, total: assetPagination.total })}</span><Button variant="secondary" className="app-action button-quiet" type="button" isDisabled={assetPageLoadState === 'loading'} onPress={() => void requestNextAssetPage()}>{assetPageLoadState === 'loading' ? <><LoaderCircle className="spin" size={14} />{t('加载中…')}</> : t('加载更多')}</Button></div>}
                </>}
              </>}
            </div>
          </section>

          {selectedAsset && sidebarView !== 'recent' && sidebarView !== 'settings' && <aside className="host-details" aria-label={t('资产连接方式')}>
            <header className="details-header"><div><strong>{t('资产详情')}</strong><span>{selectedSite?.name}</span></div><Button variant="tertiary" className="icon-button" type="button" isIconOnly aria-label={t('关闭连接面板')} onPress={closeAssetDetails}><X size={19} /></Button></header>
            <div className="details-scroll"><section className="details-card"><h3>{t('常规')}</h3><div className="detail-host-name"><AssetSymbol category={selectedAsset.category} type={selectedAsset.type} /><strong>{selectedAsset.name}</strong></div><label>{t('地址')}<Input variant="secondary" readOnly value={selectedAsset.address} /></label>{selectedAsset.comment && <p className="detail-comment">{selectedAsset.comment}</p>}</section>
              {assetOptions.stage === 'loading' && <div className="details-loading"><LoaderCircle className="spin" size={18} />{t('正在确认授权…')}</div>}
              {assetOptions.stage === 'error' && <InlineError message={assetOptions.error ?? t('无法读取连接选项')} onRetry={() => void selectAsset(selectedAsset)} />}
              {assetOptions.stage === 'ready' && <>
                <section className="details-card"><h3>{t('连接账号')}</h3>{assetOptions.accounts.length === 0 ? <p className="muted-copy">{t('当前资产没有可用的授权账号。')}</p> : <RadioGroup className="account-list" value={selectedAccountId ?? undefined} onChange={setSelectedAccountId} aria-label={t('连接账号')}>{assetOptions.accounts.map((account) => <Radio value={account.id} className={`account-choice ${account.id === selectedAccountId ? 'is-selected' : ''}`} key={account.id}><Radio.Content><KeyRound size={16} /><span><strong>{account.name}</strong><small>{account.username}</small></span>{account.id === selectedAccountId && <Check size={16} />}</Radio.Content></Radio>)}</RadioGroup>}</section>
                <section className="details-card"><h3>{t('连接方式')}</h3>{selectedAccount === null ? <p className="muted-copy">{t('选择一个账号后建立连接。')}</p> : <div className="connection-methods">{sessionKinds.map(({ kind, label, Icon }) => {
                  const method = selectedAssetMethods.find((candidate) => sessionKindForMethod(candidate) === kind);
                  if (!method) return <div className="method-unavailable" key={kind}><Icon size={17} /><span>{t(label)}</span><small>{t('未授权')}</small></div>;
                  return <Button variant="secondary" className="method-button" type="button" key={kind} isDisabled={openingSessionKinds.includes(kind)} onPress={() => void openSession(kind, method)}><Icon size={18} /><span>{openingSessionKinds.includes(kind) ? t('连接中…') : t(label)}</span><ArrowRight size={15} /></Button>;
                })}</div>}</section>
              </>}
              <p className="details-footnote"><ShieldCheck size={14} />{t('连接由 JumpServer 授权与审计')}</p>
            </div>
          </aside>}
        </section>

        <section className={`sftp-library-surface ${screen !== 'sftp' ? 'is-inactive' : ''}`} aria-label={t('SFTP 文件工作区')} aria-hidden={screen !== 'sftp'} inert={screen !== 'sftp'}>
          <SftpWorkspace key={getScopeKey(identity)} identity={identity} preferences={preferences} leftLocal={leftLocal}
            leftSession={sessionById.get(fileSlots.left) ?? null} rightSession={sessionById.get(fileSlots.right) ?? null}
            dirtySessionIds={dirtySessionIds} getDirtyHandler={getDirtyHandler} onTransferTasksCreated={registerTransferTasks}
            onConnect={(side: SftpSide, context) => openFileSlot(side, context)} onDisconnect={releaseFileSlot}
            onUseLocal={async () => { await releaseFileSlot('left'); setLeftLocal(true); }} />
        </section>

        <section className={`workbench ${screen !== 'session' ? 'is-inactive' : ''}`} aria-label={t('连接工作区')} aria-hidden={screen !== 'session'} inert={screen !== 'session'}>
          {choosingSplitTarget && <div className="split-instruction"><PanelRight size={16} /><span>{t('点击另一个连接标签，将它放入右侧窗格。')}</span><Button variant="tertiary" type="button" onPress={() => setChoosingSplitTarget(false)}>{t('取消')}</Button></div>}
          <div className={`workspace-stage ${secondarySession !== null ? 'is-split' : ''}`}>
            {tabs.map((tab) => {
              const session = sessionById.get(tab.sessionId);
              if (!session) return null;
              const visiblePane = tab.id === activeTabId ? 'primary' : tab.id === secondaryTabId ? 'secondary' : null;
              return <article className={`workspace-slot ${visiblePane ? `is-${visiblePane}` : 'is-hidden'} ${paneFocus === visiblePane ? 'is-focused' : ''}`} key={tab.id} aria-hidden={!visiblePane} inert={!visiblePane} onMouseDown={() => visiblePane && setPaneFocus(visiblePane)}>
                <div className="split-caption"><SessionIcon kind={session.kind} size={13} /><strong>{session.context.assetName}</strong><span>{session.context.accountName}</span><i className={`connection-indicator is-${session.phase}`} /></div>
                <div className="pane-content">{session.kind === 'terminal' ? <TerminalWorkspace session={session} identity={identity} preferences={preferences}
                  onReconnect={() => void openRecent(session.context)} reconnecting={openingSessionKinds.includes(session.kind)}
                  fileSession={sessionById.get(fileSlots[`quick:${session.id}`]) ?? null}
                  dirty={dirtySessionIds.includes(fileSlots[`quick:${session.id}`])}
                  onConnect={(context) => openFileSlot(`quick:${session.id}`, context)} onDisconnect={() => releaseFileSlot(`quick:${session.id}`)}
                  onFileDirtyChange={getDirtyHandler(fileSlots[`quick:${session.id}`] ?? `quick:${session.id}`)} onTransferTasksCreated={registerTransferTasks} />
                  : <DatabasePane session={session} preferences={preferences} onDirtyChange={getDirtyHandler(session.id)} onReconnect={() => void openRecent(session.context)} reconnecting={openingSessionKinds.includes(session.kind)} />}</div>
              </article>;
            })}
          </div>
        </section>
        {screen === 'new' && <section className="new-tab-surface" aria-label={t('新标签页')}><NewTabPage recent={scopedRecent} siteName={selectedSite?.name ?? ''} onConnect={(context) => void openRecent(context)} onSearch={openPicker} onBrowseHosts={browseHosts} /></section>}
      </div>

      {pickerOpen && <QuickSwitcher entries={quickEntries} index={pickerIndex} query={pickerQuery} loading={pickerAssetState === 'loading'} inputRef={pickerInputRef} onQueryChange={(value) => { setPickerQuery(value); setPickerIndex(0); }} onIndexChange={setPickerIndex} onActivate={(key) => { const entry = pickerEntries.find((entry) => entry.key === key); if (entry) activatePickerEntry(entry); }} onClose={() => { setPickerOpen(false); setPickerQuery(''); }} onCompositionChange={(value) => { composingRef.current = value; }} />}
      {siteDialogOpen && <SiteDialog form={siteForm} onChange={setSiteForm} onClose={() => setSiteDialogOpen(false)} onSubmit={saveSite} />}
      {pendingFileSession && <AlertDialog.Root isOpen onOpenChange={(isOpen) => { if (!isOpen && !replacingFile) setPendingFileSession(null); }}>
        <AlertDialog.Backdrop className="modal-backdrop" isDismissable={false} isKeyboardDismissDisabled>
          <AlertDialog.Container className="app-modal-container" placement="center">
            <AlertDialog.Dialog className="modal-card confirmation-dialog" aria-label={t('替换 SFTP 连接')}>
              <AlertDialog.Heading>{t('在 SFTP 中打开新主机？')}</AlertDialog.Heading>
              <AlertDialog.Body><p>{t('右侧当前连接有未保存的编辑。继续将丢弃编辑，已有传输会在后台继续。')}</p></AlertDialog.Body>
              <AlertDialog.Footer className="modal-actions">
                <Button variant="secondary" type="button" autoFocus className="app-action button-quiet" isDisabled={replacingFile} onPress={() => { const session = pendingFileSession; setPendingFileSession(null); void window.desktop.invoke('session.detach', { sessionId: session.id }).catch((error) => addToast(getErrorMessage(error), 'error')); }}>{t('保留当前连接')}</Button>
                <Button variant="danger" type="button" className="app-action button-danger" isDisabled={replacingFile} onPress={() => { setReplacingFile(true); void adoptFileSlot('right', pendingFileSession).then(() => { setPendingFileSession(null); setScreen('sftp'); }).catch((error) => addToast(getErrorMessage(error), 'error')).finally(() => setReplacingFile(false)); }}>{replacingFile ? t('切换中…') : t('丢弃编辑并打开')}</Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog.Root>}
      {pendingIdentityAction && <AlertDialog.Root isOpen onOpenChange={(isOpen) => { if (!isOpen && !identityBusy) setPendingIdentityAction(null); }}>
        <AlertDialog.Backdrop className="modal-backdrop" isDismissable={false} isKeyboardDismissDisabled>
          <AlertDialog.Container className="app-modal-container" placement="center">
            <AlertDialog.Dialog className="modal-card confirmation-dialog">
              <AlertDialog.Icon status="warning"><LogOut size={25} /></AlertDialog.Icon>
              <AlertDialog.Heading>{pendingIdentityAction.siteId ? t('切换 JumpServer 站点？') : t('注销当前身份？')}</AlertDialog.Heading>
              <AlertDialog.Body><p>{t('当前连接将关闭，传输将停止，未保存的草稿会丢弃。已发送的命令和写入不能保证撤回。')}</p></AlertDialog.Body>
              <AlertDialog.Footer className="modal-actions">
                <Button variant="secondary" className="app-action button-quiet" type="button" autoFocus isDisabled={identityBusy} onPress={() => setPendingIdentityAction(null)}>{t('继续工作')}</Button>
                <Button variant="danger" className="app-action button-danger" type="button" isDisabled={identityBusy} onPress={() => void transitionIdentity(pendingIdentityAction.siteId)}>{identityBusy ? t('处理中…') : t('确认并继续')}</Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog.Root>}
      {removeSiteId !== null && <RemoveSiteDialog site={sites.find((site) => site.id === removeSiteId) ?? null} onCancel={() => setRemoveSiteId(null)} onConfirm={() => {
        const siteId = removeSiteId;
        setRemoveSiteId(null);
        void (async () => {
          try {
            if (identityRef.current?.siteId === siteId) {
              z.void().parse(await window.desktop.invoke('auth.logout', {}));
              clearScopedMemory();
              identityRef.current = null;
              scopeRef.current = 'signed-out';
              setIdentity(null);
            }
            z.void().parse(await window.desktop.invoke('site.remove', { siteId }));
            setSites((current) => current.filter((site) => site.id !== siteId));
            setSelectedSiteId((current) => current === siteId ? null : current);
            addToast(t('已删除站点。'), 'success');
          } catch (error) { addToast(t('无法删除站点：{{error}}', { error: getErrorMessage(error) }), 'error'); }
        })();
      }} />}
      {closeRequestedTab && <CloseTabDialog tab={closeRequestedTab} needsWarning={closeNeedsWarning} hasDirtyContents={closeHasDirtyContents} hasActiveTransfer={closeHasActiveTransfer} busy={closingTabId === closeRequestedTab.id} onCancel={() => { if (closingTabId === null) setPendingCloseTabId(null); }} onConfirm={() => void closeTab(closeRequestedTab.id)} />}
      <ToastRegion toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </main>
  );
}

function SessionIcon({ kind, size = 18 }: { kind: SessionKind; size?: number }) {
  return kind === 'terminal' ? <TerminalSquare size={size} /> : kind === 'files' ? <FolderOpen size={size} /> : <Database size={size} />;
}

function assetVisualKind({ category: rawCategory, type: rawType }: Pick<Asset, 'category' | 'type'>): 'database' | 'host' | 'server' {
  const category = rawCategory?.toLocaleLowerCase();
  const type = rawType?.toLocaleLowerCase();
  if (category === 'database' || (category === undefined && type !== undefined && databaseAssetTypes[type] === true)) {
    return 'database';
  }
  return category === 'host' ? 'host' : 'server';
}

function AssetSymbol(asset: Pick<Asset, 'category' | 'type'>) {
  const visualKind = assetVisualKind(asset);
  return <span className={`asset-symbol is-${visualKind}`} aria-hidden="true">{visualKind === 'database' ? <Database size={25} /> : visualKind === 'host' ? <TerminalSquare size={25} /> : <Server size={25} />}</span>;
}



function EmptyAssetState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="asset-empty"><span>{icon}</span><strong>{title}</strong><p>{detail}</p></div>;
}

function LoadingRows({ label }: { label: string }) {
  return <div className="loading-rows"><LoaderCircle className="spin" size={16} /><span>{label}</span><i /><i /><i /></div>;
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  useI18n();
  return <div className="inline-error"><CircleAlert size={16} /><span>{message}</span><Button variant="tertiary" type="button" className="text-button" onPress={onRetry}>{t('重试')}</Button></div>;
}

function TaskDrawer({ tasks, detachedSessions, attachingSessionIds, cancelingTaskIds, onAttach, onCancel, onClose }: { tasks: TransferTask[]; detachedSessions: SessionInfo[]; attachingSessionIds: string[]; cancelingTaskIds: string[]; onAttach: (sessionId: string) => void; onCancel: (task: TransferTask) => void; onClose: () => void }) {
  useI18n();
  return (
    <>
      <header className="task-drawer-header"><div><span className="panel-label">{t('后台任务')}</span><strong>{t('传输队列')}</strong></div><Button variant="tertiary" className="icon-button" type="button" isIconOnly aria-label={t('关闭任务抽屉')} onPress={onClose}><X size={16} /></Button></header>
      <div className="task-list">
        {tasks.length === 0 && detachedSessions.length === 0 && <EmptyAssetState icon={<FolderOpen size={24} />} title={t('暂无传输任务')} detail={t('上传和下载进度将在这里显示。')} />}
        {tasks.map((task) => {
          const percentage = task.total === undefined || task.total <= 0 ? null : Math.min(100, Math.round((task.transferred / task.total) * 100));
          const cancelable = task.phase === 'queued' || task.phase === 'transferring';
          const canceling = cancelable && (task.cancelRequested || cancelingTaskIds.includes(task.id));
          return (
            <div className="task-row" key={task.id}>
              <div className="task-row-top"><span className="task-direction">{task.sourceSessionId ? t('远端复制') : task.direction === 'upload' ? t('上传') : t('下载')}</span><strong>{task.name}</strong><span className={`task-phase is-${task.phase} ${canceling ? 'is-canceling' : ''}`}>{canceling ? t('正在取消') : taskPhaseLabel(task.phase)}</span></div>
              <div className="task-progress"><i style={percentage === null ? undefined : { width: `${percentage}%` }} /></div>
              <div className="task-meta"><span>{formatBytes(task.transferred)}{task.total === undefined ? '' : ` / ${formatBytes(task.total)}`}</span>{task.error !== undefined && <span className="task-error">{task.error}</span>}{cancelable && <Button variant="tertiary" className="text-button" type="button" isDisabled={canceling} onPress={() => onCancel(task)}>{canceling ? t('正在取消…') : t('取消')}</Button>}</div>
            </div>
          );
        })}
        {detachedSessions.length > 0 && <section className="detached-workspaces" aria-label={t('后台文件工作区')}>
          <span className="panel-label">{t('后台文件工作区')}</span>
          {detachedSessions.map((session) => <div className="detached-workspace" key={session.id}>
            <span><strong>{tabTitle(session)}</strong><small>{t('传输仍在后台运行')}</small></span>
            <Button variant="secondary" size="sm" className="app-action button-quiet button-small" type="button" isDisabled={attachingSessionIds.includes(session.id)} onPress={() => onAttach(session.id)}>{attachingSessionIds.includes(session.id) ? t('重新打开中…') : t('重新打开')}</Button>
          </div>)}
        </section>}
      </div>
    </>
  );
}


function SiteDialog({ form, onChange, onClose, onSubmit }: { form: { id: string; name: string; url: string; error: string }; onChange: (form: { id: string; name: string; url: string; error: string }) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  useI18n();
  return (
    <Modal.Root isOpen onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <Modal.Backdrop className="modal-backdrop" isDismissable>
        <Modal.Container className="app-modal-container" placement="center">
          <Modal.Dialog className="modal-card site-dialog">
            <Modal.Header className="site-dialog-header">
              <div>
                <span className="panel-label">{t('受信入口')}</span>
                <Modal.Heading>{form.id.length > 0 ? t('编辑站点') : t('添加站点')}</Modal.Heading>
              </div>
              <Button variant="tertiary" className="icon-button" type="button" isIconOnly aria-label={t('关闭')} onPress={onClose}><X size={17} /></Button>
            </Modal.Header>
            <Modal.Body className="site-dialog-body">
              <form onSubmit={onSubmit}>
                <label>
                  {t('站点名称')}
                  <Input variant="secondary" autoFocus value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value, error: '' })} placeholder={t('例如：生产 JumpServer')} />
                </label>
                <label>
                  {t('HTTPS 地址')}
                  <Input variant="secondary" value={form.url} onChange={(event) => onChange({ ...form, url: event.target.value, error: '' })} placeholder="https://jumpserver.example.com" inputMode="url" />
                </label>
                <p className="field-hint">{t('支持部署子路径。不会接受 HTTP、URL 内嵌凭据或片段。')}</p>
                {form.error.length > 0 && <div className="form-error"><CircleAlert size={15} />{form.error}</div>}
                <div className="modal-actions">
                  <Button variant="secondary" className="app-action button-quiet" type="button" onPress={onClose}>{t('取消')}</Button>
                  <Button variant="primary" className="app-action button-primary" type="submit"><Check size={15} />{t('保存站点')}</Button>
                </div>
              </form>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}

function RemoveSiteDialog({ site, onCancel, onConfirm }: { site: Site | null; onCancel: () => void; onConfirm: () => void }) {
  useI18n();
  return (
    <AlertDialog.Root isOpen onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <AlertDialog.Backdrop className="modal-backdrop" isDismissable isKeyboardDismissDisabled={false}>
        <AlertDialog.Container className="app-modal-container" placement="center">
          <AlertDialog.Dialog className="modal-card confirmation-dialog">
            <AlertDialog.Icon status="danger"><CircleAlert className="danger-icon" size={25} /></AlertDialog.Icon>
            <AlertDialog.Heading>{t('删除“{{value}}”', { value: site?.name ?? t('此站点') })}</AlertDialog.Heading>
            <AlertDialog.Body><p>{t('这会删除本地站点配置。若服务端仍有活动会话，必须由主进程按真实注销和关闭语义处理。')}</p></AlertDialog.Body>
            <AlertDialog.Footer className="modal-actions">
              <Button variant="secondary" className="app-action button-quiet" type="button" onPress={onCancel}>{t('取消')}</Button>
              <Button variant="danger" className="app-action button-danger" type="button" onPress={onConfirm}><X size={15} />{t('删除站点')}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog.Root>
  );
}

function CloseTabDialog({ tab, needsWarning, hasDirtyContents, hasActiveTransfer, busy, onCancel, onConfirm }: { tab: WorkspaceTab; needsWarning: boolean; hasDirtyContents: boolean; hasActiveTransfer: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  useI18n();
  const actionLabel = hasActiveTransfer ? t('关闭标签并在后台继续') : hasDirtyContents ? t('丢弃并关闭') : t('关闭连接');
  return (
    <AlertDialog.Root isOpen onOpenChange={(isOpen) => { if (!isOpen && !busy) onCancel(); }}>
      <AlertDialog.Backdrop className="modal-backdrop" isDismissable={!busy} isKeyboardDismissDisabled={busy}>
        <AlertDialog.Container className="app-modal-container" placement="center">
          <AlertDialog.Dialog className="modal-card confirmation-dialog">
            <AlertDialog.Icon status={needsWarning || hasDirtyContents ? 'danger' : 'default'}><CircleAlert className={(needsWarning || hasDirtyContents) ? 'danger-icon' : undefined} size={25} /></AlertDialog.Icon>
            <AlertDialog.Heading>{t('关闭工作标签？')}</AlertDialog.Heading>
            <AlertDialog.Body>
              {hasActiveTransfer ? <p>{t('关闭“{{title}}”会结束终端连接。快捷 SFTP 的传输不会取消，文件连接会保留在后台，完成前可从任务抽屉重新打开。', { title: tab.title })}</p> : <p>{needsWarning ? t('“{{title}}”仍在建立连接。关闭会请求服务端结束该会话，无法撤销。', { title: tab.title }) : t('关闭“{{title}}”会请求服务端结束对应会话。', { title: tab.title })}</p>}
              {hasDirtyContents && <p>{t('此工作区含有未保存的内容。确认后这些修改将被丢弃。')}</p>}
            </AlertDialog.Body>
            <AlertDialog.Footer className="modal-actions">
              <Button variant="secondary" className="app-action button-quiet" type="button" isDisabled={busy} onPress={onCancel}>{t('保留标签')}</Button>
              <Button variant="danger" className="app-action button-danger" type="button" isDisabled={busy} onPress={onConfirm}>{busy ? t('处理中…') : actionLabel}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog.Root>
  );
}

function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  useI18n();
  return <div className="toast-region" aria-live="polite">{toasts.map((toast) => <div className={`toast is-${toast.tone}`} key={toast.id}><span>{toast.tone === 'error' ? <CircleAlert size={16} /> : toast.tone === 'success' ? <Check size={16} /> : <Bell size={16} />}</span><p>{toast.message}</p><Button variant="tertiary" type="button" isIconOnly aria-label={t('关闭通知')} onPress={() => onDismiss(toast.id)}><X size={14} /></Button></div>)}</div>;
}
