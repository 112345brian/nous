// Behaviour of downloadAll and syncCachedArticles as seen by SettingsScreen and App.tsx.
// Written BEFORE the logic moved into src/core and kept unchanged afterwards (only the import
// path changed when the wiring moved to the composition root). They run the real article
// pipeline; db, fetch, the renderer and the clock are fakes.
import { downloadAll, syncCachedArticles } from '../../composition';
import * as dbModule from '../db';
import type { Db } from '../db';
const db = dbModule as unknown as jest.Mocked<Db>;
import { _resetMathCacheState } from '../../composition';   // the math runtime is built in the root

const mockMeta: Record<string, string> = {};
jest.mock('../db', () => require('./helpers/mockDbModule').asDbModule({
  getSlugsByCacheStatus: jest.fn(),
  getCachedSlugs: jest.fn(),
  getMeta: jest.fn(async (k: string) => mockMeta[k] ?? null),
  setMeta: jest.fn(async (k: string, v: string) => { mockMeta[k] = v; }),
  getEntryCount: jest.fn(async () => 5),
  upsertIndexEntries: jest.fn(async () => {}),
  cleanDenormalizedTitles: jest.fn(async () => {}),
  getAllEntryTitles: jest.fn(async () => []),
  invalidateLinkCache: jest.fn(),
  cacheArticle: jest.fn(async () => {}),
  indexLinks: jest.fn(async () => {}),
  getEntryHtml: jest.fn(async () => null),
  updateArticleHtml: jest.fn(async () => {}),
  setArticleAst: jest.fn(async () => {}),
  putMathBatch: jest.fn(async () => {}),
  getMathByHashes: jest.fn(async () => []),
}));
const mockRender = jest.fn();
jest.mock('../../core/mathBridge', () => ({ createMathBridge: () => require('./fakeMathBridge').fakeMathBridge((...a: unknown[]) => mockRender(...a)) }));
jest.mock('../perf', () => ({ perf: { enabled: false, begin() {}, end() {}, mark() {}, time: (_k: string, _s: string, fn: () => unknown) => fn(), timeSync: (_k: string, _s: string, fn: () => unknown) => fn() } }));

const m = db as jest.Mocked<typeof db>;
const NOW = Date.UTC(2026, 5, 10, 12);
const entries = (n: number, prefix = 'a') => Array.from({ length: n }, (_, i) => ({ slug: `${prefix}${i}`, title: `Title ${prefix}${i}` }));
const slugOf = (url: string) => /\/entries\/([^/]+)\/$/.exec(url)?.[1];
const page = (slug: string, body = `<p>Body of ${slug}.</p>`) => ({ ok: true, status: 200, text: async () => `<div id="aueditable"><h1>T</h1>${body}</div>` });

let fetchMock: jest.Mock;
let gated: Array<{ slug: string; release: () => void }>;
let articleFetches: () => string[];
function instantFetch(over: Record<string, ReturnType<typeof page> | { ok: false; status: number; text: () => Promise<string> }> = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    const s = slugOf(url);
    if (s && over[s]) return over[s];
    return s ? page(s) : { ok: true, status: 200, text: async () => '' };
  });
}
function gatedFetch() {
  gated = [];
  fetchMock.mockImplementation((url: string) => new Promise(res => {
    const s = slugOf(url)!;
    gated.push({ slug: s, release: () => res(page(s)) });
  }));
}
const progress = () => { const calls: Array<{ done: number; total: number; current: string }> = []; return { calls, fn: (p: { done: number; total: number; current: string }) => { calls.push(p); } }; };

beforeEach(() => {
  _resetMathCacheState();
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  mockMeta.index_refreshed_at = String(NOW);          // index is fresh: no contents.html request
  m.getEntryCount.mockResolvedValue(5);
  m.getSlugsByCacheStatus.mockResolvedValue({ uncached: [], cached: [] });
  m.getCachedSlugs.mockResolvedValue([]);
  mockRender.mockImplementation(async (items: Array<{ tex: string; display: boolean }>) => items.map(i => ({ ...i, b64: btoa('<svg/>'), w: 1, h: 1 })));
  fetchMock = jest.fn();
  (globalThis as any).fetch = fetchMock;
  articleFetches = () => fetchMock.mock.calls.map(c => slugOf(c[0])).filter((s): s is string => !!s);
  instantFetch();
});
afterEach(() => jest.useRealTimers());

