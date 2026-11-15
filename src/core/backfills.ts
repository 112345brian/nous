// Use case UC-A4: the background pass that gives cached articles their AST.
// Storage and the pacing arrive through `deps`. (The one-time inline-math pass that used to sit here
// was removed upstream: articles cached without rendered math are now queued on the pending list.)
import type { ArticleMathStore, LibraryBackfillStore } from './ports';
import type { MathPriority } from '../utils/mathThrottlePolicy';
import { parseSepHtml } from '../utils/sepHtml/parse';

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
