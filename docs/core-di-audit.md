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
| `services/catalog.ts` | none left in the converted flows; `MATH_SUBST_RE` (a global-flag regex, so `lastIndex` state) remains for `substitutemath` | `./db` (about 20 functions), `./mathRender`, bundled `assets/entry-seed.json`, `fetch` x3 (index page, article page, notes page), `./perf` | `Date.now`, `setTimeout` (throttle sleeps, the 30 s abort), `AbortController` | `ArticleSource`, `ArticleLibrary`, `ArticleMath`, `ArticleMathStore`, `KeyValueStore`, `LibraryIndexStore`, `StageTimer`, `Clock`, `Sleep` | `refreshIndexIfStale`, `fetchAndCacheArticle` and the math-completion state machine **converted** (section 4); `substitutemath`, the backfills, downloads and sync are listed (section 5) |
| `services/db.ts` | `_db` (connection), `metaCache`, `_linkCache` | `expo-sqlite` | `Date.now` x7 | it **is** the `LibraryStore` / `UserStore` / `KeyValueStore` adapter; nothing to inject into it | Listed; 4 sessions editing it |
| `services/graphDb.ts` | `_schema` (creates its own tables lazily) | `getDb()` x4 from `./db` | `Date.now` x4 | `GraphStore` adapter; the graph assembly (nodes/edges from rows) is pure and could move inward | Listed |
| `services/inpho.ts` | `_primedSlugs` (Set) | `fetch` (`getJson`), `expo-file-system` (dev-seed files, `__DEV__` only), `getMeta/setMeta` from `./db` | `Date.now` x2, `setTimeout` x1 | `GraphSource`, `KeyValueStore`, `Clock`, `Sleep` | Listed |
| `services/mathRender.ts` | 7 module variables (`injectFn`, `domReady`, `resolveReady`, `readyPromise`, `mathJaxLoading`, `seq`, `pending`) forming a bridge to the WebView component | `expo-asset`, `expo-file-system` | `setTimeout` (timeout race) | `MathRenderer` (batch **and** readiness lifecycle) | Listed |
| `services/downloadNotification.ts` | `state` (throttle bookkeeping) | `react-native` `NativeModules`/`Platform`, `expo-notifications` | `Date.now` x1, `setTimeout` x2 | `ProgressNotifier` adapter | Already injected into the core (see section 3) |
| `services/seedImport.ts` | none | `expo-file-system` (+ `/legacy`), dynamic `import('./db')` to call `closeDb` | none | `SeedInstaller` (download, close DB, replace file) | Not touched: `db-seed-import-safety` is rewriting it |
| `screens/*`, `App.tsx` | n/a (UI) | 9 files import `services/db` as a value (tracked by a shrink-only test) | `InteractionManager` (ArticleScreen only), `Date.now` (HistoryScreen, ArticleScreen `updated_at`, App auto-sync interval), `setTimeout` (UI debounces) | wired use cases | Listed |

Not hidden dependencies (deliberately allowed): `atob`/`btoa` (pure, deterministic; used in
`utils/sepHtml/parse.ts`), seeded constant tables (`new Set([...])`), `Math`, `JSON`.

## 3. Composition root and direction of dependency

**`src/composition.ts` is the composition root** (added after the first version of this audit,
which found none). It builds the concrete adapters and hands them to the core use cases;
screens and `App.tsx` import the converted use cases from it. What it owns and what it does
not yet:

- **Wired in the root:** sync-folder export/import and Zotero export (adapters:
  `services/expoSyncFolder.ts`, `services/zoteroHttp.ts`; the user-data store is a small object
  over `services/db`; platform and home directory are read here, at the edge), and
  `downloadAll` / `syncCachedArticles`, built from the re-exported use cases below plus the
  library queries and a timer-backed `sleep`.
- **Re-exported from `services/catalog.ts`:** `refreshIndexIfStale`, `fetchAndCacheArticle`,
  `onMathReady`, `completeArticleMath`, `resumePendingMath`. `catalog.ts` still wires these
  itself, because the one remaining caller inside it, `backfillMathInline`, calls
  `resumePendingMath` from the math-completion instance created there. Moving that wiring into
  the root first would make `catalog.ts` and `composition.ts` import each other. Once that
  backfill is converted (or removed by `delete-legacy-compat`), the wiring moves and the
  re-export becomes real code. Callers already import from the root, so nothing changes for them.
- `App.tsx` still wires the download progress callback to the download notifier and calls
  `preloadMathJax()` itself.
- `components/MathRenderWebView.tsx` still registers itself into a module-level bridge in
  `services/mathRender.ts` (`_registerInject`, `_onMessage`, `_signalDomReady`).
