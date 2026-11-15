import { prewarmCommonMath, PrewarmDeps } from '../prewarmCommonMath';

// Hand-written fixtures only (generic formulas we authored; no SEP text).
const LIST = [{ tex: 'x^2', display: false }, { tex: 'a+b', display: true }];

function fakes(over: Partial<PrewarmDeps> & { stamp0?: string | null; complete?: boolean } = {}) {
  let stamp = over.stamp0 ?? null;
  const calls = { ensure: [] as Array<typeof LIST> };
  const deps: PrewarmDeps = {
    list: LIST,
    stamp: 'v1',
    ensure: async spots => { calls.ensure.push(spots as typeof LIST); return { complete: over.complete ?? true }; },
    getStamp: async () => stamp,
    setStamp: async s => { stamp = s; },
    ...over,
  };
  return { deps, calls, getStamp: () => stamp };
}

describe('prewarmCommonMath', () => {
  it('does nothing when the stamp is current', async () => {
    const f = fakes({ stamp0: 'v1' });
    expect((await prewarmCommonMath(f.deps)).status).toBe('current');
    expect(f.calls.ensure).toEqual([]);
  });

  it('ensures the whole list once and stamps on completion', async () => {
    const f = fakes();
    expect((await prewarmCommonMath(f.deps)).status).toBe('done');
    expect(f.calls.ensure).toEqual([LIST]);
    expect(f.getStamp()).toBe('v1');
  });

  it('does not stamp an incomplete run, so the next launch retries', async () => {
    const f = fakes({ complete: false });
    expect((await prewarmCommonMath(f.deps)).status).toBe('partial');
    expect(f.getStamp()).toBeNull();
  });

  it('runs again when the list stamp changes', async () => {
    const f = fakes({ stamp0: 'v0' });
    expect((await prewarmCommonMath(f.deps)).status).toBe('done');
    expect(f.getStamp()).toBe('v1');
  });

  it('an ensure failure propagates and leaves the stamp unset', async () => {
    const f = fakes({ ensure: async () => { throw new Error('boom'); } });
    await expect(prewarmCommonMath(f.deps)).rejects.toThrow('boom');
    expect(f.getStamp()).toBeNull();
  });
});
