import * as SQLite from 'expo-sqlite';
import type { EntryRow, EntrySummary, ReadRow, ReadNode, Session, Annotation } from '../types';
import { makeExcerpt } from '../utils/excerpt';
import { CORE_MIGRATIONS } from './coreMigrations';
import { runMigrations, userVersionStore } from './migrations';
import { secretsAvailable, getSecret, setSecret, deleteSecret } from './secureSecrets';

// One shared connection. getDb() caches the *promise* of an opened-and-migrated
// database, so concurrent callers share a single open and none can observe a
// handle whose schema is still being built. closeDb() waits for any in-flight
// open, and getDb() waits for any in-flight close before opening again.
let _open: Promise<SQLite.SQLiteDatabase> | null = null;
let _closing: Promise<void> | null = null;

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('sep.db');
  try {
    // Outside any transaction: SQLite cannot change the journal mode inside one.
    await db.execAsync('PRAGMA journal_mode = WAL;');
    await runMigrations(db, CORE_MIGRATIONS, userVersionStore);
  } catch (e) {
    await db.closeAsync().catch(() => {});
    throw e;
  }
  return db;
}

// Exported so feature modules that own their own tables (e.g. services/graphDb.ts)
// can share the single app DB connection rather than opening their own.
export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  while (_closing) await _closing.catch(() => {});
  if (!_open) {
    const opening = openAndMigrate();
    _open = opening;
    // A failed open or migration must not be cached: the next caller retries.
    opening.catch(() => { if (_open === opening) _open = null; });
  }
  return _open;
}

// Used by seedImport — closes the connection so the DB file can be replaced.
// Resolves once the file is released; a getDb() issued meanwhile waits and then
// opens the (possibly replaced) file afresh.
export async function closeDb(): Promise<void> {
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

export async function getEntryCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM entries'
  );
  return row?.count ?? 0;
}

// Library scope filter, bound as a parameter. `scope` is typed as a closed union
// but not guaranteed at runtime: getPrefs casts an untyped meta string, and
// importUserData can set that string from a sync-folder file. A value outside
// the union therefore matches no rows instead of being spliced into the SQL.
function scopeFilter(scope: 'all' | 'sep' | 'owl'): { where: string; params: string[] } {
  return scope === 'all'
    ? { where: '', params: [] }
    : { where: 'WHERE source = ?', params: [scope] };
}

export async function getEntryCounts(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{ total: number; cached: number }> {
  const db = await getDb();
  const { where, params } = scopeFilter(scope);
  const row = await db.getFirstAsync<{ total: number; cached: number }>(
    `SELECT COUNT(*) AS total, COUNT(cached_at) AS cached FROM entries ${where}`,
    params
  );
  return { total: row?.total ?? 0, cached: row?.cached ?? 0 };
}

// ── Client-rendered math cache (see src/utils/sepHtml/render/mathStore.ts) ──

export interface MathRow {
  hash: string;
  svg: string;
  w: number;
  h: number;
  d: boolean;
}

// Bulk-load cached equations by hash to warm the in-memory render cache.
export async function getMathByHashes(hashes: string[]): Promise<MathRow[]> {
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
export async function getMathSvgMap(hashes: string[]): Promise<Record<string, string>> {
  if (!hashes.length) return {};
  const rows = await getMathByHashes(hashes);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.hash] = r.svg;
  return map;
}


// Persist one device-rendered equation. Idempotent on hash.
export async function putMath(
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
export async function putMathBatch(
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

export async function upsertIndexEntries(
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

// Return content_html for all cached math articles. Used by the startup
// backfill in catalog.ts to substitute raw TeX with pre-rendered SVGs.
export async function getMathArticleHtml(): Promise<Array<{ slug: string; content_html: string }>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ slug: string; content_html: string }>(
    `SELECT slug, content_html FROM entries WHERE has_math = 1 AND content_html IS NOT NULL`
  );
  return rows;
}

// Overwrite content_html and clear AST for a single entry. Used by backfillMathInline.
// AST is cleared so ArticleScreen falls back to parseSepHtml; backfillAst re-populates it.
export async function updateArticleHtml(slug: string, html: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE entries SET content_html = ?, content_ast = NULL WHERE slug = ?`, [html, slug]);
}

export async function setArticleAst(slug: string, ast: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE entries SET content_ast = ? WHERE slug = ?`, [ast, slug]);
}

// Return slugs of cached articles that don't yet have a pre-parsed AST.
export async function getUncachedAstSlugs(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ slug: string }>(
    `SELECT slug FROM entries WHERE content_html IS NOT NULL AND content_ast IS NULL`
  );
  return rows.map(r => r.slug);
}

