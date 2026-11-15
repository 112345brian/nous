# Spike: MathJax directly in Hermes (no WebView)

Branch `claude/mathjax-hermes-spike-9b666e`. Question: can MathJax typeset TeX → SVG in
the Hermes runtime, and is that better than the hidden-WebView path?

## Recommendation

**Adopt for correctness; do not yet delete the WebView — decide on perf after one
on-device measurement.** MathJax *does* run in Hermes and (on ASCII TeX) produces
SVG that matches the WebView output. What I could not establish is the go/no-go
criterion "equal or better cold first-open on a math-heavy article", because I could
not run the app (see "Not verified"). What I did measure says the trade is:

* Hermes has **no WebView launch, no 3 MB base64 read + `atob` + inject, no JSON
  bridge** — those costs are real but not measurable here.
* Hermes typesets **~5× slower per equation** than V8-with-JIT in Chrome (1.45 s vs
  0.30 s for 500 equations on an M-series Mac), and it does it **on the JS thread**,
  so it must be time-sliced.

So: ship it behind the flag, measure on a real iPhone with `perf` stage timings, then
choose. If the on-device numbers are bad, "adopt for the simple subset" (ASCII TeX,
no `\require`) with WebView fallback is the safe middle: the engine returns per-item
errors, so a fallback is straightforward.

## The failure and the fix

Reproduced with the standalone `hermes` CLI from `node_modules/react-native/sdks/hermesc/osx-bin`
(`Hermes release version: for RN 0.81.6`, HBC 96) on a Metro-built, non-minified bundle
(`scripts/hermes-spike/`). The existing `texToSvg.ts` returned
`{"error":"Property 'require' doesn't exist"}` for every equation.

Where: `mathjax-full/js/components/version.js`, pulled in by `mathjax.js`:

```js
exports.VERSION = typeof PACKAGE_VERSION === 'undefined'
  ? function () { var load = eval('require'); var dirname = eval('__dirname'); ... }()
  : PACKAGE_VERSION;
```

Node-only `eval('require')`; Hermes has no `require` global. **Fix:** define the global
`PACKAGE_VERSION` before loading MathJax (done in `texToSvg.ts`, reading
`mathjax-full/package.json`). One line; no polyfills, no entry change, no Metro config.

The historical message (`Cannot read property 'mathjax' of undefined`, commit 95d69c9)
is **not** what I got and I could not reproduce that text, so I can't prove it is the same
bug. Everything else on the checklist was fine under this Hermes: Metro module order /
circular requires (none hit), `js/` modules plus `AllPackages` (no `es5` bundle needed),
RegExp features, `Intl`, `normalize`, `Symbol`, no `document` needed with `liteAdaptor`.
Hermes does print compile *warnings* for `document`/`setTimeout`/`Promise` references
in MathJax's unused browser paths; they're never executed.

## Correctness (352 hand-written snippets)

Corpus: `scripts/hermes-spike/corpus.js` (variables, scripts, fractions, quantifiers,
logic/modal, sets, relations, big operators, delimiters, `\text`, `\mathbb`/`\mathcal`/`\mathbf`,
matrices/cases/align, macros, ~15 malformed or empty, 8 non-ASCII). Written by hand, nothing copied from SEP.

Reference = the WebView engine: `node_modules/mathjax-full/es5/tex-svg-full.js` is
byte-identical to the decoded `src/assets/mathjax-full.b64` (`cmp`-verified), driven with
the same `BOOT_HTML` config (`fontCache:'none'`, `tex2svg`) in headless Chrome 
(not WKWebView).

| Comparison | Result |
|---|---|
| Hermes vs Node `liteAdaptor` (same code path) | **352/352 identical**, including the 11 error cases |
| Hermes vs WebView engine, byte-for-byte | 0/341 (serialization differs: attribute order, `aria-hidden="true"`, `vertical-align:0px` vs `0`) |
| Hermes vs WebView, after normalizing those three | **336/341 identical** (same paths, same viewBox, same width/height in ex) |
| Error cases (malformed TeX) | 11/11 error in both |

Real mismatches (5):

| TeX | WebView w×h (ex) | Hermes w×h (ex) | Cause |
|---|---|---|---|
| `\mathbb{1}` | 0.808×2.149 | 1.357×2.149 | glyph not in the SVG font → fallback `<text>`; width is estimated by liteAdaptor, measured by a browser |
| `é` | 0.955×2.149 | 1.357×2.149 | same (non-ASCII text) |
| `\text{é ü ñ}` | 4.02×2.149 | 5.204×2.149 | same |
| `\text{日本語}` | 6×2.149 | 6.787×2.149 | same |
| `\require{cancel}\cancel{x}` | 2.502×2.233 | 16.74×2.326 | `AllPackages` has no working `\require`; the WebView build (`tex-svg-full`) does. Hermes renders the failed macro as red text |

So "identical SVG on the corpus" is met for ASCII TeX with the serialization caveat,
and **not** met for non-ASCII text-mode glyphs and `\require`. Neither is fixable by
the runtime; they are adaptor/package-set differences (fix `\require` by listing packages
explicitly; the fallback-glyph width is inherent to having no font metrics). Also note
`btoa` throws on non-Latin1 in the SVG — the shim turns that into a per-item error.

## Performance

500 unique templated equations (`gen500.js`; 12 hand-written templates, ~every 9th is display),
3.9 MB of SVG output. Macbook, arm64. Hermes = standalone CLI on precompiled bytecode
(`hermesc -O`), 3 runs; timings are `Date.now()` (1 ms resolution). Chrome = headless
Chrome, same `tex-svg-full.js` as the app asset, `performance.now()`, 3 runs.

