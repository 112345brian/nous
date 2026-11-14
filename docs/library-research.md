# Library research: could we adopt something instead of building it?

**Checked:** 2026-11-14 · **Recheck by:** 2027-02-14 (versions, RN-compat floors and
release dates below are perishable)

Scope: no app code was changed. Versions, licenses, peer ranges and publish dates come
from the npm registry (queried 2026-11-14). Expo-compatibility comes from Expo's own
`bundledNativeModules.json` on the `sdk-54` branch. Claims that rest only on web-search
snippets or on my background knowledge are tagged **(unverified)**.

## Bottom line

**There is no framework that replaces this app's core.** The valuable, differentiating
part is `src/utils/sepHtml/` (parse → AST → virtualized native blocks, with annotation
highlights, `<math-i>` placeholders, footnotes and TOC anchors wired in). Every
"reading app" or HTML-rendering library I found either solves a different problem (EPUB,
Markdown, WYSIWYG editing) or would give up virtualization, which is the thing the
reader needs for speed. The licensing posture is clean for every shortlisted candidate.

What is worth doing:

| Rank | Candidate | Verdict | Effort |
|---|---|---|---|
| 1 | `@shopify/flash-list` v2 for `SepArticle` | **Adopt after a spike** (gate on timing data) | S: 0.5–1.5 days |
| 2 | MathJax inside Hermes (no new dependency) | **Evaluate** (go/no-go spike) | M: 1–3 days |
| 3 | W3C TextQuoteSelector as the annotation *data model* | **Adopt the idea, not a library** | S: 0.5 day |
| 4 | Everything else (render-html, KaTeX, Readium, epub, Recogito, op-sqlite, Watermelon, Skia, d3-force, pager-view, MMKV) | **Skip** | n/a |

Two repo hygiene findings came out of this and are listed at the end.

## Constraints used to judge candidates

- **Stack:** Expo `~54`, React Native `0.81.6`, React `19.1`, new architecture on
  (`android/gradle.properties` has `newArchEnabled=true`; SDK 54 default). `react-native-macos`
  `^0.81.7` is a dependency.
- **License:** the app is GPL-3.0. MIT, BSD, ISC and Apache-2.0 are all compatible with
  GPL-3.0 (Apache-2.0 is *not* compatible with GPL-2.0-only, which is irrelevant here).
- **Content rule** (`AGENTS.md`, `NOTICE.md`): never bundle SEP text, SEP-derived
  renderings (including pre-rendered math SVG), or InPhO data. Any math or rendering
  library must run **on-device on fetched content**. None of the shortlisted libraries
  ships data of its own; the rule bites on *how we use* them, e.g. a build-time
  "pre-render all equations" step is off the table for any math engine.
- **Pinning:** use the versions Expo pins, not npm `latest`. Several `latest` releases
  are ahead of RN 0.81 (see "Version traps").

## 1. HTML / article rendering

**What it would replace:** `src/utils/sepHtml/parse.ts` (468 lines) and
`src/utils/sepHtml/render/*` (Blocks 287, Inline 297, SepArticle 153, MathSvg 73),
about 1.3k lines, plus `articleTemplate.ts` / `injectedAssets.ts` for the WebView fallback.

| Library | Version · last publish · license | Fit | Verdict |
|---|---|---|---|
| `@native-html/render` | 1.0.4 · 2026-10-14 · MIT | Pure-JS, HTML → native views. Its README says it is the successor to `react-native-render-html` (same API) and lists Android, iOS, macOS, Windows. New-architecture support: **(unverified)**. | **Skip** |
| `react-native-render-html` | 6.3.4 · 2022-01-24 · BSD-2-Clause | Superseded by the row above. | Skip |
| `react-native-enriched-markdown` | 1.2.0 · 2026-11-12 · MIT | Markdown, not HTML. New-arch only. Native LaTeX (RaTeX) is documented as **not supported on macOS**. | Skip |
| `react-native-enriched-html` | 1.2.0 · 2026-10-28 · MIT | HTML editor/display. Peer `react-native >=0.82`, so it **cannot be installed on RN 0.81.6**. | Skip (revisit after an RN upgrade) |

**Why skip:** a general HTML renderer builds one big view tree. Our renderer's value is
that it turns the article into an AST, caches the AST in SQLite (`content_ast`), and
feeds `FlatList` block by block with `windowSize={3}` and `removeClippedSubviews`
(`SepArticle.tsx`). That is exactly what keeps long articles smooth, and the user's
complaint is speed. Swapping in a non-virtualized renderer would likely make long SEP
articles *worse* **(unverified; not benchmarked)**. We would also have to re-integrate
annotation highlights (`Inline.tsx`), math placeholders and footnote taps on top of a
generic renderer. Keep the custom pipeline; spend effort on its list layer instead
(section 5).

