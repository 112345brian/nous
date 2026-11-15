#!/usr/bin/env node
/**
 * Coverage of the tiered-math classifier over locally held article HTML.
 *   node scripts/mathTierCoverage.cjs <dir-or-file> [...]
 * Reads \( … \) and \[ … \] TeX from .html files you point it at and prints ONLY
 * counts and rejection reasons — never the TeX or any article text. Nothing is
 * written to disk. Point it at pages you fetched yourself (do not commit them).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function loadClassifier() {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/mathTier.ts'), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const m = { exports: {} };
  new Function('module', 'exports', out.outputText)(m, m.exports);
  return m.exports;
}
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function files(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs.readdirSync(p).flatMap(f => (f.endsWith('.html') ? [path.join(p, f)] : []));
}

const { analyzeSimpleTex } = loadClassifier();
const targets = process.argv.slice(2);
if (!targets.length) { console.error('usage: mathTierCoverage.cjs <dir-or-file> ...'); process.exit(2); }
const RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
let total = 0, simple = 0, display = 0;
const uniq = new Map(); // tex+flag -> simple?
const reasons = new Map();
for (const t of targets) for (const f of files(t)) {
  const html = fs.readFileSync(f, 'utf8');
  let m; RE.lastIndex = 0;
  let n = 0, s = 0;
  while ((m = RE.exec(html))) {
    const isDisp = m[2] !== undefined;
    const tex = decode((m[1] ?? m[2]).trim());
    const r = analyzeSimpleTex(tex, isDisp);
    total++; n++;
    if (isDisp) display++;
    if (r.ok) { simple++; s++; } else {
      const key = r.reason.replace(/^(char:).*/, '$1<c>');
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
    uniq.set((isDisp ? 'D' : 'I') + tex, r.ok);
  }
  console.log(`${path.basename(f)}: ${n} equations, ${s} simple (${n ? Math.round(100 * s / n) : 0}%)`);
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '0.0') + '%';
const u = [...uniq.values()];
console.log(`\nTOTAL ${total}  simple ${simple} (${pct(simple, total)})  display ${display}`);
console.log(`UNIQUE ${u.length}  simple ${u.filter(Boolean).length} (${pct(u.filter(Boolean).length, u.length)})`);
console.log('Top rejection reasons:');
[...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