| Metric | Hermes (CLI) | Chrome/V8 (WebView engine) |
|---|---|---|
| Init, cold (require MathJax modules + build TeX/SVG jax) | 16–17 ms | 52 ms script eval to ready hook + 6 ms `defaultReady` |
| 500 unique equations, cold | 1401–1462 ms | 296–311 ms |
| Same 500 again, "warm" | 1425–1583 ms | 216–258 ms |
| Per equation p50 / p95 / max (cold) | 3 / 4–5 / 5–10 ms | 0.5 / 1.2 / 8.7 ms |
| Equations over 16 ms | 0 | not recorded |
| Peak RSS of the whole process | 29–35 MB | not measured |
| Time-sliced (6 ms budget): longest slice held | 10–12 ms (212 slices) | n/a |

Reading these:

* Warm ≈ cold: there's no meaningful per-equation cache, so cost is linear in
  equation count (~2.9 ms/equation). A math-heavy article is ~1.5 s of JS-thread
  time on a laptop; a phone will be slower (**not measured**).
* Init is cheap because Hermes lazily compiles from bytecode; the cost moves into
  the first few equations (first 50: 140 ms, same as the last 50, so no big warmup).
* Without slicing, a single equation is ≤10 ms here (inside a 16 ms frame), but a
  batch of 500 is ~1.4 s of blocked thread. With 6 ms budgeted slices the thread is
  held ≤12 ms at a time on this machine. On a phone, per-equation cost may be 2–4×
  higher (assumption, unmeasured), which would break the 16 ms frame for single
  complex equations — hence the slicing is not optional.
* The Chrome column is only the *engine* speed. It excludes everything that makes
  the WebView path slow to start (WKWebView process, file read + `atob`, inject,
  bridge). Those are the thing the `perf` stage timings should be used to measure.

### If tiered math is on (complex-only subset)

A separate branch adds a classifier that renders trivially simple TeX as styled text and
sends only the rest to MathJax. Its `mathTier.ts` is not on this branch, so I used a
**stand-in** (`scripts/hermes-spike/tier-proxy.js`: one token, single-token scripts, one simple
binary operator, no `\frac`/`\text`/environments/etc.). It will not match the real classifier.

| Corpus subset (Hermes CLI, bytecode, 5 passes, `Date.now()`) | Equations | Mean per equation |
|---|---|---|
| All | 352 | 1.07 ms |
| Complex only (what MathJax would still see) | 259 (74%) | 1.23 ms |

So with this proxy, tiering removes 26% of the corpus equations but only about 15% of the
rendering time, since simple equations are the cheap ones. These corpus snippets are shorter than
the 500-equation set above (about 1.1 ms vs about 2.9 ms per equation), and my corpus's
simple/complex mix is not an article mix, so treat the ratio as indicative only. Correctness
mismatches above are all in the complex subset. Re-run with the real classifier once it lands.

## What I could not verify

* **On-device (iOS or Android) anything.** `xcrun simctl` isn't available here
  (only the Command Line Tools are installed) and `ios/Pods` doesn't exist, so I could not
  build or launch the app, run in the simulator, or read `perf` stage timings. So there
  is **no measured cold-first-open comparison** and no scroll-jank measurement; "jank" is
  inferred from slice length on a desktop CPU.
* The standalone `hermes` CLI is the same engine version but a macOS desktop build:
  the CPU is far faster than a phone's, and I did not check whether app-embedded Hermes
  differs (for example if `require` is a global in the app, though the fix avoids that code path anyway).
* The reference engine ran in headless **Chrome**, not WKWebView / Android WebView.
  The SVG path data comes from the same JS, but I did not diff WKWebView output.
* Android, macOS (the repo has a `macos/` target), and the real SEP corpus were not tried.
* Memory: only whole-process peak RSS of the CLI; not app memory, and not the WebView's.

## What it would take to delete the 3 MB asset and the WebView

1. Wire the flag on (`EXPO_PUBLIC_MATH_HERMES=1` → `mathRender.renderMathBatch` takes the Hermes
   branch), run on a device, compare `perf` stages against the WebView on a math-heavy article.
2. Delete `src/components/MathRenderWebView.tsx`, its mount in `App.tsx`, the WebView
   bridge half of `mathRender.ts` (`preloadMathJax`, `_registerInject`, …),
   `src/assets/mathjax-full.b64`, `scripts/genMathjaxBundle.cjs`, the allowlist entry in
   `scripts/check-no-bundled-content.js`, and `react-native-webview` if nothing else uses it.
3. Not free: MathJax enters the JS bundle instead (the CLI `.hbc` for MathJax plus the
   renderer is about 2.3 MB; bundle size vs. the 3 MB asset is roughly a wash, so this does
   not make the download smaller — it removes the WebView work and base64 load, not bytes).
4. Decide `\require`/package set (explicit package list), and the non-ASCII width issue
   (e.g. fall back to the WebView or raw TeX for TeX containing non-Latin1).
5. Bump the backfill gate (`math_inline_v*`) only if the stored SVG serialization is
   meant to change; it need not (sizes are equal on 336/341).

## What's in the branch

* `texToSvg.ts` — sets `PACKAGE_VERSION` (the fix).
* `src/services/mathRenderHermes.ts` — `renderMathBatchHermes`, same shape as `renderMathBatch`,
  time-budgeted slices with injectable clock/yield; flag `EXPO_PUBLIC_MATH_HERMES=1`
  (default off; WebView path unchanged apart from a 2-line early return when the flag is on).
* Tests: `src/services/__tests__/mathRenderHermes.test.ts` (jest/Node: shape, empty,
  malformed/NUL input, encode failure, failure on the second item, slicing, corpus
  of 352 renders and only the known-malformed entries error).
* `scripts/hermes-spike/` — the Hermes harness and corpus (see its README to reproduce).