- Nine files outside the services still import the SQLite adapter (`services/db`) as a value:
  `App.tsx`, `ArticleScreen`, `HomeScreen`, `GraphScreen`, `HistoryScreen`, `SettingsScreen`,
  `ReadingListScreen`, `AnnotationsScreen` and `OrphanedAnnotationsBanner`.
  (`OnboardingScreen` imports only the `Prefs` type; the first version of this audit counted
  it, and a test caught the mistake.)

Direction of dependency, all enforced by tests (`innerRing.test.ts`, `compositionRoot.test.ts`):

| Rule | Check |
|---|---|
| Inner ring and core never import outer code, or the root | `innerRing.test.ts` |
| Adapters (`src/services/*`) never import the root | RC2 |
| Only `composition.ts` wires core use cases (one recorded exception: `services/catalog.ts`, see above; it fails if the exception goes stale) | RC3 |
| Screens, components and `App.tsx` take the converted use cases from the root, not from `catalog`/`dataSync` | RC4 |
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
2b. ~~The deferred-math completion state machine~~: **done**, see section 4. What is left of
   the subsystem is `substitutemath` (render the equations, store the SVGs, rewrite the
   HTML) and its renderer: it needs a `MathRenderer` (the WebView bridge in `mathRender.ts`,
   six module variables) and a `MathStore` (`putMathBatch`). **Blocked on the `tiered-math`
   branch**, which rewrites `substitutemath` (it renders trivially simple TeX as styled text
   and adds `utils/mathTier.ts`). Converting it now would turn that branch's change into a
   delete-versus-modify conflict, so it was left in place and injected. Do it right after
   `tiered-math` merges. `backfillMathHashFormat` and `backfillMathInline` belong with it
   (the second calls `resumePendingMath`); `delete-legacy-compat` may remove them first.
3. ~~`downloadAll` / `syncCachedArticles`~~ (UC-G1, G2): **done**, see section 4. What is left of
   this item is the backfills (UC-A4): `backfillAst`, `backfillMathHashFormat`,
   `backfillMathInline`. `backfillMathInline` is the last thing in `catalog.ts` that calls a
   converted use case (`resumePendingMath`) and so the last blocker for moving the catalog wiring
   into the root. The `math-throttle` session is working on it and `delete-legacy-compat` may remove
   it, so wait for both. The overlap with the idle scheduler (`Scheduler`) is in `App.tsx`, not here.
4. **Auto-sync decision in `App.tsx`** (lines ~166-171): a duplicated staleness rule
   (`Date.now() - last > days`), same shape as `refreshIndexIfStale` and the InPhO TTL in
   `inpho.ensureInphoIndex`. Extract one pure `isStale(now, last, ttl)` into `utils` and
   use it in all three.
5. **Graph assembly in `graphDb.ts`** (UC-F1, F2). Turning rows into nodes and edges is pure
   and is a large part of the 474-line file; move it inward and leave SQL in the adapter. Also consider moving
   the `_schema` table creation into the migration code (`db-connection-migrations`).
6. **`inpho.ts`** (UC-F). `fetch` plus `getMeta/setMeta` plus the TTL: ports `GraphSource`,
   `KeyValueStore`, `Clock`; the dev-seed file reading is a `__DEV__`-only adapter.
7. **`mathRender.ts`**. The module-level bridge to the WebView component is the only
   global-mutable coupling between a component and a service. Replace the six variables
   with one object created by the composition root and passed to both sides.
8. **`seedImport.ts`** (UC-A2). Wait for `db-seed-import-safety`.
9. ~~The composition root~~: **started**, see sections 3 and 4. Next: (a) when `downloadAll`,
   `syncCachedArticles` and the backfills are converted, move the catalog wiring into the root
   and delete the exception in RC3; (b) migrate the nine files that import `services/db` to
   wired use cases one at a time, removing each from the RC5 allowlist as it goes.
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
  `hasTexSpan`; `substitutemath` still has the shared regex until it is converted.
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
- **Minor (pinned):** `downloadAll` also pauses 100 ms after the last group, which delays the
  end of the download for nothing.
- **Dead work removed:** `fetchAndCacheArticle` computed `extractTitle(html)` and never used it
  (the title comes from the index). The conversion drops it, which also clears one lint error.
- `scripts/test-download.mjs`, `scripts/buildEntrySeed.js` and `scripts/auditCorpus.cjs`
  carry their own copies of `extractById`, `decodeEntities` and friends (now canonical in
  `src/utils/sepPage.ts`). They can drift.
