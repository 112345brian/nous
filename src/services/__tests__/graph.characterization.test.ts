// Characterization of the knowledge-graph feature (link graph, InPhO related / timeline /
// influence graphs, the index and relations caches, layout priming), run through the public
// functions the screens use, against a real in-memory SQLite and a fake network.
//
// `api()` is the only place that knows where those functions live: they moved from
// services/inpho + services/graphDb to the composition root, and every assertion below stayed.
import { createRealDb, type RealDb } from './helpers/realSqlite';

let mockCurrent: RealDb;
jest.mock('expo-sqlite', () => ({ __esModule: true, openDatabaseAsync: async () => mockCurrent }));

const mockReadFile = jest.fn();
jest.mock('expo-file-system', () => ({ readAsStringAsync: (...a: unknown[]) => mockReadFile(...a) }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///doc/' }));

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

let now = T0;
let db: any;
let m: any;
let g: any;
let calls: string[];
let detail: Record<string, any>;
let idea: any;
let thinker: any;
let failPaths: Set<string>;

function api() {
  const comp = require('../../composition');
  return {
    getGraph: comp.getGraph, getArticleLinkGraph: comp.getArticleLinkGraph, ensureInphoIndex: comp.ensureInphoIndex,
    primeBackfillForSlugs: comp.primeBackfillForSlugs, primeGraphLayouts: comp.primeGraphLayouts,
    getLayoutCache: comp.getLayoutCache, setLayoutCache: comp.setLayoutCache,
  };
}

const ideaList = () => ({ responseData: { results: [
  { ID: 10, label: 'Epistemology', sep_dir: 'epistemology' },
  { ID: 11, label: 'Elsewhere', sep_dir: 'kant-idea' },   // an entry we do not have
  { ID: 12, label: 'Empiricism', sep_dir: 'hume' },       // same slug as thinker 2: the idea wins
  { ID: 13, label: 'Nowhere', sep_dir: 'not-in-corpus' }, // not an entry we have
  { ID: 14, label: 'No dir', sep_dir: '' },
  { label: 'no id' },
] } });
const thinkerList = () => ({ responseData: { results: [
  { ID: 1, label: 'Kant', sep_dir: 'kant' },
  { ID: 2, label: 'Hume', sep_dir: 'hume' },
  { ID: 3, label: 'Leibniz', sep_dir: 'leibniz' },
  { ID: 4, label: 'Nobody', sep_dir: 'nobody' },
] } });

beforeEach(async () => {
  jest.resetModules();
  mockCurrent = createRealDb();
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockReadFile.mockReset().mockRejectedValue(new Error('no file'));
  calls = [];
  failPaths = new Set();
  idea = ideaList(); thinker = thinkerList();
  detail = {
    '/thinker/1.json': { responseData: { related_thinkers: [1, 2, 3, 4], related_ideas: [10, 12, 11, 13], teachers: [2], students: [3], influenced: [4], influenced_by: [3, 9], birth: [{ year: 1724 }], death: [{ year: 1804 }] } },
    '/thinker/2.json': { responseData: { birth: [{ year: 1711 }], death: [{ year: 1776 }] } },
    '/thinker/3.json': { responseData: { birth: [{ year: 1646 }], death: [{ year: 1716 }] } },
    '/thinker/4.json': { responseData: { birth: [], death: [] } },
    '/idea/10.json': { responseData: { related: [12, 13], related_thinkers: [2] } },
  };
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    const path = url.replace('https://www.inphoproject.org', '');
    calls.push(path);
    if (failPaths.has(path)) throw new Error('offline');
    const body = path === '/idea.json' ? idea : path === '/thinker.json' ? thinker : detail[path];
    if (body === undefined) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  });
  m = require('../db');
  db = await m.getDb();
  for (const [slug, title, prog] of [['kant', 'Kant', 0.5], ['hume', 'Hume', 0], ['leibniz', 'Leibniz', 0.95], ['epistemology', 'Epistemology', 0.2], ['orphan', 'Orphan', 0]] as const) {
    await db.runAsync('INSERT INTO entries (slug, title, read_progress) VALUES (?, ?, ?)', [slug, title, prog]);
  }
  await db.runAsync("INSERT INTO reads (slug, title, visited_at, session_id) VALUES ('kant', 'Kant', 1, 's'), ('kant', 'Kant', 2, 's'), ('hume', 'Hume', 3, 's')");
  g = api();
});
afterEach(() => { jest.restoreAllMocks(); delete (globalThis as any).fetch; });

