// The pure half of the knowledge graph: turning rows into nodes and edges, the cache lifetime
// rules, the InPhO payload parsing and the layout key. No I/O; src/core/graph.ts supplies the rows.
import { getInfluenceWeight } from '../data/influenceWeights';
import type {
  GraphData, GraphEdge, GraphNode, InphoInfluence, InphoNodeRow, InphoRelations,
} from '../types';
import type { GraphEntryRow } from './ports';

export const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] };
export const emptyGraph = (): GraphData => ({ nodes: [], edges: [] });

// ── Cache lifetimes ──────────────────────────────────────────────────────────

/** A cached relations record is reused for 7 days (InPhO updates monthly). */
export const RELATIONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The index is refreshed quarterly. */
export const INDEX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Relations are stale once strictly older than the TTL (exactly 7 days is still fresh). */
export const relationsFresh = (now: number, fetchedAt: number): boolean => !(now - fetchedAt > RELATIONS_TTL_MS);
/** The index is fresh while strictly younger than the TTL (exactly 90 days is stale). */
export const indexFresh = (now: number, syncedAt: number): boolean => now - syncedAt < INDEX_TTL_MS;

// ── InPhO payloads ───────────────────────────────────────────────────────────

/** InPhO wraps list and detail payloads inconsistently; unwrap to the useful shape. */
export function unwrap<T = any>(raw: any): T {
  return raw?.responseData?.results ?? raw?.responseData ?? raw?.results ?? raw;
}

export const num = (a: any): number[] => (Array.isArray(a) ? a.filter((x): x is number => typeof x === 'number') : []);

/** InPhO encodes a date as [{ year, month, day }] (BCE = negative year). */
export function yearOf(field: any): number | null {
  const e = Array.isArray(field) ? field[0] : field;
  const y = e?.year;
  return typeof y === 'number' ? y : null;
}

/** The index rows in the idea and thinker lists, or null when either list is not a list or nothing usable is left. */
export function parseIndexNodes(ideaRaw: unknown, thinkerRaw: unknown): InphoNodeRow[] | null {
  const ideas = unwrap<any[]>(ideaRaw);
  const thinkers = unwrap<any[]>(thinkerRaw);
  if (!Array.isArray(ideas) || !Array.isArray(thinkers)) return null;
  const nodes: InphoNodeRow[] = [];
  for (const i of ideas) {
    if (typeof i?.ID !== 'number') continue;
    nodes.push({ id: i.ID, kind: 'idea', label: String(i.label ?? ''), sep_dir: i.sep_dir || null });
  }
  for (const t of thinkers) {
    if (typeof t?.ID !== 'number') continue;
    nodes.push({ id: t.ID, kind: 'thinker', label: String(t.label ?? ''), sep_dir: t.sep_dir || null });
  }
  return nodes.length === 0 ? null : nodes;
}

/**
 * The relations in an entry's detail record. Ideas expose `related` (ideas) and `related_thinkers`;
 * thinkers expose `related_ideas`, `related_thinkers` and an influence network.
 */
export function parseRelations(kind: 'idea' | 'thinker', detail: any): InphoRelations {
  const rel: InphoRelations = {
    ideas: kind === 'idea' ? num(detail?.related) : num(detail?.related_ideas),
    thinkers: num(detail?.related_thinkers),
  };
  if (kind === 'thinker' && detail) {
    rel.influence = {
      teachers: num(detail.teachers), students: num(detail.students),
      influenced: num(detail.influenced), influenced_by: num(detail.influenced_by),
    };
  }
  return rel;
}

/** Cached relations from a stored payload; null when it is not valid JSON. */
export function parseStoredRelations(payload: string): InphoRelations | null {
  try { return JSON.parse(payload); } catch { return null; }
}

// ── Link graph ───────────────────────────────────────────────────────────────

