// Behaviour of catalog.refreshIndexIfStale as seen by its callers (App.tsx, syncCachedArticles).
// Written BEFORE the logic moved into src/core and kept unchanged afterwards. db and fetch are fakes.
import { refreshIndexIfStale } from '../../composition';   // wired in the composition root
import * as db from '../db';
import seed from '../../assets/entry-seed.json';

jest.mock('../db', () => ({
  getMeta: jest.fn(), setMeta: jest.fn(), getEntryCount: jest.fn(),
  upsertIndexEntries: jest.fn(), cleanDenormalizedTitles: jest.fn(),
  getAllEntryTitles: jest.fn(), invalidateLinkCache: jest.fn(),
}));
const m = db as jest.Mocked<typeof db>;

const NOW = Date.UTC(2026, 5, 10, 12);
const WEEK = 7 * 24 * 60 * 60 * 1000;
const HTML = `<ul>
<li><a href="entries/abduction/"><strong>abduction</strong></a></li>
<li>Ancient Philosophy
<ul>
<li><a href="entries/plato/"><strong>Plato</strong></a></li>
</ul></li>
<li><a href="entries/ethics/"><strong>Ethics</strong></a>
<ul>
<li><a href="entries/virtue-ethics/"><strong>Virtue Ethics</strong></a></li>
</ul></li>
<li><a href="entries/kant/"><strong>Kant &amp; Co</strong></a></li>
</ul>`;
const PARSED = [
  { slug: 'abduction', title: 'abduction', parent_label: null },
  { slug: 'ethics', title: 'Ethics', parent_label: null },
  { slug: 'kant', title: 'Kant & Co', parent_label: null },
  { slug: 'plato', title: 'Plato', parent_label: 'Ancient Philosophy' },
  { slug: 'virtue-ethics', title: 'Virtue Ethics', parent_label: 'Ethics' },
];

let calls: string[];
let fetchMock: jest.Mock;
const page = (body: string, ok = true, status = 200) => ({ ok, status, text: async () => body });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup(opts: { lastRefresh: string | null; count: number }) {
  m.getMeta.mockImplementation(async k => (k === 'index_refreshed_at' ? opts.lastRefresh : null));
  m.getEntryCount.mockResolvedValue(opts.count);
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
  calls = [];
  m.upsertIndexEntries.mockImplementation(async () => { calls.push('upsert'); });
  m.cleanDenormalizedTitles.mockImplementation(async () => { calls.push('clean'); });
  m.setMeta.mockImplementation(async k => { calls.push(`setMeta:${k}`); });
  m.invalidateLinkCache.mockImplementation(() => { calls.push('invalidate'); });
  m.getAllEntryTitles.mockImplementation(async () => { calls.push('titles'); return []; });
  fetchMock = jest.fn().mockResolvedValue(page(HTML));
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => jest.useRealTimers());

