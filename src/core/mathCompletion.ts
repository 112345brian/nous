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
import type { MathPriority } from '../utils/mathThrottlePolicy';
import { parseSepHtml } from '../utils/sepHtml/parse';
import { hasTexSpan } from '../utils/sepMath';

export const MATH_PENDING_KEY = 'math_pending';
export type MathReadyListener = (slug: string) => void;

export interface MathCompletionDeps {
  /** Render every equation in `html` and return it with <math-i> references (stores the SVGs). */
  substitute(html: string, priority: MathPriority): Promise<string>;
  articles: ArticleMathStore;
  meta: KeyValueStore;
  /**
   * A pause between units of background work, then wait until work of this priority may run
   * (the reader is quiet, no download hold). The wrapper passes the priority model's
   * yieldThenMathMayRun, so resuming yields to reading.
   */
  pause(priority: MathPriority): Promise<void>;
  /** Dev-only: start watching a unit of work for stalls; returns the function that stops the watch. */
  watchStall?(label: string): () => void;
}

export interface MathCompletion {
  /** Subscribe to "this article's equations are now rendered and stored". Returns an unsubscribe function. */
  onMathReady(cb: MathReadyListener): () => void;
  /**
   * Render the equations of a cached article and rewrite it with SVG references.
   * `html` may be passed when the caller already holds it (skips a read).
   * Resolves true when the article no longer needs math work; false when the renderer
   * made no progress (it stays pending and is retried at next launch). Never rejects.
   * `priority` defaults to 'current' (the reader is waiting on this article).
   */
  completeArticleMath(slug: string, html?: string, priority?: MathPriority): Promise<boolean>;
  /** Finish math for articles whose deferred render never completed. Sequential, yielding between articles. */
  resumePendingMath(): Promise<void>;
  /**
   * Record the debt first so a kill mid-render resumes at next launch, then render.
   * Does not wait. Errors stay inside the pipeline.
   */
  completeLater(slug: string, html: string): void;
}

export function createMathCompletion(deps: MathCompletionDeps): MathCompletion {
  const { substitute, articles, meta, pause, watchStall } = deps;

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

  function completeArticleMath(slug: string, html?: string, priority: MathPriority = 'current'): Promise<boolean> {
    const existing = inFlight.get(slug);
    if (existing) return existing;
    const stopWatch = watchStall?.(`math:${slug}`);
    const p = (async () => {
      try {
        const src = html ?? (await articles.getEntryHtml(slug));
        if (!src) return false;
        const updated = await substitute(src, priority);
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
        stopWatch?.();
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
      // One article per unit; stops here (the slug stays pending) while the reader is active.
      await pause('background');
      await completeArticleMath(slug, undefined, 'background');
    }
  }

  function completeLater(slug: string, html: string): void {
    updatePending(s => { s.add(slug); }).then(() => completeArticleMath(slug, html));
  }

  return { onMathReady, completeArticleMath, resumePendingMath, completeLater };
}
