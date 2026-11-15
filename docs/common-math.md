# Common-math pre-warm

`src/data/commonMath.ts` is a curated list of generic, textbook-standard formulas
(Bayes' theorem and variants, expected utility, De Morgan, set identities, quantifier
negation, Kripke semantics clauses, ...). On first launch they are rendered on-device
(MathJax in the hidden WebView) at the lowest scheduler priority and cached in the
`math` table, so the first articles that contain the same TeX find it cached.

## Licensing

Hand-authored generic formulas only. No SEP text is committed and no rendering is
committed; SVGs exist only in the on-device cache. See the exemption clause in
`AGENTS.md`. The survey below prints counts only.

## Survey (counts only; sample of 25 public SEP entries + 2 pages that 404'd)

Sampled areas: classical/modal/intuitionistic/propositional/conditional/inductive logic,
set theory, category theory, model theory, computability, probability, Bayesian and formal
epistemology, decision theory, game theory, social choice, confirmation, causal models,
philosophy of mathematics, structuralism. Pages were fetched at one request per second to a
temp directory (never the repo) and deleted afterwards. Re-run with
`node scripts/commonMathSurvey.cjs <pagesDir> [--list list.json]`.

| measure | count |
|---|---|
| entries with math | 23 of 25 (2 more pages were 404s) |
| equation occurrences | 12,395 |
| distinct equations (whitespace-normalized) | 4,260 |
| distinct, in ≥2 articles | 182 (5,557 occurrences) |
| distinct, in ≥3 articles | 90 (4,830 occurrences) |
| distinct, in ≥5 articles | 54 (4,188 occurrences) |

The most-shared equations are overwhelmingly single symbols (`A`, `B`, `P`, `n`, ...),
which the tiered-math classifier renders as styled text. Of the 12,395 occurrences,
8,139 (65.7%) are inline TeX that `classifySimpleTex` (branch `claude/tiered-math-40e587`)
accepts, leaving 4,256 that need MathJax.

Concept frequency (distinct articles containing the construct, occurrences in parentheses):
`\mid` 18 (622), negation 15 (591), `\wedge`/`\vee` 14 (551), implication arrows 17 (574),
`\forall` 9 (193), `\exists` 10 (161), `\vdash` 6 (202), `\models`/`\vDash` 6 (183),
`\Box`/`\Diamond` 6 (196), `\frac` 11 (128), `\sum` 10 (45), `\subseteq` 8 (60), `\cup` 10 (45).

## Coverage of the list (how many occurrences it would have covered)

The cache key is the exact (whitespace-normalized) TeX plus the display flag, so the list
only helps where an article's string equals ours character for character. Notation was
chosen by common textbook convention (`\mid`, `\neg`, `\wedge`, `\vee`, `\rightarrow`,
`\vDash`), not tuned to match SEP strings.

| | count |
|---|---|
| list entries | 266 (excludes inline entries the tiered-math classifier already handles) |
| entries that occur verbatim in the sample | 13 |
| occurrences covered verbatim | 108 of 12,395 (0.87%) |
| ... of the 4,256 occurrences that need MathJax | 108 (2.5%) |
| occurrences covered if all spaces were ignored (upper bound) | 111 (0.90%) |

Takeaway: with exact-string keys the list gives a small hit rate on this sample. SEP
authors write equations with article-specific symbols, macros (`\amp`, `\bF`, ...) and
spacing. A bigger win would need a canonicalizing hash (whitespace/macro normalization) or
per-fragment rendering, not a longer list. Whether pre-warming makes first articles faster
on a device has NOT been measured.

## Pre-warm mechanics

- `prewarmCommonMath(deps, {maxChunks})` (`src/services/prewarmCommonMath.ts`): dependencies
  injected (hash, cache lookup, render, write, stamp). Skips cached hashes, renders the rest
  in chunks of 8 (`renderMathBatch`), writes each chunk (`putMathBatch`) before the next,
  stamps completion only when nothing is missing or failed, and does nothing at all when the
  stamp is current. A chunk that renders nothing ends the run.
- Stamp: `commonMathStamp()` derives a hash of the list, stored in `meta` key
  `common_math_prewarm`; the pre-warm reruns only when the list changes.
- `src/services/commonMathWiring.ts` is the single integration point, called once from
  `App.tsx` after the other idle tasks are queued. On the plain scheduler each chunk is its
  own task that re-queues the next, so `hold()` / `noteActivity()` gate every chunk.
- Switching to math-throttle's priority API: schedule one task and pass
  `beforeChunk: () => idleScheduler.yieldThenMayRun('background')` (see the comment in the
  wiring file). The plain scheduler does not gate downloads; math-throttle's `hold('download')`
  does, and `downloadAll` / sync / seed import must take it.
