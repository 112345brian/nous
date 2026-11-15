// Pure helpers for the article list. No React / RN imports so they stay testable
// in plain node and belong to the inner (I/O-free) ring.

import type { Block } from '../types';

// Which list implementation SepArticle uses. 'flatlist' is the shipping default;
// 'flashlist' is the FlashList v2 spike (see docs/library-research.md §5).
export type ListEngine = 'flatlist' | 'flashlist';

export interface HeadingRef { index: number; id: string }

// Blocks whose renderer keeps local state (image aspect ratio in Blocks.tsx, the
// measured WebView height in ArticleScreen's FallbackBlock). A recycled cell would
// show the previous item's size, so these get a unique type per index, which
// puts each in its own recycle pool, i.e. never recycled.
const NON_RECYCLABLE: ReadonlySet<Block['t']> = new Set(['image', 'unsupported']);

export function sepItemType(block: Block, index: number): string {
  return NON_RECYCLABLE.has(block.t) ? `${block.t}-${index}` : block.t;
}

// Headings that carry an id, in document order, with their block index.
export function collectHeadings(blocks: ReadonlyArray<Block>): HeadingRef[] {
  const out: HeadingRef[] = [];
  blocks.forEach((b, index) => {
    if (b.t === 'heading' && b.id) out.push({ index, id: b.id });
  });
  return out;
}

// Scroll-spy: the id of the last heading at or before `firstVisibleIndex`, or ''
// when the reader is still above the first heading. Replaces the offset-based spy,
// whose onLayout `y` is relative to the heading's parent cell, not the content.
export function activeHeadingId(headings: ReadonlyArray<HeadingRef>, firstVisibleIndex: number): string {
  let lo = 0;
  let hi = headings.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (headings[mid].index <= firstVisibleIndex) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found >= 0 ? headings[found].id : '';
}