/** The article's own link graph: the centre, what it links to and what links to it. */
export function assembleArticleLinkGraph(
  centerSlug: string, outgoing: GraphEdge[], incoming: GraphEdge[],
  entries: GraphEntryRow[], readSlugs: string[],
): GraphData {
  const edges = [...outgoing, ...incoming];
  const readSet = new Set(readSlugs);
  const titleMap = new Map(entries.map(r => [r.slug, r.title]));
  const progressMap = new Map(entries.map(r => [r.slug, r.read_progress ?? 0]));
  const slugs = new Set<string>([centerSlug]);
  for (const e of edges) { slugs.add(e.from_slug); slugs.add(e.to_slug); }
  return {
    nodes: [...slugs].map(slug => ({
      slug, title: titleMap.get(slug) ?? slug, read: readSet.has(slug),
      readProgress: progressMap.get(slug) ?? 0,
      kind: (slug === centerSlug ? 'entry' : 'linked') as 'entry' | 'linked',
    })),
    edges,
  };
}

/** Every slug the link graph for these edges mentions, centre first. */
export function linkGraphSlugs(centerSlug: string, edges: GraphEdge[]): string[] {
  const slugs = new Set<string>([centerSlug]);
  for (const e of edges) { slugs.add(e.from_slug); slugs.add(e.to_slug); }
  return [...slugs];
}

// ── InPhO graphs ─────────────────────────────────────────────────────────────

/** An InPhO node that maps to an entry in our corpus, with that entry's title. */
export interface CorpusNode { row: InphoNodeRow; title: string }

/** The nodes that can have a corpus entry: they have an SEP page and it is not the centre. */
export function relatedCandidates(rows: InphoNodeRow[], centerSlug: string): InphoNodeRow[] {
  return rows.filter(r => r.sep_dir && r.sep_dir !== centerSlug);
}

/** The distinct SEP slugs of the candidates, in first-seen order. */
export const candidateSlugs = (candidates: InphoNodeRow[]): string[] =>
  [...new Set(candidates.map(r => r.sep_dir as string))];

/** Keep the candidates whose slug is an entry we have; one node per slug, an idea over a thinker. */
export function pickCorpusNodes(candidates: InphoNodeRow[], titles: Map<string, string>): CorpusNode[] {
  const bySlug = new Map<string, InphoNodeRow>();
  for (const r of candidates) {
    const slug = r.sep_dir as string;
    if (!titles.has(slug)) continue;
    const existing = bySlug.get(slug);
    if (!existing || (existing.kind === 'thinker' && r.kind === 'idea')) bySlug.set(slug, r);
  }
  return [...bySlug.values()].map(r => ({ row: r, title: titles.get(r.sep_dir as string) as string }));
}

/** What the builders need to colour nodes: who has been read and how far, and the centre's title. */
export interface ReadContext {
  readSet: Set<string>;
  progress: Map<string, number>;
  centerTitle: string;
}

export function readContext(centerSlug: string, entries: GraphEntryRow[], readSlugs: string[]): ReadContext {
  return {
    readSet: new Set(readSlugs),
    progress: new Map(entries.filter(r => (r.read_progress ?? 0) > 0).map(r => [r.slug, r.read_progress as number])),
    centerTitle: entries.find(r => r.slug === centerSlug)?.title ?? centerSlug,
  };
}

const centerNode = (centerSlug: string, c: ReadContext): GraphNode => ({
  slug: centerSlug, title: c.centerTitle, read: c.readSet.has(centerSlug),
  readProgress: c.progress.get(centerSlug) ?? 0, kind: 'entry',
});

/** Related ideas and thinkers around the centre; the node kind carries the idea/thinker colour. */
export function assembleSemanticGraph(centerSlug: string, resolved: CorpusNode[], c: ReadContext): GraphData {
  const nodes: GraphNode[] = [
    centerNode(centerSlug, c),
    ...resolved.map(r => {
      const s = r.row.sep_dir as string;
      return { slug: s, title: r.title, read: c.readSet.has(s), readProgress: c.progress.get(s) ?? 0, kind: r.row.kind };
    }),
  ];
  const edges: GraphEdge[] = resolved.map(r => ({ from_slug: centerSlug, to_slug: r.row.sep_dir as string }));
  return { nodes, edges };
}

