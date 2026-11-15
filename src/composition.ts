// The composition root: the one place that builds concrete adapters and hands them to the core
// use cases. Screens and App.tsx import the use cases from here; the core imports nothing outside
// itself and the pure inner ring; adapters (src/services/*) never import this file.
// src/__tests__/compositionRoot.test.ts enforces all three.
//
// Adapters live in src/services (db, catalog's fetch and equation functions, expoSyncFolder,
// zoteroHttp, mathPriority, prefetch, ...). Each use case in src/core takes the ports it needs
// as a parameter; this file is where they meet.
import { Platform } from 'react-native';
import {
  getSyncFolder, exportUserData, importUserData, getArticleVersionDate,
  getSlugsByCacheStatus, getCachedSlugs, getMeta, setMeta,
  upsertIndexEntries, cacheArticle, getEntryCount, indexLinks, getAllEntryTitles, invalidateLinkCache,
  cleanDenormalizedTitles, getEntryHtml, updateArticleHtml, setArticleAst, getMathArticleHtml,
  getUncachedAstSlugs, setEntryNotes,
  type UserDataExport, type BookmarkRow,
} from './services/db';
import type { Annotation, DownloadProgress, IndexEntry, LibraryScope } from './types';
import type { UserDataStore } from './core/ports';
import { exportUserDataToFolder, importUserDataFromFolder } from './core/syncUserData';
import { exportBookmarkToZotero } from './core/zotero';
import { downloadAll as downloadAllUseCase, syncCachedArticles as syncCachedUseCase } from './core/libraryDownload';
import { refreshIndexIfStale as refreshIndexUseCase } from './core/refreshIndex';
import { fetchAndCacheArticle as cacheArticleUseCase } from './core/cacheArticle';
import { createMathCompletion } from './core/mathCompletion';
import { backfillMathInline as backfillMathInlineUseCase, backfillAst as backfillAstUseCase } from './core/backfills';
import { ensureNotesCached as ensureNotesUseCase } from './core/ensureNotes';
import { fetchIndexHtml, fetchArticleHtml, fetchNotesHtml, substitutemath } from './services/catalog';
import { expoSyncFolder } from './services/expoSyncFolder';
import { zoteroHttp } from './services/zoteroHttp';
import { startPrefetch as startPrefetchAdapter } from './services/prefetch';
import { withDownloadHold, yieldThenMathMayRun, watchStalls } from './services/mathPriority';
import { perf } from './services/perf';
import { linkifyHtml } from './utils/linkifier';
import seedEntries from './assets/entry-seed.json';

// ── Sync folder and Zotero ───────────────────────────────────────────────────

const dbUserData: UserDataStore<UserDataExport> = {
  getSyncFolder: () => getSyncFolder() as Promise<string>,
  exportUserData,
  importUserData,
};

function syncDeps() {
  return {
    folder: expoSyncFolder,
    store: dbUserData,
    env: {
      platform: Platform.OS as string,
      home: (process.env as Record<string, string | undefined>).HOME ?? '',
    },
  };
}

export function exportToSyncFolder(): Promise<'ok' | 'no_folder' | 'error'> {
  return exportUserDataToFolder(syncDeps());
}

export function importFromSyncFolder(): Promise<'ok' | 'no_folder' | 'not_found' | 'error'> {
  return importUserDataFromFolder(syncDeps());
}

export function exportToZotero(
  apiKey: string,
  userId: string,
  item: Pick<BookmarkRow, 'slug' | 'title' | 'author' | 'pub_date'>,
  annotations: Annotation[] = []
): Promise<'ok' | 'auth_error' | 'error'> {
  return exportBookmarkToZotero(
    { http: zoteroHttp(apiKey, userId), versionDate: getArticleVersionDate, clock: { now: () => Date.now() } },
    item,
    annotations,
  );
}

// ── Entry index and article caching ──────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function refreshIndexIfStale(): Promise<void> {
  return refreshIndexUseCase({
    source: { fetchIndexHtml },
    store: { getEntryCount, upsertIndexEntries, cleanDenormalizedTitles, getAllEntryTitles, invalidateLinkCache },
    meta: { getMeta, setMeta },
    clock: { now: () => Date.now() },
    bundledEntries: seedEntries as IndexEntry[],
  });
}

