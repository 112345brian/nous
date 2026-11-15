import type { EntrySummary } from '../types';

/** Recent reads that are not already in the reading list (those are shown there). */
export function recentWithoutBookmarks(history: EntrySummary[], bookmarks: Pick<EntrySummary, 'slug'>[]): EntrySummary[] {
  const marked = new Set(bookmarks.map(b => b.slug));
  return history.filter(h => !marked.has(h.slug));
}

/** The progress that "mark as read / unread" sets from the current one. */
export function toggledReadProgress(current: number | null | undefined): number {
  return (current ?? 0) >= 1 ? 0 : 1;
}
