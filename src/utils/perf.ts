// Dev-only stage timing for the article load path.
//
// Pure bookkeeping: the clock and the log sink are injected, so this module
// does no I/O of its own and is trivially testable. Only the default `perf`
// instance (src/services/perf.ts) touches globals (`__DEV__`, `performance`, `console`).
//
// Usage (all calls are no-ops, and `time` just runs `fn`, when disabled):
//   perf.begin(slug);
//   const res = await perf.time(slug, 'fetch', () => fetch(...));
//   const ast = perf.timeSync(slug, 'parse', () => parseSepHtml(html));
//   perf.mark(slug, 'first-render');   // elapsed since begin
//   perf.end(slug);                    // logs one summary line

export interface PerfOptions {
  enabled: boolean;
  now: () => number;
  log: (line: string) => void;
}

export interface Perf {
  readonly enabled: boolean;
  /** Start (or restart) a trace for `key`. */
  begin(key: string): void;
  /** Time an async `fn` and add its duration to `stage`. Returns fn's result; rethrows. */
  time<T>(key: string, stage: string, fn: () => Promise<T>): Promise<T>;
  /** Synchronous variant of `time`. */
  timeSync<T>(key: string, stage: string, fn: () => T): T;
  /** Record elapsed-since-begin under `stage` (e.g. time to first render). */
  mark(key: string, stage: string): void;
  /** Log the summary line and drop the trace. No-op if there is no trace. */
  end(key: string): void;
}

interface Trace {
  startedAt: number;
  // Insertion-ordered; repeated stages are summed.
  stages: Map<string, number>;
  marks: Map<string, number>;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function createPerf(opts: PerfOptions): Perf {
  const { enabled, now, log } = opts;
  const traces = new Map<string, Trace>();

  function add(key: string, stage: string, ms: number) {
    const t = traces.get(key);
    if (!t) return;
    t.stages.set(stage, (t.stages.get(stage) ?? 0) + ms);
  }

  return {
    enabled,

    begin(key) {
      if (!enabled) return;
      traces.set(key, { startedAt: now(), stages: new Map(), marks: new Map() });
    },

    timeSync<T>(key: string, stage: string, fn: () => T): T {
      if (!enabled) return fn();
      const t0 = now();
      try {
        return fn();
      } finally {
        add(key, stage, now() - t0);
      }
    },

    async time<T>(key: string, stage: string, fn: () => Promise<T>): Promise<T> {
      if (!enabled) return fn();
      const t0 = now();
      try {
        return await fn();
      } finally {
        add(key, stage, now() - t0);
      }
    },

    mark(key, stage) {
      if (!enabled) return;
      const t = traces.get(key);
      if (!t) return;
      // Keep the first mark: a re-render must not overwrite time-to-first-render.
      if (!t.marks.has(stage)) t.marks.set(stage, now() - t.startedAt);
    },

    end(key) {
      if (!enabled) return;
      const t = traces.get(key);
      if (!t) return;
      traces.delete(key);
      const total = now() - t.startedAt;
      const parts = [`total=${round(total)}ms`];
      t.stages.forEach((ms, s) => parts.push(`${s}=${round(ms)}ms`));
      t.marks.forEach((ms, s) => parts.push(`@${s}=${round(ms)}ms`));
      log(`[perf] ${key} ${parts.join(' ')}`);
    },
  };
}
