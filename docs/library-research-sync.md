# Library research: user-data sync and Zotero export

**Checked:** 2026-11-14 · **Recheck by:** 2027-02-14 (versions, release dates and Expo pins
below are perishable)

Companion to `docs/library-research.md` (rendering, math, annotations, storage, lists,
graph; on branch `claude/confident-carson-30e7ed`). No app code was changed. Versions,
licenses, peer ranges and publish dates come from the npm registry (queried 2026-11-14).
Expo pins come from `bundledNativeModules.json` on Expo's `sdk-54` branch. Zotero API rules
come from zotero.org's Web API v3 docs and the `zotero-schema` repo. Anything resting on
background knowledge or an unread source is tagged **(unverified)**. Secret storage is out
of scope (handled by `expo-secure-store` on another branch).

## Bottom line

**No library should replace either piece.** The sync problem is not "merge arbitrary
concurrent edits" (CRDT territory). It is "two or three of one person's devices share a
folder that a dumb file-sync service (iCloud Drive, Dropbox, Syncthing) copies around."
Every real sync framework I checked either needs a server (PowerSync, Replicache, Evolu
relay), needs WebAssembly that Hermes does not provide (Automerge, Loro), or would add a
second source of truth beside SQLite (Yjs, TinyBase). The Zotero client library that
exists is AGPL-3.0 and would replace about 40 lines of `fetch`, while the real defects in
`exportToZotero` are protocol details the library does not handle for us either.

The valuable finding is that **the current sync format has data-model bugs that no library
would fix**, and they are cheap to fix in our own code:

1. **Annotation ids are device-local.** `annotations.id` is an autoincrement integer
   (`db.ts:837`, `saveAnnotation`), but `importUserData` upserts "by id — incoming id wins"
   (`db.ts:939-951`). Device A's annotation #7 and device B's unrelated annotation #7
   overwrite each other's `note`/`color`, and different texts silently share an id.
2. **Import drops `content_hash`.** The annotation INSERT in `db.ts:942` omits the column
   that `saveAnnotation` writes and that `exportToZotero` groups by. After a sync, annotations
   lose their article-version anchor.
3. **No tombstones.** `deleteAnnotation` / un-bookmarking just remove the row
   (`db.ts:859-862`). The next import from a device that still has the row resurrects it.
4. **Whole-file, single-name overwrite.** `exportToSyncFolder` writes one `sep_user.json`
   (`dataSync.ts:9, 41-44`). Two devices exporting between imports clobber each other, and
   sync services create "conflicted copy" files the app never reads.
5. **Prefs "remote wins" include secrets** (`db.ts:952-958`; already tracked as the
   UC-H3 gap in `use-cases.md`), and a pref sync means one device's font size overwrites
   another's.
6. **Zotero re-export duplicates.** `exportToZotero` has no idempotency, so tapping Export
   twice, or retrying after a timeout, creates duplicate items (`dataSync.ts:129-133`).

