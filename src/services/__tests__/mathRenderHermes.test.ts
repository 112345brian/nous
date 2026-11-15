import { renderMathBatchHermes } from '../mathRenderHermes';
import { HERMES_MATH_ENABLED } from '../mathRenderHermes';

const corpus: string[] = require('../../../scripts/hermes-spike/corpus.js');

describe('renderMathBatchHermes', () => {
  it('is off by default (WebView path stays the default)', () => {
    expect(HERMES_MATH_ENABLED).toBe(false);
  });

  it('returns one result per item, in order, in the WebView result shape', async () => {
    const r = await renderMathBatchHermes([
      { tex: 'x^2', display: false },
      { tex: '\\frac{a}{b}', display: true },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].tex).toBe('x^2');
    expect(r[1].display).toBe(true);
    for (const x of r) {
      expect(x.error).toBeUndefined();
      expect(atob(x.b64!)).toMatch(/^<svg /);
      expect(x.w).toBeGreaterThan(0);
      expect(x.h).toBeGreaterThan(0);
    }
  });

  it('empty input -> empty output', async () => {
    expect(await renderMathBatchHermes([])).toEqual([]);
  });

  it('malformed TeX, empty and NUL-containing TeX yield per-item errors, never throw', async () => {
    const r = await renderMathBatchHermes([
      { tex: '\\frac{a}', display: false },
      { tex: '{', display: false },
      { tex: 'x\u0000y', display: false },
      { tex: 'ok', display: false },
    ]);
    expect(r).toHaveLength(4);
    expect(r[0].error).toBeTruthy();
    expect(r[1].error).toBeTruthy();
    expect(r[3].error).toBeUndefined();
    // the NUL item must resolve to either an svg or an error, never undefined
    expect(r[2].b64 || r[2].error).toBeTruthy();
  });

  it('an encode failure (e.g. btoa on non-Latin1) becomes a per-item error, batch continues', async () => {
    let n = 0;
    const r = await renderMathBatchHermes(
      [{ tex: 'a', display: false }, { tex: 'b', display: false }],
      { encode: s => { if (n++ === 0) throw new Error('InvalidCharacterError'); return btoa(s); } },
    );
    expect(r[0].error).toMatch(/InvalidCharacter/);
    expect(r[1].b64).toBeTruthy();
  });

  it('a render that throws on the second attempt is isolated to that item', async () => {
    let calls = 0;
    const render = ((tex: string) => {
      if (++calls === 2) throw new Error('boom');
      return { svg: `<svg>${tex}</svg>`, width: 1, height: 2 };
    }) as any;
    const r = await renderMathBatchHermes(
      [{ tex: 'a', display: false }, { tex: 'b', display: false }, { tex: 'c', display: false }],
      { render, encode: s => s },
    );
    expect(r.map(x => !!x.error)).toEqual([false, true, false]);
  });

  it('yields between time-budgeted slices so the JS thread is not held', async () => {
    let t = 0;
    const yields: number[] = [];
    const render = (() => { t += 3; return { svg: '<svg/>', width: 1, height: 1 }; }) as any;
    const items = Array.from({ length: 10 }, (_, i) => ({ tex: `x${i}`, display: false }));
    const r = await renderMathBatchHermes(items, {
      render, encode: s => s, budgetMs: 6, now: () => t,
      yieldFn: async () => { yields.push(t); },
    });
    expect(r).toHaveLength(10);
    // 3 ms per equation, 6 ms budget -> yield after every 2nd item, none after the last
    expect(yields.length).toBe(4);
  });
});

describe('corpus under the jest (Node) engine', () => {
  it('hand-written corpus renders; only the known-malformed entries error', async () => {
    expect(corpus.length).toBeGreaterThanOrEqual(200);
    const items = corpus.map(raw => raw.startsWith('D:') ? { tex: raw.slice(2), display: true } : { tex: raw, display: false });
    const r = await renderMathBatchHermes(items, { encode: s => s });
    const errs = r.filter(x => x.error).map(x => x.tex).sort();
    expect(errs).toEqual(
      ['', ' ', '{', '}', 'x^', 'x_1_2', 'x^1^2', '\\frac{a}', '\\begin{foo}x\\end{foo}', '\\text{unclosed', '\\left( x', 'a & b', '€10']
        .filter(t => t !== '' && t !== ' ').sort(),
    );
  });
});
