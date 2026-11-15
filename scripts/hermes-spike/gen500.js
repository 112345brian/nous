// Deterministic generator of N unique, hand-templated equations (not from SEP).
module.exports = function gen(n) {
  const T = [
    i => `x_{${i}}^{2}+y_{${i}}`, i => `\\frac{a_{${i}}+b}{c_{${i}}-d}`, i => `\\forall x_{${i}}\\,\\exists y\\,R_{${i}}(x_{${i}},y)`,
    i => `\\sum_{k=1}^{${i + 2}} k^{${(i % 4) + 1}}`, i => `\\Box(p_{${i}}\\to q)\\to(\\Box p_{${i}}\\to\\Box q)`, i => `\\mathcal{M}_{${i}}\\models\\phi\\land\\psi_{${i}}`,
    i => `\\{x\\mid P_{${i}}(x)\\}\\subseteq A_{${i}}\\cup B`, i => `\\begin{pmatrix}a_{${i}}&b\\\\c&d_{${i}}\\end{pmatrix}`, i => `\\text{if }n=${i}\\text{ then }f(n)=\\sqrt{n+${i}}`,
    i => `\\int_0^{${i + 1}} t^{${i % 5}}\\,dt`, i => `\\neg(p_{${i}}\\lor q_{${i}})\\leftrightarrow(\\neg p_{${i}}\\land\\neg q_{${i}})`, i => `\\mathbb{R}^{${i + 1}}\\to\\mathbb{R}`,
  ];
  const out = [];
  for (let i = 0; i < n; i++) out.push({ tex: T[i % T.length](i), display: i % 9 === 0 });
  return out;
};
