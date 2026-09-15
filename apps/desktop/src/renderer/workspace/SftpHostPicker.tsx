import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Input, Radio, RadioGroup } from '@heroui/react';
import { ChevronLeft, ChevronRight, FolderOpen, LoaderCircle, Search, Server, X } from 'lucide-react';
import { resourceContextForMethod, sessionKindForMethod } from '@shared/index';
import type { Account, Asset, ConnectMethod, Identity, ResourceContext } from '@shared/index';
import './SftpHostPicker.css';
import { translateDiagnostic, useI18n } from '../i18n';

const ASSET_PAGE_SIZE = 30;
const MAX_ELIGIBILITY_REQUESTS = 4;

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type EligibilityStatus = 'eligible' | 'unsupported' | 'error';

interface AssetOptionsState {
  state: LoadState;
  accounts: Account[];
  method: ConnectMethod | null;
  error: string | null;
}

interface PreferredAccount {
  id: string;
  name: string;
}

interface Eligibility {
  asset: Asset;
  status: EligibilityStatus;
  error?: string;
}

interface ScanRun {
  scope: string;
  cache: Map<string, Eligibility | Promise<Eligibility>>;
}

export interface SftpHostPickerProps {
  identity: Identity | null;
  initialContext?: ResourceContext;
  canReturn?: boolean;
  onSelect: (context: ResourceContext) => Promise<void>;
  onClose: () => void;
}

function scopeKey(identity: Identity | null): string {
  return identity === null ? '' : `${identity.siteId}\u0000${identity.userId}\u0000${identity.orgId}`;
}

function assetKey(asset: Asset): string {
  return `${asset.orgId}\u0000${asset.id}`;
}

function mergeAssets(current: Asset[], additions: Asset[]): Asset[] {
  const seen = new Set(current.map(assetKey));
  const merged = [...current];
  for (const asset of additions) {
    if (!seen.has(assetKey(asset))) {
      seen.add(assetKey(asset));
      merged.push(asset);
    }
  }
  return merged;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return '请求未完成，请检查站点连接后重试。';
}

