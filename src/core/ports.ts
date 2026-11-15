import type {
  Annotation, AnnotationWithTitle, BookmarkRow, EntryRef, EntryRow, EntrySummary, GraphEdge, IndexEntry,
  InphoNodeRow, LibraryScope, Prefs, Session,
} from '../types';
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


// ── Stores the screens read and write (UI use cases) ─────────────────────────
//
// Grouped by use case, not one big interface. The root (src/composition.ts) builds each from the
// SQLite adapter and exports it; screens and useBoot take them from the root. Preferences kept in
// the `meta` table use KeyValueStore above. A use case lists only the slice it needs with
// Pick<...>, so its fake stays small.

/** What the reader has read: history, progress, recents. */
export interface ReaderStateStore {
  /** Log a visit (starts a new session after a long gap; `fromSlug` is the page the link came from). */
  recordRead(slug: string, title: string, fromSlug: string | null): Promise<void>;
  /** Scroll progress 0..1; only ratchets upward. */
  setReadProgress(slug: string, progress: number): Promise<void>;
  /** Set progress exactly (mark as read / unread). */
  forceSetReadProgress(slug: string, progress: number): Promise<void>;
  /** Most recently read distinct entries, newest first. */
  getRecentSlugs(limit?: number): Promise<EntrySummary[]>;
  /** The newest `limit` reading sessions, each with its tree of reads, newest first. */
  getSessions(limit?: number): Promise<Session[]>;
}

/** The reading list. */
export interface BookmarkStore {
  /** Add or remove; resolves to whether the entry is bookmarked afterwards. */
  toggleBookmark(slug: string, title: string): Promise<boolean>;
  isBookmarked(slug: string): Promise<boolean>;
  getBookmarks(): Promise<EntrySummary[]>;
  getBookmarksFull(): Promise<BookmarkRow[]>;
}

/** Highlights and notes. */
export interface AnnotationStore {
  getAnnotationsForSlug(slug: string): Promise<Annotation[]>;
  getAllAnnotations(): Promise<AnnotationWithTitle[]>;
  saveAnnotation(
    slug: string, selectedText: string, context: string | null, color: string,
    note?: string | null, currentHash?: string | null,
  ): Promise<Annotation>;
  updateAnnotation(id: number, note: string | null, color: string): Promise<void>;
  deleteAnnotation(id: number): Promise<void>;
  deleteAnnotations(ids: number[]): Promise<void>;
  /** Point a highlight at its text in a newer version of the article. */
  updateAnnotationAnchor(id: number, newText: string, newHash: string): Promise<void>;
}

/** Reading entries from the local library: lookup, search, links and cached equations. */
export interface LibraryReadStore {
  getEntry(slug: string): Promise<EntryRow | null>;
  getEntryHtml(slug: string): Promise<string | null>;
  getEntryPreview(slug: string): Promise<{ title: string; author: string | null; excerpt: string | null } | null>;
  getAllEntries(): Promise<{ slug: string; title: string; parent_label: string | null }[]>;
  searchEntries(query: string, limit?: number): Promise<EntrySummary[]>;
  /** Entries whose body links to `slug`. */
  getLinksTo(slug: string): Promise<EntrySummary[]>;
  /** Record which entries `contentHtml` links to. */
  indexLinks(fromSlug: string, contentHtml: string): Promise<void>;
  /** Rendered equations by content hash (SVG text). */
  getMathSvgMap(hashes: string[]): Promise<Record<string, string>>;
  getEntryCounts(scope?: LibraryScope): Promise<{ total: number; cached: number }>;
  /** How many entries are in the index (0 on a fresh install). */
  getEntryCount(): Promise<number>;
  /** Drop every downloaded article body (the index and the reader's own data stay). */
  clearArticleCache(): Promise<void>;
}

/** First-run preferences and the settings that are more than a single meta key. */
export interface AppPrefsStore {
  getPrefs(): Promise<Prefs>;
  savePrefs(prefs: Prefs): Promise<void>;
  getZoteroPrefs(): Promise<{ apiKey: string; userId: string }>;
  saveZoteroPrefs(apiKey: string, userId: string): Promise<void>;
  getSyncFolder(): Promise<string>;
  setSyncFolder(path: string): Promise<void>;
}

// ── Seed import (UC-A2) ──────────────────────────────────────────────────────

