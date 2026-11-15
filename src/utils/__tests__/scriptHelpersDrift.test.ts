// scripts/*.{mjs,js,cjs} run under plain node and cannot import the TypeScript in src/, so they carry
// copies of the page-extraction helpers whose canonical home is src/utils/sepPage.ts. A copy that
// drifts silently changes what the seed builder and the corpus audit see, so this runs each copy
// against the canonical on the same inputs and fails on any difference.
import { extractById, extractMetaContent, extractTitle, decodeEntities } from '../sepPage';

declare function require(mod: string): any;
declare const __dirname: string;
const fs = require('fs');
const path = require('path');
const ROOT: string = path.resolve(__dirname, '../../..');

// Source text of a top-level `function name(...) { ... }`, found by brace matching.
function fnSource(file: string, name: string): string | null {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm').exec(text);
  if (!m) return null;
  const open = text.indexOf('{', text.indexOf(')', m.index));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(m.index, i + 1);
  }
  return null;
}

// A script's copy of a function, evaluated with the helpers it calls available alongside it.
function load(file: string, name: string, helpers: string[] = []): (...a: any[]) => any {
  const parts = [...helpers, name].map(n => {
    const src = fnSource(file, n);
    if (!src) throw new Error(`${file} has no function ${n}`);
    return src;
  });
  const consts = fs.readFileSync(path.join(ROOT, file), 'utf8').match(/^const NAMED_ENTITIES[\s\S]*?^};/m)?.[0] ?? '';
  // eslint-disable-next-line no-new-func
  return new Function(`${consts}\n${parts.join('\n')}\nreturn ${name};`)();
}

const PAGES = [
  '<html><head><title>Free Will (Stanford Encyclopedia of Philosophy)</title><meta property="citation_author" content="O&#39;Connor, Timothy"></head><body><div id="aueditable"><h1>T</h1><div><p>a</p></div><p>b</p></div></body></html>',
  '<div id="toc"><ul><li>A</li></ul></div><div id="preamble"><p>x &amp; y</p></div>',
  '<h1 class="pagetitle x">Caf&eacute; &mdash; &#233; &#xE9;</h1>',
  '<div id="aueditable"><div>unclosed',
  '<nav id="aueditable">n</nav>',
  '',
];
const STRINGS = ['a &amp; b', '&lt;x&gt; &quot;q&quot; &#039;s&#039;', '&nbsp;|&eacute;|&mdash;|&#233;|&#xE9;|&unknown;', '&Eacute;&ouml;&hellip;&ldquo;x&rdquo;', '&laquo;&raquo;&bull;&prime;', ''];

const COPIES: Array<{ file: string; entities?: boolean; byId?: boolean; meta?: boolean; title?: boolean }> = [
  { file: 'scripts/test-download.mjs', entities: true, byId: true, meta: true, title: true },
  { file: 'scripts/buildEntrySeed.js', entities: true },
  { file: 'scripts/auditCorpus.cjs', byId: true },
];

describe.each(COPIES)('$file keeps its copy of the sepPage helpers in step', c => {
  if (c.entities) test('decodeEntities', () => {
    const copy = load(c.file, 'decodeEntities');
    for (const s of STRINGS) expect({ s, out: copy(s) }).toEqual({ s, out: decodeEntities(s) });
  });
  if (c.byId) test('extractById', () => {
    const copy = load(c.file, 'extractById');
    for (const p of PAGES) for (const id of ['aueditable', 'toc', 'preamble', 'missing']) {
      expect({ id, out: copy(p, id) }).toEqual({ id, out: extractById(p, id) });
    }
  });
  if (c.meta) test('extractMetaContent', () => {
    const copy = load(c.file, 'extractMetaContent', ['decodeEntities']);
    for (const p of PAGES) expect(copy(p, 'citation_author')).toEqual(extractMetaContent(p, 'citation_author'));
  });
  if (c.title) test('extractTitle', () => {
    const copy = load(c.file, 'extractTitle', ['decodeEntities']);
    for (const p of PAGES) expect(copy(p)).toEqual(extractTitle(p));
  });
});
