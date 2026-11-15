# Core dependency-injection audit

Status: **findings as of commit time, derived from reading the code** (not run on a
device). Companion to `src/utils/__tests__/innerRing.test.ts`, which enforces the rules
below. The use-case list this audit checks is the draft `docs/use-cases.md` (section 3,
uncommitted in the architecture-review worktree).

Goal: every dependency the core needs is **injected**, never imported or created inside
it, so the core runs and tests with fakes.

## 1. The rings today

| Ring | Where | Rule (enforced by `innerRing.test.ts`) |
|---|---|---|
| Inner (pure) | `src/types.ts`, `src/data/**`, `src/utils/**` except `utils/sepHtml/render/**` | No I/O, no outer-ring imports, no timers/clock/random, no `process.env`, no module-level mutable state |
| Core | `src/core/**` (new): `ports.ts` (interfaces only) and use cases that take ports as parameters | Same rules as inner; `ports.ts` may contain only types |
| Adapters / wiring | `src/services/**` | Implement the ports; may import `src/core`; core never imports them |
| UI | `src/screens/**`, `src/components/**`, `App.tsx`, `utils/sepHtml/render/**` | Call services (and, later, wired use cases) |

Before this change there was no core ring: `catalog.ts` (use-case logic) and `db.ts`
(SQLite) sat side by side in `services/`, and screens imported both.

## 2. Hidden dependencies, per module

"Core" modules are the ones holding use-case logic. Adapters (`db.ts`, `graphDb.ts`,
`mathRender.ts`, `downloadNotification.ts`) are allowed to be concrete; they are listed
because they leak state or globals into the logic that calls them.

| Module | Hidden singletons / state | Concrete adapters imported | Implicit globals | Port(s) it needs | Status |
|---|---|---|---|---|---|
| `services/dataSync.ts` | none | `expo-file-system`, `react-native` `Platform`, `fetch`, `db` | `Date` (Zotero "today"), `process.env.HOME` | `SyncFolder`, `UserDataStore`, `ZoteroHttp`, `Clock` | **Converted** (see section 4) |
| `utils/linkifier.ts` | `_default` (lazy cache of the compiled link index) | none (bundled data module only) | none | the index as a parameter | **Converted**: `createLinkifier(json)`; the lazy default is the one recorded exception |
| `services/catalog.ts` | none | `./db`, `fetch` x3 (index, article and notes pages), `./perf` | `setTimeout` (the 30 s abort) | it is the adapter module for SEP pages; everything else it used to hold is in `src/core`, wired in `composition.ts` | **Converted** (section 4); only the upgrade-only `backfillMathHashFormat` remains in logic form (section 8) |
| `services/db.ts` | `_db` (connection), `metaCache`, `_linkCache` | `expo-sqlite` | `Date.now` x7 | it **is** the `LibraryStore` / `UserStore` / `KeyValueStore` adapter; nothing to inject into it | Listed; 4 sessions editing it |
| `services/graphDb.ts` | `_schema` (creates its own tables lazily) | `getDb()` x4 from `./db` | `Date.now` x4 | `GraphStore` adapter; the graph assembly (nodes/edges from rows) is pure and could move inward | Listed |
| `services/inpho.ts` | `_primedSlugs` (Set) | `fetch` (`getJson`), `expo-file-system` (dev-seed files, `__DEV__` only), `getMeta/setMeta` from `./db` | `Date.now` x2, `setTimeout` x1 | `GraphSource`, `KeyValueStore`, `Clock`, `Sleep` | Listed |
| `services/mathRender.ts` | 7 module variables (`injectFn`, `domReady`, `resolveReady`, `readyPromise`, `mathJaxLoading`, `seq`, `pending`) forming a bridge to the WebView component | `expo-asset`, `expo-file-system` | `setTimeout` (timeout race) | `MathRenderer` (batch **and** readiness lifecycle) | Listed |
| `services/downloadNotification.ts` | none now (the iOS permission flag is per sink instance) | `react-native` `NativeModules`/`Platform`, `expo-notifications` | `setTimeout` x2 (the 8 s dismiss, a platform call) | `ProgressNotifier` (core, throttle) over a `ProgressSink` (adapter) | **Converted**: `core/downloadNotifier.ts` holds the 3 s / 30 article throttle with the clock injected; the adapter keeps only the native and expo calls |
| `services/seedImport.ts` | none | `expo-file-system` (+ `/legacy`), dynamic `import('./db')` to call `closeDb` | none | `SeedFiles`, `SeedDatabase`, `UserDataStore` (export/import), `KeyValueStore`, `Clock` | **Converted**: `core/seedImport.ts` holds download/validate/snapshot/swap/restore/rollback; the adapter is the file and connection calls only; wired in `composition.ts` as `importSeedFromUrl` |
| `screens/*`, `App.tsx` | n/a (UI) | 10 files import `services/db` as a value (tracked by a shrink-only test) | `InteractionManager` (ArticleScreen only), `Date.now` (HistoryScreen, ArticleScreen `updated_at`, App auto-sync interval), `setTimeout` (UI debounces) | wired use cases | Listed |

