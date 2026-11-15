# Nous — Use Cases

Status: **draft, derived from reading the code on 2026-11-14; statuses updated after the fixes merged the same day**, not from a product
owner. Each entry says what the app does today. Where code and README disagree,
the code is described and the disagreement is listed at the bottom. Review this
file, correct it, and treat it as the source of truth for the application layer.

## Why this file exists

In a clean architecture each row below becomes **one use case** (an interactor or
application service) in the application ring. A use case:

- is named for what the *reader* achieves, not for a screen or a table;
- takes plain inputs and returns plain outputs (no React, no SQL, no `fetch`);
- reaches the outside world only through the **ports** listed in section 3.

Screens call use cases. Use cases call ports. Adapters (`expo-sqlite`, `fetch`,
the WebView math renderer, the file system, notifications) implement the ports.
Today most screens call `src/services/db.ts` and `catalog.ts` directly, so the
"Code today" column shows where each use case currently lives, scattered.

Hard constraint on every use case that touches content: SEP article text and
InPhO data are fetched on the device at runtime and are never bundled or hosted
by us (`AGENTS.md`, `NOTICE.md`).

## 1. Actors and external systems

| Name | Role |
|---|---|
| Reader | The only human actor. |
| SEP site (`plato.stanford.edu`) | Source of the entry index, articles and `notes.html` footnotes. |
| InPhO | Source of the semantic graph and thinker dates (fetched per client). |
| Zotero API | Optional export target for bookmarks and annotations. |
| Sync folder | A user-chosen folder where a user-data JSON file is written and read. |
| OS | Download-progress notifications and the share sheet. |

## 2. Use cases

Status column: **ok** = implemented as described; **gap** = known defect or
missing behavior, see section 4.

### A. Start the app

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-A1 | Complete first-run onboarding | Choose the home mode, library scope, whether to download everything, and an optional seed URL; mark onboarding done. | `OnboardingScreen`, `App.handleOnboardingDone`, `getMeta`/`setMeta`, `savePrefs` | ok |
| UC-A2 | Seed the library from a URL | Replace the local database with a downloaded one (first run or from Settings). The onboarding code already saves prefs only after the import, because the import replaces the whole file. | `seedImport.importSeedFromUrl`, `closeDb` | ok (user data is exported before the swap, restored after, rolled back on failure) |
| UC-A3 | Build or refresh the entry index | If empty or stale (weekly), fetch `contents.html`, upsert entries, rebuild search and link index. | `catalog.refreshIndexIfStale`, `upsertIndexEntries` | ok |
| UC-A4 | Run background maintenance | Backfill ASTs and math, sync cached articles, prime graph layouts, only when nothing higher-priority is happening (reading, scrolling, downloading; see `docs/math-throttling.md`). | `backfillAst`, `backfillMath*`, `syncCachedArticles`, `primeGraphLayouts` | ok (being moved to an idle scheduler) |

### B. Find something to read

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-B1 | Browse the library | Alphabetical list with a letter index. | `HomeScreen`, `searchEntries('')` | ok |
| UC-B2 | Search entry titles | Prefix search over titles, ranked. | `db.searchEntries`, `utils/ftsQuery.buildFtsQuery` (FTS5 on slug and title) | ok (title-only by design; quotes and punctuation in the query are escaped) |
| UC-B3 | Resume reading | Jump to the most recent article, see recents. | `HomeScreen` (`getRecentSlugs`) | ok |
| UC-B4 | See related articles | From an article, show backlinks and outgoing links. | `getLinksTo`, `getLinksFrom`, `indexLinks` | ok |

### C. Read an article

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-C1 | Open an article | Show the cached copy; if absent, fetch, process and cache it, then show it. Record the read. | `ArticleScreen.load`, `fetchAndCacheArticle`, `getEntry`, `recordRead` | ok (slow first open) |
| UC-C2 | Read with remembered position | Save scroll progress; restore it on reopen. | `setReadProgress`, `forceSetReadProgress` | ok |
| UC-C3 | Jump within an article | Use the table of contents or an anchor link. | `TocSheet`, `parseToc`, `handleTocJump` | ok (TOC jumps and the scroll-spy go by block index; unverified on a device) |
| UC-C4 | Read a footnote | Tap a note marker to see its text in a sheet. | `FootnoteSheet`, `ensureNotesCached`, `fetchNotesHtml` | ok |
| UC-C5 | Follow a link to another entry | Tapping an SEP link opens that entry; external links open the browser. | `handleNativeLink`, `linkifier` | ok |
| UC-C6 | Read equations | TeX is rendered to SVG on the device, cached by hash, shown inline. | `mathRender`, `substitutemath`, `putMath`, `getMathSvgMap` | ok |
| UC-C7 | Refresh an article | Re-fetch and replace the cached copy, keeping version history. | `load(forceRefetch)`, `cacheArticle`, `article_versions` | ok |
| UC-C8 | Share or cite an article | Produce a citation string and open the share sheet. | `formatCitation`, `handleShare` | ok |

