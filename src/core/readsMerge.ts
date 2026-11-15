// Reads sync helpers. Core: the database comes in as a SqlRunner port.
//
// A read's cross-device identity is (slug, visited_at, session_id). The unique index
// on those columns (READS_UNIQUE_INDEX_SQL in services/coreMigrations.ts) is what lets `INSERT OR IGNORE` ignore a
// read that is already present.
import type { SqlRunner } from './ports';

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
