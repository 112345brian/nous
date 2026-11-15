# Handoff: finish the core (Nous)

Read this first, then `docs/core-di-audit.md` (sections 3, 4, 8) and `docs/use-cases.md` section 3.

## Goal

Make the app's logic run and test without a device: every use case in `src/core` taking its
dependencies as parameters (ports), every adapter in `src/services`, one composition root
(`src/composition.ts`), the UI importing nothing from `src/services`. Tests enforce it.

## State (verified, not a claim)

- Branch `claude/laughing-maxwell-cbbfd8`, worktree
  `/Users/BrianP/programming/nous/.claude/worktrees/laughing-maxwell-cbbfd8`, tip `75ac41b`.
  17 commits ahead of `claude/repo-architecture-review-da3bba`, 0 behind. **Not pushed.**
- Gate on a real `npm ci --legacy-peer-deps --ignore-scripts`: `npx tsc --noEmit` clean,
  `npx eslint .` 0 errors (117 style warnings), `npx jest` 1068/1068 in 89 suites,
  `node scripts/check-no-bundled-content.js` passes. A fresh worktree has no `node_modules`.
- All six child slices are merged: seed import, notifier/prefetch/secrets, math render bridge,
  graph/InPhO, UI off `services/db`, pure logic out of `db.ts`. Their sessions are idle.
- The rings and rules are in `src/utils/__tests__/innerRing.test.ts` (inner ring and core: no I/O,
  no globals, no module state, no React/Expo, no exceptions) and
  `src/__tests__/compositionRoot.test.ts` (RC2 adapters never import the root; RC3 only the root
  value-imports core use cases; RC4 UI takes use cases from the root; RC5 UI imports nothing from
  `src/services`).

## Method that worked (use it for every slice)

1. grep every caller; check other branches and worktrees for overlap first (`git for-each-ref`,
   `git status` in the other worktrees).
2. Write characterization tests against the CURRENT behavior first; run them green.
3. Move logic into `src/core` (ports as parameters), keep the adapter thin, wire ONLY in
   `composition.ts`, keep exported names working through the root.
4. Fake-based core tests with `Date.now`/`setTimeout`/`fetch` made to throw; one deliberate
   mutation of a key behavior must be caught.
5. Full gate (above), commit, do not push.

## Traps

- zsh mangles `$REF:path`; write `"${REF}:path"`. `--include=*.ts` fails to expand in zsh.
- New worktrees are cut from `main`, not from your branch: merge your branch first.
- Do not merge another session's branch unless the user says so.
- Licensing (`AGENTS.md`, `NOTICE.md`): never bundle SEP text or InPhO data.

## Open items (the known remainder, section 8 of the audit)

1. **Make `src/services/db.ts` an injected instance.** It holds the connection (`_open`,
   `_closing`) and two caches (`metaCache`, `_linkCache`) and composes the core's migration
   runner and merge rules over its own handle (the two recorded RC3 exceptions:
   `services/db.ts` and the re-export `services/migrations.ts`). Plan: a
   `createDb({ migrate, mergeAnnotation, mergeRead, ... })` factory; the root builds it and passes
   `getDb` to `graphDb`, `seedImport` and the rest; delete the re-export; empty
   `WIRING_EXCEPTIONS`. Largest remaining change.
2. Two lazily initialised adapters keep state by design: `services/texToSvg.ts` (MathJax engine)
   and `services/secureSecrets.ts` (lazy `require`, must stay lazy). Leave unless item 1 changes
   the picture.
3. Suspected bugs, pinned in tests but NOT fixed (section 7 of the audit): a failed download counts
   as done; an offline sync still records `last_deep_sync`; the article-request abort timer is
   cleared before the body is read; an offline first launch stamps the bundled seed as fresh.
   Each has a test that pins the current behavior: flip it when you fix.
4. Not merged on purpose: `origin/new-spinner` (older, unrelated UI feature touching HomeScreen and
   GraphScreen); `claude/heuristic-torvalds-bc24e0` (only pins `react-native-worklets`, already pinned).
5. `scripts/test-download.mjs`, `scripts/buildEntrySeed.js`, `scripts/auditCorpus.cjs` still carry
   copies of the page-extraction helpers (canonical in `src/utils/sepPage.ts`).

## Next step

The parent session (`claude/repo-architecture-review-da3bba`) merges this branch. After that: item 1,
then item 3 one bug at a time (each with its pinned test flipped).
