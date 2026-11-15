// downloadAll / syncCachedArticles run with plain in-memory fakes: no jest.mock, no timers, no fetch,
// no SQLite. Pacing and the clock are injected; Date.now, fetch and setTimeout throw to prove it.
import {
  downloadAll, syncCachedArticles, DOWNLOAD_CONCURRENCY, DOWNLOAD_PAUSE_MS, SYNC_CONCURRENCY, SYNC_PAUSE_MS,
  type DownloadAllDeps, type SyncCachedDeps,
} from '../libraryDownload';
import type { DownloadProgress, EntryRef } from '../../types';

const refs = (n: number, p = 'a'): EntryRef[] => Array.from({ length: n }, (_, i) => ({ slug: `${p}${i}`, title: `T ${p}${i}` }));

function world(o: { uncached?: EntryRef[]; cached?: EntryRef[]; results?: Record<string, boolean>; indexFails?: boolean; now?: number } = {}) {
  const log: string[] = [];
  const meta = new Map<string, string>();
  const calls: Array<{ slug: string; opts: unknown }> = [];
  let inFlight = 0; let maxInFlight = 0;
  const cacheArticle = async (slug: string, opts: unknown) => {
    calls.push({ slug, opts });
    log.push(`cache:${slug}`);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();            // let the rest of the group start before any finishes
    await Promise.resolve();
    inFlight--;
    return o.results?.[slug] ?? true;
  };
  const sleep = async (ms: number) => { log.push(`sleep:${ms}`); };
  const dl: DownloadAllDeps = {
    library: { getSlugsByCacheStatus: async scope => { log.push(`status:${scope}`); return { uncached: o.uncached ?? [], cached: o.cached ?? [] }; } },
    cacheArticle, sleep,
  };
  const sync: SyncCachedDeps = {
    library: { getCachedSlugs: async () => { log.push('cached'); return o.cached ?? []; } },
    refreshIndex: async () => { log.push('refresh'); if (o.indexFails) throw new Error('db'); },
    cacheArticle,
    meta: { setMeta: async (k, v) => { log.push(`set:${k}`); meta.set(k, v); } },
    clock: { now: () => o.now ?? 1_700_000_000_000 },
    sleep,
  };
  const progress: DownloadProgress[] = [];
  return { dl, sync, log, meta, calls, progress, onProgress: (p: DownloadProgress) => { progress.push(p); }, maxInFlight: () => maxInFlight };
}

