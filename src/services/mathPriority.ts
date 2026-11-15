// App-wide wiring of the math priority model (policy: src/utils/mathThrottlePolicy.ts,
// mechanism: src/services/idleScheduler.ts). Kept out of catalog.ts so that file only
// needs one-line call sites. See docs/math-throttling.md.

import { idleScheduler } from './idleScheduler';
import { createStallDetector } from '../utils/stallDetector';
import { DEFAULT_THROTTLE_CONFIG, createSliceBudget } from '../utils/mathThrottlePolicy';
import type { MathPriority } from '../utils/mathThrottlePolicy';

export type { MathPriority };

/** Resolves once work of this priority may run (no hold, reader quiet). Never skip the await. */
export function whenMathMayRun(priority: MathPriority): Promise<void> {
  return idleScheduler.whenMayRun(priority);
}

/** A macrotask pause between units of work, then whenMathMayRun. Use at unit boundaries. */
export function yieldThenMathMayRun(priority: MathPriority): Promise<void> {
  return idleScheduler.yieldThenMayRun(priority);
}

/** Run `fn` with a 'download' hold: math (all priorities) and background tasks stay paused. */
export async function withDownloadHold<T>(fn: () => Promise<T>): Promise<T> {
  const release = idleScheduler.hold('download');
  try {
    return await fn();
  } finally {
    release();
  }
}

declare const __DEV__: boolean | undefined;
declare const performance: { now(): number } | undefined;

/**
 * Dev only: watch JS-thread stalls while `label`'s math completes and log one line
 * ("[perf] stalls <label> max=..ms >16=.. >50=.."). Returns a stop function; a no-op in release.
 * Overlapping watches share nothing: each logs its own window.
 */
export function watchStalls(label: string): () => void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return () => {};
  const d = createStallDetector({
    now: defaultNow,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
  });
  d.start();
  return () => {
    const r = d.stop();
    console.log(`[perf] stalls ${label} max=${r.maxMs}ms >16=${r.over16} >50=${r.over50} ticks=${r.ticks}`);
  };
}

/**
 * Time-slice for a synchronous-ish loop (atob, string splice, parse): call
 * `await slice.checkpoint()` once per item. When the slice budget is spent it
 * yields a macrotask and waits for the policy to allow `priority` again.
 */
export function mathSlice(priority: MathPriority | null, budgetMs = DEFAULT_THROTTLE_CONFIG.sliceBudgetMs, now: () => number = defaultNow) {
  const budget = createSliceBudget(now, budgetMs);
  return {
    async checkpoint(): Promise<void> {
      if (!budget.exhausted()) return;
      await (priority ? yieldThenMathMayRun(priority) : macrotask());
      budget.reset();
    },
  };
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** A bare macrotask pause (frames and touches run), with no policy check. */
export function macrotask(ms = DEFAULT_THROTTLE_CONFIG.yieldMs): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
