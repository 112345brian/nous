import type { EntryRow, IndexEntry } from '../types';

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
  /** Render every equation in `html` now; resolves to the HTML with <math-i> references. */
  substitute(html: string): Promise<string>;
  /** Render this cached article's equations in the background and rewrite it when done. Does not wait. */
  completeLater(slug: string, html: string): void;
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