describe('is the index stale?', () => {
  test('fresh index: nothing is fetched or written', async () => {
    setup({ lastRefresh: String(NOW - 3600_000), count: 5 });
    await refreshIndexIfStale();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  test('exactly one week old is still fresh; one millisecond more is stale', async () => {
    setup({ lastRefresh: String(NOW - WEEK), count: 5 });
    await refreshIndexIfStale();
    expect(fetchMock).not.toHaveBeenCalled();
    setup({ lastRefresh: String(NOW - WEEK - 1), count: 5 });
    await refreshIndexIfStale();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test('never refreshed (null or empty) is stale', async () => {
    setup({ lastRefresh: null, count: 5 });
    await refreshIndexIfStale();
    setup({ lastRefresh: '', count: 5 });
    await refreshIndexIfStale();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test('an empty library is stale even if the timestamp is fresh', async () => {
    setup({ lastRefresh: String(NOW), count: 0 });
    await refreshIndexIfStale();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test('quirk: a non-numeric timestamp counts as fresh (NaN comparison is false)', async () => {
    setup({ lastRefresh: 'abc', count: 5 });
    await refreshIndexIfStale();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a successful refresh', () => {
  test('fetches contents.html with browser-like headers', async () => {
    setup({ lastRefresh: null, count: 0 });
    await refreshIndexIfStale();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://plato.stanford.edu/contents.html');
    expect(init.headers['User-Agent']).toMatch(/Mozilla/);
    expect(init.headers.Accept).toMatch(/text\/html/);
  });

  test('upserts the parsed, title-sorted entries, then cleans titles, then stamps the time', async () => {
    setup({ lastRefresh: null, count: 0 });
    await refreshIndexIfStale();
    expect(m.upsertIndexEntries).toHaveBeenCalledWith(PARSED);
    expect(m.setMeta).toHaveBeenCalledWith('index_refreshed_at', String(NOW));
    expect(calls.slice(0, 3)).toEqual(['upsert', 'clean', 'setMeta:index_refreshed_at']);
  });

  test('then rebuilds the link index in the background: longest titles first as returned, regex-escaped', async () => {
    setup({ lastRefresh: null, count: 0 });
    m.getAllEntryTitles.mockImplementation(async () => { calls.push('titles'); return [{ slug: 's1', title: 'Title (x)+' }, { slug: 's2', title: 'Plain' }]; });
    await refreshIndexIfStale();
    await flush();
    expect(calls).toEqual(['upsert', 'clean', 'setMeta:index_refreshed_at', 'titles', 'setMeta:link_index_json', 'invalidate']);
    const [, payload] = m.setMeta.mock.calls.find(c => c[0] === 'link_index_json')!;
    expect(JSON.parse(payload)).toEqual([
      { s: 's1', t: 'Title (x)+', p: 'Title \\(x\\)\\+' },
      { s: 's2', t: 'Plain', p: 'Plain' },
    ]);
  });

  test('the link index keeps at most 700 entries', async () => {
    setup({ lastRefresh: null, count: 0 });
    m.getAllEntryTitles.mockResolvedValue(Array.from({ length: 800 }, (_, i) => ({ slug: `s${i}`, title: `Title ${i}` })));
    await refreshIndexIfStale();
    await flush();
    const [, payload] = m.setMeta.mock.calls.find(c => c[0] === 'link_index_json')!;
    expect(JSON.parse(payload)).toHaveLength(700);
  });

  test('a failure while rebuilding the link index is swallowed', async () => {
    setup({ lastRefresh: null, count: 0 });
    m.getAllEntryTitles.mockRejectedValue(new Error('db'));
    await expect(refreshIndexIfStale()).resolves.toBeUndefined();
    await flush();
    expect(m.invalidateLinkCache).not.toHaveBeenCalled();
  });
});

describe('when the site cannot be read', () => {
  test('existing index + network error: silent, nothing written, timestamp unchanged', async () => {
    setup({ lastRefresh: null, count: 5 });
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(refreshIndexIfStale()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
  test('existing index + HTTP error: same', async () => {
    setup({ lastRefresh: null, count: 5 });
    fetchMock.mockResolvedValue(page('nope', false, 503));
    await refreshIndexIfStale();
    expect(calls).toEqual([]);
  });
  test('empty library + network error: falls back to the bundled title index', async () => {
    setup({ lastRefresh: null, count: 0 });
    fetchMock.mockRejectedValue(new Error('offline'));
    await refreshIndexIfStale();
    expect(m.upsertIndexEntries).toHaveBeenCalledTimes(1);
    expect(m.upsertIndexEntries.mock.calls[0][0]).toEqual(seed);
    expect((seed as unknown[]).length).toBeGreaterThan(1000);
  });
  test('quirk: the bundled fallback is stamped as a successful refresh, so it counts as fresh for a week', async () => {
    setup({ lastRefresh: null, count: 0 });
    fetchMock.mockRejectedValue(new Error('offline'));
    await refreshIndexIfStale();
    expect(m.setMeta).toHaveBeenCalledWith('index_refreshed_at', String(NOW));
  });
  test('a page that parses to zero entries writes nothing (and does not fall back to the seed)', async () => {
    setup({ lastRefresh: null, count: 0 });
    fetchMock.mockResolvedValue(page('<html>maintenance</html>'));
    await refreshIndexIfStale();
    expect(calls).toEqual([]);
  });
});

describe('storage errors are not swallowed (App.tsx relies on that)', () => {
  test('reading the timestamp or the count', async () => {
    m.getMeta.mockRejectedValue(new Error('db'));
    await expect(refreshIndexIfStale()).rejects.toThrow('db');
    m.getMeta.mockResolvedValue(null);
    m.getEntryCount.mockRejectedValue(new Error('db2'));
    await expect(refreshIndexIfStale()).rejects.toThrow('db2');
  });
  test('writing the entries', async () => {
    setup({ lastRefresh: null, count: 0 });
    m.upsertIndexEntries.mockRejectedValue(new Error('disk'));
    await expect(refreshIndexIfStale()).rejects.toThrow('disk');
    expect(m.setMeta).not.toHaveBeenCalled();
  });
});