export async function cacheArticle(
  slug: string,
  data: Pick<EntryRow, 'author' | 'pub_date' | 'toc_html' | 'preamble_html' | 'content_html' | 'content_ast' | 'has_math'> & { notes_html?: string | null }
): Promise<void> {
  const db = await getDb();
  const wordCount = countWords(data.content_html ?? '');
  const hash = contentHash(data.content_html ?? '');
  const excerpt = makeExcerpt(data.preamble_html || data.content_html || '', 320);
  const now = Date.now();

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
export async function setEntryNotes(slug: string, notesHtml: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE entries SET notes_html = ? WHERE slug = ?', [notesHtml, slug]);
}

export async function getArticleVersionDate(slug: string, hash: string): Promise<number | null> {
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
const ENTRY_META_COLUMNS =
  'slug, title, parent_label, source, author, pub_date, content_hash, toc_html, ' +
  'preamble_html, has_math, word_count, cached_at';
const ENTRY_HEAVY_COLUMNS = 'content_html, notes_html, content_ast';

// Everything about an entry except the article bodies.
export type EntryMeta = Omit<EntryRow, 'content_html' | 'content_ast' | 'notes_html'>;

// Full row, bodies included. Prefer getEntryMeta / getEntryHtml unless you need
// the AST or notes too (see src/services/__tests__/getEntry.callers.test.ts).
export async function getEntry(slug: string): Promise<EntryRow | null> {
  const db = await getDb();
  return db.getFirstAsync<EntryRow>(
    `SELECT ${ENTRY_META_COLUMNS}, ${ENTRY_HEAVY_COLUMNS} FROM entries WHERE slug = ?`,
    [slug]
  );
}

// Metadata only — no content_html / content_ast / notes_html.
export async function getEntryMeta(slug: string): Promise<EntryMeta | null> {
  const db = await getDb();
  return db.getFirstAsync<EntryMeta>(
    `SELECT ${ENTRY_META_COLUMNS} FROM entries WHERE slug = ?`,
    [slug]
  );
}

// Article body only. null when the entry is unknown or indexed but not cached.
export async function getEntryHtml(slug: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ content_html: string | null }>(
    'SELECT content_html FROM entries WHERE slug = ?',
    [slug]
  );
  return row?.content_html || null;
}

// Lightweight row for graph node previews (no heavy content_html)
export async function getEntryPreview(
  slug: string
): Promise<{ title: string; author: string | null; excerpt: string | null } | null> {
  const db = await getDb();
  return db.getFirstAsync<{ title: string; author: string | null; excerpt: string | null }>(
    'SELECT title, author, excerpt FROM entries WHERE slug = ?',
    [slug]
  );
}

export async function searchEntries(query: string, limit = 60): Promise<EntrySummary[]> {
  const db = await getDb();
  if (!query.trim()) {
    return db.getAllAsync<EntrySummary>(
      `SELECT slug, title, parent_label, author, cached_at FROM entries ORDER BY title ASC LIMIT ?`,
      [limit]
    );
  }
  const ftsQuery = query.trim().split(/\s+/).map(w => `"${w}"*`).join(' ');
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

const SESSION_GAP_MS = 30 * 60 * 1000;

export async function recordRead(
  slug: string,
  title: string,
  fromSlug: string | null
): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  // Find the most recent read to determine session
  const last = await db.getFirstAsync<{ visited_at: number; session_id: string }>(
    'SELECT visited_at, session_id FROM reads ORDER BY visited_at DESC LIMIT 1'
  );

  const sessionId =
    last && now - last.visited_at < SESSION_GAP_MS
      ? last.session_id
      : String(now);

  await db.runAsync(
    `INSERT INTO reads (slug, title, visited_at, from_slug, session_id)
     VALUES (?, ?, ?, ?, ?)`,
    [slug, title, now, fromSlug ?? null, sessionId]
  );
}

// Persist how far through an article the reader has scrolled (0..1).
// Only ratchets upward so re-opening near the top doesn't erase progress.
export async function setReadProgress(slug: string, progress: number): Promise<void> {
  const db = await getDb();
  const clamped = Math.max(0, Math.min(1, progress));
  await db.runAsync(
    'UPDATE entries SET read_progress = MAX(COALESCE(read_progress, 0), ?) WHERE slug = ?',
    [clamped, slug]
  );
}

// Force-set read progress without ratcheting — used for "mark as read/unread".
export async function forceSetReadProgress(slug: string, progress: number): Promise<void> {
  const db = await getDb();
  const clamped = Math.max(0, Math.min(1, progress));
  await db.runAsync(
    'UPDATE entries SET read_progress = ? WHERE slug = ?',
    [clamped, slug]
  );
}

export async function getRecentSlugs(limit = 20): Promise<EntrySummary[]> {
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

export async function getSessions(limit = 30): Promise<Session[]> {
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

  // Group by session_id
  const sessionMap = new Map<string, ReadRow[]>();
  for (const row of rows) {
    const list = sessionMap.get(row.session_id) ?? [];
    list.push(row);
    sessionMap.set(row.session_id, list);
  }

  const sessions: Session[] = [];
  for (const [sessionId, reads] of sessionMap) {
    sessions.push({
      session_id: sessionId,
      started_at: reads[0].visited_at,
      roots: buildTree(reads),
      total: reads.length,
    });
  }

  // Newest first (the query already limited which sessions are present)
  return sessions.reverse();
}

function buildTree(reads: ReadRow[]): ReadNode[] {
  const bySlug = new Map<string, ReadNode>();

  // First pass: create nodes
  for (const r of reads) {
    // If same slug appears multiple times in a session, keep latest
    bySlug.set(r.slug, { ...r, depth: 0, children: [] });
  }

  const roots: ReadNode[] = [];

  // Second pass: wire parent → child
  for (const r of reads) {
    const node = bySlug.get(r.slug)!;
    if (r.from_slug && bySlug.has(r.from_slug)) {
      bySlug.get(r.from_slug)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Third pass: compute depths
  function setDepth(node: ReadNode, d: number) {
    node.depth = d;
    for (const child of node.children) setDepth(child, d + 1);
  }
  for (const root of roots) setDepth(root, 0);

  return roots;
}

const metaCache = new Map<string, string | null>();

// Keep the in-memory cache in step with any code path that writes `meta`
// directly (savePrefs, Zotero creds, importUserData) instead of via setMeta.
// Without this, getMeta would keep serving the pre-write value for the rest of
// the session (e.g. restored custom_css / font_size silently ignored).
function cacheMeta(key: string, value: string | null): void {
  metaCache.set(key, value);
}

export async function getMeta(key: string): Promise<string | null> {
  if (metaCache.has(key)) return metaCache.get(key)!;
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?', [key]
  );
  const val = row?.value ?? null;
  metaCache.set(key, val);
  return val;
}

export async function setMeta(key: string, value: string): Promise<void> {
  metaCache.set(key, value);
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]
  );
}

export interface Prefs {
  homeMode: 'search' | 'continue';
  downloadAll: boolean;
  libraryScope: 'all' | 'sep' | 'owl';
  seedUrl: string;
}

export async function getPrefs(): Promise<Prefs> {
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

export async function savePrefs(prefs: Prefs): Promise<void> {
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

export async function toggleBookmark(slug: string, title: string): Promise<boolean> {
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
    [slug, title, Date.now()]
  );
  return true;
}

export async function isBookmarked(slug: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ slug: string }>(
    'SELECT slug FROM bookmarks WHERE slug = ?', [slug]
  );
  return !!row;
}

export async function getBookmarks(): Promise<EntrySummary[]> {
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

export async function clearArticleCache(): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE entries SET content_html = NULL, toc_html = NULL, preamble_html = NULL, cached_at = NULL'
  );
  // Clear backfill flags so they re-run against the fresh downloads on next launch.
  // Without this, articles re-downloaded with skipMath:true would be permanently
  // stored with raw TeX because backfillMathInline sees the flag and returns early.
  await db.runAsync(
    "DELETE FROM meta WHERE key IN ('math_inline_v2', 'math_hash_format_v1')"
  );
  metaCache.delete('math_inline_v2');
  metaCache.delete('math_hash_format_v1');
}

