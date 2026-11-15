// importSeedFromUrl replaces sep.db, which ALSO holds the user's reads, bookmarks,
// annotations, prefs and reading progress. These tests pin that the swap keeps
// that data, rolls back cleanly on failure, and does not use the throwing
// legacy functions from the main `expo-file-system` entry (SDK 54).
// No @types/node in this repo: same local declares as __tests__/mockup/_src.ts.
declare const __dirname: string;
declare function require(mod: string): any;
const { readdirSync, readFileSync } = require('fs');
const { join } = require('path');

import {
  DB_PATH,
  files,
  makeOldDb,
  makeSeedDb,
  resetWorld,
  state,
  type FakeDb,
} from './seedImportWorld';

// In SDK 54 the old async API on the main entry throws at runtime. Mirror that,
// so code that still imports it from here fails the way it does on a device.
jest.mock('expo-file-system', () => {
  const dead = async (name: string) => {
    throw new Error(`Method ${name} imported from "expo-file-system" is deprecated.`);
  };
  return {
    deleteAsync: () => dead('deleteAsync'),
    moveAsync: () => dead('moveAsync'),
    copyAsync: () => dead('copyAsync'),
    getInfoAsync: () => dead('getInfoAsync'),
    makeDirectoryAsync: () => dead('makeDirectoryAsync'),
    createDownloadResumable: () => {
      throw new Error('Method createDownloadResumable imported from "expo-file-system" is deprecated.');
    },
  };
});
jest.mock('expo-file-system/legacy', () => require('./seedImportWorld').fakeLegacyFs);
jest.mock('../db', () => require('./helpers/mockDbModule').asDbModule(require('./seedImportWorld').fakeDbModule));

import * as seed from '../../core/seedImport';
import { importSeedFromUrl } from '../../composition';

const URL = 'https://example.test/seed.db';
const DOC_SQLITE = DB_PATH.slice(0, DB_PATH.lastIndexOf('/') + 1);
const run = () => importSeedFromUrl(URL, () => {});
const dbAt = (path: string) => files.get(path) as FakeDb;

beforeEach(() => {
  resetWorld();
  files.set(DB_PATH, makeOldDb());
  state.seed = makeSeedDb();
});

describe('importSeedFromUrl keeps the user\'s data', () => {
  it('installs the seed AND carries over reads, bookmarks, annotations, prefs and progress', async () => {
    await run();

    const db = dbAt(DB_PATH);
    expect(db.label).toBe('seed'); // the seed really replaced the old file
    expect(db.reads.map(r => r.slug)).toEqual(['kant']);
    expect(db.bookmarks).toEqual([{ slug: 'kant', title: 'Kant', saved_at: 2, notes: 'my note' }]);
    expect(db.annotations.map(a => [a.id, a.note])).toEqual([[7, 'hi']]);
    expect(db.meta).toMatchObject({ pref_home: 'recent', font_size: '20', custom_css: 'p{}', sync_folder: 'file:///sync/' });
    expect(db.entries.kant).toBe(0.5);
  });

  it('keeps onboarding_done, which the export format leaves out, so the user is not sent through onboarding again', async () => {
    await run();
    expect(dbAt(DB_PATH).meta.onboarding_done).toBe('1');
  });

  it('keeps annotations.content_hash, which importUserData does not write', async () => {
    await run();
    expect(dbAt(DB_PATH).annotations[0].content_hash).toBe('abc');
  });

  it('restores read progress only for entries that exist in the seed', async () => {
    await run();
    const db = dbAt(DB_PATH);
    expect(db.entries).toEqual({ kant: 0.5, plato: 0 }); // hume/gone are not in the seed: not invented
  });

  it('does NOT restore cache or migration state over the seed\'s own', async () => {
    await run();
    const db = dbAt(DB_PATH);
    expect(db.meta.link_index_json).toBe('SEED-LINKS');
    expect(db.meta.ast_parser_version).toBe('2');
    expect(db.meta.index_refreshed_at).toBeUndefined();
    expect(db.meta.last_deep_sync).toBeUndefined();
  });

  it('removes stale -wal/-shm files of the old database so they are not replayed onto the new one', async () => {
    files.set(`${DB_PATH}-wal`, { label: 'old-wal', bytes: 4096 });
    files.set(`${DB_PATH}-shm`, { label: 'old-shm', bytes: 32768 });
    await run();
    expect(files.has(`${DB_PATH}-wal`)).toBe(false);
    expect(files.has(`${DB_PATH}-shm`)).toBe(false);
  });

  it('leaves only the database behind on success (no backup, no temp download)', async () => {
    await run();
    expect([...files.keys()]).toEqual([DB_PATH]);
  });

  it('works on a first run with an empty database', async () => {
    files.set(DB_PATH, { ...makeOldDb(), reads: [], bookmarks: [], annotations: [], meta: {}, entries: {} });
    await run();
    expect(dbAt(DB_PATH).label).toBe('seed');
  });
});

