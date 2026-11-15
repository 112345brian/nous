// Hand-written TeX fixtures only — no equations are taken from SEP articles.
import { classifySimpleTex, analyzeSimpleTex } from '../mathTier';
import { parseSepHtml } from '../sepHtml/parse';

const T = ' ';
const c = (tex: string) => classifySimpleTex(tex, false);

describe('accepts (exact markup)', () => {
  const cases: Array<[string, string]> = [
    ['x', '<em>x</em>'],
    ['xy', '<em>xy</em>'],
    ['7', '7'],
    ['3.5', '3.5'],
    ['7+4', `7${T}+${T}4`],
    ['x/y', '<em>x</em>/<em>y</em>'],
    ['x = y', `<em>x</em>${T}=${T}<em>y</em>`],
    ['a<b', `<em>a</em>${T}&lt;${T}<em>b</em>`],
    ['a>b', `<em>a</em>${T}&gt;${T}<em>b</em>`],
    ['-x', '−<em>x</em>'],
    ['x=-1', `<em>x</em>${T}=${T}−1`],
    ['x-y', `<em>x</em>${T}−${T}<em>y</em>`],
    ["f'(x)", '<em>f</em>′(<em>x</em>)'],
    ['f(x,y)', `<em>f</em>(<em>x</em>,${T}<em>y</em>)`],
    ['\\alpha', '<em>α</em>'],
    ['\\Gamma', 'Γ'],
    ['\\forall x', '∀<em>x</em>'],
    ['\\neg p', '¬<em>p</em>'],
    ['p \\land q', `<em>p</em>${T}∧${T}<em>q</em>`],
    ['p \\to q', `<em>p</em>${T}→${T}<em>q</em>`],
    ['x \\in A', `<em>x</em>${T}∈${T}<em>A</em>`],
    ['A \\subseteq B', `<em>A</em>${T}⊆${T}<em>B</em>`],
    ['\\top', '⊤'],
    ['\\Gamma \\vdash \\varphi', `Γ${T}⊢${T}<em>φ</em>`],
    ['x_1', '<em>x</em>₁'],
    ['d_{22}', '<em>d</em>₂₂'],
    ['x_{ij}', '<em>x</em>ᵢⱼ'],
    ['x^2', '<em>x</em>²'],
    ['x^{n}', '<em>x</em>ⁿ'],
    ['x_1^2', '<em>x</em>₁²'],
    ['x^2_1', '<em>x</em>²₁'],
    ['x_12', '<em>x</em>₁2'], // TeX: only the first char is the subscript
    ['\\{x\\}', '{<em>x</em>}'],
  ];
  it.each(cases)('%s', (tex, html) => expect(c(tex)).toBe(html));
});

describe('rejects (null → MathJax)', () => {
  const cases = [
    '\\frac{a}{b}', '\\sqrt{x}', '\\text{if}', '\\mathbb{R}', '\\mathcal{L}', '\\mathbf{v}',
    '\\begin{matrix}a\\end{matrix}', '\\newcommand{\\a}{b}', '\\sum_{i=1}^n x', '\\sin x',
    'x_{1_2}', 'x_{a^b}', 'x^{\\alpha}', 'x_A', 'x^q', 'x_', 'x^', '_1', '^2', 'x_1_2', 'x^1^2',
    '{x}', 'x}', '{x', '(x', 'x)', '(x]', '\\{x', 'x_{1', 'x_{}', '|x|', 'x:y', 'x;y', 'x\\\\y',
    '\\', '\\unknown', '∀x', 'é', 'x\u0000y', 'x​', '', '   ', '\\,', "'", 'x & y', '$x$', 'x%',
    '\\left(x\\right)', '\\ ', '\\!', 'x~y', 'x\\over y',
  ];
  it.each(cases)('%j', tex => expect(c(tex)).toBeNull());
  it('display math always null', () => {
    expect(classifySimpleTex('x', true)).toBeNull();
    expect(analyzeSimpleTex('x', true)).toEqual({ ok: false, reason: 'display' });
  });
  it('over-long input is rejected', () => expect(c('x+'.repeat(100) + 'x')).toBeNull());
  it('prototype names are not commands', () => {
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(c('\\' + n)).toBeNull();
  });
  it('reports reasons', () => {
    expect(analyzeSimpleTex('\\frac{a}{b}', false)).toEqual({ ok: false, reason: 'macro:\\frac' });
  });
});

describe('fail closed on hostile input', () => {
  it('never throws on edge and random strings', () => {
    const alphabet = ['x', '1', '\\', '{', '}', '_', '^', '(', ')', ' ', '\n', "'", '+', '-', '=', '<', '>', ',', 'α', '\u0000', '\\alpha', '\\frac', '&', '/', '.', 'in', '\\to'];
    let seed = 12345; // deterministic LCG; no Math.random in the test either
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 5000; i++) {
      let s = '';
      const len = rnd(14);
      for (let k = 0; k < len; k++) s += alphabet[rnd(alphabet.length)];
      for (const d of [false, true]) {
        expect(() => classifySimpleTex(s, d)).not.toThrow();
        const r = classifySimpleTex(s, d);
        expect(r === null || typeof r === 'string').toBe(true);
        // Anything accepted must be free of raw TeX and of unescaped markup.
        if (r !== null) {
          expect(r.replace(/<\/?em>/g, '').replace(/&[lg]t;/g, '')).not.toMatch(/[<>&]/);
        }
      }
    }
    for (const bad of [undefined, null, 5, {}, [] ] as unknown[]) {
      expect(classifySimpleTex(bad as string, false)).toBeNull();
    }
  });
  it('accepted output never contains raw backslashes or scripts markers', () => {
    for (const tex of ['x_1', 'a \\to b', '\\forall x (x \\in A)']) {
      const r = c(tex)!;
      expect(r).not.toMatch(/[\\_^]/);
    }
  });
});

describe('parseSepHtml understands the emitted markup', () => {
  it('turns it into em + text nodes only', () => {
    const html = `<p>Let ${c('x_1 < y')} hold.</p>`;
    const ast = JSON.stringify(parseSepHtml(html));
    expect(ast).toContain('"kind":"em"');
    expect(ast).toContain('x');
    expect(ast).toContain('₁');
    expect(ast).toContain('<'); // entity decoded by the parser, not left as &lt;
    expect(ast).not.toContain('&lt;');
    expect(ast).not.toContain('unsupported');
  });
});