### D. Annotate

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-D1 | Highlight and note a passage | Select text, choose a color, optionally add a note. | `AnnotationModal`, `saveAnnotation`, `annotationJs` | ok |
| UC-D2 | Edit or delete an annotation | Change note or color; remove it. | `updateAnnotation`, `deleteAnnotation` | ok |
| UC-D3 | Review all annotations | List annotations across articles and open the source. | `AnnotationsScreen`, `getAllAnnotations` | ok |
| UC-D4 | Repair orphaned annotations | When an article changed, re-anchor annotations or delete the unmatched ones. | `OrphanedAnnotationsBanner`, `reanchor`, `updateAnnotationAnchor`, `deleteAnnotations` | ok |

### E. Keep and revisit

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-E1 | Bookmark an article | Toggle a bookmark, with an optional note. | `toggleBookmark`, `updateBookmarkNotes`, `isBookmarked` | ok |
| UC-E2 | Manage the reading list | List, open, remove, share a citation for bookmarks. | `ReadingListScreen`, `getBookmarksFull` | ok |
| UC-E3 | Review reading history | Sessions shown as branching trees of how the reader moved between articles. | `HistoryScreen`, `getSessions`, `buildTree` | ok |
| UC-E4 | Export to Zotero | Send a bookmark and its annotations, one item per article version. | `dataSync.exportToZotero` | ok |

### F. Explore the graph

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-F1 | Explore the semantic graph | Zoomable graph of related entries; optionally only visited ones; open a node. | `GraphScreen`, `graphDb`, `inpho`, `forceLayout` | ok |
| UC-F2 | See an influence timeline | Thinker dates and relations around an entry. | `inpho`, `graphDb` (dates backfill) | ok |

### G. Offline library

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-G1 | Download the library | Download all uncached articles for the chosen scope, with progress, notification and cancel. | `catalog.downloadAll`, `downloadNotification` | ok (downloaded math articles are queued on `math_pending` and rendered at low priority; unverified on a device) |
| UC-G2 | Keep cached articles current | Periodic or manual deep sync of cached articles. | `syncCachedArticles` | ok |
| UC-G3 | Free storage | Clear the article cache. | `clearArticleCache` | ok |
| UC-G4 | Choose library scope | SEP only, OWL only or both. | `getPrefs`/`savePrefs`, `getSlugsByCacheStatus` | ok |

### H. Settings and data portability

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-H1 | Tune the reading experience | Font size, custom CSS, launch screen, light or dark appearance. | `SettingsScreen`, `readerCss`, `savePrefs`, `theme/ThemeProvider` (appearance: Auto, Light or Dark) | ok |
| UC-H2 | Configure Zotero | Store user id and API key. | `saveZoteroPrefs`, `getZoteroPrefs`, `secureSecrets` (the API key lives in secure storage) | ok |
| UC-H3 | Export user data to the sync folder | Write reads, bookmarks, annotations and prefs to `sep_user.json` in the folder the reader typed in. | `SettingsScreen.handleExport`, `dataSync.exportToSyncFolder`, `exportUserData` | ok (explicit allowlist; secrets are never exported) |
| UC-H4 | Import user data from the sync folder | Read that file and merge it into the local data (`handleImport` and `handleSyncNow` use the same path). | `SettingsScreen.handleImport`, `dataSync.importFromSyncFolder`, `importUserData` | ok |
| UC-H5 | Choose auto-sync | Pick when the sync folder is synced automatically. | `SettingsScreen.setAutoSyncPref`, `handleSyncNow` | ok (behavior not verified) |

## 3. Ports the use cases need

These are the outbound interfaces, as they exist in `src/core/ports.ts`. Each use case in
`src/core` takes the ports it needs as a parameter and never imports an adapter; the adapters
live in `src/services`, and `src/composition.ts` is the one place that builds them and hands
them over. Screens and `src/boot` import the wired use cases from `composition.ts`.
(`docs/core-di-audit.md` has the audit behind this list and what is still outside the core.)