## 2. Math rendering

**What it would replace:** the hidden-WebView path: `src/services/mathRender.ts`,
`src/components/MathRenderWebView.tsx`, and the 3.0 MB `src/assets/mathjax-full.b64`
asset, plus the per-equation `putMath` writes in `catalog.ts`.

| Option | Facts | Verdict |
|---|---|---|
| **KaTeX** `0.19.1` (MIT, 2026-10-23) | Fast and small, but outputs **HTML + CSS + fonts** (or MathML), not SVG. To display natively we would still need a WebView, or convert to SVG ourselves. `react-native-katex` 1.3.0 is a WebView wrapper. | Skip |
| **RaTeX** (`ratex-react-native` 0.1.15, MIT) / enriched-markdown's native math | Native, but `ratex-react-native` requires `react-native >=0.84` and `react >=19.2`; enriched-markdown's math is unsupported on macOS. Neither accepts HTML. | Skip (not installable on RN 0.81.6) |
| **`react-native-mathjax-svg`** 0.9.9 (MIT, 2021-06-30) | Claims MathJax → SVG **without a WebView**, needs `react-native-svg` (which we already have). Unmaintained since 2021. Useful as a *reference*, not a dependency. | Skip as a dep; read for ideas |
| **`react-native-math-view`** 3.9.5 | npm license field is **blank**; last publish 2021. | Skip (license unknown) |
| **MathJax in Hermes, no new library** | We already depend on `mathjax-full` (3.2.2, **Apache-2.0**). `scripts/renderMath.cjs` and `src/utils/sepHtml/render/texToSvg.ts` already run the DOM-free `liteAdaptor` path in Node. | **Evaluate** |

**The spike worth doing.** History in `git log` (`cf1db37` → `95d69c9` → `d63e6c5`):
the project first rendered math on-device in JS, then moved to a hidden WebView because
MathJax "fails at module init" under Hermes (`Cannot read property 'mathjax' of
undefined`). That error message looks like a module-initialization/circular-require
problem under Metro, not necessarily a fundamental Hermes limitation, and the
pure-JS no-WebView packages above suggest it can work **(unverified under Hermes 0.81)**.
If it does, we drop the WebView round-trip (message bridge, 3 MB asset load, hidden
view) from the first-open critical path.

**Risks to test before committing:** (a) MathJax's conversion is synchronous and its
init is heavy, so on the single JS thread it could *add* jank; batch it behind the
idle scheduler (see the `perf-parallel-defer` work) or measure first; (b) bundle/parse
cost of the TeX package set; (c) correctness of SEP's macros vs. the current output.
**Go/no-go bar:** equal or better cold first-open time on a math-heavy article, no
visible jank while scrolling, identical SVG output on a fixed corpus sample. Do this
*after* the `perf-timing` instrumentation shows math is actually the dominant stage.

## 3. "Reading app" building blocks

| Area | Candidate | Facts | Verdict |
|---|---|---|---|
| EPUB reader | `react-native-readium` 5.3.0 (MIT, 2026-10-14) | Wrapper over Readium (BSD-3-Clause native toolkits). Peers: `react-native >=0.78`, `react-native-nitro-modules >=0.35.0`. macOS: not documented **(unverified)**. | **Skip.** It reads EPUBs; our source is SEP HTML, not a publication. |
| EPUB reader | `@epubjs-react-native/core` 1.4.8 (MIT) over `epubjs` 0.3.93 (BSD-2, last 2022-02-16) | WebView-based, needs EPUB input; `epubjs` is stale. | Skip |
| Annotation | `@recogito/text-annotator` 4.3.7 (BSD-3-Clause, 2026-10-12) | Maintained, but it operates on a **live DOM**. We render native views from an AST, so it would only work inside the WebView fallback. | Skip |
| Annotation | `@apache-annotator/dom` 0.2.0 (Apache-2.0, 2021-09-03); `dom-anchor-text-quote` 4.0.2 (MIT, 2017-02-10) | DOM-based and stale. `rangy` 1.3.2 has a blank npm license field. | Skip |
| Pager | `react-native-pager-view` | Expo SDK 54 pins **6.9.1**; npm `latest` is 10.0.2. | Skip. Only relevant if we add a paginated (non-scroll) reading mode. |
| Footnote popover / TOC | none needed | Already built: `FootnoteSheet.tsx`, `TocSheet.tsx`, `parseToc.ts`. | n/a |

