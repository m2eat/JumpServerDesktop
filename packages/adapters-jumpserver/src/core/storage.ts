import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Identity, Preferences, PreferenceSettings, Site } from '../../../desktop-contract/src/index';
import { defaultPreferenceSettings, preferenceSettingsSchema } from '../../../desktop-contract/src/preferences';
import { parsePreferences, parseStoredPreferences, parseStoredPreferenceScope, siteSaveArgsSchema } from './schemas';

const siteRowSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    url: z.string().trim().min(1).max(2_048)
  })
  .strict();

const preferenceRowSchema = z
  .object({
    preferences_json: z.string().min(1)
  })
  .strict();

// Existing device settings predate update preferences; only these new fields may be absent.
const storedDeviceSettingsSchema = preferenceSettingsSchema.extend({
  autoCheckUpdates: preferenceSettingsSchema.shape.autoCheckUpdates.default(true),
  autoDownloadUpdates: preferenceSettingsSchema.shape.autoDownloadUpdates.default(false)
});

function normalizeSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('站点地址不是有效的 HTTPS URL');
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new Error('站点地址必须使用 HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('站点地址不能包含凭据、查询参数或片段');
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath || '/';
  return url.toString().replace(/\/$/, '');
}

function toSite(value: unknown): Site {
  const row = siteRowSchema.parse(value);
  return { id: row.id, name: row.name, url: normalizeSiteUrl(row.url) };
}

export class AuthStorage {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS identity_preferences (
        site_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        preferences_json TEXT NOT NULL,
        PRIMARY KEY (site_id, user_id),
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS device_preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        preferences_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  listSites(): Site[] {
    const rows: unknown = this.database.prepare('SELECT id, name, url FROM sites ORDER BY name COLLATE NOCASE, id').all();
    return z.array(siteRowSchema).parse(rows).map(toSite);
  }

  getSite(siteId: string): Site | null {
    const row: unknown = this.database.prepare('SELECT id, name, url FROM sites WHERE id = ?').get(siteId);
    if (row === undefined) return null;
    return toSite(row);
  }

  saveSite(value: unknown): Site {
    const input = siteSaveArgsSchema.parse(value);
    const site: Site = {
      id: input.id ?? randomUUID(),
      name: input.name,
      url: normalizeSiteUrl(input.url)
    };
    try {
      this.database
        .prepare(
          `INSERT INTO sites (id, name, url) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url`
        )
        .run(site.id, site.name, site.url);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('sites.url')) {
        throw new Error('该 HTTPS 站点已存在');
      }
      throw error;
    }
    return site;
  }

  removeSite(siteId: string): void {
    this.database.prepare('DELETE FROM sites WHERE id = ?').run(siteId);
  }

  private parsePreferenceRow(row: unknown): unknown {
    const parsedRow = preferenceRowSchema.parse(row);
    try {
      return JSON.parse(parsedRow.preferences_json);
    } catch {
      throw new Error('本地偏好设置已损坏，无法读取');
    }
  }

  private readDeviceSettings(): PreferenceSettings | null {
    const row: unknown = this.database
      .prepare('SELECT preferences_json FROM device_preferences WHERE id = 1')
      .get();
    if (row === undefined) return null;
    try {
      return storedDeviceSettingsSchema.parse(this.parsePreferenceRow(row));
    } catch {
      throw new Error('本地应用设置格式无效，无法读取');
    }
  }

  private writeDeviceSettings(settings: PreferenceSettings): void {
    this.database
      .prepare(
        `INSERT INTO device_preferences (id, preferences_json) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET preferences_json = excluded.preferences_json`
      )
      .run(JSON.stringify(settings));
  }

  private getDeviceSettings(): PreferenceSettings {
    const existing = this.readDeviceSettings();
    if (existing) return existing;

    const rows: unknown = this.database
      .prepare('SELECT preferences_json FROM identity_preferences ORDER BY site_id, user_id')
      .all();
    for (const row of z.array(preferenceRowSchema).parse(rows)) {
      const value = this.parsePreferenceRow(row);
      if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'fontSize')) continue;
      try {
        const { favorites: _favorites, recent: _recent, ...settings } = parseStoredPreferences(value);
        this.writeDeviceSettings(settings);
        return settings;
      } catch {
        throw new Error('本地偏好设置格式无效，无法读取');
      }
    }
    return defaultPreferenceSettings();
  }

  private getPreferenceScope(identity: Identity): Pick<Preferences, 'favorites' | 'recent'> {
    const row: unknown = this.database
      .prepare('SELECT preferences_json FROM identity_preferences WHERE site_id = ? AND user_id = ?')
      .get(identity.siteId, identity.userId);
    if (row === undefined) return { favorites: [], recent: [] };

    const value = this.parsePreferenceRow(row);
    try {
      return parseStoredPreferenceScope(value);
    } catch {
      try {
        const legacy = parseStoredPreferences(value);
        return { favorites: legacy.favorites, recent: legacy.recent };
      } catch {
        throw new Error('本地偏好设置格式无效，无法读取');
      }
    }
  }

  getPreferences(identity: Identity | null): Preferences {
    const settings = this.getDeviceSettings();
    if (!identity) return { ...settings, favorites: [], recent: [] };
    return { ...settings, ...this.getPreferenceScope(identity) };
  }

  savePreferences(identity: Identity | null, value: unknown): Preferences {
    const preferences = parsePreferences(value);
    const { favorites, recent, ...settings } = preferences;
    if (!identity && (favorites.length > 0 || recent.length > 0)) {
      throw new Error('未登录时不能保存收藏或最近连接');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.writeDeviceSettings(settings);
      if (identity) {
        this.database
          .prepare(
            `INSERT INTO identity_preferences (site_id, user_id, preferences_json) VALUES (?, ?, ?)
             ON CONFLICT(site_id, user_id) DO UPDATE SET preferences_json = excluded.preferences_json`
          )
          .run(identity.siteId, identity.userId, JSON.stringify({ favorites, recent }));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return identity ? preferences : { ...settings, favorites: [], recent: [] };
  }
}