const realFetch = (globalThis as any).fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
  (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

describe('downloadAll with fakes', () => {
  test('opens with the real total, then one event per article, counting on from the cached ones', async () => {
    const w = world({ uncached: refs(3, 'u'), cached: refs(2, 'c') });
    await downloadAll(w.dl, w.onProgress);
    expect(w.progress[0]).toEqual({ done: 2, total: 5, current: '' });
    expect(w.progress.slice(1).map(p => p.done)).toEqual([3, 4, 5]);
    expect(w.progress.slice(1).map(p => p.current)).toEqual(['T u0', 'T u1', 'T u2']);
  });

  test('groups of six, each article cached as text only, and the injected pause after every group', async () => {
    const w = world({ uncached: refs(13) });
    await downloadAll(w.dl, w.onProgress);
    expect(DOWNLOAD_CONCURRENCY).toBe(6);
    expect(w.maxInFlight()).toBe(6);
    expect(w.calls.every(c => JSON.stringify(c.opts) === JSON.stringify({ skipMath: true }))).toBe(true);
    expect(w.log.filter(l => l.startsWith('sleep:'))).toEqual(['sleep:100', 'sleep:100', 'sleep:100']);
    expect(DOWNLOAD_PAUSE_MS).toBe(100);
    // the pause comes after its group and before the next group starts
    expect(w.log.indexOf('sleep:100')).toBe(1 + 6);
  });

  test('the scope is handed to the library, defaulting to all', async () => {
    const w = world();
    await downloadAll(w.dl, w.onProgress, undefined, 'owl');
    await downloadAll(w.dl, w.onProgress);
    expect(w.log.filter(l => l.startsWith('status:'))).toEqual(['status:owl', 'status:all']);
  });

  test('a library with nothing to download emits once, does not pause', async () => {
    const w = world({ cached: refs(4, 'c') });
    await downloadAll(w.dl, w.onProgress);
    expect(w.progress).toEqual([{ done: 4, total: 4, current: '' }]);
    expect(w.log.some(l => l.startsWith('sleep:'))).toBe(false);
  });

  test('articles that fail do not count as done (the result is inspected)', async () => {
    const w = world({ uncached: refs(2), results: { a0: false } });
    await downloadAll(w.dl, w.onProgress);
    expect(w.progress.map(p => p.done)).toEqual([0, 1]);
  });

  test('abort: checked before each group, never mid-group', async () => {
    const w = world({ uncached: refs(13) });
    const ac = new AbortController();
    await downloadAll(w.dl, p => { w.onProgress(p); if (p.done === 1) ac.abort(); }, ac.signal);
    expect(w.calls).toHaveLength(6);
    const pre = world({ uncached: refs(3) });
    const done = new AbortController(); done.abort();
    await downloadAll(pre.dl, pre.onProgress, done.signal);
    expect(pre.calls).toHaveLength(0);
    expect(pre.progress).toEqual([{ done: 0, total: 3, current: '' }]);
  });

  test('a library that cannot be read rejects before any event', async () => {
    const w = world();
    w.dl.library.getSlugsByCacheStatus = async () => { throw new Error('db'); };
    await expect(downloadAll(w.dl, w.onProgress)).rejects.toThrow('db');
    expect(w.progress).toEqual([]);
  });
});

describe('syncCachedArticles with fakes', () => {
  test('refresh first, then the library, then groups of three with equations awaited', async () => {
    const w = world({ cached: refs(7) });
    await syncCachedArticles(w.sync, w.onProgress);
    expect(w.log.slice(0, 2)).toEqual(['refresh', 'cached']);
    expect(SYNC_CONCURRENCY).toBe(3);
    expect(w.maxInFlight()).toBe(3);
    expect(w.calls.every(c => JSON.stringify(c.opts) === JSON.stringify({ awaitMath: true }))).toBe(true);
    expect(w.log.filter(l => l.startsWith('sleep:'))).toEqual(['sleep:200', 'sleep:200', 'sleep:200']);
    expect(SYNC_PAUSE_MS).toBe(200);
  });

  test('no opening event; one per article; total is the cached count', async () => {
    const w = world({ cached: refs(4) });
    await syncCachedArticles(w.sync, w.onProgress);
    expect(w.progress.map(p => p.done)).toEqual([1, 2, 3, 4]);
    expect(w.progress.every(p => p.total === 4)).toBe(true);
  });

  test('the sync time comes from the injected clock, and is written last', async () => {
    const w = world({ cached: refs(2), now: 424242 });
    await syncCachedArticles(w.sync, w.onProgress);
    expect(w.meta.get('last_deep_sync')).toBe('424242');
    expect(w.log.at(-1)).toBe('set:last_deep_sync');
    const empty = world({ now: 7 });
    await syncCachedArticles(empty.sync, empty.onProgress);
    expect(empty.meta.get('last_deep_sync')).toBe('7');
  });

  test('abort writes no sync time', async () => {
    const w = world({ cached: refs(9) });
    const ac = new AbortController();
    await syncCachedArticles(w.sync, p => { if (p.done === 1) ac.abort(); }, ac.signal);
    expect(w.calls).toHaveLength(3);
    expect(w.meta.has('last_deep_sync')).toBe(false);
  });

  test('a failing index refresh rejects before the library is read or anything is fetched', async () => {
    const w = world({ cached: refs(2), indexFails: true });
    await expect(syncCachedArticles(w.sync, w.onProgress)).rejects.toThrow('db');
    expect(w.log).toEqual(['refresh']);
  });

  test('a failed article does not count as done; the sync is recorded while any article succeeded', async () => {
    const w = world({ cached: refs(2), results: { a1: false } });
    await syncCachedArticles(w.sync, w.onProgress);
    expect(w.progress.map(p => p.done)).toEqual([1]);
    expect(w.meta.has('last_deep_sync')).toBe(true);
  });

  test('every article failing records nothing; an empty library still records', async () => {
    const all = world({ cached: refs(3), results: { a0: false, a1: false, a2: false } });
    await syncCachedArticles(all.sync, all.onProgress);
    expect(all.progress).toEqual([]);
    expect(all.meta.has('last_deep_sync')).toBe(false);
    const none = world({ cached: [] });
    await syncCachedArticles(none.sync, none.onProgress);
    expect(none.meta.has('last_deep_sync')).toBe(true);
  });
});
