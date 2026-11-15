// Dev-only: watch JS-thread stalls while a unit of math work completes, and log one line
// ("[perf] stalls <label> max=..ms >16=.. >50=.."). A no-op in release. This is an adapter on
// purpose: it reads __DEV__, performance, setInterval and console. The detector itself is the
// pure utils/stallDetector.ts.
import { createStallDetector } from '../utils/stallDetector';

declare const __DEV__: boolean | undefined;
declare const performance: { now(): number } | undefined;

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** Start watching; returns the function that stops the watch and logs the result. */
export function watchStalls(label: string): () => void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return () => {};
  const d = createStallDetector({
    now,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
  });
  d.start();
  return () => {
    const r = d.stop();
    console.log(`[perf] stalls ${label} max=${r.maxMs}ms >16=${r.over16} >50=${r.over50} ticks=${r.ticks}`);
  };
}

/** A high-resolution clock for time slices. */
export const highResNow = now;
