import { createIdleScheduler } from '../idleScheduler';

// Deterministic: fake timers + an injected "after interactions" hook we control.
const IDLE = 1000;
const GAP = 200;

function make(extra: Partial<Parameters<typeof createIdleScheduler>[0]> = {}) {
  const errors: Array<[string, unknown]> = [];
  const s = createIdleScheduler({
    idleMs: IDLE,
    gapMs: GAP,
    afterInteractions: cb => cb(),
    onError: (k, e) => errors.push([k, e]),
    ...extra,
  });
  return { s, errors };
}

const tick = (ms: number) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('idleScheduler', () => {
  it('does not run a task until the idle delay has passed', async () => {
    const { s } = make();
    const fn = jest.fn();
    s.schedule('a', fn);
    await tick(IDLE - 1);
    expect(fn).not.toHaveBeenCalled();
    await tick(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs tasks one at a time, in FIFO order', async () => {
    const { s } = make();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    s.schedule('first', async () => { order.push('first:start'); await gate; order.push('first:end'); });
    s.schedule('second', () => { order.push('second'); });
    await tick(IDLE);
    expect(order).toEqual(['first:start']); // second must not overlap
    await tick(5000);
    expect(order).toEqual(['first:start']); // still blocked on the first
    release();
    await tick(GAP);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not start while held, and resumes after release', async () => {
    const { s } = make();
    const fn = jest.fn();
    const release = s.hold();
    s.schedule('a', fn);
    await tick(IDLE * 10);
    expect(fn).not.toHaveBeenCalled();
    release();
    await tick(IDLE);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('counts overlapping holds and ignores a double release', async () => {
    const { s } = make();
    const fn = jest.fn();
    const r1 = s.hold();
    const r2 = s.hold();
    s.schedule('a', fn);
    r1();
    r1(); // must not release r2's hold
    await tick(IDLE * 5);
    expect(fn).not.toHaveBeenCalled();
    r2();
    await tick(IDLE);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('noteActivity pushes the start back (scrolling keeps it paused)', async () => {
    const { s } = make();
    const fn = jest.fn();
    s.schedule('a', fn);
    await tick(IDLE - 100);
    s.noteActivity();
    await tick(IDLE - 100);
    expect(fn).not.toHaveBeenCalled();
    await tick(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a hold taken while the idle timer is pending cancels the start', async () => {
    const { s } = make();
    const fn = jest.fn();
    s.schedule('a', fn);
    await tick(IDLE - 1);
    const release = s.hold();
    await tick(IDLE * 3);
    expect(fn).not.toHaveBeenCalled();
    release();
    await tick(IDLE);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a hold taken between the timer firing and interactions finishing blocks the start', async () => {
    const h: { fire: (() => void) | null } = { fire: null };
    const { s } = make({ afterInteractions: cb => { h.fire = cb; } });
    const fn = jest.fn();
    s.schedule('a', fn);
    await tick(IDLE);
    expect(h.fire).not.toBeNull();
    const release = s.hold();
    h.fire!();
    await tick(IDLE * 2);
    expect(fn).not.toHaveBeenCalled();
    release();
    // interactions hook is manual now; fire the next one it hands us
    await tick(IDLE);
    h.fire!();
    await tick(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing task is reported, swallowed, and does not stop the queue', async () => {
    const { s, errors } = make();
    const after = jest.fn();
    s.schedule('boom-sync', () => { throw new Error('sync'); });
    s.schedule('boom-async', async () => { throw new Error('async'); });
    s.schedule('after', after);
    await tick(IDLE + GAP * 5);
    expect(after).toHaveBeenCalledTimes(1);
    expect(errors.map(e => e[0])).toEqual(['boom-sync', 'boom-async']);
  });

  it('never lets a task error escape as an unhandled rejection', async () => {
    const { s } = make({ onError: undefined });
    s.schedule('boom', async () => { throw new Error('nope'); });
    await expect(tick(IDLE + GAP)).resolves.not.toThrow();
  });

  it('ignores a duplicate key while one is still queued', async () => {
    const { s } = make();
    const fn = jest.fn();
    expect(s.schedule('same', fn)).toBe(true);
    expect(s.schedule('same', fn)).toBe(false);
    await tick(IDLE + GAP * 3);
    expect(fn).toHaveBeenCalledTimes(1);
    // once it has run, the same key may be queued again
    expect(s.schedule('same', fn)).toBe(true);
  });

  it('cancel removes a queued task and clear empties the queue', async () => {
    const { s } = make();
    const a = jest.fn();
    const b = jest.fn();
    s.schedule('a', a);
    s.schedule('b', b);
    expect(s.cancel('a')).toBe(true);
    expect(s.cancel('missing')).toBe(false);
    await tick(IDLE + GAP * 3);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    s.schedule('c', a);
    s.clear();
    await tick(IDLE * 3);
    expect(a).not.toHaveBeenCalled();
    expect(s.pending()).toBe(0);
  });

  it('a task scheduled by another task runs after it', async () => {
    const { s } = make();
    const order: string[] = [];
    s.schedule('outer', () => { order.push('outer'); s.schedule('inner', () => { order.push('inner'); }); });
    await tick(IDLE + GAP * 3);
    expect(order).toEqual(['outer', 'inner']);
  });
});
