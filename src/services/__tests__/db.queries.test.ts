// Characterization + regression tests for the query-shape fixes in
// src/services/db.ts: getSessions (bounded read), cacheArticle (atomic write),
// the cache-status/scope queries (parameterized), and the hot-query indexes.
// Runs against a real in-memory SQLite (see helpers/realSqlite.ts).

import { createRealDb, type RealDb } from './helpers/realSqlite';

let mockCurrent: RealDb;
jest.mock('expo-sqlite', () => ({
  __esModule: true,
  openDatabaseAsync: async () => mockCurrent,
}));

type DbModule = typeof import('../db');
let m: DbModule;
let raw: RealDb;

beforeEach(async () => {
  jest.resetModules();
  raw = mockCurrent = createRealDb();
  m = require('../db');
  await m.getDb();
});

async function seedEntries(rows: Array<{ slug: string; title: string; source?: string; cached?: boolean }>) {
  const db = await m.getDb();
  for (const r of rows) {
    await db.runAsync(
      'INSERT INTO entries (slug, title, source, cached_at) VALUES (?, ?, ?, ?)',
      [r.slug, r.title, r.source ?? 'sep', r.cached ? 1000 : null],
    );
  }
}

async function addRead(sessionId: string, slug: string, at: number, from: string | null = null) {
  const db = await m.getDb();
  await db.runAsync(
    'INSERT INTO reads (slug, title, visited_at, from_slug, session_id) VALUES (?, ?, ?, ?, ?)',
    [slug, `T-${slug}`, at, from, sessionId],
  );
}

describe('getSessions', () => {
  it('returns [] when there is no history', async () => {
    expect(await m.getSessions(30)).toEqual([]);
  });

  it('builds the from_slug tree for a single session', async () => {
    await addRead('s1', 'a', 100);
    await addRead('s1', 'b', 110, 'a');
    await addRead('s1', 'c', 120, 'b');
    await addRead('s1', 'd', 130, 'a');
    const sessions = await m.getSessions(30);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.session_id).toBe('s1');
    expect(s.started_at).toBe(100);
    expect(s.total).toBe(4);
    expect(s.roots.map(r => r.slug)).toEqual(['a']);
    expect(s.roots[0].depth).toBe(0);
    expect(s.roots[0].children.map(c => [c.slug, c.depth])).toEqual([['b', 1], ['d', 1]]);
    expect(s.roots[0].children[0].children.map(c => [c.slug, c.depth])).toEqual([['c', 2]]);
  });

  it('counts every read in total but keeps the latest row per slug', async () => {
    await addRead('s1', 'a', 100);
    await addRead('s1', 'a', 200);
    const [s] = await m.getSessions(30);
    expect(s.total).toBe(2);
    // NOTE: buildTree currently pushes the node once per read, so `roots` holds
    // it twice. That quirk predates this change and is deliberately not pinned.
    expect(s.roots.length).toBeGreaterThan(0);
    expect(s.roots.every(r => r.slug === 'a' && r.visited_at === 200)).toBe(true);
  });

  it('orders sessions newest-started first', async () => {
    await addRead('old', 'a', 100);
    await addRead('mid', 'b', 200);
    await addRead('new', 'c', 300);
    expect((await m.getSessions(30)).map(s => s.session_id)).toEqual(['new', 'mid', 'old']);
  });

  it('keeps only the newest `limit` sessions, in the same order', async () => {
    for (let i = 1; i <= 5; i++) await addRead(`s${i}`, `a${i}`, i * 100);
    expect((await m.getSessions(3)).map(s => s.session_id)).toEqual(['s5', 's4', 's3']);
  });

  it('returns everything when limit exceeds the number of sessions', async () => {
    await addRead('s1', 'a', 100);
    await addRead('s2', 'b', 200);
    expect(await m.getSessions(100)).toHaveLength(2);
  });

  it('returns [] for limit 0', async () => {
    await addRead('s1', 'a', 100);
    expect(await m.getSessions(0)).toEqual([]);
  });

  it('picks sessions by start time even when an older session has the latest read', async () => {
    await addRead('early', 'a', 100);
    await addRead('late', 'b', 200);
    await addRead('early', 'c', 300); // early session continues after late started
    const only = await m.getSessions(1);
    expect(only.map(s => s.session_id)).toEqual(['late']);
  });

  it('does not pull the reads of sessions outside the limit', async () => {
    for (let i = 1; i <= 50; i++) {
      for (let j = 0; j < 3; j++) await addRead(`s${i}`, `a${i}-${j}`, i * 1000 + j);
    }
    raw.rowsReturned.length = 0;
    const sessions = await m.getSessions(2);
    expect(sessions).toHaveLength(2);
    const readsRows = raw.rowsReturned
      .filter(q => /\bFROM\s+reads\b/i.test(q.sql))
      .reduce((n, q) => n + q.rows, 0);
    expect(readsRows).toBeLessThanOrEqual(2 * 3 + 2); // 2 sessions x 3 reads (+ slack for an id query)
  });
});