| Port (in `src/core/ports.ts`) | Used by | Implemented by (adapter) |
|---|---|---|
| `ArticleSource` (`fetchIndexHtml`, `fetchArticleHtml`, `fetchNotesHtml`) | A3, C1, C4, C7, G2 | `services/catalog.ts` (`fetch`, 30 s abort) |
| `LibraryIndexStore` (count, upsert entries, clean titles, all titles, invalidate link cache) | A3 | `services/db.ts` |
| `ArticleLibrary` (`cacheArticle`, `indexLinks`) | C1, C7, G1, G2 | `services/db.ts` |
| `NotesStore` (`setEntryNotes`) | C4 | `services/db.ts` |
| `ArticleMathStore` (read and rewrite an article's body, store its AST) | C6 | `services/db.ts` |
| `ArticleMath` (`substitute`: render now; `completeLater`: render in the background; `queueForLater`: record the debt only) | C1, C6, G1, G2 | `services/catalog.ts` (`substitutemath`) plus the pipeline in `core/mathCompletion.ts` |
| `LibraryCacheStatus` (cached and uncached entries) | G1, G2 | `services/db.ts` |
| `LibraryBackfillStore` (articles with no AST) | A4 | `services/db.ts` |
| `KeyValueStore` (`getMeta`, `setMeta`: stamps, flags, the pending-math list) | A3, A4, C6, G2 | `services/db.ts` (`meta` table) |
| `UserDataStore<T>` and `SyncFolder` (read and write the user-data file) | H3, H4 | `services/db.ts` and `services/expoSyncFolder.ts` (`expo-file-system`) |
| `ZoteroHttp` (`post`) | E4 | `services/zoteroHttp.ts` (`fetch`) |
| `StageTimer` (dev-only stage timing) | C1 | `services/perf.ts` |
| `Clock`, `Sleep` | A3, E4, G1, G2 | `Date.now` and a timer, supplied by the root |
| the pre-warm's own deps (`PrewarmDeps`, in `core/prewarmCommonMath.ts`) | A4 (common equations) | the root, from `mathCache.ensureMath` at background priority, the `meta` table and the idle scheduler |

Not behind a port yet, and why:

- **Math rendering itself** (the hidden WebView, the equation cache, the priority scheduler) is an
  adapter with its own state. The core sees it only as the injected `substitute` and `pause`
  functions.
- **`GraphSource` / `GraphStore`** (F): `inpho.ts` and `graphDb.ts` are still called directly.
- **`SecretStore`** (H2, E4): the Zotero key now lives in secure storage (`services/secureSecrets.ts`)
  and reaches the use case as a parameter; there is no port because nothing else needs one.
- **`ProgressNotifier`** (G1): progress reaches the caller as a callback and the download
  notification is connected in `src/boot/useBoot.ts`.
- **`Scheduler`**: the idle scheduler is used through `pause` and by the root, not by the core.

`LibraryStore` and `UserStore` are one SQLite file today. Splitting them (content
is replaceable, user data never is) is the clean boundary. The seed-import fix works around the shared file by exporting and restoring user data; splitting the file would remove the need.

## 4. Gaps

Fixed since the first draft of this file (see git history for the commits):

- **Seed import erased user data** (was UC-A2). The import now exports reads,
  bookmarks, annotations and settings first, restores them into the new database,
  and puts the old database back if anything fails.
- **Zotero API key in the export** (was UC-H2, UC-H3). The export is an explicit
  allowlist of preference keys, and the API key is kept in secure storage.
- **Search crashed on a double quote** (UC-B2). Words are now quoted and embedded
  quotes escaped (`src/utils/ftsQuery.ts`, tested against the real FTS5 engine).

Also fixed (merged the same day, **not yet checked on a device**):

- **Math after a bulk download or prefetch** (UC-G1, UC-C1). Articles cached without
  rendering math are queued on the `math_pending` list and rendered by the idle
  scheduler at low priority; the one-shot backfill flag is gone.
- **TOC taps** (UC-C3). Jumps and the active-section tracking use the block index
  instead of cell-relative offsets.

Still open:

1. **UC-B2:** search covers entry titles only. That is a product limit, not a bug,
   and the README now says so.
2. **Not behind use cases yet:** nine screens and components still read and write
   through `services/db.ts` directly (the list is in `docs/core-di-audit.md`), and
   the graph (F) is called directly. The core covers fetching, caching, sync,
   downloads, math and the backfills.
3. **Home screen:** the old "Continue reading" section no longer exists (the Reading
   tab shows Bookmarks and Recent). If that was unintended, it is a regression.

## 5. README versus code

The README was corrected on the same day (title search, on-device math, iOS
target note, appearance setting). No known disagreements remain; when you change a
behavior listed in section 2, update the README line that describes it.

## 6. Out of scope

`blind-design/design-rationale.md` describes a different product (a wiki with
editing, page creation and history). Nothing in Nous implements editing or page
creation, so those flows are not use cases here.

## Keeping this file honest

When you add a screen or a service function that does something new for the
reader, add a row here first. If a screen reads or writes data that no row
explains, that is the sign a use case is missing, or that the screen is doing
something it should not.
