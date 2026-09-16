import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { z } from 'zod';
import type { AssetGroup, Identity } from '@shared/index';
import { t, translateDiagnostic } from '../i18n';

export type AssetGroupReference = Pick<AssetGroup, 'id' | 'key'>;
export type AssetGroupPathResolution =
  | { status: 'found'; group: AssetGroup; path: AssetGroup[] }
  | { status: 'unavailable'; reference: AssetGroupReference }
  | { status: 'error'; error: string };
type LoadState = { stage: 'idle' | 'loading' | 'ready' | 'error'; error?: string };
const groupSchema: z.ZodType<AssetGroup> = z.object({
  id: z.string().guid(), key: z.string().regex(/^\d+(?::\d+)*$/),
  parentKey: z.string(), name: z.string(), path: z.string()
});
const groupsSchema = z.object({ groups: z.array(groupSchema) });
const idle: LoadState = { stage: 'idle' };
function errorMessage(error: unknown): string {
  return error instanceof z.ZodError ? t('服务端返回的数据不符合工作台契约，请检查目标部署兼容性。')
    : error instanceof Error ? translateDiagnostic(error.message) : t('分组加载失败');
}
function createCache(scope: string) {
  let expanded = new Set<string>();
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`asset-group-expanded:${scope}`) ?? '[]');
    expanded = new Set(z.array(z.string().regex(/^\d+(?::\d+)*$/)).parse(value));
  } catch { /* Invalid or unavailable local state never supplies group data. */ }
  return {
    scope, generation: 0, nodes: new Map<string, AssetGroup>(), children: new Map<string, string[]>(),
    loads: new Map<string, LoadState>(), expanded, pending: new Map<string, Promise<AssetGroup[]>>(),
    requests: new Map<string, number>(), query: '', results: [] as AssetGroup[], searchState: idle,
    searchRequest: 0
  };
}

