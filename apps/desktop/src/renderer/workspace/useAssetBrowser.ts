import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Asset, AssetGroup, Identity } from '@shared/index';
import { appendAssetPage, createAssetPagination, hasMoreAssetPages } from './assetPagination';

const assetSchema: z.ZodType<Asset> = z.object({
  id: z.string(), name: z.string(), address: z.string(), orgId: z.string(),
  protocols: z.array(z.string()), category: z.string().optional(),
  type: z.string().optional(), comment: z.string().optional()
});
export const assetsResultSchema = z.object({ assets: z.array(assetSchema), total: z.number().int().nonnegative() });

interface AssetQuery {
  search: string;
  category: string | undefined;
  favoritesOnly: boolean;
  groupPath: AssetGroup[];
}
const emptyQuery = (): AssetQuery => ({ search: '', category: undefined, favoritesOnly: false, groupPath: [] });
const emptyResult = () => ({
  pagination: createAssetPagination(),
  stage: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  error: null as unknown,
  pageStage: 'idle' as 'idle' | 'loading' | 'error',
  pageError: null as unknown
});

const savedGroupSchema = z.object({ id: z.string().guid(), key: z.string().regex(/^\d+(?::\d+)*$/) });
const selectionKey = (scope: string) => `asset-group-selection:${scope}`;
export function readSavedAssetGroup(identity: Identity): Pick<AssetGroup, 'id' | 'key'> | null {
  try {
    const value = localStorage.getItem(selectionKey(JSON.stringify([identity.siteId, identity.userId, identity.orgId])));
    const parsed = savedGroupSchema.safeParse(value ? JSON.parse(value) : null);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A query change invalidates both pending pages and connection selection before the next request. */
export function useAssetBrowser(identity: Identity | null, onQueryChange: () => void) {
  const scope = identity ? JSON.stringify([identity.siteId, identity.userId, identity.orgId]) : 'signed-out';
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const callbackRef = useRef(onQueryChange);
  callbackRef.current = onQueryChange;
  const [query, setQuery] = useState(emptyQuery);
  const queryRef = useRef(query);
  const [result, setResult] = useState(emptyResult);
  const resultRef = useRef(result);
  const request = useRef(0);
  const loadingPage = useRef(false);
  const [revision, setRevision] = useState(0);

  const invalidate = useCallback(() => {
    request.current++;
    loadingPage.current = false;
    resultRef.current = emptyResult();
    setResult(resultRef.current);
  }, []);

  const updateQuery = useCallback((next: AssetQuery, remember = true) => {
    queryRef.current = next;
    invalidate();
    callbackRef.current();
    setQuery(next);
    if (remember && scopeRef.current !== 'signed-out') {
      try {
        const group = next.groupPath.at(-1);
        if (group) localStorage.setItem(selectionKey(scopeRef.current), JSON.stringify({ id: group.id, key: group.key }));
        else localStorage.removeItem(selectionKey(scopeRef.current));
      } catch {
        // Storage can be unavailable; navigation remains usable without restoration.
      }
    }
  }, [invalidate]);

  const clear = useCallback(() => {
    updateQuery(emptyQuery(), false);
  }, [updateQuery]);
  const resetAll = useCallback(() => updateQuery(emptyQuery()), [updateQuery]);

  useEffect(() => {
    clear();
    return () => { request.current++; };
  }, [scope, clear]);

  const load = useCallback(async (more: boolean) => {
    const currentScope = scopeRef.current;
    if (currentScope === 'signed-out' || loadingPage.current) return;
    const previous = resultRef.current;
    if (more && (previous.stage !== 'ready' || !hasMoreAssetPages(previous.pagination))) return;
    const currentQuery = queryRef.current;
    const id = ++request.current;
    loadingPage.current = true;
    const pagination = more ? previous.pagination : createAssetPagination();
    const pending = more
      ? { ...previous, pageStage: 'loading' as const, pageError: null }
      : { ...emptyResult(), stage: 'loading' as const };
    resultRef.current = pending;
    setResult(pending);
    try {
      const response = await window.desktop.invoke('assets.list', {
        search: currentQuery.search.trim() || undefined,
        category: currentQuery.category,
        favoritesOnly: currentQuery.favoritesOnly || undefined,
        nodeId: currentQuery.groupPath.at(-1)?.id,
        offset: pagination.offset,
        limit: 100
      });
      if (id !== request.current || currentScope !== scopeRef.current) return;
      const next = { ...emptyResult(), pagination: appendAssetPage(pagination, assetsResultSchema.parse(response)), stage: 'ready' as const };
      resultRef.current = next;
      setResult(next);
    } catch (error: unknown) {
      if (id !== request.current || currentScope !== scopeRef.current) return;
      const next = more
        ? { ...previous, pageStage: 'error' as const, pageError: error }
        : { ...emptyResult(), stage: 'error' as const, error };
      resultRef.current = next;
      setResult(next);
    } finally {
      if (id === request.current) loadingPage.current = false;
    }
  }, []);

  useEffect(() => {
    if (scope === 'signed-out') return;
    const timer = window.setTimeout(() => { void load(false); }, 220);
    return () => window.clearTimeout(timer);
  }, [scope, query, revision, load]);

  const refresh = useCallback(() => {
    invalidate();
    setRevision(value => value + 1);
  }, [invalidate]);
  const loadMore = useCallback(() => load(true), [load]);
  const setSearch = useCallback((search: string) => {
    if (queryRef.current.search !== search) updateQuery({ ...queryRef.current, search });
  }, [updateQuery]);
  const setCategory = useCallback((category: string | undefined) => {
    if (queryRef.current.category !== category) updateQuery({ ...queryRef.current, category });
  }, [updateQuery]);
  const setFavorites = useCallback((favoritesOnly: boolean) => {
    updateQuery({ ...emptyQuery(), favoritesOnly });
  }, [updateQuery]);
  const selectGroup = useCallback((groupPath: AssetGroup[]) => {
    updateQuery({ ...queryRef.current, favoritesOnly: false, groupPath });
  }, [updateQuery]);
  const searchAll = useCallback(() => {
    updateQuery({ ...queryRef.current, favoritesOnly: false, groupPath: [] });
  }, [updateQuery]);
  const refreshFavorites = useCallback(() => {
    if (queryRef.current.favoritesOnly) refresh();
  }, [refresh]);

  return { query, ...result, clear, resetAll, setSearch, setCategory, setFavorites, selectGroup, searchAll, refresh, refreshFavorites, loadMore };
}