export async function getSlugsByCacheStatus(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{
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

export async function getAllUncachedSlugs(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{ slug: string; title: string }[]> {
  return (await getSlugsByCacheStatus(scope)).uncached;
}

export async function getCachedSlugs(scope: 'all' | 'sep' | 'owl' = 'all'): Promise<{ slug: string; title: string }[]> {
  return (await getSlugsByCacheStatus(scope)).cached;
}

export async function getAllEntryTitles(): Promise<{ slug: string; title: string }[]> {
  const db = await getDb();
  return db.getAllAsync<{ slug: string; title: string }>(
    `SELECT slug, title FROM entries WHERE LENGTH(title) > 3 ORDER BY LENGTH(title) DESC`
  );
}

export async function getAllEntries(): Promise<{ slug: string; title: string; parent_label: string | null }[]> {
  const db = await getDb();
  return db.getAllAsync<{ slug: string; title: string; parent_label: string | null }>(
    `SELECT slug, title, parent_label FROM entries WHERE title IS NOT NULL ORDER BY title ASC`
  );
}

// Strip the old "Parent: " prefix from reads.title / bookmarks.title now that
// parent_label is a first-class column. Called after every index sync; the WHERE
// clause is a no-op once all titles are already clean.
export async function cleanDenormalizedTitles(): Promise<void> {
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

export async function getLinkPayload(): Promise<string> {
  if (_linkCache) return _linkCache;
  const stored = await getMeta('link_index_json');
  if (stored) { _linkCache = stored; return stored; }
  // Fall back to the bundled asset (available immediately on first launch, before any sync)
  const { LINK_MAP_JSON } = await import('../assets/linkMapData');
  _linkCache = LINK_MAP_JSON;
  return _linkCache;
}

export function invalidateLinkCache(): void {
  _linkCache = null;
}

// ── Citation ─────────────────────────────────────────────────────────────────

export function formatCitation(entry: Pick<EntryRow, 'slug' | 'title' | 'author' | 'pub_date'>): string {
  const author = entry.author ?? 'Unknown';
  const date = entry.pub_date ? formatPubDate(entry.pub_date) : '';
  const url = `https://plato.stanford.edu/entries/${entry.slug}/`;
  const dateStr = date ? ` (${date})` : '';
  return `${author}. "${entry.title}". The Stanford Encyclopedia of Philosophy${dateStr}. Edward N. Zalta and Uri Nodelman (eds.). <${url}>`;
}

function formatPubDate(raw: string): string {
  const [year, month] = raw.split('/');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = parseInt(month ?? '1') - 1;
  return `${months[m] ?? ''} ${year ?? ''}`.trim();
}

// ── Article links (graph view) ────────────────────────────────────────────────

export async function indexLinks(fromSlug: string, contentHtml: string): Promise<void> {
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

export async function getLinksFrom(slug: string): Promise<EntrySummary[]> {
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

export async function getLinksTo(slug: string): Promise<EntrySummary[]> {
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

export async function updateBookmarkNotes(slug: string, notes: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE bookmarks SET notes = ? WHERE slug = ?', [notes, slug]);
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

export async function getBookmarksFull(): Promise<BookmarkRow[]> {
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
// A `meta` row therefore means "newer than, or not yet moved to, secure storage":
// the next read migrates it. Neither Zotero value is synced between devices.
const ZOTERO_API_KEY = 'zotero_api_key';
const ZOTERO_USER_ID = 'zotero_user_id';

async function readZoteroApiKey(db: SQLite.SQLiteDatabase): Promise<string> {
  const legacy = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?', [ZOTERO_API_KEY]
  );
  if (!(await secretsAvailable())) return legacy?.value ?? '';
  if (!legacy) return (await getSecret(ZOTERO_API_KEY)) ?? '';

  // One-time migration out of `meta`. Only drop the plaintext row once the secure
  // copy reads back identical; otherwise keep it and retry on the next read.
  const value = legacy.value;
  const moved = value === ''
    ? await deleteSecret(ZOTERO_API_KEY)
    : (await setSecret(ZOTERO_API_KEY, value)) && (await getSecret(ZOTERO_API_KEY)) === value;
  if (moved) {
    await db.runAsync('DELETE FROM meta WHERE key = ?', [ZOTERO_API_KEY]);
    metaCache.delete(ZOTERO_API_KEY);
  }
  return value;
}

export async function getZoteroPrefs(): Promise<{ apiKey: string; userId: string }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?', [ZOTERO_USER_ID]
  );
  return { apiKey: await readZoteroApiKey(db), userId: row?.value ?? '' };
}

export async function saveZoteroPrefs(apiKey: string, userId: string): Promise<void> {
  const db = await getDb();
  // True once the key is safely out of `meta`.
  const inSecureStore = (await secretsAvailable())
    && (apiKey ? await setSecret(ZOTERO_API_KEY, apiKey) : await deleteSecret(ZOTERO_API_KEY));
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

export async function saveAnnotation(
  slug: string,
  selectedText: string,
  context: string | null,
  color: string,
  note: string | null = null,
  currentHash: string | null = null
): Promise<Annotation> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.runAsync(
    `INSERT INTO annotations (slug, selected_text, context, note, color, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [slug, selectedText, context ?? null, note ?? null, color, currentHash ?? null, now, now]
  );
  return {
    id: result.lastInsertRowId,
    slug, selected_text: selectedText, context: context ?? null,
    note: note ?? null, color, content_hash: currentHash ?? null,
    created_at: now, updated_at: now,
  };
}

export async function updateAnnotation(
  id: number, note: string | null, color: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE annotations SET note = ?, color = ?, updated_at = ? WHERE id = ?',
    [note ?? null, color, Date.now(), id]
  );
}

export async function deleteAnnotation(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM annotations WHERE id = ?', [id]);
}

export async function getAnnotationsForSlug(slug: string): Promise<Annotation[]> {
  const db = await getDb();
  return db.getAllAsync<Annotation>(
    'SELECT * FROM annotations WHERE slug = ? ORDER BY created_at ASC', [slug]
  );
}

export interface AnnotationWithTitle extends Annotation {
  article_title: string | null;
}

export async function getAllAnnotations(): Promise<AnnotationWithTitle[]> {
  const db = await getDb();
  return db.getAllAsync<AnnotationWithTitle>(`
    SELECT a.*, e.title as article_title
    FROM annotations a
    LEFT JOIN entries e ON e.slug = a.slug
    ORDER BY a.created_at DESC
  `);
}

// ── JSON user data export / import ───────────────────────────────────────────

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

export async function exportUserData(): Promise<UserDataExport> {
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
    exported_at: Date.now(),
    reads,
    bookmarks,
    annotations,
    prefs: Object.fromEntries(metaRows.map(r => [r.key, r.value])),
  };
}

export async function importUserData(data: UserDataExport): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    // Reads: insert-or-ignore by (slug, visited_at) to avoid dupes
    for (const r of data.reads) {
      await db.runAsync(
        `INSERT OR IGNORE INTO reads (slug, title, visited_at, from_slug, session_id)
         VALUES (?, ?, ?, ?, ?)`,
        [r.slug, r.title, r.visited_at, r.from_slug ?? null, r.session_id]
      );
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
    // Annotations: upsert by id — incoming id wins on conflict
    for (const a of data.annotations) {
      await db.runAsync(
        `INSERT INTO annotations (id, slug, selected_text, context, note, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           note = COALESCE(excluded.note, note),
           color = excluded.color,
           updated_at = MAX(updated_at, excluded.updated_at)`,
        [a.id, a.slug, a.selected_text, a.context ?? null,
         a.note ?? null, a.color, a.created_at, a.updated_at]
      );
    }
    // Prefs: merge, remote wins — allowlisted keys only. Older exports contain the
    // whole `meta` table (Zotero credentials, sync folder, caches, migration
    // markers); those are ignored rather than written back.
    for (const [key, value] of Object.entries(data.prefs ?? {})) {
      if (!SYNCED_PREF_KEYS.includes(key) || typeof value !== 'string') continue;
      await db.runAsync(
        'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]
      );
      cacheMeta(key, value as string);
    }
  });
}

// ── Sync folder ──────────────────────────────────────────────────────────────

export async function getSyncFolder(): Promise<string> {
  return (await getMeta('sync_folder')) ?? '';
}

export async function setSyncFolder(path: string): Promise<void> {
  await setMeta('sync_folder', path);
}

export async function updateAnnotationAnchor(
  id: number,
  newText: string,
  newHash: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE annotations SET selected_text = ?, content_hash = ?, updated_at = ? WHERE id = ?',
    [newText, newHash, Date.now(), id]
  );
}

export async function deleteAnnotations(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(`DELETE FROM annotations WHERE id IN (${placeholders})`, ids);
}

function countWords(html: string): number {
  return html.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

// Fast djb2-style hash — enough to detect article version changes
export function contentHash(s: string): string {
  let h = 5381;
  const len = Math.min(s.length, 50000);
  for (let i = 0; i < len; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

// The article's hash for annotation anchoring. `cacheArticle` stores it in
// `entries.content_hash`, so opening an article reads it back in O(1); only rows
// cached before that column existed (null/empty) pay for a one-off rehash.
export function resolveEntryHash(entry: Pick<EntryRow, 'content_hash' | 'content_html'>): string {
  return entry.content_hash || contentHash(entry.content_html ?? '');
}
