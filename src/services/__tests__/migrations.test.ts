// The versioned-migration runner (services/migrations.ts), against real SQLite.


export {};

jest.mock('expo-sqlite', () => require('./helpers/fakeExpoSqlite').module);

let fake: any;
let m: any;
let db: any;

beforeEach(async () => {
  jest.resetModules();
  fake = require('./helpers/fakeExpoSqlite');
  fake.reset();
  m = require('../migrations');
  db = await fake.module.openDatabaseAsync('test.db');
});

const userVersion = (): number => Number(fake.raw('test.db').prepare('PRAGMA user_version').get().user_version);
const tableNames = (): string[] =>
  fake.raw('test.db').prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x: any) => x.name);

function steps(log: string[], failAt?: number) {
  return [1, 2, 3].map(version => ({
    version,
    name: `step ${version}`,
    async up(d: any) {
      log.push(`up ${version}`);
      await d.execAsync(`CREATE TABLE t${version} (x INTEGER)`);
      if (version === failAt) throw new Error(`step ${version} exploded`);
    },
  }));
}

describe('runMigrations with PRAGMA user_version', () => {
  it('applies every step once, in order, and stamps the latest version', async () => {
    const log: string[] = [];
    await expect(m.runMigrations(db, steps(log), m.userVersionStore)).resolves.toBe(3);
    expect(log).toEqual(['up 1', 'up 2', 'up 3']);
    expect(userVersion()).toBe(3);
  });

  it('does nothing when the database is already current', async () => {
    const log: string[] = [];
    await m.runMigrations(db, steps(log), m.userVersionStore);
    log.length = 0;
    await expect(m.runMigrations(db, steps(log), m.userVersionStore)).resolves.toBe(3);
    expect(log).toEqual([]);
  });

  it('runs only the steps after the stored version', async () => {
    fake.raw('test.db').exec('PRAGMA user_version = 2');
    const log: string[] = [];
    await m.runMigrations(db, steps(log), m.userVersionStore);
    expect(log).toEqual(['up 3']);
    expect(userVersion()).toBe(3);
  });

  it('leaves a database written by a newer app untouched', async () => {
    fake.raw('test.db').exec('PRAGMA user_version = 9');
    const log: string[] = [];
    await expect(m.runMigrations(db, steps(log), m.userVersionStore)).resolves.toBe(9);
    expect(log).toEqual([]);
    expect(userVersion()).toBe(9);
  });

  it('rolls a failed step back completely, keeps earlier steps, and resumes there', async () => {
    const log: string[] = [];
    await expect(m.runMigrations(db, steps(log, 2), m.userVersionStore)).rejects.toThrow(
      /migration 2 \(step 2\) failed: step 2 exploded/,
    );
    expect(userVersion()).toBe(1);
    expect(tableNames()).toContain('t1');
    expect(tableNames()).not.toContain('t2'); // its own writes rolled back
    expect(tableNames()).not.toContain('t3'); // later steps never ran

    log.length = 0;
    await m.runMigrations(db, steps(log), m.userVersionStore);
    expect(log).toEqual(['up 2', 'up 3']);
    expect(userVersion()).toBe(3);
  });

  it('rejects a list with gaps, duplicates or the wrong start before running anything', async () => {
    const mk = (versions: number[]) =>
      versions.map(version => ({ version, name: `v${version}`, async up() { throw new Error('must not run'); } }));
    for (const bad of [[2, 3], [1, 3], [1, 1], [0, 1]]) {
      await expect(m.runMigrations(db, mk(bad), m.userVersionStore)).rejects.toThrow(/not contiguous/);
    }
    expect(userVersion()).toBe(0);
  });

  it('refuses to store a version that is not a non-negative integer', async () => {
    for (const bad of [NaN, -1, 1.5, Infinity]) {
      await expect(m.userVersionStore.set(db, bad)).rejects.toThrow(/Invalid schema version/);
      await expect(m.tableVersionStore('x').set(db, bad)).rejects.toThrow(/Invalid schema version/);
    }
    expect(userVersion()).toBe(0);
  });
});

describe('tableVersionStore', () => {
  it('keeps independent versions per scope without touching user_version', async () => {
    const log: string[] = [];
    await m.runMigrations(db, steps(log), m.tableVersionStore('a'));
    expect(await m.tableVersionStore('a').get(db)).toBe(3);
    expect(await m.tableVersionStore('b').get(db)).toBe(0);
    expect(userVersion()).toBe(0);
  });

  it('rolls the version back together with a failed step', async () => {
    await expect(m.runMigrations(db, steps([], 3), m.tableVersionStore('a'))).rejects.toThrow(/step 3 exploded/);
    expect(await m.tableVersionStore('a').get(db)).toBe(2);
  });
});

describe('addColumnIfMissing', () => {
  beforeEach(async () => {
    await db.execAsync('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)');
  });

  it('adds a missing column', async () => {
    await m.addColumnIfMissing(db, 'things', 'color TEXT');
    const cols = fake.raw('test.db').prepare('PRAGMA table_info(things)').all().map((c: any) => c.name);
    expect(cols).toContain('color');
  });

  it('ignores a column that already exists', async () => {
    await expect(m.addColumnIfMissing(db, 'things', 'name TEXT')).resolves.toBeUndefined();
  });

  it('does not ignore any other failure', async () => {
    await expect(m.addColumnIfMissing(db, 'no_such_table', 'x TEXT')).rejects.toThrow(/no such table/);
    fake.state.failSql = () => new Error('database or disk is full');
    await expect(m.addColumnIfMissing(db, 'things', 'y TEXT')).rejects.toThrow(/disk is full/);
  });

  it('recognises the duplicate-column error across realms and message wording', () => {
    expect(m.isDuplicateColumnError(new Error('duplicate column name: pub_date'))).toBe(true);
    expect(m.isDuplicateColumnError({ message: 'Duplicate Column Name: x' })).toBe(true);
    expect(m.isDuplicateColumnError(new Error('no such table: t'))).toBe(false);
    expect(m.isDuplicateColumnError('boom')).toBe(false);
    expect(m.isDuplicateColumnError(null)).toBe(false);
  });
});