| Rank | Candidate | Verdict | Effort |
|---|---|---|---|
| 1 | Per-device snapshot files + stable ids + tombstones (own code, no library) | **Adopt** | M: 2–3 days |
| 2 | Zotero hardening in place (`Zotero-Write-Token`, check `failed`, honor `Retry-After`) | **Adopt** | S: 0.5–1 day |
| 3 | Native folder picker: `Directory.pickDirectoryAsync` from `expo-file-system` | **Evaluate** (spike on iOS/Android; macOS stays on typed path) | S: 0.5–1.5 days |
| 4 | `@react-native-documents/picker` (fallback if #3 cannot keep access across launches) | **Evaluate** only if #3 fails | S: 1 day |
| 5 | `zotero-api-client` | **Skip** (AGPL-3.0, no help with the actual defects) | n/a |
| 6 | Automerge, Yjs, Loro, cr-sqlite, TinyBase, PowerSync, Replicache, Evolu, iCloud/Drive wrappers | **Skip** | n/a |

## Constraints used to judge candidates

- **Stack:** Expo `~54`, RN `0.81.6`, new architecture on, Hermes. `react-native-macos`
  `^0.81.7` for the Mac target. `expo-file-system ~19.0.x` and `expo-sqlite ~16.0.x` are
  already dependencies (`package.json`).
- **No server we run, no accounts, offline-first, one maintainer.** This rules out any
  library whose sync needs a hosted backend or a vendor login (Google Drive OAuth counts as
  an account).
- **License:** the app is GPL-3.0. MIT/BSD/ISC/Apache-2.0 are compatible. AGPL-3.0 is
  compatible with GPL-3.0 by GPLv3 §13 (the combined work is allowed, and the AGPL network
  clause then applies to the AGPL part). That is a licensing wrinkle, not a blocker; see
  the Zotero section. `replicache` ships under a custom license URL, not an OSI license.
- **Content rule** (`AGENTS.md`): the sync file holds *our user's* reads, bookmarks and
  annotations. Annotation `selected_text` and `context` are SEP quotations. A file the user
  writes to their own folder is not redistribution by us, but we must never host or relay
  it. Any library that routes data through a third-party server (PowerSync, Evolu relay,
  Replicache) would make us the redistributor of those quotes, which is a second reason
  to skip them, besides the no-server rule.
- **Pinning:** use the versions Expo pins, not npm `latest`. Expo 58 packages are on npm
  `latest` today; SDK 54 pins `expo-document-picker ~14.0.8`, `expo-file-system ~19.0.24`,
  `expo-sqlite ~16.0.10`.

## 1. What the current code actually does

- `dataSync.ts:13-23` `syncFile`: user types a path; `~` is expanded via `process.env.HOME`
  on macOS/iOS; `file://` is prefixed. On iOS and Android a typed path outside the app
  sandbox is not writable, so this design effectively works only on macOS (which, unsandboxed,
  can write anywhere). `SettingsScreen.tsx:311-320` shows the placeholder
  `/sdcard/Nous/` for Android, which scoped storage blocks on API 30+ **(unverified on a
  device; documented Android behavior)**.
- `exportToSyncFolder` / `importFromSyncFolder` (`dataSync.ts:27-69`): serialize
  `exportUserData()` (`db.ts:896`), write to cache then `copy` over the destination, and on
  import check `version === 1` then call `importUserData`. Failures collapse to `'error'`.
- Merge rules in `importUserData`: reads `INSERT OR IGNORE` (dedupe key is whatever unique
  index `reads` has; **(unverified)** I did not read the schema's unique constraints),
  bookmarks upsert by slug keeping newest `saved_at`, annotations upsert by local id,
  prefs overwritten.
- `exportToZotero` (`dataSync.ts:76-152`): hand-built `fetch` to
  `https://api.zotero.org/users/{id}/items`, one `encyclopediaArticle` per article version
  (`content_hash`), then one child `note` containing an HTML list of highlights. Returns
  `'ok' | 'auth_error' | 'error'`; the caller in `ReadingListScreen.tsx:64-76` maps those
  to three alert messages.

## 2. Zotero

### The API's real constraints (zotero.org Web API v3 docs, read 2026-11-14)

- **Write requests need one of two guards:** `Zotero-Write-Token: <token>` or
  `If-Unmodified-Since-Version: <library version>`. Without `If-Unmodified-Since-Version`
  the server answers `428` for the update/delete endpoints that require it. For item
  creation either header is accepted.
- **Write token = idempotency key.** A token that was already submitted returns
  `412 Precondition Failed`. So reusing one token across retries of the same logical export
  is exactly the dedupe our code lacks. (Token length/charset: **(unverified)**; the docs I
  read show the header but I did not extract a format. Use a random hex string and check the
  docs page "Write Requests" before shipping.)
- **A `200` does not mean success.** The response is
  `{successful: {"0": <saved object>}, unchanged: {}, failed: {"1": {key, code, message}}}`
  keyed by array index. `dataSync.ts:131-133` treats any `res.ok` as success and reads
  `payload.successful['0'].key`; a per-item `failed` entry (bad field, 413, locked item) is
  ignored, the parent key is `undefined`, and the note is skipped while the function still
  returns `'ok'`. The note POST at `dataSync.ts:140-144` has its own result discarded.
- **Other status codes the doc lists:** `400` (invalid type/field, unparseable JSON), `409`
  (library locked), `412`, `413` (too many items in one request), `428`.
- **Rate limiting:** two forms. A `Backoff: <seconds>` header on any response means finish
  what is necessary and then pause; `429` with `Retry-After: <seconds>` means wait at least
  that long, or back off exponentially if the header is absent. Our code does neither:
  a `429` returns `'error'` and the UI says "Could not reach Zotero."
- **Batch size:** deletes are capped at 50 per request; the item-write cap is stated only as
  "too many items" (`413`). Zotero's documented write limit is 50 objects per request
  **(unverified: the page I read states 50 only for deletes and lookups)**. We send at most
  one parent per request, so this does not bite today.
- **Version header:** `Zotero-API-Version: 3` is already sent. Good.
- **Annotation item type:** `annotation` is a real item type in `zotero-schema`
  (schema version 45 at check time), but Zotero annotations are created on a PDF/EPUB/
  snapshot *attachment* child **(unverified: stated from Zotero's data model, not
  re-read here)**. Our items are web-article records with no attachment, so a child
  `note` is the correct representation and no library changes that. Rendering each
  highlight as an `annotation` item would require creating a fake attachment, which is
  worse for the user's library. Keep notes.
- **Schema fit:** `encyclopediaArticle` supports `title`, `encyclopediaTitle`, `date`,
  `url`, `accessDate`, `language`, `extra` (all fields we send) and creator types `author`,
  `editor`, `contributor` (confirmed in `zotero-schema/schema.json`).
- **`parseCreators` (`dataSync.ts:171-178`)** splits on commas, so `"Smith, John, Jr."` or
  an author field with two authors becomes one author with first name `John`. This is our
  data-quality issue, independent of any client library.

### Candidate: `zotero-api-client`

| Field | Value |
|---|---|
| Version · last publish | 0.53.0 · 2026-11-08 (npm `time.modified`); GitHub repo pushed 2026-11-08 |
| License | **AGPL-3.0** (package.json `license`; `COPYING` carries the Zotero-trademark notice). GitHub's license API reports "Other/NOASSERTION", so read the file, not the badge. |
| Fit with GPL-3.0 | Compatible by GPLv3 §13; the combined app would carry AGPL §13 for the covered portion. Harmless for a client-only app, but it is a new obligation and the opposite of "boring licenses only." |
| Runtime | Plain `fetch`, `spark-md5`, `@babel/runtime(-corejs3) ^8.1.0`. No Node built-ins visible in `src/request.js`. `engines.node >= 18`. No RN-specific mention; Hermes/RN behavior **(unverified; not run)** |
| Bundle | `lib/main.cjs` 78.9 KB raw / 16.8 KB gzipped, plus corejs3 runtime helpers (size **(unverified)**) |
| macOS | Pure JS, so no native concern (RN-macos runs the same Hermes) |
| Maintenance | Single maintainer; frequent releases (0.53.0 is the 53rd minor) |

**What it would replace:** the request building in `exportToZotero` (`dataSync.ts:82-87,
129-133, 140-144`): the base URL, the headers, and a typed `api(key).library('user',
id).items().post([...])`. It supports `zoteroWriteToken` and `ifUnmodifiedSinceVersion`
config (`src/request.js:17-22`), a `retry`/`retryDelay` option with exponential backoff
(`request.js:253-258, 345-358`), and typed response objects that expose per-index failures.

**What it does not do:**

- It does not honor `Retry-After` or `Backoff` (I grepped the source: no occurrences; its
  retry is a fixed exponential schedule of its own).
- It does not generate a write token for you or make a multi-step export (parent, then
  child note) atomic. We would still write the group-by-version loop, the HTML note
  builder (`buildAnnotationNote`), the access-date lookup, and the status-to-UI mapping.
- It does not change the annotation story (see above).

**Verdict: Skip.** About 15 lines of our `fetch` calls become 8 lines of library calls,
for an AGPL dependency and about 80 KB. The six defects that matter (write token,
`failed` map, `Retry-After`, partial-failure result, creator parsing, dedupe) are fixed
equally well, and with fewer moving parts, by changing our own function. Revisit if we
ever need to *read* the user's library (sync back, duplicate detection against existing
items), where typed pagination and versioning start to pay for themselves.

`zotero-lib` 1.1.0 (ISC, 2026-02-15) is a Node CLI-style wrapper (`OpenDevEd`); I did not
evaluate RN compatibility and it is not a better fit than the above **(unverified)**.

### Recommended hardening (own code, no dependency)

1. Generate one write token per *logical export* (e.g. random per slug + version hash,
   stored in `meta` so a retry reuses it). Treat `412` on a reused token as "already saved."
2. After each POST, read `failed` and `successful`, and surface a real error. Do not
   return `'ok'` if the parent was not created or the note failed.
3. On `429`, wait `Retry-After`; on `Backoff`, pause further calls. Return a distinct
   `'rate_limited'` so the UI can say so.
4. Return a richer result (`{status, created, failed}`) and update the single caller in
   `ReadingListScreen.tsx:64`. Per the global rule: grep callers first, add a test that
   asserts the caller does not treat a partial failure as success.
5. Fix `parseCreators` for "Last, First" vs. multiple authors; add tests with `Jr.`,
   hyphenated, single-name and empty inputs.

## 3. Sync

### Why not a CRDT or sync framework

| Candidate | Version · last publish · license | Needs a server? | Hermes / RN 0.81 | macOS | Verdict |
|---|---|---|---|---|---|
| `@automerge/automerge` | 3.5.0 · 2026-09-16 · MIT | No (file/peer capable) | Ships a WASM core (47.5 MB unpacked); Hermes has no WebAssembly. RN support story **(unverified)** | n/a | Skip |
| `@automerge/automerge-repo` | 2.6.0-alpha.3 · 2026-11-13 · MIT | Storage adapters, no file-folder adapter | Alpha tag on latest | n/a | Skip |
| `yjs` | 13.6.33 · 2026-09-23 · MIT | No | Pure JS, works on Hermes | Yes | Skip (see below) |
| `loro-crdt` | 1.17.1 · 2026-10-22 · MIT | No | WASM (21.9 MB unpacked) | n/a | Skip |
| `@vlcn.io/crsqlite` (cr-sqlite) | 0.16.3 · **2024-01-17** (npm); GitHub repo pushed 2026-08-10 · Apache-2.0 per npm | No | Needs a loadable SQLite extension; `expo-sqlite` extension loading **(unverified)** | n/a | Skip |
| `tinybase` | 10.1.0 · 2026-11-12 · MIT | Optional synchronizers | Peer list includes `expo ^58` (optional?) **(unverified)** | n/a | Skip |
| `@powersync/react-native` | 2.4.1 · 2026-11-12 · Apache-2.0 | **Yes** (PowerSync service + backend DB) | Peer RN `*`; needs `@powersync/op-sqlite` or its own SQLite | n/a | Skip |
| `replicache` | 15.3.0 · 2026-05-22 · **custom license (roci.dev/terms)** | **Yes** | n/a | n/a | Skip |
| `@evolu/react-native` | 16.3.0 · 2026-11-14 · MIT | Relay server | Peer `react-native >=0.88`: **cannot install on 0.81.6** | n/a | Skip |

**Why Yjs is the closest and still a skip.** It is pure JS, MIT, and actively released.
But we would store annotations in a Yjs document *and* in SQLite (the app queries them
with SQL: `getAllAnnotations`, joins to `entries`), or give up SQL for those tables. We
would still need a transport, and the only transport that fits "no server, no accounts" is
exactly the dumb shared folder we already have, just with opaque binary updates instead of
a readable JSON file. We would buy conflict-free merge of free-text note edits (rare:
single user, few devices) at the price of a second persistence layer and unreadable files.
`y-indexeddb` (9.0.12, last published 2023-11-02) is browser-only and irrelevant.

**Why the frameworks with servers fail on principle.** PowerSync, Replicache and the
Evolu relay all put a service we or a vendor run between the user's devices. That breaks
"no server we run or host" and "no accounts," and (see Constraints) would route SEP
quotations through it.

**Why a CRDT is more than the problem needs.** Reads are an append-only log (a visit
cannot conflict with another visit). Bookmarks are a set keyed by slug. Annotations are
records with a last-writer-wins `updated_at`, plus deletes. That is an **LWW-element-set
with tombstones**, a few dozen lines, and it is a *state-based* CRDT that we can hand-write
safely at this size.

### Recommended design (own code, no dependency)

1. **One file per device**, `nous-<deviceId>.json`, written only by that device. A file
   sync service then has no write-write conflicts on a file (the cause of "conflicted
   copy" files). Import reads every `nous-*.json` except our own and merges them. A plain
   `ls` + `File.text()` loop over the folder replaces `importFromSyncFolder`'s single-file
   read.
2. **Stable record ids.** Add a `uid TEXT` (UUID/ULID via `expo-crypto ~15.0.9`) to
   `annotations`; keep the integer `id` as local PK. Export the `uid`; import upserts by
   `uid`. Back-fill existing rows once in a migration. Bookmarks key by `slug`
   (already stable); reads key by `(slug, visited_at, session_id)`.
3. **Tombstones.** A small `deleted_records(kind, key, deleted_at)` table; export it;
   import applies a delete when `deleted_at > updated_at`. Garbage-collect after, say,
   90 days (a device offline longer re-imports old rows, an accepted limit).
4. **Per-record LWW** on `updated_at` for annotations and bookmarks (bookmark gets an
   `updated_at` too, replacing "keep newest `saved_at`").
5. **Do not sync secrets or device prefs.** Allow-list prefs (theme, font size, scope)
   instead of the current `NOT IN ('onboarding_done')` deny-list (`db.ts:903`), and keep
   `zotero_api_key` out of the file entirely (matches the `expo-secure-store` branch).
6. **Fix `content_hash`** in the import INSERT (`db.ts:942`) as part of this.
7. **Format version bump** (`version: 2`) with the existing `version !== 1` guard
   (`dataSync.ts:63`) widened to read v1 files once for migration.
8. **Tests for the merge function**, written first, per the global rule: two devices with
   colliding integer ids, a delete on one and an edit on the other, a v1 file import, an
   empty folder, and a corrupt file among valid ones.

Effort: **M, 2–3 days** (migration + merge + tests; the UI changes are in #3 below).

### Folder access: the part that is genuinely platform-specific

The typed-path text box in `SettingsScreen.tsx:303-320` is the weakest piece for iOS and
Android. Options:

| Candidate | Version · last publish · license | Covers | Verdict |
|---|---|---|---|
| `Directory.pickDirectoryAsync` in `expo-file-system` (already installed, `~19.0.24`) | n/a · MIT (Expo) | The SDK 54 changelog lists "[iOS] Add `pickDirectoryAsync` support"; the SDK 54 docs show `pickFileAsync`/`pickDirectoryAsync` for Android. Persistence of access across app launches **(unverified)** | **Evaluate** (spike) |
| `expo-document-picker` | npm 58.0.5 · 2026-11-11 · MIT; **SDK 54 pin `~14.0.8`** | Picks files, not directories. Docs list platforms `android, ios, web` only, so **no macOS** | Skip for this use |
| `@react-native-documents/picker` | 12.0.3 · 2026-10-18 · MIT · peer RN `>=0.79` | Maintained successor of `react-native-document-picker`; directory/bookmark support and macOS **(unverified)**; native module, so a config plugin or prebuild step is likely | Evaluate only if the Expo API cannot persist access |
| `react-native-saf-x` | 2.2.3 · **2023-10-03** · MIT | Android Storage Access Framework wrapper | Skip (stale 3 years) |
| `react-native-cloud-storage` | 3.3.0 · 2026-10-23 · MIT · peer RN `>=0.76` | iCloud Drive and Google Drive; Google Drive uses OAuth (an account), iCloud needs an entitlement and Apple developer config | Skip (accounts; Android parity) |
| `react-native-cloud-store` | 0.12.0 · **2024-04-11** · MIT | iCloud only | Skip (stale, iOS-only) |

**Spike to run before committing** (S, 0.5–1.5 days): on a real iOS device and an Android
device, pick a folder in iCloud Drive / a Drive-backed folder, store the returned URI in
`meta.sync_folder`, kill and relaunch the app, and confirm a write succeeds. If access is
lost on relaunch, try `@react-native-documents/picker` (bookmark API). On macOS keep the
text path (the app is not sandboxed in dev builds; an App-Sandbox release build would need
the same picker with a security-scoped bookmark: **(unverified)** whether
`react-native-macos` exposes any of this). `process.env.HOME` in `syncFile` is also
**(unverified)** under Hermes outside macOS dev builds.

A **"Share"/"Open in" sheet** (`expo-sharing ~14.0.8`) is a zero-risk fallback for iOS: the
user exports the JSON and imports it with `getDocumentAsync`. It is manual, but works with
no folder permissions at all, and is a reasonable v1 for mobile while the picker is
validated.

### Auto-sync (UC-H5)

`SettingsScreen.tsx:41, 366-369` stores `autoSync` (`off | 2days | 7days`), but
`syncOnLaunch` in `dataSync.ts:72` is an explicit no-op, and "Check for updates now"
(`handleSyncNow`, `SettingsScreen.tsx:192`) is about SEP index downloads, not the sync
folder. So UC-H5 "auto-sync" is currently a label, matching `use-cases.md` "behavior not
verified." Real background sync would need `expo-background-task ~1.0.10` and
`expo-task-manager ~14.0.9`, both pinned for SDK 54 **(unverified on macOS)**. For one
person with a few devices, **sync on launch and on foreground** is sufficient and needs no
background task; I recommend wiring `syncOnLaunch` to import-then-export with a
10-second timeout.

## 4. Ranked recommendation

| # | Do | Verdict | Effort | Notes |
|---|---|---|---|---|
| 1 | Per-device files + `uid` + tombstones + LWW merge, with tests first | **Adopt (own code)** | M, 2–3 days | Fixes bugs 1–5. Includes the `content_hash` import fix and moving secrets out of the file. |
| 2 | Zotero write token, `failed` handling, `Retry-After`, richer result, `parseCreators` fix | **Adopt (own code)** | S, 0.5–1 day | Fixes bug 6 and the silent partial-failure path. Single caller to update. |
| 3 | Folder picker spike (`Directory.pickDirectoryAsync`) | **Evaluate** | S, 0.5–1.5 days | Gate: access survives relaunch on real iOS/Android devices. |
| 4 | Wire `syncOnLaunch` (import then export on launch/foreground) | **Adopt (own code)** | S, 0.5 day | Makes UC-H5 real without a background task. |
| 5 | `@react-native-documents/picker` | **Evaluate if #3 fails** | S, 1 day | Native module, new dependency. |
| 6 | `zotero-api-client` | **Skip** | n/a | AGPL-3.0; revisit only if we start *reading* Zotero libraries. |
| 7 | Automerge, Loro, Yjs, cr-sqlite, TinyBase, PowerSync, Replicache, Evolu | **Skip** | n/a | WASM, servers, a second store, an unmaintained npm package, or RN `>=0.88`. |

Total for ranks 1, 2, 4: about **3–4.5 days**; the picker spike adds up to 1.5.

## Version traps

- npm `latest` for `expo-*` packages is the Expo 58 line; for SDK 54 install only via
  `npx expo install` (document-picker `~14.0.8`, file-system `~19.0.24`, sqlite
  `~16.0.10`, crypto `~15.0.9`, sharing `~14.0.8`).
- `@evolu/react-native` 16.3.0 requires RN `>=0.88`; it will not resolve on 0.81.6.
- `@automerge/automerge-repo` `latest` is currently an `2.6.0-alpha.3` prerelease.

## Items not verified

- Zotero write-token format and the exact per-request item cap for writes.
- That `annotation` items require an attachment parent (stated from the data model, not
  re-read in the docs).
- Whether `zotero-api-client` runs unmodified on Hermes (fetch and `spark-md5` only, but
  not executed), and the size of its `@babel/runtime-corejs3` helpers.
- Whether `pickDirectoryAsync` keeps access across launches on iOS, and any macOS picker
  behavior.
- RN support of Automerge/Loro WASM, `expo-sqlite` extension loading for cr-sqlite,
  TinyBase's Expo peer being optional.
- Unique-index definition on `reads` (affects the dedupe in `importUserData`).
