// Replace all \(…\) and \[…\] TeX math in raw article HTML with compact <math-i> placeholder
// elements. The SVGs are stored in the `math` table by hash, so content_html stays small: no
// inlined base64, no multi-MB HTML. (UC-C6)
//
// `priority` null = the caller already owns the schedule (the syncCachedArticles awaitMath path
// runs under its own 'download' hold, so gating on it would wait forever); chunks and slices then
// only yield a macrotask.
//
// Tiered math (flag-gated, default off): trivially simple TeX becomes styled text in the line and
// only the remainder is typeset. The flag is the `tiered_math` meta pref ('1' on, '0' off);
// anything else falls back to TIERED_MATH_DEFAULT (see docs/tiered-math.md).
import type { KeyValueStore } from './ports';
import type { EnsureResult, MathSpotInput } from './mathCache';
import type { MathSlice } from './mathPacing';
import type { MathPriority } from '../utils/mathThrottlePolicy';
import { decodeEntities } from '../utils/sepPage';
import { classifySimpleTex, TIERED_MATH_DEFAULT } from '../utils/mathTier';
import { mathHash } from '../utils/mathKey';

const MATH_SUBST_SOURCE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/.source;

export interface SubstituteMathDeps {
  /** The equation cache: make sure every equation is stored, rendering only what is missing. */
  ensureMath(spots: MathSpotInput[], priority: MathPriority | null): Promise<Pick<EnsureResult, 'dims' | 'complete'>>;
  meta: Pick<KeyValueStore, 'getMeta'>;
  /** A time slice for the splice loop (from the pacing module). */
  mathSlice(priority: MathPriority | null): MathSlice;
}

/** Whether tiered math is on: the meta pref when set, otherwise the build default. */
export async function tieredMathEnabled(meta: Pick<KeyValueStore, 'getMeta'>): Promise<boolean> {
  try {
    const v = await meta.getMeta('tiered_math');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* fall through to default */ }
  return TIERED_MATH_DEFAULT;
}

export type SubstituteMath = (html: string, priority?: MathPriority | null) => Promise<string>;

export function createSubstituteMath(deps: SubstituteMathDeps): SubstituteMath {
  return async function substituteMath(html: string, priority: MathPriority | null = 'current'): Promise<string> {
    const spots: Array<{ index: number; len: number; tex: string; display: boolean }> = [];
    const re = new RegExp(MATH_SUBST_SOURCE, 'g');   // fresh per call: no lastIndex state shared between calls
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const inline = m[1];
      const block = m[2];
      spots.push({
        index: m.index,
        len: m[0].length,
        tex: decodeEntities((inline ?? block).trim()),
        display: block !== undefined,
      });
    }
    if (!spots.length) return html;

    // Tiering (flag-gated): trivially simple TeX becomes styled text in the line; only
    // the remainder is typeset by MathJax. Fail closed: null means MathJax.
    const tiered = (await tieredMathEnabled(deps.meta))
      ? spots.map(s => classifySimpleTex(s.tex, s.display))
      : spots.map(() => null);
    const mjSpots = spots
      .filter((_, i) => tiered[i] === null)
      .map(s => ({ tex: s.tex, display: s.display }));

    // Dedupe, look up what the math table already holds, render only the missing
    // unique equations (each chunk stored before the next is requested). If any
    // equation is still missing (renderer timed out), leave the article untouched
    // and pending; rewriting is the idempotent last step and needs no rendering.
    const { dims, complete } = mjSpots.length
      ? await deps.ensureMath(mjSpots, priority)
      : { dims: new Map<string, { w: number; h: number }>(), complete: true };
    if (!complete) return html;
    const slice = deps.mathSlice(priority);

    let out = html;
    for (let i = spots.length - 1; i >= 0; i--) {
      await slice.checkpoint(); // yield the JS thread when this slice's time budget is spent
      const { index, len, display, tex } = spots[i];
      const text = tiered[i];
      if (text !== null) {
        out = out.slice(0, index) + text + out.slice(index + len);
        continue;
      }
      const hash = mathHash(tex, display);
      const d = dims.get(hash);
      if (!d) continue; // unrenderable TeX stays as raw text
      // Tiny placeholder — no base64 in HTML.
      const tag = `<math-i hash="${hash}" d="${display ? '1' : '0'}" w="${d.w.toFixed(4)}" h="${d.h.toFixed(4)}"></math-i>`;
      out = out.slice(0, index) + tag + out.slice(index + len);
    }
    return out;
  };
}
