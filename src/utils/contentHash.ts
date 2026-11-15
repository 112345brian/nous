// Pure: cheap content fingerprint, used to detect article version changes.
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
export function resolveEntryHash(entry: { content_hash?: string | null; content_html?: string | null }): string {
  return entry.content_hash || contentHash(entry.content_html ?? '');
}
