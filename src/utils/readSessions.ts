// Pure: shaping of reading-history rows (moved out of services/db.ts).
import type { ReadRow, ReadNode, Session } from '../types';

export const SESSION_GAP_MS = 30 * 60 * 1000;

/** The session a read at `now` belongs to: the last read's session if it is recent enough, else a new one named by `now`. */
export function sessionIdFor(
  last: { visited_at: number; session_id: string } | null,
  now: number,
): string {
  return last && now - last.visited_at < SESSION_GAP_MS ? last.session_id : String(now);
}

export function buildTree(reads: ReadRow[]): ReadNode[] {
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

/** Groups rows (already ordered oldest first) by session, keeping first-seen order, newest session first. */
export function groupSessions(rows: ReadRow[]): Session[] {
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
  return sessions.reverse();
}
