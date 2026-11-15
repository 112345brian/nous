// The seed-import use case run with in-memory fakes: no jest.mock, no expo. The fake keeps a
// database's CONTENT inside its FILE (as the real app does), so replacing or restoring the file
// replaces or restores the user's data. Date.now and fetch throw, so the core cannot reach them.
import { importSeed, type SeedImportDeps, type SeedPhase } from '../seedImport';
import type { SeedDatabase, SeedFiles, SeedUserDataShape } from '../ports';

interface Db {
  label: string;
  bytes: number;
  invalid?: boolean;
  bookmarks: string[];
  annotations: Array<{ id: number; content_hash: string | null }>;
  meta: Record<string, string>;
  progress: Record<string, number>;
}
type Snap = SeedUserDataShape & { bookmarks: string[] };

const mkDb = (label: string, extra: Partial<Db> = {}): Db =>
  ({ label, bytes: 100_000, bookmarks: [], annotations: [], meta: {}, progress: {}, ...extra });
const oldDb = () => mkDb('old', {
  bookmarks: ['kant'],
  annotations: [{ id: 7, content_hash: 'abc' }],
  meta: { onboarding_done: '1', font_size: '20', pref_home: 'recent', link_index_json: 'OLD' },
  progress: { kant: 0.5, gone: 1 },
});
const seedDb = () => mkDb('seed', { meta: { link_index_json: 'SEED' }, progress: { kant: 0, plato: 0 } });

function world(opts: { status?: number | null; seed?: Db | null } = {}) {
  const files = new Map<string, Db>([['db', oldDb()]]);
  const log: string[] = [];
  const fail = new Set<string>();
  const maybe = (op: string) => { if (fail.has(op)) { fail.delete(op); throw new Error(`${op} failed`); } };
  const seed = opts.seed === undefined ? seedDb() : opts.seed;
  const open = () => {
    const f = files.get('db');
    if (!f || f.invalid) throw new Error('not a database');
    return f;
  };

  const sf: SeedFiles = {
    backupLocation: 'BACKUP',
    async download(_url, cb) {
      log.push('download');
      maybe('download');
      cb(40, 100); cb(100, 100);
      const status = opts.status === undefined ? 200 : opts.status;
      if (status && status < 300 && seed) files.set('tmp', JSON.parse(JSON.stringify(seed)));
      return { status };
    },
    async downloadedSize() { return files.get('tmp')?.bytes ?? null; },
    async discardDownload() { log.push('discardDownload'); files.delete('tmp'); },
    async prepareDbDir() {},
    async hasDb(s) { return files.has(`db${s}`); },
    async hasBackup(s) { return files.has(`bak${s}`); },
    async backUpDb(s) { log.push('backUp'); maybe('backUp'); files.set(`bak${s}`, JSON.parse(JSON.stringify(files.get(`db${s}`)))); },
    async removeDb(s) { log.push('removeDb'); files.delete(`db${s}`); },
    async restoreBackup(s) { log.push('restoreBackup'); maybe('restoreBackup'); files.set(`db${s}`, files.get(`bak${s}`)!); files.delete(`bak${s}`); },
    async setAsideBackup(s, tag) { log.push(`setAside ${tag}`); files.set(`bak.${tag}${s}`, files.get(`bak${s}`)!); files.delete(`bak${s}`); },
    async removeBackup(s) { log.push('removeBackup'); files.delete(`bak${s}`); },
    async installDownload() { log.push('install'); maybe('install'); files.set('db', files.get('tmp')!); files.delete('tmp'); },
  };
  const db: SeedDatabase = {
    async close() { log.push('close'); maybe('close'); },
    async listMeta() { return Object.entries(open().meta).map(([key, value]) => ({ key, value })); },
    async listReadProgress() { return Object.entries(open().progress).filter(([, p]) => p > 0).map(([slug, read_progress]) => ({ slug, read_progress })); },
    async restoreDerived({ annotationHashes, readProgress }) {
      log.push('restoreDerived');
      const d = open();
      for (const h of annotationHashes) { const a = d.annotations.find(x => x.id === h.id); if (a) a.content_hash = h.content_hash; }
      for (const p of readProgress) if (p.slug in d.progress) d.progress[p.slug] = p.read_progress;
    },
  };
  const deps: SeedImportDeps<Snap> = {
    files: sf,
    db,
    userData: {
      async exportUserData() {
        log.push('export'); maybe('export');
        const d = open();
        return { version: 1, bookmarks: [...d.bookmarks], annotations: d.annotations.map(a => ({ ...a })), prefs: { ...d.meta } };
      },
      async importUserData(data) {
        log.push('import'); maybe('import');
        const d = open();
        d.bookmarks.push(...data.bookmarks);
        d.annotations.push(...data.annotations.map(a => ({ id: a.id, content_hash: null })));
      },
    },
    meta: { async setMeta(k, v) { open().meta[k] = v; } },
    clock: { now: () => 1234 },
  };
  return { files, log, fail, deps };
}

