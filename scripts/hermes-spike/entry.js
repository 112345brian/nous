// DEV-ONLY spike entry: bundled by Metro and executed by the standalone `hermes` CLI.
const log = (s) => (typeof print === 'function' ? print(s) : console.log(s));
globalThis.PACKAGE_VERSION = '3.2.1';
try {
  const { texToSvg, mathEngineUnavailable } = require('../../src/services/texToSvg');
  const r = texToSvg('x^2+\\frac{a}{b}', false);
  log('RESULT ' + JSON.stringify(r).slice(0, 300));
  log('unavailable=' + mathEngineUnavailable());
} catch (e) {
  log('THROWN ' + (e && e.stack || e));
}
