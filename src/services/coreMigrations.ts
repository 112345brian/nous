// The core schema (sep.db), as an ordered list of versioned steps.
// See migrations.ts for how steps are applied. Never edit or reorder a released
// step; append a new one and bump nothing else (the version is the list length).

import type { SQLiteDatabase } from 'expo-sqlite';
import { addColumnIfMissing, type Migration } from './migrations';

// Everything that existed before schema versioning: the original tables, plus
// the columns later releases added with ALTER TABLE. Adopts installs created
// by any earlier release (user_version = 0): tables use IF NOT EXISTS and
// only a duplicate-column error is ignored when adding columns.
//
// NOTE: the InPhO semantic-graph tables (inpho_nodes, inpho_relations) are
// owned by services/graphDb.ts, which creates them lazily with its own
// versioned migrations the first time the graph feature is used. Keeping that
// schema out of the core reader DB keeps the graph an optional, self-contained
// module.
const SCHEMA_V1_SQL = `
    CREATE TABLE IF NOT EXISTS entries (
      slug         TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      parent_label TEXT,
      source       TEXT NOT NULL DEFAULT 'sep',
      author       TEXT,
      pub_date     TEXT,
      content_hash TEXT,
      toc_html     TEXT,
      preamble_html TEXT,
      content_html TEXT,
      notes_html   TEXT,
      word_count   INTEGER DEFAULT 0,
      read_progress REAL DEFAULT 0,
      excerpt      TEXT,
      cached_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS reads (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL,
      title      TEXT NOT NULL,
      visited_at INTEGER NOT NULL,
      from_slug  TEXT,
      session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      slug      TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      saved_at  INTEGER NOT NULL,
      notes     TEXT
    );

    CREATE TABLE IF NOT EXISTS links (
      from_slug TEXT NOT NULL,
      to_slug   TEXT NOT NULL,
      PRIMARY KEY (from_slug, to_slug)
    );

    CREATE INDEX IF NOT EXISTS idx_links_to_slug ON links(to_slug);

    CREATE TABLE IF NOT EXISTS article_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      cached_at    INTEGER NOT NULL,
      UNIQUE(slug, content_hash)
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT NOT NULL,
      selected_text TEXT NOT NULL,
      context       TEXT,
      note          TEXT,
      color         TEXT NOT NULL DEFAULT '#FFE566',
      content_hash  TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- NOTE: the InPhO semantic-graph tables (inpho_nodes, inpho_relations) are
    -- owned by services/graphDb.ts, which lazily creates them the first time the
    -- graph feature is used. Keeping that schema out of the core reader DB keeps
    -- the graph an optional, self-contained module.

    -- Client-rendered math cache. Each row is a TeX equation rendered to SVG
    -- ON THIS DEVICE (mathStore.ts / texToSvg.ts) from article TeX the user
    -- fetched. This is a runtime artifact and is NEVER bundled or shipped — see
    -- NOTICE.md. hash = mathStore.mathHash(tex, display); d = display flag.
    CREATE TABLE IF NOT EXISTS math (
      hash TEXT PRIMARY KEY,
      svg  TEXT NOT NULL,
      w    REAL,
      h    REAL,
      d    INTEGER NOT NULL DEFAULT 0
    );

`;

const SCHEMA_V1_COLUMNS: ReadonlyArray<readonly [table: string, columnDef: string]> = [
  ['entries', 'pub_date TEXT'],
  ['entries', 'content_hash TEXT'],
  ['bookmarks', 'notes TEXT'],
  ['annotations', 'content_hash TEXT'],
  ['entries', 'read_progress REAL DEFAULT 0'],
  ['entries', 'excerpt TEXT'],
  ['entries', 'parent_label TEXT'],
  ['entries', "source TEXT NOT NULL DEFAULT 'sep'"],
  ['entries', 'has_math INTEGER DEFAULT 0'],
  ['entries', 'content_ast TEXT'],
  ['entries', 'notes_html TEXT'],
];

async function metaValue(db: SQLiteDatabase, key: string): Promise<string | undefined> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  return row?.value;
}

export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline schema (tables and columns that predate versioning)',
    async up(db) {
      await db.execAsync(SCHEMA_V1_SQL);
      for (const [table, columnDef] of SCHEMA_V1_COLUMNS) {
        await addColumnIfMissing(db, table, columnDef);
      }
    },
  },
  {
    // Clear articles cached before the preamble_html column existed so they
    // re-fetch with the corrected parser (title/preamble no longer embedded in
    // content_html). Guarded by its original meta flag: installs that already
    // ran it must not lose their cache a second time.
    version: 2,
    name: 'clear cache from before preamble_html',
    async up(db) {
      if (await metaValue(db, 'migrated_clear_cache_v2')) return;
      await db.runAsync(
        `UPDATE entries SET content_html = NULL, preamble_html = NULL, toc_html = NULL,
         excerpt = NULL, cached_at = NULL WHERE cached_at IS NOT NULL`,
      );
      await db.runAsync(`INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_clear_cache_v2', '1')`);
    },
  },
  {
    // Parser version 2: the native HTML parser changed the stored AST in a
    // user-visible way (bracket-free footnote refs -> fnref). Clearing
    // content_ast forces cached articles to re-parse with the current parser
    // on next open, rather than rendering a stale AST frozen at download time.
    // To invalidate ASTs again, append a new step that does the same.
    version: 3,
    name: 're-parse cached ASTs (parser version 2)',
    async up(db) {
      if ((await metaValue(db, 'ast_parser_version')) === '2') return;
      await db.runAsync('UPDATE entries SET content_ast = NULL');
      await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['ast_parser_version', '2']);
    },
  },
  {
    // Move FTS from a content-table index to a standalone one (titles only).
    version: 4,
    name: 'standalone FTS index',
    async up(db) {
      const info = await db.getFirstAsync<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='entries_fts'",
      );
      const needsCreate = !info || info.sql?.includes("content='entries'");
      if (!needsCreate) return;
      await db.runAsync('DROP TABLE IF EXISTS entries_fts');
      await db.runAsync(`
        CREATE VIRTUAL TABLE entries_fts USING fts5(
          slug UNINDEXED,
          title,
          tokenize='porter ascii'
        )
      `);
      await db.runAsync('INSERT INTO entries_fts(slug, title) SELECT slug, title FROM entries');
    },
  },
];

export const LATEST_CORE_SCHEMA_VERSION = CORE_MIGRATIONS.length;
