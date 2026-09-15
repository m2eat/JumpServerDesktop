import { z } from 'zod';
import { defaultPreferenceSettings, preferenceSettingsSchema } from '../../../desktop-contract/src/preferences';
import type { Account, Asset, ConnectMethod, Identity, Preferences, ResourceContext } from '../../../desktop-contract/src/index';

// Core reserves UUID-shaped organization IDs whose version/variant bits are zero.
const uuid = z.string().guid();
const nonEmpty = z.string().trim().min(1);
const identifier = z.union([nonEmpty, z.number().int().finite().transform(String)]);

export const emptyArgsSchema = z.object({}).strict();

export const siteSaveArgsSchema = z
  .object({
    id: uuid.optional(),
    name: nonEmpty.max(120),
    url: nonEmpty.max(2_048)
  })
  .strict();

export const siteRemoveArgsSchema = z.object({ siteId: uuid }).strict();
export const authLoginArgsSchema = z.object({ siteId: uuid }).strict();

const assetCategoryQuerySchema = nonEmpty.max(64).regex(/^[a-z][a-z0-9_-]*$/);

export const assetsListArgsSchema = z
  .object({
    search: z.string().trim().max(256).optional(),
    category: assetCategoryQuerySchema.optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    favoritesOnly: z.boolean().optional()
  })
  .strict();

export const assetsOptionsArgsSchema = z
  .object({
    assetId: uuid,
    orgId: uuid
  })
  .strict();

const nativeKokoConnectMethodIdentitySchema = z
  .object({
    value: nonEmpty.max(128).regex(/^[a-z0-9][a-z0-9_-]*$/i),
    component: z.literal('koko'),
    type: z.literal('native')
  })
  .strict();

const chenWebConnectMethodIdentitySchema = z
  .object({
    value: z.literal('web_gui'),
    component: z.literal('chen'),
    type: z.literal('web')
  })
  .strict();

const contextBaseSchema = z.object({
  siteId: uuid,
  userId: nonEmpty.max(256),
  orgId: uuid,
  assetId: uuid,
  assetName: nonEmpty.max(512),
  address: nonEmpty.max(1_024),
  accountId: nonEmpty.max(512),
  accountName: nonEmpty.max(512)
});

const contextSchema = z.union([
  contextBaseSchema.extend({ protocol: z.enum(['ssh', 'telnet']), connectMethod: nativeKokoConnectMethodIdentitySchema }).strict(),
  contextBaseSchema.extend({ protocol: z.literal('sftp'), connectMethod: nativeKokoConnectMethodIdentitySchema }).strict(),
  contextBaseSchema.extend({ protocol: z.literal('mysql'), connectMethod: chenWebConnectMethodIdentitySchema }).strict()
]);

export function parseContext(value: unknown): ResourceContext {
  return contextSchema.parse(value);
}

const favoriteIdsSchema = z.array(uuid).max(500).superRefine((favorites, issue) => {
  if (new Set(favorites).size !== favorites.length) {
    issue.addIssue({ code: 'custom', message: '收藏资产不能重复' });
  }
});

export const preferencesSchema = preferenceSettingsSchema
  .extend({
    favorites: favoriteIdsSchema,
    recent: z.array(contextSchema).max(100)
  })
  .strict() satisfies z.ZodType<Preferences>;

const storedPreferenceScopeSchema = z
  .object({
    favorites: favoriteIdsSchema,
    recent: z.array(z.unknown()).max(100)
  })
  .strict();

const storedLegacyPreferencesSchema = preferenceSettingsSchema
  .partial()
  .extend({
    favorites: favoriteIdsSchema,
    recent: z.array(z.unknown()).max(100)
  })
  .strict();

export type PreferenceScope = Pick<Preferences, 'favorites' | 'recent'>;

export function parsePreferences(value: unknown): Preferences {
  return preferencesSchema.parse(value);
}

export function parseStoredPreferenceScope(value: unknown): PreferenceScope {
  const stored = storedPreferenceScopeSchema.parse(value);
  return {
    favorites: stored.favorites,
    recent: stored.recent.flatMap((recent) => {
      const parsed = contextSchema.safeParse(recent);
      return parsed.success ? [parsed.data] : [];
    })
  };
}

