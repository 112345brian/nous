// Characterization + regression tests for how Zotero credentials and the
// user-data export interact with the `meta` table.
//
// expo-sqlite is replaced by a tiny in-memory fake that understands only the
// `meta` statements db.ts issues; every other query returns nothing.

declare const __dirname: string;

const mockMeta = new Map<string, string>();

jest.mock('expo-sqlite', () => {
  const list = (sql: string, params: unknown[]): { negate: boolean; keys: Set<string> } | null => {
    const m = /WHERE key (NOT )?IN \(([^)]*)\)/i.exec(sql);
    if (!m) return null;
    const keys = m[2].includes('?')
      ? (params as string[])
      : [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]);
    return { negate: !!m[1], keys: new Set(keys) };
  };
  const fakeDb = {
    execAsync: async () => {},
    getAllAsync: async (sql: string, params: unknown[] = []) => {
      if (!/FROM meta/i.test(sql)) return [];
      const rows = [...mockMeta].map(([key, value]) => ({ key, value }));
      const l = list(sql, params);
      if (!l) return rows;
      return rows.filter(r => (l.negate ? !l.keys.has(r.key) : l.keys.has(r.key)));
    },
    getFirstAsync: async (sql: string, params: unknown[] = []) => {
      const m = /FROM meta WHERE key = (?:\?|'([^']*)')/i.exec(sql);
      if (!m) return null;
      const key = m[1] ?? (params[0] as string);
      return mockMeta.has(key) ? { value: mockMeta.get(key) } : null;
    },
    runAsync: async (sql: string, params: unknown[] = []) => {
      let m: RegExpExecArray | null;
      if (/INSERT OR REPLACE INTO meta \(key, value\) VALUES \(\?, \?\)/i.test(sql)) {
        mockMeta.set(params[0] as string, params[1] as string);
      } else if ((m = /INSERT OR REPLACE INTO meta (?:\(key, value\) )?VALUES \('([^']+)', \?\)/i.exec(sql))) {
        mockMeta.set(m[1], params[0] as string);
      } else if ((m = /INSERT OR REPLACE INTO meta (?:\(key, value\) )?VALUES \('([^']+)', '([^']*)'\)/i.exec(sql))) {
        mockMeta.set(m[1], m[2]);
      } else if (/DELETE FROM meta WHERE key = \?/i.test(sql)) {
        mockMeta.delete(params[0] as string);
      } else if ((m = /DELETE FROM meta WHERE key IN \(([^)]*)\)/i.exec(sql))) {
        for (const k of m[1].matchAll(/'([^']*)'/g)) mockMeta.delete(k[1]);
      }
      return { lastInsertRowId: 0, changes: 0 };
    },
    withTransactionAsync: async (fn: () => Promise<void>) => { await fn(); },
    closeAsync: async () => {},
  };
  return { __esModule: true, openDatabaseAsync: async () => fakeDb };
});

function freshDb(): typeof import('../db') {
  jest.resetModules();
  return require('../db');
}

// __mocks__/expo-secure-store.js (in-memory, with test controls). Re-required
// after jest.resetModules() in freshDb(), so grab the live instance lazily.
const secure = () => require('expo-secure-store');

beforeEach(() => {
  mockMeta.clear();
  secure().__reset();
});

describe('getZoteroPrefs / saveZoteroPrefs (current behavior)', () => {
  it('returns empty strings when nothing is stored', async () => {
    const db = freshDb();
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: '', userId: '' });
  });

  it('round-trips both values', async () => {
    const db = freshDb();
    await db.saveZoteroPrefs('KEY123', '42');
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: 'KEY123', userId: '42' });
  });
});

