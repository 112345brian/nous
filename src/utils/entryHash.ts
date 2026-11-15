import type { EntryRow } from '../types';
import { contentHash } from './contentHash';

/**
 * The hash that identifies the version of an article a highlight was made against: the stored
 * hash, or one computed from the body for rows cached before hashes were stored.
 * (Same rule as resolveEntryHash in services/db.ts; kept here so the core can use it.)
 */
export function resolveEntryHash(entry: Pick<EntryRow, 'content_hash' | 'content_html'>): string {
  return entry.content_hash || contentHash(entry.content_html ?? '');
}