describe('importSeedFromUrl when something goes wrong', () => {
  const expectOldDbIntact = () => {
    const db = dbAt(DB_PATH);
    expect(db.label).toBe('old');
    expect(db.bookmarks).toHaveLength(1);
    expect(db.annotations).toHaveLength(1);
    expect(db.meta.link_index_json).toBe('OLD-LINKS');
    expect([...files.keys()]).toEqual([DB_PATH]); // no backup or download left over
  };

  it('restoring the user data fails: the old database comes back and the backup is removed', async () => {
    state.failImport = true;
    await expect(run()).rejects.toThrow('restore failed');
    expectOldDbIntact();
  });

  it('the seed file cannot be opened as a database: the old database comes back', async () => {
    state.seed = { ...makeSeedDb(), invalid: true };
    await expect(run()).rejects.toThrow();
    expectOldDbIntact();
  });

  it('moving the seed into place fails: the old database comes back', async () => {
    state.failMoveInto = DB_PATH;
    await expect(run()).rejects.toThrow('disk full');
    expectOldDbIntact();
  });

  it('the download fails: nothing is touched', async () => {
    state.downloadStatus = 404;
    await expect(run()).rejects.toThrow('HTTP 404');
    expectOldDbIntact();
    expect(state.log).not.toContain('closeDb');
  });

  it('the download is too small to be a database: nothing is touched', async () => {
    state.seed = { label: 'tiny', bytes: 10 };
    await expect(run()).rejects.toThrow('too small');
    expectOldDbIntact();
    expect(state.log).not.toContain('closeDb');
  });

  it('does not delete the backup before the user data is restored', async () => {
    await run();
    const order = state.log.filter(l => l.startsWith('copy') || l === 'importUserData' || l.includes('delete') );
    const copyAt = order.findIndex(l => l.startsWith('copy'));
    const restoreAt = order.indexOf('importUserData');
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeGreaterThan(copyAt);
    // the only delete of the backup comes after the restore
    const backupDeletes = order
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('delete') && /backup/i.test(l));
    for (const { i } of backupDeletes) expect(i).toBeGreaterThan(restoreAt);
  });

  it('a backup left by an earlier interrupted import is set aside, never silently deleted', async () => {
    files.set(`${DOC_SQLITE}sep.db.pre-seed-backup`, { ...makeOldDb(), label: 'interrupted-old' });
    await run();
    const survivors = [...files.entries()].filter(([p, f]) => p !== DB_PATH && (f as any).label === 'interrupted-old');
    expect(survivors).toHaveLength(1);
  });
});

