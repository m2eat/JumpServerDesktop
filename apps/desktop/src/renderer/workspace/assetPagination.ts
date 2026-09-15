import type { Asset } from '../../../../../packages/desktop-contract/src/index';

export interface AssetPage {
  assets: Asset[];
  total: number;
}

export interface AssetPagination {
  assets: Asset[];
  total: number;
  offset: number;
}

export function createAssetPagination(): AssetPagination {
  return { assets: [], total: 0, offset: 0 };
}

/**
 * Applies one server page. Offset tracks rows consumed from the server, while
 * the visible list removes duplicate asset IDs introduced at page boundaries.
 */
export function appendAssetPage(current: AssetPagination, page: AssetPage): AssetPagination {
  if (page.assets.length === 0 && current.offset < page.total) {
    throw new Error('服务端返回的资产分页无法继续消费。');
  }

  const seen = new Set(current.assets.map((asset) => asset.id));
  const assets = [...current.assets];
  for (const asset of page.assets) {
    if (!seen.has(asset.id)) {
      seen.add(asset.id);
      assets.push(asset);
    }
  }

  return {
    assets,
    total: page.total,
    offset: current.offset + page.assets.length
  };
}

export function hasMoreAssetPages(pagination: AssetPagination): boolean {
  return pagination.offset < pagination.total;
}
