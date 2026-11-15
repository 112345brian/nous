// Merge one imported annotation into the local table.
//
// Kept free of expo imports so it can be unit-tested against a plain SQLite.
// Annotation integer ids are device-local autoincrements, so they must NEVER be
// used to match records across devices — `uid` is the cross-device identity.

export interface SqlRunner {
  runAsync(sql: string, params?: any[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params?: any[]): Promise<T | null>;
}

/** Shape read from a sync file; every field but the text may be missing (v1 files, partial objects). */
export interface ImportedAnnotation {
  uid?: string | null;
  slug?: string;
  selected_text?: string;
  context?: string | null;
  note?: string | null;
  color?: string | null;
  content_hash?: string | null;
  created_at?: number;
  updated_at?: number;
}

/** Random 128-bit hex id; crypto.randomUUID is not guaranteed on Hermes. */
export function newUid(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return s;
}

/** Returns true if a row was inserted or updated, false if skipped (invalid or older). */
export async function mergeAnnotation(db: SqlRunner, a: ImportedAnnotation): Promise<boolean> {
  if (!a || typeof a.slug !== 'string' || !a.slug || typeof a.selected_text !== 'string' || !a.selected_text) {
    return false;
  }
  const created = typeof a.created_at === 'number' ? a.created_at : Date.now();
  const updated = typeof a.updated_at === 'number' ? a.updated_at : created;
  const color = a.color || '#FFE566';

  // Resolve the local row: by uid, else (v1 files) by slug + text + created_at.
  let existing = a.uid
    ? await db.getFirstAsync<{ id: number; updated_at: number }>(
        'SELECT id, updated_at FROM annotations WHERE uid = ?', [a.uid])
    : null;
  if (!existing) {
    existing = await db.getFirstAsync<{ id: number; updated_at: number }>(
      'SELECT id, updated_at FROM annotations WHERE slug = ? AND selected_text = ? AND created_at = ?',
      [a.slug, a.selected_text, created]);
  }

  if (!existing) {
    await db.runAsync(
      `INSERT INTO annotations
         (uid, slug, selected_text, context, note, color, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.uid || newUid(), a.slug, a.selected_text, a.context ?? null, a.note ?? null,
       color, a.content_hash ?? null, created, updated]);
    return true;
  }

  // Last writer wins on the whole mutable record (a cleared note must propagate).
  if (updated <= existing.updated_at) return false;
  await db.runAsync(
    `UPDATE annotations
        SET selected_text = ?, context = ?, note = ?, color = ?, content_hash = ?,
            updated_at = ?, uid = COALESCE(uid, ?)
      WHERE id = ?`,
    [a.selected_text, a.context ?? null, a.note ?? null, color, a.content_hash ?? null,
     updated, a.uid ?? null, existing.id]);
  return true;
}