**What to borrow instead:** the *model* from the W3C Web Annotation spec, the
`TextQuoteSelector` (`exact` + `prefix` + `suffix`). `reanchor.ts` (92 lines) already
does fuzzy re-anchoring using `selected_text` + a `context` string; storing explicit
prefix/suffix and using them to disambiguate repeated phrases is a small, library-free
improvement. Effort S (~0.5 day plus a DB migration for the extra column).

## 4. Local storage and search

**What it would replace:** `expo-sqlite` in `src/services/db.ts` and `graphDb.ts`.

| Library | Facts | Verdict |
|---|---|---|
| `@op-engineering/op-sqlite` 19.0.5 (MIT, 2026-11-05) | README: iOS, Android, **macOS** and web; FTS5 plugin; SQLCipher option. Expo SDK 54 does not bundle it, so it would be a separately managed native dependency. | **Skip** |
| `expo-sqlite` `~16.0.10` | Expo-pinned. **FTS is already in use** (`entries_fts` in `db.ts`), so full-text search is not a gap. | Keep |
| `@nozbe/watermelondb` 0.28.0 (MIT, 2025-04-07) | ORM + sync layer; a rewrite of the data layer for no stated benefit. | Skip |
| `react-native-mmkv` 4.3.2 (MIT) | Faster key/value, but `meta`/`prefs` are tiny and not on the hot path; needs `react-native-nitro-modules`. | Skip |

**Why skip:** the measured-by-reading problems are in how the app *queries* SQLite,
not in the engine: `SELECT *` in `getEntry` loads the article twice, and content is
re-hashed on open. Those are being addressed in the `perf-columns` and `perf-hash-once`
work. Changing the engine would not fix either.

## 5. List and scroll performance

**What it would replace:** the `FlatList` in `src/utils/sepHtml/render/SepArticle.tsx`
(tuned with `windowSize={3}`, `initialNumToRender={12}`, `maxToRenderPerBatch={8}`),
including its `onScrollToIndexFailed` workaround that scrolls to an *approximate*
offset, waits 200 ms, then retries. That workaround exists because `FlatList` cannot
jump to an unmeasured variable-height block.

| Library | Facts | Verdict |
|---|---|---|
| **`@shopify/flash-list` v2** | MIT. Expo SDK 54 pins **2.0.2** (npm `latest` 2.3.3, 2026-10-01). README: rebuilt for the new architecture, **new-arch only**, **JS-only** (no native dependency), no item-size estimates, maintains visible content position. | **Adopt after a spike** |
| `@legendapp/list` 3.7.2 (MIT) | Newer alternative; not in Expo's pin list. | Skip (no reason to prefer it over the Expo-pinned one) |
| `recyclerlistview` 4.2.3 (Apache-2.0) | Older; needs explicit layout providers. | Skip |

**Why this is #1:** it is the cheapest change, it is a dependency Expo already
vetted for SDK 54, it has no native code to link, and it targets the exact weak spot
(variable-height heterogeneous blocks plus anchor jumps for TOC, footnotes and search).
**Caveats:** (a) macOS support is **(unverified)**; I found no statement, so test on the
macOS target before committing; (b) recycling can interact badly with blocks that hold
state (selection, expanded footnotes, `MathSvg` placeholders), so verify highlight and
annotation rendering after recycling; (c) the speedup is **unmeasured**. Run the spike
behind the timing data from `perf-timing`: if first-open time is dominated by fetch and
math, this will not fix it, though it may still fix scroll feel and anchor jumps.
**Spike plan:** swap `FlatList` for `FlashList` behind a flag; test long articles
(heavy math, long bibliography, tables), TOC jump, footnote jump, restore-scroll-position.

## 6. Graph visualization

**What it would replace:** `src/utils/forceLayout.ts` (97 lines, seeded
Fruchterman–Reingold with an all-pairs O(n²) repulsion loop and an iteration count that
shrinks as n grows) and the `react-native-svg` drawing in `src/screens/GraphScreen.tsx`.

| Library | Facts | Verdict |
|---|---|---|
| `d3-force` 3.0.1 | ISC (GPL-compatible), pure JS, ~55 KB unpacked, Barnes-Hut many-body force. | **Skip.** Our layout is small, deterministic and cached (`primeGraphLayouts`); the graph is a local neighborhood, not thousands of nodes. d3-force's win is at large n. Revisit only if graphs get big. |
| `@shopify/react-native-skia` 2.14.0 (MIT) | Expo SDK 54 pins **2.2.12**. npm peers: `react >=19`, `react-native >=0.78`, `react-native-reanimated >=4`, `react-native-worklets`. Documented macOS support (Shopify docs, via search). Adds a large native dependency. | **Skip** unless the SVG graph is shown to be the bottleneck at realistic node counts. |