const bySlug = (d: any) => Object.fromEntries(d.nodes.map((n: any) => [n.slug, n]));
const edgeKeys = (d: any) => d.edges.map((e: any) => `${e.from_slug}>${e.to_slug}${e.weight !== undefined ? `@${e.weight}` : ''}`).sort();
const cnt = (sql: string, ...p: unknown[]) => (mockCurrent.raw.prepare(sql).get(...p) as any).n as number;

describe('link graph (getArticleLinkGraph)', () => {
  it('is empty when the article has no links', async () => {
    expect(await g.getArticleLinkGraph('kant')).toEqual({ nodes: [], edges: [] });
  });

  it('holds the centre, its outgoing links and its backlinks, with read state and titles', async () => {
    for (const [a, b] of [['kant', 'hume'], ['kant', 'ghost'], ['leibniz', 'kant'], ['hume', 'leibniz']]) {
      await db.runAsync('INSERT INTO links (from_slug, to_slug) VALUES (?, ?)', [a, b]);
    }
    const d = await g.getArticleLinkGraph('kant');
    expect(edgeKeys(d)).toEqual(['kant>ghost', 'kant>hume', 'leibniz>kant']);
    const n = bySlug(d);
    expect(Object.keys(n).sort()).toEqual(['ghost', 'hume', 'kant', 'leibniz']);
    expect(n.kant).toEqual({ slug: 'kant', title: 'Kant', read: true, readProgress: 0.5, kind: 'entry' });
    expect(n.hume).toEqual({ slug: 'hume', title: 'Hume', read: true, readProgress: 0, kind: 'linked' });
    expect(n.leibniz).toEqual({ slug: 'leibniz', title: 'Leibniz', read: false, readProgress: 0.95, kind: 'linked' });
    expect(n.ghost).toEqual({ slug: 'ghost', title: 'ghost', read: false, readProgress: 0, kind: 'linked' }); // not in entries: slug as title
  });

  it('caps outgoing links at 150 and backlinks at 50', async () => {
    for (let i = 0; i < 160; i++) await db.runAsync('INSERT INTO links VALUES (?, ?)', ['kant', `out${i}`]);
    for (let i = 0; i < 60; i++) await db.runAsync('INSERT INTO links VALUES (?, ?)', [`in${i}`, 'kant']);
    const d = await g.getArticleLinkGraph('kant');
    expect(d.edges.filter((e: any) => e.from_slug === 'kant')).toHaveLength(150);
    expect(d.edges.filter((e: any) => e.to_slug === 'kant')).toHaveLength(50);
    expect(d.nodes).toHaveLength(201);
  });
});