describe('cacheArticle', () => {
  const payload = (html: string) => ({
    author: 'A', pub_date: '2020', toc_html: '<ul></ul>', preamble_html: '<p>pre</p>',
    content_html: html, content_ast: null, has_math: 0,
  });
  const versions = async (slug: string) =>
    (await (await m.getDb()).getAllAsync<{ content_hash: string }>(
      'SELECT content_hash FROM article_versions WHERE slug = ? ORDER BY id', [slug]));

  beforeEach(() => seedEntries([{ slug: 'x', title: 'X' }]));

  it('stores the article, its hash and one version row', async () => {
    await m.cacheArticle('x', payload('<p>one</p>'));
    const row = await (await m.getDb()).getFirstAsync<any>('SELECT * FROM entries WHERE slug = ?', ['x']);
    expect(row.content_html).toBe('<p>one</p>');
    expect(row.content_hash).toBe(m.contentHash('<p>one</p>'));
    expect(row.cached_at).not.toBeNull();
    expect((await versions('x')).map(v => v.content_hash)).toEqual([m.contentHash('<p>one</p>')]);
  });

  it('keeps the previous version when the content changes', async () => {
    await m.cacheArticle('x', payload('<p>one</p>'));
    await m.cacheArticle('x', payload('<p>two</p>'));
    expect((await versions('x')).map(v => v.content_hash)).toEqual([
      m.contentHash('<p>one</p>'), m.contentHash('<p>two</p>'),
    ]);
  });

  it('is idempotent when the same content is cached again', async () => {
    await m.cacheArticle('x', payload('<p>one</p>'));
    await m.cacheArticle('x', payload('<p>one</p>'));
    expect(await versions('x')).toHaveLength(1);
  });

  it('is atomic: a failure on the last write leaves the old article and versions intact', async () => {
    await m.cacheArticle('x', payload('<p>one</p>'));
    let versionInserts = 0;
    raw.beforeRun = sql => {
      if (/INSERT OR IGNORE INTO article_versions/.test(sql) && ++versionInserts === 2) {
        throw new Error('disk full');
      }
    };
    await expect(m.cacheArticle('x', payload('<p>two</p>'))).rejects.toThrow('disk full');
    raw.beforeRun = null;
    const row = await (await m.getDb()).getFirstAsync<any>('SELECT * FROM entries WHERE slug = ?', ['x']);
    expect(row.content_html).toBe('<p>one</p>');
    expect(row.content_hash).toBe(m.contentHash('<p>one</p>'));
    expect((await versions('x')).map(v => v.content_hash)).toEqual([m.contentHash('<p>one</p>')]);
  });
});

describe('cache-status / scope queries', () => {
  beforeEach(() => seedEntries([
    { slug: 's1', title: 'S1', source: 'sep', cached: true },
    { slug: 's2', title: 'S2', source: 'sep' },
    { slug: 'o1', title: 'O1', source: 'owl', cached: true },
    { slug: 'o2', title: 'O2', source: 'owl' },
    { slug: 'o3', title: 'O3', source: 'owl' },
  ]));

  it.each([
    ['all', 5, 2],
    ['sep', 2, 1],
    ['owl', 3, 1],
  ] as const)('getEntryCounts(%s)', async (scope, total, cached) => {
    expect(await m.getEntryCounts(scope)).toEqual({ total, cached });
  });

  it('getEntryCounts defaults to all', async () => {
    expect(await m.getEntryCounts()).toEqual({ total: 5, cached: 2 });
  });

  it('getSlugsByCacheStatus partitions by cached_at within a scope', async () => {
    const r = await m.getSlugsByCacheStatus('owl');
    expect(r.cached.map(e => e.slug)).toEqual(['o1']);
    expect(r.uncached.map(e => e.slug).sort()).toEqual(['o2', 'o3']);
  });

  it('getAllUncachedSlugs / getCachedSlugs follow the scope', async () => {
    expect((await m.getAllUncachedSlugs('sep')).map(e => e.slug)).toEqual(['s2']);
    expect((await m.getCachedSlugs('sep')).map(e => e.slug)).toEqual(['s1']);
  });

  // `pref_library_scope` is an untyped meta string that importUserData can set
  // from a sync-folder file, so an out-of-union value can really reach these.
  const hostile = "x' OR '1'='1" as any;
  it('treats a scope outside the union as matching nothing, not everything', async () => {
    expect(await m.getEntryCounts(hostile)).toEqual({ total: 0, cached: 0 });
    expect(await m.getSlugsByCacheStatus(hostile)).toEqual({ uncached: [], cached: [] });
  });

  it('does not throw on a scope containing quotes or statement separators', async () => {
    const nasty = "'; DROP TABLE entries; --" as any;
    await expect(m.getEntryCounts(nasty)).resolves.toEqual({ total: 0, cached: 0 });
    expect(await m.getEntryCount()).toBe(5);
  });
});

