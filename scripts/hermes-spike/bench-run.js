// DEV-ONLY perf bench for texToSvg under standalone Hermes. Prints one JSON line.
globalThis.PACKAGE_VERSION = '3.2.1';
const gen = require('./gen500');
const clock = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
const N = 500;
const eqs = gen(N);
const t0 = clock();
const { texToSvg } = require('../../src/utils/sepHtml/render/texToSvg');
const tRequire = clock();
const first = texToSvg('x', false); // init: loads mathjax modules + builds TeX/SVG jax
const tInit = clock();
const cold = [];
let errs = 0, bytes = 0;
for (const e of eqs) { const a = clock(); const r = texToSvg(e.tex, e.display); cold.push(clock() - a); if (r.error) errs++; else bytes += r.svg.length; }
const tCold = clock();
const warm = [];
for (const e of eqs) { const a = clock(); texToSvg(e.tex, e.display); warm.push(clock() - a); }
const tWarm = clock();
const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sum = a => a.reduce((x, y) => x + y, 0);
print(JSON.stringify({
  hasPerformanceNow: typeof performance !== 'undefined',
  requireMs: tRequire - t0, initMs: tInit - tRequire, firstOk: !first.error,
  coldTotalMs: tCold - tInit, warmTotalMs: tWarm - tCold,
  coldP50: q(cold, .5), coldP95: q(cold, .95), coldMax: q(cold, 1), coldOver16: cold.filter(x => x > 16).length, coldOver8: cold.filter(x => x > 8).length,
  warmP50: q(warm, .5), warmP95: q(warm, .95), warmMax: q(warm, 1),
  first50ColdMs: sum(cold.slice(0, 50)), last50ColdMs: sum(cold.slice(-50)),
  errs, svgBytes: bytes,
}));
