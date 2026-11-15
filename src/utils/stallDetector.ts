// Dev-only JS-thread stall detector. A repeating timer should fire every
// `intervalMs`; when the thread is busy it fires late, and the lateness is the
// stall. Pure bookkeeping: the clock and the timer functions are injected.
//
//   const d = createStallDetector({ now, setInterval, clearInterval });
//   d.start();  ...work...  const report = d.stop();
//   report = { maxMs, over16, over50, ticks }

export interface StallReport {
  /** Longest observed lateness (ms) of any tick. */
  maxMs: number;
  /** Ticks later than 16 ms (a dropped 60 fps frame). */
  over16: number;
  /** Ticks later than 50 ms (a "long task"). */
  over50: number;
  ticks: number;
}

export interface StallDetectorOptions {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  intervalMs?: number;
}

export interface StallDetector {
  start(): void;
  /** Stop and return the report; safe to call twice (second call returns the same report). */
  stop(): StallReport;
}

export function createStallDetector(opts: StallDetectorOptions): StallDetector {
  const intervalMs = opts.intervalMs ?? 8;
  let handle: unknown = null;
  let last = 0;
  let report: StallReport = { maxMs: 0, over16: 0, over50: 0, ticks: 0 };
  return {
    start() {
      if (handle !== null) return;
      report = { maxMs: 0, over16: 0, over50: 0, ticks: 0 };
      last = opts.now();
      handle = opts.setInterval(() => {
        const t = opts.now();
        const late = Math.max(0, t - last - intervalMs);
        last = t;
        report.ticks++;
        if (late > report.maxMs) report.maxMs = late;
        if (late > 16) report.over16++;
        if (late > 50) report.over50++;
      }, intervalMs);
    },
    stop() {
      if (handle !== null) {
        // A stall that is still in progress when we stop has not been seen by any
        // tick yet (the late tick is queued behind us): account for it here.
        const late = Math.max(0, opts.now() - last - intervalMs);
        if (late > report.maxMs) report.maxMs = late;
        if (late > 16) report.over16++;
        if (late > 50) report.over50++;
        opts.clearInterval(handle);
        handle = null;
      }
      return { ...report, maxMs: Math.round(report.maxMs * 10) / 10 };
    },
  };
}