describe('Zotero API key in secure storage', () => {
  it('save puts the key in secure storage, not in meta; user id stays in meta', async () => {
    const db = freshDb();
    await db.saveZoteroPrefs('KEY123', '42');
    expect(secure().__dump()).toEqual({ zotero_api_key: 'KEY123' });
    expect(mockMeta.has('zotero_api_key')).toBe(false);
    expect(mockMeta.get('zotero_user_id')).toBe('42');
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: 'KEY123', userId: '42' });
  });

  it('save with an empty key clears the secret', async () => {
    const db = freshDb();
    await db.saveZoteroPrefs('KEY123', '42');
    await db.saveZoteroPrefs('', '42');
    expect(secure().__dump()).toEqual({});
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: '', userId: '42' });
  });

  it('the key is never served from the in-memory meta cache', async () => {
    const db = freshDb();
    await db.saveZoteroPrefs('KEY123', '42');
    expect(await db.getMeta('zotero_api_key')).toBeNull();
  });

  it('a stray meta row is migrated to secure storage on first read, then deleted', async () => {
    const db = freshDb();
    mockMeta.set('zotero_api_key', 'OLDKEY');
    mockMeta.set('zotero_user_id', '7');
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: 'OLDKEY', userId: '7' });
    expect(secure().__dump()).toEqual({ zotero_api_key: 'OLDKEY' });
    expect(mockMeta.has('zotero_api_key')).toBe(false);
    // idempotent: second read, nothing left to migrate
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: 'OLDKEY', userId: '7' });
  });

  it('migration keeps the meta row (and still returns the key) if the secure write fails', async () => {
    const db = freshDb();
    mockMeta.set('zotero_api_key', 'OLDKEY');
    secure().__setFailSet(true);
    expect((await db.getZoteroPrefs()).apiKey).toBe('OLDKEY');
    expect(mockMeta.get('zotero_api_key')).toBe('OLDKEY'); // not lost
    secure().__setFailSet(false);
    await db.getZoteroPrefs(); // retried on the next read
    expect(secure().__dump()).toEqual({ zotero_api_key: 'OLDKEY' });
    expect(mockMeta.has('zotero_api_key')).toBe(false);
  });

  it('migration does not drop the meta row if the secure copy cannot be read back', async () => {
    const db = freshDb();
    mockMeta.set('zotero_api_key', 'OLDKEY');
    secure().__setFailGet(true);
    expect((await db.getZoteroPrefs()).apiKey).toBe('OLDKEY');
    expect(mockMeta.get('zotero_api_key')).toBe('OLDKEY');
  });

  it('a newer meta row (written while secure storage was failing) wins over a stale secret', async () => {
    const db = freshDb();
    await db.saveZoteroPrefs('OLD', '1');
    secure().__setFailSet(true);
    await db.saveZoteroPrefs('NEW', '1'); // secure write fails -> falls back to meta
    expect(mockMeta.get('zotero_api_key')).toBe('NEW');
    secure().__setFailSet(false);
    expect((await db.getZoteroPrefs()).apiKey).toBe('NEW');
    expect(secure().__dump()).toEqual({ zotero_api_key: 'NEW' });
    expect(mockMeta.has('zotero_api_key')).toBe(false);
  });

  it('falls back to meta when secure storage is unavailable (e.g. macOS), and never exports it', async () => {
    const db = freshDb();
    secure().__setAvailable(false);
    await db.saveZoteroPrefs('KEY123', '42');
    expect(secure().__dump()).toEqual({});
    expect(mockMeta.get('zotero_api_key')).toBe('KEY123');
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: 'KEY123', userId: '42' });
    expect(JSON.stringify(await db.exportUserData())).not.toMatch(/KEY123|zotero/);
  });

  it('survives the native module being missing entirely (macOS, stale binary): import must not throw', async () => {
    jest.resetModules();
    jest.doMock('expo-secure-store', () => { throw new Error('Cannot find native module ExpoSecureStore'); });
    try {
      const db = require('../db');
      await db.saveZoteroPrefs('KEY123', '42');
      expect(mockMeta.get('zotero_api_key')).toBe('KEY123');
      expect(await db.getZoteroPrefs()).toEqual({ apiKey: 'KEY123', userId: '42' });
      expect(JSON.stringify(await db.exportUserData())).not.toMatch(/KEY123|zotero/);
    } finally {
      // Put the in-memory manual mock back for the tests that follow.
      jest.doMock('expo-secure-store', () => jest.requireActual('../../../__mocks__/expo-secure-store.js'));
    }
  });

  it('an empty key saved while unavailable then read once available clears the secret', async () => {
    const db = freshDb();
    await db.saveZoteroPrefs('KEY123', '42');
    secure().__setAvailable(false);
    await db.saveZoteroPrefs('', '42'); // meta ''
    secure().__setAvailable(true);
    expect((await db.getZoteroPrefs()).apiKey).toBe('');
    expect(secure().__dump()).toEqual({});
    expect(mockMeta.has('zotero_api_key')).toBe(false);
  });
});

