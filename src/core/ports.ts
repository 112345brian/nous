import type { EntryRef, EntryRow, IndexEntry, LibraryScope } from '../types';
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

