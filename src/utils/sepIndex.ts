// Pure: turn SEP index pages and titles into data. No I/O: callers pass HTML text in.
import type { IndexEntry } from '../types';
import { decodeEntities } from './sepPage';

/** Parse plato.stanford.edu/contents.html into entries, sorted by title. */
export function parseContentsHtml(html: string): Array<IndexEntry & { parent_label: string | null }> {
  const entries: { slug: string; title: string; parent_label: string | null }[] = [];
  const seen = new Set<string>();
  const STRONG_LINK = /href="entries\/([a-z0-9-]+)\/"><strong>([^<]+)<\/strong>/g;
  let m: RegExpExecArray | null;

  // Pass 1: parent groups — <li> HEADER \n <ul> sub-entries </ul>
  // Header may be plain text OR a linked entry
  const parentGroupRe = /<li>\s*([^\n]+)\n\s*<ul>([\s\S]*?)<\/ul>/g;
  while ((m = parentGroupRe.exec(html)) !== null) {
    const header = m[1].trim();
    const subHtml = m[2];
    const strongM = header.match(/<strong>([^<]+)<\/strong>/);
    const parentLabel = decodeEntities(strongM ? strongM[1].trim() : header.replace(/<[^>]*>/g, '').trim());
    if (!parentLabel) continue;
    // If header is a linked entry, add the parent itself (no parent_label — it IS the parent)
    const parentLink = header.match(/href="entries\/([a-z0-9-]+)\/"/);
    if (parentLink && !seen.has(parentLink[1])) {
      seen.add(parentLink[1]);
      entries.push({ slug: parentLink[1], title: parentLabel, parent_label: null });
    }
    // Add sub-entries: store only the sub-title as title, parent_label separately
    const subRe = /href="entries\/([a-z0-9-]+)\/"><strong>([^<]+)<\/strong>/g;
    let sub: RegExpExecArray | null;
    while ((sub = subRe.exec(subHtml)) !== null) {
      const slug = sub[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      entries.push({ slug, title: decodeEntities(sub[2].trim()), parent_label: parentLabel });
    }
  }

  // Pass 2: standalone entries not already captured
  STRONG_LINK.lastIndex = 0;
  while ((m = STRONG_LINK.exec(html)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ slug, title: decodeEntities(m[2].trim()), parent_label: null });
  }

  entries.sort((a, b) => a.title.localeCompare(b.title));
  return entries;
}

/** The JSON stored under meta key `link_index_json`: the longest (at most 700) titles as link patterns. */
export function buildLinkIndexPayload(entries: { slug: string; title: string }[]): string {
  return JSON.stringify(
    entries.slice(0, 700).map(e => ({
      s: e.slug,
      t: e.title,
      p: e.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    }))
  );
}
