import { COMMON_MATH, commonMathStamp } from '../commonMath';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { texToSvg } = require('../../../scripts/renderMath.cjs');

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('COMMON_MATH', () => {
  it('has 100-300 entries', () => {
    expect(COMMON_MATH.length).toBeGreaterThanOrEqual(100);
    expect(COMMON_MATH.length).toBeLessThanOrEqual(300);
  });

  it('has no duplicates after whitespace normalization', () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const e of COMMON_MATH) {
      const k = (e.display ? 'D' : 'I') + norm(e.tex);
      if (seen.has(k)) dups.push(e.tex);
      seen.add(k);
    }
    expect(dups).toEqual([]);
  });

  it('has well-formed entries', () => {
    for (const e of COMMON_MATH) {
      expect(typeof e.tex).toBe('string');
      expect(e.tex.trim().length).toBeGreaterThan(0);
      expect(typeof e.display).toBe('boolean');
      expect(e.tex).not.toMatch(/\0/);
    }
  });

  it('renders every entry through MathJax with no error or merror', () => {
    const bad: string[] = [];
    for (const e of COMMON_MATH) {
      const r = texToSvg(e.tex, e.display);
      if (r.error || !r.svg || /merror|data-mjx-error/.test(r.svg)) bad.push(e.tex);
    }
    expect(bad).toEqual([]);
  }, 120000);

  it('stamp changes when the list changes and is stable otherwise', () => {
    expect(commonMathStamp()).toBe(commonMathStamp(COMMON_MATH));
    expect(commonMathStamp([...COMMON_MATH, { tex: 'q', display: false }])).not.toBe(commonMathStamp());
    expect(commonMathStamp(COMMON_MATH.slice(1))).not.toBe(commonMathStamp());
    const edited = COMMON_MATH.map((e, i) => (i === 0 ? { ...e, display: !e.display } : e));
    expect(commonMathStamp(edited)).not.toBe(commonMathStamp());
  });
});
