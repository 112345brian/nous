// Priority policy for math rendering. Pure: no I/O, no timers, no globals; the
// caller passes the clock reading in. See docs/math-throttling.md.
//
// Priorities, highest first:
//   1 reading     hold: opening/rendering an article (a `reading` hold)
//                 and scroll/touch (recorded as activity)
//   2 download    hold: downloadAll / syncCachedArticles / seed import
//   3 current     math for the article on screen: runs only after a short quiet gap
//   4 background  backfills, resume-pending, AST backfill: runs only after a long quiet gap
//
// Holds block both math priorities. Activity blocks them until the quiet gap
// has passed; the gap is longer for background work so the current article
// always wins the first quiet moment.

export type MathPriority = 'current' | 'background';
export type HoldKind = 'reading' | 'download';

export interface ThrottleConfig {
  /** Quiet time after the last reader activity before current-article math may run. */
  currentQuietMs: number;
  /** Same, for background math and backfills. */
  backgroundQuietMs: number;
  /** Macrotask pause between units of work, so frames and touch events get the thread. */
  yieldMs: number;
  /** Equations per WebView message. Bounds the one batch that cannot be cancelled. */
  chunkSize: number;
  /** Max JS-thread time (ms) for post-processing (atob, string splice, parse) before yielding. */
  sliceBudgetMs: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  currentQuietMs: 400,
  backgroundQuietMs: 1500,
  yieldMs: 16,
  chunkSize: 24,
  sliceBudgetMs: 8,
};

export interface ThrottleState {
  /** Number of active holds per kind. */
  holds: Readonly<Record<HoldKind, number>>;
  /** Clock reading of the last reader activity (scroll, touch, hold taken or released); null = none yet. */
  lastActivityAt: number | null;
  now: number;
}

export type Decision =
  | { run: true }
  | { run: false; blockedBy: HoldKind; waitMs: typeof Infinity }
  | { run: false; blockedBy: 'quiet'; waitMs: number };

/** May work of priority `p` run right now? If not, why, and how long until the answer can change by itself. */
export function mayRun(p: MathPriority, s: ThrottleState, cfg: ThrottleConfig = DEFAULT_THROTTLE_CONFIG): Decision {
  // Highest-priority blocker is reported first.
  if (s.holds.reading > 0) return { run: false, blockedBy: 'reading', waitMs: Infinity };
  if (s.holds.download > 0) return { run: false, blockedBy: 'download', waitMs: Infinity };
  if (s.lastActivityAt !== null) {
    const quiet = p === 'current' ? cfg.currentQuietMs : cfg.backgroundQuietMs;
    const remaining = s.lastActivityAt + quiet - s.now;
    if (remaining > 0) return { run: false, blockedBy: 'quiet', waitMs: remaining };
  }
  return { run: true };
}

/** Half-open index ranges [start, end) covering 0..n in pieces of at most `size`. */
export function chunkRanges(n: number, size: number): Array<[number, number]> {
  const step = Math.max(1, Math.floor(size) || 1);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i += step) out.push([i, Math.min(n, i + step)]);
  return out;
}

export interface SliceBudget {
  /** True once the current slice has used up its budget. */
  exhausted(): boolean;
  /** Start a new slice (call after yielding). */
  reset(): void;
}

/** Tracks JS-thread time used since the last yield. The clock is injected. */
export function createSliceBudget(now: () => number, budgetMs: number): SliceBudget {
  let start = now();
  return {
    exhausted: () => now() - start >= budgetMs,
    reset: () => { start = now(); },
  };
}