/** The part of a user-data export the seed import relies on; the adapter owns the rest of the shape. */
export interface SeedUserDataShape {
  version: number;
  annotations: Array<{ id: number; content_hash: string | null }>;
  prefs?: Record<string, string>;
}

/** The database files of the local library, addressed by role. `suffix` is '', '-wal' or '-shm'. */
export interface SeedFiles {
  /** Download `url` to a temporary file, reporting progress. Resolves to the HTTP status (null when there was no response); rejects on a network failure. */
  download(url: string, onProgress: (bytesWritten: number, bytesTotal: number) => void): Promise<{ status: number | null }>;
  /** Size in bytes of the downloaded temporary file, or null when it does not exist. */
  downloadedSize(): Promise<number | null>;
  /** Delete the temporary download; a missing file is not an error. */
  discardDownload(): Promise<void>;
  /** Create the folder the database lives in. */
  prepareDbDir(): Promise<void>;
  hasDb(suffix: string): Promise<boolean>;
  hasBackup(suffix: string): Promise<boolean>;
  /** Copy the database file to the backup location (the original stays). */
  backUpDb(suffix: string): Promise<void>;
  /** Delete a database file; a missing file is not an error. */
  removeDb(suffix: string): Promise<void>;
  /** Move the backup file back to the database location. */
  restoreBackup(suffix: string): Promise<void>;
  /** Rename a backup file so it is kept under `tag`, out of the way of the next backup. */
  setAsideBackup(suffix: string, tag: string): Promise<void>;
  removeBackup(suffix: string): Promise<void>;
  /** Move the downloaded file into place as the main database file. */
  installDownload(): Promise<void>;
  /** Where the backup lives, for the error message when it cannot be put back. */
  readonly backupLocation: string;
}

/** The open local database, as far as the seed swap needs it. */
export interface SeedDatabase {
  /** Close the connection (the next use reopens it lazily, on whatever file is then in place). */
  close(): Promise<void>;
  /** Every `meta` row. */
  listMeta(): Promise<Array<{ key: string; value: string | null }>>;
  /** Reading progress of every entry that has some. */
  listReadProgress(): Promise<Array<{ slug: string; read_progress: number }>>;
  /**
   * In one transaction: set annotations.content_hash by id, and read_progress by slug (only for
   * entries that exist; nothing is invented).
   */
  restoreDerived(data: {
    annotationHashes: Array<{ id: number; content_hash: string }>;
    readProgress: Array<{ slug: string; read_progress: number }>;
  }): Promise<void>;
}

// ── Notification, prefetch and secrets ports ─────────────────────────────────

/** Shows download progress to the reader (Android progress bar, iOS text notification). */
export interface ProgressNotifier {
  start(): Promise<void>;
  /** `done` of `total` articles so far; the implementation decides how often this is shown. */
  update(done: number, total: number): Promise<void>;
  finish(total: number): Promise<void>;
}

/** What the notification platform can show. Unthrottled: the core decides when `update` is called. */
export interface ProgressSink {
  start(): Promise<void>;
  update(done: number, total: number): void;
  finish(total: number): Promise<void>;
}

/** The connection as the prefetch policy sees it (null = unknown). */
export interface ConnectionInfo {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  /** Cellular or metered. */
  isExpensive: boolean | null;
}
export interface Connectivity {
  current(): Promise<ConnectionInfo>;
}

/** Runs a callback once animations and gestures have settled. */
export interface Interactions {
  afterInteractions(cb: () => void): { cancel(): void };
}

/** A cancellable pause. */
export interface Delay {
  start(ms: number): { done: Promise<void>; cancel(): void };
}

/** Outgoing links of an entry, with whether each target is cached (`cached_at` null = not). */
export interface LinkLookup {
  getLinksFrom(slug: string): Promise<Array<{ slug: string; cached_at: number | null }>>;
}

/** Secrets such as the Zotero API key (Keychain / Keystore). Failures come back as values, never throws. */
export interface SecretStore {
  available(): Promise<boolean>;
  /** The stored secret, or null if absent or unreadable. */
  get(key: string): Promise<string | null>;
  /** True only if the value was stored. */
  set(key: string, value: string): Promise<boolean>;
  /** True if the secret is gone (or never existed). */
  delete(key: string): Promise<boolean>;
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
