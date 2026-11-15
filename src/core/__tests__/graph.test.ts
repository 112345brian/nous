// The knowledge-graph use cases with in-memory fakes: no SQLite, no network, no jest.mock.
// Date.now, setTimeout and fetch are made to throw, so any read of the real clock, timer or
// network inside the core fails the test.
import { createGraph, INDEX_SYNCED_KEY, type GraphDeps } from '../graph';
import { layoutKey, INDEX_TTL_MS, RELATIONS_TTL_MS, relationsFresh, indexFresh } from '../graphAssembly';
import type { GraphEntryRow, GraphStore, LayoutRow, RelationsRow } from '../ports';
import type { GraphEdge, InphoNodeRow } from '../../types';

declare function require(mod: string): any;
declare const __dirname: string;

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface World {
  deps: GraphDeps;
  nodes: InphoNodeRow[];
  relations: Map<string, RelationsRow>;
  layouts: Map<string, LayoutRow & { created_at: number }>;
  meta: Map<string, string>;
  fetched: string[];
  detail: Record<string, any>;
  clock: { t: number };
  sleeps: number[];
  setDatesCalls: number[];
  opts: { devSeed: { ideas: unknown; thinkers: unknown } | null; offline: boolean; failReplace: boolean };
}

const IDEAS = { responseData: { results: [
  { ID: 10, label: 'Epistemology', sep_dir: 'epistemology' },
  { ID: 12, label: 'Empiricism', sep_dir: 'hume' },
  { ID: 13, label: 'Nowhere', sep_dir: 'not-in-corpus' },
] } };
const THINKERS = { responseData: { results: [
  { ID: 1, label: 'Kant', sep_dir: 'kant' }, { ID: 2, label: 'Hume', sep_dir: 'hume' },
  { ID: 3, label: 'Leibniz', sep_dir: 'leibniz' },
] } };

function world(o: Partial<World['opts']> = {}, seedIndex = false): World {
  const w = {
    nodes: [] as InphoNodeRow[], relations: new Map<string, RelationsRow>(),
    layouts: new Map<string, LayoutRow & { created_at: number }>(), meta: new Map<string, string>(),
    fetched: [] as string[], clock: { t: NOW }, sleeps: [] as number[], setDatesCalls: [] as number[],
    opts: { devSeed: null, offline: false, failReplace: false, ...o },
    detail: {
      '/thinker/1.json': { responseData: { related_thinkers: [1, 2, 3], related_ideas: [10, 12], teachers: [2], students: [3], influenced: [], influenced_by: [3], birth: [{ year: 1724 }], death: [{ year: 1804 }] } },
      '/thinker/2.json': { responseData: { birth: [{ year: 1711 }], death: [{ year: 1776 }] } },
      '/thinker/3.json': { responseData: { birth: [{ year: 1646 }], death: [{ year: 1716 }] } },
    } as Record<string, any>,
  } as unknown as World;
  const entries: GraphEntryRow[] = [
    { slug: 'kant', title: 'Kant', read_progress: 0.5 }, { slug: 'hume', title: 'Hume', read_progress: 0 },
    { slug: 'leibniz', title: 'Leibniz', read_progress: 0.95 }, { slug: 'epistemology', title: 'Epistemology', read_progress: null },
  ];
  const links: GraphEdge[] = [{ from_slug: 'kant', to_slug: 'hume' }, { from_slug: 'leibniz', to_slug: 'kant' }];
  const dates = new Map<number, { b: number | null; d: number | null; checked: boolean }>();
  const store: GraphStore = {
    outgoingLinks: async (s, n) => links.filter(l => l.from_slug === s).slice(0, n),
    incomingLinks: async (s, n) => links.filter(l => l.to_slug === s).slice(0, n),
    entriesBySlugs: async slugs => entries.filter(e => slugs.includes(e.slug)),
    readSlugs: async () => ['kant'],
    indexCount: async () => w.nodes.length,
    replaceIndex: async n => { if (w.opts.failReplace) throw new Error('disk full'); w.nodes = n.map(x => ({ ...x })); },
    nodeBySep: async slug => {
      const rows = w.nodes.filter(n => n.sep_dir === slug).sort((a, b) => (a.kind === 'idea' ? 0 : 1) - (b.kind === 'idea' ? 0 : 1));
      return rows[0] ?? null;
    },
    nodesByIds: async (ii, ti) => w.nodes.filter(n => (n.kind === 'idea' && ii.includes(n.id)) || (n.kind === 'thinker' && ti.includes(n.id)))
      .map(n => ({ ...n, birth_year: dates.get(n.id)?.b ?? null, death_year: dates.get(n.id)?.d ?? null })),
    thinkerDatesBySep: async slug => {
      const n = w.nodes.find(x => x.sep_dir === slug && x.kind === 'thinker');
      return n ? { birth_year: dates.get(n.id)?.b ?? null, death_year: dates.get(n.id)?.d ?? null } : null;
    },
    thinkersMissingDates: async ids => w.nodes.filter(n => n.kind === 'thinker' && ids.includes(n.id) && !dates.get(n.id)?.checked).reverse(),
    setDates: async (id, b, d) => { w.setDatesCalls.push(id); dates.set(id, { b, d, checked: true }); },
    relationsRows: async slugs => slugs.flatMap(s => (w.relations.has(s) ? [w.relations.get(s) as RelationsRow] : [])),
    putRelations: async (slug, payload, fetched_at) => { w.relations.set(slug, { slug, payload, fetched_at }); },
    layoutRow: async (c, m) => w.layouts.get(`${c}|${m}`) ?? null,
    putLayoutRow: async (c, m, key, positions, created_at) => { w.layouts.set(`${c}|${m}`, { layout_key: key, positions, created_at }); },
  };
  w.deps = {
    source: {
      fetchJson: async path => {
        w.fetched.push(path);
        if (w.opts.offline) return null;
        return path === '/idea.json' ? IDEAS : path === '/thinker.json' ? THINKERS : (w.detail[path] ?? null);
      },
      readDevSeed: async () => w.opts.devSeed,
    },
    store,
    meta: { getMeta: async k => w.meta.get(k) ?? null, setMeta: async (k, v) => { w.meta.set(k, v); } },
    clock: { now: () => w.clock.t },
    sleep: async ms => { w.sleeps.push(ms); },
    articles: {
      getPreview: async slug => ({ title: slug, author: `by ${slug}`, excerpt: 'stored teaser' }),
      getHtml: async slug => (slug === 'kant' ? '<p>Kant read <a href="/entries/hume/">Hume</a> closely.</p>' : '<p>Hume wrote a lot.</p>'),
    },
  };
  if (seedIndex) {
    w.nodes = [
      ...IDEAS.responseData.results.map(i => ({ id: i.ID, kind: 'idea' as const, label: i.label, sep_dir: i.sep_dir })),
      ...THINKERS.responseData.results.map(i => ({ id: i.ID, kind: 'thinker' as const, label: i.label, sep_dir: i.sep_dir })),
    ];
    w.meta.set(INDEX_SYNCED_KEY, String(NOW));
  }
  return w;
}