export function SftpHostPicker({ identity, initialContext, canReturn = false, onSelect, onClose }: SftpHostPickerProps) {
  const { t } = useI18n();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const identityRef = useRef(identity);
  const scopeRef = useRef(scopeKey(identity));
  const runRef = useRef<ScanRun | null>(null);
  const optionsRequestRef = useRef(0);
  const submitRequestRef = useRef(0);
  const pageLoadingRef = useRef(false);
  const nextOffsetRef = useRef(0);
  const totalRef = useRef(0);
  const eligibleAssetsRef = useRef<Asset[]>([]);
  const scanFailuresRef = useRef<Eligibility[]>([]);
  const submittingRef = useRef(false);
  const scanNextPageRef = useRef<((run: ScanRun, expectedEligibleCount: number) => Promise<void>) | null>(null);
  const optionsInFlightRef = useRef(0);
  const optionWaitersRef = useRef<Array<() => void>>([]);

  const [query, setQuery] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetOffset, setAssetOffset] = useState(0);
  const [assetTotal, setAssetTotal] = useState(0);
  const [assetState, setAssetState] = useState<LoadState>('idle');
  const [assetReloadVersion, setAssetReloadVersion] = useState(0);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadingNextPage, setLoadingNextPage] = useState(false);
  const [retryingFailures, setRetryingFailures] = useState(false);
  const [scanFailures, setScanFailures] = useState<Eligibility[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [options, setOptions] = useState<AssetOptionsState>({ state: 'idle', accounts: [], method: null, error: null });
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const titleId = useId();
  const searchId = useId();
  const assetListId = useId();
  const accountListId = useId();
  const scope = scopeKey(identity);

  identityRef.current = identity;
  scopeRef.current = scope;

  const selectedAccount = useMemo(
    () => options.accounts.find((account) => account.id === selectedAccountId) ?? null,
    [options.accounts, selectedAccountId]
  );
  const hasMoreAssets = assetOffset < assetTotal;
  const canConnect = !submitting && identity !== null && selectedAsset !== null && selectedAccount !== null && options.method !== null;

  const isRunCurrent = useCallback((run: ScanRun) => (
    mountedRef.current && runRef.current === run && scopeRef.current === run.scope
  ), []);

  const fetchAssetOptions = useCallback(async (asset: Asset, run?: ScanRun) => {
    if (optionsInFlightRef.current >= MAX_ELIGIBILITY_REQUESTS) {
      await new Promise<void>((resolve) => {
        if (run === undefined) {
          optionWaitersRef.current.unshift(resolve);
        } else {
          optionWaitersRef.current.push(resolve);
        }
      });
    } else {
      optionsInFlightRef.current += 1;
    }
    if (run !== undefined && !isRunCurrent(run)) {
      const next = optionWaitersRef.current.shift();
      if (next !== undefined) next();
      else optionsInFlightRef.current -= 1;
      return null;
    }
    try {
      return await window.desktop.invoke('assets.options', { assetId: asset.id, orgId: asset.orgId });
    } finally {
      const next = optionWaitersRef.current.shift();
      if (next !== undefined) next();
      else optionsInFlightRef.current -= 1;
    }
  }, [isRunCurrent]);

  const probeAsset = useCallback(async (asset: Asset, run: ScanRun): Promise<Eligibility> => {
    const key = assetKey(asset);
    const cached = run.cache.get(key);
    if (cached !== undefined) {
      return await cached;
    }

    const request = (async (): Promise<Eligibility> => {
      try {
        const response = await fetchAssetOptions(asset, run);
        if (response === null) {
          return { asset, status: 'error', error: '授权检查已因搜索条件变化取消。' };
        }
        const hasFileMethod = response.methods.some((method) => sessionKindForMethod(method) === 'files');
        return { asset, status: hasFileMethod && response.accounts.length > 0 ? 'eligible' : 'unsupported' };
      } catch (error: unknown) {
        return { asset, status: 'error', error: errorMessage(error) };
      }
    })();
    run.cache.set(key, request);
    const result = await request;
    if (run.cache.get(key) === request) {
      run.cache.set(key, result);
    }
    return result;
  }, [fetchAssetOptions]);

  const probeAssets = useCallback(async (candidates: Asset[], run: ScanRun): Promise<Eligibility[]> => {
    const results = new Array<Eligibility>(candidates.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(MAX_ELIGIBILITY_REQUESTS, candidates.length) }, async () => {
      while (isRunCurrent(run)) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= candidates.length) {
          return;
        }
        results[index] = await probeAsset(candidates[index], run);
      }
    });
    await Promise.all(workers);
    return results.filter((result): result is Eligibility => result !== undefined);
  }, [isRunCurrent, probeAsset]);

  const applyEligibility = useCallback((results: Eligibility[]) => {
    const additions = results.filter((result) => result.status === 'eligible').map((result) => result.asset);
    eligibleAssetsRef.current = mergeAssets(eligibleAssetsRef.current, additions);
    setAssets(eligibleAssetsRef.current);

    const failures = new Map(scanFailuresRef.current.map((result) => [assetKey(result.asset), result]));
    for (const result of results) {
      if (result.status === 'error') {
        failures.set(assetKey(result.asset), result);
      } else {
        failures.delete(assetKey(result.asset));
      }
    }
    scanFailuresRef.current = [...failures.values()];
    setScanFailures(scanFailuresRef.current);
  }, []);

  const scanNextPage = useCallback(async (run: ScanRun, expectedEligibleCount: number): Promise<void> => {
    if (!isRunCurrent(run) || pageLoadingRef.current || nextOffsetRef.current >= totalRef.current && totalRef.current !== 0) {
      return;
    }

    pageLoadingRef.current = true;
    setLoadingNextPage(true);
    setPageError(null);
    if (eligibleAssetsRef.current.length === 0) {
      setAssetState('loading');
    }

    let continueScanning = false;
    try {
      const offset = nextOffsetRef.current;
      const response = await window.desktop.invoke('assets.list', {
        search: query.trim() || undefined,
        offset,
        limit: ASSET_PAGE_SIZE
      });
      if (!isRunCurrent(run)) {
        return;
      }
      if (response.assets.length === 0 && offset < response.total) {
        throw new Error('服务端返回的资产分页无法继续消费。');
      }

      nextOffsetRef.current = offset + response.assets.length;
      totalRef.current = response.total;
      setAssetOffset(nextOffsetRef.current);
      setAssetTotal(response.total);

      const results = await probeAssets(response.assets, run);
      if (!isRunCurrent(run)) {
        return;
      }
      applyEligibility(results);
      setAssetState('ready');
      continueScanning = eligibleAssetsRef.current.length === expectedEligibleCount && nextOffsetRef.current < totalRef.current;
    } catch (error: unknown) {
      if (!isRunCurrent(run)) {
        return;
      }
      setPageError(errorMessage(error));
      setAssetState(eligibleAssetsRef.current.length === 0 ? 'error' : 'ready');
    } finally {
      if (isRunCurrent(run)) {
        pageLoadingRef.current = false;
        setLoadingNextPage(false);
      }
    }

    if (continueScanning && isRunCurrent(run)) {
      await scanNextPageRef.current?.(run, expectedEligibleCount);
    }
  }, [applyEligibility, isRunCurrent, probeAssets, query]);
  scanNextPageRef.current = scanNextPage;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runRef.current = null;
      optionsRequestRef.current += 1;
      submitRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    optionsRequestRef.current += 1;
    submitRequestRef.current += 1;
    submittingRef.current = false;
    setSelectedAsset(null);
    setSelectedAccountId(null);
    setOptions({ state: 'idle', accounts: [], method: null, error: null });
    setSelectionNotice(null);
    setSubmitError(null);
    setSubmitting(false);
  }, [scope]);

  useEffect(() => {
    const run: ScanRun = { scope, cache: new Map() };
    runRef.current = run;
    pageLoadingRef.current = false;
    nextOffsetRef.current = 0;
    totalRef.current = 0;
    eligibleAssetsRef.current = [];
    scanFailuresRef.current = [];
    setAssets([]);
    setAssetOffset(0);
    setAssetTotal(0);
    setPageError(null);
    setScanFailures([]);
    setLoadingNextPage(false);
    setRetryingFailures(false);

    if (identity === null) {
      setAssetState('idle');
      return;
    }

    setAssetState('loading');
    void scanNextPage(run, 0);
  }, [assetReloadVersion, identity, query, scanNextPage, scope]);

  useEffect(() => {
    if (selectedAsset === null) {
      const frame = window.requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [selectedAsset]);

  const preferredAccountFor = (asset: Asset): PreferredAccount | undefined => {
    if (
      initialContext === undefined
      || identity === null
      || initialContext.siteId !== identity.siteId
      || initialContext.userId !== identity.userId
      || initialContext.orgId !== identity.orgId
      || initialContext.assetId !== asset.id
      || initialContext.orgId !== asset.orgId
    ) {
      return undefined;
    }
    return { id: initialContext.accountId, name: initialContext.accountName };
  };

  const selectAsset = useCallback(async (asset: Asset) => {
    const requestIdentity = identityRef.current;
    if (requestIdentity === null) {
      return;
    }
    const requestScope = scopeKey(requestIdentity);
    const requestId = ++optionsRequestRef.current;
    const preferredAccount = preferredAccountFor(asset);
    setSelectedAsset(asset);
    setSelectedAccountId(null);
    setOptions({ state: 'loading', accounts: [], method: null, error: null });
    setSelectionNotice(null);
    setSubmitError(null);

    try {
      // Selection deliberately re-fetches Core authorization; a scan result is not a connection grant.
      const response = await fetchAssetOptions(asset);
      if (response === null) {
        return;
      }
      if (!mountedRef.current || scopeRef.current !== requestScope || optionsRequestRef.current !== requestId) {
        return;
      }
      const method = response.methods.find((candidate) => sessionKindForMethod(candidate) === 'files') ?? null;
      const preferred = preferredAccount === undefined
        ? null
        : response.accounts.find((account) => account.id === preferredAccount.id) ?? null;
      setOptions({ state: 'ready', accounts: response.accounts, method, error: null });
      setSelectedAccountId(preferred?.id ?? null);
      if (method === null) {
        setSelectionNotice('此主机当前没有 Core 授权的原生 SFTP 连接方式。请返回并选择另一台主机。');
      } else if (response.accounts.length === 0) {
        setSelectionNotice('此主机没有可用于原生 SFTP 的授权账号。请返回并选择另一台主机。');
      } else if (preferredAccount !== undefined && preferred === null) {
        setSelectionNotice(`预选账号“${preferredAccount.name}”不再可用。请选择另一个已授权账号。`);
      } else if (preferred === null) {
        setSelectionNotice('请选择一个已授权账号。');
      }
    } catch (error: unknown) {
      if (!mountedRef.current || scopeRef.current !== requestScope || optionsRequestRef.current !== requestId) {
        return;
      }
      setOptions({ state: 'error', accounts: [], method: null, error: errorMessage(error) });
      setSelectedAccountId(null);
    }
  }, [fetchAssetOptions, initialContext, identity]);

  const clearSelection = () => {
    if (submittingRef.current) {
      return;
    }
    optionsRequestRef.current += 1;
    setSelectedAsset(null);
    setSelectedAccountId(null);
    setOptions({ state: 'idle', accounts: [], method: null, error: null });
    setSelectionNotice(null);
    setSubmitError(null);
  };

  const restartSearch = () => {
    runRef.current = null;
    pageLoadingRef.current = false;
    setAssetReloadVersion((current) => current + 1);
  };

  const loadMoreAssets = () => {
    const run = runRef.current;
    if (run === null || pageLoadingRef.current || !hasMoreAssets) {
      return;
    }
    void scanNextPage(run, eligibleAssetsRef.current.length);
  };

  const retryEligibilityFailures = async () => {
    const run = runRef.current;
    const failures = scanFailuresRef.current;
    if (run === null || failures.length === 0 || retryingFailures) {
      return;
    }
    setRetryingFailures(true);
    for (const failure of failures) {
      run.cache.delete(assetKey(failure.asset));
    }
    const results = await probeAssets(failures.map((failure) => failure.asset), run);
    if (isRunCurrent(run)) {
      applyEligibility(results);
      setRetryingFailures(false);
    }
  };

  const onQueryChange = (value: string) => {
    runRef.current = null;
    pageLoadingRef.current = false;
    setQuery(value);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) {
      return;
    }
    const requestIdentity = identityRef.current;
    if (requestIdentity === null || selectedAsset === null || selectedAccount === null || options.method === null) {
      setSubmitError('请先选择带有 Core 原生 SFTP 授权的主机和账号。');
      return;
    }
    if (!options.accounts.some((account) => account.id === selectedAccount.id)) {
      setSubmitError('所选账号已不在当前授权结果中。请返回并重新选择主机。');
      return;
    }

    const requestScope = scopeKey(requestIdentity);
    const requestId = ++submitRequestRef.current;
    const context = resourceContextForMethod({
      siteId: requestIdentity.siteId,
      userId: requestIdentity.userId,
      orgId: selectedAsset.orgId,
      assetId: selectedAsset.id,
      assetName: selectedAsset.name,
      address: selectedAsset.address,
      accountId: selectedAccount.id,
      accountName: selectedAccount.name
    }, options.method);

    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSelect(context);
      if (mountedRef.current && scopeRef.current === requestScope && submitRequestRef.current === requestId) {
        onClose();
      }
    } catch (error: unknown) {
      if (mountedRef.current && scopeRef.current === requestScope && submitRequestRef.current === requestId) {
        setSubmitError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current && scopeRef.current === requestScope && submitRequestRef.current === requestId) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const closeIfIdle = () => {
    if (!submittingRef.current && canReturn) {
      onClose();
    }
  };

  const scannedCount = assetOffset;
  const emptyAtEnd = assetState === 'ready' && assets.length === 0 && !hasMoreAssets && scanFailures.length === 0;

  return (
    <section className="sftp-host-picker" aria-labelledby={titleId} aria-busy={submitting}>
      <header className="sftp-host-picker__header">
        {selectedAsset === null ? (
          <span className="sftp-host-picker__mark" aria-hidden="true"><FolderOpen size={18} /></span>
        ) : (
          <Button isIconOnly className="sftp-host-picker__back" type="button" variant="ghost" isDisabled={submitting} aria-label={t('返回 SFTP 主机列表')} onPress={clearSelection}><ChevronLeft size={18} /></Button>
        )}
        <span className="sftp-host-picker__heading">
          <strong id={titleId}>{selectedAsset === null ? t('选择 SFTP 主机') : t('选择 SFTP 账号')}</strong>
          <small>{identity === null
            ? t('当前没有已登录身份')
            : selectedAsset === null
              ? t('{{identityName}} · 已授权资产', { identityName: identity.name })
              : t('{{assetName}} · {{address}}', { assetName: selectedAsset.name, address: selectedAsset.address })}</small>
        </span>
        {canReturn && <Button isIconOnly className="sftp-host-picker__close" type="button" variant="ghost" aria-label={t('返回文件')} onPress={closeIfIdle} isDisabled={submitting}><X size={17} /></Button>}
      </header>

      <form className="sftp-host-picker__body" onSubmit={submit}>
        {selectedAsset === null ? (
          <section className="sftp-host-picker__hosts" aria-label={t('已授权 SFTP 主机')}>
            <label className="sftp-host-picker__search input-frame" htmlFor={searchId}>
              <Search size={16} aria-hidden="true" />
              <Input
                ref={searchRef}
                id={searchId}
                type="search"
                aria-label={t('搜索 SFTP 主机或地址')}
                value={query}
                placeholder={t('搜索主机或地址')}
                autoComplete="off"
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </label>
            <p className="sftp-host-picker__search-hint">{t('显示当前身份有权连接的 SFTP 主机。')}</p>

            <div id={assetListId} className="sftp-host-picker__asset-list" role="listbox" aria-label={t('已授权 SFTP 主机')} aria-busy={assetState === 'loading'}>
              {identity === null && <div className="sftp-host-picker__empty" role="status">{t('登录站点后才能读取可授权的 SFTP 主机。')}</div>}
              {identity !== null && assetState === 'loading' && assets.length === 0 && <div className="sftp-host-picker__loading" role="status"><LoaderCircle className="sftp-host-picker__spin" size={16} />{t('正在验证授权主机…')}</div>}
              {identity !== null && assetState === 'error' && <div className="sftp-host-picker__error" role="alert"><span>{t('无法读取授权主机：{{error}}', { error: translateDiagnostic(pageError ?? '') })}</span><Button type="button" variant="ghost" onPress={restartSearch}>{t('重新开始')}</Button></div>}
              {assets.map((asset) => (
                <Button className="sftp-host-picker__asset"
                                type="button"
                                variant="ghost"
                                
                                
                                key={assetKey(asset)}
                                isDisabled={submitting || loadingNextPage || retryingFailures}
                                onClick={() => void selectAsset(asset)} render={(buttonProps) => <button {...buttonProps} role="option"  aria-selected={false} />} > <span className="sftp-host-picker__asset-icon" aria-hidden="true"><Server size={16} /></span>
                                <span className="sftp-host-picker__asset-copy"><strong>{asset.name}</strong><small>{asset.address}</small></span>
                                <ChevronRight size={15} aria-hidden="true" /></Button>
              ))}
              {identity !== null && emptyAtEnd && <div className="sftp-host-picker__empty" role="status">{t('没有当前可用的原生 SFTP 主机。')}</div>}
            </div>

            {(identity !== null && (scanFailures.length > 0 || hasMoreAssets || pageError !== null)) && (
              <footer className="sftp-host-picker__pagination">
                {scanFailures.length > 0 && <p className="sftp-host-picker__scan-error" role="alert"><span>{t('{{count}} 台主机的授权尚未确认，未将它们当作不支持。', { count: scanFailures.length })}{scanFailures[0].error ? ` ${t('最近错误：{{error}}', { error: translateDiagnostic(scanFailures[0].error) })}` : ''}</span><Button type="button" variant="ghost" isDisabled={retryingFailures || submitting} onPress={() => void retryEligibilityFailures()}>{retryingFailures ? t('正在重试…') : t('重试授权检查')}</Button></p>}
                {pageError !== null && assetState === 'ready' && <p className="sftp-host-picker__scan-error" role="alert"><span>{t('下一页未读取：{{error}}', { error: translateDiagnostic(pageError) })}</span><Button type="button" variant="ghost" isDisabled={loadingNextPage || submitting} onPress={loadMoreAssets}>{t('重试此页')}</Button></p>}
                {hasMoreAssets && <Button className="sftp-host-picker__load-more" type="button" variant="secondary" onPress={loadMoreAssets} isDisabled={submitting || loadingNextPage || retryingFailures}>{loadingNextPage ? t('正在查找更多主机…') : t('继续查找主机')}</Button>}
                <small>{t('已检查 {{scannedCount}} / {{assetTotal}} 台资产，显示 {{connectedCount}} 台可连接主机', { scannedCount, assetTotal, connectedCount: assets.length })}</small>
              </footer>
            )}
          </section>
        ) : (
          <section className="sftp-host-picker__details" aria-label={t('SFTP 账号选择')}>
            <div className="sftp-host-picker__selected-host">
              <span className="sftp-host-picker__asset-icon" aria-hidden="true"><Server size={17} /></span>
              <span><strong>{selectedAsset.name}</strong><small>{selectedAsset.address}</small></span>
            </div>

            {options.state === 'loading' && <div className="sftp-host-picker__loading sftp-host-picker__options-loading" role="status"><LoaderCircle className="sftp-host-picker__spin" size={16} />{t('正在重新确认账号与原生 SFTP 方式…')}</div>}
            {options.state === 'error' && <div className="sftp-host-picker__error sftp-host-picker__options-error" role="alert"><span>{t('无法读取连接选项：{{error}}', { error: translateDiagnostic(options.error ?? '') })}</span><Button type="button" variant="ghost" onPress={() => void selectAsset(selectedAsset)}>{t('重试')}</Button></div>}
            {options.state === 'ready' && <>
              {selectionNotice !== null && <p className="sftp-host-picker__notice" role="status">{translateDiagnostic(selectionNotice)}</p>}
              <div className="sftp-host-picker__method"><span>{t('连接方式')}</span><strong>{options.method?.label ?? t('没有可用的原生 SFTP 方式')}</strong></div>
              <fieldset className="sftp-host-picker__accounts">
                <legend>{t('授权账号')}</legend>
                <RadioGroup id={accountListId} aria-label={t('{{assetName}} 的授权账号', { assetName: selectedAsset.name })} value={selectedAccountId ?? undefined} isDisabled={submitting || options.method === null} onChange={(accountId) => { setSelectedAccountId(accountId); setSelectionNotice(null); setSubmitError(null); }}>
                  {options.accounts.map((account) => (
                    <Radio key={account.id} value={account.id}>
                      <Radio.Content className={selectedAccountId === account.id ? 'sftp-host-picker__account is-selected' : 'sftp-host-picker__account'}>
                        <span className="sftp-host-picker__account-copy"><strong>{account.name}</strong><small>{account.username}</small></span>
                        <Radio.Control className="sftp-host-picker__account-control" />
                      </Radio.Content>
                    </Radio>
                  ))}
                  {options.accounts.length === 0 && <p className="sftp-host-picker__no-accounts">{t('Core 没有返回可选账号。')}</p>}
                </RadioGroup>
              </fieldset>
            </>}

            <footer className="sftp-host-picker__footer">
              <span className="sftp-host-picker__submit-error" role="alert">{submitError === null ? null : translateDiagnostic(submitError)}</span>
              <Button className="sftp-host-picker__cancel" type="button" variant="secondary" onPress={clearSelection} isDisabled={submitting}>{t('返回主机')}</Button>
              <Button className="sftp-host-picker__connect" type="submit" variant="primary" isDisabled={!canConnect}>{submitting ? t('正在连接…') : t('连接 SFTP')}</Button>
            </footer>
          </section>
        )}
      </form>
    </section>
  );
}

export default SftpHostPicker;
