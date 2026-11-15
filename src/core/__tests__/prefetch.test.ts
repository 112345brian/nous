// Prefetch runs with fakes for connectivity, interactions, delay and links. Date.now, setTimeout
// and fetch throw, so the core cannot be reaching for them.
import { createPrefetcher } from '../prefetch';
import type { ConnectionInfo } from '../ports';

const boom = (n: string) => () => { throw new Error(`${n} must not be called by the core`); };
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(boom('Date.now') as never);
  jest.spyOn(globalThis, 'setTimeout').mockImplementation(boom('setTimeout') as never);
  (globalThis as any).fetch = boom('fetch');
});
afterEach(() => jest.restoreAllMocks());

const OK: ConnectionInfo = { isConnected: true, isInternetReachable: true, isExpensive: false };

function world(o: { conn?: ConnectionInfo; links?: Array<{ slug: string; cached_at: number | null }>; fail?: string[] } = {}) {
  const log: string[] = [];
  const delays: Array<{ ms: number; resolve: () => void; cancelled: boolean }> = [];
  let interactionCb: (() => void) | null = null;
  let interactionCancelled = false;
  const fetched: string[] = [];
  const start = createPrefetcher({
    connectivity: { current: async () => o.conn ?? OK },
    interactions: { afterInteractions: cb => { interactionCb = cb; return { cancel: () => { interactionCancelled = true; } }; } },
    delay: { start: ms => { let resolve!: () => void; const done = new Promise<void>(r => { resolve = r; }); const d = { ms, resolve, cancelled: false }; delays.push(d); return { done, cancel: () => { d.cancelled = true; } }; } },
    links: { getLinksFrom: async () => o.links ?? [] },
    fetchOne: async s => { fetched.push(s); if (o.fail?.includes(s)) throw new Error('flaky'); return true; },
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const fire = async () => { interactionCb?.(); await flush(); };
  /** resolve the pending delay (idle delay, or the gap) */
  const elapse = async () => { delays[delays.length - 1].resolve(); await flush(); };
  return { start, delays, fetched, log, fire, elapse, flush, get interactionCancelled() { return interactionCancelled; } };
}
const L = (...slugs: string[]) => slugs.map(slug => ({ slug, cached_at: null }));

test('waits for interactions, then the idle delay, then fetches targets one by one with a gap', async () => {
  const w = world({ links: [...L('a'), { slug: 'b', cached_at: 3 }, ...L('c')] });
  w.start('self');
  expect(w.delays).toHaveLength(0);
  await w.fire();
  expect(w.delays.map(d => d.ms)).toEqual([2500]);
  expect(w.fetched).toEqual([]);
  await w.elapse();
  expect(w.fetched).toEqual(['a']);
  expect(w.delays.map(d => d.ms)).toEqual([2500, 400]);
  await w.elapse();
  expect(w.fetched).toEqual(['a', 'c']);
});

test.each([
  ['expensive', { ...OK, isExpensive: true }],
  ['offline', { ...OK, isConnected: false }],
  ['unknown cost', { ...OK, isExpensive: null }],
  ['unreachable', { ...OK, isInternetReachable: false }],
])('does nothing when the connection is %s', async (_n, conn) => {
  const w = world({ conn, links: L('a') });
  w.start('self'); await w.fire(); await w.elapse();
  expect(w.fetched).toEqual([]);
});

test('cancel before the interactions settle never starts the clock; cancel during the delay stops it', async () => {
  const a = world({ links: L('a') });
  const cancelA = a.start('self'); cancelA(); await a.fire();
  expect(a.delays).toHaveLength(0);
  expect(a.interactionCancelled).toBe(true);

  const b = world({ links: L('a') });
  const cancelB = b.start('self'); await b.fire();
  cancelB();
  expect(b.delays[0].cancelled).toBe(true);
  await b.elapse();
  expect(b.fetched).toEqual([]);
});

test('cancel mid-run stops after the current article', async () => {
  const w = world({ links: L('a', 'b') });
  const cancel = w.start('self'); await w.fire(); await w.elapse();
  expect(w.fetched).toEqual(['a']);
  cancel(); await w.elapse();
  expect(w.fetched).toEqual(['a']);
});

test('attempted slugs (even failed ones) are instance state: not retried by a later start, but a new instance retries', async () => {
  const w = world({ links: L('a', 'b'), fail: ['a'] });
  w.start('self'); await w.fire(); await w.elapse(); await w.elapse();
  expect(w.fetched).toEqual(['a', 'b']);
  w.start('self'); await w.fire(); await w.elapse();
  expect(w.fetched).toEqual(['a', 'b']);

  const fresh = world({ links: L('a', 'b') });
  fresh.start('self'); await fresh.fire(); await fresh.elapse();
  expect(fresh.fetched).toEqual(['a']);
});

test('never throws when a port fails', async () => {
  const start = createPrefetcher({
    connectivity: { current: async () => { throw new Error('net'); } },
    interactions: { afterInteractions: cb => { cb(); return { cancel() {} }; } },
    delay: { start: () => ({ done: Promise.resolve(), cancel() {} }) },
    links: { getLinksFrom: async () => [] },
    fetchOne: async () => true,
  });
  expect(() => start('x')).not.toThrow();
  await Promise.resolve();
});