export function parseStoredPreferences(value: unknown): Preferences {
  const stored = storedLegacyPreferencesSchema.parse(value);
  if (stored.fontSize === undefined || stored.terminalFont === undefined || stored.scrollback === undefined) {
    throw new Error('本地偏好设置缺少旧版必填字段');
  }
  return parsePreferences({
    ...defaultPreferenceSettings(),
    ...stored,
    recent: stored.recent.flatMap((recent) => {
      const parsed = contextSchema.safeParse(recent);
      return parsed.success ? [parsed.data] : [];
    })
  });
}

const profileSchema = z
  .object({
    id: identifier,
    name: z.string().trim().max(512).optional(),
    username: z.string().trim().max(512).optional()
  })
  .passthrough()
  .superRefine((profile, issue) => {
    if (!profile.name && !profile.username) {
      issue.addIssue({ code: 'custom', message: '用户资料缺少姓名和用户名' });
    }
  });

const currentOrgSchema = z
  .object({
    id: uuid,
    name: z.string().trim().max(512).optional()
  })
  .passthrough();

export function parseIdentity(siteId: string, profileValue: unknown, orgValue: unknown): Identity {
  const profile = profileSchema.parse(profileValue);
  const org = currentOrgSchema.parse(orgValue);
  const name = profile.name || profile.username;
  if (!name) throw new Error('用户资料缺少可显示名称');
  return { siteId, userId: profile.id, name, orgId: org.id };
}

const protocolSchema = z
  .object({
    name: nonEmpty.max(64),
    port: z.number().int().min(0).max(65_535).nullable().optional(),
    public: z.boolean().optional()
  })
  .passthrough();

const permedAccountSchema = z
  .object({
    id: z.string().trim().min(1).max(512).optional(),
    alias: z.string().trim().min(1).max(512).optional(),
    name: nonEmpty.max(512),
    username: z.string().max(512).optional()
  })
  .passthrough()
  .superRefine((account, issue) => {
    if (!account.id && !account.alias) {
      issue.addIssue({ code: 'custom', message: '授权账号缺少标识' });
    }
  });

const labeledChoiceValueSchema = z
  .union([
    nonEmpty.max(128),
    z.object({
      value: nonEmpty.max(128),
      label: z.string().trim().max(512)
    }).passthrough()
  ])
  .transform((value) => typeof value === 'string' ? value : value.value);

const permittedAssetSchema = z
  .object({
    id: uuid,
    name: nonEmpty.max(512),
    address: nonEmpty.max(1_024),
    org_id: uuid,
    category: labeledChoiceValueSchema.nullish(),
    type: labeledChoiceValueSchema.nullish(),
    comment: z.string().max(8_192).nullable().optional(),
    permed_protocols: z.array(protocolSchema).optional(),
    permed_accounts: z.array(permedAccountSchema).optional()
  })
  .passthrough();

export type PermittedAsset = z.infer<typeof permittedAssetSchema>;

export function parsePermittedAsset(value: unknown): PermittedAsset {
  return permittedAssetSchema.parse(value);
}

export function toAsset(value: unknown): Asset {
  const asset = parsePermittedAsset(value);
  return {
    id: asset.id,
    name: asset.name,
    address: asset.address,
    orgId: asset.org_id,
    protocols: (asset.permed_protocols ?? []).map((protocol) => protocol.name),
    ...(asset.category ? { category: asset.category } : {}),
    ...(asset.type ? { type: asset.type } : {}),
    ...(asset.comment ? { comment: asset.comment } : {})
  };
}

export function toAccounts(value: unknown): Account[] {
  const accounts = z.array(permedAccountSchema).parse(value);
  return accounts.map((account) => ({
    id: account.id ?? account.alias ?? '',
    name: account.name,
    username: account.username ?? account.alias ?? account.name
  }));
}

const coreConnectMethodSchema = z
  .object({
    component: nonEmpty.max(128),
    type: nonEmpty.max(128),
    value: nonEmpty.max(128),
    label: nonEmpty.max(256),
    endpoint_protocol: nonEmpty.max(128).optional(),
    disabled: z.boolean().optional()
  })
  .passthrough();

