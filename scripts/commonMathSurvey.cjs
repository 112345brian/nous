#!/usr/bin/env node
/*
 * Equation-frequency survey over a directory of fetched SEP entry pages.
 * DEV TOOL. Prints COUNTS ONLY — it never prints or writes any SEP text, so its
 * output is safe to paste into docs/common-math.md. Keep the fetched pages
 * outside the repo (a temp dir) and delete them afterwards (see NOTICE.md).
 *
 *   node scripts/commonMathSurvey.cjs <pagesDir> [--list <tex-array.json>]
 *
 * --list: a JSON array of {tex, display} (our own hand-written list); reports how
 * many equation occurrences in the sample the list would have covered.
 */
const fs = require('fs');
const path = require('path');

const norm = s => s.replace(/\s+/g, ' ').trim();
const RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

function extract(html) {
  const out = [];
  RE.lastIndex = 0;
  let m;
  while ((m = RE.exec(html))) {
    const display = m[2] !== undefined;
    out.push({ tex: norm(m[1] ?? m[2]), display });
  }
  return out;
}

function survey(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  const perKey = new Map(); // key -> {count, articles:Set}
  let total = 0;
  const perArticle = [];
  for (const f of files) {
    const eqs = extract(fs.readFileSync(path.join(dir, f), 'utf8'));
    perArticle.push(eqs.length);
    for (const e of eqs) {
      total++;
      const k = (e.display ? 'D:' : 'I:') + e.tex;
      const v = perKey.get(k) || { count: 0, articles: new Set() };
      v.count++; v.articles.add(f);
      perKey.set(k, v);
    }
  }
  return { files, perKey, total, perArticle };
}

module.exports = { extract, survey, norm };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: commonMathSurvey.cjs <pagesDir> [--list list.json]'); process.exit(2); }
  const { files, perKey, total, perArticle } = survey(dir);
  const spread = n => [...perKey.values()].filter(v => v.articles.size >= n).length;
  const occ = n => [...perKey.values()].filter(v => v.articles.size >= n).reduce((a, v) => a + v.count, 0);
  console.log(`articles: ${files.length}`);
  console.log(`equation occurrences: ${total}`);
  console.log(`distinct equations: ${perKey.size}`);
  console.log(`articles with math: ${perArticle.filter(n => n > 0).length}`);
  for (const n of [2, 3, 5]) console.log(`distinct in >=${n} articles: ${spread(n)} (${occ(n)} occurrences)`);
  const li = process.argv.indexOf('--list');
  if (li > 0) {
    const list = JSON.parse(fs.readFileSync(process.argv[li + 1], 'utf8'));
    const keys = new Set(list.map(e => (e.display ? 'D:' : 'I:') + norm(e.tex)));
    let covered = 0, coveredDistinct = 0;
    for (const [k, v] of perKey) if (keys.has(k)) { covered += v.count; coveredDistinct++; }
    console.log(`list entries: ${keys.size}`);
    console.log(`list entries that occur verbatim in sample: ${coveredDistinct}`);
    console.log(`occurrences covered verbatim: ${covered} (${(100 * covered / total).toFixed(2)}%)`);
    // Upper bound if every space were insignificant (it is not: the cache key is the exact string).
    const nospace = k => k.replace(/\s+/g, '');
    const keys2 = new Set([...keys].map(nospace));
    let covered2 = 0;
    for (const [k, v] of perKey) if (keys2.has(nospace(k))) covered2 += v.count;
    console.log(`occurrences covered ignoring all spaces: ${covered2} (${(100 * covered2 / total).toFixed(2)}%)`);
  }
}
