// services/db is an injected instance: no module-level connection or cache is shared between two
// instances, and the adapter takes every platform piece (clock, uid, secrets, bundled link map,
// the migration runner) as a dependency.
export {};

jest.mock('expo-sqlite', () => require('./helpers/fakeExpoSqlite').module);

let fake: any;
beforeEach(() => { jest.resetModules(); fake = require('./helpers/fakeExpoSqlite'); fake.reset(); });

describe('createDb', () => {
  it('keeps the connection and the meta cache per instance', async () => {
    const { loadDb } = require('./helpers/testDb');
    const a = loadDb();
    const b = loadDb();
    await a.setMeta('k', 'from-a');
    // b has its own cache, so it reads the database, not a's memory (same underlying file here).
    expect(await b.getMeta('k')).toBe('from-a');
    fake.raw().exec(`UPDATE meta SET value = 'changed' WHERE key = 'k'`);
    expect(await a.getMeta('k')).toBe('from-a');   // a still serves its cache
    expect(await b.getMeta('k')).toBe('from-a');   // b cached its first read too
    const c = loadDb();
    expect(await c.getMeta('k')).toBe('changed');  // a new instance starts cold
  });

  it('uses the injected clock, uid source and bundled link map, not globals', async () => {
    const { loadDb } = require('./helpers/testDb');
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now used'); });
    const rnd = jest.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used'); });
    try {
      const db = loadDb({ clock: { now: () => 42 }, newUid: () => 'uid-1', loadBundledLinkMap: async () => '{"bundled":1}' });
      const ann = await db.saveAnnotation('kant', 'text', null, 'yellow');
      expect(ann).toMatchObject({ uid: 'uid-1', created_at: 42, updated_at: 42 });
      expect(await db.getLinkPayload()).toBe('{"bundled":1}');
    } finally { spy.mockRestore(); rnd.mockRestore(); }
  });

  it('runs the injected migrate on open, and a failed one is retried by the next getDb', async () => {
    const { loadDb } = require('./helpers/testDb');
    let calls = 0;
    const db = loadDb({ migrate: async (h: any) => { if (++calls === 1) throw new Error('boom'); await h.execAsync('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)'); } });
    await expect(db.getDb()).rejects.toThrow('boom');
    await expect(db.getDb()).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });
});