/** Related thinkers carrying birth and death years; the centre's own years when it is a thinker. */
export function assembleTimelineGraph(
  centerSlug: string, resolved: CorpusNode[], c: ReadContext,
  centerDates: { birth_year: number | null; death_year: number | null } | null,
): GraphData {
  const nodes: GraphNode[] = [
    { ...centerNode(centerSlug, c), birthYear: centerDates?.birth_year ?? null, deathYear: centerDates?.death_year ?? null },
    ...resolved.map(r => {
      const s = r.row.sep_dir as string;
      return {
        slug: s, title: r.title, read: c.readSet.has(s), readProgress: c.progress.get(s) ?? 0,
        kind: 'thinker' as const, birthYear: r.row.birth_year ?? null, deathYear: r.row.death_year ?? null,
      };
    }),
  ];
  const edges: GraphEdge[] = resolved.map(r => ({ from_slug: centerSlug, to_slug: r.row.sep_dir as string }));
  return { nodes, edges };
}

/** Every thinker id an influence network mentions. */
export const influenceIds = (infl: InphoInfluence): number[] =>
  [...new Set([...infl.teachers, ...infl.students, ...infl.influenced, ...infl.influenced_by])];

/** Weight of a direct teacher/student link, and of looser influence. */
export const PEDAGOGICAL_WEIGHT = 3.0;
export const INFLUENCE_BASE_WEIGHT = 1.5;

/**
 * Influence DAG. Edge direction is influence flow (earlier to later): teachers and influencers point
 * into the centre, students and the influenced point out of it. Direct pedagogical links outweigh
 * general influence; Wikidata weights multiply on top when there are any.
 */
export function assembleInfluenceGraph(
  centerSlug: string, infl: InphoInfluence, resolved: CorpusNode[], c: ReadContext,
): GraphData {
  const idToSlug = new Map(resolved.map(r => [r.row.id, r.row.sep_dir as string]));
  const nodes: GraphNode[] = [
    centerNode(centerSlug, c),
    ...resolved.map(r => {
      const s = r.row.sep_dir as string;
      return { slug: s, title: r.title, read: c.readSet.has(s), readProgress: c.progress.get(s) ?? 0, kind: 'thinker' as const };
    }),
  ];
  const edges: GraphEdge[] = [];
  const teacherSet = new Set(infl.teachers);
  const studentSet = new Set(infl.students);
  const add = (from: string, to: string, base: number) => {
    if (!from || !to || from === to) return;
    edges.push({ from_slug: from, to_slug: to, weight: base * getInfluenceWeight(from, to) });
  };
  for (const id of [...infl.teachers, ...infl.influenced_by]) {
    const s = idToSlug.get(id);
    if (s) add(s, centerSlug, teacherSet.has(id) ? PEDAGOGICAL_WEIGHT : INFLUENCE_BASE_WEIGHT);
  }
  for (const id of [...infl.students, ...infl.influenced]) {
    const s = idToSlug.get(id);
    if (s) add(centerSlug, s, studentSet.has(id) ? PEDAGOGICAL_WEIGHT : INFLUENCE_BASE_WEIGHT);
  }
  return { nodes, edges };
}

/** Put rows in the order of `ids` (first id = highest priority); rows whose id is absent keep first place. */
export function inPriorityOrder(rows: InphoNodeRow[], ids: number[]): InphoNodeRow[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

// ── Layout cache key ─────────────────────────────────────────────────────────

/** FNV-1a over the sorted node slugs: cheap and enough to invalidate a cached layout. */
export function layoutKey(nodeSlugs: string[]): number {
  const s = [...nodeSlugs].sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h;
}
