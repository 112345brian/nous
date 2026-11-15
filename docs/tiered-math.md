# Tiered math rendering

Trivially simple TeX (single variables, digits, `x_1`, `p \to q`, …) is shown as styled
text in the line. Everything else still goes through MathJax → SVG → `<math-i>`.
**Default OFF**; not verified on a device (see "Not verified").

## Design
- `src/utils/mathTier.ts` — pure classifier (no I/O, no RN, no clock/random).
  `classifySimpleTex(tex, display)` → inline-HTML string or `null` (= use MathJax).
  `analyzeSimpleTex` returns `{ok:false, reason}` for tooling (coverage script).
- `substitutemath` (`src/services/catalog.ts`): per TeX spot, classifier first; only the
  `null` remainder is sent to `renderMathBatch`. The `<math-i>` path, `putMathBatch`, and
  deferred math (`completeArticleMath`, `math_pending`) are unchanged. If the MathJax
  remainder returns nothing (timeout) the function returns the HTML untouched, so the
  article stays pending exactly as before — never "done" with raw TeX left.
- Markup emitted is `<em>` + text only; `parseSepHtml` already handles it (tested). No new AST node.

## Deviation from the brief: no `<sub>`/`<sup>`
The reader renders both as `scriptStyle` = body font × 0.75 with **no baseline shift**
(`Inline.tsx`; React Native has none). `x_1` and `x^1` would both look like a small `x1`.
So scripts are emitted as **Unicode script characters** (`x₁`, `d₂₂`, `x²`, `xⁿ`). A script
containing a character with no Unicode form (uppercase, Greek, most sup letters) → `null`.
Sub: `0-9 + - = ( )` and `a e h i j k l m n o p r s t u v x`. Sup: `0-9 + - = ( )` and `i n`.

## Whitelist (ASCII only, ≤120 chars, inline only)
Letters (italic, runs merged), digits/decimals (upright), `+ - = < > / ! ( ) [ ] , '`
(`-`→`−`, `'`→`′`, thin spaces U+2009 around binary ops/relations, after commas; unary
minus unspaced), `\{ \}`, `\,`, Greek `\alpha…\omega`, `\Gamma…\Omega` (+ var forms), logic/set/relation
symbols (`\forall \exists \neg \lnot \land \wedge \lor \vee \to \rightarrow \leftarrow \leftrightarrow
\Rightarrow \Leftarrow \Leftrightarrow \in \notin \ni \subset \subseteq \supset \supseteq \cup \cap \top \bot
\vdash \models \vDash \nvdash \leq \le \geq \ge \neq \ne \equiv \approx \sim \times \cdot \pm \setminus \circ
\oplus \otimes \emptyset \varnothing \infty \Box \Diamond \langle \rangle \ldots`), and single-token or flat
`{…}` sub/superscripts as above.
## Fail-closed rule
Anything not matched returns `null`: unknown macros (`\frac \sqrt \text \mathbb \mathcal \mathbf \left`…),
bare `{}` groups, nested scripts, double scripts, script without base, unbalanced brackets/braces,
non-ASCII or control chars, empty/over-long input, display math, non-strings. The entry point wraps the
analysis in try/catch → `null`. Tests loop 5,000 random strings and require no throw and escaped output.

## Cached articles — decision: do NOT rewrite
Tiering applies only to articles processed after the flag is on. Facts from the code:
- `entries.content_hash` is set in `cacheArticle` from the HTML passed then, and `updateArticleHtml`
  (used when deferred math completes) does not touch it. So deferred math, SVG or tiered, never
  changes the hash; annotations with a matching hash stay valid.
- On the `awaitMath` path the hash is of the already-substituted HTML, so toggling the flag and
  re-fetching changes the hash; `partitionAnnotations` then falls back to `html.includes(selected_text)`.
- That fallback is a raw HTML substring match. A selection spanning an equation fails with `<math-i>`
  *and* with `<em>` markup alike; text next to equations matches in both. Tests cover both.
- Backfill risks: text offsets of highlights inside the article shift (equation text now exists in
  the flow), and a cached article would flip between SVG and text mid-reading. Safe path if wanted later:
  a meta-guarded one-shot like `backfillMathInline`, run only for articles with zero annotations
  (check the `annotations` table first), re-deriving from fetched TeX — which cached `<math-i>` no longer
  contains, so it needs a re-fetch. Not implemented.
- `backfillMathInline` (legacy articles still holding raw TeX) goes through `substitutemath`, so with the flag on
  those get tiered too; they are being rewritten anyway.

## How to enable
Runtime: `await setMeta('tiered_math', '1')` (`'0'` forces off). Default: `TIERED_MATH_DEFAULT` in `catalog.ts`.
Takes effect for the next processed article.

## Measured coverage (counts only; fetched pages kept outside the repo)
`node scripts/mathTierCoverage.cjs <dir>` on pages fetched from plato.stanford.edu (logic-classical,
set-theory, russell-paradox): 2,704 equations, **2,135 simple (79.0%)**; unique 899, 561 simple (62.4%).
Per article: logic-classical 84% of 1,560; set-theory 73% of 763; russell-paradox 70% of 381.
Top rejects: stray chars (`|`, `:`, `;`, …), nested/unmappable scripts, unbalanced brackets (intervals),
custom macros (`\LKe`, `\amp`), `\mathbb`, `\aleph`, display (47), `\mathcal`, `\not`. A few of those
(`\mathbb{N}`, `|x|`, `\aleph`) are cheap whitelist additions if wanted.
Percentages are by equation count, not weighted by cost; I did not measure any speedup.

## Glyph risk (unverified — from font knowledge, not tested)
- Thin space U+2009: generally fine. `ϵ ϑ ϖ ϱ ϕ` (Greek variants): fine on iOS/macOS; Android Roboto covers most.
- `⊢ ⊨ ⊬ ⊤ ⊥ ∀ ∃ ∈ ∉ ∪ ∩ ⊆ ⊂ ≤ ≥ ≠ ≡ ≈ ∼ ∖ ⊕ ⊗ ∘ ⋅ ∞`: iOS/macOS fine via system fallback; Android mostly via Noto Symbols/Math fallback, Roboto itself lacks several (`⊢ ⊨ ⊤ ⊥ ⊕ ⊗ ∖`) → may fall back to a different-weight font or tofu on older devices.
- `⟨ ⟩ □ ◇ ⇒ ⇔ ⇐`: likely OK on Apple; `⟨⟩` and `◇` the riskiest on Android.
- Unicode sub/sup: digits and `+−=()` and `ⁱⁿ` ok nearly everywhere. Subscript letters (U+2090–209C, `ᵢⱼᵣᵤᵥ`) are the weakest: expect mismatched size or missing glyphs on some Android/macOS fonts.
- No test of italic fallback: italic style on a fallback-font symbol is synthesized/ignored.

## Known fidelity gaps vs MathJax
Spacing is thin everywhere (MathJax uses medium/thick for binary/relations); no math font (italic of the body
serif); real sub/sup positioning impossible, only Unicode glyphs; `x_12` correctly splits as `x₁2`; line breaks can fall
at thin spaces; text selection/annotation now includes equation characters; letters and Greek italic only via `<em>`.

## Not verified
No device or simulator rendering (iOS, Android, macOS). Glyph availability, script glyph sizes, line breaking and
visual spacing are untested. Flag stays OFF until someone looks at a logic-heavy article on a device. Baseline unchanged:
tsc clean, jest 11 failures / 7 suites (mockup/* and App.test.tsx) before and after.
