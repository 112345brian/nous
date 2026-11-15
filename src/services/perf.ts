// The app's default timing instance. This is the one place that reads the globals
// (`__DEV__`, `performance`, `console`); the logic lives in src/utils/perf.ts, which
// takes the clock and the log sink as parameters.
import { createPerf, type Perf } from '../utils/perf';

declare const __DEV__: boolean | undefined;
declare const performance: { now(): number } | undefined;

const clock: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/** Default instance: on only in dev builds (`__DEV__`), silent in release. */
export const perf: Perf = createPerf({
  enabled: typeof __DEV__ !== 'undefined' && !!__DEV__,
  now: clock,
  log: line => console.log(line),
});
