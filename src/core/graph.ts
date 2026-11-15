// The knowledge-graph use cases: the SEP link graph, the InPhO related / timeline / influence
// graphs, the index and relations caches, and the background priming of layouts. Everything it
// touches comes in through `GraphDeps` (the InPhO source, the graph tables, the settings, the clock,
// the pause), and all of its state (which slugs this session already primed) lives in the instance.
//
// LICENSING: InPhO data is CC BY-NC-SA. It is fetched per client at runtime through `GraphSource`
// and cached locally; nothing here, or anywhere in the build, bundles it.
import { forceLayout, slugSeed } from '../utils/forceLayout';
import { makeExcerpt } from '../utils/excerpt';
import { findLinkSentence } from '../utils/linkSentence';
import type {
  CachedPosition, GraphData, GraphMode, GraphView, InphoNodeRow, InphoRelations,
} from '../types';
import type { Clock, GraphArticles, GraphSource, GraphStore, KeyValueStore, Sleep } from './ports';
import {
  assembleArticleLinkGraph, assembleInfluenceGraph, assembleSemanticGraph, assembleTimelineGraph,
  candidateSlugs, emptyGraph, indexFresh, influenceIds, inPriorityOrder, layoutKey, parseIndexNodes,
  parseRelations, parseStoredRelations, pickCorpusNodes, readContext, relatedCandidates,
  relationsFresh, unwrap, yearOf, linkGraphSlugs, type CorpusNode, type ReadContext,
} from './graphAssembly';

export interface GraphDeps {
  source: GraphSource;
  store: GraphStore;
  /** Where the index sync time and the "visited only" preference live. */
  meta: KeyValueStore;
  clock: Clock;
  /** Yields between layout frames so the JS thread stays free. */
  sleep: Sleep;
  articles: GraphArticles;
}

export const INDEX_SYNCED_KEY = 'inpho_index_synced_at';
export const VISITED_ONLY_KEY = 'graph_visited_only';
/** Outgoing links and backlinks shown around one article. */
export const OUTGOING_LIMIT = 150;
export const INCOMING_LIMIT = 50;
/** Thinker detail requests in flight at once when backfilling dates. */
const DATE_BATCH = 5;

// Reference canvas for background layout; positions are stored relative so any device can use them.
const PRIME_W = 390;
const PRIME_H = 760;

export interface NodePreview { author: string | null; excerpt: string | null; context: string | null }

