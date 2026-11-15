import type { EntryRef, EntryRow, GraphEdge, IndexEntry, InphoNodeRow, LibraryScope } from '../types';
import type { MathPriority } from '../utils/mathThrottlePolicy';

// Ports: the outward-facing interfaces the core needs. Plain TypeScript only.
//
// Direction of dependency: adapters (src/services, UI) import these types and
// implement them; nothing in src/core imports an adapter. The composition code that
// builds adapters and hands them to core functions lives at the edge
// (today: the wrappers in src/services/dataSync.ts; see docs/core-di-audit.md).

/** Wall clock. Core code never reads Date.now() or new Date() itself. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** Reads and writes the user-data file inside the folder the reader chose. */
export interface SyncFolder {
  /** Text of the file at `fileUri`, or null when it does not exist. */
  read(fileUri: string): Promise<string | null>;
  /** Create parent folders as needed and replace the file with `text`. */
  write(fileUri: string, text: string): Promise<void>;
}

/**
 * The slice of the local database the sync-folder use cases need.
 * `T` is the snapshot shape (src/services/db.ts's UserDataExport); the core only
 * relies on its `version` field, so the adapter owns the rest of the shape.
 */
export interface UserDataStore<T extends { version: number }> {
  /** The folder path the reader typed in Settings ('' when unset). */
  getSyncFolder(): Promise<string>;
  exportUserData(): Promise<T>;
  importUserData(data: T): Promise<void>;
}

/** Minimal HTTP surface of the Zotero web API; the adapter adds base URL, key and headers. */
export interface ZoteroHttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<any>;
}
export interface ZoteroHttp {
  /** POST `body` as JSON to `path` (e.g. '/items'), relative to the reader's library. */
  post(path: string, body: unknown): Promise<ZoteroHttpResponse>;
}

