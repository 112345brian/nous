# Math throttling: equations never compete with reading

Equations are typeset by MathJax in a hidden WebView (`src/services/mathRender.ts`).
MathJax itself runs off the React Native JS thread, but receiving and parsing the
result, `atob`, DB writes, `parseSepHtml` + `JSON.stringify`, the AST `JSON.parse` in
`ArticleScreen` and the re-render all run on it. This model makes all of that stop
while something more important is happening, and resume afterwards.

## Priorities (highest first)

| # | Priority | What | Mechanism | Math may run when |
|---|----------|------|-----------|-------------------|
| 1 | reading | opening/rendering an article; scroll, touch | `idleScheduler.hold('reading')` in `ArticleScreen.load()`; `noteActivity()` from `SepArticle` scroll and the WebView `progress` message | never while a hold is active; then not until the quiet gap has passed |
| 2 | download | `downloadAll`, `syncCachedArticles`, seed import | `idleScheduler.hold('download')` via `withDownloadHold` (catalog.ts; App.tsx and SettingsScreen call sites for seed import) | never while one is running (all math is fully paused, current article included) |
| 3 | current | math of the article on screen (`completeArticleMath` default) | gate `whenMayRun('current')` | no hold, and 400 ms since the last activity |
| 4 | background | `backfillMathInline`, `resumePendingMath`, `backfillAst` | gate `whenMayRun('background')` | no hold, and 1500 ms since the last activity |

Holds are counted per kind; releasing a hold counts as activity, so the quiet gap
starts when the article finished opening / the download finished.

## Pieces

* `src/utils/mathThrottlePolicy.ts`: pure policy and constants. `mayRun(priority, state, cfg)`
  answers "may this run now, and if not, what is blocking and for how long"; `chunkRanges`;
  `createSliceBudget(now, ms)`. No I/O, no timers; the clock is injected. Tests with a fake clock:
  `src/utils/__tests__/mathThrottlePolicy.test.ts`.
* `src/services/idleScheduler.ts`: `hold(kind = 'reading')`, `noteActivity()` (both
  unchanged for existing callers), plus the cooperative yield points
  `whenMayRun(priority)` and `yieldThenMayRun(priority)` (a 16 ms macrotask pause, then
  `whenMayRun`). A running task is still never interrupted; it stops at its next
  `await whenMayRun(...)`. New tasks also don't start during a `download` hold.
* `src/services/mathChunked.ts`: `renderMathChunked(items, {priority})`. One WebView message
  per chunk, one in flight, yield point before each. Per-item results keep their order and
  errors; a chunk that throws or returns short becomes per-item errors; a fully timed-out
  chunk stops the rest (otherwise N chunks x 30 s timeout) and the article stays pending.
  `chunkSize: Infinity` is the old single batch. `priority: null` = ungated, used only by the
  `awaitMath` path of `syncCachedArticles`, which already runs under its own download hold
  (gating would deadlock).
* `src/utils/mathKey.ts`, `src/services/mathCache.ts`: key, dedupe, chunk persistence (below).
* `src/services/mathPriority.ts`: singleton wiring: `whenMathMayRun`, `yieldThenMathMayRun`,
  `withDownloadHold`, `mathSlice` (time-sliced loops) and the dev-only `watchStalls`.
* `src/utils/stallDetector.ts`: dev-only JS-thread stall detector (timer lateness).
* `catalog.ts` changes are small: `substitutemath(html, priority)` calls `ensureMath` and keeps only the splice loop
  (with a slice checkpoint); `completeArticleMath(slug, html?, priority)`;
  `resumePendingMath`, `backfillMathInline`, `backfillAst` do one article per unit with
  `await yieldThenMathMayRun('background')` between units; `downloadAll` /
  `syncCachedArticles` are wrapped in `withDownloadHold`.
* `ArticleScreen`: the `onMathReady` listener waits for `whenMayRun('current')` before the
  AST `JSON.parse` + swap, and ignores the event if the reader navigated away meanwhile.

## Paused, not dropped

Nothing is removed from a queue when paused. Current-article math is recorded in
`math_pending` before it starts (unchanged) and removed only on success;
`resumePendingMath` walks that list one article per unit. `backfillAst` and
`backfillMathInline` re-derive their work list from the DB, so a kill mid-way resumes at
the first unfinished article. `backfillMathInline` now re-reads each article's HTML right
before processing (its start-of-run snapshot can be hours old when paused).

## Dedupe and crash safety (the `math` table is the progress record)

`src/utils/mathKey.ts` (pure) defines the table key: `mathHash(tex, display)` =
`hash64(normalizeTex(tex), display)`, where normalization only trims and collapses whitespace
runs (braces and commands are untouched: `x_1` and `x_{1}` stay separate). `catalog.ts`
imports it; `hash64` is also what `backfillMathHashFormat` uses on raw SVG bytes, unchanged.

