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

## Existing cached articles — re-derive, no backfill
The app is prerelease (no users, no old articles or annotations to preserve), so there is one code path:
tiering applies to **every** article when the flag is on. There is no "new articles only" mode and no backfill.
- `db.ts` `initSchema` records `math_tier_stamp` = `off` or `on:<MATH_TIER_VERSION>` (`mathTier.ts`).
  When the effective state differs from the stored stamp (flag flipped, or `MATH_TIER_VERSION` bumped because the
  classifier output changed), cached article content (html, ast, toc, preamble, notes, excerpt, `cached_at`) is
  cleared and `math_pending` / math backfill flags are dropped, so articles re-fetch and re-process. Same pattern as
  `ast_parser_version`. First run only records the stamp; nothing is cleared.
- The `tiered_math` meta pref overrides `TIERED_MATH_DEFAULT`; a change takes effect (and clears) on the next launch.
  Bump `MATH_TIER_VERSION` whenever the whitelist or emitted markup changes.
- `content_hash` is set by `cacheArticle` from the HTML it is given and not changed by deferred math. Re-fetching
  gives a new hash, so annotations made before are checked by `partitionAnnotations` and, if orphaned, re-anchored.

### Annotations
- Annotations must still survive a real SEP revision (orphan/re-anchor logic unchanged except one addition below).
- A selection that spans tiered math has rendered text (`Then x₁ holds`). The stored HTML has `<em>x</em>₁`, so the
  raw substring scan and the old re-anchor missed it. `tryReanchor` now retries against the tag-stripped,
  entity-decoded HTML when the raw attempt fails. Covered in `tieredMath.test.ts` (revision re-anchors; changed text
  still orphans).
- A complex (SVG) equation has no selectable text: it contributes nothing to `selected_text`, so the anchor is the
  text on either side, and a revision that replaces the equation in place is not noticed. The obvious stable anchor is
  the TeX source (or its `mathHash`) stored with the annotation; **not built** (it needs selection to know the equation).

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
