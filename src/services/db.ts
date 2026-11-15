import * as SQLite from 'expo-sqlite';
import type { EntryRow, EntrySummary, ReadRow, Session, Annotation } from '../types';
import { makeExcerpt } from '../utils/excerpt';
import { contentHash, resolveEntryHash } from '../utils/contentHash';
import { formatCitation } from '../utils/citation';
import { buildFtsQuery } from '../utils/ftsQuery';
import { mathTierStamp, TIERED_MATH_DEFAULT } from '../utils/mathTier';
import { sessionIdFor, groupSessions } from '../utils/readSessions';
import { scopeFilter, countWords } from '../utils/libraryScope';
import type { mergeAnnotation as MergeAnnotation } from '../core/annotationMerge';
import type { mergeRead as MergeRead } from '../core/readsMerge';

// The pure helpers stay plain exports; everything that touches the connection lives on a Db
// instance made by createDb() and built once in src/composition.ts.
export { contentHash, resolveEntryHash, formatCitation };

// What createDb needs from outside. The migration runner and the merge rules are core code; the
// clock, uid source, secure store and bundled link map are platform pieces. The root supplies all
// of them, so this adapter value-imports no core use case and keeps no module-level state.
export interface DbDeps {
  /** Opens the physical database. Defaults to the app's sep.db. */
  open?: () => Promise<SQLite.SQLiteDatabase>;
  /** Brings a freshly opened handle's schema up to date (the core migration runner over CORE_MIGRATIONS). */
  migrate: (db: SQLite.SQLiteDatabase) => Promise<void>;
  mergeAnnotation: typeof MergeAnnotation;
  mergeRead: typeof MergeRead;
  clock: { now: () => number };
  newUid: () => string;
  secrets: {
    available: () => Promise<boolean>;
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  };
  /** The link index shipped in the bundle, used before the first index sync stores one. */
  loadBundledLinkMap: () => Promise<string>;
}

// ── Client-rendered math cache (see (removed; math is rendered by core/substituteMath.ts)) ──

export interface MathRow {
  hash: string;
  svg: string;
  w: number;
  h: number;
  d: boolean;
}
const ENTRY_META_COLUMNS =
  'slug, title, parent_label, source, author, pub_date, content_hash, toc_html, ' +
  'preamble_html, has_math, word_count, cached_at';
const ENTRY_HEAVY_COLUMNS = 'content_html, notes_html, content_ast';

// Everything about an entry except the article bodies.
export type EntryMeta = Omit<EntryRow, 'content_html' | 'content_ast' | 'notes_html'>;
export interface Prefs {
  homeMode: 'search' | 'continue';
  downloadAll: boolean;
  libraryScope: 'all' | 'sep' | 'owl';
  seedUrl: string;
}
export interface BookmarkRow {
  slug: string;
  title: string;
  saved_at: number;
  notes: string | null;
  author: string | null;
  pub_date: string | null;
  cached_at: number | null;
}
const ZOTERO_API_KEY = 'zotero_api_key';
const ZOTERO_USER_ID = 'zotero_user_id';
export interface AnnotationWithTitle extends Annotation {
  article_title: string | null;
}
export interface UserDataExport {
  version: number;
  exported_at: number;
  reads: ReadRow[];
  bookmarks: BookmarkRow[];
  annotations: Annotation[];
  prefs: Record<string, string>;
}

// The ONLY `meta` keys that travel in the user-data export (and that an import
// will write back). This is an allowlist on purpose: `meta` also holds secrets,
// device-local paths, caches and migration markers, and a new key must never
// leak into a synced file just because nobody remembered to exclude it. Add a
// key here only if it is a harmless, user-chosen preference.
export const SYNCED_PREF_KEYS: readonly string[] = [
  'pref_home', 'pref_download_all', 'pref_library_scope', 'pref_seed_url',
  'custom_css', 'font_size', 'auto_sync', 'link_preview', 'graph_visited_only',
];