export function createGraph(deps: GraphDeps) {
  const { source, store, meta, clock, sleep, articles } = deps;
  // Session-level: repeated article opens do not re-queue slugs already processed.
  const primed = new Set<string>();

  // ── Link graph ─────────────────────────────────────────────────────────────

  /** Local link graph for one article: the centre, its outgoing links and its backlinks. */
  async function getArticleLinkGraph(centerSlug: string): Promise<GraphData> {
    const outgoing = await store.outgoingLinks(centerSlug, OUTGOING_LIMIT);
    const incoming = await store.incomingLinks(centerSlug, INCOMING_LIMIT);
    const edges = [...outgoing, ...incoming];
    if (edges.length === 0) return emptyGraph();
    const [readSlugs, entries] = await Promise.all([
      store.readSlugs(),
      store.entriesBySlugs(linkGraphSlugs(centerSlug, edges)),
    ]);
    return assembleArticleLinkGraph(centerSlug, outgoing, incoming, entries, readSlugs);
  }

  // ── InPhO index ────────────────────────────────────────────────────────────

  /** Write parsed index lists to the local index and stamp the sync time. */
  async function storeIndex(ideaRaw: unknown, thinkerRaw: unknown): Promise<boolean> {
    const nodes = parseIndexNodes(ideaRaw, thinkerRaw);
    if (!nodes) return false;
    await store.replaceIndex(nodes);
    await meta.setMeta(INDEX_SYNCED_KEY, String(clock.now()));
    return true;
  }

  /** Download the idea and thinker lists and replace the local index. */
  async function syncInphoIndex(): Promise<boolean> {
    const [ideaRaw, thinkerRaw] = await Promise.all([
      source.fetchJson('/idea.json'),
      source.fetchJson('/thinker.json'),
    ]);
    if (!ideaRaw || !thinkerRaw) return false;
    return storeIndex(ideaRaw, thinkerRaw);
  }

  /** Ensure the index exists and is not stale. Safe to call before every graph open. */
  async function ensureInphoIndex(force = false): Promise<boolean> {
    const count = await store.indexCount();
    if (count > 0 && !force) {
      const synced = Number((await meta.getMeta(INDEX_SYNCED_KEY)) ?? 0);
      if (indexFresh(clock.now(), synced)) return true;
    }
    // Dev builds prefer local seed files over the network.
    const seed = await source.readDevSeed();
    if (seed && await storeIndex(seed.ideas, seed.thinkers)) return true;
    const ok = await syncInphoIndex();
    // A failed refresh keeps a usable index.
    return ok || count > 0;
  }

  // ── Relations ──────────────────────────────────────────────────────────────

  async function cachedRelations(slug: string): Promise<InphoRelations | null> {
    const [row] = await store.relationsRows([slug]);
    if (!row || !relationsFresh(clock.now(), row.fetched_at)) return null;
    return parseStoredRelations(row.payload);
  }

  /**
   * The related ids (and influence) for an entry, from its detail record. Null on a network failure,
   * so the caller does not cache it: a stored empty result would block every later retry.
   */
  async function fetchRelations(node: InphoNodeRow): Promise<InphoRelations | null> {
    const raw = await source.fetchJson(node.kind === 'idea' ? `/idea/${node.id}.json` : `/thinker/${node.id}.json`);
    if (!raw) return null;
    const d = unwrap<any>(raw);
    const rel = parseRelations(node.kind, d);
    // Record the centre thinker's own dates while the detail is in hand.
    if (node.kind === 'thinker' && d) await store.setDates(node.id, yearOf(d.birth), yearOf(d.death));
    return rel;
  }

  async function getRelations(centerSlug: string, node: InphoNodeRow): Promise<InphoRelations> {
    const cached = await cachedRelations(centerSlug);
    if (cached) return cached;
    const fetched = await fetchRelations(node);
    if (fetched === null) return { ideas: [], thinkers: [] }; // not persisted: retried on the next open
    await store.putRelations(centerSlug, JSON.stringify(fetched), clock.now());
    return fetched;
  }

  /**
   * Fetch birth/death years for thinkers that lack them, five at a time to stay polite to
   * inphoproject.org. A failed request leaves dates_checked = 0 so the next Timeline open retries it.
   */
  async function backfillDates(thinkerIds: number[]): Promise<void> {
    if (thinkerIds.length === 0) return;
    const missing = inPriorityOrder(await store.thinkersMissingDates(thinkerIds), thinkerIds);
    for (let i = 0; i < missing.length; i += DATE_BATCH) {
      await Promise.all(missing.slice(i, i + DATE_BATCH).map(async node => {
        const raw = await source.fetchJson(`/thinker/${node.id}.json`);
        if (!raw) return;
        const d = unwrap<any>(raw);
        await store.setDates(node.id, yearOf(d?.birth), yearOf(d?.death));
      }));
    }
  }

  // ── Graph builders (rows from the store, assembly from the core) ───────────

  /** Idea/thinker ids that map to an entry in the corpus, with the read context of the result. */
  async function resolveCorpus(
    ideaIds: number[], thinkerIds: number[], centerSlug: string,
  ): Promise<{ resolved: CorpusNode[]; ctx: ReadContext } | null> {
    if (ideaIds.length === 0 && thinkerIds.length === 0) return null;
    const candidates = relatedCandidates(await store.nodesByIds(ideaIds, thinkerIds), centerSlug);
    const slugs = candidateSlugs(candidates);
    if (slugs.length === 0) return null;
    const [entries, readSlugs] = await Promise.all([
      store.entriesBySlugs([centerSlug, ...slugs]),
      store.readSlugs(),
    ]);
    const titles = new Map(entries.map(e => [e.slug, e.title]));
    const resolved = pickCorpusNodes(candidates, titles);
    if (resolved.length === 0) return null;
    return { resolved, ctx: readContext(centerSlug, entries, readSlugs) };
  }

  async function buildSemanticGraph(centerSlug: string, ideaIds: number[], thinkerIds: number[]): Promise<GraphData> {
    const r = await resolveCorpus(ideaIds, thinkerIds, centerSlug);
    return r ? assembleSemanticGraph(centerSlug, r.resolved, r.ctx) : emptyGraph();
  }

  async function buildTimelineGraph(centerSlug: string, thinkerIds: number[]): Promise<GraphData> {
    const r = await resolveCorpus([], thinkerIds, centerSlug);
    if (!r) return emptyGraph();
    // The centre's own dates: if it is a thinker it belongs on the timeline too.
    return assembleTimelineGraph(centerSlug, r.resolved, r.ctx, await store.thinkerDatesBySep(centerSlug));
  }

  async function buildInfluenceGraph(centerSlug: string, infl: NonNullable<InphoRelations['influence']>): Promise<GraphData> {
    const r = await resolveCorpus([], influenceIds(infl), centerSlug);
    return r ? assembleInfluenceGraph(centerSlug, infl, r.resolved, r.ctx) : emptyGraph();
  }

  /**
   * The graph for an entry in a mode; empty when the entry has no InPhO node or InPhO is unreachable
   * on first use.
   *   related   : related ideas and thinkers
   *   influence : directional teacher/student/influence DAG (thinkers)
   *   timeline  : related thinkers carrying birth/death years
   */
  async function getGraph(centerSlug: string, mode: GraphMode = 'related'): Promise<GraphData> {
    await ensureInphoIndex();
    const node = await store.nodeBySep(centerSlug);
    if (!node) return emptyGraph();
    const rel = await getRelations(centerSlug, node);
    if (mode === 'influence') {
      if (!rel.influence) return emptyGraph(); // idea-centred entries have no influence DAG
      return buildInfluenceGraph(centerSlug, rel.influence);
    }
    if (mode === 'timeline') {
      await backfillDates(rel.thinkers);
      return buildTimelineGraph(centerSlug, rel.thinkers);
    }
    return buildSemanticGraph(centerSlug, rel.ideas, rel.thinkers);
  }

  // ── Layout cache ───────────────────────────────────────────────────────────

  async function getLayoutCache(centerSlug: string, mode: string, nodeSlugs: string[]): Promise<CachedPosition[] | null> {
    const row = await store.layoutRow(centerSlug, mode);
    if (!row || row.layout_key !== layoutKey(nodeSlugs)) return null;
    try { return JSON.parse(row.positions) as CachedPosition[]; } catch { return null; }
  }

  async function setLayoutCache(centerSlug: string, mode: string, nodeSlugs: string[], positions: CachedPosition[]): Promise<void> {
    await store.putLayoutRow(centerSlug, mode, layoutKey(nodeSlugs), JSON.stringify(positions), clock.now());
  }

  // ── Background priming ─────────────────────────────────────────────────────

  /** Thinker ids from fresh cached relations of `slugs`, first slug first, deduped. No network. */
  async function cachedThinkerIdsForSlugs(slugs: string[]): Promise<number[]> {
    if (slugs.length === 0) return [];
    const bySlug = new Map((await store.relationsRows(slugs)).map(r => [r.slug, r]));
    const now = clock.now();
    const seen = new Set<number>();
    const result: number[] = [];
    for (const slug of slugs) {
      const row = bySlug.get(slug);
      if (!row || !relationsFresh(now, row.fetched_at)) continue;
      const rel = parseStoredRelations(row.payload);
      if (!rel) continue;
      for (const id of rel.thinkers) {
        if (!seen.has(id)) { seen.add(id); result.push(id); }
      }
    }
    return result;
  }

  /**
   * Backfill birth/death years for the thinkers of the given slugs in priority order (pass the
   * active article first). Uses only cached relations: it never fetches relations itself. Meant to
   * run fire-and-forget when an article is ready; never rejects.
   */
  async function primeBackfillForSlugs(slugs: string[]): Promise<void> {
    try {
      const thinkerIds = await cachedThinkerIdsForSlugs(slugs);
      if (thinkerIds.length > 0) await backfillDates(thinkerIds);
    } catch {
      // Best effort.
    }
  }

  async function runAndCacheLayout(centerSlug: string, mode: string, data: GraphData): Promise<void> {
    if (data.nodes.length === 0) return;
    const nodeSlugs = data.nodes.map(n => n.slug);
    if (await getLayoutCache(centerSlug, mode, nodeSlugs)) return;
    let last: CachedPosition[] | null = null;
    for (const frame of forceLayout(data.nodes, data.edges, PRIME_W, PRIME_H, centerSlug, slugSeed(centerSlug + mode))) {
      last = frame.map(ln => ({ slug: ln.slug, xRel: ln.x / PRIME_W, yRel: ln.y / PRIME_H }));
      await sleep(0);
    }
    if (last) await setLayoutCache(centerSlug, mode, nodeSlugs, last);
  }

  /**
   * Compute and cache graph layouts for the given slugs in the background, from data already cached
   * (no new network requests beyond a stale index). A slug is processed once per session, even if
   * that attempt failed. Never rejects.
   */
  async function primeGraphLayouts(slugs: string[]): Promise<void> {
    const todo = slugs.filter(s => !primed.has(s));
    if (todo.length === 0) return;
    todo.forEach(s => primed.add(s));
    try {
      await ensureInphoIndex();
      for (const slug of todo) {
        // Links view: always available, no InPhO needed.
        await runAndCacheLayout(slug, 'links', await getArticleLinkGraph(slug));

        // InPhO views: only when relations are already cached for this slug.
        if (!await store.nodeBySep(slug)) continue;
        const rel = await cachedRelations(slug);
        if (!rel) continue;
        await runAndCacheLayout(slug, 'related', await buildSemanticGraph(slug, rel.ideas, rel.thinkers));
        if (rel.influence) await runAndCacheLayout(slug, 'influence', await buildInfluenceGraph(slug, rel.influence));
        // Timeline: only when every thinker's dates are already stored.
        if (rel.thinkers.length > 0 && (await store.thinkersMissingDates(rel.thinkers)).length === 0) {
          await runAndCacheLayout(slug, 'timeline', await buildTimelineGraph(slug, rel.thinkers));
        }
      }
    } catch {
      // Best effort.
    }
  }

  // ── Graph screen helpers ───────────────────────────────────────────────────

  /** The card under a tapped node: author, a generous excerpt of the body, and in the links view the sentence that links it to the centre. */
  async function getNodePreview(slug: string, centerSlug: string | null, mode: GraphView): Promise<NodePreview> {
    const wantContext = !!centerSlug && mode === 'links' && slug !== centerSlug;
    const [p, targetHtml, centerHtml] = await Promise.all([
      articles.getPreview(slug),
      articles.getHtml(slug),
      wantContext ? articles.getHtml(centerSlug as string) : Promise.resolve(null),
    ]);
    // Prefer the outgoing link in the centre article, then a backlink to the centre inside the target.
    const context = wantContext
      ? (centerHtml ? findLinkSentence(centerHtml, slug) : null)
        ?? (targetHtml ? findLinkSentence(targetHtml, centerSlug as string) : null)
      : null;
    const excerpt = targetHtml ? makeExcerpt(targetHtml, 1200) : (p?.excerpt ?? null);
    return { author: p?.author ?? null, excerpt, context };
  }

  async function getVisitedOnly(): Promise<boolean> {
    return (await meta.getMeta(VISITED_ONLY_KEY)) === '1';
  }
  function setVisitedOnly(on: boolean): Promise<void> {
    return meta.setMeta(VISITED_ONLY_KEY, on ? '1' : '0');
  }

  return {
    getArticleLinkGraph, getGraph, ensureInphoIndex, primeBackfillForSlugs, primeGraphLayouts,
    getLayoutCache, setLayoutCache, getNodePreview, getVisitedOnly, setVisitedOnly,
  };
}

export type GraphUseCases = ReturnType<typeof createGraph>;