describe('exportUserData / importUserData', () => {
  it('keeps the shape dataSync.ts consumes', async () => {
    const db = freshDb();
    const out = await db.exportUserData();
    expect(Object.keys(out).sort()).toEqual(
      ['annotations', 'bookmarks', 'exported_at', 'prefs', 'reads', 'version'],
    );
    expect(out.version).toBe(1);
  });

  it('exports only allowlisted prefs — never credentials, even from a legacy meta row', async () => {
    const db = freshDb();
    await db.saveZoteroPrefs('SECRETKEY', '42');
    mockMeta.set('zotero_api_key', 'LEGACYKEY'); // pre-migration row still in meta
    mockMeta.set('onboarding_done', 'true');
    mockMeta.set('font_size', '19');
    const { prefs } = await db.exportUserData();
    expect(prefs).toEqual({ font_size: '19' });
    expect(JSON.stringify(await db.exportUserData())).not.toMatch(/SECRETKEY|LEGACYKEY|zotero/);
  });

  it('a brand-new meta key is NOT exported until someone adds it to SYNCED_PREF_KEYS', async () => {
    const db = freshDb();
    mockMeta.set('some_future_api_token', 'tok_live_123');
    mockMeta.set('sync_folder', '/private/device/path');
    mockMeta.set('link_index_json', '{"big":"cache"}');
    mockMeta.set('ast_parser_version', '2');
    const { prefs } = await db.exportUserData();
    expect(prefs).toEqual({});
  });

  it('exports every allowlisted pref that is set', async () => {
    const db = freshDb();
    for (const k of db.SYNCED_PREF_KEYS) mockMeta.set(k, `v_${k}`);
    const { prefs } = await db.exportUserData();
    expect(Object.keys(prefs).sort()).toEqual([...db.SYNCED_PREF_KEYS].sort());
  });

  it('import ignores credentials and other non-allowlisted keys from an old full-meta export', async () => {
    const db = freshDb();
    await db.importUserData({
      version: 1, exported_at: 0, reads: [], bookmarks: [], annotations: [],
      prefs: {
        font_size: '21',
        zotero_api_key: 'OLDKEY', zotero_user_id: '7',
        sync_folder: '/other/device', ast_parser_version: '999', link_index_json: '[]',
        // a malformed value must not throw or be written
        custom_css: 5 as unknown as string,
      },
    });
    expect(mockMeta.get('font_size')).toBe('21');
    for (const k of ['zotero_api_key', 'zotero_user_id', 'sync_folder', 'link_index_json', 'custom_css']) {
      expect(mockMeta.has(k)).toBe(false);
    }
    // initSchema writes its own parser version; the imported '999' must not clobber it.
    expect(mockMeta.get('ast_parser_version')).not.toBe('999');
    expect(await db.getZoteroPrefs()).toEqual({ apiKey: '', userId: '' });
    expect(secure().__dump()).toEqual({});
  });

  it('import writes prefs to meta and keeps the in-memory cache coherent', async () => {
    const db = freshDb();
    expect(await db.getMeta('font_size')).toBeNull(); // primes the cache with null
    await db.importUserData({
      version: 1, exported_at: 0, reads: [], bookmarks: [], annotations: [],
      prefs: { font_size: '21' },
    });
    expect(mockMeta.get('font_size')).toBe('21');
    expect(await db.getMeta('font_size')).toBe('21');
  });

  it('import accepts an export with no prefs field', async () => {
    const db = freshDb();
    await expect(
      db.importUserData({ version: 1, exported_at: 0, reads: [], bookmarks: [], annotations: [] } as any),
    ).resolves.toBeUndefined();
  });
});

describe('callers (static scan)', () => {
  const { readdirSync, readFileSync, statSync } = require('fs');
  const { join } = require('path');
  const SRC = join(__dirname, '..', '..');
  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(f)) out.push(p);
    }
    return out;
  }
  const files = walk(SRC).filter(p => !/__tests__/.test(p));

  // seedImport.ts is the one other legitimate caller: it snapshots the user's data
  // across a database swap, and must restore its non-synced settings itself
  // (setMeta) because the export format is the allowlisted sync format.
  it('only dataSync.ts and seedImport.ts call exportUserData / importUserData', () => {
    const users = files
      .filter(p => /\b(exportUserData|importUserData)\(/.test(readFileSync(p, 'utf8')))
      .map(p => p.slice(SRC.length + 1))
      .filter(p => p !== join('services', 'db.ts'))
      .sort();
    expect(users).toEqual([join('services', 'dataSync.ts'), join('services', 'seedImport.ts')]);
  });

  // seedImport.ts lists the keys only so a seed import keeps those meta rows; it
  // never reads their values for use, and the key itself lives in secure storage.
  it('only db.ts and seedImport.ts name the Zotero credential keys', () => {
    const users = files
      .filter(p => /zotero_(api_key|user_id)/.test(readFileSync(p, 'utf8')))
      .map(p => p.slice(SRC.length + 1));
    expect(users).toEqual([join('services', 'db.ts'), join('services', 'seedImport.ts')]);
  });
});
