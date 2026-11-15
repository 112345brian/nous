import { InteractionManager } from 'react-native';
import {
  DEFAULT_THROTTLE_CONFIG, HoldKind, MathPriority, ThrottleConfig, mayRun,
} from '../utils/mathThrottlePolicy';

// Runs background work (backfills, link indexing, graph layout priming, deep sync)
// only while the reader is idle, one task at a time, so it never competes with
// article render or scrolling on the single JS thread.
//
//   schedule(key, fn)  queue a task (FIFO; a duplicate key that is still queued is ignored)
//   hold()             pause starting tasks until the returned release() is called
//                      (counted; releasing twice is harmless). Use while an article is
//                      being opened.
//   noteActivity()     push the next start back by idleMs. Call on scroll / touch.
//   hold(kind)         kind is 'reading' (default; article open) or 'download'
//                      (downloadAll / sync / seed import). Both stop new tasks.
//   whenMayRun(p)      cooperative yield point for a RUNNING task: resolves when the
//                      math throttle policy (src/utils/mathThrottlePolicy.ts) allows
//                      priority p ('current' | 'background'), i.e. no hold is active and
//                      the reader has been quiet long enough. Await it between units.
//   yieldThenMayRun(p) a macrotask pause (frames/touches run), then whenMayRun(p).
//
// A task that is already running is never interrupted (a promise can't be paused);
// the guarantee is that no *new* task starts while held or recently active, and that
// a task which awaits whenMayRun between units stops at the next unit boundary. Task
// errors are reported to onError and swallowed, so background failures can never
// reach a caller's catch (e.g. App.boot()'s, which would flip the phase to index_error).

export interface IdleSchedulerOptions {
  /** Quiet time required before a task may start. */
  idleMs?: number;
  /** Pause between consecutive tasks once the queue is draining. */
  gapMs?: number;
  /** Defer the actual start until animations/gestures settle. */
  afterInteractions?: (cb: () => void) => void;
  onError?: (key: string, err: unknown) => void;
  /** Policy constants for whenMayRun; defaults to DEFAULT_THROTTLE_CONFIG. */
  throttle?: Partial<ThrottleConfig>;
  /** Injected clock (ms). Defaults to Date.now. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface IdleScheduler {
  schedule(key: string, run: () => unknown): boolean;
  cancel(key: string): boolean;
  clear(): void;
  hold(kind?: HoldKind): () => void;
  noteActivity(): void;
  whenMayRun(priority: MathPriority): Promise<void>;
  yieldThenMayRun(priority: MathPriority): Promise<void>;
  pending(): number;
}

interface Task {
  key: string;
  run: () => unknown;
}

export function createIdleScheduler(opts: IdleSchedulerOptions = {}): IdleScheduler {
  const idleMs = opts.idleMs ?? 1500;
  const gapMs = opts.gapMs ?? 250;
  const afterInteractions = opts.afterInteractions ?? ((cb: () => void) => cb());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const onError = opts.onError;
  const cfg: ThrottleConfig = { ...DEFAULT_THROTTLE_CONFIG, ...opts.throttle };
  const now = opts.now ?? (() => Date.now());

  const queue: Task[] = [];
  const holdCounts: Record<HoldKind, number> = { reading: 0, download: 0 };
  const holdsTotal = () => holdCounts.reading + holdCounts.download;
  let lastActivityAt: number | null = null;
  // Callers parked in whenMayRun; woken on any hold release / activity / clear.
  const changeWaiters = new Set<() => void>();
  const notifyChange = () => { const ws = [...changeWaiters]; changeWaiters.clear(); ws.forEach(w => w()); };
  let running = false;
  let timer: unknown = null;

  const blocked = () => holdsTotal() > 0 || running;

  function disarm() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function arm(ms: number) {
    disarm();
    if (queue.length === 0 || blocked()) return;
    timer = setTimer(() => {
      timer = null;
      afterInteractions(start);
    }, ms);
  }

  function start() {
    // State may have changed while waiting for interactions to finish.
    if (blocked() || queue.length === 0) return;
    const task = queue.shift()!;
    running = true;
    Promise.resolve()
      .then(task.run)
      .catch(err => {
        try { onError?.(task.key, err); } catch { /* reporting must never throw */ }
      })
      .then(() => {
        running = false;
        arm(gapMs);
      });
  }

  const api: IdleScheduler = {
    schedule(key, run) {
      if (queue.some(t => t.key === key)) return false;
      queue.push({ key, run });
      if (timer === null) arm(idleMs);
      return true;
    },
    cancel(key) {
      const i = queue.findIndex(t => t.key === key);
      if (i < 0) return false;
      queue.splice(i, 1);
      return true;
    },
    clear() {
      queue.length = 0;
      disarm();
    },
    hold(kind: HoldKind = 'reading') {
      holdCounts[kind]++;
      lastActivityAt = now();
      disarm();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holdCounts[kind]--;
        lastActivityAt = now(); // the reader/download just finished: quiet gap starts now
        arm(idleMs);
        notifyChange();
      };
    },
    noteActivity() {
      lastActivityAt = now();
      if (timer !== null) arm(idleMs);
      notifyChange();
    },
    async whenMayRun(priority) {
      for (;;) {
        const d = mayRun(priority, { holds: holdCounts, lastActivityAt, now: now() }, cfg);
        if (d.run) return;
        const waitMs = (d as { waitMs: number }).waitMs; // repo tsconfig is non-strict: no union narrowing on `run`
        await new Promise<void>(resolve => {
          let handle: unknown = null;
          const wake = () => { if (handle !== null) clearTimer(handle); changeWaiters.delete(wake); resolve(); };
          changeWaiters.add(wake);
          // Holds report waitMs = Infinity: only a release wakes us. Quiet gaps wake by timer.
          if (Number.isFinite(waitMs)) handle = setTimer(wake, Math.max(1, waitMs));
        });
      }
    },
    async yieldThenMayRun(priority) {
      await new Promise<void>(r => setTimer(r, cfg.yieldMs));
      await api.whenMayRun(priority);
    },
    pending() {
      return queue.length;
    },
  };
  return api;
}

/** App-wide instance. */
export const idleScheduler = createIdleScheduler({
  afterInteractions: cb => { InteractionManager.runAfterInteractions(cb); },
  onError: (key, err) => {
    if (__DEV__) console.warn(`[idleScheduler] ${key} failed`, err);
  },
});
