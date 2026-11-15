// The graph tables: the SQLite adapter behind the core's GraphStore port.
//
// Decoupled from services/db.ts: this module owns the InPhO tables and creates them the first
// time each database connection is used, so the core reader DB stays unaware of the (optional)
// graph feature. The connection comes from the caller (the composition root passes db.getDb); the
// schema-ready bookkeeping is instance state. All assembly, cache lifetimes and the layout key live
// in src/core (graph.ts, graphAssembly.ts); this file only runs SQL.
//
// LICENSING: InPhO data is fetched per-client at runtime from inphoproject.org
// and cached locally, never bundled. See services/inphoSource.ts / NOTICE.md.

import type * as SQLite from 'expo-sqlite';
import { runMigrations, tableVersionStore, type Migration } from './migrations';
import type { GraphEdge, InphoNodeRow } from '../types';
import type { GraphStore, GraphEntryRow, RelationsRow, LayoutRow } from '../core/ports';

// ── Schema (owned here, created on first use) ────────────────────────────────

// Schema version lives in the shared schema_versions table under this scope
// (the core schema owns PRAGMA user_version). See services/migrations.ts.
const GRAPH_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'InPhO tables and layout cache',
    async up(db) {
      await db.execAsync(`
    -- InPhO semantic index (ideas + thinkers), synced per-client from
    -- inphoproject.org. sep_dir joins to entries.slug. See core/graph.ts.
    CREATE TABLE inpho_nodes (
      id            INTEGER NOT NULL,
      kind          TEXT NOT NULL,        -- 'idea' | 'thinker'
      label         TEXT NOT NULL,
      sep_dir       TEXT,
      birth_year    INTEGER,              -- thinkers only; filled lazily (Timeline)
      death_year    INTEGER,
      dates_checked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX idx_inpho_sep ON inpho_nodes(sep_dir);

    -- Per-entry resolved relations, cached after a one-off /idea|thinker/{id}
    -- fetch. payload = JSON { ideas, thinkers, influence? }.
    CREATE TABLE inpho_relations (
      slug       TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    -- Settled force-layout positions, keyed by article+mode+node-set hash.
    -- positions = JSON [{slug, xRel, yRel}] where xRel/yRel are 0-1 fractions
    -- of canvas dimensions so the cache survives screen rotation / device changes.
    CREATE TABLE graph_layout_cache (
      center_slug  TEXT NOT NULL,
      mode         TEXT NOT NULL,
      layout_key   INTEGER NOT NULL,
      positions    TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (center_slug, mode)
    );
  `);
    },
  },
];


const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');