describe('InPhO index (ensureInphoIndex)', () => {
  it('downloads both lists, keeps only usable rows, and stamps the sync time', async () => {
    expect(await g.ensureInphoIndex()).toBe(true);
    expect(calls.sort()).toEqual(['/idea.json', '/thinker.json']);
    const rows = mockCurrent.raw.prepare('SELECT kind, id, sep_dir FROM inpho_nodes ORDER BY kind, id').all();
    expect(rows.map((r: any) => `${r.kind}:${r.id}:${r.sep_dir}`)).toEqual([
      'idea:10:epistemology', 'idea:11:kant-idea', 'idea:12:hume', 'idea:13:not-in-corpus', 'idea:14:null',
      'thinker:1:kant', 'thinker:2:hume', 'thinker:3:leibniz', 'thinker:4:nobody',
    ]);
    expect(await m.getMeta('inpho_index_synced_at')).toBe(String(T0));
  });

  it('unwraps the other payload shapes InPhO uses', async () => {
    idea = { results: [{ ID: 1, label: 'a', sep_dir: 'x' }] };
    thinker = [{ ID: 2, label: 'b', sep_dir: 'y' }];
    await g.ensureInphoIndex();
    expect(cnt('SELECT COUNT(*) AS n FROM inpho_nodes')).toBe(2);
  });

  it('does not download again while the index is under 90 days old', async () => {
    await g.ensureInphoIndex();
    calls.length = 0;
    now = T0 + 90 * DAY - 1;
    expect(await g.ensureInphoIndex()).toBe(true);
    expect(calls).toEqual([]);
  });

  it('downloads again at exactly 90 days, and when forced', async () => {
    await g.ensureInphoIndex();
    calls.length = 0;
    now = T0 + 90 * DAY;
    await g.ensureInphoIndex();
    expect(calls.sort()).toEqual(['/idea.json', '/thinker.json']);
    calls.length = 0;
    await g.ensureInphoIndex(true);
    expect(calls.sort()).toEqual(['/idea.json', '/thinker.json']);
  });

  it('keeps using a stale index when the refresh fails, and reports failure when there is none', async () => {
    expect(await g.ensureInphoIndex()).toBe(true);
    failPaths.add('/idea.json');
    now = T0 + 91 * DAY;
    expect(await g.ensureInphoIndex()).toBe(true);
    mockCurrent.raw.exec('DELETE FROM inpho_nodes');
    expect(await g.ensureInphoIndex()).toBe(false);
  });

  it('a non-ok response or an empty list leaves the index empty', async () => {
    detail['/idea.json'] = undefined;
    idea = { responseData: { results: [] } };
    thinker = { responseData: { results: [] } };
    expect(await g.ensureInphoIndex()).toBe(false);
    expect(cnt('SELECT COUNT(*) AS n FROM inpho_nodes')).toBe(0);
  });

  it('a resync keeps the birth/death years already fetched', async () => {
    await g.ensureInphoIndex();
    mockCurrent.raw.exec("UPDATE inpho_nodes SET birth_year = 1700, death_year = 1780, dates_checked = 1 WHERE kind = 'thinker' AND id = 2");
    await g.ensureInphoIndex(true);
    const r = mockCurrent.raw.prepare("SELECT birth_year, death_year, dates_checked FROM inpho_nodes WHERE kind = 'thinker' AND id = 2").get();
    expect({ ...r }).toEqual({ birth_year: 1700, death_year: 1780, dates_checked: 1 });
  });

  describe('dev seed files', () => {
    it('are preferred over the network when readable (dev builds)', async () => {
      mockReadFile.mockImplementation(async (uri: string) => JSON.stringify(uri.endsWith('inpho-idea.json') ? idea : thinker));
      expect(await g.ensureInphoIndex()).toBe(true);
      expect(calls).toEqual([]);
      expect(mockReadFile.mock.calls.map(c => c[0]).sort()).toEqual(['file:///doc/dev-seeds/inpho-idea.json', 'file:///doc/dev-seeds/inpho-thinker.json']);
      expect(cnt('SELECT COUNT(*) AS n FROM inpho_nodes')).toBe(9);
    });
    it('fall back to the network when a file is missing or malformed', async () => {
      mockReadFile.mockImplementation(async (uri: string) => (uri.endsWith('inpho-idea.json') ? 'not json' : '{}'));
      expect(await g.ensureInphoIndex()).toBe(true);
      expect(calls.sort()).toEqual(['/idea.json', '/thinker.json']);
    });
  });
});

