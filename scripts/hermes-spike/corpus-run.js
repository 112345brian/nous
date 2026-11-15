// DEV-ONLY: render the whole corpus under Hermes and print one JSON line per entry,
// followed by timing lines. Bundle with Metro, run with react-native's `hermes` CLI.
globalThis.PACKAGE_VERSION = '3.2.1';
const corpus = require('./corpus');
const out = (s) => print(s);
const now = () => Date.now();
const t0 = now();
const { texToSvg } = require('../../src/utils/sepHtml/render/texToSvg');
const tReq = now();
texToSvg('x', false); // forces init
const tInit = now();
out('TIMING ' + JSON.stringify({ requireMs: tReq - t0, firstRenderMs: tInit - tReq }));
const rows = [];
const t1 = now();
for (const raw of corpus) {
  const display = raw.startsWith('D:');
  const tex = display ? raw.slice(2) : raw;
  const r = texToSvg(tex, display);
  rows.push({ tex, display, ...r });
}
out('TIMING ' + JSON.stringify({ corpusMs: now() - t1, n: corpus.length }));
for (const r of rows) out('ROW ' + JSON.stringify(r));