Not hidden dependencies (deliberately allowed): `atob`/`btoa` (pure, deterministic; used in
`utils/sepHtml/parse.ts`), seeded constant tables (`new Set([...])`), `Math`, `JSON`.

## 3. Composition root and direction of dependency

**`src/composition.ts` is the composition root.** It builds the concrete adapters and hands
them to the core use cases; screens, `src/boot` and `App.tsx` import the use cases from it. Every converted
use case is wired there and nowhere else:

- sync-folder export/import and Zotero export (adapters `services/expoSyncFolder.ts`,
  `services/zoteroHttp.ts`; the user-data store is a small object over `services/db`; the platform
  and home directory are read here, at the edge);
- the entry-index refresh, article caching, footnote fetching and the deferred-math pipeline
  (adapters: `services/catalog.ts`, now just the three page fetchers; plus `services/perf.ts`,
  the linkifier and the bundled seed index);
- the **math runtime**, built once in the root and shared by the UI and the use cases: the idle
  scheduler (holds, quiet-gap policy, background tasks), the pacing helpers around it, the
  chunked renderer, the equation cache and the TeX substitution, all from `src/core`, each taking
  its clock, timer, renderer and store as parameters. `idleScheduler`, `withDownloadHold` and
  `ensureMath` are exported for the screens and the boot hook;
- `downloadAll` and `syncCachedArticles`, wrapped in the math priority model's download hold
  (`downloadAll` drains the queued math once the hold is released);
- the background AST pass (`backfillAst`), paced by the priority model's `yieldThenMathMayRun`;
- the common-equation pre-warm: its use case is `core/prewarmCommonMath.ts` (it already took
  every dependency as a parameter and imports nothing), and the wiring that used to be
  `services/commonMathWiring.ts` (the `meta` stamp, `ensureMath` at background priority,
  the idle scheduler) is in the root, because connecting concrete adapters to a use case is what
  the root is for;
- link prefetch: `core/prefetch.ts` (`createPrefetcher`) takes `Connectivity`, `Interactions`, `Delay`,
  `LinkLookup` and the "cache one article" function; the root builds the one instance and exports
  `startPrefetch`. `services/prefetch.ts` is only the NetInfo and InteractionManager adapters.
- download notification: `core/downloadNotifier.ts` (`createProgressNotifier`) over the platform
  sink; the root exports `start/update/finishDownloadNotification` for `useBoot`.
- secrets: the `SecretStore` port is in `core/ports.ts`; `services/secureSecrets.ts` implements it
  (`secureSecretStore`) and keeps its named functions, which `db.ts` still imports.

What still wires itself outside the root:

- `src/boot/useBoot.ts` (the boot state machine, moved out of `App.tsx` upstream) connects the download progress callback to the notifier and calls `preloadMathJax()`; it takes every use case from the root.
- `components/MathRenderWebView.tsx` registers itself into a module-level bridge in
  `services/mathRender.ts` (`_registerInject`, `_onMessage`, `_signalDomReady`).
- Ten files outside the services still import the SQLite adapter (`services/db`) as a value:
  `boot/useBoot`, `ArticleScreen`, `HomeScreen`, `GraphScreen`, `HistoryScreen`, `SettingsScreen`,
  `ReadingListScreen`, `AnnotationsScreen`, `OrphanedAnnotationsBanner` and `theme/ThemeProvider`
  (it stores the `appearance` preference with `getMeta`/`setMeta`).

Direction of dependency, all enforced by tests (`innerRing.test.ts`, `compositionRoot.test.ts`):

| Rule | Check |
|---|---|
| Inner ring and core never import outer code, or the root | `innerRing.test.ts` |
| Adapters (`src/services/*`) never import the root | RC2 |
| Only `composition.ts` wires core use cases (no exceptions today; a new one needs a reason and fails if it goes stale) | RC3 |
| Screens, components and `App.tsx` take the converted use cases from the root, not from `catalog`/`prefetch` | RC4 |
| The list of files that import `services/db` directly can only shrink (a new one fails; a migrated one must leave the list) | RC5 |

Each rule was checked by introducing a deliberate violation and confirming it fails.

