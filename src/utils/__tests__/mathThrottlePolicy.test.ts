import {
  DEFAULT_THROTTLE_CONFIG as CFG, mayRun, chunkRanges, createSliceBudget, ThrottleState,
} from '../mathThrottlePolicy';

const st = (o: Partial<ThrottleState> = {}): ThrottleState => ({
  holds: { reading: 0, download: 0 }, lastActivityAt: null, now: 10_000, ...o,
});

describe('mayRun', () => {
  it('runs both priorities when nothing is active', () => {
    expect(mayRun('current', st())).toEqual({ run: true });
    expect(mayRun('background', st())).toEqual({ run: true });
  });

  it('a reading hold blocks everything, indefinitely', () => {
    const s = st({ holds: { reading: 1, download: 0 } });
    expect(mayRun('current', s)).toEqual({ run: false, blockedBy: 'reading', waitMs: Infinity });
    expect(mayRun('background', s).run).toBe(false);
  });

  it('a download hold fully pauses current-article math too', () => {
    const s = st({ holds: { reading: 0, download: 2 } });
    expect(mayRun('current', s)).toEqual({ run: false, blockedBy: 'download', waitMs: Infinity });
    expect(mayRun('background', s).run).toBe(false);
  });

  it('reports the higher-priority blocker when both holds are active', () => {
    const d = mayRun('current', st({ holds: { reading: 1, download: 1 } }));
    expect(d).toMatchObject({ run: false, blockedBy: 'reading' });
  });

  it('after activity, current waits currentQuietMs and background waits longer', () => {
    const s = st({ lastActivityAt: 10_000 - 100 });
    expect(mayRun('current', s)).toEqual({ run: false, blockedBy: 'quiet', waitMs: CFG.currentQuietMs - 100 });
    expect(mayRun('background', s)).toEqual({ run: false, blockedBy: 'quiet', waitMs: CFG.backgroundQuietMs - 100 });
  });

  it('current may run in a gap where background may not', () => {
    const s = st({ lastActivityAt: 10_000 - CFG.currentQuietMs });
    expect(mayRun('current', s).run).toBe(true);
    expect(mayRun('background', s).run).toBe(false);
  });

  it('the quiet gap is exact at the boundary and when the clock is far ahead', () => {
    expect(mayRun('current', st({ lastActivityAt: 10_000 - CFG.currentQuietMs + 1 })).run).toBe(false);
    expect(mayRun('current', st({ lastActivityAt: 10_000 - CFG.currentQuietMs })).run).toBe(true);
    expect(mayRun('background', st({ lastActivityAt: 0, now: 1e9 })).run).toBe(true);
  });

  it('honours a custom config', () => {
    const cfg = { ...CFG, currentQuietMs: 5 };
    expect(mayRun('current', st({ lastActivityAt: 10_000 - 5 }), cfg).run).toBe(true);
  });
});

describe('chunkRanges', () => {
  it('covers 0..n exactly once, in order', () => {
    expect(chunkRanges(5, 2)).toEqual([[0, 2], [2, 4], [4, 5]]);
    expect(chunkRanges(4, 2)).toEqual([[0, 2], [2, 4]]);
  });
  it('handles empty input and a size larger than the input', () => {
    expect(chunkRanges(0, 24)).toEqual([]);
    expect(chunkRanges(3, 24)).toEqual([[0, 3]]);
  });
  it('treats a bad size (0, negative, NaN) as 1 rather than looping forever', () => {
    expect(chunkRanges(2, 0)).toEqual([[0, 1], [1, 2]]);
    expect(chunkRanges(2, -3)).toEqual([[0, 1], [1, 2]]);
    expect(chunkRanges(2, NaN)).toEqual([[0, 1], [1, 2]]);
  });
  it('default chunk size is within the 20-40 target', () => {
    expect(CFG.chunkSize).toBeGreaterThanOrEqual(20);
    expect(CFG.chunkSize).toBeLessThanOrEqual(40);
  });
});

describe('createSliceBudget', () => {
  it('is exhausted once the budget has elapsed and resets on demand', () => {
    let t = 0;
    const b = createSliceBudget(() => t, 8);
    expect(b.exhausted()).toBe(false);
    t = 7.9; expect(b.exhausted()).toBe(false);
    t = 8; expect(b.exhausted()).toBe(true);
    b.reset();
    expect(b.exhausted()).toBe(false);
    t = 16; expect(b.exhausted()).toBe(true);
  });
});
