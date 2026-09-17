import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Identity } from '../../../desktop-contract/src/index';
import { defaultPreferences } from '../../../desktop-contract/src/preferences';
import { AuthStorage } from './storage';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AuthStorage', () => {
  it('keeps identity favorites and recents isolated while device settings survive site removal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jumpserver-desktop-storage-'));
    temporaryDirectories.push(directory);
    const storage = new AuthStorage(join(directory, 'desktop.sqlite'));
    const site = storage.saveSite({ name: '生产 JumpServer', url: 'https://jump.example.test/base/' });
    const firstIdentity: Identity = {
      siteId: site.id,
      userId: 'user-a',
      name: '用户 A',
      orgId: '0f35c0f1-0ab0-4a15-8f46-1a502ec296f3'
    };
    const secondIdentity: Identity = { ...firstIdentity, userId: 'user-b', name: '用户 B' };
    const nativeRecent = {
      siteId: site.id,
      userId: firstIdentity.userId,
      orgId: firstIdentity.orgId,
      assetId: 'ef58b927-e75f-43a7-b6e0-3213590c74ed',
      assetName: '服务器',
      address: 'server.example.test',
      accountId: 'account',
      accountName: 'operator',
      protocol: 'ssh',
      connectMethod: { value: 'ssh_client', component: 'koko' as const, type: 'native' as const }
    };
    const firstPreferences = {
      ...defaultPreferences(),
      fontSize: 17,
      autoCheckUpdates: false,
      autoDownloadUpdates: true,
      favorites: [nativeRecent.assetId],
      recent: [nativeRecent]
    };
    const devicePreferences = { ...firstPreferences, favorites: [], recent: [] };

    storage.savePreferences(firstIdentity, firstPreferences);
    storage.savePreferences(secondIdentity, {
      ...devicePreferences,
      favorites: ['e91c36a7-59f8-4a10-a68a-f0a5b314b4de']
    });

    expect(storage.getPreferences(firstIdentity)).toEqual(firstPreferences);
    expect(storage.getPreferences(secondIdentity)).toEqual({
      ...devicePreferences,
      favorites: ['e91c36a7-59f8-4a10-a68a-f0a5b314b4de']
    });
    expect(storage.getPreferences(null)).toEqual(devicePreferences);
    storage.removeSite(site.id);
    expect(storage.getPreferences(null)).toEqual(devicePreferences);
    expect(storage.getPreferences(firstIdentity)).toEqual(devicePreferences);
    storage.close();
  });

  it('migrates legacy settings once without clearing identity favorites or valid recents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jumpserver-desktop-storage-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'desktop.sqlite');
    const siteId = '00000000-0000-4000-8000-000000000001';
    const identity: Identity = {
      siteId,
      userId: 'user-a',
      name: '用户 A',
      orgId: '0f35c0f1-0ab0-4a15-8f46-1a502ec296f3'
    };
    const nativeRecent = {
      siteId,
      userId: identity.userId,
      orgId: identity.orgId,
      assetId: 'ef58b927-e75f-43a7-b6e0-3213590c74ed',
      assetName: '服务器',
      address: 'server.example.test',
      accountId: 'account',
      accountName: 'operator',
      protocol: 'ssh',
      connectMethod: { value: 'ssh_client', component: 'koko' as const, type: 'native' as const }
    };
    const chenRecent = {
      ...nativeRecent,
      assetName: '数据库主机',
      protocol: 'mysql',
      connectMethod: { value: 'web_gui' as const, component: 'chen' as const, type: 'web' as const }
    };
    const obsoleteKokoRecent = {
      ...nativeRecent,
      connectMethod: { value: 'web_cli', component: 'koko' as const, type: 'web' as const }
    };
    const legacyPreferences = {
      fontSize: 17,
      terminalFont: defaultPreferences().terminalFont,
      scrollback: defaultPreferences().scrollback,
      favorites: [nativeRecent.assetId],
      recent: [{ ...nativeRecent, connectMethod: 'web_cli' }, obsoleteKokoRecent, nativeRecent, chenRecent]
    };
    const expectedDevicePreferences = { ...defaultPreferences(), fontSize: 17, favorites: [], recent: [] };
    const database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    database.exec(`
      CREATE TABLE sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE identity_preferences (
        site_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        preferences_json TEXT NOT NULL,
        PRIMARY KEY (site_id, user_id),
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
      ) STRICT;
    `);
    database.prepare('INSERT INTO sites (id, name, url) VALUES (?, ?, ?)').run(siteId, '生产 JumpServer', 'https://jump.example.test');
    database
      .prepare('INSERT INTO identity_preferences (site_id, user_id, preferences_json) VALUES (?, ?, ?)')
      .run(identity.siteId, identity.userId, JSON.stringify(legacyPreferences));
    database.close();

    const migrated = new AuthStorage(filePath);
    expect(migrated.getPreferences(null)).toEqual(expectedDevicePreferences);
    expect(migrated.getPreferences(identity)).toEqual({
      ...expectedDevicePreferences,
      favorites: legacyPreferences.favorites,
      recent: [nativeRecent, chenRecent]
    });
    expect(migrated.getPreferences({ ...identity, userId: 'user-b' })).toEqual(expectedDevicePreferences);
    migrated.removeSite(siteId);
    expect(migrated.getPreferences(null)).toEqual(expectedDevicePreferences);
    migrated.close();
  });

  it('migrates existing device settings and persists shortcut and update choices without resetting other settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jumpserver-desktop-storage-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'desktop.sqlite');
    const { shortcuts, autoCheckUpdates: _check, autoDownloadUpdates: _download, favorites: _favorites, recent: _recent, ...legacySettings } = defaultPreferences();
    legacySettings.fontSize = 19;
    legacySettings.language = 'en-US';
    const database = new DatabaseSync(filePath);
    database.exec('CREATE TABLE device_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), preferences_json TEXT NOT NULL) STRICT');
    database.prepare('INSERT INTO device_preferences VALUES (1, ?)').run(JSON.stringify(legacySettings));
    database.close();

    const storage = new AuthStorage(filePath);
    const migrated = storage.getPreferences(null);
    expect(migrated).toEqual({ ...legacySettings, shortcuts, autoCheckUpdates: true, autoDownloadUpdates: false, favorites: [], recent: [] });
    shortcuts.darwin['picker.open'] = 'Shift+Meta+KeyP';
    shortcuts.win32['tabs.close'] = null;
    storage.savePreferences(null, { ...migrated, shortcuts, autoCheckUpdates: false, autoDownloadUpdates: true });
    storage.close();

    const reopened = new AuthStorage(filePath);
    expect(reopened.getPreferences(null)).toEqual({ ...migrated, shortcuts, autoCheckUpdates: false, autoDownloadUpdates: true });
    reopened.close();
  });

  it('rejects invalid device settings and unauthenticated identity data without overwriting settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jumpserver-desktop-storage-'));
    temporaryDirectories.push(directory);
    const storage = new AuthStorage(join(directory, 'desktop.sqlite'));
    const saved = storage.savePreferences(null, { ...defaultPreferences(), fontSize: 17 });

    expect(() => storage.savePreferences(null, { ...saved, terminalLineHeight: 2.01 })).toThrow();
    expect(() => storage.savePreferences(null, { ...saved, autoCheckUpdates: 'false' })).toThrow();
    expect(() => storage.savePreferences(null, { ...saved, autoDownloadUpdates: 'true' })).toThrow();
    expect(() => storage.savePreferences(null, {
      ...saved, shortcuts: { ...saved.shortcuts, darwin: { 'tabs.new': 'Meta+KeyW' } }
    })).toThrow();
    expect(() => storage.savePreferences(null, {
      ...saved,
      favorites: ['ef58b927-e75f-43a7-b6e0-3213590c74ed']
    })).toThrow('未登录');
    expect(storage.getPreferences(null)).toEqual(saved);
    storage.close();
  });

  it('rejects insecure and credential-bearing site URLs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jumpserver-desktop-storage-'));
    temporaryDirectories.push(directory);
    const storage = new AuthStorage(join(directory, 'desktop.sqlite'));

    expect(() => storage.saveSite({ name: '不安全', url: 'http://jump.example.test' })).toThrow('HTTPS');
    expect(() => storage.saveSite({ name: '含凭据', url: 'https://user:secret@jump.example.test' })).toThrow('凭据');
    storage.close();
  });
});
