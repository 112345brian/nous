import { InteractionManager } from 'react-native';

// Runs background work (backfills, link indexing, graph layout priming, deep sync)
// only while the reader is idle, one task at a time, so it never competes with
// article render or scrolling on the single JS thread.
//
//   schedule(key, fn)  queue a task (FIFO; a duplicate key that is still queued is ignored)
//   hold()             pause starting tasks until the returned release() is called
//                      (counted; releasing twice is harmless). Use while an article is
//                      being opened.
//   noteActivity()     push the next start back by idleMs. Call on scroll / touch.
//
// A task that is already running is never interrupted (a promise can't be paused);
// the guarantee is that no *new* task starts while held or recently active. Task
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
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface IdleScheduler {
  schedule(key: string, run: () => unknown): boolean;
  cancel(key: string): boolean;
  clear(): void;
  hold(): () => void;
  noteActivity(): void;
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

  const queue: Task[] = [];
  let holds = 0;
  let running = false;
  let timer: unknown = null;

  const blocked = () => holds > 0 || running;

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

  return {
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
    hold() {
      holds++;
      disarm();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        arm(idleMs);
      };
    },
    noteActivity() {
      if (timer !== null) arm(idleMs);
    },
    pending() {
      return queue.length;
    },
  };
}

/** App-wide instance. */
export const idleScheduler = createIdleScheduler({
  afterInteractions: cb => { InteractionManager.runAfterInteractions(cb); },
  onError: (key, err) => {
    if (__DEV__) console.warn(`[idleScheduler] ${key} failed`, err);
  },
});
