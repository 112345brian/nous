// The index-refresh use case run with plain in-memory fakes: no jest.mock, no fetch, no SQLite.
import { refreshIndexIfStale, INDEX_REFRESH_INTERVAL_MS, type RefreshIndexDeps } from '../refreshIndex';
import type { IndexEntry } from '../../types';

const NOW = 1_800_000_000_000;
const HTML = `<ul>
<li><a href="entries/zeta/"><strong>Zeta</strong></a></li>
<li><a href="entries/alpha/"><strong>Alpha</strong></a></li>
</ul>`;
const FAKE_SEED: IndexEntry[] = [{ slug: 'seed-only', title: 'Seed Only' }];

function world(o: { last?: string | null; count?: number; html?: string | Error; now?: number; titles?: { slug: string; title: string }[] } = {}) {
  const log: string[] = [];
  const meta = new Map<string, string>();
  if (o.last) meta.set('index_refreshed_at', o.last);
  const upserts: IndexEntry[][] = [];
  const deps: RefreshIndexDeps = {
    source: { fetchIndexHtml: async () => { log.push('fetch'); if (o.html instanceof Error) throw o.html; return o.html ?? HTML; } },
    store: {
      getEntryCount: async () => o.count ?? 0,
      upsertIndexEntries: async e => { log.push('upsert'); upserts.push(e); },
      cleanDenormalizedTitles: async () => { log.push('clean'); },
      getAllEntryTitles: async () => { log.push('titles'); return o.titles ?? [{ slug: 'a', title: 'Alpha' }]; },
      invalidateLinkCache: () => { log.push('invalidate'); },
    },
    meta: {
      getMeta: async k => meta.get(k) ?? null,
      setMeta: async (k, v) => { log.push(`set:${k}`); meta.set(k, v); },
    },
    clock: { now: () => o.now ?? NOW },
    bundledEntries: FAKE_SEED,
  };
  return { deps, log, meta, upserts };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('refreshIndexIfStale with fakes', () => {
  const realFetch = (globalThis as any).fetch;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
    (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
  });
  afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

  test('the injected clock decides staleness and is what gets stored', async () => {
    const w = world({ last: String(NOW - 1000), count: 3 });
    await refreshIndexIfStale(w.deps);
    expect(w.log).toEqual([]);                              // fresh: no fetch at all

    const later = world({ last: String(NOW - 1000), count: 3, now: NOW + INDEX_REFRESH_INTERVAL_MS });
    await refreshIndexIfStale(later.deps);
    expect(later.log.slice(0, 4)).toEqual(['fetch', 'upsert', 'clean', 'set:index_refreshed_at']);
    expect(later.meta.get('index_refreshed_at')).toBe(String(NOW + INDEX_REFRESH_INTERVAL_MS));
  });

  test('parsed entries come from the injected source, sorted by title', async () => {
    const w = world();
    await refreshIndexIfStale(w.deps);
    expect(w.upserts[0].map(e => e.slug)).toEqual(['alpha', 'zeta']);
  });

  test('offline first launch uses the injected bundled entries, not a built-in list', async () => {
    const w = world({ html: new Error('offline'), count: 0 });
    await refreshIndexIfStale(w.deps);
    expect(w.upserts).toEqual([FAKE_SEED]);
  });

  test('offline with an existing library changes nothing', async () => {
    const w = world({ html: new Error('offline'), count: 9 });
    await refreshIndexIfStale(w.deps);
    expect(w.log).toEqual(['fetch']);
    expect(w.meta.size).toBe(0);
  });

  test('the link index is rebuilt after the entries land and the cache is invalidated last', async () => {
    const w = world({ titles: [{ slug: 'x', title: 'A.B' }] });
    await refreshIndexIfStale(w.deps);
    await flush();
    expect(w.log).toEqual(['fetch', 'upsert', 'clean', 'set:index_refreshed_at', 'titles', 'set:link_index_json', 'invalidate']);
    expect(JSON.parse(w.meta.get('link_index_json')!)).toEqual([{ s: 'x', t: 'A.B', p: 'A\\.B' }]);
  });

  test('storage failures reach the caller; link-index failures do not', async () => {
    const bad = world();
    bad.deps.store.upsertIndexEntries = async () => { throw new Error('disk'); };
    await expect(refreshIndexIfStale(bad.deps)).rejects.toThrow('disk');

    const ok = world();
    ok.deps.store.getAllEntryTitles = async () => { throw new Error('db'); };
    await expect(refreshIndexIfStale(ok.deps)).resolves.toBeUndefined();
    await flush();
    expect(ok.log).not.toContain('invalidate');
  });
});
