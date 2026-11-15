jest.mock('../db', () => ({ getMeta: jest.fn(), setMeta: jest.fn(), getMathSvgMap: jest.fn(), putMathBatch: jest.fn() }));
jest.mock('../catalog', () => ({ mathHash: (t: string, d: boolean) => `${d ? 'D' : 'I'}:${t}` }));
jest.mock('../mathRender', () => ({ renderMathBatch: jest.fn() }));
jest.mock('../idleScheduler', () => ({ idleScheduler: { schedule: jest.fn() } }));

import { scheduleCommonMathPrewarm } from '../commonMathWiring';
import type { PrewarmDeps } from '../prewarmCommonMath';

const LIST = [1, 2, 3, 4, 5].map(i => ({ tex: `x_${i}`, display: false }));

function harness(failAll = false) {
  const cached = new Set<string>();
  let stamp: string | null = null;
  const deps: PrewarmDeps = {
    list: LIST, stamp: 's1', chunkSize: 2,
    hash: (t, d) => `${d ? 'D' : 'I'}:${t}`,
    getCachedSvgMap: async hs => Object.fromEntries(hs.filter(h => cached.has(h)).map(h => [h, 'x'])),
    render: async items => items.map(i => (failAll ? { ...i, error: 'timeout' } : { ...i, b64: 'AA==', w: 1, h: 1 })),
    putBatch: async rows => rows.forEach(r => cached.add(r.hash)),
    getStamp: async () => stamp,
    setStamp: async s => { stamp = s; },
    decode: () => '<svg/>',
  };
  const queue: Array<[string, () => unknown]> = [];
  const scheduler = { schedule: (k: string, fn: () => unknown) => { queue.push([k, fn]); return true; } };
  const drain = async () => { let n = 0; while (queue.length && n++ < 20) { const [, fn] = queue.shift()!; await fn(); } return n; };
  return { deps, scheduler, queue, drain, getStamp: () => stamp, cached };
}

describe('scheduleCommonMathPrewarm', () => {
  it('schedules exactly one task up front, then one task per chunk', async () => {
    const h = harness();
    scheduleCommonMathPrewarm(h.scheduler, h.deps);
    expect(h.queue.map(q => q[0])).toEqual(['prewarm-common-math']);
    const runs = await h.drain();
    expect(runs).toBe(3); // 5 equations, chunks of 2
    expect(h.getStamp()).toBe('s1');
  });

  it('does not reschedule after a relaunch with the stamp current', async () => {
    const h = harness();
    scheduleCommonMathPrewarm(h.scheduler, h.deps);
    await h.drain();
    scheduleCommonMathPrewarm(h.scheduler, h.deps);
    expect(await h.drain()).toBe(1);
  });

  it('stops (no endless rescheduling) when rendering fails', async () => {
    const h = harness(true);
    scheduleCommonMathPrewarm(h.scheduler, h.deps);
    expect(await h.drain()).toBe(1);
    expect(h.getStamp()).toBeNull();
  });
});