## Version traps (don't `npm i <pkg>@latest`)

Compare npm `latest` with what Expo SDK 54 expects (`bundledNativeModules.json`):

| Package | npm `latest` | Expo SDK 54 pin | Note |
|---|---|---|---|
| `react-native-reanimated` | 4.7.1 (peer RN `0.86 - 0.88`) | `~4.1.1` | `latest` does not support RN 0.81 |
| `react-native-gesture-handler` | 3.5.0 | `~2.28.0` | major-version gap |
| `react-native-pager-view` | 10.0.2 | `6.9.1` | |
| `@react-native-community/netinfo` | 12.0.1 | `11.4.1` | |
| `react-native-webview` | 14.0.1 | `13.15.0` | repo already matches Expo |
| `@shopify/flash-list` | 2.3.3 | `2.0.2` | install with `npx expo install` |
| `@shopify/react-native-skia` | 2.14.0 | `2.2.12` | |

Rule: add native-adjacent packages with `npx expo install <pkg>` so Expo selects the
pinned version. Packages that need a newer RN than 0.81.6 (`react-native-enriched-html`
`>=0.82`, `ratex-react-native` `>=0.84`) are blocked until an RN upgrade.

## License and content-bundling review

| Candidate | License | GPL-3.0-compatible | Bundles data? |
|---|---|---|---|
| `@native-html/render` | MIT | yes | no |
| `react-native-render-html` | BSD-2-Clause | yes | no |
| `react-native-enriched-markdown` / `-html` | MIT | yes | no |
| `katex` | MIT | yes | fonts only (not SEP data) |
| `mathjax-full` | **Apache-2.0** | yes (GPL-3.0; not GPL-2.0-only) | no |
| `@shopify/flash-list` | MIT | yes | no |
| `@op-engineering/op-sqlite` | MIT | yes | no |
| `@shopify/react-native-skia` | MIT | yes | no |
| `d3-force` | ISC | yes | no |
| `react-native-readium` / Readium toolkits | MIT / BSD-3-Clause | yes | no |
| `@recogito/text-annotator` | BSD-3-Clause | yes | no |
| `react-native-math-view` | **blank on npm** | **unknown: do not use** | n/a |
| `rangy` | **blank on npm** | **unknown: do not use** | n/a |
| WordPress `react-native-aztec` | GPL-2.0 / MPL-2.0 (per Software Mansion's comparison page) | avoid; archived, no new-arch | n/a |

Nothing shortlisted ships SEP or InPhO content. The standing rule still applies to *use*:
math must be generated on-device from fetched TeX, never as a bundled or CI-built artifact.

## Repo hygiene findings (from reading, not from libraries)

1. **`src/utils/sepHtml/render/texToSvg.ts` is dead code.** Its only consumer is its own
   test (`__tests__/texToSvg.test.ts`); the live path is `mathRender.ts` → hidden WebView.
   Its header comment says MathJax runs "in the RN JS runtime", which contradicts
   `mathRender.ts` ("MathJax cannot run in the Hermes JS runtime"). Either it is the
   starting point for the Hermes spike in section 2 or it should be deleted; today it
   misleads.
2. **Wrong license note.** `texToSvg.ts` calls `mathjax-full` "MIT-licensed"; the npm
   metadata says **Apache-2.0**. Both are compatible, but `NOTICE.md` should name the
   correct license and carry any attribution Apache-2.0 requires for the 3 MB
   `mathjax-full.b64` asset we redistribute.
3. `@react-native/new-app-screen` is listed in `package.json` but is not imported
   anywhere in `src/` or `App.tsx` (template leftover); safe to remove after a build check.

## Sources

- npm registry (`registry.npmjs.org`), queried 2026-11-14, for all versions, licenses, publish dates and peer ranges.
- Expo SDK 54 pins: https://raw.githubusercontent.com/expo/expo/sdk-54/packages/expo/bundledNativeModules.json
- `@native-html/render` README: https://raw.githubusercontent.com/native-html/render/master/README.md
- Software Mansion comparison page (enriched-markdown/-html, Aztec): https://docs.swmansion.com/react-native-enriched-html/misc/comparison-with-other-libraries
- FlashList v2 README: https://raw.githubusercontent.com/Shopify/flash-list/main/README.md
- op-sqlite README: https://raw.githubusercontent.com/OP-Engineering/op-sqlite/main/README.md
- Web-search snippets only (treat as secondary): Skia macOS support (Shopify docs), Readium native toolkits and `react-native-readium`, `react-native-mathjax-svg`, enriched-markdown macOS math limitation.
