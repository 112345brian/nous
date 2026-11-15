// Use case UC-A4: one-time background passes over articles that are already cached.
// Storage, the renderer, the pacing and the pending-math resume arrive through `deps`.
import type { ArticleMathStore, KeyValueStore, LibraryBackfillStore } from './ports';
import type { MathPriority } from '../utils/mathThrottlePolicy';
import { parseSepHtml } from '../utils/sepHtml/parse';

/** Meta key set once the inline-math pass has run. */
export const MATH_INLINE_DONE_KEY = 'math_inline_v2';

export interface BackfillMathInlineDeps {
  /** Finishes deferred per-article math from a previous run (the math-completion pipeline). */
  resumePendingMath(): Promise<void>;
  meta: KeyValueStore;
  library: Pick<LibraryBackfillStore, 'getMathArticleHtml'>;
  articles: Pick<ArticleMathStore, 'getEntryHtml' | 'updateArticleHtml'>;
  /** Render every equation in `html`; resolves to the HTML with <math-i> references. */
  substitute(html: string, priority: MathPriority): Promise<string>;
  /** A pause between units of work, then wait until background work may run. */
  pause(priority: MathPriority): Promise<void>;
}

// Runs substitute on all already-cached math articles so their stored content_html has SVGs
// instead of raw TeX. Runs entirely from the local database: no network. Guarded by a meta key.
export async function backfillMathInline(deps: BackfillMathInlineDeps): Promise<void> {
  // Finish any deferred per-article math from a previous run first.
  await deps.resumePendingMath().catch(() => {});
  // v2: v1 ran before the WebView renderer existed and converted nothing
  // (MathJax can't run on Hermes), so re-run once against the real renderer.
  const done = await deps.meta.getMeta(MATH_INLINE_DONE_KEY);
  if (done) return;
  const articles = await deps.library.getMathArticleHtml();
  for (const article of articles) {
    await deps.pause('background');
    try {
      // Re-read: the snapshot above may be hours old if we were paused, and a
      // reader-triggered completion may have rewritten this article since.
      const current = (await deps.articles.getEntryHtml(article.slug)) ?? article.content_html;
      const updated = await deps.substitute(current, 'background');
      if (updated !== current) {
        await deps.articles.updateArticleHtml(article.slug, updated);
      }
    } catch {
      // non-fatal — article will fall back to legacy monospace TeX
    }
  }
  await deps.meta.setMeta(MATH_INLINE_DONE_KEY, '1');
}

export interface BackfillAstDeps {
  library: Pick<LibraryBackfillStore, 'getUncachedAstSlugs'>;
  articles: Pick<ArticleMathStore, 'getEntryHtml' | 'setArticleAst'>;
  pause(priority: MathPriority): Promise<void>;
}

// Pre-parses the AST for all cached articles that don't have one yet (articles cached before
// that feature, or rewritten by a math update).
export async function backfillAst(deps: BackfillAstDeps): Promise<void> {
  const slugs = await deps.library.getUncachedAstSlugs();
  for (const slug of slugs) {
    // One article per unit: yield a macrotask, and stop while the reader is
    // active or a download is running (the work list is re-derived from the DB).
    await deps.pause('background');
    try {
      const html = await deps.articles.getEntryHtml(slug);
      if (!html) continue;
      const ast = JSON.stringify(parseSepHtml(html));
      await deps.articles.setArticleAst(slug, ast);
    } catch { }
  }
}