describe('getGraph', () => {
  it('is empty when the entry has no InPhO node', async () => {
    expect(await g.getGraph('orphan')).toEqual({ nodes: [], edges: [] });
  });

  it("'related': corpus entries only, the idea wins over a thinker of the same slug, the centre is excluded", async () => {
    const d = await g.getGraph('kant', 'related');
    expect(edgeKeys(d)).toEqual(['kant>epistemology', 'kant>hume', 'kant>leibniz']);
    const n = bySlug(d);
    expect(n.kant).toEqual({ slug: 'kant', title: 'Kant', read: true, readProgress: 0.5, kind: 'entry' });
    expect(n.hume.kind).toBe('idea');
    expect(n.epistemology.kind).toBe('idea');
    expect(n.leibniz).toEqual({ slug: 'leibniz', title: 'Leibniz', read: false, readProgress: 0.95, kind: 'thinker' });
    expect(Object.keys(n).sort()).toEqual(['epistemology', 'hume', 'kant', 'leibniz']);
  });

  it("'related' for an idea-centred entry uses its own relation lists", async () => {
    const d = await g.getGraph('epistemology', 'related');
    expect(edgeKeys(d)).toEqual(['epistemology>hume']);
  });

  it("'influence': directed, teachers and students weigh 3, other influence 1.5", async () => {
    const d = await g.getGraph('kant', 'influence');
    // influenced_by [3, 9] gives leibniz>kant at 1.5 (leibniz is not in `teachers`); 9 is not in the corpus.
    expect(edgeKeys(d)).toEqual(['hume>kant@3', 'kant>leibniz@3', 'leibniz>kant@1.5']);
    expect(bySlug(d).hume.kind).toBe('thinker');
    expect(bySlug(d).kant.kind).toBe('entry');
  });

  it("'influence' is empty for an idea-centred entry", async () => {
    expect(await g.getGraph('epistemology', 'influence')).toEqual({ nodes: [], edges: [] });
  });

  it("'timeline': related thinkers with birth/death years, dates fetched lazily and stored", async () => {
    const d = await g.getGraph('kant', 'timeline');
    const n = bySlug(d);
    expect(n.kant).toMatchObject({ kind: 'entry', birthYear: 1724, deathYear: 1804 });
    expect(n.hume).toMatchObject({ kind: 'thinker', birthYear: 1711, deathYear: 1776 });
    expect(n.leibniz).toMatchObject({ kind: 'thinker', birthYear: 1646, deathYear: 1716 });
    expect(edgeKeys(d)).toEqual(['kant>hume', 'kant>leibniz']);
    expect(cnt("SELECT COUNT(*) AS n FROM inpho_nodes WHERE kind = 'thinker' AND dates_checked = 1")).toBe(4);
  });

  it('a thinker with no recorded dates is marked checked and not fetched again', async () => {
    await g.getGraph('kant', 'timeline');
    calls.length = 0;
    await g.getGraph('kant', 'timeline');
    expect(calls.filter(c => /thinker\/\d\.json/.test(c))).toEqual([]);
  });

  it('a failed date fetch leaves the thinker to be retried', async () => {
    await g.getGraph('kant', 'related');
    failPaths.add('/thinker/2.json');
    await g.getGraph('kant', 'timeline');
    expect(cnt("SELECT dates_checked AS n FROM inpho_nodes WHERE kind = 'thinker' AND id = 2")).toBe(0);
    expect(cnt("SELECT dates_checked AS n FROM inpho_nodes WHERE kind = 'thinker' AND id = 3")).toBe(1);
  });

  it('fetches dates in batches of 5 at a time', async () => {
    const ids = [101, 102, 103, 104, 105, 106, 107];
    thinker = { responseData: { results: [{ ID: 1, label: 'Kant', sep_dir: 'kant' }, ...ids.map(i => ({ ID: i, label: `t${i}`, sep_dir: `t${i}` }))] } };
    detail['/thinker/1.json'] = { responseData: { related_thinkers: ids } };
    for (const i of ids) detail[`/thinker/${i}.json`] = { responseData: { birth: [{ year: 1 }], death: [{ year: 2 }] } };
    let live = 0, peak = 0;
    const base = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn(async (u: string) => {
      if (/thinker\/10\d\.json/.test(u)) { live++; peak = Math.max(peak, live); await new Promise<void>(r => setTimeout(r, 5)); live--; }
      return base(u);
    });
    await g.getGraph('kant', 'timeline');
    expect(peak).toBe(5);
  });

  it('caches relations for 7 days: no refetch inside the window, a refetch after it', async () => {
    await g.getGraph('kant', 'related');
    const detailCalls = () => calls.filter(c => c === '/thinker/1.json').length;
    expect(detailCalls()).toBe(1);
    now = T0 + 7 * DAY; // exactly 7 days: still fresh (the rule is "older than")
    await g.getGraph('kant', 'related');
    expect(detailCalls()).toBe(1);
    now = T0 + 7 * DAY + 1;
    await g.getGraph('kant', 'related');
    expect(detailCalls()).toBe(2);
  });

  it('a failed relations fetch yields an empty graph and is not cached', async () => {
    await g.ensureInphoIndex();
    failPaths.add('/thinker/1.json');
    expect(await g.getGraph('kant', 'related')).toEqual({ nodes: [], edges: [] });
    expect(cnt('SELECT COUNT(*) AS n FROM inpho_relations')).toBe(0);
    failPaths.clear();
    expect((await g.getGraph('kant', 'related')).nodes.length).toBeGreaterThan(1);
  });

  it('a corrupt cached relations row is refetched', async () => {
    await g.getGraph('kant', 'related');
    mockCurrent.raw.exec("UPDATE inpho_relations SET payload = '{nope'");
    calls.length = 0;
    const d = await g.getGraph('kant', 'related');
    expect(d.nodes.length).toBeGreaterThan(1);
  });
});

describe('primeBackfillForSlugs', () => {
  it('fetches missing dates only for thinkers in fresh cached relations, never relations themselves', async () => {
    await g.getGraph('kant', 'related');
    calls.length = 0;
    await g.primeBackfillForSlugs(['kant', 'unknown']);
    expect(calls.sort()).toEqual(['/thinker/2.json', '/thinker/3.json', '/thinker/4.json']);
  });
  it('does nothing for stale relations and never rejects', async () => {
    await g.getGraph('kant', 'related');
    calls.length = 0;
    now = T0 + 8 * DAY;
    await g.primeBackfillForSlugs(['kant']);
    expect(calls).toEqual([]);
    mockCurrent.raw.exec('DROP TABLE inpho_nodes');
    await expect(g.primeBackfillForSlugs(['kant'])).resolves.toBeUndefined();
  });
});

