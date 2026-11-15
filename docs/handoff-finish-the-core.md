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

## Status: finished

Done on `claude/core-handoff-docs-0904e3` (cut from `main`, then merged `claude/laughing-maxwell-cbbfd8`):

1. **`services/db.ts` is an injected instance** (`createDb(deps)`, built once in `composition.ts`).
   Migration runner, merge rules, clock, uid, secure store and bundled link map are dependencies.
   `getDb`/`closeDb` are handed to `graphDb` and the seed import. `services/migrations.ts` is deleted,
   `WIRING_EXCEPTIONS` is empty. Tests: `helpers/testDb.ts`, `helpers/mockDbModule.ts`, `db.instance.test.ts`.
2. `texToSvg.ts` and `secureSecrets.ts` keep their lazy state by design (unchanged).
3. The four pinned bugs are fixed, each with its test flipped: failed downloads no longer count as
   done, an all-failed sync no longer records `last_deep_sync`, the abort timer now covers the body,
   and the bundled seed is no longer stamped as a fresh index.
4. Not merged on purpose, as before: `origin/new-spinner`, `claude/heuristic-torvalds-bc24e0`.
5. The script copies of the page helpers stay (plain node cannot import TS) but
   `src/utils/__tests__/scriptHelpersDrift.test.ts` now fails if one drifts.

Still open (small): `~` expansion of the sync folder needs a device check (audit section 7). The
non-numeric `index_refreshed_at` bug is fixed: a non-finite timestamp now counts as stale.
