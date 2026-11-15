// The ONE place that connects prewarmCommonMath to the real app: db, catalog's
// hash, the WebView renderer and the idle scheduler. App.tsx calls
// scheduleCommonMathPrewarm() once after first launch's essential work.
//
// Scheduling (plain scheduler API on this branch): each chunk is its own
// scheduler task that re-schedules the next one, so the scheduler's hold() /
// noteActivity() gates EVERY chunk (never during an article open or a scroll).
// TO SWITCH to the priority API (math-throttle branch: whenMayRun /
// yieldThenMayRun, MathPriority 'background'): schedule ONE task and pass
//   beforeChunk: () => idleScheduler.yieldThenMayRun('background')
// to prewarmCommonMath instead of maxChunks:1 + rescheduling (see the
// "PRIORITY SWITCH" note below). Nothing else changes.

import { COMMON_MATH, commonMathStamp } from '../data/commonMath';
import { getMeta, getMathSvgMap, putMathBatch, setMeta } from './db';
import { mathHash } from './catalog';
import { renderMathBatch } from './mathRender';
import { idleScheduler } from './idleScheduler';
import { prewarmCommonMath, PrewarmDeps } from './prewarmCommonMath';

export const COMMON_MATH_META_KEY = 'common_math_prewarm';
const TASK_KEY = 'prewarm-common-math';

export function realPrewarmDeps(): PrewarmDeps {
  return {
    list: COMMON_MATH,
    stamp: commonMathStamp(),
    hash: mathHash,
    getCachedSvgMap: getMathSvgMap,
    render: renderMathBatch,
    putBatch: putMathBatch,
    getStamp: () => getMeta(COMMON_MATH_META_KEY),
    setStamp: s => setMeta(COMMON_MATH_META_KEY, s),
  };
}

export function scheduleCommonMathPrewarm(
  scheduler: Pick<typeof idleScheduler, 'schedule'> = idleScheduler,
  deps: PrewarmDeps = realPrewarmDeps(),
): void {
  const step = async (): Promise<void> => {
    const r = await prewarmCommonMath(deps, { maxChunks: 1 });
    // Continue only while progress is being made; a failed/empty chunk ends the
    // run (stamp stays unset, so the next launch retries just the missing ones).
    if (r.status === 'partial' && r.rendered > 0 && r.remaining > r.failed) {
      scheduler.schedule(TASK_KEY, step);
    }
  };
  // PRIORITY SWITCH (after math-throttle merges): replace the body above with
  //   scheduler.schedule(TASK_KEY, () => prewarmCommonMath({ ...deps,
  //     beforeChunk: () => idleScheduler.yieldThenMayRun('background') }));
  scheduler.schedule(TASK_KEY, step);
}
