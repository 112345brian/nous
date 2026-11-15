# Core dependency-injection audit

Status: **findings as of commit time, derived from reading the code** (not run on a
device). Companion to `src/utils/__tests__/innerRing.test.ts`, which enforces the rules
below. The use-case list this audit checks is the draft `docs/use-cases.md` (section 3,
uncommitted in the architecture-review worktree).

Goal: every dependency the core needs is **injected**, never imported or created inside
it, so the core runs and tests with fakes.

## 1. The rings (final)

| Ring | Where | Rule (enforced by `src/utils/__tests__/innerRing.test.ts`) |
|---|---|---|
| Inner (pure) | `src/types.ts`, `src/data/**`, `src/utils/**` | No I/O, no outer-ring imports, no timers, clock or random, no `process.env`, no module-level mutable state, and no React, React Native or Expo import. No exceptions. |
| Core | `src/core/**`: `ports.ts` (interfaces only) and the use cases, which take their ports as parameters | Same rules as the inner ring; `ports.ts` may contain only types. |
| Adapters | `src/services/**` | Implement the ports with the real library (`expo-sqlite`, `fetch`, `expo-file-system`, notifications, the MathJax WebView). May import `src/core`; the core never imports them; they never import the root. |
| Root | `src/composition.ts` | The one place that builds the adapters and hands them to the use cases. Only it value-imports core use cases (rule RC3). |
| UI | `src/screens/**`, `src/components/**`, `src/boot/**`, `src/theme/**`, `src/ui/**`, `App.tsx` | Take stores and use cases from the root, shapes from `src/types.ts`; import **nothing** from `src/services` (rule RC5). |

Before the core existed there was no such split: `catalog.ts` (use-case logic) and `db.ts`
(SQLite) sat side by side in `services/`, and every screen imported both.

## 2. Where each module's dependencies ended up

The first version of this audit listed the hidden dependencies of every module; this is the
outcome. "Core" means the logic is in `src/core` and the module's only remaining job is the
adapter named.

| Was | Now |
|---|---|
| `dataSync.ts` (sync folder, Zotero) | `core/syncUserData.ts`, `core/zotero.ts`; adapters `expoSyncFolder.ts`, `zoteroHttp.ts` |
| `catalog.ts` (index refresh, article caching, bulk download, footnotes, backfills, math completion) | `core/refreshIndex.ts`, `cacheArticle.ts`, `libraryDownload.ts`, `ensureNotes.ts`, `backfills.ts`, `mathCompletion.ts`; `catalog.ts` is the three page fetchers |
| `substitutemath`, the equation cache, the chunked renderer, the priority scheduler | `core/substituteMath.ts`, `mathCache.ts`, `mathChunked.ts`, `mathPacing.ts`, `idleScheduler.ts`; instances built in the root |
| `mathRender.ts` (module-level WebView bridge) | `core/mathBridge.ts` (`createMathBridge`, one instance); `mathRender.ts` loads the MathJax asset |
| `downloadNotification.ts`, `prefetch.ts`, `secureSecrets.ts` | `core/downloadNotifier.ts`, `core/prefetch.ts`, the `SecretStore` port; the platform calls stay in the adapters |
| `seedImport.ts` | `core/seedImport.ts` behind `SeedFiles` and `SeedDatabase`; the adapter keeps the file and connection calls |
| `graphDb.ts`, `inpho.ts` | `core/graph.ts`, `core/graphAssembly.ts`; adapters `graphDb.ts` (SQL) and `inphoSource.ts` (HTTP, dev seeds) |
| Merge rules, migration runner, `buildTree`, `countWords` and other pure helpers in `db.ts` | `core/annotationMerge.ts`, `readsMerge.ts`, `migrations.ts`; `utils/readSessions.ts`, `libraryScope.ts`, `entryHash.ts` |
| Screens calling `services/db` | stores and use cases from the root (`readerState`, `bookmarkStore`, `annotationStore`, `libraryRead`, `appPrefs`, `metaStore`, `loadArticleData`, ...) |
| `utils/motion.ts`, `useBackDismiss.ts`, `utils/sepHtml/render/**` (React Native under `utils/`) | `src/ui/` (`texToSvg.ts`, an in-process MathJax engine, became the adapter `services/texToSvg.ts`; the unused `mathStore.ts` stub was deleted) |
| `utils/linkifier.ts` lazy default instance | the pure factory only; the root holds the lazy instance |
| `utils/perf.ts` default instance, `ThemeProvider` reading `db` | `services/perf.ts` (re-exported by the root); `ThemeProvider` takes a `KeyValueStore` prop |

