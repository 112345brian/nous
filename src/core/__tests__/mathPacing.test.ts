// The pacing helpers with a fake scheduler, a fake timer and a fake clock: no real timers, no globals.
import { createMathPacing, type MathPacingDeps } from '../mathPacing';
import { DEFAULT_THROTTLE_CONFIG } from '../../utils/mathThrottlePolicy';

function world() {
  const log: string[] = [];
  let clock = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const scheduler: MathPacingDeps['scheduler'] = {
    whenMayRun: async p => { log.push(`when:${p}`); },
    yieldThenMayRun: async p => { log.push(`yield:${p}`); },
    hold: kind => { log.push(`hold:${kind}`); return () => { log.push(`release:${kind}`); }; },
  };
  const pacing = createMathPacing({ scheduler, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, now: () => clock });
  return { pacing, log, timers, advance: (ms: number) => { clock += ms; } };
}

const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
});
afterEach(() => { jest.restoreAllMocks(); globalThis.setTimeout = realSetTimeout; });

describe('createMathPacing with fakes', () => {
  test('the gates are the scheduler\'s', async () => {
    const w = world();
    await w.pacing.whenMathMayRun('current');
    await w.pacing.yieldThenMathMayRun('background');
    expect(w.log).toEqual(['when:current', 'yield:background']);
  });

  test('withDownloadHold holds for the duration and releases afterwards, also when the work fails', async () => {
    const w = world();
    expect(await w.pacing.withDownloadHold(async () => { w.log.push('work'); return 7; })).toBe(7);
    await expect(w.pacing.withDownloadHold(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(w.log).toEqual(['hold:download', 'work', 'release:download', 'hold:download', 'release:download']);
  });

  test('macrotask waits on the injected timer for the configured yield', async () => {
    const w = world();
    let done = false;
    const p = w.pacing.macrotask().then(() => { done = true; });
    expect(w.timers).toHaveLength(1);
    expect(w.timers[0].ms).toBe(DEFAULT_THROTTLE_CONFIG.yieldMs);
    expect(done).toBe(false);
    w.timers[0].fn();
    await p;
    expect(done).toBe(true);
  });

  describe('mathSlice', () => {
    test('does nothing until the budget is spent, then yields at the given priority and starts a new slice', async () => {
      const w = world();
      const slice = w.pacing.mathSlice('background', 10);
      await slice.checkpoint();
      expect(w.log).toEqual([]);
      w.advance(10);
      await slice.checkpoint();
      expect(w.log).toEqual(['yield:background']);
      await slice.checkpoint();                       // a fresh slice: no yield
      expect(w.log).toEqual(['yield:background']);
    });
    test('with no priority it only yields a macrotask, never asks the policy', async () => {
      const w = world();
      const slice = w.pacing.mathSlice(null, 5);
      w.advance(5);
      const p = slice.checkpoint();
      expect(w.timers).toHaveLength(1);
      w.timers[0].fn();
      await p;
      expect(w.log).toEqual([]);
    });
  });
});
