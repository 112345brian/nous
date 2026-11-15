// The composition root: the one place that builds concrete adapters and hands them to the core
// use cases. Screens and App.tsx import the use cases from here; the core imports nothing outside
// itself and the pure inner ring; adapters (src/services/*) never import this file.
// src/__tests__/compositionRoot.test.ts enforces all three.
//
// Adapters live in src/services (db, catalog's fetch and equation functions, expoSyncFolder,
// zoteroHttp, mathPriority, prefetch, ...). Each use case in src/core takes the ports it needs
// as a parameter; this file is where they meet.
import { InteractionManager, Platform } from 'react-native';
import { createDb, type UserDataExport, type BookmarkRow } from './services/db';
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
import { seedFiles, createSeedDatabase } from './services/seedImport';
import { fetchIndexHtml, fetchArticleHtml, fetchNotesHtml } from './services/catalog';
import { loadMathJaxScript } from './services/mathRender';
import { createMathBridge } from './core/mathBridge';
import type { MathRenderer } from './core/ports';
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
export { perf };
// UI stores and use cases (section "UI stores" below).
import type {
  AnnotationStore, AppPrefsStore, BookmarkStore, KeyValueStore, LibraryReadStore, ReaderStateStore,
} from './core/ports';
import { loadArticleForReading } from './core/loadArticle';
import { reanchorOrphans as reanchorOrphansUseCase, deleteOrphans as deleteOrphansUseCase } from './core/orphanedAnnotations';
import { loadHomeData as loadHomeDataUseCase } from './core/homeData';
import { loadReaderSettings as loadReaderSettingsUseCase } from './core/readerSettings';
import { runAutoDeepSync as runAutoDeepSyncUseCase } from './core/autoDeepSync';
import { prepareZoteroSend as prepareZoteroSendUseCase } from './core/zoteroSend';
import { createLinkifier } from './utils/linkifier';
import { LINK_MAP_JSON } from './assets/linkMapData';
import seedEntries from './assets/entry-seed.json';
// Knowledge graph (graph/InPhO slice)
import { createGraph } from './core/graph';
import { createGraphStore } from './services/graphDb';
import { mergeAnnotation } from './core/annotationMerge';
import { mergeRead } from './core/readsMerge';
import { runMigrations, tableVersionStore, userVersionStore } from './core/migrations';
import { CORE_MIGRATIONS } from './services/coreMigrations';
import { secretsAvailable, getSecret, setSecret, deleteSecret } from './services/secureSecrets';
import { inphoSource } from './services/inphoSource';

declare const __DEV__: boolean | undefined;

// ── The app database ─────────────────────────────────────────────────────────

// Random 128-bit hex id; crypto.randomUUID is not guaranteed on Hermes.
function newUid(): string {
  let id = '';
  for (let i = 0; i < 4; i++) id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return id;
}

// The one database instance: it holds the connection and the in-memory caches, and gets the core
// pieces (migration runner, merge rules), the clock, the uid source and the secure store from here.
// Everything that needs the connection (stores, the seed import, the graph tables) is built from it.
const appDb = createDb({
  migrate: async db => { await runMigrations(db, CORE_MIGRATIONS, userVersionStore); },
  mergeAnnotation,
  mergeRead,
  clock: { now: () => Date.now() },
  newUid,
  secrets: { available: secretsAvailable, get: getSecret, set: setSecret, delete: deleteSecret },
  loadBundledLinkMap: async () => (await import('./assets/linkMapData')).LINK_MAP_JSON,
});
const {
  getSyncFolder, exportUserData, importUserData, getArticleVersionDate,
  getSlugsByCacheStatus, getCachedSlugs, getMeta, setMeta,
  upsertIndexEntries, cacheArticle, getEntryCount, indexLinks, getAllEntryTitles, invalidateLinkCache,
  cleanDenormalizedTitles, getEntryHtml, updateArticleHtml, setArticleAst,
  getUncachedAstSlugs, setEntryNotes, getMathByHashes, putMathBatch, getLinksFrom,
  getDb, getEntryPreview,
} = appDb;
const dbStore = appDb;
// The same instance, for the on-device test runner (src/tests/runTests.ts), which drives the real database.
export { appDb };
const getEntryHtmlForGraph = getEntryHtml;

