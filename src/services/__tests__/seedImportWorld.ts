// Test double for seedImport: an in-memory filesystem plus a fake `./db` module
// in which a database's CONTENT lives inside its FILE. That is the property the
// real app has (user data and cached articles share sep.db), so replacing or
// restoring the file replaces or restores the data.
//
// Limits, stated plainly: this exercises seedImport's orchestration (order of
// operations, backup, rollback, what is carried over). It does not run real
// SQLite, and `importUserData` here mirrors the real one's known gap (it does
// not write annotations.content_hash). If db.ts changes those, update this file.

export const DOC = 'file:///doc/';
export const CACHE = 'file:///cache/';
export const DB_PATH = `${DOC}SQLite/sep.db`;
export const TMP_PATH = `${CACHE}seed_import.db`;

export interface FakeDb {
  label: string;
  bytes: number;
  invalid?: boolean;
  reads: any[];
  bookmarks: any[];
  annotations: any[];
  meta: Record<string, string>;
  /** slug -> read_progress */
  entries: Record<string, number>;
}
export interface FakeBlob {
  label: string;
  bytes: number;
}
type FakeFile = FakeDb | FakeBlob;

export const files = new Map<string, FakeFile>();
export const state = {
  open: null as FakeDb | null,
  failImport: false,
  failMoveInto: null as string | null,
  downloadStatus: 200,
  seed: null as FakeFile | null,
  log: [] as string[],
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const isDb = (f: FakeFile | undefined): f is FakeDb => !!f && 'meta' in f;

export function resetWorld(): void {
  files.clear();
  state.open = null;
  state.failImport = false;
  state.failMoveInto = null;
  state.downloadStatus = 200;
  state.seed = null;
  state.log = [];
}

export function emptyDb(label: string): FakeDb {
  return { label, bytes: 100_000, reads: [], bookmarks: [], annotations: [], meta: {}, entries: {} };
}

// ── expo-file-system/legacy ──────────────────────────────────────────────────
export const fakeLegacyFs = {
  documentDirectory: DOC,
  cacheDirectory: CACHE,
  async deleteAsync(path: string) {
    state.log.push(`delete ${path}`);
    files.delete(path);
  },
  async makeDirectoryAsync() {},
  async getInfoAsync(path: string) {
    const f = files.get(path);
    return { exists: !!f, size: f?.bytes ?? 0, uri: path, isDirectory: false };
  },
  async moveAsync({ from, to }: { from: string; to: string }) {
    state.log.push(`move ${from} -> ${to}`);
    if (state.failMoveInto === to) {
      state.failMoveInto = null; // fail once; the rollback's own move must work
      throw new Error('disk full');
    }
    const f = files.get(from);
    if (!f) throw new Error(`move: no such file ${from}`);
    files.set(to, f);
    files.delete(from);
  },
  async copyAsync({ from, to }: { from: string; to: string }) {
    state.log.push(`copy ${from} -> ${to}`);
    const f = files.get(from);
    if (!f) throw new Error(`copy: no such file ${from}`);
    if (files.has(to)) throw new Error(`copy: destination exists ${to}`);
    files.set(to, clone(f));
  },
  createDownloadResumable(_url: string, to: string) {
    return {
      async downloadAsync() {
        if (state.downloadStatus >= 200 && state.downloadStatus < 300 && state.seed) {
          files.set(to, clone(state.seed));
        }
        return { status: state.downloadStatus, uri: to };
      },
    };
  },
};

// ── ./db ─────────────────────────────────────────────────────────────────────
function handleFor(db: FakeDb) {
  return {
    async getAllAsync(sql: string) {
      if (/FROM meta/i.test(sql)) {
        return Object.entries(db.meta).map(([key, value]) => ({ key, value }));
      }
      if (/FROM entries WHERE read_progress/i.test(sql)) {
        return Object.entries(db.entries)
          .filter(([, p]) => p > 0)
          .map(([slug, read_progress]) => ({ slug, read_progress }));
      }
      throw new Error(`fake db: unhandled SQL: ${sql}`);
    },
    async runAsync(sql: string, params: any[] = []) {
      if (/UPDATE entries SET read_progress/i.test(sql)) {
        const [p, slug] = params;
        if (slug in db.entries) db.entries[slug] = p;
        return { changes: 1, lastInsertRowId: 0 };
      }
      if (/UPDATE annotations SET content_hash/i.test(sql)) {
        const [hash, id] = params;
        const a = db.annotations.find(x => x.id === id);
        if (a) a.content_hash = hash;
        return { changes: a ? 1 : 0, lastInsertRowId: 0 };
      }
      throw new Error(`fake db: unhandled SQL: ${sql}`);
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      const before = clone(db);
      try {
        await fn();
      } catch (e) {
        Object.assign(db, before);
        throw e;
      }
    },
  };
}

async function openDb(): Promise<FakeDb> {
  let f = files.get(DB_PATH);
  if (!f) {
    f = emptyDb('fresh');
    files.set(DB_PATH, f);
  }
  if (!isDb(f) || f.invalid) throw new Error('file is not a database');
  state.open = f;
  return f;
}

export const fakeDbModule = {
  async getDb() {
    return handleFor(await openDb());
  },
  async closeDb() {
    state.log.push('closeDb');
    state.open = null;
  },
  async exportUserData() {
    const db = await openDb();
    const prefs: Record<string, string> = {};
    for (const [k, v] of Object.entries(db.meta)) if (k !== 'onboarding_done') prefs[k] = v;
    return { version: 1, exported_at: 0, reads: clone(db.reads), bookmarks: clone(db.bookmarks), annotations: clone(db.annotations), prefs };
  },
  async importUserData(data: any) {
    const db = await openDb();
    if (state.failImport) throw new Error('restore failed');
    state.log.push('importUserData');
    for (const r of data.reads) db.reads.push(clone(r));
    for (const b of data.bookmarks) db.bookmarks.push(clone(b));
    // Mirrors the real importUserData: annotations.content_hash is NOT written.
    for (const a of data.annotations) {
      const copy = clone(a);
      delete copy.content_hash;
      db.annotations.push(copy);
    }
    for (const [k, v] of Object.entries(data.prefs ?? {})) db.meta[k] = v as string;
  },
  async setMeta(key: string, value: string) {
    (await openDb()).meta[key] = value;
  },
};

// ── fixtures ─────────────────────────────────────────────────────────────────
export function makeOldDb(): FakeDb {
  return {
    label: 'old',
    bytes: 9_000_000,
    reads: [{ id: 1, slug: 'kant', title: 'Kant', visited_at: 1, from_slug: null, session_id: 's1' }],
    bookmarks: [{ slug: 'kant', title: 'Kant', saved_at: 2, notes: 'my note' }],
    annotations: [
      { id: 7, slug: 'kant', selected_text: 'x', context: null, note: 'hi', color: '#FFE566', content_hash: 'abc', created_at: 1, updated_at: 1 },
    ],
    meta: {
      onboarding_done: '1',
      pref_home: 'recent',
      font_size: '20',
      custom_css: 'p{}',
      sync_folder: 'file:///sync/',
      // Cache / migration state that belongs to the OLD database file:
      link_index_json: 'OLD-LINKS',
      ast_parser_version: '1',
      index_refreshed_at: '111',
      last_deep_sync: '5',
    },
    entries: { kant: 0.5, hume: 0.25, gone: 1 },
  };
}

export function makeSeedDb(): FakeDb {
  return {
    label: 'seed',
    bytes: 80_000,
    reads: [],
    bookmarks: [],
    annotations: [],
    meta: { ast_parser_version: '2', link_index_json: 'SEED-LINKS' },
    entries: { kant: 0, plato: 0 },
  };
}
