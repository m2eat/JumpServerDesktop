import { describe, expect, it } from 'vitest';
import type { Asset } from '../../../../../packages/desktop-contract/src/index';
import { appendAssetPage, createAssetPagination, hasMoreAssetPages } from './assetPagination';

const assets: Asset[] = [
  { id: 'a', name: 'alpha', address: '192.0.2.1', orgId: 'org', protocols: ['ssh'] },
  { id: 'b', name: 'bravo', address: '192.0.2.2', orgId: 'org', protocols: ['ssh'] },
  { id: 'c', name: 'charlie', address: '192.0.2.3', orgId: 'org', protocols: ['ssh'] }
];

describe('asset pagination', () => {
  it('deduplicates visible asset IDs without rewinding the server offset', () => {
    const first = appendAssetPage(createAssetPagination(), { assets: assets.slice(0, 2), total: 5 });
    const second = appendAssetPage(first, { assets: assets.slice(1), total: 5 });

    expect(second.assets.map((asset) => asset.id)).toEqual(['a', 'b', 'c']);
    expect(second.offset).toBe(4);
    expect(hasMoreAssetPages(second)).toBe(true);
  });

  it('rejects a page that claims more rows but consumes none', () => {
    expect(() => appendAssetPage(createAssetPagination(), { assets: [], total: 1 })).toThrow('无法继续消费');
  });
});