// The linkifier over the bundled link index. Parsing the index and compiling its regex is deferred
// to the first article that is cached, not paid at startup.
let linkifier: ((html: string) => string) | null = null;
function linkifyHtml(html: string): string {
  if (!linkifier) linkifier = createLinkifier(LINK_MAP_JSON);
  return linkifier(html);
}

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

// ── Math render bridge ───────────────────────────────────────────────────────

// The one WebView bridge instance. The core reaches it only as the `MathRenderer` port;
// components/MathRenderWebView registers into it through `mathWebViewHost`. Timers are real here.
const mathBridge = createMathBridge({
  loadEngineScript: loadMathJaxScript,
  setTimer,
  clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
});

// The Hermes spike (services/mathRenderHermes.ts) is a second `MathRenderer`, chosen here by the
// build-time flag, not a branch inside the bridge. It is required lazily, inside the flagged
// branch, so its MathJax-in-Hermes code is never evaluated (and a release build can drop it)
// unless EXPO_PUBLIC_MATH_HERMES=1. With the flag on there is no WebView engine to load, so
// preloadMathJax is a no-op. See docs/mathjax-hermes-spike.md.
const useHermesMath = process.env.EXPO_PUBLIC_MATH_HERMES === '1';
const mathRenderer: MathRenderer = useHermesMath
  ? { render: items => require('./services/mathRenderHermes').renderMathBatchHermes(items) }
  : mathBridge;

/** What the hidden MathRenderWebView calls into; nothing else should. */
export const mathWebViewHost = {
  attach: mathBridge.attach,
  onMessage: mathBridge.onMessage,
  onDomReady: mathBridge.onDomReady,
  reset: mathBridge.reset,
};
/** Load MathJax into the WebView now (boot does this only when equations are waiting). Idempotent. */
export const preloadMathJax = (): Promise<void> => (useHermesMath ? Promise.resolve() : mathBridge.preload());
export const isMathWebViewReady = mathBridge.isAttached;

