// Cross-device annotation merge, run against a real SQLite (node:sqlite).
import { mergeAnnotation, type SqlRunner } from '../src/services/annotationMerge';

declare function require(m: string): any;
declare const __dirname: string;
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('fs');
const { join } = require('path');

function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, slug TEXT NOT NULL,
    selected_text TEXT NOT NULL, context TEXT, note TEXT,
    color TEXT NOT NULL DEFAULT '#FFE566', content_hash TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX idx_annotations_uid ON annotations(uid);`);
  const db: SqlRunner & { all(): any[] } = {
    async runAsync(sql, p = []) { return raw.prepare(sql).run(...(p as any[])); },
    async getFirstAsync(sql, p = []) { return (raw.prepare(sql).get(...(p as any[])) as any) ?? null; },
    all: () => raw.prepare('SELECT * FROM annotations ORDER BY id').all(),
  };
  return db;
}

const base = { slug: 'kant', selected_text: 'categorical imperative', created_at: 100, updated_at: 100 };

describe('mergeAnnotation', () => {
  test('keeps content_hash on insert (was dropped by the old import)', async () => {
    const db = makeDb();
    await mergeAnnotation(db, { ...base, uid: 'u1', color: '#fff', content_hash: 'h1' });
    expect(db.all()[0].content_hash).toBe('h1');
  });

  test('different annotations with the same local id on two devices do not overwrite each other', async () => {
    const db = makeDb();
    await mergeAnnotation(db, { ...base, uid: 'u1', color: '#fff' });
    // Device B's own annotation #1 (different uid, different text) arrives.
    await mergeAnnotation(db, { ...base, uid: 'u2', selected_text: 'other', color: '#000' });
    const rows = db.all();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.selected_text).sort()).toEqual(['categorical imperative', 'other']);
  });

  test('same uid: newer update wins and can clear a note', async () => {
    const db = makeDb();
    await mergeAnnotation(db, { ...base, uid: 'u1', color: '#fff', note: 'n' });
    await mergeAnnotation(db, { ...base, uid: 'u1', color: '#fff', note: null, updated_at: 200 });
    expect(db.all()[0].note).toBeNull();
  });

  test('same uid: older update is ignored', async () => {
    const db = makeDb();
    await mergeAnnotation(db, { ...base, uid: 'u1', color: '#fff', note: 'new', updated_at: 300 });
    expect(await mergeAnnotation(db, { ...base, uid: 'u1', color: '#000', note: 'old', updated_at: 200 })).toBe(false);
    expect(db.all()[0].note).toBe('new');
  });

  test('v1 file without uid: matches an existing row by slug+text+created_at, no duplicate', async () => {
    const db = makeDb();
    await mergeAnnotation(db, { ...base, uid: 'u1', color: '#fff' });
    await mergeAnnotation(db, { ...base, color: '#000', updated_at: 500 }); // no uid
    const rows = db.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].uid).toBe('u1');
    expect(rows[0].color).toBe('#000');
  });

  test('v1 file without uid and no match: inserts with a generated uid, ignoring any incoming id', async () => {
    const db = makeDb();
    await mergeAnnotation(db, { ...base, id: 7 } as any);
    const rows = db.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].uid).toMatch(/^[0-9a-f]{32}$/);
  });

  test('importing the same file twice is idempotent', async () => {
    const db = makeDb();
    const a = { ...base, uid: 'u1', color: '#fff', content_hash: 'h' };
    await mergeAnnotation(db, a);
    await mergeAnnotation(db, a);
    expect(db.all()).toHaveLength(1);
  });

  test.each([
    ['empty object', {}],
    ['blank text', { slug: 'a', selected_text: '' }],
    ['missing slug', { selected_text: 'x' }],
    ['null', null],
  ])('rejects %s without writing', async (_n, input) => {
    const db = makeDb();
    expect(await mergeAnnotation(db, input as any)).toBe(false);
    expect(db.all()).toHaveLength(0);
  });

  test('partial object gets defaults (color, timestamps)', async () => {
    const db = makeDb();
    await mergeAnnotation(db, { slug: 'a', selected_text: 'x' });
    const r = db.all()[0];
    expect(r.color).toBe('#FFE566');
    expect(r.created_at).toBe(r.updated_at);
  });
});

// db.ts must use the merge function, schema must have uid, and saveAnnotation must set it.
describe('db.ts wiring (source scan)', () => {
  const db = readFileSync(join(__dirname, '..', 'src/services/db.ts'), 'utf8') as string;
  test('importUserData merges annotations via mergeAnnotation, not an id upsert', () => {
    expect(db).toMatch(/mergeAnnotation\(/);
    expect(db).not.toMatch(/ON CONFLICT\(id\)/);
  });
  test('annotations table has a uid column, migration and unique index', () => {
    expect(db).toMatch(/uid\s+TEXT/);
    expect(db).toMatch(/ALTER TABLE annotations ADD COLUMN uid/);
    expect(db).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_uid/);
  });
  test('saveAnnotation writes a uid', () => {
    expect(db).toMatch(/INSERT INTO annotations \(uid,/);
  });
});
