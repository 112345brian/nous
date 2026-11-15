globalThis.PACKAGE_VERSION = '3.2.1';
const corpus = require('./corpus'), simple = require('./tier-proxy');
const { texToSvg } = require('../../src/services/texToSvg');
texToSvg('x', false);
const run = list => { const t = Date.now(); let n = 0; for (let k = 0; k < 5; k++) for (const raw of list) { const d = raw.startsWith('D:'); texToSvg(d ? raw.slice(2) : raw, d); n++; } return { n, ms: Date.now() - t, perEqMs: (Date.now() - t) / n }; };
const complex = corpus.filter(r => !simple(r));
print(JSON.stringify({ all: run(corpus), complexOnly: run(complex), nAll: corpus.length, nComplex: complex.length }));
