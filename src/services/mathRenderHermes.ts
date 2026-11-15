// DEV-ONLY spike: typeset TeX → SVG with MathJax running directly in the Hermes
// JS runtime (no WebView, no 3 MB asset). Same call shape and result shape as
// mathRender.renderMathBatch, so it can stand in for it behind a flag.
// See docs/mathjax-hermes-spike.md for numbers and the recommendation.
//
// Rendering is synchronous per equation, so a batch is cut into time-budgeted
// slices with a yield between them; the JS thread is never held longer than
// about one slice plus one equation.

import { texToSvg } from '../utils/sepHtml/render/texToSvg';
import type { MathReq, MathResult } from './mathRender';

/** Build-time flag. Off by default; the WebView path is untouched when off. */
export const HERMES_MATH_ENABLED = process.env.EXPO_PUBLIC_MATH_HERMES === '1';

export interface HermesMathOptions {
  /** Max time spent rendering before yielding to the event loop. */
  budgetMs?: number;
  now?: () => number;
  /** Resolves on the next turn of the event loop. */
  yieldFn?: () => Promise<void>;
  /** SVG → base64 (default: global btoa). Throwing yields a per-item error. */
  encode?: (svg: string) => string;
  /** Test seam; defaults to the real renderer. */
  render?: typeof texToSvg;
}

const defaultYield = () => new Promise<void>(r => setTimeout(r, 0));

export async function renderMathBatchHermes(
  items: MathReq[],
  opts: HermesMathOptions = {},
): Promise<MathResult[]> {
  const budget = opts.budgetMs ?? 6;
  const now = opts.now ?? (() => Date.now());
  const yieldFn = opts.yieldFn ?? defaultYield;
  const encode = opts.encode ?? ((s: string) => btoa(s));
  const render = opts.render ?? texToSvg;

  const out: MathResult[] = new Array(items.length);
  let sliceStart = now();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const base = { tex: it.tex, display: it.display };
    try {
      const r = render(it.tex, it.display);
      if ('error' in r) out[i] = { ...base, error: r.error };
      else out[i] = { ...base, b64: encode(r.svg), w: r.width ?? 1, h: r.height ?? 1 };
    } catch (e) {
      out[i] = { ...base, error: String((e as Error)?.message ?? e) };
    }
    if (i < items.length - 1 && now() - sliceStart >= budget) {
      await yieldFn();
      sliceStart = now();
    }
  }
  return out;
}
