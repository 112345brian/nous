// How equation rendering paces itself (policy: utils/mathThrottlePolicy.ts, mechanism:
// core/idleScheduler.ts). One instance is built in src/composition.ts around the app-wide
// scheduler; the timer and the clock are parameters. See docs/math-throttling.md.
import type { IdleScheduler } from './idleScheduler';
import { DEFAULT_THROTTLE_CONFIG, createSliceBudget } from '../utils/mathThrottlePolicy';
import type { MathPriority } from '../utils/mathThrottlePolicy';

export type { MathPriority };

export interface MathPacingDeps {
  scheduler: Pick<IdleScheduler, 'whenMayRun' | 'yieldThenMayRun' | 'hold'>;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** A high-resolution clock (ms) for time slices. */
  now: () => number;
}

export interface MathSlice {
  /** Call once per item of a long synchronous-ish loop: yields when the slice budget is spent. */
  checkpoint(): Promise<void>;
}

export interface MathPacing {
  /** Resolves once work of this priority may run (no hold, reader quiet). Never skip the await. */
  whenMathMayRun(priority: MathPriority): Promise<void>;
  /** A macrotask pause between units of work, then whenMathMayRun. Use at unit boundaries. */
  yieldThenMathMayRun(priority: MathPriority): Promise<void>;
  /** Run `fn` with a 'download' hold: math (all priorities) and background tasks stay paused. */
  withDownloadHold<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Time-slice for a synchronous-ish loop (atob, string splice, parse): call
   * `await slice.checkpoint()` once per item. When the slice budget is spent it yields a
   * macrotask and waits for the policy to allow `priority` again (null = just yield).
   */
  mathSlice(priority: MathPriority | null, budgetMs?: number): MathSlice;
  /** A bare macrotask pause (frames and touches run), with no policy check. */
  macrotask(ms?: number): Promise<void>;
}

export function createMathPacing(deps: MathPacingDeps): MathPacing {
  const { scheduler, setTimer, now } = deps;

  const whenMathMayRun = (priority: MathPriority) => scheduler.whenMayRun(priority);
  const yieldThenMathMayRun = (priority: MathPriority) => scheduler.yieldThenMayRun(priority);
  const macrotask = (ms: number = DEFAULT_THROTTLE_CONFIG.yieldMs) => new Promise<void>(r => { setTimer(r, ms); });

  async function withDownloadHold<T>(fn: () => Promise<T>): Promise<T> {
    const release = scheduler.hold('download');
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function mathSlice(priority: MathPriority | null, budgetMs: number = DEFAULT_THROTTLE_CONFIG.sliceBudgetMs): MathSlice {
    const budget = createSliceBudget(now, budgetMs);
    return {
      async checkpoint(): Promise<void> {
        if (!budget.exhausted()) return;
        await (priority ? yieldThenMathMayRun(priority) : macrotask());
        budget.reset();
      },
    };
  }

  return { whenMathMayRun, yieldThenMathMayRun, withDownloadHold, mathSlice, macrotask };
}