export function createGraphStore(getDb: () => Promise<SQLite.SQLiteDatabase>): GraphStore {
  // Keyed by connection handle: when the database is closed and reopened (e.g. the file was
  // replaced by a seed import) the new handle must be checked again, or the tables would be
  // missing from the new file.
  const schemaByDb = new WeakMap<SQLite.SQLiteDatabase, Promise<void>>();

  // The shared DB handle with the graph schema guaranteed present.
  async function gdb(): Promise<SQLite.SQLiteDatabase> {
    const db = await getDb();
    let ready = schemaByDb.get(db);
    if (!ready) {
      ready = runMigrations(db, GRAPH_MIGRATIONS, tableVersionStore('graph')).then(() => undefined);
      schemaByDb.set(db, ready);
      // A failed migration is not cached: the next call retries it.
      ready.catch(() => { if (schemaByDb.get(db) === ready) schemaByDb.delete(db); });
    }
    await ready;
    return db;
  }

  const NODE_COLS = 'id, kind, label, sep_dir, birth_year, death_year';

  return {
    // The link graph reads only the core tables, so it does not wait for the graph schema.
    async outgoingLinks(slug, limit) {
      const db = await getDb();
      return db.getAllAsync<GraphEdge>('SELECT from_slug, to_slug FROM links WHERE from_slug = ? LIMIT ?', [slug, limit]);
    },
    async incomingLinks(slug, limit) {
      const db = await getDb();
      return db.getAllAsync<GraphEdge>('SELECT from_slug, to_slug FROM links WHERE to_slug = ? LIMIT ?', [slug, limit]);
    },
    async entriesBySlugs(slugs): Promise<GraphEntryRow[]> {
      if (slugs.length === 0) return [];
      const db = await getDb();
      return db.getAllAsync<GraphEntryRow>(
        `SELECT slug, title, read_progress FROM entries WHERE slug IN (${inList(slugs.length)})`, slugs);
    },
    async readSlugs() {
      const db = await getDb();
      return (await db.getAllAsync<{ slug: string }>('SELECT DISTINCT slug FROM reads')).map(r => r.slug);
    },

    async indexCount() {
      const db = await gdb();
      const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM inpho_nodes');
      return row?.n ?? 0;
    },

    // Lazily-backfilled birth/death years and dates_checked flags survive the replace, so a
    // quarterly refresh does not force a full date re-fetch.
    async replaceIndex(nodes) {
      const db = await gdb();
      await db.withTransactionAsync(async () => {
        const existing = await db.getAllAsync<{
          kind: string; id: number;
          birth_year: number | null; death_year: number | null; dates_checked: number;
        }>('SELECT kind, id, birth_year, death_year, dates_checked FROM inpho_nodes WHERE dates_checked = 1 OR birth_year IS NOT NULL OR death_year IS NOT NULL');
        const dateMap = new Map(existing.map(r => [`${r.kind}:${r.id}`, r]));
        await db.execAsync('DELETE FROM inpho_nodes');
        for (const n of nodes) {
          const prev = dateMap.get(`${n.kind}:${n.id}`);
          await db.runAsync(
            'INSERT INTO inpho_nodes (id, kind, label, sep_dir, birth_year, death_year, dates_checked) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [n.id, n.kind, n.label, n.sep_dir ?? null,
             prev?.birth_year ?? null, prev?.death_year ?? null, prev?.dates_checked ?? 0]
          );
        }
      });
    },

    async nodeBySep(slug) {
      const db = await gdb();
      const row = await db.getFirstAsync<InphoNodeRow>(
        `SELECT ${NODE_COLS} FROM inpho_nodes WHERE sep_dir = ?
         ORDER BY CASE kind WHEN 'idea' THEN 0 ELSE 1 END LIMIT 1`,
        [slug]
      );
      return row ?? null;
    },

    async nodesByIds(ideaIds, thinkerIds) {
      const db = await gdb();
      if (ideaIds.length === 0 && thinkerIds.length === 0) return [];
      const ideaPlace = inList(ideaIds.length) || 'NULL';
      const thinkerPlace = inList(thinkerIds.length) || 'NULL';
      return db.getAllAsync<InphoNodeRow>(
        `SELECT ${NODE_COLS} FROM inpho_nodes
         WHERE (kind = 'idea' AND id IN (${ideaPlace})) OR (kind = 'thinker' AND id IN (${thinkerPlace}))`,
        [...ideaIds, ...thinkerIds]
      );
    },

    async thinkerDatesBySep(slug) {
      const db = await gdb();
      return db.getFirstAsync<{ birth_year: number | null; death_year: number | null }>(
        `SELECT birth_year, death_year FROM inpho_nodes WHERE sep_dir = ? AND kind = 'thinker' LIMIT 1`, [slug]);
    },

    async thinkersMissingDates(ids) {
      if (ids.length === 0) return [];
      const db = await gdb();
      return db.getAllAsync<InphoNodeRow>(
        `SELECT ${NODE_COLS} FROM inpho_nodes
         WHERE kind = 'thinker' AND dates_checked = 0 AND id IN (${inList(ids.length)})`,
        ids
      );
    },

    // dates_checked = 1 even when both years are null, so a thinker with no recorded dates is not refetched.
    async setDates(id, birth, death) {
      const db = await gdb();
      await db.runAsync(
        "UPDATE inpho_nodes SET birth_year = ?, death_year = ?, dates_checked = 1 WHERE kind = 'thinker' AND id = ?",
        [birth, death, id]
      );
    },

    async relationsRows(slugs): Promise<RelationsRow[]> {
      if (slugs.length === 0) return [];
      const db = await gdb();
      return db.getAllAsync<RelationsRow>(
        `SELECT slug, payload, fetched_at FROM inpho_relations WHERE slug IN (${inList(slugs.length)})`, slugs);
    },
    async putRelations(slug, payload, fetchedAt) {
      const db = await gdb();
      await db.runAsync(
        'INSERT OR REPLACE INTO inpho_relations (slug, payload, fetched_at) VALUES (?, ?, ?)',
        [slug, payload, fetchedAt]
      );
    },

    async layoutRow(centerSlug, mode): Promise<LayoutRow | null> {
      const db = await gdb();
      return db.getFirstAsync<LayoutRow>(
        'SELECT layout_key, positions FROM graph_layout_cache WHERE center_slug = ? AND mode = ?', [centerSlug, mode]);
    },
    async putLayoutRow(centerSlug, mode, key, positions, createdAt) {
      const db = await gdb();
      await db.runAsync(
        `INSERT OR REPLACE INTO graph_layout_cache (center_slug, mode, layout_key, positions, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [centerSlug, mode, key, positions, createdAt]
      );
    },
  };
}