describe('importSeedFromUrl: order and phases', () => {
  it('snapshots, closes, backs up, replaces, restores, and only then drops the backup', async () => {
    await run();
    const at = (pred: (l: string) => boolean) => state.log.findIndex(pred);
    const exp = at(l => l === 'exportUserData');
    const close = at(l => l === 'closeDb');
    const copy = at(l => l.startsWith('copy'));
    const swap = at(l => l.startsWith('move') && l.endsWith(`-> ${DB_PATH}`));
    const restore = at(l => l === 'importUserData');
    const dropBackup = at(l => l.startsWith('delete') && l.includes('pre-seed-backup'));
    expect([exp, close, copy, swap, restore, dropBackup].every(i => i >= 0)).toBe(true);
    expect([exp, close, copy, swap, restore, dropBackup]).toEqual([exp, close, copy, swap, restore, dropBackup].slice().sort((a, b) => a - b));
  });

  it('reports downloading (with progress), then validating, then installing', async () => {
    const seen: any[] = [];
    await importSeedFromUrl(URL, p => seen.push(p));
    expect(seen).toEqual([
      { phase: 'downloading', bytesWritten: 40, bytesTotal: 100 },
      { phase: 'downloading', bytesWritten: 100, bytesTotal: 100 },
      { phase: 'validating' },
      { phase: 'installing' },
    ]);
  });
});

describe('importSeedFromUrl: more failure paths leave the old database intact', () => {
  const intact = () => {
    expect(dbAt(DB_PATH).label).toBe('old');
    expect(dbAt(DB_PATH).bookmarks).toHaveLength(1);
    expect([...files.keys()]).toEqual([DB_PATH]);
  };
  it('the download throws: nothing is touched', async () => {
    state.failDownload = true;
    await expect(run()).rejects.toThrow('network down');
    intact();
    expect(state.log).not.toContain('closeDb');
  });
  it('the snapshot cannot be read: nothing is touched', async () => {
    state.failExport = true;
    await expect(run()).rejects.toThrow('export failed');
    intact();
    expect(state.log).not.toContain('closeDb');
    expect(state.log.some(l => l.startsWith('copy'))).toBe(false);
  });
  it('closing the connection fails: the file is not touched', async () => {
    state.failClose = true;
    await expect(run()).rejects.toThrow('close failed');
    intact();
    expect(state.log.some(l => l.startsWith('copy'))).toBe(false);
  });
  it('the backup copy fails: the old database stays', async () => {
    state.failCopy = true;
    await expect(run()).rejects.toThrow('copy failed');
    expect(dbAt(DB_PATH).label).toBe('old');
  });
  it('rollback itself fails: the error says where the backup is kept, and the backup is not deleted', async () => {
    state.failImport = true;
    state.failMoveFromBackup = true;
    await expect(run()).rejects.toThrow(/restore failed.*could not be put back.*pre-seed-backup/);
    expect([...files.keys()].some(k => k.includes('pre-seed-backup'))).toBe(true);
  });
});

describe('the SDK 54 file API', () => {
  it('seedImport.ts takes its file functions from expo-file-system/legacy, not the throwing main entry', () => {
    const src = readFileSync(join(__dirname, '..', 'seedImport.ts'), 'utf8');
    expect(src).not.toMatch(/from 'expo-file-system'/);
    expect(src).toMatch(/from 'expo-file-system\/legacy'/);
  });
});

// A new `meta` key is user data or cache. If it is neither listed nor classified,
// a seed import would silently lose it (or clobber the seed with stale state).
describe('meta key classification', () => {
  function metaKeysUsedInSource(): string[] {
    const root = join(__dirname, '..', '..', '..');
    const out = new Set<string>();
    const scan = (text: string) => {
      for (const m of text.matchAll(/\b(?:getMeta|setMeta)\(\s*'([a-z0-9_]+)'/g)) out.add(m[1]);
      for (const m of text.matchAll(/INTO meta[^)]*\)\s*VALUES\s*\(\s*'([a-z0-9_]+)'/g)) out.add(m[1]);
    };
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          scan(readFileSync(p, 'utf8'));
        }
      }
    };
    walk(join(root, 'src'));
    scan(readFileSync(join(root, 'App.tsx'), 'utf8'));
    return [...out].filter(k => !k.startsWith('_test'));
  }

  it('every meta key in the source is classified as preserved or cache-owned', () => {
    const classified = (k: string) =>
      seed.PRESERVED_META_KEYS.has(k) ||
      seed.PRESERVED_META_PREFIXES.some(p => k.startsWith(p)) ||
      seed.CACHE_META_KEYS.has(k);
    const unclassified = metaKeysUsedInSource().filter(k => !classified(k));
    expect(unclassified).toEqual([]);
  });
});
