// Use cases UC-C1 / UC-C7: fetch an article, process it and cache it.
// The network, storage, math renderer, stage timer and link index arrive through `deps`;
// nothing here reads a clock, a global or a module-level singleton.
//
// Math handling (articles with TeX only):
//   default        — cache the text now, render equations in the background and
//                    rewrite the article when done. Resolves without waiting for MathJax.
//   awaitMath      — render equations first; for bulk sync where nobody is waiting
//                    on the first paint.
//   skipMath       — leave raw TeX and queue the slug on the pending list only; no rendering
//                    is started (bulk download; the resume pass drains the list later).
//   deferPriority  — priority of the deferred render (default 'current'; prefetch passes
//                    'background' so a neighbour never competes with the reader).
import type { ArticleLibrary, ArticleMath, ArticleSource, StageTimer } from './ports';
import type { MathPriority } from '../utils/mathThrottlePolicy';
import { parseSepHtml } from '../utils/sepHtml/parse';
import { extractArticleParts, hasTex, referencesNotes, stripArticleHeader } from '../utils/sepArticlePage';

export interface CacheArticleDeps {
  source: Pick<ArticleSource, 'fetchArticleHtml' | 'fetchNotesHtml'>;
  library: ArticleLibrary;
  math: ArticleMath;
  timing: StageTimer;
  /** Wraps first mentions of other entries' titles in links. */
  linkify(html: string): string;
}

export interface CacheArticleOptions { skipMath?: boolean; awaitMath?: boolean; deferPriority?: MathPriority }

/** Resolves true when the article is cached; false on any failure (nothing is thrown). */
export async function fetchAndCacheArticle(
  deps: CacheArticleDeps,
  slug: string,
  opts: CacheArticleOptions = {},
): Promise<boolean> {
  const { source, library, math, timing } = deps;
  try {
    const html = await source.fetchArticleHtml(slug);
    if (html === null) return false;

    const parts = timing.timeSync(slug, 'extract', () => extractArticleParts(html));
    if (!parts.rawContentHtml) return false;

    const contentHtml = stripArticleHeader(parts.rawContentHtml);

    const linkedHtml = timing.timeSync(slug, 'linkify', () => deps.linkify(contentHtml));
    const hasMath = hasTex(linkedHtml);
    // Substitute math unless caller opted out (bulk download queues it on the pending list).
    const deferMath = hasMath && !opts.skipMath && !opts.awaitMath;
    const finalHtml = hasMath && !opts.skipMath && opts.awaitMath
      // awaitMath callers (the bulk sync) run under their own download hold: gating on the
      // priority model here would wait for the hold to end, so render with no priority.
      ? await timing.time(slug, 'math', () => math.substitute(linkedHtml, null))
      : linkedHtml;
    // Footnote text lives on a sibling notes.html page; fetch it so footnotes
    // resolve offline. Only when the body actually references it.
    const notesHtml = referencesNotes(finalHtml)
      ? await timing.time(slug, 'notes', () => source.fetchNotesHtml(slug))
      : null;
    // Pre-parse the AST so the reader can JSON.parse instead of re-parsing HTML.
    const content_ast = timing.timeSync(slug, 'parse+stringify', () => JSON.stringify(parseSepHtml(finalHtml)));
    await timing.time(slug, 'cache-write', () => library.cacheArticle(slug, {
      author: parts.author,
      pub_date: parts.pubDate,
      toc_html: parts.tocHtml,
      preamble_html: parts.preambleHtml,
      content_html: finalHtml,
      notes_html: notesHtml,
      content_ast,
      has_math: hasMath ? 1 : 0,
    }));
    // Index outgoing links for graph view
    library.indexLinks(slug, contentHtml).catch(() => {});
    if (deferMath) {
      // Fire-and-forget: the implementation records the debt first so a kill
      // mid-render resumes at next launch.
      math.completeLater(slug, finalHtml, opts.deferPriority ?? 'current');
    } else if (hasMath && opts.skipMath) {
      // Record the debt only; the resume pass renders it later at background priority.
      await math.queueForLater(slug);
    }
    return true;
  } catch {
    return false;
  }
}