`src/services/mathCache.ts` `ensureMath(spots, priority)` is the one function both the first
render and a resume go through:

1. hash every spot and dedupe by hash;
2. look up which hashes the `math` table already has (`getMathByHashes`, in IN lists of 400);
3. send only the missing unique equations to the WebView, in chunks of 24;
4. **write each chunk to the table in its own transaction (`putMathBatch`) before the next
   chunk is requested** (`renderMathChunked`'s `onChunk`, awaited);
5. return `complete` once every hash is stored or was rejected by MathJax as bad TeX.

Finalization is separate and idempotent (`substitutemath` rewrite, then `completeArticleMath`
writes `content_html`, re-derives the AST and clears `math_pending`). It runs only when
`complete` is true and renders nothing if everything is stored. There is no progress counter:
what is in the table is what is done.

Guarantees:
* A force stop or crash loses at most the chunk in flight: **24 equations** of MathJax work
  (a chunk's SVGs are not in the table until its transaction commits). Resume renders only
  the hashes still missing, never one already stored.
* A kill between the last chunk and finalization resumes with finalization only (zero
  rendering). Finalization writes `content_html` after the SVG rows exist, as before, so no
  placeholder can reference a missing row.
* A chunk that throws, returns short or times out leaves only its hashes missing; the other
  chunks are stored and other articles proceed. Retries are bounded in memory
  (`MAX_RENDER_ATTEMPTS = 2` per equation per app run, one extra pass inside the same call);
  after that the article stays in `math_pending` until the next launch, which gets fresh
  attempts. TeX that MathJax itself rejects is remembered for the run, left as raw text, and
  does not hold the article pending.
* A fully timed-out chunk (engine presumed hung) skips the remaining chunks of that pass
  instead of waiting 30 s per chunk.

Limits:
* Chunk size 24 is the loss window and the cancel window. Smaller means less lost work but
  more transactions and bridge messages (12 would double both); 24 sits in the 20-40 target.
  One constant (`chunkSize`).
* The window is "MathJax work for one chunk", not data: the article text and `math_pending`
  were already durable.
* Retry counters and the bad-TeX set are not persisted, so an equation the renderer can
  never do costs `MAX_RENDER_ATTEMPTS` renders per launch for as long as its article is
  pending. Rejected-TeX equations do not count (they finalize the article).
* `putMathBatch` is the only durable write per chunk; if SQLite itself fails the error
  propagates, the article stays pending, and nothing is half-written (one transaction).
* Rows written under old hashes stay valid: only TeX with internal runs of whitespace gets a
  new hash, and existing articles keep referencing their old rows. No version bump or migration
  was written (the existing derived-content version lives in `coreMigrations.ts`, which this
  task must not touch); re-fetched or re-rendered articles simply store the new hash.

### Dedupe ratio (counts only, 4 math-heavy articles fetched by hand; pages kept outside the repo)

| | count |
|---|---|
| equation spots in the 4 articles | 2235 |
| unique per article (sum), whitespace-normalized | 834 |
| unique across the 4 articles | 761 |
| unique with trim only (old key) | 780 |

So 66% of typesets disappear once repeats are deduped (63% from within-article repeats,
a further ~3% because the articles share equations), and normalization merges 19 more.
Per article: logic-modal 878 -> 324, set-theory 763 -> 266, computability 363 -> 176,
model-theory 231 -> 68. Bundling pre-rendered common equations in the app is not an option
(AGENTS.md: SEP-derived content is never bundled); the tiering branch already removes the
most common trivial ones. Four articles is a small sample: treat the ratio as indicative.

## Constants and tuning (`DEFAULT_THROTTLE_CONFIG`)

| Constant | Default | Raise it to | Lower it to |
|----------|---------|-------------|-------------|
| `chunkSize` | 24 equations per message | amortize bridge overhead, finish faster | shorten the one uncancellable batch |
| `currentQuietMs` | 400 | never touch the thread until the reader has clearly stopped | see equations sooner |
| `backgroundQuietMs` | 1500 | | |
| `yieldMs` | 16 | give frames more room (slower math) | faster math |
| `sliceBudgetMs` | 8 | | keep post-processing slices well under a frame |

Pass overrides to `createIdleScheduler({ throttle: {...} })` in `idleScheduler.ts`.

**Worst-case delay after the reader acts.** A batch already inside the WebView cannot be
cancelled. The bound is one chunk (24 equations): its MathJax time (off the JS thread,
**not measured**), then on the JS thread one `JSON.parse` of ~24 SVGs, then at most one
8 ms slice before the next yield point. The remaining unsliceable stall is the per-article
`parseSepHtml` + `JSON.stringify` in `completeArticleMath` (and the same in `backfillAst`)
plus the SQLite writes.

## Measurements (synthetic, Node, not a device)

`scripts/mathStallBench.bench.ts` (not in the jest suite; run with
`npx jest --testMatch '**/scripts/mathStallBench.bench.ts' --runInBand`) stubs the DB and the
WebView, feeds `completeArticleMath` a hand-written article, and runs `stallDetector` over it
(4 ms interval; stall = timer lateness). It covers only this pipeline's own JS work (message
`JSON.parse`, `atob`, splice, `parseSepHtml`, `JSON.stringify`), in V8 on a laptop, not Hermes
on a phone. Before = base commit `2fa1958`, after = this branch; runs 2-4 of 5:

| equations x SVG size | | wall | longest stall | stalls >16 ms | stalls >50 ms |
|---|---|---|---|---|---|
| 400 x 4 KB | before | 7-8 ms | 3-4 ms | 0 | 0 |
| | after | 308 ms | 3-5 ms | 0 | 0 |
| 1500 x 4 KB | before | 71-73 ms | 67-69 ms | 1 | 1 |
| | after | 1.4-1.5 s | 14-18 ms | 0-1 | 0 |
| 400 x 40 KB | before | 29-31 ms | 25-27 ms | 1 | 0 |
| | after | 340 ms | 8 ms | 0 | 0 |
| 1500 x 40 KB | before | 197-222 ms | 193-218 ms | 1 | 1 |
| | after | 1.5 s | 8-18 ms | 0-1 | 0 |

Reading it: before, the whole result is processed in one uninterrupted stretch, so the stall
equals the work and grows with the article. After, the stall is bounded by a slice/chunk
(single digits to ~18 ms here) regardless of article size. The price is wall time: about
16 ms of deliberate yield per chunk, roughly +1 s per 1500 equations, before counting any
pauses. The 400 x 4 KB case is below Node's noise floor, so it shows no benefit; Hermes is
slower than V8, which is why the larger rows are the interesting ones, but that scaling was
not measured.

In a dev build, `watchStalls` logs `[perf] stalls math:<slug> max=.. >16=.. >50=..` while
each article's math completes, so the same numbers can be read off a device. The
detector also counts a stall still running when it stops.

## What could not be verified

* Nothing was run on a device or simulator: no real WebView, MathJax timing, SQLite, Hermes,
  `SvgXml` re-render or frame rate. The tables above are Node-only and synthetic.
* Whether 24 equations per chunk is the right size on a slow phone (MathJax time per chunk is
  unmeasured). It is one constant.
* Touch (without scroll) does not count as activity: only scroll events and the WebView
  `progress` message call `noteActivity()`. The article-open hold covers the first seconds.
* Visible-first ordering and incremental AST updates (plan item 5) are not done. The article
  is still rewritten and re-parsed as a whole when all its equations are done, so the reader
  sees raw TeX until then; the swap itself is now deferred to a quiet gap. What blocks it:
  `completeArticleMath` rewrites `content_html` and re-parses the whole AST only once, and
  `mathref` nodes exist only after that rewrite. Incremental updates need per-chunk AST
  patching by hash (or position) instead, and the viewport-to-equation mapping from the native
  renderer; that touches `substitutemath` (tiered-math) and `core/mathCompletion.ts`
  (pure-core-no-io), so it was left for after those merge.
* `backfillMathInline` still loads every math article's HTML at once (`getMathArticleHtml`)
  and sets `math_inline_v2` even if the renderer timed out for some articles (existing
  behavior, not changed here).
* `backfillAst` and the per-article `parseSepHtml` cannot be sliced inside; one article is
  the smallest unit.

## Related gap (not fixed here)

Articles bulk-downloaded with `skipMath: true` after the one-shot `math_inline_v2` flag is set
never get math, because nothing adds them to `math_pending`. This design makes the fix easy:
`resumePendingMath` is now the single paced, resumable consumer of `math_pending`, so
`downloadAll` only needs to add each `skipMath` article that `has_math` to that list
(`updatePending(s => s.add(slug))`, as `fetchAndCacheArticle` already does for the deferred
path) and it will be rendered at background priority. A test in
`catalog.backfillMathInline.test.ts` pins the current behavior ("known gap") and will need to
change with that fix.

## Merge notes

Expect conflicts with `tiered-math` (`substitutemath`), `pure-core-no-io`
(`completeArticleMath`/`resumePendingMath`/`updatePending` moving to `src/core/mathCompletion.ts`;
the yield point and priority argument would become injected dependencies there) and
`delete-legacy-compat` (migrations only; no overlap expected beyond imports in catalog.ts).
