// Reads sync helpers. Kept free of expo imports so they run against plain SQLite in tests.
//
// A read's cross-device identity is (slug, visited_at, session_id). The table had
// no unique constraint, so the old `INSERT OR IGNORE` never ignored anything and
// every import duplicated every read.
import type { SqlRunner } from './annotationMerge';

/** Removes duplicate reads left by the old import, keeping the oldest row of each. */
export const READS_DEDUPE_SQL = `
  DELETE FROM reads
   WHERE id NOT IN (SELECT MIN(id) FROM reads GROUP BY slug, visited_at, session_id)`;

export const READS_UNIQUE_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_reads_identity ON reads(slug, visited_at, session_id)';

export interface ImportedRead {
  slug?: string;
  title?: string | null;
  visited_at?: number;
  from_slug?: string | null;
  session_id?: string;
}

/** Returns true if a new row was inserted, false if it was a duplicate or invalid. */
export async function mergeRead(db: SqlRunner, r: ImportedRead): Promise<boolean> {
  if (!r || typeof r.slug !== 'string' || !r.slug
      || typeof r.visited_at !== 'number' || !Number.isFinite(r.visited_at)
      || typeof r.session_id !== 'string' || !r.session_id) {
    return false;
  }
  const res = (await db.runAsync(
    `INSERT OR IGNORE INTO reads (slug, title, visited_at, from_slug, session_id)
     VALUES (?, ?, ?, ?, ?)`,
    [r.slug, r.title || r.slug, r.visited_at, r.from_slug ?? null, r.session_id]
  )) as { changes?: number } | undefined;
  return (res?.changes ?? 0) > 0;
}