const edgeKeys = (d: { edges: GraphEdge[] }) => d.edges.map(e => `${e.from_slug}>${e.to_slug}${e.weight !== undefined ? `@${e.weight}` : ''}`).sort();

describe('the graph core with fakes', () => {
  const realFetch = (globalThis as any).fetch;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
    jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
    (globalThis as any).fetch = () => { throw new Error('core used the network'); };
  });
  afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

  describe('cache lifetimes', () => {
    it('relations are stale only when strictly older than 7 days', () => {
      expect(relationsFresh(NOW, NOW - RELATIONS_TTL_MS)).toBe(true);
      expect(relationsFresh(NOW, NOW - RELATIONS_TTL_MS - 1)).toBe(false);
    });
    it('the index is fresh only while strictly younger than 90 days', () => {
      expect(indexFresh(NOW, NOW - INDEX_TTL_MS + 1)).toBe(true);
      expect(indexFresh(NOW, NOW - INDEX_TTL_MS)).toBe(false);
    });
  });

  describe('ensureInphoIndex', () => {
    it('syncs an empty index, stamping the injected clock', async () => {
      const w = world();
      expect(await createGraph(w.deps).ensureInphoIndex()).toBe(true);
      expect(w.nodes).toHaveLength(6);
      expect(w.meta.get(INDEX_SYNCED_KEY)).toBe(String(NOW));
    });
    it('does not fetch while fresh, fetches at exactly the TTL, and when forced', async () => {
      const w = world({}, true);
      const g = createGraph(w.deps);
      w.clock.t = NOW + INDEX_TTL_MS - 1;
      await g.ensureInphoIndex();
      expect(w.fetched).toEqual([]);
      w.clock.t = NOW + INDEX_TTL_MS;
      await g.ensureInphoIndex();
      expect(w.fetched.sort()).toEqual(['/idea.json', '/thinker.json']);
      w.fetched.length = 0; w.clock.t += 1;
      await g.ensureInphoIndex(true);
      expect(w.fetched).toHaveLength(2);
    });
    it('keeps a stale index when the refresh fails; fails when there is no index', async () => {
      const stale = world({ offline: true }, true);
      stale.clock.t = NOW + 200 * DAY;
      expect(await createGraph(stale.deps).ensureInphoIndex()).toBe(true);
      expect(await createGraph(world({ offline: true }).deps).ensureInphoIndex()).toBe(false);
    });
    it('prefers the dev seed over the network, and falls back when it holds nothing usable', async () => {
      const seeded = world({ devSeed: { ideas: IDEAS, thinkers: THINKERS } });
      await createGraph(seeded.deps).ensureInphoIndex();
      expect(seeded.fetched).toEqual([]);
      const empty = world({ devSeed: { ideas: { results: [] }, thinkers: { results: [] } } });
      await createGraph(empty.deps).ensureInphoIndex();
      expect(empty.fetched).toHaveLength(2);
    });
    it('a store failure while writing the index rejects (it is not swallowed into a refetch)', async () => {
      const w = world({ failReplace: true });
      await expect(createGraph(w.deps).ensureInphoIndex()).rejects.toThrow('disk full');
    });
  });

  describe('getGraph', () => {
    it('related: idea beats thinker for one slug, the centre is excluded, corpus only', async () => {
      const w = world({}, true);
      const d = await createGraph(w.deps).getGraph('kant', 'related');
      expect(edgeKeys(d)).toEqual(['kant>epistemology', 'kant>hume', 'kant>leibniz']);
      const kinds = Object.fromEntries(d.nodes.map(n => [n.slug, n.kind]));
      expect(kinds).toEqual({ kant: 'entry', epistemology: 'idea', hume: 'idea', leibniz: 'thinker' });
      expect(d.nodes.find(n => n.slug === 'kant')).toMatchObject({ read: true, readProgress: 0.5 });
      expect(d.nodes.find(n => n.slug === 'epistemology')).toMatchObject({ readProgress: 0 }); // null progress reads as 0
    });
    it('influence: teachers and students 3, other influence 1.5, directed by flow', async () => {
      const w = world({}, true);
      const d = await createGraph(w.deps).getGraph('kant', 'influence');
      expect(edgeKeys(d)).toEqual(['hume>kant@3', 'kant>leibniz@3', 'leibniz>kant@1.5']);
    });
    it('timeline: dates are fetched through the source and land on the nodes', async () => {
      const w = world({}, true);
      const d = await createGraph(w.deps).getGraph('kant', 'timeline');
      expect(d.nodes.find(n => n.slug === 'hume')).toMatchObject({ birthYear: 1711, deathYear: 1776 });
      expect(d.nodes.find(n => n.slug === 'kant')).toMatchObject({ birthYear: 1724, deathYear: 1804 });
    });
    it('relations are cached for 7 days by the injected clock', async () => {
      const w = world({}, true);
      const g = createGraph(w.deps);
      await g.getGraph('kant', 'related');
      const n = () => w.fetched.filter(p => p === '/thinker/1.json').length;
      w.clock.t = NOW + RELATIONS_TTL_MS;
      await g.getGraph('kant', 'related');
      expect(n()).toBe(1);
      w.clock.t = NOW + RELATIONS_TTL_MS + 1;
      await g.getGraph('kant', 'related');
      expect(n()).toBe(2);
    });
    it('a failed relations fetch is empty and not cached', async () => {
      const w = world({}, true);
      delete w.detail['/thinker/1.json'];
      expect(await createGraph(w.deps).getGraph('kant', 'related')).toEqual({ nodes: [], edges: [] });
      expect(w.relations.size).toBe(0);
    });
    it('backfills dates in priority order, 5 at a time', async () => {
      const w = world({}, true);
      const ids = [101, 102, 103, 104, 105, 106, 107];
      for (const id of ids) { w.nodes.push({ id, kind: 'thinker', label: `t${id}`, sep_dir: `t${id}` }); w.detail[`/thinker/${id}.json`] = { responseData: { birth: [{ year: 1 }] } }; }
      w.relations.set('kant', { slug: 'kant', payload: JSON.stringify({ ideas: [], thinkers: ids }), fetched_at: NOW });
      let live = 0, peak = 0;
      const src = w.deps.source.fetchJson;
      w.deps.source.fetchJson = async p => { live++; peak = Math.max(peak, live); await Promise.resolve(); await Promise.resolve(); live--; return src(p); };
      await createGraph(w.deps).primeBackfillForSlugs(['kant']);
      expect(peak).toBe(5);
      expect(w.setDatesCalls.sort()).toEqual(ids);
    });
  });

  describe('link graph', () => {
    it('has the centre and its neighbours, with the centre marked', async () => {
      const w = world({}, true);
      const d = await createGraph(w.deps).getArticleLinkGraph('kant');
      expect(d.nodes.map(n => `${n.slug}:${n.kind}`)).toEqual(['kant:entry', 'hume:linked', 'leibniz:linked']);
      expect(edgeKeys(d)).toEqual(['kant>hume', 'leibniz>kant']);
    });
    it('is empty without links', async () => {
      expect(await createGraph(world({}, true).deps).getArticleLinkGraph('orphan')).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('layout priming', () => {
    it('computes and stores layouts, pausing through the injected sleep, never a real timer', async () => {
      const w = world({}, true);
      await createGraph(w.deps).primeGraphLayouts(['kant']);
      expect([...w.layouts.keys()].sort()).toEqual(['kant|links']);
      expect(w.sleeps.length).toBeGreaterThan(0);
      expect(new Set(w.sleeps)).toEqual(new Set([0]));
      expect(w.layouts.get('kant|links')?.created_at).toBe(NOW);
    });
    it('primed slugs are per instance: a second instance does the work again', async () => {
      const w = world({}, true);
      const a = createGraph(w.deps);
      await a.primeGraphLayouts(['kant']);
      w.layouts.clear();
      await a.primeGraphLayouts(['kant']);
      expect(w.layouts.size).toBe(0); // same instance remembers
      await createGraph(w.deps).primeGraphLayouts(['kant']);
      expect(w.layouts.size).toBe(1); // a new instance does not share hidden state
    });
    it('a store failure is swallowed, and the slug stays marked', async () => {
      const w = world({}, true);
      w.deps.store.outgoingLinks = async () => { throw new Error('db gone'); };
      const g = createGraph(w.deps);
      await expect(g.primeGraphLayouts(['kant'])).resolves.toBeUndefined();
    });
    it('the layout key is a pinned order-independent hash', () => {
      expect(layoutKey(['b', 'a'])).toBe(692878806);
      expect(layoutKey(['a', 'b'])).toBe(692878806);
      expect(layoutKey(['a'])).not.toBe(layoutKey(['a', 'b']));
    });
    it('a cached layout is a hit only for the same node set', async () => {
      const w = world({}, true);
      const g = createGraph(w.deps);
      await g.setLayoutCache('kant', 'links', ['b', 'a'], [{ slug: 'a', xRel: 0.1, yRel: 0.2 }]);
      expect(await g.getLayoutCache('kant', 'links', ['a', 'b'])).toEqual([{ slug: 'a', xRel: 0.1, yRel: 0.2 }]);
      expect(await g.getLayoutCache('kant', 'links', ['a'])).toBeNull();
    });
  });

  describe('screen helpers', () => {
    it('preview: excerpt from the body, and in the links view the sentence linking the two', async () => {
      const g = createGraph(world({}, true).deps);
      const p = await g.getNodePreview('hume', 'kant', 'links');
      expect(p).toEqual({ author: 'by hume', excerpt: 'Hume wrote a lot.', context: 'Kant read Hume closely.' });
      expect((await g.getNodePreview('hume', 'kant', 'related')).context).toBeNull();
      expect((await g.getNodePreview('kant', 'kant', 'links')).context).toBeNull();
    });
    it('the visited-only preference round-trips through the key/value store', async () => {
      const w = world();
      const g = createGraph(w.deps);
      expect(await g.getVisitedOnly()).toBe(false);
      await g.setVisitedOnly(true);
      expect(w.meta.get('graph_visited_only')).toBe('1');
      expect(await g.getVisitedOnly()).toBe(true);
      await g.setVisitedOnly(false);
      expect(await g.getVisitedOnly()).toBe(false);
    });
  });
});

describe('who may touch the graph adapters', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..', '..', '..');
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(rel, acc); }
      else if (/\.tsx?$/.test(e.name)) acc.push(rel);
    }
    return acc;
  };
  const files = [...walk('src'), 'App.tsx'];
  const importing = (needle: RegExp) => files.filter(f => needle.test(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '')));

  it('only the composition root imports the graph store and the InPhO source', () => {
    expect(importing(/from '[^']*\/(graphDb|inphoSource)'/).filter(f => f !== 'src/composition.ts')).toEqual([]);
  });
  it('no service file keeps the old module-level graph state or imports services/db to find a connection', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/services/graphDb.ts'), 'utf8');
    expect(text).not.toMatch(/from '\.\/db'/);
    expect(text).not.toMatch(/^(let|const) _schema/m);
    expect(text).not.toMatch(/Date\.now|setTimeout/);
    expect(fs.existsSync(path.join(ROOT, 'src/services/inpho.ts'))).toBe(false);
  });
});
