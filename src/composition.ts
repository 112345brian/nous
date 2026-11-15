// The composition root: the one place that builds concrete adapters and hands them to the core
// use cases. Screens and App.tsx import the use cases from here; the core imports nothing outside
// itself and the pure inner ring; adapters (src/services/*) never import this file.
// src/__tests__/compositionRoot.test.ts enforces all three.
//
// Adapters live in src/services (db, catalog's fetch and equation functions, expoSyncFolder,
// zoteroHttp, mathPriority, prefetch, ...). Each use case in src/core takes the ports it needs
// as a parameter; this file is where they meet.
import { InteractionManager, Platform } from 'react-native';
import {
  getSyncFolder, exportUserData, importUserData, getArticleVersionDate,
  getSlugsByCacheStatus, getCachedSlugs, getMeta, setMeta,
  upsertIndexEntries, cacheArticle, getEntryCount, indexLinks, getAllEntryTitles, invalidateLinkCache,
  cleanDenormalizedTitles, getEntryHtml, updateArticleHtml, setArticleAst,
  getUncachedAstSlugs, setEntryNotes, getMathByHashes, putMathBatch, getLinksFrom,
  type UserDataExport, type BookmarkRow,
} from './services/db';
import type { Annotation, DownloadProgress, IndexEntry, LibraryScope } from './types';
import type { UserDataStore } from './core/ports';
import { exportUserDataToFolder, importUserDataFromFolder } from './core/syncUserData';
import { exportBookmarkToZotero } from './core/zotero';
import { downloadAll as downloadAllUseCase, syncCachedArticles as syncCachedUseCase } from './core/libraryDownload';
import { refreshIndexIfStale as refreshIndexUseCase } from './core/refreshIndex';
import { fetchAndCacheArticle as cacheArticleUseCase, type CacheArticleOptions } from './core/cacheArticle';
import { createMathCompletion } from './core/mathCompletion';
import { createIdleScheduler } from './core/idleScheduler';
import { createMathPacing } from './core/mathPacing';
import { createChunkedRenderer } from './core/mathChunked';
import { createMathCache } from './core/mathCache';
import { createSubstituteMath } from './core/substituteMath';
import { backfillAst as backfillAstUseCase } from './core/backfills';
import { ensureNotesCached as ensureNotesUseCase } from './core/ensureNotes';
import { importSeed, type SeedPhase } from './core/seedImport';
import { seedFiles, seedDatabase } from './services/seedImport';
import { fetchIndexHtml, fetchArticleHtml, fetchNotesHtml } from './services/catalog';
import { renderMathBatch } from './services/mathRender';
import { watchStalls, highResNow } from './services/stallWatch';
import { expoSyncFolder } from './services/expoSyncFolder';
import { zoteroHttp } from './services/zoteroHttp';
import { netInfoConnectivity, rnInteractions } from './services/prefetch';
import { createPlatformProgressSink } from './services/downloadNotification';
import { createPrefetcher } from './core/prefetch';
import { createProgressNotifier } from './core/downloadNotifier';
import { prewarmCommonMath, type PrewarmDeps } from './core/prewarmCommonMath';
import { COMMON_MATH, commonMathStamp } from './data/commonMath';
import { perf } from './services/perf';
import { linkifyHtml } from './utils/linkifier';
import seedEntries from './assets/entry-seed.json';

declare const __DEV__: boolean | undefined;

// ── Math runtime ─────────────────────────────────────────────────────────────

// The pieces of equation rendering, built once here and shared: the idle scheduler (holds,
// quiet-gap policy, background tasks), the pacing helpers around it, the chunked renderer, the
// equation cache and the substitution that rewrites an article's TeX. Each core piece takes the
// clock, the timer and the renderer as parameters; this is the only place they are real.
const setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms);

export const idleScheduler = createIdleScheduler({
  now: () => Date.now(),
  setTimer,
  clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  afterInteractions: cb => { InteractionManager.runAfterInteractions(cb); },
  onError: (key, err) => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(`[idleScheduler] ${key} failed`, err);
  },
});

const pacing = createMathPacing({ scheduler: idleScheduler, setTimer, now: highResNow });
export const { withDownloadHold, whenMathMayRun, yieldThenMathMayRun } = pacing;

const renderChunked = createChunkedRenderer({
  render: renderMathBatch,
  firstGate: pacing.whenMathMayRun,
  nextGate: pacing.yieldThenMathMayRun,
  macrotask: () => pacing.macrotask(),
});

const mathCache = createMathCache({
  store: { getMathByHashes, putMathBatch },
  renderChunked,
  pause: pacing.yieldThenMathMayRun,
  macrotask: () => pacing.macrotask(),
});
export const ensureMath = mathCache.ensureMath;
/** Test hook: forget this run's equation-failure bookkeeping (a restart does the same). */
export const _resetMathCacheState = mathCache.reset;

