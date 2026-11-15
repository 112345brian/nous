// graphDb owns the InPhO tables inside the shared sep.db and versions them
// under its own scope. Through the GraphStore port: indexCount() needs the
// schema, so calling it exercises the lazy setup.


export {};

jest.mock('expo-sqlite', () => require('./helpers/fakeExpoSqlite').module);

let fake: any;
let db: any;
let graph: any;

beforeEach(() => {
  jest.resetModules();
  fake = require('./helpers/fakeExpoSqlite');
  fake.reset();
  db = require('./helpers/testDb').loadDb();
  const store = require('../graphDb').createGraphStore(db.getDb, require('../../core/migrations'));
  graph = { inphoIndexCount: () => store.indexCount() };
});

const tables = (r: any): string[] =>
  r.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x: any) => x.name);
const columns = (r: any, t: string): string[] =>
  r.prepare(`PRAGMA table_info(${t})`).all().map((x: any) => x.name);
const graphVersion = (r: any): number | undefined =>
  r.prepare("SELECT version FROM schema_versions WHERE scope = 'graph'").get()?.version;

describe('graph schema', () => {
  it('is created on first use and recorded under its own scope', async () => {
    await db.getDb();
    expect(tables(fake.raw())).not.toContain('inpho_nodes'); // optional: core does not create it

    await expect(graph.inphoIndexCount()).resolves.toBe(0);
    const r = fake.raw();
    expect(tables(r)).toEqual(expect.arrayContaining(['inpho_nodes', 'inpho_relations', 'graph_layout_cache']));
    expect(columns(r, 'inpho_nodes')).toEqual(expect.arrayContaining(['birth_year', 'death_year', 'dates_checked']));
    expect(graphVersion(r)).toBe(1);
  });

  it('does not run schema SQL again once recorded', async () => {
    await graph.inphoIndexCount();
    await db.closeDb(); // a new handle re-checks the recorded version, nothing more
    const seen: string[] = [];
    fake.state.failSql = (sql: string) => { seen.push(sql); return null; };
    await graph.inphoIndexCount();
    expect(seen.filter(s => /CREATE (TABLE|INDEX)|ALTER TABLE/i.test(s) && !/schema_versions/.test(s))).toEqual([]);
  });

  it('(bug) is set up again on a reopened connection after the file was replaced', async () => {
    await graph.inphoIndexCount();
    await db.closeDb();
    fake.dropDatabase(); // e.g. a seed import swapped in a different sep.db

    await expect(graph.inphoIndexCount()).resolves.toBe(0);
    expect(tables(fake.raw())).toContain('inpho_nodes');
  });

  it('does not cache a failed setup: it is rolled back and retried', async () => {
    let n = 0;
    fake.state.failSql = (sql: string) =>
      (sql.includes('CREATE TABLE inpho_nodes') && n++ === 0 ? new Error('boom') : null);
    await expect(graph.inphoIndexCount()).rejects.toThrow(/boom/);
    expect(tables(fake.raw())).not.toContain('inpho_nodes');
    expect(graphVersion(fake.raw())).toBeUndefined();

    await expect(graph.inphoIndexCount()).resolves.toBe(0);
    expect(graphVersion(fake.raw())).toBe(1);
  });

  it('shares one setup between concurrent first calls', async () => {
    const counts = await Promise.all([graph.inphoIndexCount(), graph.inphoIndexCount(), graph.inphoIndexCount()]);
    expect(counts).toEqual([0, 0, 0]);
    expect(graphVersion(fake.raw())).toBe(1);
  });
});