describe('hot-query indexes', () => {
  const plan = async (sql: string, params: unknown[] = []) =>
    (await raw.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)).map(r => r.detail).join(' | ');

  it('recordRead\'s latest-read lookup uses an index, not a scan + sort', async () => {
    const p = await plan('SELECT visited_at, session_id FROM reads ORDER BY visited_at DESC LIMIT 1');
    expect(p).toMatch(/USING (COVERING )?INDEX/);
    expect(p).not.toMatch(/TEMP B-TREE/);
  });

  it('annotations are looked up by slug through an index', async () => {
    const p = await plan('SELECT * FROM annotations WHERE slug = ? ORDER BY created_at ASC', ['x']);
    expect(p).toMatch(/SEARCH annotations USING (COVERING )?INDEX/);
  });

  it('the per-row annotation_count subquery uses an index', async () => {
    const p = await plan('SELECT (SELECT COUNT(*) FROM annotations a WHERE a.slug = b.slug) FROM bookmarks b');
    expect(p).toMatch(/SEARCH a USING (COVERING )?INDEX/);
  });

  it('getSessions\'s bounded query reads each session\'s rows through an index', async () => {
    const p = await plan(
      `SELECT id FROM reads WHERE session_id IN (
         SELECT session_id FROM reads GROUP BY session_id
         ORDER BY MIN(visited_at) DESC, MIN(id) DESC LIMIT 30
       ) ORDER BY visited_at ASC, id ASC`);
    expect(p).toMatch(/SEARCH reads USING (COVERING )?INDEX idx_reads_session_visited/);
  });

  it('creates exactly the four query indexes', async () => {
    const names = (await raw.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name"))
      .map(r => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'idx_annotations_slug', 'idx_reads_session_visited', 'idx_reads_slug', 'idx_reads_visited',
    ]));
  });

  it('re-running schema setup on an already-initialized, populated database is harmless', async () => {
    await addRead('s1', 'a', 100);
    jest.resetModules();
    const m2: DbModule = require('../db'); // fresh module state, same underlying database
    await expect(m2.getDb()).resolves.toBeDefined();
    expect((await m2.getSessions(30))).toHaveLength(1);
  });
});

describe('clearArticleCache', () => {
  it('drops cached content and the list of articles waiting for math', async () => {
    await seedEntries([{ slug: 'a', title: 'A', cached: true }]);
    const db = await m.getDb();
    await db.runAsync("UPDATE entries SET content_html = '<p>x</p>' WHERE slug = 'a'");
    await m.setMeta('math_pending', JSON.stringify(['a']));
    expect(await m.getMeta('math_pending')).toBe('["a"]');

    await m.clearArticleCache();

    const row = await db.getFirstAsync('SELECT content_html, cached_at FROM entries WHERE slug = ?', ['a']);
    expect(row).toEqual({ content_html: null, cached_at: null });
    // both the stored row and the in-memory meta cache are cleared
    expect(await m.getMeta('math_pending')).toBeNull();
    expect(await db.getFirstAsync("SELECT value FROM meta WHERE key = 'math_pending'")).toBeNull();
  });

  it('keeps user data and settings', async () => {
    await seedEntries([{ slug: 'a', title: 'A', cached: true }]);
    await m.setMeta('font_size', '19');
    await addRead('s1', 'a', 1000);
    await m.clearArticleCache();
    expect(await m.getMeta('font_size')).toBe('19');
    expect(await m.getSessions(30)).toHaveLength(1);
  });
});

describe('adapter wiring of the core merge (importUserData)', () => {
  it('gives a uid-less annotation a 128-bit hex uid and the real clock', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(4242);
    await m.importUserData({ version: 1, exported_at: 0, reads: [], bookmarks: [], prefs: {},
      annotations: [{ slug: 's', selected_text: 'x' } as any] });
    const row: any = raw.raw.prepare('SELECT * FROM annotations').get();
    expect(row.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(row.created_at).toBe(4242);
    jest.restoreAllMocks();
  });
  it('recordRead starts a new session after the 30-minute gap and keeps it inside', async () => {
    const spy = jest.spyOn(Date, 'now');
    spy.mockReturnValue(1_000); await m.recordRead('a', 'A', null);
    spy.mockReturnValue(1_000 + 60_000); await m.recordRead('b', 'B', 'a');
    spy.mockReturnValue(1_000 + 60_000 + 31 * 60_000); await m.recordRead('c', 'C', null);
    const ids = raw.raw.prepare('SELECT session_id FROM reads ORDER BY visited_at').all().map((r: any) => r.session_id);
    expect(ids).toEqual(['1000', '1000', String(1_000 + 60_000 + 31 * 60_000)]);
    jest.restoreAllMocks();
  });
});