// Deferred math: the pipeline behind "show the text first, render the equations after". All of
// its state lives in this one instance. `pause` and `watchStall` come from the math priority
// model, so background rendering yields to reading and downloads.
const mathCompletion = createMathCompletion({
  substitute: substitutemath,
  articles: { getEntryHtml, updateArticleHtml, setArticleAst },
  meta: { getMeta, setMeta },
  pause: yieldThenMathMayRun,
  watchStall: watchStalls,
});
export const onMathReady = mathCompletion.onMathReady;
export const completeArticleMath = mathCompletion.completeArticleMath;
export const resumePendingMath = mathCompletion.resumePendingMath;

// Math handling (articles with TeX only):
//   default        — cache the text now, render equations in the background and
//                    rewrite the article when done (onMathReady fires). Resolves
//                    without waiting for MathJax.
//   awaitMath      — render equations first (old behavior); for bulk sync where
//                    nobody is waiting on the first paint.
//   skipMath       — leave raw TeX; bulk download defers to backfillMathInline.
export function fetchAndCacheArticle(
  slug: string,
  opts: { skipMath?: boolean; awaitMath?: boolean } = {},
): Promise<boolean> {
  return cacheArticleUseCase({
    source: { fetchArticleHtml, fetchNotesHtml },
    library: { cacheArticle, indexLinks },
    math: { substitute: substitutemath, completeLater: mathCompletion.completeLater },
    timing: perf,
    linkify: linkifyHtml,
  }, slug, opts);
}

// If an already-cached article's body refers to footnotes that were never stored, fetch and keep
// them. Resolves to the notes HTML, or null when there are none to use.
export function ensureNotesCached(slug: string, contentHtml: string | null): Promise<string | null> {
  return ensureNotesUseCase(
    { source: { fetchNotesHtml }, library: { setEntryNotes } },
    slug, contentHtml,
  );
}

// ── Bulk download and sync ───────────────────────────────────────────────────

export function downloadAll(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  scope: LibraryScope = 'all',
): Promise<void> {
  // A download hold keeps equation rendering and background tasks paused while it runs.
  return withDownloadHold(() => downloadAllUseCase(
    { library: { getSlugsByCacheStatus }, cacheArticle: fetchAndCacheArticle, sleep },
    onProgress, signal, scope,
  ));
}

export function syncCachedArticles(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return withDownloadHold(() => syncCachedUseCase(
    {
      library: { getCachedSlugs },
      refreshIndex: refreshIndexIfStale,
      cacheArticle: fetchAndCacheArticle,
      meta: { setMeta },
      clock: { now: () => Date.now() },
      sleep,
    },
    onProgress, signal,
  ));
}

// ── Background passes over cached articles ───────────────────────────────────

// One-time pass: render the equations of articles cached as raw TeX. Starts by finishing any
// deferred math a previous run left pending.
export function backfillMathInline(): Promise<void> {
  return backfillMathInlineUseCase({
    resumePendingMath,
    meta: { getMeta, setMeta },
    library: { getMathArticleHtml },
    articles: { getEntryHtml, updateArticleHtml },
    substitute: substitutemath,
    pause: yieldThenMathMayRun,
  });
}

// One-time pass: pre-parse the AST of cached articles that have none.
export function backfillAst(): Promise<void> {
  return backfillAstUseCase({
    library: { getUncachedAstSlugs },
    articles: { getEntryHtml, setArticleAst },
    pause: yieldThenMathMayRun,
  });
}

// ── Link prefetch ────────────────────────────────────────────────────────────

/**
 * Once the reader has stayed on `slug` for a while, quietly cache a few of its uncached outgoing
 * links. Returns a cancel function: call it on navigation/unmount. Never throws.
 */
export function startPrefetch(slug: string): () => void {
  return startPrefetchAdapter(slug, s => fetchAndCacheArticle(s, { skipMath: true }));
}