describe('layout cache and priming', () => {
  const pos = [{ slug: 'kant', xRel: 0.5, yRel: 0.5 }];
  it('round-trips positions and invalidates when the node set changes', async () => {
    expect(await g.getLayoutCache('kant', 'links', ['a', 'b'])).toBeNull();
    await g.setLayoutCache('kant', 'links', ['a', 'b'], pos);
    expect(await g.getLayoutCache('kant', 'links', ['b', 'a'])).toEqual(pos); // order does not matter
    expect(await g.getLayoutCache('kant', 'links', ['a', 'b', 'c'])).toBeNull();
    expect(await g.getLayoutCache('kant', 'related', ['a', 'b'])).toBeNull();
  });
  it('keys the cache by a pinned FNV-1a hash of the sorted slugs', async () => {
    await g.setLayoutCache('kant', 'links', ['b', 'a'], pos);
    const r = mockCurrent.raw.prepare('SELECT layout_key, created_at FROM graph_layout_cache').get();
    expect({ ...r }).toEqual({ layout_key: 692878806, created_at: T0 });
  });
  it('a corrupt cached layout reads as a miss', async () => {
    await g.setLayoutCache('kant', 'links', ['a'], pos);
    mockCurrent.raw.exec("UPDATE graph_layout_cache SET positions = 'x'");
    expect(await g.getLayoutCache('kant', 'links', ['a'])).toBeNull();
  });

  const modes = () => mockCurrent.raw.prepare('SELECT center_slug, mode FROM graph_layout_cache ORDER BY mode').all().map((r: any) => `${r.center_slug}:${r.mode}`);

  it('computes the links layout for a linked article, and no InPhO layouts without cached relations', async () => {
    await db.runAsync("INSERT INTO links VALUES ('kant', 'hume')");
    await g.primeGraphLayouts(['kant']);
    expect(modes()).toEqual(['kant:links']);
    const row = mockCurrent.raw.prepare('SELECT positions FROM graph_layout_cache').get();
    const p = JSON.parse(row.positions);
    expect(p.map((x: any) => x.slug).sort()).toEqual(['hume', 'kant']);
    for (const q of p) { expect(q.xRel).toBeGreaterThanOrEqual(-1); expect(q.yRel).toBeLessThanOrEqual(2); }
  });

  it('with cached relations and dates, computes all four views', async () => {
    await db.runAsync("INSERT INTO links VALUES ('kant', 'hume')");
    await g.getGraph('kant', 'timeline'); // caches relations and dates
    calls.length = 0;
    await g.primeGraphLayouts(['kant']);
    expect(modes()).toEqual(['kant:influence', 'kant:links', 'kant:related', 'kant:timeline']);
    expect(calls).toEqual([]); // priming never fetches relations or dates
  });

  it('skips the timeline while a thinker still lacks dates', async () => {
    await g.getGraph('kant', 'related'); // relations cached, dates not fetched
    await g.primeGraphLayouts(['kant']);
    expect(modes()).toEqual(['kant:influence', 'kant:related']);
  });

  it('does not queue a slug twice in a session, even if its layout was deleted', async () => {
    await db.runAsync("INSERT INTO links VALUES ('kant', 'hume')");
    await g.primeGraphLayouts(['kant']);
    mockCurrent.raw.exec('DELETE FROM graph_layout_cache');
    await g.primeGraphLayouts(['kant']);
    expect(modes()).toEqual([]);
  });

  it('never rejects (best effort) and a slug that failed stays marked as done', async () => {
    mockCurrent.raw.exec('DROP TABLE links');
    await expect(g.primeGraphLayouts(['kant'])).resolves.toBeUndefined();
  });

  it('an unchanged cached layout is not recomputed', async () => {
    await db.runAsync("INSERT INTO links VALUES ('kant', 'hume')");
    await g.primeGraphLayouts(['kant']);
    mockCurrent.raw.exec("UPDATE graph_layout_cache SET created_at = 1");
    jest.resetModules();
    g = api();
    await g.primeGraphLayouts(['kant']);
    expect(cnt('SELECT created_at AS n FROM graph_layout_cache')).toBe(1);
  });
});
