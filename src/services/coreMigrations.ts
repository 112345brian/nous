// The core schema (sep.db), as an ordered list of versioned steps.
// See migrations.ts for how steps are applied. Never edit or reorder a released
// step; append a new one and bump nothing else (the version is the list length).

// Derived-content invalidation: to make cached articles re-process (stored
// HTML/AST changed in a user-visible way), append a step that clears the derived
// column (e.g. `UPDATE entries SET content_ast = NULL`) and records the new
// `ast_parser_version` in the meta table, guarded on that value so it is a no-op
// when already applied. The initial step records version 2 (the current parser).

import type { Migration } from '../core/migrations';

export const READS_UNIQUE_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_reads_identity ON reads(slug, visited_at, session_id)';

// The initial schema (version 1): final tables, columns, FTS table and indexes.
//
// NOTE: the InPhO semantic-graph tables (inpho_nodes, inpho_relations) are
// owned by services/graphDb.ts, which creates them lazily with its own
// versioned migrations the first time the graph feature is used. Keeping that
// schema out of the core reader DB keeps the graph an optional, self-contained
// module.
const SCHEMA_V1_SQL = `
    CREATE TABLE entries (
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
      cached_at    INTEGER,
      has_math     INTEGER DEFAULT 0,
      content_ast  TEXT
    );

    CREATE TABLE reads (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL,
      title      TEXT NOT NULL,
      visited_at INTEGER NOT NULL,
      from_slug  TEXT,
      session_id TEXT NOT NULL
    );

    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE bookmarks (
      slug      TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      saved_at  INTEGER NOT NULL,
      notes     TEXT
    );

    CREATE TABLE links (
      from_slug TEXT NOT NULL,
      to_slug   TEXT NOT NULL,
      PRIMARY KEY (from_slug, to_slug)
    );

    CREATE INDEX idx_links_to_slug ON links(to_slug);

    CREATE TABLE article_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      cached_at    INTEGER NOT NULL,
      UNIQUE(slug, content_hash)
    );

    CREATE TABLE annotations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uid           TEXT,
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
    CREATE TABLE math (
      hash TEXT PRIMARY KEY,
      svg  TEXT NOT NULL,
      w    REAL,
      h    REAL,
      d    INTEGER NOT NULL DEFAULT 0
    );

`;

// Each index is here because EXPLAIN QUERY PLAN against the real schema showed a
// full scan, a temp b-tree, or a per-query AUTOMATIC index without it:
//   idx_reads_visited          recordRead's "latest read" lookup, run on every
//                              article open (was SCAN + temp b-tree sort)
//   idx_reads_session_visited  getSessions: pick the newest sessions and load
//                              just their rows (covering scan, then SEARCH)
//   idx_reads_slug             getRecentSlugs grouping, the graph's
//                              EXISTS/DISTINCT over reads, and the title cleanup
//   idx_annotations_slug       annotations by slug (+ created_at order) and the
//                              per-row annotation_count subqueries
// Not added: entries(source) / entries(cached_at). The scope queries must visit
// every row to count or partition, so an index on a 3-value column changes
// nothing (plans checked).
const QUERY_INDEXES = [
  'CREATE INDEX idx_reads_visited ON reads(visited_at)',
  'CREATE INDEX idx_reads_session_visited ON reads(session_id, visited_at)',
  'CREATE INDEX idx_reads_slug ON reads(slug)',
  'CREATE INDEX idx_annotations_slug ON annotations(slug, created_at)',
];

// Cross-device identity (sync): integer ids are device-local, so annotations carry a
// uid and a read is identified by (slug, visited_at, session_id). Both are unique so
// importing the same file twice cannot duplicate rows (see annotationMerge.ts,
// readsMerge.ts).
const IDENTITY_INDEXES = [
  'CREATE UNIQUE INDEX idx_annotations_uid ON annotations(uid)',
  READS_UNIQUE_INDEX_SQL,
];

const FTS_SQL = `
    CREATE VIRTUAL TABLE entries_fts USING fts5(
      slug UNINDEXED,
      title,
      tokenize='porter ascii'
    )
`;

export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    async up(db) {
      await db.execAsync(SCHEMA_V1_SQL);
      await db.execAsync(FTS_SQL);
      for (const sql of QUERY_INDEXES) await db.runAsync(sql);
      for (const sql of IDENTITY_INDEXES) await db.runAsync(sql);
      await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['ast_parser_version', '2']);
    },
  },
];

export const LATEST_CORE_SCHEMA_VERSION = CORE_MIGRATIONS.length;
