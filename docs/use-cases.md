# Nous — Use Cases

Status: **draft, derived from reading the code on 2026-11-14**, not from a product
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
| UC-A2 | Seed the library from a URL | Replace the local database with a downloaded one (first run or from Settings). The onboarding code already saves prefs only after the import, because the import replaces the whole file. | `seedImport.importSeedFromUrl`, `closeDb` | **gap** (can erase user data) |
| UC-A3 | Build or refresh the entry index | If empty or stale (weekly), fetch `contents.html`, upsert entries, rebuild search and link index. | `catalog.refreshIndexIfStale`, `upsertIndexEntries` | ok |
| UC-A4 | Run background maintenance | Backfill ASTs and math, sync cached articles, prime graph layouts, without blocking reading. | `backfillAst`, `backfillMath*`, `syncCachedArticles`, `primeGraphLayouts` | ok (being moved to an idle scheduler) |

### B. Find something to read

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-B1 | Browse the library | Alphabetical list with a letter index. | `HomeScreen`, `searchEntries('')` | ok |
| UC-B2 | Search entry titles | Prefix search over titles, ranked. | `db.searchEntries` (FTS5 on slug and title) | **gap** (title-only; README says full-text) |
| UC-B3 | Resume reading | Jump to the most recent article, see recents. | `HomeScreen` (`getRecentSlugs`) | ok |
| UC-B4 | See related articles | From an article, show backlinks and outgoing links. | `getLinksTo`, `getLinksFrom`, `indexLinks` | ok |

### C. Read an article

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-C1 | Open an article | Show the cached copy; if absent, fetch, process and cache it, then show it. Record the read. | `ArticleScreen.load`, `fetchAndCacheArticle`, `getEntry`, `recordRead` | ok (slow first open) |
| UC-C2 | Read with remembered position | Save scroll progress; restore it on reopen. | `setReadProgress`, `forceSetReadProgress` | ok |
| UC-C3 | Jump within an article | Use the table of contents or an anchor link. | `TocSheet`, `parseToc`, `handleTocJump` | ok |
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
| UC-G1 | Download the library | Download all uncached articles for the chosen scope, with progress, notification and cancel. | `catalog.downloadAll`, `downloadNotification` | ok |
| UC-G2 | Keep cached articles current | Periodic or manual deep sync of cached articles. | `syncCachedArticles` | ok |
| UC-G3 | Free storage | Clear the article cache. | `clearArticleCache` | ok |
| UC-G4 | Choose library scope | SEP only, OWL only or both. | `getPrefs`/`savePrefs`, `getSlugsByCacheStatus` | ok |

### H. Settings and data portability

| ID | Use case | Summary | Code today | Status |
|---|---|---|---|---|
| UC-H1 | Tune the reading experience | Font size, custom CSS, launch screen. | `SettingsScreen`, `readerCss`, `savePrefs` | ok |
| UC-H2 | Configure Zotero | Store user id and API key. | `saveZoteroPrefs`, `getZoteroPrefs` | **gap** (key kept in `meta`) |
| UC-H3 | Export user data to the sync folder | Write reads, bookmarks, annotations and prefs to `sep_user.json` in the folder the reader typed in. | `SettingsScreen.handleExport`, `dataSync.exportToSyncFolder`, `exportUserData` | **gap** (export includes secrets) |
| UC-H4 | Import user data from the sync folder | Read that file and merge it into the local data (`handleImport` and `handleSyncNow` use the same path). | `SettingsScreen.handleImport`, `dataSync.importFromSyncFolder`, `importUserData` | ok |
| UC-H5 | Choose auto-sync | Pick when the sync folder is synced automatically. | `SettingsScreen.setAutoSyncPref`, `handleSyncNow` | ok (behavior not verified) |

## 3. Ports the use cases need

These are the outbound interfaces to define. Each is currently a direct import of a
concrete library or module.

| Port | Used by | Implemented today by |
|---|---|---|
| `ArticleSource` (fetch index, article, notes) | A3, C1, C4, C7, G1, G2 | `fetch` in `catalog.ts` |
| `MathRenderer` (TeX to SVG batch) | C1, C6 | hidden MathJax WebView (`mathRender.ts`, `MathRenderWebView`) |
| `LibraryStore` (entries, search, links, versions) | A, B, C, G | `db.ts` (`expo-sqlite`) |
| `UserStore` (reads, bookmarks, annotations, prefs) | C2, D, E, H | `db.ts` (same file as `LibraryStore`) |
| `SecretStore` (API keys) | H2, E4 | none; `meta` table today |
| `GraphSource` / `GraphStore` | F | `inpho.ts`, `graphDb.ts` |
| `ZoteroClient` | E4 | `fetch` in `dataSync.ts` |
| `SyncFolder` (read/write user-data file) | H3, H4, H5 | `expo-file-system` in `dataSync.ts` |
| `ProgressNotifier` | G1 | `downloadNotification.ts` |
| `Clock`, `Scheduler` (idle work) | A4, G2 | `Date.now`, timers, `InteractionManager` |

`LibraryStore` and `UserStore` are one SQLite file today. Splitting them (content
is replaceable, user data never is) is the clean boundary and removes the A2 gap.

## 4. Known gaps behind the "gap" markers

1. **UC-A2:** the seed import deletes `sep.db`, which also holds bookmarks,
   annotations, reads and prefs. No caller exports and restores user data around
   it. Reproduction test pending.
2. **UC-B2:** `entries_fts` indexes `slug` and `title` only, so search is a title
   prefix search, not full-text. The search query also wraps each word in quotes
   without escaping embedded quotes, so a `"` in the query can produce an invalid
   FTS expression (untested).
3. **UC-H2, UC-H3:** `exportUserData` exports every `meta` row except
   `onboarding_done`, including the Zotero API key, into the sync-folder file.

## 5. README versus code

| README says | Code does |
|---|---|
| "Full-text search across all ~1,800 SEP articles" | Title-only search (see UC-B2). |
| "Math: MathJax 3 (server-side SVG, cached in SQLite)" | Rendered on the device in a hidden WebView, then cached. |
| "A philosophy reader app for Android and macOS" | An `ios/` target is also checked in; CI builds Android only. |

## 6. Out of scope

`blind-design/design-rationale.md` describes a different product (a wiki with
editing, page creation and history). Nothing in Nous implements editing or page
creation, so those flows are not use cases here.

## Keeping this file honest

When you add a screen or a service function that does something new for the
reader, add a row here first. If a screen reads or writes data that no row
explains, that is the sign a use case is missing, or that the screen is doing
something it should not.