## 3. Composition root and direction of dependency (final)

`src/composition.ts` builds every adapter once and wires every core use case. What it owns:

- the **math runtime**: the idle scheduler, the pacing helpers, the chunked renderer, the equation
  cache, the substitution and the WebView bridge, each from `src/core`, each given its clock,
  timer, renderer and store here;
- the **use cases**: index refresh, article caching, footnotes, bulk download and sync (under the
  math priority model's download hold), the AST backfill, deferred-math completion, sync-folder
  and Zotero export, seed import, the download notifier, link prefetch, the common-equation
  pre-warm, the graph;
- the **stores the UI reads and writes** (`readerState`, `bookmarkStore`, `annotationStore`,
  `libraryRead`, `appPrefs`, `metaStore`) and the UI use cases built over them;
- the shared instances the UI needs (`idleScheduler`, `withDownloadHold`, `ensureMath`, `perf`).

Direction of dependency, every rule enforced by a test:

| Rule | Check |
|---|---|
| The inner ring and the core import nothing outside themselves, no React, Expo or React Native, call no I/O, timer or clock, keep no module state; no exceptions | `innerRing.test.ts` |
| `ports.ts` contains only types | `innerRing.test.ts` |
| RC2: adapters (`src/services`) never import the root | `compositionRoot.test.ts` |
| RC3: only the root value-imports core use cases. Two recorded exceptions, both in the SQLite adapter (section 8) | `compositionRoot.test.ts` |
| RC4: the UI takes the converted use cases from the root, not from where they used to live | `compositionRoot.test.ts` |
| RC5: no UI, boot, theme or `src/ui` file imports anything from `src/services` (not even a type), and nothing outside the adapters, the core, tests and the root imports `services/db` | `compositionRoot.test.ts` |

Each rule was checked by introducing a deliberate violation and confirming that it fails.

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
| Math render bridge (UC-C6) | `services/mathRender.ts` held `injectFn`, `domReady`, `resolveReady`, `readyPromise`, `mathJaxLoading`, `seq` and `pending` as module variables; `MathRenderWebView` called its exported `_registerInject`/`_onMessage`/`_signalDomReady`; the 20 s / 30 s timeouts used `setTimeout` directly | `core/mathBridge.ts`: `createMathBridge({ loadEngineScript, setTimer, clearTimer })` returns the `MathRenderer` (`render`) plus the host surface (`attach`, `onMessage`, `onDomReady`, `reset`, `preload`, `isAttached`); all state is closure state, timeouts are `READY_TIMEOUT_MS` / `BATCH_TIMEOUT_MS`. `services/mathRender.ts` shrank to `loadMathJaxScript` (asset + file read + snippet). The root builds the one instance, exports `mathWebViewHost`, `preloadMathJax` and `isMathWebViewReady`, and hands `mathRenderer.render` to the chunked renderer. **Hermes spike:** a second `MathRenderer` (`renderMathBatchHermes`), chosen in the root by `EXPO_PUBLIC_MATH_HERMES === '1'`, required lazily so it is not evaluated with the flag off; with it on `preloadMathJax` is a no-op. `MathRenderWebView` and `useBoot` import from the root |
| Footnote backfill (UC-C4) | `catalog.ensureNotesCached` called `fetch` and `./db` | `core/ensureNotes.ts`; wrapped in the root; `referencesNotes` is shared with the article use case |
| Math priority model (from `math-throttle`) | `completeArticleMath(slug, html, priority)`, `watchStalls`, `yieldThenMathMayRun`, `withDownloadHold` wired into `catalog.ts` | re-homed behind the ports: `priority` is an argument of `ArticleMath.substitute` (`null` = the caller owns the schedule) and of `completeArticleMath`; the pause and the stall watch are injected into `createMathCompletion`; the download hold wraps the two bulk wrappers in the root |
| `catalog.ts` | use cases, wiring and adapters in one 590-line file | adapters only (the page fetchers) plus the upgrade-only `backfillMathHashFormat`; nothing in it calls a converted use case, so the root imports it one way and the RC3 exception is gone |

Evidence: `src/services/__tests__/dataSync.test.ts` (14 tests, written before the change
against the old code and **unchanged** afterwards), the linkifier snapshots (taken from
the old code), plus new tests that run the core with plain in-memory fakes and make
`Date.now` and `fetch` throw, to prove the core never reaches for them:
`src/core/__tests__/*.test.ts` (the bridge: `mathBridge.test.ts`, 15 tests with a hand-driven timer; scenarios first run green against the module-level version; mutating the reqId routing is caught by 2 of them), `src/__tests__/mathBridgeWiring.test.ts` (one instance, no state in the adapter, the component and `useBoot` go through the root, the spike plugs in at the root), `src/utils/__tests__/syncPath.test.ts`,
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

**Knowledge graph (graph/InPhO slice).** `services/graphDb.ts` (SQL plus assembly plus lazy schema)
and `services/inpho.ts` (fetch, dev-seed files, TTL, `_primedSlugs`) are split:

| Piece | Where now |
|---|---|
| Ports `GraphSource` (InPhO JSON, dev-seed files), `GraphStore` (graph tables and the joins to `entries`, `reads`, `links`), `GraphArticles` (the preview card's article reads); `KeyValueStore`, `Clock`, `Sleep` reused | `core/ports.ts` |
| Pure assembly: link graph, related / timeline / influence graphs, corpus resolution, edge weights (teacher/student 3, other influence 1.5, times the Wikidata weight), the 7-day relations and 90-day index rules, InPhO payload parsing, the layout key | `core/graphAssembly.ts` |
| Use cases: `ensureInphoIndex`, `getGraph`, `getArticleLinkGraph`, `primeBackfillForSlugs`, `primeGraphLayouts`, `getLayoutCache` / `setLayoutCache`, `getNodePreview`, `getVisitedOnly` / `setVisitedOnly`; `primed` slugs are instance state | `core/graph.ts` (`createGraph`) |
| Graph and layout types | `types.ts` |
| SQL and the graph schema (versioned under scope `graph`; ready-state per connection, in the instance) | `services/graphDb.ts` (`createGraphStore(getDb)`) |
| `fetch` and `expo-file-system` dev seeds | `services/inphoSource.ts` (`inphoSource`); `inpho.ts` is deleted |
| Wiring | `composition.ts`, "Knowledge graph" section |

`GraphScreen` now imports nothing from `services/` (it left the RC5 allowlist): its preview card, which
read the article rows and held `findLinkSentence` inside the component, is `getNodePreview` (with
`utils/linkSentence.ts`), and its "visited only" preference is `getVisitedOnly` / `setVisitedOnly`.
`getGraphData` (the global link graph) had no caller and was deleted. A side effect of assembling in the
core: the InPhO builders read the entries they need in one query instead of scanning every entry with
progress above zero.
Tests: `src/services/__tests__/graph.characterization.test.ts` (35 tests, written against the old
modules first and unchanged after the move except for where `api()` finds the functions) and
`src/core/__tests__/graph.test.ts` (24 tests with in-memory fakes; `Date.now`, `setTimeout` and `fetch`
throw). Mutations caught: relations TTL `>` to `>=` (3 tests), teacher/student weight 3 to 2 (2 tests).

Enforcement added to `innerRing.test.ts`: `src/core` is in the ring; it also fails on
`process.*`, a bare `Date()`, module-level `let`/`var`, and an empty module-level
`new Map/Set/WeakMap/WeakSet`; `ports.ts` must contain only types; recorded exceptions
must still match a real violation, so they cannot go stale.

## 5. Order of work (all done)

The conversions this section used to queue are done, in this order: refresh index, article
caching, deferred-math completion, composition root, bulk download and sync, backfills,
footnotes, the equation runtime, the math render bridge, graph and InPhO, seed import,
notification, prefetch and secrets, the UI off the SQLite adapter, and the pure logic out of
`db.ts` and the services. Section 4 records each; section 8 lists what is left and why.

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
- **Fixed (test flipped in `refreshIndex.test.ts`):** after an offline
  first launch the bundled seed is stamped as a successful refresh
  (`index_refreshed_at = now`), so the app will not fetch the real index again for a week.
  The seed has no `parent_label`, so until then the browse list has no parent grouping and
  the link index is built from seed titles only. The time is no longer stamped when the
  entries came from the seed, so the next launch fetches the real index.
- **Fixed (test flipped in `refreshIndex.test.ts`, new cases in `core/__tests__/refreshIndex.test.ts`):**
  a non-numeric `index_refreshed_at` value was treated as fresh forever (`now - NaN > interval`
  is false), unless the library was empty. A value that is not a finite number now counts as
  stale; negative values were already stale, and future or recent timestamps stay fresh.
- **Fixed (new test in `fetchAndCache.test.ts`):** the 30 s abort timer in the article request is
  cleared as soon as the response headers arrive (`finally { clearTimeout }`), before the body
  is read. A connection that stalls mid-body is therefore never aborted, and the call (and the
  article screen waiting on it) can hang. The timer is now cleared only after `res.text()` resolves (article and notes requests).
- **Hazard removed:** `completeArticleMath` and `substitutemath` shared one global-flag regex
  (`MATH_SUBST_RE`) and each had to reset `lastIndex = 0` before use; forgetting that in
  either makes `test`/`exec` skip matches. The completion side now uses the stateless
  `hasTexSpan`; `substituteMath` now builds a fresh regex per call. (With `exec` in a loop the shared
  regex was harmless in practice, since the loop runs to `null`, which resets it; only the `.test()`
  use could leak state.)
- **Behaviour to know (pinned):** `completeArticleMath(slug, html)` returns the in-flight
  promise for that slug even if called with a different `html`, and a completion that finds no
  TeX left in an unchanged article counts as done and notifies listeners.
- **Fixed (tests flipped in `downloadSync.test.ts`):** in both `downloadAll` and
  `syncCachedArticles` an article that fails to download is counted as done (the result of the
  fetch is never inspected), so progress reaches 100% even if everything failed. Worse,
  `syncCachedArticles` then records `last_deep_sync`, which `App.tsx` uses to decide when to
  sync next, so a sync run offline marks the library as freshly synced and the next auto-sync
  waits two to seven days. Now only successes count, and `last_deep_sync` is recorded unless every article
  failed.
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

## 8. The known remainder: what is still outside the core, and why

Everything above is in `src/core` or is an adapter. These are the things that remain, with the
reason each cannot (or should not) move.

**Adapters with their own state.** An adapter is allowed to be concrete and to hold state about
the thing it wraps. What is left:

| Where | State | Why it stays |
|---|---|---|
| `services/db.ts` (`createDb`) | the one connection (`_open`, `_closing`), `metaCache`, `_linkCache`: **instance state**, no module state | It is the SQLite adapter. The root builds the one instance and passes `getDb`/`closeDb` to `graphDb` and the seed import. |
| `services/texToSvg.ts` | the lazily built MathJax document (`_doc`, `_adaptor`, `_initError`) | The in-process MathJax engine behind the flagged Hermes spike: a lazily initialised engine is what an adapter is. |
| `services/secureSecrets.ts` | the lazily required `expo-secure-store` module (`mod`) | It throws at import when the native module is not linked, so the `require` must stay lazy. |

**No exceptions to RC3.** `services/db.ts` is `createDb(deps)`: the migration runner, the merge
rules, the clock, the uid source, the secure store and the bundled link map are parameters, and
`composition.ts` supplies them. `services/graphDb.ts` and the seed import receive their connection
(and, for graphDb, the migration runner) from the root. `services/migrations.ts` is gone and
`WIRING_EXCEPTIONS` is empty. Tests build an instance with `services/__tests__/helpers/testDb.ts`;
tests that fake the module wrap their fake in `helpers/mockDbModule.ts`.

**Left alone on purpose.**

- `scripts/test-download.mjs`, `scripts/buildEntrySeed.js` and `scripts/auditCorpus.cjs` carry
  their own copies of the page-extraction helpers (now canonical in `src/utils/sepPage.ts`).
  They are build scripts run by plain node, which cannot import the TypeScript, so the copies
  stay; `scriptHelpersDrift.test.ts` runs each copy against the canonical on the same inputs and
  fails when one drifts (it found, and the change fixed, a `test-download.mjs` copy that did not
  decode numeric or named entities).
- `origin/new-spinner`, an older unrelated UI feature (an animated logo), was not merged.
- Still open from section 7: the `~` sync-folder expansion needs a device check. The bugs the
  earlier pass left pinned, including the non-numeric `index_refreshed_at`, are fixed (see section 7).

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
| `secureSecrets.ts`: lazy module `mod` | `SecretStore` port in `core/ports.ts`; `secureSecretStore` adapter | The lazy `require` of `expo-secure-store` (it throws at import when unlinked). `db.ts` now takes the secure store as a dependency from the root. There is no logic worth a core module: every function is "call the platform, turn a failure into a return value". |

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

`getSessions`' `buildTree` (the session tree) now lives in `utils/readSessions.ts`; `ReaderStateStore.getSessions` is a pass-through to `db.ts`, which calls it. The `getEntry.callers` guard now lists `core/loadArticle.ts` and the port.

### db-pure-logic slice (merge, migrations, db.ts helpers)

| Moved | To | Notes |
|---|---|---|
| `mergeAnnotation`, `ImportedAnnotation` | `core/annotationMerge.ts` | Takes `SqlRunner` (new port in `ports.ts`) and `MergeDeps` (`Clock` + `newUid`); the adapter supplies `Date.now` and the `Math.random` uid generator (`newUid` now lives in `db.ts`). |
| `mergeRead`, `ImportedRead` | `core/readsMerge.ts` | `READS_UNIQUE_INDEX_SQL` is schema data and now sits in `services/coreMigrations.ts`. |
| `runMigrations`, `userVersionStore`, `tableVersionStore`, `Migration`, `VersionStore` | `core/migrations.ts` | Database is the `MigrationDb` port. The old `services/migrations.ts` re-export is deleted; `graphDb` gets the runner from the root. |
| `buildTree`, session grouping, 30-minute session rule | `utils/readSessions.ts` | `getSessions` / `recordRead` call them. |
| `scopeFilter`, `countWords` | `utils/libraryScope.ts` | |
| `resolveEntryHash` | `utils/contentHash.ts` | Still re-exported from `db.ts` (ArticleScreen imports it there). |

Left in `db.ts` on purpose: `_open`/`_closing` (the one shared connection and its open/close handshake: it is the adapter's state, and `seedImport` closes it through `closeDb`); `metaCache` (a read-through cache of the `meta` table that must stay in step with every direct write in the same file); `_linkCache` (same, for the link index; the fallback to the bundled asset is a dynamic import, which the core may not do). `db.ts` also stays the one place that calls `runMigrations` and the merges, hence the RC3 exception.
