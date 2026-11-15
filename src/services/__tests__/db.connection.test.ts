// Connection lifecycle + schema migration behaviour of services/db.ts.
//
// Runs against real SQLite (node:sqlite, FTS5 included) through a fake
// `expo-sqlite`, so the migrations are exercised for real. Tests marked
// "(bug)" describe behaviour the original implementation got wrong.


export {};

declare const __dirname: string;

jest.mock('expo-sqlite', () => require('./helpers/fakeExpoSqlite').module);

let fake: any;
let db: any;

beforeEach(() => {
  jest.resetModules();
  fake = require('./helpers/fakeExpoSqlite');
  fake.reset();
  db = require('./helpers/testDb').loadDb();
});

const tables = (r: any): string[] =>
  r.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x: any) => x.name);
const columns = (r: any, t: string): string[] =>
  r.prepare(`PRAGMA table_info(${t})`).all().map((x: any) => x.name);
const userVersion = (r: any): number => Number(r.prepare('PRAGMA user_version').get().user_version);
const meta = (r: any, key: string): string | undefined =>
  r.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;

describe('fresh install', () => {
  it('creates every table and column the app reads', async () => {
    await db.getDb();
    const r = fake.raw();
    for (const t of ['entries', 'reads', 'meta', 'bookmarks', 'links', 'article_versions', 'annotations', 'math', 'entries_fts']) {
      expect(tables(r)).toContain(t);
    }
    expect(columns(r, 'entries')).toEqual(expect.arrayContaining([
      'slug', 'title', 'parent_label', 'source', 'author', 'pub_date', 'content_hash', 'toc_html',
      'preamble_html', 'content_html', 'notes_html', 'content_ast', 'has_math', 'word_count',
      'read_progress', 'excerpt', 'cached_at',
    ]));
    expect(columns(r, 'bookmarks')).toContain('notes');
    expect(columns(r, 'annotations')).toContain('content_hash');
  });

  it('uses WAL, a standalone porter FTS index, and records the parser version', async () => {
    await db.getDb();
    const r = fake.raw();
    const fts = r.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_fts'").get().sql as string;
    expect(fts).toMatch(/fts5/i);
    expect(fts).not.toContain("content='entries'");
    expect(meta(r, 'ast_parser_version')).toBe('2');
  });

  it('stamps PRAGMA user_version with the latest core schema version', async () => {
    const { LATEST_CORE_SCHEMA_VERSION } = require('../coreMigrations');
    await db.getDb();
    expect(LATEST_CORE_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(userVersion(fake.raw())).toBe(LATEST_CORE_SCHEMA_VERSION);
  });
});

describe('later schema steps', () => {
  it('applies a step appended after version 1 to a database already at version 1', async () => {
    const { runMigrations, userVersionStore } = require('../../core/migrations');
    const { CORE_MIGRATIONS } = require('../coreMigrations');
    await db.getDb();
    await db.closeDb();
    const v2 = {
      version: CORE_MIGRATIONS.length + 1,
      name: 'test step',
      async up(d: any) { await d.execAsync('ALTER TABLE entries ADD COLUMN extra TEXT'); },
    };
    const handle = await fake.module.openDatabaseAsync('sep.db');
    await expect(runMigrations(handle, [...CORE_MIGRATIONS, v2], userVersionStore)).resolves.toBe(v2.version);
    expect(columns(fake.raw(), 'entries')).toContain('extra');
    expect(userVersion(fake.raw())).toBe(v2.version);
  });

  it('leaves a database from a newer app version alone', async () => {
    await db.getDb();
    await db.closeDb();
    fake.raw().exec('PRAGMA user_version = 999');
    await db.getDb();
    expect(userVersion(fake.raw())).toBe(999);
  });
});

describe('reopening', () => {
  it('does not lose data', async () => {
    await db.getDb();
    const r = fake.raw();
    r.exec(`INSERT INTO entries (slug, title, content_html, content_ast, cached_at) VALUES ('x', 'X', '<p>kept</p>', '{}', 1)`);
    await db.closeDb();
    await db.getDb();
    const row = r.prepare('SELECT content_html, content_ast, cached_at FROM entries WHERE slug = ?').get('x');
    expect(row).toEqual({ content_html: '<p>kept</p>', content_ast: '{}', cached_at: 1 });
  });

  it('does not run schema SQL again once user_version is current', async () => {
    await db.getDb();
    await db.closeDb();
    const seen: string[] = [];
    fake.state.failSql = (sql: string) => { seen.push(sql); return null; };
    await db.getDb();
    expect(seen.filter(s => /CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE VIRTUAL/i.test(s))).toEqual([]);
  });
});

describe('migration failures', () => {
  it('propagates a failing step instead of swallowing it, and retries cleanly', async () => {
    fake.state.failSql = (sql: string) => (/CREATE INDEX idx_reads_slug/.test(sql) ? new Error('database or disk is full') : null);
    await expect(db.getDb()).rejects.toThrow('disk is full');
    expect(userVersion(fake.raw())).toBe(0);
    // The whole step rolled back, including the tables it had already created.
    expect(tables(fake.raw())).not.toContain('meta');
    expect(tables(fake.raw())).not.toContain('entries');

    fake.state.failSql = null;
    await db.getDb();
    expect(userVersion(fake.raw())).toBe(1);
  });

  it('(bug) a failed initialisation is not cached as an open, half-built database', async () => {
    let n = 0;
    fake.state.failSql = (sql: string) =>
      (sql.includes('CREATE TABLE entries') && n++ === 0 ? new Error('boom') : null);
    await expect(db.getDb()).rejects.toThrow('boom');
    const handle = await db.getDb();
    expect(handle).toBeDefined();
    expect(tables(fake.raw())).toContain('entries');
    expect(tables(fake.raw())).toContain('entries_fts');
  });

  it('retries after the database fails to open', async () => {
    fake.state.failOpen = new Error('cannot open');
    await expect(db.getDb()).rejects.toThrow('cannot open');
    await expect(db.getDb()).resolves.toBeDefined();
  });
});

describe('connection lifecycle', () => {
  it('(bug) concurrent first callers share one connection', async () => {
    const [a, b, c] = await Promise.all([db.getDb(), db.getDb(), db.getDb()]);
    expect(fake.state.openCalls).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('(bug) a caller arriving during schema setup waits for it to finish', async () => {
    fake.state.opGate = fake.makeGate();
    const first = db.getDb();
    await fake.tick(5); // the file is open; the first schema statement is parked on the gate
    const late = db.getDb();
    expect(await fake.settledState(late)).toBe('pending');

    fake.state.opGate.release();
    const [a, b] = await Promise.all([first, late]);
    expect(b).toBe(a);
    expect(tables(fake.raw())).toContain('entries');
  });

  it('(bug) closeDb waits for an in-flight open, closes it, and the next getDb reopens', async () => {
    fake.state.openGate = fake.makeGate();
    const opening = db.getDb();
    const closing = db.closeDb();
    fake.state.openGate.release();
    await Promise.all([opening, closing]);
    expect(fake.state.handles[0].closed).toBe(true);

    const fresh = await db.getDb();
    expect(fake.state.openCalls).toBe(2);
    expect(fresh).not.toBe(fake.state.handles[0]);
    expect(fresh.closed).toBe(false);
  });

  it('(bug) getDb during a close waits for the next open instead of returning the closing handle', async () => {
    const first = await db.getDb();
    fake.state.closeGate = fake.makeGate();
    const closing = db.closeDb();
    await fake.tick(5);
    const reopening = db.getDb();
    expect(await fake.settledState(reopening)).toBe('pending');

    fake.state.closeGate.release();
    const second = await reopening;
    await closing;
    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
    await expect(second.getFirstAsync('SELECT 1 AS one')).resolves.toEqual({ one: 1 });
  });

  it('closeDb with nothing open is a no-op, and is safe to call twice', async () => {
    await expect(db.closeDb()).resolves.toBeUndefined();
    await db.getDb();
    await Promise.all([db.closeDb(), db.closeDb()]);
    expect(fake.state.handles[0].closed).toBe(true);
  });
});

describe('structural guards', () => {
  const fs = require('fs');
  const path = require('path');
  const srcRoot = path.join(__dirname, '..', '..');

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        if (name !== '__tests__') sourceFiles(p, out);
      } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('only db.ts opens the database, so there is exactly one connection to guard', () => {
    const offenders = sourceFiles(srcRoot).filter(
      f => /openDatabase(Async|Sync)/.test(fs.readFileSync(f, 'utf8')) && path.basename(f) !== 'db.ts',
    );
    expect(offenders).toEqual([]);
  });

  it('no schema change swallows its errors', () => {
    const offenders = sourceFiles(srcRoot).filter(f =>
      /ALTER TABLE[^\n]*\n?[^\n]*\.catch\(\(\) => \{\}\)/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