/** Small key/value settings and bookkeeping (the `meta` table today). */
export interface KeyValueStore {
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

/** Where SEP pages come from. */
export interface ArticleSource {
  /** Raw HTML of the SEP table of contents (contents.html). Rejects when it cannot be read. */
  fetchIndexHtml(): Promise<string>;
  /**
   * Raw HTML of an entry page, or null when the site answered with an error status.
   * Rejects on a network failure or timeout.
   */
  fetchArticleHtml(slug: string): Promise<string | null>;
  /** The footnotes of an entry (body of its notes page), or null when there are none to use. Never rejects. */
  fetchNotesHtml(slug: string): Promise<string | null>;
}

/** What an article row stores when it is cached. */
export type CachedArticleFields =
  Pick<EntryRow, 'author' | 'pub_date' | 'toc_html' | 'preamble_html' | 'content_html' | 'content_ast' | 'has_math'>
  & { notes_html?: string | null };

/** The slice of the local library the article-caching use case writes to. */
export interface ArticleLibrary {
  cacheArticle(slug: string, data: CachedArticleFields): Promise<void>;
  /** Record which entries `contentHtml` links to (feeds the backlinks and the graph). */
  indexLinks(slug: string, contentHtml: string): Promise<void>;
}

/** Turns TeX in an article into stored SVG equations. */
export interface ArticleMath {
  /**
   * Render every equation in `html` now; resolves to the HTML with <math-i> references.
   * `priority` says how patiently to render (see the math priority model); `null` means the
   * caller already owns the schedule, so the renderer must not wait on it.
   */
  substitute(html: string, priority?: MathPriority | null): Promise<string>;
  /**
   * Render this cached article's equations in the background and rewrite it when done. Does not
   * wait. `priority` defaults to 'current' (the reader is looking at it); prefetch passes
   * 'background' so a neighbouring article never competes with the reader.
   */
  completeLater(slug: string, html: string, priority?: MathPriority): void;
  /**
   * Record that this cached article still has unrendered equations, and do nothing more: a later
   * resume pass renders it at background priority. Resolves once the debt is recorded.
   */
  queueForLater(slug: string): Promise<void>;
}

/** Dev-only stage timing; structurally the same as `Perf` in utils/perf.ts. */
export interface StageTimer {
  time<T>(key: string, stage: string, fn: () => Promise<T>): Promise<T>;
  timeSync<T>(key: string, stage: string, fn: () => T): T;
}

/** The slice of the local library the index refresh needs. */
export interface LibraryIndexStore {
  getEntryCount(): Promise<number>;
  upsertIndexEntries(entries: IndexEntry[]): Promise<void>;
  cleanDenormalizedTitles(): Promise<void>;
  /** All entry titles, longest first; the source for the link index. */
  getAllEntryTitles(): Promise<{ slug: string; title: string }[]>;
  /** Drop any in-memory copy of the link index so the next reader sees the new one. */
  invalidateLinkCache(): void;
}

/** The slice of the local library the math-completion pipeline reads and rewrites. */
export interface ArticleMathStore {
  /** The cached article body, or null when it is not in the library. */
  getEntryHtml(slug: string): Promise<string | null>;
  updateArticleHtml(slug: string, html: string): Promise<void>;
  /** The article's pre-parsed AST as JSON. */
  setArticleAst(slug: string, ast: string): Promise<void>;
}

/** Waits `ms` milliseconds; how the core paces itself without owning a timer. */
export type Sleep = (ms: number) => Promise<void>;

/** Which entries are in the local library already, for the bulk download and sync loops. */
export interface LibraryCacheStatus {
  getSlugsByCacheStatus(scope: LibraryScope): Promise<{ uncached: EntryRef[]; cached: EntryRef[] }>;
  /** Every cached entry (all scopes). */
  getCachedSlugs(): Promise<EntryRef[]>;
}

/** Work lists for the background passes over cached articles. */
export interface LibraryBackfillStore {
  /** Slugs of cached articles that have no stored AST yet. */
  getUncachedAstSlugs(): Promise<string[]>;
}

/** Where an article's footnotes are stored. */
export interface NotesStore {
  setEntryNotes(slug: string, notesHtml: string): Promise<void>;
}

/** One equation to typeset. */
export interface MathRequest { tex: string; display: boolean }
/** The outcome for one equation, in the order requested: an SVG (base64) with its size, or an error. */
export interface MathResult {
  tex: string;
  display: boolean;
  b64?: string; // base64 of the standalone SVG
  w?: number;
  h?: number;
  error?: string; // 'timeout' | 'render-failed' | 'missing' are transient; anything else means the TeX itself was rejected
}

/** Typesets equations. Today a hidden WebView running MathJax; always one result per request. */
export interface MathRenderer {
  render(items: MathRequest[]): Promise<MathResult[]>;
}

/** The equation table: rendered SVGs by content hash. */
export interface MathStore {
  getMathByHashes(hashes: string[]): Promise<Array<{ hash: string; w: number; h: number }>>;
  putMathBatch(rows: Array<{ hash: string; svg: string; w: number; h: number; display: boolean }>): Promise<void>;
}

// ── Knowledge graph ──────────────────────────────────────────────────────────

/** Where InPhO data comes from. Both methods swallow every failure and say so with null. */
export interface GraphSource {
  /** JSON at an InPhO path such as '/idea.json'; null on a network error, a non-OK status or bad JSON. */
  fetchJson(path: string): Promise<any | null>;
  /**
   * The index lists read from files a dev build injected into the app (idea list, thinker list,
   * both parsed); null in a release build, or when a file is missing or malformed.
   */
  readDevSeed(): Promise<{ ideas: unknown; thinkers: unknown } | null>;
}

/** A cached InPhO relations record exactly as stored. */
export interface RelationsRow { slug: string; payload: string; fetched_at: number }
/** A stored layout record exactly as stored. */
export interface LayoutRow { layout_key: number; positions: string }
/** The slice of an entry the graph shows. */
export interface GraphEntryRow { slug: string; title: string; read_progress: number | null }

/**
 * The graph tables plus the reading tables they join to. Rows in, rows out: assembling nodes and
 * edges, the cache lifetime rules and the layout key are the core's job. The adapter creates the
 * graph tables itself (the first time each database connection is used).
 */
export interface GraphStore {
  // SEP link graph
  outgoingLinks(slug: string, limit: number): Promise<GraphEdge[]>;
  incomingLinks(slug: string, limit: number): Promise<GraphEdge[]>;
  /** Entries by slug; slugs that are not entries are simply absent. */
  entriesBySlugs(slugs: string[]): Promise<GraphEntryRow[]>;
  /** Every slug the reader has opened, once each. */
  readSlugs(): Promise<string[]>;
  // InPhO index
  indexCount(): Promise<number>;
  /** Replace the whole index; years and dates_checked already fetched for a (kind, id) are kept. */
  replaceIndex(nodes: InphoNodeRow[]): Promise<void>;
  /** The node for an SEP slug, an idea in preference to a thinker. */
  nodeBySep(slug: string): Promise<InphoNodeRow | null>;
  /** Nodes with these idea ids or these thinker ids. */
  nodesByIds(ideaIds: number[], thinkerIds: number[]): Promise<InphoNodeRow[]>;
  /** Birth and death years of the thinker node for this slug. */
  thinkerDatesBySep(slug: string): Promise<{ birth_year: number | null; death_year: number | null } | null>;
  /** Thinker nodes among `ids` whose dates were never fetched, in no particular order. */
  thinkersMissingDates(ids: number[]): Promise<InphoNodeRow[]>;
  /** Record a thinker's years (null = none recorded) and mark the dates as fetched. */
  setDates(id: number, birth: number | null, death: number | null): Promise<void>;
  // Relations cache
  relationsRows(slugs: string[]): Promise<RelationsRow[]>;
  putRelations(slug: string, payload: string, fetchedAt: number): Promise<void>;
  // Layout cache
  layoutRow(centerSlug: string, mode: string): Promise<LayoutRow | null>;
  putLayoutRow(centerSlug: string, mode: string, key: number, positions: string, createdAt: number): Promise<void>;
}

/** The article rows the graph preview card reads. */
export interface GraphArticles {
  getPreview(slug: string): Promise<{ title: string; author: string | null; excerpt: string | null } | null>;
  getHtml(slug: string): Promise<string | null>;
}
