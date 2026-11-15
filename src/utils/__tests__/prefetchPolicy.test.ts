import {
  PREFETCH_MAX_TARGETS,
  canPrefetchOn,
  runPrefetch,
  selectPrefetchTargets,
  type ConnectionState,
} from '../prefetchPolicy';

const c = (slug: string, cached_at: number | null = null) => ({ slug, cached_at });

describe('selectPrefetchTargets', () => {
  it('skips cached, current, attempted and duplicate slugs', () => {
    const out = selectPrefetchTargets(
      'self',
      [c('self'), c('a', 123), c('b'), c('b'), c('c'), c('d')],
      new Set(['c']),
    );
    expect(out).toEqual(['b', 'd']);
  });

  it('caps at the default max and honours an explicit max', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`s${i}`));
    expect(selectPrefetchTargets('x', many, new Set())).toHaveLength(PREFETCH_MAX_TARGETS);
    expect(selectPrefetchTargets('x', many, new Set(), 2)).toEqual(['s0', 's1']);
    expect(selectPrefetchTargets('x', many, new Set(), 0)).toEqual([]);
  });

  it('handles empty input and blank slugs', () => {
    expect(selectPrefetchTargets('x', [], new Set())).toEqual([]);
    expect(selectPrefetchTargets('x', [c('')], new Set())).toEqual([]);
  });

  it('does not mutate the attempted set', () => {
    const attempted = new Set<string>();
    selectPrefetchTargets('x', [c('a')], attempted);
    expect(attempted.size).toBe(0);
  });
});

describe('canPrefetchOn', () => {
  const base: ConnectionState = { isConnected: true, isInternetReachable: true, isExpensive: false };
  it('allows online, unmetered', () => expect(canPrefetchOn(base)).toBe(true));
  it('allows when reachability is still unknown', () =>
    expect(canPrefetchOn({ ...base, isInternetReachable: null })).toBe(true));
  it('blocks offline, unreachable, metered', () => {
    expect(canPrefetchOn({ ...base, isConnected: false })).toBe(false);
    expect(canPrefetchOn({ ...base, isConnected: null })).toBe(false);
    expect(canPrefetchOn({ ...base, isInternetReachable: false })).toBe(false);
    expect(canPrefetchOn({ ...base, isExpensive: true })).toBe(false);
  });
  it('blocks when metered-ness is unknown or state is missing', () => {
    expect(canPrefetchOn({ ...base, isExpensive: null })).toBe(false);
    expect(canPrefetchOn(null)).toBe(false);
    expect(canPrefetchOn(undefined)).toBe(false);
  });
});

describe('runPrefetch', () => {
  it('runs strictly one at a time with a gap between requests', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const events: string[] = [];
    const done = await runPrefetch(['a', 'b', 'c'], {
      fetchOne: async s => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`f:${s}`);
        await Promise.resolve();
        inFlight--;
        return true;
      },
      sleep: async ms => { events.push(`z:${ms}`); },
      shouldContinue: () => true,
    }, 123);
    expect(done).toEqual(['a', 'b', 'c']);
    expect(maxInFlight).toBe(1);
    expect(events).toEqual(['f:a', 'z:123', 'f:b', 'z:123', 'f:c']); // no trailing sleep
  });

  it('stops as soon as shouldContinue goes false (cancel on navigation)', async () => {
    let keep = true;
    const fetched: string[] = [];
    const done = await runPrefetch(['a', 'b', 'c'], {
      fetchOne: async s => { fetched.push(s); if (s === 'a') keep = false; return true; },
      sleep: async () => {},
      shouldContinue: () => keep,
    });
    expect(fetched).toEqual(['a']);
    expect(done).toEqual(['a']);
  });

  it('does nothing when cancelled up front or given no targets', async () => {
    const fetchOne = jest.fn(async () => true);
    expect(await runPrefetch(['a'], { fetchOne, sleep: async () => {}, shouldContinue: () => false })).toEqual([]);
    expect(await runPrefetch([], { fetchOne, sleep: async () => {}, shouldContinue: () => true })).toEqual([]);
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it('survives a throwing or failing fetch on the second attempt and keeps going', async () => {
    const attempts: string[] = [];
    const done = await runPrefetch(['a', 'b', 'c'], {
      fetchOne: async s => {
        if (s === 'b') throw new Error('boom');
        return s !== 'a' ? true : false;
      },
      sleep: async () => {},
      shouldContinue: () => true,
      onAttempt: s => attempts.push(s),
    });
    expect(attempts).toEqual(['a', 'b', 'c']); // failures are still recorded as attempted
    expect(done).toEqual(['c']);
  });
});
