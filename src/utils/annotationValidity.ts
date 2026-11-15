import type { Annotation } from '../types';

// Split an article's annotations into those still anchored in the current text
// and those orphaned by an article update.
//
// An annotation is valid when it has no recorded hash, when its hash matches
// the article's current hash (the cheap, common case), or — if the hash differs —
// when its selected text still appears in the article. The full-HTML scan is
// therefore only paid for annotations whose hash differs, and `getHtml` is
// never called when every annotation is resolved by hash alone.
export function partitionAnnotations<T extends Pick<Annotation, 'content_hash' | 'selected_text'>>(
  anns: T[],
  currentHash: string,
  getHtml: () => string,
): { valid: T[]; stale: T[] } {
  const valid: T[] = [];
  const stale: T[] = [];
  let html: string | null = null;
  for (const a of anns) {
    if (!a.content_hash || a.content_hash === currentHash) {
      valid.push(a);
      continue;
    }
    if (html === null) html = getHtml();
    (html.includes(a.selected_text) ? valid : stale).push(a);
  }
  return { valid, stale };
}