## 4. Converted now

All conversions keep the old exported function names and signatures, so no caller changed.

| What | Before | After |
|---|---|---|
| Sync-folder export/import (UC-H3, UC-H4) | `dataSync.ts` built `File`/`Directory`, read `Platform.OS` and `process.env.HOME` inline | `core/syncUserData.ts` takes `SyncFolder` + `UserDataStore` + an env value; path logic is the pure `utils/syncPath.ts`; `dataSync.ts` keeps `exportToSyncFolder` / `importFromSyncFolder` as wrappers around an `expo-file-system` adapter |
| Zotero export (UC-E4) | `fetch`, `new Date()` and the version lookup inline | `core/zotero.ts` takes `ZoteroHttp`, a `versionDate` function and a `Clock`; the note/creator builders came along unchanged; `exportToZotero(apiKey, userId, item, annotations)` is a wrapper |
| Link index (UC-C1 step) | `linkifyHtml` hard-wired to the bundled JSON | `createLinkifier(json)` is pure and testable with a tiny index; `linkifyHtml` is the lazy default |
| Index refresh (UC-A3) | `catalog.refreshIndexIfStale` called `Date.now`, `fetch`, `./db` and the bundled seed directly | `core/refreshIndex.ts` takes `ArticleSource`, `LibraryIndexStore`, `KeyValueStore`, `Clock` and the bundled entries as a parameter; the contents-page parser and the link-index payload are pure (`utils/sepIndex.ts`); `catalog.refreshIndexIfStale()` is a wrapper with the same name, so `App.tsx` and `syncCachedArticles` are unchanged |
| Article caching (UC-C1, C7) | `catalog.fetchAndCacheArticle` called `fetch`, `AbortController`, `./db`, the math pipeline, `perf` and `linkifyHtml` directly | `core/cacheArticle.ts` takes `ArticleSource`, `ArticleLibrary`, `ArticleMath`, `StageTimer` and a `linkify` function; page extraction, header stripping and the TeX/footnote checks are pure (`utils/sepArticlePage.ts`); `catalog.fetchAndCacheArticle(slug, opts)` is a wrapper, and the 30 s abort plus the `fetch`/`fetch-body` timing stay in a small adapter beside it, so callers (`ArticleScreen`, `prefetch`, `downloadAll`, `syncCachedArticles`, `runTests`) are unchanged |
| Deferred-math completion (UC-C6) | `catalog.ts` held `pendingChain`, `mathReadyListeners` and `mathInFlight` as module-level singletons, plus the read-modify-write on `math_pending` | `core/mathCompletion.ts`: `createMathCompletion({ substitute, articles, meta, sleep })` keeps all state in a closure; `catalog.ts` creates the one app instance and re-exports `onMathReady`, `completeArticleMath` and `resumePendingMath` under the same names, so `ArticleScreen` and `backfillMathInline` are unchanged. `substitutemath` is deliberately **not** moved (see section 5) and is injected. The "is TeX left?" check is the pure, stateless `utils/sepMath.hasTexSpan` |
| Composition root | wiring spread over `services/dataSync.ts` and `services/catalog.ts`; UI imported use cases from wherever they lived | `src/composition.ts` owns the sync/Zotero wiring and re-exports the catalog-wired use cases; `ArticleScreen`, `SettingsScreen`, `ReadingListScreen` and `App.tsx` import them from it; `dataSync.ts` keeps only the legacy `syncOnLaunch` no-op that `delete-legacy-compat` removes (left alone so that change still applies) |
| Bulk download and sync (UC-G1, G2) | `catalog.downloadAll` / `syncCachedArticles` called `fetchAndCacheArticle`, `refreshIndexIfStale`, `./db`, `setTimeout` and `Date.now` directly | `core/libraryDownload.ts` takes the library queries, the bound `cacheArticle` and `refreshIndex` use cases, a `Clock`, `KeyValueStore` and a `Sleep`; the group sizes and pauses (6 / 100 ms and 3 / 200 ms) are named constants; `DownloadProgress` moved to `types.ts`; the wrappers live in `composition.ts` (they only need use cases it already imports one way), so `catalog.ts` lost about 60 lines and `SettingsScreen` and `App.tsx` import them from the root |
| Backfills (UC-A4) | `catalog.backfillMathInline` / `backfillAst` called `./db`, `substitutemath`, `resumePendingMath` and the priority model directly | `core/backfills.ts`: `backfillAst(deps)` takes the stores and `pause(priority)`; wrapped in the root. `backfillMathInline` was deleted upstream (queued math is drained by `resumePendingMath` instead), so its core version, its flag and its tests went with it |
| Math runtime (UC-C6; from `math-throttle`) | `services/{idleScheduler,mathPriority,mathCache,mathChunked}.ts` and `catalog.substitutemath`: module-level singletons (`attempts`, `permanentFailures`, the scheduler's queue and holds, the shared regex) reading `Date.now`, `setTimeout`, `InteractionManager` and `__DEV__` directly | `core/idleScheduler.ts` (the clock, timer and interaction hook are parameters), `core/mathPacing.ts`, `core/mathChunked.ts` (`createChunkedRenderer`), `core/mathCache.ts` (`createMathCache`: the failure bookkeeping is closure state, so instances are independent), `core/substituteMath.ts` (`createSubstituteMath`, a fresh regex per call, the tier flag read through the key/value port); the one app-wide set is built in `composition.ts`; `watchStalls` stays in `services/stallWatch.ts` as the dev-only adapter it is; the render request/result types moved to `core/ports.ts` (`MathRequest`, `MathResult`) with new ports `MathRenderer` and `MathStore` |
| Math gap fix (from `fix-math-gap`) | `fetchAndCacheArticle`, `downloadAll`, `resumePendingMath` edited in place | re-applied in the core versions: `CacheArticleOptions.deferPriority`, `ArticleMath.queueForLater` (a `skipMath` article is queued on `math_pending`, awaited), `completeLater(slug, html, priority)`, and the root's `downloadAll` drains after the hold is released |
| Common-equation pre-warm (from `common-math-list`) | `services/prewarmCommonMath.ts` + `services/commonMathWiring.ts` | use case moved to `core/prewarmCommonMath.ts`; wiring moved into `composition.ts`; both tests moved with them (the source guard that pins `'background'` now reads `composition.ts`) |
| Footnote backfill (UC-C4) | `catalog.ensureNotesCached` called `fetch` and `./db` | `core/ensureNotes.ts`; wrapped in the root; `referencesNotes` is shared with the article use case |
| Math priority model (from `math-throttle`) | `completeArticleMath(slug, html, priority)`, `watchStalls`, `yieldThenMathMayRun`, `withDownloadHold` wired into `catalog.ts` | re-homed behind the ports: `priority` is an argument of `ArticleMath.substitute` (`null` = the caller owns the schedule) and of `completeArticleMath`; the pause and the stall watch are injected into `createMathCompletion`; the download hold wraps the two bulk wrappers in the root |
| `catalog.ts` | use cases, wiring and adapters in one 590-line file | adapters only (the page fetchers) plus the upgrade-only `backfillMathHashFormat`; nothing in it calls a converted use case, so the root imports it one way and the RC3 exception is gone |

Evidence: `src/services/__tests__/dataSync.test.ts` (14 tests, written before the change
against the old code and **unchanged** afterwards), the linkifier snapshots (taken from
the old code), plus new tests that run the core with plain in-memory fakes and make
`Date.now` and `fetch` throw, to prove the core never reaches for them:
`src/core/__tests__/*.test.ts`, `src/utils/__tests__/syncPath.test.ts`,
`src/utils/__tests__/linkifier.test.ts`, `src/utils/__tests__/sepIndex.test.ts`. The bulk-download tests
(`src/services/__tests__/downloadSync.test.ts`, 19 tests: concurrency, pacing with fake timers, progress, abort, the sync timestamp)
were written against the old functions and are unchanged after the move apart from the import path; dropping the pause after each
group is caught by 2 tests. The math-completion tests
(`src/services/__tests__/mathCompletion.test.ts`, 13 tests) were written against the old state machine and are
unchanged after the move; disabling the in-flight de-duplication is caught by 2 of them plus the perf session's. The article-caching
wrapper tests (`src/services/__tests__/fetchAndCache.test.ts`, 16 tests) and the perf session's
`deferredMath.test.ts` (9 tests, the math modes) were run against the old code first and are
unchanged after the move; a deliberate mutation of the defer rule is caught by 2 of them. The index-refresh
wrapper tests (`src/services/__tests__/refreshIndex.test.ts`, 17 tests) were also written
before the move and are unchanged after it.

Enforcement added to `innerRing.test.ts`: `src/core` is in the ring; it also fails on
`process.*`, a bare `Date()`, module-level `let`/`var`, and an empty module-level
`new Map/Set/WeakMap/WeakSet`; `ports.ts` must contain only types; recorded exceptions
must still match a real violation, so they cannot go stale.

## 5. Not converted, with a suggested order

Order is by value over risk, and by which files other sessions are editing. Start these
only after the performance and db sessions have merged, to avoid conflicts.

1. ~~`catalog.refreshIndexIfStale`~~ (UC-A3): **done**, see section 4. It introduced
   `KeyValueStore`, `ArticleSource.fetchIndexHtml` and `LibraryIndexStore`; `BundledIndex`
   turned out to be a plain data parameter (`bundledEntries`), not a port.
2. ~~`catalog.fetchAndCacheArticle`~~ (UC-C1, C7): **done**, see section 4. It introduced
   `ArticleSource.fetchArticleHtml`/`fetchNotesHtml`, `ArticleLibrary`, `ArticleMath` and
   `StageTimer`. `fetchNotesHtml` is passed through as it is (network plus a small
   extraction in one function); splitting those is a follow-up.
2b. ~~The deferred-math completion state machine~~ and ~~the equation pipeline behind it~~
   (scheduler, pacing, chunked renderer, cache, substitution): **done**, see section 4. What is
   left is the WebView bridge in `services/mathRender.ts` and the Hermes spike in
   `mathRenderHermes.ts`, which are the renderer adapter itself: the core sees it only as the
   injected `render` function (the `MathRenderer` port).
3. ~~`downloadAll` / `syncCachedArticles`~~ and ~~the backfills~~ (UC-G1, G2, A4): **done**.
   `backfillMathHashFormat` was left alone: see section 8.
4. **Auto-sync decision in `App.tsx`** (lines ~166-171): a duplicated staleness rule
   (`Date.now() - last > days`), same shape as `refreshIndexIfStale` and the InPhO TTL in
   `inpho.ensureInphoIndex`. Extract one pure `isStale(now, last, ttl)` into `utils` and
   use it in all three.
5. **Graph assembly in `graphDb.ts`** (UC-F1, F2). Turning rows into nodes and edges is pure
   and is a large part of the 474-line file; move it inward and leave SQL in the adapter. Also consider moving
   the `_schema` table creation into the migration code (`db-connection-migrations`).
6. **`inpho.ts`** (UC-F). `fetch` plus `getMeta/setMeta` plus the TTL: ports `GraphSource`,
   `KeyValueStore`, `Clock`; the dev-seed file reading is a `__DEV__`-only adapter.
7. **`mathRender.ts`**: the renderer adapter. The module-level bridge to the WebView component is the only
   global-mutable coupling between a component and a service. Replace the six variables
   with one object created by the composition root and passed to both sides.
8. ~~`seedImport.ts`~~ (UC-A2): **done**, see section 3 row and `core/seedImport.ts`.
9. ~~The composition root~~: **done for every converted use case**, see sections 3 and 4. What is
   left is migrating the ten files that import `services/db` to wired use cases, one at a time,
   removing each from the RC5 allowlist as it goes. `theme/ThemeProvider` is the easiest first
   one: pass it a `KeyValueStore` from the root.
10. **`db.ts`** splits (`LibraryStore` / `UserStore` / `KeyValueStore` / `SecretStore`) are the
    adapters side of the same boundary; sequence them after `db-secrets` and
    `db-connection-migrations` land.

Pure helpers still inside `db.ts` that can move inward with a re-export once the db
sessions are done: `buildTree`, `countWords` (the peer asked to keep these in place for
now).

## 6. Corrections to `docs/use-cases.md`

Verified against the code. Please fold these into the draft.

1. **UC-H4 and UC-H5 are wrong about "sync now".** The draft says `handleImport` and
   `handleSyncNow` use the same path. They do not: `SettingsScreen.handleSyncNow` and the
   `auto_sync` pref (`App.tsx` ~166) both call `catalog.syncCachedArticles`, which
   re-fetches cached **SEP articles**. That is UC-G2 ("Keep cached articles current"). The
   sync **folder** is only touched by the explicit Export and Import actions. Move H5 under
   G, and drop the claim from H4. `dataSync.syncOnLaunch` is an empty legacy function that
   `App.tsx` still calls.
2. **`SyncFolder` is not just a read/write port.** It also needs the folder preference
   (read via `getSyncFolder`, a `meta` value) and the environment (`Platform.OS`, home
   directory). Modeled now as `SyncFolder` + `UserDataStore.getSyncFolder` + `SyncEnv`.
3. **`Clock` / `Scheduler` conflates two things.** Services use timers only as short
   throttle sleeps (`setTimeout(r, 0..200)` in `catalog`, `inpho`) or a timeout race
   (`mathRender`): that is a `Sleep`/delay port, not a scheduler. `InteractionManager` is
   used only in `ArticleScreen` (UI), never in a service. The `Scheduler` the draft lists
   is what the `perf-parallel-defer` session is introducing. `Clock` is used by index
   staleness (`catalog`), the InPhO TTL (`inpho`), the auto-sync interval (`App.tsx`), row
   timestamps (`db`, `graphDb`), notification throttling, and the Zotero access date.
4. **`ProgressNotifier` is already injected.** `downloadAll(onProgress, signal, scope)` and
   `syncCachedArticles(onProgress, signal)` take a callback; `App.tsx` wires the notifier.
   Only the adapter (`downloadNotification.ts`, with its module `state`) is concrete.
5. **`SecretStore` is already a parameter at the use-case level.** `exportToZotero` takes
   `apiKey` and `userId`; `ReadingListScreen` reads them from `getZoteroPrefs()`. The
   gap is only where the key is stored, not how it reaches the use case.
6. **`GraphSource` has a second source and `GraphStore` owns its schema.** `inpho.ts` also
   reads dev-seed JSON files via `expo-file-system` in `__DEV__`; `graphDb.ts` creates its
   own tables lazily (`_schema`).
7. **Ports the draft is missing:**
   - `KeyValueStore` (`getMeta`/`setMeta`): used by `catalog`, `inpho`, `App.tsx`, onboarding.
   - `BundledIndex`: `refreshIndexIfStale` falls back to the bundled `entry-seed.json`
     (title/link facts only, allowed by `AGENTS.md`) when the first launch is offline. It
     needs no port: it is data, passed in as `bundledEntries`.
   - `SeedInstaller` (UC-A2): download a database, close the connection, replace the file.
   - `MathRenderer` is more than "TeX to SVG batch": it has a readiness lifecycle
     (`preloadMathJax`, `isMathWebViewReady`) that callers depend on.
   - `LinkIndex`: the link payload is cached in `db.ts` (`_linkCache`).
8. **UC-A3** also rebuilds the link index in the background (`buildLinkIndex`) and
   re-cleans denormalized titles after every refresh.
9. After conversion, `ArticleSource` has three methods (`fetchIndexHtml`, `fetchArticleHtml`,
   `fetchNotesHtml`), and the draft's `MathRenderer` is really three things: the renderer
   (WebView bridge), the equation store, and the deferred-completion pipeline. The use case
   only sees the last one, as `ArticleMath { substitute, completeLater }`.
10. `ArticleMathStore` (`getEntryHtml`, `updateArticleHtml`, `setArticleAst`) is new and separate
    from the draft's `LibraryStore`: the math pipeline rewrites articles but never creates them.
11. `@react-native-community/netinfo` is a dependency but nothing in `src` imports it. The
   prefetch work that wants a "skip when offline" check will need a `Connectivity` port.

## 7. Latent bugs found while doing this (not fixed unless noted)

- **Fixed:** `linkifyHtml` with an empty link index loops forever (the regex becomes
  `/(?:)/`, which matches the empty string and never advances). The bundled index has 1838
  entries, so it cannot happen today; a corrupt or empty index would hang the app while
  caching an article. `createLinkifier` now returns the input unchanged for an empty index.
- **Suspected, not fixed (behaviour preserved):** `~` expansion for the sync folder reads
  `process.env.HOME`. React Native's `process.env` normally has no `HOME`, so on a real
  device `~/Sync` likely resolves to `file://Sync/sep_user.json` (not a valid URI). Needs a
  device check. With the new `SyncEnv`, the fix is to pass a real home directory from the
  adapter (for example from `expo-file-system` `Paths`).
- **Suspected, not fixed (behaviour pinned in `refreshIndex.test.ts`):** after an offline
  first launch the bundled seed is stamped as a successful refresh
  (`index_refreshed_at = now`), so the app will not fetch the real index again for a week.
  The seed has no `parent_label`, so until then the browse list has no parent grouping and
  the link index is built from seed titles only. Probable fix: do not stamp the time when the
  entries came from the seed.
- **Suspected, not fixed (pinned):** a non-numeric `index_refreshed_at` value is treated as
  fresh forever (`now - NaN > interval` is false), unless the library is empty.
- **Suspected, not fixed (behaviour kept):** the 30 s abort timer in the article request is
  cleared as soon as the response headers arrive (`finally { clearTimeout }`), before the body
  is read. A connection that stalls mid-body is therefore never aborted, and the call (and the
  article screen waiting on it) can hang. Probable fix: keep the timer until `res.text()` has
  resolved. Pinned by `fetchAndCache.test.ts` ("the timeout timer is cleared once the response
  arrives").
- **Hazard removed:** `completeArticleMath` and `substitutemath` shared one global-flag regex
  (`MATH_SUBST_RE`) and each had to reset `lastIndex = 0` before use; forgetting that in
  either makes `test`/`exec` skip matches. The completion side now uses the stateless
  `hasTexSpan`; `substituteMath` now builds a fresh regex per call. (With `exec` in a loop the shared
  regex was harmless in practice, since the loop runs to `null`, which resets it; only the `.test()`
  use could leak state.)
- **Behaviour to know (pinned):** `completeArticleMath(slug, html)` returns the in-flight
  promise for that slug even if called with a different `html`, and a completion that finds no
  TeX left in an unchanged article counts as done and notifies listeners.
- **Suspected, not fixed (pinned in `downloadSync.test.ts`):** in both `downloadAll` and
  `syncCachedArticles` an article that fails to download is counted as done (the result of the
  fetch is never inspected), so progress reaches 100% even if everything failed. Worse,
  `syncCachedArticles` then records `last_deep_sync`, which `App.tsx` uses to decide when to
  sync next, so a sync run offline marks the library as freshly synced and the next auto-sync
  waits two to seven days. Probable fix: count only successes and record the time only if at
  least one article was refreshed (or report failures to the caller).
- **Fixed upstream (`fix-math-gap`):** `downloadAll` used to cache math articles as raw TeX and
  record nothing in `math_pending`, while `backfillMathInline`'s pass ran once ever, so articles
  downloaded afterwards kept their raw TeX. A `skipMath` article is now queued and drained by
  `resumePendingMath`; the one-shot backfill and its flag are gone.
- **Minor (pinned):** `downloadAll` also pauses 100 ms after the last group, which delays the
  end of the download for nothing.
- **Dead work removed:** `fetchAndCacheArticle` computed `extractTitle(html)` and never used it
  (the title comes from the index). The conversion drops it, which also clears one lint error.
- `scripts/test-download.mjs`, `scripts/buildEntrySeed.js` and `scripts/auditCorpus.cjs`
  carry their own copies of `extractById`, `decodeEntities` and friends (now canonical in
  `src/utils/sepPage.ts`). They can drift.

## 8. What is deliberately left outside the core, and why

After merging `math-throttle`, `delete-legacy-compat`, `tiered-math` and the rest of the parent
branch, and converting everything this audit listed, these remain outside `src/core` on purpose.

| Left in place | Where | Why |
|---|---|---|
| `backfillMathHashFormat` | `services/catalog.ts`, scheduled from `src/boot/useBoot.ts` | Upgrade-only code (it migrates an earlier build's inline-base64 math format; guarded by `math_hash_format_v1`). The brief said `delete-legacy-compat` had deleted it; at the parent tip it is still defined and still scheduled, and `LEGACY_RE` is its regex. By the prerelease rule it should be deleted, not converted, and that is the project owner's call. It touches only the database and the equation table, calls no converted use case, and so does not block anything. |
| `services/mathRender.ts` and `mathRenderHermes.ts` | `services/` | The renderer adapter: the WebView bridge (module-level `injectFn`, `readyPromise`, `pending`, `seq`, loaded from `expo-asset` and `expo-file-system`) and the flagged Hermes spike. The core sees it only as the injected `render` function. Making the bridge an instance owned by the root, with `MathRenderWebView` registering into it, would remove the last module-level coupling between a component and a service; it is a separate change. |
| `db.ts`, `graphDb.ts`, `inpho.ts`, `seedImport.ts`, `secureSecrets.ts`, `downloadNotification.ts`, `mathRender.ts`, `expoSyncFolder.ts`, `zoteroHttp.ts` | `services/` | These are the adapters. They are allowed to be concrete. The pure graph-assembly logic inside `graphDb.ts` and the TTL logic in `inpho.ts` could move inward (section 5, items 4 to 6). |
| `screens/GraphScreen.tsx` imports `services/db` | UI | The only RC5 allowlist entry left; the graph session owns it. The other nine UI files moved to the stores below. |
| `utils/sepHtml/render/**` | `utils/` | React Native UI code that sits under `utils/`; still an outer-ring exception in `innerRing.test.ts`. (`motion.ts` and `useBackDismiss.ts` moved to `src/ui/`, which counts as outer ring.) |
| `theme/` | UI | Outer ring by definition (the enforcement test lists it). |
| `useBoot` notifier wiring, `MathRenderWebView` bridge | UI | See section 3. |
| Module state in adapters: the bridge variables in `mathRender.ts` (`attempted` in prefetch is now instance state in `core/prefetch.ts`) | `services/` | Allowed at the edge. (The cache, the scheduler and the pacing are now instances built in the root; `_resetMathCacheState` is just that instance's `reset`.) |

### What the parent's new code added to the picture

- `utils/mathKey.ts` replaced `utils/mathHash.ts` from this branch: its `hash64` is the same
  algorithm (the pinned snapshots still pass against it), and `mathHash` now normalizes the TeX
  first.
- Static-scan tests that pin file locations (`mathPriority.callers.test.ts`,
  `dbSecrets.test.ts`) were updated to the new locations: the hold now lives in the root's
  wrappers, and the callers of `exportUserData`/`importUserData` are the core use case (through its
  port) and `seedImport`.
- The parent tests that imported `downloadAll`, `syncCachedArticles`, `completeArticleMath` and
  friends from `services/catalog` now import them from `composition`. Only import lines changed.

### Notification / prefetch / secrets slice

| Was | Now | Left outside the core, and why |
|---|---|---|
| `downloadNotification.ts`: module `state`, `Date.now`, throttle | `core/downloadNotifier.ts` + `ProgressNotifier`/`ProgressSink` ports; clock injected | Android/iOS calls and the 8 s `setTimeout` dismiss, in `createPlatformProgressSink()` (platform calls) |
| `prefetch.ts`: module `attempted`, NetInfo, InteractionManager, `./db` | `core/prefetch.ts` + `Connectivity`, `Interactions`, `Delay`, `LinkLookup`; `attempted` is instance state | `netInfoConnectivity`, `rnInteractions`; the `setTimeout` delay is built in the root |
| `secureSecrets.ts`: lazy module `mod` | `SecretStore` port in `core/ports.ts`; `secureSecretStore` adapter | The lazy `require` of `expo-secure-store` (it throws at import when unlinked). `db.ts` (not this slice) still imports the named functions; routing it through a `SecretStore` passed in from the root is for whoever owns `db.ts`. There is no logic worth a core module: every function is "call the platform, turn a failure into a return value". |

## UI stores and use cases (the screens off the SQLite adapter)

Design: the screens needed many small reads and writes, so the core gets **ports grouped by use
case**, not one database interface. All are in `src/core/ports.ts` ("Stores the screens read and
write"); the root builds each from the `services/db` functions and exports it.

| Port (root export) | Holds |
|---|---|
| `ReaderStateStore` (`readerState`) | recordRead, setReadProgress, forceSetReadProgress, getRecentSlugs, getSessions |
| `BookmarkStore` (`bookmarkStore`) | toggleBookmark, isBookmarked, getBookmarks, getBookmarksFull |
| `AnnotationStore` (`annotationStore`) | per-article and all highlights, save/update/delete, re-anchor |
| `LibraryReadStore` (`libraryRead`) | getEntry, getEntryHtml, getEntryPreview, getAllEntries, searchEntries, getLinksTo, indexLinks, getMathSvgMap, getEntryCount(s), clearArticleCache |
| `AppPrefsStore` (`appPrefs`) | first-run prefs, Zotero credentials, sync folder |
| `KeyValueStore` (`metaStore`) | the `meta` table; also what `ThemeProvider` receives as its `store` prop |

The shapes (`Prefs`, `BookmarkRow`, `AnnotationWithTitle`) moved to `src/types.ts` so a port can
name them; `db.ts` still declares identical ones (structural typing) until its own cleanup.

Where a screen did real logic around a call, it is now a use case (plain fakes, no clock or timer;
`src/core/__tests__/uiUseCases.test.ts`, which also compares each against the old inline code):

| Use case (root wrapper) | Replaces |
|---|---|
| `loadArticleForReading` (`loadArticleData`) | ArticleScreen's load: overlap highlight and setting reads with the entry read, download when missing, split highlights valid/stale |
| `reanchorOrphans`, `deleteOrphans` | OrphanedAnnotationsBanner: re-anchor and persist, result message |
| `loadHomeData` | HomeScreen's three-way read |
| `loadReaderSettings` | SettingsScreen's five meta reads and their parsing |
| `autoDeepSyncDue`, `runAutoDeepSync` | the due-date rule inside useBoot's idle task |
| `prepareZoteroSend` | ReadingListScreen: credentials check and highlight read |

Pure rules extracted to `src/utils` (not use cases): `annotationGroups`, `homeLists`,
`zoteroMessage`, `readerSettings`, `entryHash` (same one-line rule as `resolveEntryHash` in
`db.ts`, which this slice may not edit: dedupe when the pure-helper session lands).

Left in place: `getSessions`' `buildTree` (the session tree) still lives in `services/db.ts`
because that file belongs to another session; `ReaderStateStore.getSessions` is a pass-through
until it moves. The `getEntry.callers` guard now lists `core/loadArticle.ts` and the port.