export function useAssetGroups(identity: Identity | null) {
  const scope = identity ? JSON.stringify([identity.siteId, identity.userId, identity.orgId]) : 'signed-out';
  const cache = useMemo(() => createCache(scope), [scope]);
  const active = useRef(cache);
  active.current = cache;
  const [revision, redraw] = useReducer((value: number) => value + 1, 0);
  const publish = useCallback(() => { if (active.current === cache) redraw(); }, [cache]);
  const rememberExpansion = useCallback(() => {
    try { localStorage.setItem(`asset-group-expanded:${scope}`, JSON.stringify([...cache.expanded])); }
    catch { /* Navigation works when persistence is unavailable. */ }
  }, [cache, scope]);

  const loadChildren = useCallback((parentKey = '', fresh = false): Promise<AssetGroup[]> => {
    if (scope === 'signed-out') return Promise.resolve([]);
    if (!fresh) {
      const pending = cache.pending.get(parentKey);
      if (pending) return pending;
      if (cache.loads.get(parentKey)?.stage === 'ready') {
        return Promise.resolve((cache.children.get(parentKey) ?? []).map(key => cache.nodes.get(key)!));
      }
    }
    const generation = cache.generation;
    const request = (cache.requests.get(parentKey) ?? 0) + 1;
    cache.requests.set(parentKey, request);
    const current = () => active.current === cache && cache.generation === generation && cache.requests.get(parentKey) === request;
    cache.loads.set(parentKey, { stage: 'loading' });
    publish();
    const promise = (async () => {
      try {
        const response = groupsSchema.parse(await window.desktop.invoke('assets.groups', parentKey ? { parentKey } : {}));
        if (!current()) throw new Error(t('分组请求已失效'));
        const direct: string[] = [];
        const nested = new Map<string, string[]>();
        for (const group of response.groups) {
          cache.nodes.set(group.key, group);
          if (group.parentKey === parentKey) direct.push(group.key);
          else {
            const siblings = nested.get(group.parentKey) ?? [];
            siblings.push(group.key);
            nested.set(group.parentKey, siblings);
          }
        }
        cache.children.set(parentKey, [...new Set(direct)]);
        // Root responses can include auto-unfolded descendants. Keep their hierarchy,
        // but only mark the explicitly requested level as completely loaded.
        for (const [key, children] of nested) {
          if (cache.loads.get(key)?.stage !== 'ready') cache.children.set(key, [...new Set(children)]);
        }
        cache.loads.set(parentKey, { stage: 'ready' });
        publish();
        return direct.map(key => cache.nodes.get(key)!);
      } catch (error) {
        if (current()) {
          cache.loads.set(parentKey, { stage: 'error', error: errorMessage(error) });
          publish();
        }
        throw error;
      } finally {
        if (current()) cache.pending.delete(parentKey);
      }
    })();
    cache.pending.set(parentKey, promise);
    return promise;
  }, [cache, scope, publish]);

  const search = useCallback(async (query: string): Promise<void> => {
    cache.query = query;
    const request = ++cache.searchRequest;
    const generation = cache.generation;
    cache.results = [];
    if (!query.trim() || scope === 'signed-out') {
      cache.searchState = idle;
      publish();
      return;
    }
    cache.searchState = { stage: 'loading' };
    publish();
    try {
      const response = groupsSchema.parse(await window.desktop.invoke('assets.groups', { search: query.trim() }));
      if (active.current !== cache || cache.generation !== generation || request !== cache.searchRequest) return;
      cache.results = response.groups;
      cache.searchState = { stage: 'ready' };
    } catch (error) {
      if (active.current !== cache || cache.generation !== generation || request !== cache.searchRequest) return;
      cache.searchState = { stage: 'error', error: errorMessage(error) };
    }
    publish();
  }, [cache, scope, publish]);

  const resolve = useCallback(async (reference: AssetGroupReference, fresh: boolean): Promise<AssetGroupPathResolution> => {
    const generation = cache.generation;
    try {
      const path: AssetGroup[] = [];
      const parts = reference.key.split(':');
      let parent = '';
      for (let index = 0; index < parts.length; index++) {
        const key = parts.slice(0, index + 1).join(':');
        const children = await loadChildren(parent, fresh);
        if (active.current !== cache || generation !== cache.generation) return { status: 'error', error: t('分组请求已失效') };
        const group = children.find(candidate => candidate.key === key);
        if (!group || (index === parts.length - 1 && group.id !== reference.id)) return { status: 'unavailable', reference };
        path.push(group);
        parent = key;
      }
      const group = path.at(-1);
      if (!group) return { status: 'unavailable', reference };
      for (const ancestor of path.slice(0, -1)) cache.expanded.add(ancestor.key);
      rememberExpansion();
      publish();
      return { status: 'found', group, path };
    } catch (error) {
      return { status: 'error', error: errorMessage(error) };
    }
  }, [cache, loadChildren, rememberExpansion, publish]);
  const resolvePath = useCallback((reference: AssetGroupReference) => resolve(reference, false), [resolve]);
  const restoreGroup = useCallback((reference: AssetGroupReference) => resolve(reference, true), [resolve]);
  const refreshPath = restoreGroup;
  const refresh = useCallback(async () => {
    cache.generation++;
    cache.pending.clear();
    cache.loads.clear();
    cache.nodes.clear();
    cache.children.clear();
    publish();
    try { await loadChildren('', true); } catch { /* The root exposes its error and retry action. */ }
    if (cache.query) await search(cache.query);
  }, [cache, publish, loadChildren, search]);
  const toggle = useCallback((key: string) => {
    if (cache.expanded.has(key)) cache.expanded.delete(key);
    else {
      cache.expanded.add(key);
      void loadChildren(key).catch(() => {});
    }
    rememberExpansion();
    publish();
  }, [cache, rememberExpansion, publish, loadChildren]);
  const retry = useCallback((key = '') => { void loadChildren(key, true).catch(() => {}); }, [loadChildren]);

  useEffect(() => {
    void refresh();
    return () => { cache.generation++; cache.searchRequest++; cache.pending.clear(); };
  }, [cache, refresh]);

  // Rehydrate expansion lazily only for nodes reached through the current authorized tree.
  useEffect(() => {
    const visit = (parent: string) => {
      for (const key of cache.children.get(parent) ?? []) {
        if (!cache.expanded.has(key)) continue;
        if (!cache.loads.has(key)) void loadChildren(key).catch(() => {});
        else if (cache.loads.get(key)?.stage === 'ready') visit(key);
      }
    };
    visit('');
  }, [cache, loadChildren, revision]);

  return {
    enabled: scope !== 'signed-out', scope, nodes: cache.nodes, children: cache.children,
    loads: cache.loads, expanded: cache.expanded, rootState: cache.loads.get('') ?? idle,
    query: cache.query, results: cache.results, searchState: cache.searchState,
    loadChildren, toggle, retry, search, resolvePath, restoreGroup, refreshPath, refresh
  };
}
export type AssetGroups = ReturnType<typeof useAssetGroups>;