describe('downloadAll', () => {
  test('reports the real total up front, counting what is already cached', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: entries(2, 'u'), cached: entries(3, 'c') });
    const p = progress();
    const run = downloadAll(p.fn);
    await jest.runAllTimersAsync(); await run;
    expect(p.calls[0]).toEqual({ done: 3, total: 5, current: '' });
  });

  test('a fully cached library still emits once and fetches nothing', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: [], cached: entries(4, 'c') });
    const p = progress();
    await downloadAll(p.fn);
    expect(p.calls).toEqual([{ done: 4, total: 4, current: '' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the scope is passed through, defaulting to all', async () => {
    const run = downloadAll(() => {}, undefined, 'sep');
    await jest.runAllTimersAsync(); await run;
    expect(m.getSlugsByCacheStatus).toHaveBeenLastCalledWith('sep');
    const run2 = downloadAll(() => {});
    await jest.runAllTimersAsync(); await run2;
    expect(m.getSlugsByCacheStatus).toHaveBeenLastCalledWith('all');
  });

  test('six at a time, and a pause of 100 ms after each group before the next one starts', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: entries(13), cached: [] });
    gatedFetch();
    const run = downloadAll(() => {});
    await jest.advanceTimersByTimeAsync(0);
    expect(gated).toHaveLength(6);                                  // first group, all in flight together
    gated.splice(0).forEach(g => g.release());
    await jest.advanceTimersByTimeAsync(99);
    expect(gated).toHaveLength(0);                                  // still pausing
    await jest.advanceTimersByTimeAsync(1);
    expect(gated).toHaveLength(6);                                  // second group
    gated.splice(0).forEach(g => g.release());
    await jest.advanceTimersByTimeAsync(100);
    expect(gated).toHaveLength(1);                                  // the remainder
    gated.splice(0).forEach(g => g.release());
    await jest.advanceTimersByTimeAsync(99);
    let finished = false; run.then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);                                   // even the last group is followed by the pause
    await jest.advanceTimersByTimeAsync(1);
    await run;
    expect(articleFetches()).toEqual(entries(13).map(e => e.slug));
  });

  test('one progress event per article with its title, counting on from what was cached', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: entries(3, 'u'), cached: entries(2, 'c') });
    const p = progress();
    const run = downloadAll(p.fn);
    await jest.runAllTimersAsync(); await run;
    expect(p.calls.slice(1).map(c => c.done)).toEqual([3, 4, 5]);
    expect(new Set(p.calls.slice(1).map(c => c.current))).toEqual(new Set(['Title u0', 'Title u1', 'Title u2']));
    expect(p.calls.every(c => c.total === 5)).toBe(true);
  });

  // The one-shot inline-math backfill was removed upstream. A bulk download now queues each article
  // that has TeX on math_pending and drains the queue once the download hold is released.
  test('articles are cached as text only and queued: no equation is rendered during the download', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: [{ slug: 'logic', title: 'Logic' }], cached: [] });
    instantFetch({ logic: page('logic', '<p>Let \\(x\\) be a set.</p>') });
    let rendersDuringDownload = -1;
    const run = downloadAll(p => { if (p.done === 1) rendersDuringDownload = mockRender.mock.calls.length; });
    await jest.runAllTimersAsync(); await run;
    const cached = m.cacheArticle.mock.calls[0][1] as any;
    expect(cached.content_html).toContain('\\(x\\)');            // cached as text with the raw TeX
    expect(cached.has_math).toBe(1);
    expect(rendersDuringDownload).toBe(0);                          // nothing rendered while downloading
  });

  test('once the download is over the queued math is drained (rendered, article rewritten, queue emptied)', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: [{ slug: 'logic', title: 'Logic' }], cached: [] });
    instantFetch({ logic: page('logic', '<p>Let \\(x\\) be a set.</p>') });
    m.getEntryHtml.mockResolvedValue('<p>Let \\(x\\) be a set.</p>');
    const run = downloadAll(() => {});
    await jest.runAllTimersAsync(); await run;
    await jest.runAllTimersAsync();
    expect(mockRender).toHaveBeenCalled();
    expect(m.updateArticleHtml).toHaveBeenCalledWith('logic', expect.stringContaining('<math-i'));
    expect(JSON.parse(mockMeta.math_pending ?? '[]')).toEqual([]);
  });

  test('an article that fails to download does not count as done', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: entries(2), cached: [] });
    instantFetch({ a0: { ok: false, status: 503, text: async () => '' } });
    const p = progress();
    const run = downloadAll(p.fn);
    await jest.runAllTimersAsync(); await run;
    expect(p.calls.map(c => c.done)).toEqual([0, 1]);
    expect(m.cacheArticle).toHaveBeenCalledTimes(1);
  });

  test('when every download fails, progress never leaves zero', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: entries(3), cached: [] });
    fetchMock.mockRejectedValue(new Error('offline'));
    const p = progress();
    const run = downloadAll(p.fn);
    await jest.runAllTimersAsync(); await run;
    expect(p.calls.map(c => c.done)).toEqual([0]);
  });

  test('already aborted: only the opening event, nothing fetched', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: entries(8), cached: [] });
    const ac = new AbortController(); ac.abort();
    const p = progress();
    await downloadAll(p.fn, ac.signal);
    expect(p.calls).toEqual([{ done: 0, total: 8, current: '' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('aborting mid-way finishes the group in flight and starts no further group', async () => {
    m.getSlugsByCacheStatus.mockResolvedValue({ uncached: entries(13), cached: [] });
    const ac = new AbortController();
    const p = progress();
    const run = downloadAll(c => { p.fn(c); if (c.done === 3) ac.abort(); }, ac.signal);
    await jest.runAllTimersAsync(); await run;
    expect(articleFetches()).toHaveLength(6);
    expect(p.calls.at(-1)!.done).toBe(6);
  });

  test('a failure reading the library rejects before any progress is reported', async () => {
    m.getSlugsByCacheStatus.mockRejectedValue(new Error('db'));
    const p = progress();
    await expect(downloadAll(p.fn)).rejects.toThrow('db');
    expect(p.calls).toEqual([]);
  });
});

describe('syncCachedArticles', () => {
  test('refreshes the index first, then re-fetches', async () => {
    mockMeta.index_refreshed_at = String(NOW - 8 * 24 * 3600 * 1000);   // stale
    m.getCachedSlugs.mockResolvedValue(entries(1));
    fetchMock.mockImplementation(async (url: string) =>
      /contents\.html$/.test(url) ? { ok: true, status: 200, text: async () => '<li><a href="entries/zz/"><strong>Zz</strong></a></li>' } : page(slugOf(url)!));
    const run = syncCachedArticles(() => {});
    await jest.runAllTimersAsync(); await run;
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      'https://plato.stanford.edu/contents.html', 'https://plato.stanford.edu/entries/a0/']);
    expect(m.upsertIndexEntries).toHaveBeenCalledTimes(1);
  });

  test('a fresh index is not fetched again; the library is read with no scope argument', async () => {
    m.getCachedSlugs.mockResolvedValue(entries(1));
    const run = syncCachedArticles(() => {});
    await jest.runAllTimersAsync(); await run;
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://plato.stanford.edu/entries/a0/']);
    expect(m.getCachedSlugs).toHaveBeenCalledWith();
  });

  test('three at a time, with a pause of 200 ms after each group', async () => {
    m.getCachedSlugs.mockResolvedValue(entries(7));
    gatedFetch();
    const run = syncCachedArticles(() => {});
    await jest.advanceTimersByTimeAsync(0);
    expect(gated).toHaveLength(3);
    gated.splice(0).forEach(g => g.release());
    await jest.advanceTimersByTimeAsync(199);
    expect(gated).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(gated).toHaveLength(3);
    gated.splice(0).forEach(g => g.release());
    await jest.advanceTimersByTimeAsync(200);
    expect(gated).toHaveLength(1);
    gated.splice(0).forEach(g => g.release());
    await jest.runAllTimersAsync(); await run;
  });

  test('no opening event; one event per article after it is cached; the total is the cached count', async () => {
    m.getCachedSlugs.mockResolvedValue(entries(4));
    const p = progress();
    const run = syncCachedArticles(p.fn);
    await jest.runAllTimersAsync(); await run;
    expect(p.calls.map(c => c.done)).toEqual([1, 2, 3, 4]);
    expect(p.calls.every(c => c.total === 4)).toBe(true);
    expect(new Set(p.calls.map(c => c.current))).toEqual(new Set(entries(4).map(e => e.title)));
  });

  test('equations are rendered as part of the sync', async () => {
    m.getCachedSlugs.mockResolvedValue([{ slug: 'logic', title: 'Logic' }]);
    instantFetch({ logic: page('logic', '<p>Let \\(x\\) be a set.</p>') });
    const run = syncCachedArticles(() => {});
    await jest.runAllTimersAsync(); await run;
    expect((m.cacheArticle.mock.calls[0][1] as any).content_html).toContain('<math-i');
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  test('the time of a completed sync is recorded; an empty library still counts as synced', async () => {
    m.getCachedSlugs.mockResolvedValue(entries(2));
    const run = syncCachedArticles(() => {});
    await jest.runAllTimersAsync(); await run;
    expect(mockMeta.last_deep_sync).toBe(String(NOW + 200));   // stamped when the sync ends: after the last pause
    delete mockMeta.last_deep_sync;
    m.getCachedSlugs.mockResolvedValue([]);
    const p = progress();
    const before = Date.now();                                  // no groups, so no pause: stamped at once
    await syncCachedArticles(p.fn);
    expect(p.calls).toEqual([]);
    expect(mockMeta.last_deep_sync).toBe(String(before));
  });

  test('an aborted sync stops at the next group and does not record a sync time', async () => {
    m.getCachedSlugs.mockResolvedValue(entries(9));
    const ac = new AbortController();
    const run = syncCachedArticles(c => { if (c.done === 2) ac.abort(); }, ac.signal);
    await jest.runAllTimersAsync(); await run;
    expect(articleFetches()).toHaveLength(3);
    expect(mockMeta.last_deep_sync).toBeUndefined();
    // already aborted: nothing at all
    fetchMock.mockClear();
    await syncCachedArticles(() => {}, ac.signal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an article that fails to download does not count as done, but the rest still sync', async () => {
    m.getCachedSlugs.mockResolvedValue(entries(2));
    instantFetch({ a0: { ok: false, status: 500, text: async () => '' } });
    const p = progress();
    const run = syncCachedArticles(p.fn);
    await jest.runAllTimersAsync(); await run;
    expect(p.calls.map(c => c.done)).toEqual([1]);
    expect(mockMeta.last_deep_sync).toBe(String(NOW + 200));   // one article was refreshed
  });

  test('a sync in which every article fails (offline) does not record last_deep_sync', async () => {
    m.getCachedSlugs.mockResolvedValue(entries(4));
    fetchMock.mockRejectedValue(new Error('offline'));
    const p = progress();
    const run = syncCachedArticles(p.fn);
    await jest.runAllTimersAsync(); await run;
    expect(p.calls).toEqual([]);
    expect(mockMeta.last_deep_sync).toBeUndefined();
  });

  test('an empty library has nothing to fail, so the sync time is still recorded', async () => {
    m.getCachedSlugs.mockResolvedValue([]);
    const run = syncCachedArticles(() => {});
    await jest.runAllTimersAsync(); await run;
    expect(mockMeta.last_deep_sync).toBeDefined();
  });

  test('a storage failure reading the library rejects and records nothing', async () => {
    m.getCachedSlugs.mockRejectedValue(new Error('db'));
    await expect(syncCachedArticles(() => {})).rejects.toThrow('db');
    expect(mockMeta.last_deep_sync).toBeUndefined();
  });
});
