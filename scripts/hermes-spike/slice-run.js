// DEV-ONLY: how long is the JS thread held per slice if we render 500 equations with a
// 6 ms budget between yields (the yield itself is simulated; CLI has no timers).
globalThis.PACKAGE_VERSION = '3.2.1';
const eqs = require('./gen500')(500);
const { texToSvg } = require('../../src/services/texToSvg');
texToSvg('x', false);
const BUDGET = 6; let slices = [], start = Date.now(), t0 = start;
for (let i = 0; i < eqs.length; i++) {
  texToSvg(eqs[i].tex, eqs[i].display);
  if (Date.now() - start >= BUDGET) { slices.push(Date.now() - start); start = Date.now(); }
}
slices.push(Date.now() - start);
slices.sort((a, b) => a - b);
print(JSON.stringify({ budget: BUDGET, nSlices: slices.length, p50: slices[slices.length >> 1], max: slices[slices.length - 1], totalMs: Date.now() - t0 }));