const substitutemath = createSubstituteMath({
  ensureMath: mathCache.ensureMath,
  meta: { getMeta },
  mathSlice: pacing.mathSlice,
});

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
//   skipMath       — leave raw TeX and queue the slug on the pending list only; no rendering
//                    is started (bulk download; resumePendingMath drains the list).
//   deferPriority  — priority of the deferred render (default 'current'; prefetch passes
//                    'background' so a neighbour never competes with the reader).
export function fetchAndCacheArticle(slug: string, opts: CacheArticleOptions = {}): Promise<boolean> {
  return cacheArticleUseCase({
    source: { fetchArticleHtml, fetchNotesHtml },
    library: { cacheArticle, indexLinks },
    math: { substitute: substitutemath, completeLater: mathCompletion.completeLater, queueForLater: mathCompletion.queueForLater },
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
  // A download hold keeps equation rendering and background tasks paused while it runs. It is
  // released before the queued math is drained; resumePendingMath still pauses per article for
  // any hold or reader activity, so it never renders during a download.
  return withDownloadHold(() => downloadAllUseCase(
    { library: { getSlugsByCacheStatus }, cacheArticle: fetchAndCacheArticle, sleep },
    onProgress, signal, scope,
  )).finally(() => { void resumePendingMath().catch(() => {}); });
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

// ── Background pass over cached articles ─────────────────────────────────────

// Background pass: pre-parse the AST of cached articles that have none.
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
export const startPrefetch: (slug: string) => () => void = createPrefetcher({
  connectivity: netInfoConnectivity,
  interactions: rnInteractions,
  delay: { start: ms => { let t: ReturnType<typeof setTimeout>; return { done: new Promise<void>(r => { t = setTimeout(r, ms); }), cancel: () => clearTimeout(t) }; } },
  links: { getLinksFrom },
  fetchOne: s => fetchAndCacheArticle(s, { deferPriority: 'background' }),
});

// ── Download notification ────────────────────────────────────────────────────

// Throttles progress updates (clock injected) and hands them to the platform sink. useBoot calls
// these three around downloadAll.
const downloadNotifier = createProgressNotifier({ sink: createPlatformProgressSink(), clock: { now: () => Date.now() } });
export const startDownloadNotification = downloadNotifier.start;
export const updateDownloadNotification = downloadNotifier.update;
export const finishDownloadNotification = downloadNotifier.finish;

// ── Common-equation pre-warm ─────────────────────────────────────────────────

// Connects prewarmCommonMath (src/core) to the app: the db meta row that holds the stamp,
// mathCache.ensureMath at the lowest priority, and the idle scheduler. useBoot calls
// scheduleCommonMathPrewarm() once, after the other idle tasks.
//
// Never-during-reading/scroll/download is not re-implemented here: the task starts only when the
// scheduler is idle, and ensureMath(..., 'background') awaits the priority model
// (src/utils/mathThrottlePolicy.ts) before every chunk, so a reading or download hold, or recent
// scroll/touch, pauses it at the next chunk boundary. The priority must stay 'background' (a test
// guards this).
export const COMMON_MATH_META_KEY = 'common_math_prewarm';
export const COMMON_MATH_TASK_KEY = 'prewarm-common-math';

export function realPrewarmDeps(ensure: typeof ensureMath = ensureMath): PrewarmDeps {
  return {
    list: COMMON_MATH,
    stamp: commonMathStamp(),
    ensure: spots => ensure(spots, 'background'),
    getStamp: () => getMeta(COMMON_MATH_META_KEY),
    setStamp: s => setMeta(COMMON_MATH_META_KEY, s),
  };
}

export function scheduleCommonMathPrewarm(
  scheduler: Pick<typeof idleScheduler, 'schedule'> = idleScheduler,
  deps: PrewarmDeps = realPrewarmDeps(),
): boolean {
  return scheduler.schedule(COMMON_MATH_TASK_KEY, () => prewarmCommonMath(deps));
}


// ── Seed import (UC-A2) ──────────────────────────────────────────────────────

export type { SeedPhase };

/**
 * Replace the local database with the one at `url`, keeping the reader's data. Callers wrap it in
 * withDownloadHold. The orchestration is src/core/seedImport.ts; the file and connection calls
 * are the adapters in src/services/seedImport.ts.
 */
export function importSeedFromUrl(url: string, onProgress: (p: SeedPhase) => void): Promise<void> {
  return importSeed(
    {
      files: seedFiles,
      db: seedDatabase,
      userData: dbUserData,
      meta: { setMeta },
      clock: { now: () => Date.now() },
    },
    url,
    onProgress,
  );
}
