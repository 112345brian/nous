#!/usr/bin/env node
/**
 * Standalone test: fetch the SEP entry list and download a few articles.
 * Run with: node scripts/test-download.mjs
 */

const BASE = 'https://plato.stanford.edu';

// ── Extraction helpers (copies of src/utils/sepPage.ts; src/utils/__tests__/scriptHelpersDrift.test.ts keeps them in step) ──────────────────────────────────

function extractById(html, id) {
  const start = new RegExp(`<(div|nav|section|ol|ul)[^>]*\\bid="${id}"[^>]*>`, 'i');
  const m = start.exec(html);
  if (!m) return null;

  const tag = m[1].toLowerCase();
  let depth = 1;
  let i = m.index + m[0].length;
  while (i < html.length && depth > 0) {
    const open = html.indexOf(`<${tag}`, i);
    const close = html.indexOf(`</${tag}>`, i);
    if (close === -1) break;
    if (open !== -1 && open < close) { depth++; i = open + 1; }
    else { depth--; i = close + tag.length + 3; }
  }
  const content = html.slice(m.index + m[0].length, i - tag.length - 3).trim();
  return content || null;
}

function extractMetaContent(html, property) {
  const m = html.match(new RegExp(`<meta property="${property}" content="([^"]+)"`));
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]+?)\s*\(Stanford/i)
         ?? html.match(/<h1[^>]*class="[^"]*pagetitle[^"]*"[^>]*>([^<]+)/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å', aelig: 'æ',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', oslash: 'ø',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', yacute: 'ý',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Auml: 'Ä', Aring: 'Å', AElig: 'Æ',
  Oacute: 'Ó', Ograve: 'Ò', Ocirc: 'Ô', Ouml: 'Ö', Oslash: 'Ø',
  Uacute: 'Ú', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ccedil: 'Ç', Yacute: 'Ý',
  // Typographic
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
  laquo: '«', raquo: '»', bull: '•', prime: '′',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function testIndexFetch() {
  console.log('\n── 1. Fetching entry index from plato.stanford.edu/contents.html …');
  const res = await fetch(`${BASE}/contents.html`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const seen = new Set();
  const entries = [];
  const re = /href="entries\/([a-z0-9-]+)\/"><strong>([^<]+)<\/strong>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    entries.push({ slug: m[1], title: decodeEntities(m[2].trim()) });
  }

  console.log(`   ✓ Found ${entries.length} entries`);
  console.log(`   First 5: ${entries.slice(0, 5).map(e => e.slug).join(', ')}`);
  return entries;
}

async function testArticleFetch(slug) {
  console.log(`\n── 2. Fetching article: ${slug} …`);
  const res = await fetch(`${BASE}/entries/${slug}/`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const title      = extractTitle(html) ?? slug;
  const author     = extractMetaContent(html, 'citation_author');
  const pubDate    = extractMetaContent(html, 'citation_publication_date');
  const tocHtml    = extractById(html, 'toc');
  const preamble   = extractById(html, 'preamble');
  const content    = extractById(html, 'aueditable') ?? extractById(html, 'article-content');

  if (!content) throw new Error('Could not extract article content');

  console.log(`   ✓ Title:    ${title}`);
  console.log(`   ✓ Author:   ${author ?? '(not found)'}`);
  console.log(`   ✓ Date:     ${pubDate ?? '(not found)'}`);
  console.log(`   ✓ TOC:      ${tocHtml ? `${tocHtml.length} chars` : '(none)'}`);
  console.log(`   ✓ Preamble: ${preamble ? `${preamble.length} chars` : '(none)'}`);
  console.log(`   ✓ Content:  ${content.length} chars`);

  // Count sections
  const sections = (content.match(/<h2/g) ?? []).length;
  console.log(`   ✓ Sections: ${sections} h2 headings`);

  return { title, author, pubDate, tocHtml, content };
}

async function testMultiple(entries) {
  const slugs = ['plotinus', 'kant', 'aristotle'];
  console.log(`\n── 3. Fetching ${slugs.length} articles concurrently …`);
  const start = Date.now();
  const results = await Promise.all(slugs.map(async slug => {
    const res = await fetch(`${BASE}/entries/${slug}/`);
    const html = await res.text();
    const content = extractById(html, 'aueditable') ?? extractById(html, 'article-content');
    return { slug, ok: res.ok, size: content?.length ?? 0 };
  }));
  const ms = Date.now() - start;
  results.forEach(r => console.log(`   ✓ ${r.slug}: ${(r.size/1024).toFixed(1)} KB`));
  console.log(`   ✓ All done in ${ms}ms`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const entries = await testIndexFetch();
    await testArticleFetch('plotinus');
    await testMultiple(entries);
    console.log('\n✅  All tests passed — download pipeline works.\n');
  } catch (e) {
    console.error('\n❌  Test failed:', e.message);
    process.exit(1);
  }
})();