export function createDb(deps: DbDeps) {
  // One shared connection. getDb() caches the *promise* of an opened-and-migrated
  // database, so concurrent callers share a single open and none can observe a
  // handle whose schema is still being built. closeDb() waits for any in-flight
  // open, and getDb() waits for any in-flight close before opening again.
  let _open: Promise<SQLite.SQLiteDatabase> | null = null;
  let _closing: Promise<void> | null = null;

  // Tiered math: which math pipeline produced the cached articles. When the
  // effective on/off state or MATH_TIER_VERSION changes, clear cached article
  // content so everything re-fetches and re-processes. Not a versioned migration:
  // it depends on launch-time state (the `tiered_math` meta pref overrides
  // TIERED_MATH_DEFAULT), so it must be able to run again after a flag flip.
  async function applyMathTierStamp(db: SQLite.SQLiteDatabase): Promise<void> {
    const tierPref = await db.getFirstAsync<{ value: string }>(`SELECT value FROM meta WHERE key = 'tiered_math'`);
    const tierStamp = mathTierStamp(tierPref ? tierPref.value === '1' : TIERED_MATH_DEFAULT);
    const tierSeen = await db.getFirstAsync<{ value: string }>(`SELECT value FROM meta WHERE key = 'math_tier_stamp'`);
    if (tierSeen?.value === tierStamp) return;
    if (tierSeen) {
      await db.runAsync(
        `UPDATE entries SET content_html = NULL, preamble_html = NULL, toc_html = NULL, notes_html = NULL,
         content_ast = NULL, excerpt = NULL, cached_at = NULL WHERE cached_at IS NOT NULL`
      );
      await db.runAsync(`DELETE FROM meta WHERE key = 'math_pending'`);
    }
    await db.runAsync(`INSERT OR REPLACE INTO meta (key, value) VALUES ('math_tier_stamp', ?)`, [tierStamp]);
  }

  async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
    const db = await (deps.open ? deps.open() : SQLite.openDatabaseAsync('sep.db'));
    try {
      // Outside any transaction: SQLite cannot change the journal mode inside one.
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await deps.migrate(db);
      await applyMathTierStamp(db);
    } catch (e) {
      await db.closeAsync().catch(() => {});
      throw e;
    }
    return db;
  }

  // Shared with the feature modules that own their own tables (services/graphDb.ts) and with the
  // seed import: the root hands them this, so there is a single app connection.
  async function getDb(): Promise<SQLite.SQLiteDatabase> {
    while (_closing) await _closing.catch(() => {});
    if (!_open) {
      const opening = openAndMigrate();
      _open = opening;
      // A failed open or migration must not be cached: the next caller retries.
      opening.catch(() => { if (_open === opening) _open = null; });
    }
    return _open;
  }

  // Used by the seed import: closes the connection so the DB file can be replaced.
  // Resolves once the file is released; a getDb() issued meanwhile waits and then
  // opens the (possibly replaced) file afresh.
  async function closeDb(): Promise<void> {
    while (_closing) await _closing.catch(() => {});
    const opening = _open;
    if (!opening) return;
    _open = null;
    const closing = (async () => {
      let db: SQLite.SQLiteDatabase;
      try {
        db = await opening;
      } catch {
        return; // the open failed; there is no handle to close
      }
      await db.closeAsync();
    })();
    _closing = closing;
    try {
      await closing;
    } finally {
      if (_closing === closing) _closing = null;
    }
  }

  async function getEntryCount(): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM entries'
    );
    return row?.count ?? 0;
  }

  async function getEntryCounts(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{ total: number; cached: number }> {
    const db = await getDb();
    const { where, params } = scopeFilter(scope);
    const row = await db.getFirstAsync<{ total: number; cached: number }>(
      `SELECT COUNT(*) AS total, COUNT(cached_at) AS cached FROM entries ${where}`,
      params
    );
    return { total: row?.total ?? 0, cached: row?.cached ?? 0 };
  }


  // Bulk-load cached equations by hash to warm the in-memory render cache.
  async function getMathByHashes(hashes: string[]): Promise<MathRow[]> {
    if (hashes.length === 0) return [];
    const db = await getDb();
    const placeholders = hashes.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ hash: string; svg: string; w: number; h: number; d: number }>(
      `SELECT hash, svg, w, h, d FROM math WHERE hash IN (${placeholders})`,
      hashes
    );
    return rows.map(r => ({ hash: r.hash, svg: r.svg, w: r.w, h: r.h, d: r.d === 1 }));
  }

  // Return a hash→svg map for the given hashes. Missing hashes are omitted.
  async function getMathSvgMap(hashes: string[]): Promise<Record<string, string>> {
    if (!hashes.length) return {};
    const rows = await getMathByHashes(hashes);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.hash] = r.svg;
    return map;
  }


  // Persist one device-rendered equation. Idempotent on hash.
  async function putMath(
    hash: string,
    svg: string,
    w: number,
    h: number,
    display: boolean
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'INSERT OR IGNORE INTO math (hash, svg, w, h, d) VALUES (?, ?, ?, ?, ?)',
      [hash, svg, w, h, display ? 1 : 0]
    );
  }

  // Persist many device-rendered equations in one transaction. Idempotent on hash.
  // One round trip instead of one awaited INSERT per equation.
  async function putMathBatch(
    rows: Array<{ hash: string; svg: string; w: number; h: number; display: boolean }>
  ): Promise<void> {
    if (!rows.length) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const r of rows) {
        await db.runAsync(
          'INSERT OR IGNORE INTO math (hash, svg, w, h, d) VALUES (?, ?, ?, ?, ?)',
          [r.hash, r.svg, r.w, r.h, r.display ? 1 : 0]
        );
      }
    });
  }

  async function upsertIndexEntries(
    entries: { slug: string; title: string; parent_label?: string | null }[]
  ): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const e of entries) {
        await db.runAsync(
          `INSERT INTO entries (slug, title, parent_label)
           VALUES (?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET title = excluded.title, parent_label = excluded.parent_label`,
          [e.slug, e.title, e.parent_label ?? null]
        );
        await db.runAsync(`DELETE FROM entries_fts WHERE slug = ?`, [e.slug]);
        await db.runAsync(`INSERT INTO entries_fts (slug, title) VALUES (?, ?)`, [e.slug, e.title]);
      }
    });
  }

  // Overwrite content_html and clear AST for a single entry. Used by the math pipeline.
  // AST is cleared so ArticleScreen falls back to parseSepHtml; backfillAst re-populates it.
  async function updateArticleHtml(slug: string, html: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE entries SET content_html = ?, content_ast = NULL WHERE slug = ?`, [html, slug]);
  }

  async function setArticleAst(slug: string, ast: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE entries SET content_ast = ? WHERE slug = ?`, [ast, slug]);
  }

  // Return slugs of cached articles that don't yet have a pre-parsed AST.
  async function getUncachedAstSlugs(): Promise<string[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ slug: string }>(
      `SELECT slug FROM entries WHERE content_html IS NOT NULL AND content_ast IS NULL`
    );
    return rows.map(r => r.slug);
  }

  async function cacheArticle(
    slug: string,
    data: Pick<EntryRow, 'author' | 'pub_date' | 'toc_html' | 'preamble_html' | 'content_html' | 'content_ast' | 'has_math'> & { notes_html?: string | null }
  ): Promise<void> {
    const db = await getDb();
    const wordCount = countWords(data.content_html ?? '');
    const hash = contentHash(data.content_html ?? '');
    const excerpt = makeExcerpt(data.preamble_html || data.content_html || '', 320);
    const now = deps.clock.now();

    // One transaction: the old-version record, the row update and the new-version
    // record must land together. Before, a failure between them could leave
    // article_versions out of step with entries (e.g. the old article overwritten
    // but its hash never recorded).
    await db.withTransactionAsync(async () => {
      // Preserve the old version record before overwriting
      const prev = await db.getFirstAsync<{ content_hash: string | null; cached_at: number | null }>(
        'SELECT content_hash, cached_at FROM entries WHERE slug = ?', [slug]
      );
      if (prev?.content_hash && prev?.cached_at) {
        await db.runAsync(
          'INSERT OR IGNORE INTO article_versions (slug, content_hash, cached_at) VALUES (?, ?, ?)',
          [slug, prev.content_hash, prev.cached_at]
        );
      }

      await db.runAsync(
        `UPDATE entries SET
           author = ?, pub_date = ?, content_hash = ?,
           toc_html = ?, preamble_html = ?,
           content_html = ?, notes_html = ?, content_ast = ?, has_math = ?, word_count = ?, excerpt = ?, cached_at = ?
         WHERE slug = ?`,
        [data.author ?? null, data.pub_date ?? null, hash,
         data.toc_html ?? null, data.preamble_html ?? null,
         data.content_html ?? null, data.notes_html ?? null, data.content_ast ?? null, data.has_math ? 1 : 0, wordCount, excerpt, now, slug]
      );

      // Record the new version
      await db.runAsync(
        'INSERT OR IGNORE INTO article_versions (slug, content_hash, cached_at) VALUES (?, ?, ?)',
        [slug, hash, now]
      );
    });
  }

  // Persist footnote-page HTML for an already-cached article (lazy backfill for
  // entries that were downloaded before notes were stored).
  async function setEntryNotes(slug: string, notesHtml: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE entries SET notes_html = ? WHERE slug = ?', [notesHtml, slug]);
  }

  async function getArticleVersionDate(slug: string, hash: string): Promise<number | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ cached_at: number }>(
      'SELECT cached_at FROM article_versions WHERE slug = ? AND content_hash = ?',
      [slug, hash]
    );
    return row?.cached_at ?? null;
  }

  // Explicit column lists (no SELECT *): the heavy columns — content_html,
  // content_ast, notes_html — are each a whole article, so callers that don't need
  // them must not pay to read them.

  // Full row, bodies included. Prefer getEntryMeta / getEntryHtml unless you need
  // the AST or notes too (see src/services/__tests__/getEntry.callers.test.ts).
  async function getEntry(slug: string): Promise<EntryRow | null> {
    const db = await getDb();
    return db.getFirstAsync<EntryRow>(
      `SELECT ${ENTRY_META_COLUMNS}, ${ENTRY_HEAVY_COLUMNS} FROM entries WHERE slug = ?`,
      [slug]
    );
  }

  // Metadata only — no content_html / content_ast / notes_html.
  async function getEntryMeta(slug: string): Promise<EntryMeta | null> {
    const db = await getDb();
    return db.getFirstAsync<EntryMeta>(
      `SELECT ${ENTRY_META_COLUMNS} FROM entries WHERE slug = ?`,
      [slug]
    );
  }

  // Article body only. null when the entry is unknown or indexed but not cached.
  async function getEntryHtml(slug: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ content_html: string | null }>(
      'SELECT content_html FROM entries WHERE slug = ?',
      [slug]
    );
    return row?.content_html || null;
  }

  // Lightweight row for graph node previews (no heavy content_html)
  async function getEntryPreview(
    slug: string
  ): Promise<{ title: string; author: string | null; excerpt: string | null } | null> {
    const db = await getDb();
    return db.getFirstAsync<{ title: string; author: string | null; excerpt: string | null }>(
      'SELECT title, author, excerpt FROM entries WHERE slug = ?',
      [slug]
    );
  }

  async function searchEntries(query: string, limit = 60): Promise<EntrySummary[]> {
    const db = await getDb();
    if (!query.trim()) {
      return db.getAllAsync<EntrySummary>(
        `SELECT slug, title, parent_label, author, cached_at FROM entries ORDER BY title ASC LIMIT ?`,
        [limit]
      );
    }
    const ftsQuery = buildFtsQuery(query) as string; // non-null: the blank case returned above
    return db.getAllAsync<EntrySummary>(
      `SELECT e.slug, e.title, e.parent_label, e.author, e.cached_at
       FROM entries_fts fts
       JOIN entries e USING (slug)
       WHERE entries_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      [ftsQuery, limit]
    );
  }

  async function recordRead(
    slug: string,
    title: string,
    fromSlug: string | null
  ): Promise<void> {
    const db = await getDb();
    const now = deps.clock.now();

    // Find the most recent read to determine session
    const last = await db.getFirstAsync<{ visited_at: number; session_id: string }>(
      'SELECT visited_at, session_id FROM reads ORDER BY visited_at DESC LIMIT 1'
    );

    const sessionId = sessionIdFor(last, now);

    await db.runAsync(
      `INSERT OR IGNORE INTO reads (slug, title, visited_at, from_slug, session_id)
       VALUES (?, ?, ?, ?, ?)`,
      [slug, title, now, fromSlug ?? null, sessionId]
    );
  }

  // Persist how far through an article the reader has scrolled (0..1).
  // Only ratchets upward so re-opening near the top doesn't erase progress.
  async function setReadProgress(slug: string, progress: number): Promise<void> {
    const db = await getDb();
    const clamped = Math.max(0, Math.min(1, progress));
    await db.runAsync(
      'UPDATE entries SET read_progress = MAX(COALESCE(read_progress, 0), ?) WHERE slug = ?',
      [clamped, slug]
    );
  }

  // Force-set read progress without ratcheting — used for "mark as read/unread".
  async function forceSetReadProgress(slug: string, progress: number): Promise<void> {
    const db = await getDb();
    const clamped = Math.max(0, Math.min(1, progress));
    await db.runAsync(
      'UPDATE entries SET read_progress = ? WHERE slug = ?',
      [clamped, slug]
    );
  }

  async function getRecentSlugs(limit = 20): Promise<EntrySummary[]> {
    const db = await getDb();
    // Most recently read unique slugs, with progress / annotation count / excerpt
    return db.getAllAsync<EntrySummary>(
      `SELECT r.slug, r.title, e.parent_label, e.author, e.cached_at,
              e.read_progress, e.excerpt,
              (SELECT COUNT(*) FROM annotations a WHERE a.slug = r.slug) AS annotation_count
       FROM reads r
       LEFT JOIN entries e USING (slug)
       GROUP BY r.slug
       ORDER BY MAX(r.visited_at) DESC
       LIMIT ?`,
      [limit]
    );
  }

  async function getSessions(limit = 30): Promise<Session[]> {
    const db = await getDb();

    // Bound the read in SQL: pick the newest `limit` sessions (by start time, with
    // the row id breaking ties the same way the old full-table scan did), then
    // load only their rows. History only ever grows, so loading every read just
    // to slice the result in JS got slower with every article opened.
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (bounded === 0) return [];

    const rows = await db.getAllAsync<ReadRow>(
      `SELECT id, slug, title, visited_at, from_slug, session_id
       FROM reads
       WHERE session_id IN (
         SELECT session_id FROM reads
         GROUP BY session_id
         ORDER BY MIN(visited_at) DESC, MIN(id) DESC
         LIMIT ?
       )
       ORDER BY visited_at ASC, id ASC`,
      [bounded]
    );

    // Newest first (the query already limited which sessions are present)
    return groupSessions(rows);
  }

  const metaCache = new Map<string, string | null>();

  // Keep the in-memory cache in step with any code path that writes `meta`
  // directly (savePrefs, Zotero creds, importUserData) instead of via setMeta.
  // Without this, getMeta would keep serving the pre-write value for the rest of
  // the session (e.g. restored custom_css / font_size silently ignored).
  function cacheMeta(key: string, value: string | null): void {
    metaCache.set(key, value);
  }

  async function getMeta(key: string): Promise<string | null> {
    if (metaCache.has(key)) return metaCache.get(key)!;
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?', [key]
    );
    const val = row?.value ?? null;
    metaCache.set(key, val);
    return val;
  }

  async function setMeta(key: string, value: string): Promise<void> {
    metaCache.set(key, value);
    const db = await getDb();
    await db.runAsync(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]
    );
  }


  async function getPrefs(): Promise<Prefs> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key IN ('pref_home', 'pref_download_all', 'pref_library_scope', 'pref_seed_url')"
    );
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
      homeMode: (map['pref_home'] as Prefs['homeMode']) ?? 'search',
      downloadAll: map['pref_download_all'] !== 'false',
      libraryScope: (map['pref_library_scope'] as Prefs['libraryScope']) ?? 'all',
      seedUrl: map['pref_seed_url'] ?? '',
    };
  }

  async function savePrefs(prefs: Prefs): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('pref_home', ?)", [prefs.homeMode]);
      await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('pref_download_all', ?)", [String(prefs.downloadAll)]);
      await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('pref_library_scope', ?)", [prefs.libraryScope]);
      await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('pref_seed_url', ?)", [prefs.seedUrl]);
      await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('onboarding_done', 'true')");
    });
    cacheMeta('pref_home', prefs.homeMode);
    cacheMeta('pref_download_all', String(prefs.downloadAll));
    cacheMeta('pref_library_scope', prefs.libraryScope);
    cacheMeta('pref_seed_url', prefs.seedUrl);
    cacheMeta('onboarding_done', 'true');
  }

  async function toggleBookmark(slug: string, title: string): Promise<boolean> {
    const db = await getDb();
    const existing = await db.getFirstAsync<{ slug: string }>(
      'SELECT slug FROM bookmarks WHERE slug = ?', [slug]
    );
    if (existing) {
      await db.runAsync('DELETE FROM bookmarks WHERE slug = ?', [slug]);
      return false;
    }
    await db.runAsync(
      'INSERT INTO bookmarks (slug, title, saved_at) VALUES (?, ?, ?)',
      [slug, title, deps.clock.now()]
    );
    return true;
  }

  async function isBookmarked(slug: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ slug: string }>(
      'SELECT slug FROM bookmarks WHERE slug = ?', [slug]
    );
    return !!row;
  }

  async function getBookmarks(): Promise<EntrySummary[]> {
    const db = await getDb();
    return db.getAllAsync<EntrySummary>(
      `SELECT b.slug, b.title, e.parent_label, e.author, e.cached_at,
              e.read_progress, e.excerpt,
              (SELECT COUNT(*) FROM annotations a WHERE a.slug = b.slug) AS annotation_count
       FROM bookmarks b
       LEFT JOIN entries e USING (slug)
       ORDER BY b.saved_at DESC`
    );
  }

  async function clearArticleCache(): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'UPDATE entries SET content_html = NULL, toc_html = NULL, preamble_html = NULL, cached_at = NULL'
    );
    // The articles are gone, so the list of articles waiting for math rendering is moot.
    await db.runAsync("DELETE FROM meta WHERE key = 'math_pending'");
    metaCache.delete('math_pending');
  }

  async function getSlugsByCacheStatus(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{
    uncached: { slug: string; title: string }[];
    cached: { slug: string; title: string }[];
  }> {
    const db = await getDb();
    const { where, params } = scopeFilter(scope);
    const rows = await db.getAllAsync<{ slug: string; title: string; is_cached: number }>(
      `SELECT slug, title, (cached_at IS NOT NULL) AS is_cached FROM entries ${where}`,
      params
    );
    const uncached: { slug: string; title: string }[] = [];
    const cached: { slug: string; title: string }[] = [];
    for (const row of rows) {
      if (row.is_cached) cached.push({ slug: row.slug, title: row.title });
      else uncached.push({ slug: row.slug, title: row.title });
    }
    return { uncached, cached };
  }

  async function getAllUncachedSlugs(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{ slug: string; title: string }[]> {
    return (await getSlugsByCacheStatus(scope)).uncached;
  }

  async function getCachedSlugs(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{ slug: string; title: string }[]> {
    return (await getSlugsByCacheStatus(scope)).cached;
  }

  async function getAllEntryTitles(): Promise<{ slug: string; title: string }[]> {
    const db = await getDb();
    return db.getAllAsync<{ slug: string; title: string }>(
      `SELECT slug, title FROM entries WHERE LENGTH(title) > 3 ORDER BY LENGTH(title) DESC`
    );
  }

  async function getAllEntries(): Promise<{ slug: string; title: string; parent_label: string | null }[]> {
    const db = await getDb();
    return db.getAllAsync<{ slug: string; title: string; parent_label: string | null }>(
      `SELECT slug, title, parent_label FROM entries WHERE title IS NOT NULL ORDER BY title ASC`
    );
  }

  // Strip the old "Parent: " prefix from reads.title / bookmarks.title now that
  // parent_label is a first-class column. Called after every index sync; the WHERE
  // clause is a no-op once all titles are already clean.
  async function cleanDenormalizedTitles(): Promise<void> {
    const db = await getDb();
    await db.runAsync(`
      UPDATE reads
      SET title = SUBSTR(title, (SELECT LENGTH(e.parent_label) + 3 FROM entries e WHERE e.slug = reads.slug))
      WHERE EXISTS (
        SELECT 1 FROM entries e
        WHERE e.slug = reads.slug
          AND e.parent_label IS NOT NULL
          AND reads.title LIKE (e.parent_label || ': %')
      )
    `);
    await db.runAsync(`
      UPDATE bookmarks
      SET title = SUBSTR(title, (SELECT LENGTH(e.parent_label) + 3 FROM entries e WHERE e.slug = bookmarks.slug))
      WHERE EXISTS (
        SELECT 1 FROM entries e
        WHERE e.slug = bookmarks.slug
          AND e.parent_label IS NOT NULL
          AND bookmarks.title LIKE (e.parent_label || ': %')
      )
    `);
  }

  // Link index: pre-built once at index-sync time, cached in meta.
  // Module-level cache so we only hit the DB once per app session.
  let _linkCache: string | null = null;

  async function getLinkPayload(): Promise<string> {
    if (_linkCache) return _linkCache;
    const stored = await getMeta('link_index_json');
    if (stored) { _linkCache = stored; return stored; }
    // Fall back to the bundled asset (available immediately on first launch, before any sync)
    _linkCache = await deps.loadBundledLinkMap();
    return _linkCache;
  }

  function invalidateLinkCache(): void {
    _linkCache = null;
  }

  // ── Citation ─────────────────────────────────────────────────────────────────

  // ── Article links (graph view) ────────────────────────────────────────────────

  async function indexLinks(fromSlug: string, contentHtml: string): Promise<void> {
    const db = await getDb();
    const re = /href="\/entries\/([a-z0-9-]+)\//g;
    const targets = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(contentHtml)) !== null) {
      if (m[1] !== fromSlug) targets.add(m[1]);
    }
    if (targets.size === 0) return;
    const slugs = [...targets];
    const placeholders = slugs.map(() => `(?, ?)`).join(', ');
    const params = slugs.flatMap(to => [fromSlug, to]);
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM links WHERE from_slug = ?', [fromSlug]);
      await db.runAsync(
        `INSERT OR IGNORE INTO links (from_slug, to_slug) VALUES ${placeholders}`,
        params
      );
    });
  }

  async function getLinksFrom(slug: string): Promise<EntrySummary[]> {
    const db = await getDb();
    return db.getAllAsync<EntrySummary>(
      `SELECT e.slug, e.title, e.parent_label, e.author, e.cached_at
       FROM links l
       JOIN entries e ON e.slug = l.to_slug
       WHERE l.from_slug = ?
       ORDER BY e.title ASC`,
      [slug]
    );
  }

  async function getLinksTo(slug: string): Promise<EntrySummary[]> {
    const db = await getDb();
    return db.getAllAsync<EntrySummary>(
      `SELECT e.slug, e.title, e.parent_label, e.author, e.cached_at
       FROM links l
       JOIN entries e ON e.slug = l.from_slug
       WHERE l.to_slug = ?
       ORDER BY e.title ASC`,
      [slug]
    );
  }

  // ── Reading list (bookmarks + notes) ─────────────────────────────────────────

  async function updateBookmarkNotes(slug: string, notes: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE bookmarks SET notes = ? WHERE slug = ?', [notes, slug]);
  }


  async function getBookmarksFull(): Promise<BookmarkRow[]> {
    const db = await getDb();
    return db.getAllAsync<BookmarkRow>(
      `SELECT b.slug, b.title, b.saved_at, b.notes,
              e.author, e.pub_date, e.cached_at
       FROM bookmarks b
       LEFT JOIN entries e USING (slug)
       ORDER BY b.saved_at DESC`
    );
  }

  // ── Zotero ───────────────────────────────────────────────────────────────────

  // The API key is a secret: it lives in secure storage (secureSecrets.ts), not in
  // the plain `meta` table, so it never reaches DB backups or the sync export.
  // Where secure storage is unavailable (or a write to it fails) it falls back to
  // a `meta` row — still never exported, because exports use SYNCED_PREF_KEYS.
  // A `meta` row, when present, is the newest value and wins over secure storage;
  // it is removed the next time a save reaches secure storage. Neither Zotero
  // value is synced between devices.

  async function readZoteroApiKey(db: SQLite.SQLiteDatabase): Promise<string> {
    const fallback = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?', [ZOTERO_API_KEY]
    );
    if (fallback) return fallback.value;
    if (!(await deps.secrets.available())) return '';
    return (await deps.secrets.get(ZOTERO_API_KEY)) ?? '';
  }

  async function getZoteroPrefs(): Promise<{ apiKey: string; userId: string }> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?', [ZOTERO_USER_ID]
    );
    return { apiKey: await readZoteroApiKey(db), userId: row?.value ?? '' };
  }

  async function saveZoteroPrefs(apiKey: string, userId: string): Promise<void> {
    const db = await getDb();
    // True once the key is safely out of `meta`.
    const inSecureStore = (await deps.secrets.available())
      && (apiKey ? await deps.secrets.set(ZOTERO_API_KEY, apiKey) : await deps.secrets.delete(ZOTERO_API_KEY));
    await db.withTransactionAsync(async () => {
      await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('zotero_user_id', ?)", [userId]);
      if (inSecureStore) {
        await db.runAsync('DELETE FROM meta WHERE key = ?', [ZOTERO_API_KEY]);
      } else {
        await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('zotero_api_key', ?)", [apiKey]);
      }
    });
    cacheMeta(ZOTERO_USER_ID, userId);
    metaCache.delete(ZOTERO_API_KEY); // never keep the secret in the in-memory meta cache
  }

  // ── Annotations ──────────────────────────────────────────────────────────────

  async function saveAnnotation(
    slug: string,
    selectedText: string,
    context: string | null,
    color: string,
    note: string | null = null,
    currentHash: string | null = null
  ): Promise<Annotation> {
    const db = await getDb();
    const now = deps.clock.now();
    const uid = deps.newUid();
    const result = await db.runAsync(
      `INSERT INTO annotations (uid, slug, selected_text, context, note, color, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, slug, selectedText, context ?? null, note ?? null, color, currentHash ?? null, now, now]
    );
    return {
      id: result.lastInsertRowId,
      uid,
      slug, selected_text: selectedText, context: context ?? null,
      note: note ?? null, color, content_hash: currentHash ?? null,
      created_at: now, updated_at: now,
    };
  }

  async function updateAnnotation(
    id: number, note: string | null, color: string
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'UPDATE annotations SET note = ?, color = ?, updated_at = ? WHERE id = ?',
      [note ?? null, color, deps.clock.now(), id]
    );
  }

  async function deleteAnnotation(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM annotations WHERE id = ?', [id]);
  }

  async function getAnnotationsForSlug(slug: string): Promise<Annotation[]> {
    const db = await getDb();
    return db.getAllAsync<Annotation>(
      'SELECT * FROM annotations WHERE slug = ? ORDER BY created_at ASC', [slug]
    );
  }


  async function getAllAnnotations(): Promise<AnnotationWithTitle[]> {
    const db = await getDb();
    return db.getAllAsync<AnnotationWithTitle>(`
      SELECT a.*, e.title as article_title
      FROM annotations a
      LEFT JOIN entries e ON e.slug = a.slug
      ORDER BY a.created_at DESC
    `);
  }


  // ── JSON user data export / import ───────────────────────────────────────────


  async function exportUserData(): Promise<UserDataExport> {
    const db = await getDb();
    const [reads, bookmarks, annotations, metaRows] = await Promise.all([
      db.getAllAsync<ReadRow>('SELECT * FROM reads ORDER BY visited_at ASC'),
      db.getAllAsync<BookmarkRow>('SELECT * FROM bookmarks ORDER BY saved_at ASC'),
      db.getAllAsync<Annotation>('SELECT * FROM annotations ORDER BY created_at ASC'),
      db.getAllAsync<{ key: string; value: string }>(
        `SELECT key, value FROM meta WHERE key IN (${SYNCED_PREF_KEYS.map(() => '?').join(',')})`,
        [...SYNCED_PREF_KEYS]
      ),
    ]);
    return {
      version: 1,
      exported_at: deps.clock.now(),
      reads,
      bookmarks,
      annotations,
      prefs: Object.fromEntries(metaRows.map(r => [r.key, r.value])),
    };
  }

  async function importUserData(data: UserDataExport): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      // Reads: identity is (slug, visited_at, session_id); see readsMerge.ts.
      for (const r of data.reads ?? []) {
        await deps.mergeRead(db, r);
      }
      // Bookmarks: upsert by slug, keep newest saved_at
      for (const b of data.bookmarks) {
        await db.runAsync(
          `INSERT INTO bookmarks (slug, title, saved_at, notes)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
             title = excluded.title,
             saved_at = MAX(saved_at, excluded.saved_at),
             notes = COALESCE(excluded.notes, notes)`,
          [b.slug, b.title, b.saved_at, b.notes ?? null]
        );
      }
      // Annotations: matched across devices by uid (never by the local integer id),
      // last writer wins per record — see annotationMerge.ts.
      for (const a of data.annotations ?? []) {
        await deps.mergeAnnotation(db, a, { clock: deps.clock, newUid: deps.newUid });
      }
      // Prefs: merge, remote wins — allowlisted keys only, so a file can never
      // write credentials, device paths or caches into this device's meta.
      for (const [key, value] of Object.entries(data.prefs)) {
        if (!SYNCED_PREF_KEYS.includes(key) || typeof value !== 'string') continue;
        await db.runAsync(
          'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]
        );
        cacheMeta(key, value as string);
      }
    });
  }

  // ── Sync folder ──────────────────────────────────────────────────────────────

  async function getSyncFolder(): Promise<string> {
    return (await getMeta('sync_folder')) ?? '';
  }

  async function setSyncFolder(path: string): Promise<void> {
    await setMeta('sync_folder', path);
  }

  async function updateAnnotationAnchor(
    id: number,
    newText: string,
    newHash: string
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'UPDATE annotations SET selected_text = ?, content_hash = ?, updated_at = ? WHERE id = ?',
      [newText, newHash, deps.clock.now(), id]
    );
  }

  async function deleteAnnotations(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    const placeholders = ids.map(() => '?').join(',');
    await db.runAsync(`DELETE FROM annotations WHERE id IN (${placeholders})`, ids);
  }

  return {
    getDb, closeDb,
    getEntryCount,
    getEntryCounts,
    getMathByHashes,
    getMathSvgMap,
    putMath,
    putMathBatch,
    upsertIndexEntries,
    updateArticleHtml,
    setArticleAst,
    getUncachedAstSlugs,
    cacheArticle,
    setEntryNotes,
    getArticleVersionDate,
    getEntry,
    getEntryMeta,
    getEntryHtml,
    getEntryPreview,
    searchEntries,
    recordRead,
    setReadProgress,
    forceSetReadProgress,
    getRecentSlugs,
    getSessions,
    cacheMeta,
    getMeta,
    setMeta,
    getPrefs,
    savePrefs,
    toggleBookmark,
    isBookmarked,
    getBookmarks,
    clearArticleCache,
    getSlugsByCacheStatus,
    getAllUncachedSlugs,
    getCachedSlugs,
    getAllEntryTitles,
    getAllEntries,
    cleanDenormalizedTitles,
    getLinkPayload,
    invalidateLinkCache,
    indexLinks,
    getLinksFrom,
    getLinksTo,
    updateBookmarkNotes,
    getBookmarksFull,
    readZoteroApiKey,
    getZoteroPrefs,
    saveZoteroPrefs,
    saveAnnotation,
    updateAnnotation,
    deleteAnnotation,
    getAnnotationsForSlug,
    getAllAnnotations,
    exportUserData,
    importUserData,
    getSyncFolder,
    setSyncFolder,
    updateAnnotationAnchor,
    deleteAnnotations,
  };
}

export type Db = ReturnType<typeof createDb>;
