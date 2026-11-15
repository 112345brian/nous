// Pre-render the curated generic formulas (src/data/commonMath.ts) into the
// `math` table so the first articles find them cached. Everything heavy is
// reused: ensureMath (src/services/mathCache.ts) hashes with mathHash /
// normalizeTex (src/utils/mathKey.ts), dedupes, skips hashes already stored,
// renders the rest in chunks gated by the priority model, and persists every
// chunk before requesting the next. This file adds only the list-specific
// part: the version stamp, so the work happens once per list version.
//
// Dependencies are injected so it is testable with fakes; the real wiring is
// commonMathWiring.ts.

export interface PrewarmEnsureResult {
  /** True when every equation is stored or definitively unrenderable. */
  complete: boolean;
  stats?: { spots: number; unique: number; alreadyStored: number; rendered: number };
}

export interface PrewarmDeps {
  list: ReadonlyArray<{ tex: string; display: boolean }>;
  /** Version stamp of the list (commonMathStamp). */
  stamp: string;
  /** mathCache.ensureMath bound to the lowest priority ('background'). */
  ensure(spots: Array<{ tex: string; display: boolean }>): Promise<PrewarmEnsureResult>;
  getStamp(): Promise<string | null>;
  setStamp(stamp: string): Promise<void>;
}

export interface PrewarmResult {
  status: 'current' | 'done' | 'partial';
  stats?: PrewarmEnsureResult['stats'];
}

/**
 * No-op when the stamp is current. Otherwise ensures the list is stored and
 * records the stamp only if that completed; a partial run (hung engine, a hold
 * that never lifted before exit, chunk failures) is retried on the next launch,
 * where cached hashes are skipped. Errors propagate (the idle scheduler reports
 * and swallows them) and leave the stamp unset.
 */
export async function prewarmCommonMath(deps: PrewarmDeps): Promise<PrewarmResult> {
  if ((await deps.getStamp()) === deps.stamp) return { status: 'current' };
  const r = await deps.ensure(deps.list.map(e => ({ tex: e.tex, display: e.display })));
  if (!r.complete) return { status: 'partial', stats: r.stats };
  await deps.setStamp(deps.stamp);
  return { status: 'done', stats: r.stats };
}
