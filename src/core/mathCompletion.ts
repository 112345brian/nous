// The deferred-math completion pipeline (UC-C6). A freshly fetched article is cached and
// shown with its raw TeX first; equations are rendered afterwards and the article is
// rewritten with <math-i> hash references. Slugs whose math is not done yet are tracked
// in a meta key so an interrupted run resumes at the next launch (resumePendingMath).
//
// All state (the pending-update chain, the listeners, the in-flight renders) lives in the
// closure of one createMathCompletion() call, so every instance is independent and the
// pipeline can be run with fakes. The renderer and the equation store stay behind the
// injected `substitute` function.
import type { ArticleMathStore, KeyValueStore } from './ports';
import { parseSepHtml } from '../utils/sepHtml/parse';
import { hasTexSpan } from '../utils/sepMath';

export const MATH_PENDING_KEY = 'math_pending';
/** Pause between articles when resuming, so the UI thread gets a turn. */
const RESUME_YIELD_MS = 32;

export type MathReadyListener = (slug: string) => void;

export interface MathCompletionDeps {
  /** Render every equation in `html` and return it with <math-i> references (stores the SVGs). */
  substitute(html: string): Promise<string>;
  articles: ArticleMathStore;
  meta: KeyValueStore;
  sleep(ms: number): Promise<void>;
}

export interface MathCompletion {
  /** Subscribe to "this article's equations are now rendered and stored". Returns an unsubscribe function. */
  onMathReady(cb: MathReadyListener): () => void;
  /**
   * Render the equations of a cached article and rewrite it with SVG references.
   * `html` may be passed when the caller already holds it (skips a read).
   * Resolves true when the article no longer needs math work; false when the renderer
   * made no progress (it stays pending and is retried at next launch). Never rejects.
   */
  completeArticleMath(slug: string, html?: string): Promise<boolean>;
  /** Finish math for articles whose deferred render never completed. Sequential, yielding between articles. */
  resumePendingMath(): Promise<void>;
  /**
   * Record the debt first so a kill mid-render resumes at next launch, then render.
   * Does not wait. Errors stay inside the pipeline.
   */
  completeLater(slug: string, html: string): void;
}

export function createMathCompletion(deps: MathCompletionDeps): MathCompletion {
  const { substitute, articles, meta, sleep } = deps;

  let pendingChain: Promise<void> = Promise.resolve();
  const listeners = new Set<MathReadyListener>();
  const inFlight = new Map<string, Promise<boolean>>();

  function updatePending(fn: (slugs: Set<string>) => void): Promise<void> {
    // Serialized: read-modify-write on one meta row must not interleave.
    pendingChain = pendingChain.then(async () => {
      try {
        const raw = await meta.getMeta(MATH_PENDING_KEY);
        const slugs = new Set<string>(raw ? JSON.parse(raw) : []);
        fn(slugs);
        await meta.setMeta(MATH_PENDING_KEY, JSON.stringify([...slugs]));
      } catch {
        // non-fatal — worst case the slug is not retried until it is re-fetched
      }
    });
    return pendingChain;
  }

  function onMathReady(cb: MathReadyListener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }

  function completeArticleMath(slug: string, html?: string): Promise<boolean> {
    const existing = inFlight.get(slug);
    if (existing) return existing;
    const p = (async () => {
      try {
        const src = html ?? (await articles.getEntryHtml(slug));
        if (!src) return false;
        const updated = await substitute(src);
        if (updated === src) {
          // Nothing converted. Fine if there was no TeX; otherwise the renderer
          // timed out — keep it pending.
          if (hasTexSpan(src)) return false;
        } else {
          await articles.updateArticleHtml(slug, updated);
          await articles.setArticleAst(slug, JSON.stringify(parseSepHtml(updated)));
        }
        await updatePending(s => { s.delete(slug); });
        listeners.forEach(cb => { try { cb(slug); } catch { /* listener bug must not break the pipeline */ } });
        return true;
      } catch {
        return false;
      } finally {
        inFlight.delete(slug);
      }
    })();
    inFlight.set(slug, p);
    return p;
  }

  async function resumePendingMath(): Promise<void> {
    let slugs: string[] = [];
    try {
      const raw = await meta.getMeta(MATH_PENDING_KEY);
      slugs = raw ? JSON.parse(raw) : [];
    } catch {
      return;
    }
    for (const slug of slugs) {
      await sleep(RESUME_YIELD_MS);
      await completeArticleMath(slug);
    }
  }

  function completeLater(slug: string, html: string): void {
    updatePending(s => { s.add(slug); }).then(() => completeArticleMath(slug, html));
  }

  return { onMathReady, completeArticleMath, resumePendingMath, completeLater };
}
