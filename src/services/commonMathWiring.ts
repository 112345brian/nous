// The ONE place that connects prewarmCommonMath to the app: db meta (the stamp),
// mathCache.ensureMath at the lowest priority, and the idle scheduler.
// App.tsx calls scheduleCommonMathPrewarm() once, after the other idle tasks.
//
// Never-during-reading/scroll/download is not re-implemented here: the task
// starts only when the scheduler is idle, and ensureMath(…, 'background') awaits
// the priority model (src/utils/mathThrottlePolicy.ts) before every chunk, so a
// reading or download hold, or recent scroll/touch, pauses it at the next chunk
// boundary. The priority must stay 'background' (a test guards this).

import { COMMON_MATH, commonMathStamp } from '../data/commonMath';
import { getMeta, setMeta } from './db';
import { ensureMath } from './mathCache';
import { idleScheduler } from './idleScheduler';
import { prewarmCommonMath, PrewarmDeps } from './prewarmCommonMath';

export const COMMON_MATH_META_KEY = 'common_math_prewarm';
export const COMMON_MATH_TASK_KEY = 'prewarm-common-math';

export function realPrewarmDeps(): PrewarmDeps {
  return {
    list: COMMON_MATH,
    stamp: commonMathStamp(),
    ensure: spots => ensureMath(spots, 'background'),
    getStamp: () => getMeta(COMMON_MATH_META_KEY),
    setStamp: s => setMeta(COMMON_MATH_META_KEY, s),
  };
}

export function scheduleCommonMathPrewarm(
  scheduler: Pick<typeof idleScheduler, 'schedule'> = idleScheduler,
  deps: PrewarmDeps = realPrewarmDeps(),
): boolean {
  return scheduler.schedule(COMMON_MATH_TASK_KEY, () => prewarmCommonMath(deps));
}
