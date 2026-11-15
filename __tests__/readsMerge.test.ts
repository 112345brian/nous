// Reads import must be idempotent; run against a real SQLite (node:sqlite).
import {
  mergeRead, READS_DEDUPE_SQL, READS_UNIQUE_INDEX_SQL,
} from '../src/services/readsMerge';
import type { SqlRunner } from '../src/services/annotationMerge';

declare function require(m: string): any;
declare const __dirname: string;
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('fs');
const { join } = require('path');

// Same DDL as db.ts initSchema (no unique constraint: that is the old bug).
const DDL = `CREATE TABLE reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, title TEXT NOT NULL,
  visited_at INTEGER NOT NULL, from_slug TEXT, session_id TEXT NOT NULL);`;

function makeDb(withIndex = true) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(DDL);
  if (withIndex) raw.exec(READS_UNIQUE_INDEX_SQL);
  const db: SqlRunner & { raw: any; all(): any[] } = {
    raw,
    async runAsync(sql, p = []) { return raw.prepare(sql).run(...(p as any[])); },
    async getFirstAsync(sql, p = []) { return (raw.prepare(sql).get(...(p as any[])) as any) ?? null; },
    all: () => raw.prepare('SELECT * FROM reads ORDER BY id').all(),
  };
  return db;
}

const r = { slug: 'kant', title: 'Kant', visited_at: 1000, from_slug: null, session_id: 's1' };

describe('mergeRead', () => {
  test('importing the same file twice does not duplicate reads (the bug)', async () => {
    const db = makeDb();
    expect(await mergeRead(db, r)).toBe(true);
    expect(await mergeRead(db, r)).toBe(false);
    expect(db.all()).toHaveLength(1);
  });

  test('a local read and the same read from another device collapse to one row', async () => {
    const db = makeDb();
    await db.runAsync('INSERT OR IGNORE INTO reads (slug,title,visited_at,from_slug,session_id) VALUES (?,?,?,?,?)',
      ['kant', 'Kant', 1000, null, 's1']);
    await mergeRead(db, { ...r });
    expect(db.all()).toHaveLength(1);
  });

  test('distinct visits stay distinct (other time, other slug, other session)', async () => {
    const db = makeDb();
    await mergeRead(db, r);
    await mergeRead(db, { ...r, visited_at: 2000 });
    await mergeRead(db, { ...r, slug: 'hume' });
    await mergeRead(db, { ...r, session_id: 's2' });
    expect(db.all()).toHaveLength(4);
  });

  test('keeps from_slug and defaults a missing one to null', async () => {
    const db = makeDb();
    await mergeRead(db, { ...r, from_slug: 'hume' });
    await mergeRead(db, { slug: 'x', title: 'X', visited_at: 5, session_id: 's' });
    expect(db.all().map(x => x.from_slug)).toEqual(['hume', null]);
  });

  test.each([
    ['empty', {}],
    ['null', null],
    ['blank slug', { ...r, slug: '' }],
    ['non-numeric visited_at', { ...r, visited_at: 'x' }],
    ['missing session_id', { slug: 'a', title: 'A', visited_at: 1 }],
  ])('rejects %s without writing', async (_n, input) => {
    const db = makeDb();
    expect(await mergeRead(db, input as any)).toBe(false);
    expect(db.all()).toHaveLength(0);
  });

  test('missing title falls back to the slug', async () => {
    const db = makeDb();
    await mergeRead(db, { slug: 'a', visited_at: 1, session_id: 's' } as any);
    expect(db.all()[0].title).toBe('a');
  });
});

describe('migration for databases already polluted by the old import', () => {
  test('dedupe removes extra copies (keeping the oldest row), then the unique index can be built', () => {
    const db = makeDb(false);
    const ins = db.raw.prepare('INSERT INTO reads (slug,title,visited_at,from_slug,session_id) VALUES (?,?,?,?,?)');
    for (let i = 0; i < 3; i++) ins.run('kant', 'Kant', 1000, null, 's1'); // 3 copies
    ins.run('hume', 'Hume', 1000, null, 's1');
    expect(() => db.raw.exec(READS_UNIQUE_INDEX_SQL)).toThrow(); // fails until deduped
    db.raw.exec(READS_DEDUPE_SQL);
    db.raw.exec(READS_UNIQUE_INDEX_SQL);
    const rows = db.all();
    expect(rows).toHaveLength(2);
    expect(rows.find(x => x.slug === 'kant').id).toBe(1);
  });

  test('dedupe on a clean or empty table is a no-op', () => {
    const db = makeDb(false);
    db.raw.exec(READS_DEDUPE_SQL);
    expect(db.all()).toHaveLength(0);
  });
});

describe('db.ts wiring (source scan)', () => {
  const db = readFileSync(join(__dirname, '..', 'src/services/db.ts'), 'utf8') as string;
  test('importUserData merges reads via mergeRead', () => {
    expect(db).toMatch(/mergeRead\(/);
    // only recordRead may insert into reads directly; the import loop must not
    expect(db.match(/INSERT OR IGNORE INTO reads/g)).toHaveLength(1);
  });
  test('init dedupes then creates the unique index', () => {
    expect(db).toMatch(/READS_DEDUPE_SQL/);
    expect(db).toMatch(/READS_UNIQUE_INDEX_SQL/);
    expect(db.indexOf('READS_DEDUPE_SQL')).toBeLessThan(db.indexOf('READS_UNIQUE_INDEX_SQL'));
  });
  test('recordRead cannot throw on a duplicate key', () => {
    expect(db).toMatch(/INSERT OR IGNORE INTO reads \(slug, title, visited_at, from_slug, session_id\)\s+VALUES/);
  });
});