const renderChunked = createChunkedRenderer({
  render: mathRenderer.render,
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

// ── UI stores ────────────────────────────────────────────────────────────────

// The stores the screens read and write, built from the SQLite adapter. Screens never import
// services/db (RC5); they take these from here. Each is typed by its port in src/core/ports.ts,
// so a method added to db.ts is not visible to the UI until it is added to a port.

/** The `meta` table: small settings and bookkeeping (appearance, font size, onboarding flag...). */
export const metaStore: KeyValueStore = { getMeta: dbStore.getMeta, setMeta: dbStore.setMeta };

export const readerState: ReaderStateStore = {
  recordRead: dbStore.recordRead,
  setReadProgress: dbStore.setReadProgress,
  forceSetReadProgress: dbStore.forceSetReadProgress,
  getRecentSlugs: dbStore.getRecentSlugs,
  getSessions: dbStore.getSessions,
};

export const bookmarkStore: BookmarkStore = {
  toggleBookmark: dbStore.toggleBookmark,
  isBookmarked: dbStore.isBookmarked,
  getBookmarks: dbStore.getBookmarks,
  getBookmarksFull: dbStore.getBookmarksFull,
};

export const annotationStore: AnnotationStore = {
  getAnnotationsForSlug: dbStore.getAnnotationsForSlug,
  getAllAnnotations: dbStore.getAllAnnotations,
  saveAnnotation: dbStore.saveAnnotation,
  updateAnnotation: dbStore.updateAnnotation,
  deleteAnnotation: dbStore.deleteAnnotation,
  deleteAnnotations: dbStore.deleteAnnotations,
  updateAnnotationAnchor: dbStore.updateAnnotationAnchor,
};

export const libraryRead: LibraryReadStore = {
  getEntry: dbStore.getEntry,
  getEntryHtml: dbStore.getEntryHtml,
  getEntryPreview: dbStore.getEntryPreview,
  getAllEntries: dbStore.getAllEntries,
  searchEntries: dbStore.searchEntries,
  getLinksTo: dbStore.getLinksTo,
  indexLinks: dbStore.indexLinks,
  getMathSvgMap: dbStore.getMathSvgMap,
  getEntryCounts: dbStore.getEntryCounts,
  getEntryCount: dbStore.getEntryCount,
  clearArticleCache: dbStore.clearArticleCache,
};

export const appPrefs: AppPrefsStore = {
  getPrefs: dbStore.getPrefs,
  savePrefs: dbStore.savePrefs,
  getZoteroPrefs: dbStore.getZoteroPrefs,
  saveZoteroPrefs: dbStore.saveZoteroPrefs,
  getSyncFolder: () => dbStore.getSyncFolder() as Promise<string>,
  setSyncFolder: dbStore.setSyncFolder,
};

// ── UI use cases ─────────────────────────────────────────────────────────────

/** Entry + highlights + display settings for the reader; downloads the article first when needed. */
export function loadArticleData(slug: string, forceRefetch: boolean, onFetching?: () => void) {
  return loadArticleForReading(
    {
      library: libraryRead, annotations: annotationStore, meta: metaStore, timing: perf,
      fetchArticle: s => fetchAndCacheArticle(s),
    },
    slug, forceRefetch, onFetching,
  );
}

export const reanchorOrphans = (anns: Parameters<typeof reanchorOrphansUseCase>[1], content: string, hash: string) =>
  reanchorOrphansUseCase(annotationStore, anns, content, hash);
export const deleteOrphans = (ids: number[]) => deleteOrphansUseCase(annotationStore, ids);

export const loadHomeData = () =>
  loadHomeDataUseCase({ reads: readerState, bookmarks: bookmarkStore, annotations: annotationStore });

export const loadReaderSettings = () => loadReaderSettingsUseCase(metaStore);

export const prepareZoteroSend = (slug: string) =>
  prepareZoteroSendUseCase({ prefs: appPrefs, annotations: annotationStore }, slug);

/** Re-download cached articles when the auto-sync setting says it is due. */
export const runAutoDeepSync = () =>
  runAutoDeepSyncUseCase({ meta: metaStore, clock: { now: () => Date.now() }, sync: () => syncCachedArticles(() => {}) });


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
      db: createSeedDatabase(appDb),
      userData: dbUserData,
      meta: { setMeta },
      clock: { now: () => Date.now() },
    },
    url,
    onProgress,
  );
}

// ── Knowledge graph ──────────────────────────────────────────────────────────

// The SEP link graph and the InPhO graphs, built once here. The graph tables, the InPhO source,
// the settings, the clock and the pause are the only real things behind it; its one piece of state
// (which slugs this session already primed) lives in this instance.
const graph = createGraph({
  source: inphoSource,
  store: createGraphStore(getDb, { runMigrations, tableVersionStore }),
  meta: { getMeta, setMeta },
  clock: { now: () => Date.now() },
  sleep,
  articles: { getPreview: getEntryPreview, getHtml: getEntryHtmlForGraph },
});
export const getGraph = graph.getGraph;
export const getArticleLinkGraph = graph.getArticleLinkGraph;
export const ensureInphoIndex = graph.ensureInphoIndex;
export const primeBackfillForSlugs = graph.primeBackfillForSlugs;
export const primeGraphLayouts = graph.primeGraphLayouts;
export const getLayoutCache = graph.getLayoutCache;
export const setLayoutCache = graph.setLayoutCache;
export const getNodePreview = graph.getNodePreview;
export const getVisitedOnly = graph.getVisitedOnly;
export const setVisitedOnly = graph.setVisitedOnly;