const coreConnectMethodsSchema = z.record(z.string(), z.array(coreConnectMethodSchema));

export type CoreConnectMethod = z.infer<typeof coreConnectMethodSchema>;

export function parseCoreConnectMethods(value: unknown): Record<string, CoreConnectMethod[]> {
  const record = coreConnectMethodsSchema.parse(value);
  const methods: Record<string, CoreConnectMethod[]> = {};
  for (const [protocol, entries] of Object.entries(record)) {
    methods[protocol.toLowerCase()] = entries;
  }
  return methods;
}

const connectionTokenSchema = z
  .object({
    id: identifier,
    is_active: z.boolean().optional(),
    from_ticket: z.string().trim().min(1).nullable().optional(),
    face_token: z.string().trim().min(1).optional()
  })
  .passthrough();

export function parseConnectionToken(value: unknown): { tokenId: string; active: boolean; pending: boolean } {
  const token = connectionTokenSchema.parse(value);
  return {
    tokenId: token.id,
    active: token.is_active !== false,
    pending: Boolean(token.from_ticket || token.face_token || token.is_active === false)
  };
}

export type DesktopConnectMethods = ConnectMethod[];

export function toDesktopConnectMethods(
  asset: PermittedAsset,
  rawMethods: unknown
): DesktopConnectMethods {
  const methodsByProtocol = parseCoreConnectMethods(rawMethods);
  const selected: ConnectMethod[] = [];
  const seen = new Set<string>();

  for (const permittedProtocol of asset.permed_protocols ?? []) {
    const protocol = permittedProtocol.name.toLowerCase();
    for (const method of methodsByProtocol[protocol] ?? []) {
      if (method.disabled) continue;

      const endpointProtocol = method.endpoint_protocol?.toLowerCase();
      let desktopMethod: ConnectMethod | null = null;
      if (
        (protocol === 'ssh' || protocol === 'telnet')
        && method.component === 'koko'
        && method.type === 'native'
        && endpointProtocol === 'ssh'
      ) {
        desktopMethod = { value: method.value, label: method.label, protocol, component: 'koko', type: 'native', endpointProtocol };
      } else if (
        protocol === 'sftp'
        && method.component === 'koko'
        && method.type === 'native'
        && endpointProtocol === 'sftp'
      ) {
        desktopMethod = { value: method.value, label: method.label, protocol, component: 'koko', type: 'native', endpointProtocol };
      } else if (
        protocol === 'mysql'
        && method.component === 'chen'
        && method.type === 'web'
        && method.value === 'web_gui'
        && endpointProtocol === 'http'
      ) {
        desktopMethod = { value: method.value, label: method.label, protocol, component: 'chen', type: 'web', endpointProtocol };
      }
      if (desktopMethod === null) continue;

      const key = `${protocol}\u0000${desktopMethod.component}\u0000${desktopMethod.type}\u0000${desktopMethod.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(desktopMethod);
    }
  }

  return selected;
}

export function parsePaginatedAssets(value: unknown): { values: unknown[]; total: number } {
  const pageSchema = z
    .object({
      count: z.number().int().min(0),
      results: z.array(z.unknown())
    })
    .passthrough();
  const parsed = pageSchema.safeParse(value);
  if (parsed.success) return { values: parsed.data.results, total: parsed.data.count };
  const values = z.array(z.unknown()).parse(value);
  return { values, total: values.length };
}

const apiErrorSchema = z
  .object({
    code: z.string().trim().min(1).optional(),
    detail: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
    error: z.string().trim().min(1).optional()
  })
  .passthrough();

export function parseApiError(value: unknown): { code?: string; detail: string } {
  const parsed = apiErrorSchema.safeParse(value);
  if (!parsed.success) return { detail: '服务端返回了无法识别的错误响应' };
  const rawDetail = parsed.data.detail ?? parsed.data.error ?? '服务端拒绝了请求';
  const detail =
    typeof rawDetail === 'string'
      ? rawDetail
      : Array.isArray(rawDetail)
        ? rawDetail.join('; ')
        : '服务端返回了结构化错误';
  return { ...(parsed.data.code ? { code: parsed.data.code } : {}), detail };
}