const run = (w: ReturnType<typeof world>, phases: SeedPhase[] = []) => importSeed(w.deps, 'https://x/seed.db', p => phases.push(p));

const realFetch = (globalThis as any).fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation(() => { throw new Error('core set a timer'); });
  (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

describe('a successful import', () => {
  test('installs the seed and carries over user data, preserved prefs, hashes and progress', async () => {
    const w = world();
    await run(w);
    const d = w.files.get('db')!;
    expect(d.label).toBe('seed');
    expect(d.bookmarks).toEqual(['kant']);
    expect(d.annotations).toEqual([{ id: 7, content_hash: 'abc' }]);
    expect(d.meta).toEqual({ onboarding_done: '1', font_size: '20', pref_home: 'recent', link_index_json: 'SEED' });
    expect(d.progress).toEqual({ kant: 0.5, plato: 0 });
    expect([...w.files.keys()]).toEqual(['db']);
  });

  test('phases: downloading with progress, validating, installing', async () => {
    const phases: SeedPhase[] = [];
    await run(world(), phases);
    expect(phases).toEqual([
      { phase: 'downloading', bytesWritten: 40, bytesTotal: 100 },
      { phase: 'downloading', bytesWritten: 100, bytesTotal: 100 },
      { phase: 'validating' },
      { phase: 'installing' },
    ]);
  });

  test('order: export, close, back up, remove, install, import, restoreDerived, drop backup', async () => {
    const w = world();
    await run(w);
    const order = ['export', 'close', 'backUp', 'removeDb', 'install', 'import', 'restoreDerived', 'removeBackup'];
    const at = order.map(o => w.log.indexOf(o));
    expect(at.every(i => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  test('a leftover backup is set aside with a tag from the injected clock, never deleted', async () => {
    const w = world();
    w.files.set('bak', mkDb('interrupted'));
    await run(w);
    expect(w.files.get('bak.interrupted-1234')!.label).toBe('interrupted');
  });
});

describe('failures leave the user data intact', () => {
  const intact = (w: ReturnType<typeof world>) => {
    const d = w.files.get('db')!;
    expect(d.label).toBe('old');
    expect(d.bookmarks).toEqual(['kant']);
    expect(d.meta.link_index_json).toBe('OLD');
    expect([...w.files.keys()]).toEqual(['db']);
  };

  test.each([
    ['import', 'import failed'],
    ['install', 'install failed'],
    ['backUp', 'backUp failed'],
  ])('%s fails: old database comes back, backup and download removed', async (op, msg) => {
    const w = world();
    w.fail.add(op);
    await expect(run(w)).rejects.toThrow(msg);
    intact(w);
  });

  test('the new file is not a database: rolled back', async () => {
    const w = world({ seed: { ...seedDb(), invalid: true } });
    await expect(run(w)).rejects.toThrow('not a database');
    intact(w);
  });

  test.each([['download', 'download failed'], ['export', 'export failed'], ['close', 'close failed']])(
    '%s fails before the file is touched', async (op, msg) => {
      const w = world();
      w.fail.add(op);
      await expect(run(w)).rejects.toThrow(msg);
      intact(w);
      expect(w.log).not.toContain('removeDb');
    });

  test('HTTP error, no response, and a too-small file touch nothing', async () => {
    for (const [status, msg] of [[404, 'HTTP 404'], [null, 'HTTP unknown']] as const) {
      const w = world({ status });
      await expect(run(w)).rejects.toThrow(msg);
      intact(w);
      expect(w.log).not.toContain('close');
    }
    const w = world({ seed: mkDb('tiny', { bytes: 10 }) });
    await expect(run(w)).rejects.toThrow('too small');
    intact(w);
    expect(w.log).not.toContain('close');
  });

  test('when even the rollback fails, the error names the backup and the backup stays', async () => {
    const w = world();
    w.fail.add('import');
    w.fail.add('restoreBackup');
    await expect(run(w)).rejects.toThrow(/import failed.*could not be put back.*BACKUP/);
    expect(w.files.has('bak')).toBe(true);
  });

  test('the backup is not dropped before the restore has succeeded', async () => {
    const w = world();
    w.fail.add('import');
    await expect(run(w)).rejects.toThrow();
    expect(w.log.indexOf('removeBackup')).toBe(-1);
  });
});
