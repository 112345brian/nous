import { upsertIndexEntries, cacheArticle, getMeta, setMeta, getEntryCount, getSlugsByCacheStatus, getCachedSlugs, indexLinks, getAllEntryTitles, invalidateLinkCache, cleanDenormalizedTitles, getMathArticleHtml, updateArticleHtml, setArticleAst, getUncachedAstSlugs, getEntryHtml, putMath, setEntryNotes } from './db';
import { linkifyHtml } from '../utils/linkifier';
import seedEntries from '../assets/entry-seed.json';
import { ensureMath } from './mathCache';
import { mathHash, hash64 } from '../utils/mathKey';
import { mathSlice, watchStalls, yieldThenMathMayRun, withDownloadHold, MathPriority } from './mathPriority';
import { parseSepHtml } from '../utils/sepHtml/parse';
import { perf } from '../utils/perf';
import { classifySimpleTex, TIERED_MATH_DEFAULT } from '../utils/mathTier';

// Replace all \(…\) and \[…\] TeX math in the raw HTML with compact <math-i>
// placeholder elements. `priority` null = the caller already owns the schedule (the
// syncCachedArticles awaitMath path runs under its own 'download' hold, so gating on
// it would wait forever); chunks and slices then only yield a macrotask. SVGs are stored in the `math` DB table by hash so
// content_html stays small — no inlined base64, no multi-MB HTML.
const MATH_SUBST_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
// Tiered math flag. Default OFF until verified on a device. Enable by setting the
// `tiered_math` meta pref to '1' (setMeta('tiered_math', '1')) or flipping the
// constant (mathTier.ts). Applies to every article; db init clears cached
// content when the on/off state or MATH_TIER_VERSION changes, so articles
// re-fetch and re-process on next launch (docs/tiered-math.md).
async function tieredMathEnabled(): Promise<boolean> {
  try {
    const v = await getMeta('tiered_math');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* fall through to default */ }
  return TIERED_MATH_DEFAULT;
}
async function substitutemath(html: string, priority: MathPriority | null = 'current'): Promise<string> {
  const spots: Array<{ index: number; len: number; tex: string; display: boolean }> = [];
  MATH_SUBST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_SUBST_RE.exec(html)) !== null) {
    const inline = m[1];
    const block = m[2];
    spots.push({
      index: m.index,
      len: m[0].length,
      tex: decodeEntities((inline ?? block).trim()),
      display: block !== undefined,
    });
  }
  if (!spots.length) return html;

  // Tiering (flag-gated): trivially simple TeX becomes styled text in the line; only
  // the remainder is typeset by MathJax. Fail closed: null means MathJax.
  const tiered = (await tieredMathEnabled())
    ? spots.map(s => classifySimpleTex(s.tex, s.display))
    : spots.map(() => null);
  const mjSpots = spots
    .filter((_, i) => tiered[i] === null)
    .map(s => ({ tex: s.tex, display: s.display }));

  // Dedupe, look up what the math table already holds, render only the missing
  // unique equations (each chunk stored before the next is requested). If any
  // equation is still missing (renderer timed out), leave the article untouched
  // and pending; rewriting is the idempotent last step and needs no rendering.
  const { dims, complete } = mjSpots.length
    ? await ensureMath(mjSpots, priority)
    : { dims: new Map<string, { w: number; h: number }>(), complete: true };
  if (!complete) return html;
  const slice = mathSlice(priority);

  let out = html;
  for (let i = spots.length - 1; i >= 0; i--) {
    await slice.checkpoint(); // yield the JS thread when this slice's time budget is spent
    const { index, len, display, tex } = spots[i];
    const text = tiered[i];
    if (text !== null) {
      out = out.slice(0, index) + text + out.slice(index + len);
      continue;
    }
    const hash = mathHash(tex, display);
    const d = dims.get(hash);
    if (!d) continue; // unrenderable TeX stays as raw text
    // Tiny placeholder — no base64 in HTML.
    const tag = `<math-i hash="${hash}" d="${display ? '1' : '0'}" w="${d.w.toFixed(4)}" h="${d.h.toFixed(4)}"></math-i>`;
    out = out.slice(0, index) + tag + out.slice(index + len);
  }
  return out;
}

// ── Deferred math ────────────────────────────────────────────────────────────
// A freshly fetched article is cached and shown with its raw TeX first (the
// parser renders it as monospace); equations are rendered afterwards and the
// article is rewritten with <math-i> hash references. Slugs whose math is not
// done yet are tracked in a meta key so an interrupted run resumes at launch
// (see resumePendingMath, called from backfillMathInline).
const MATH_PENDING_KEY = 'math_pending';
let pendingChain: Promise<void> = Promise.resolve();
function updatePending(fn: (slugs: Set<string>) => void): Promise<void> {
  // Serialized: read-modify-write on one meta row must not interleave.
  pendingChain = pendingChain.then(async () => {
    try {
      const raw = await getMeta(MATH_PENDING_KEY);
      const slugs = new Set<string>(raw ? JSON.parse(raw) : []);
      fn(slugs);
      await setMeta(MATH_PENDING_KEY, JSON.stringify([...slugs]));
    } catch {
      // non-fatal — worst case the slug is not retried until it is re-fetched
    }
  });
  return pendingChain;
}

type MathReadyListener = (slug: string) => void;
const mathReadyListeners = new Set<MathReadyListener>();
// Subscribe to "this article's equations are now rendered and stored".
// Returns an unsubscribe function.
export function onMathReady(cb: MathReadyListener): () => void {
  mathReadyListeners.add(cb);
  return () => { mathReadyListeners.delete(cb); };
}

const mathInFlight = new Map<string, Promise<boolean>>();
// Render the equations of a cached article and rewrite it with SVG references.
// `html` may be passed when the caller already holds it (skips a DB read).
// Resolves true when the article no longer needs math work; false when the
// renderer made no progress (it stays pending and is retried at next launch).
export function completeArticleMath(slug: string, html?: string, priority: MathPriority = 'current'): Promise<boolean> {
  const existing = mathInFlight.get(slug);
  if (existing) return existing;
  const stopWatch = watchStalls(`math:${slug}`); // dev-only; no-op in release
  const p = (async () => {
    try {
      const src = html ?? (await getEntryHtml(slug));
      if (!src) return false;
      const updated = await substitutemath(src, priority);
      if (updated === src) {
        // Nothing converted. Fine if there was no TeX; otherwise the renderer
        // timed out — keep it pending.
        MATH_SUBST_RE.lastIndex = 0;
        if (MATH_SUBST_RE.test(src)) return false;
      } else {
        await updateArticleHtml(slug, updated);
        await setArticleAst(slug, JSON.stringify(parseSepHtml(updated)));
      }
      await updatePending(s => { s.delete(slug); });
      mathReadyListeners.forEach(cb => { try { cb(slug); } catch { /* listener bug must not break the pipeline */ } });
      return true;
    } catch {
      return false;
    } finally {
      mathInFlight.delete(slug);
      stopWatch();
    }
  })();
  mathInFlight.set(slug, p);
  return p;
}

// Finish math for articles whose deferred render never completed (app killed,
// renderer timed out). Sequential, yielding between articles.
export async function resumePendingMath(): Promise<void> {
  let slugs: string[] = [];
  try {
    const raw = await getMeta(MATH_PENDING_KEY);
    slugs = raw ? JSON.parse(raw) : [];
  } catch {
    return;
  }
  for (const slug of slugs) {
    // One article per unit; stops here (slug stays in math_pending) while the reader is active.
    await yieldThenMathMayRun('background');
    await completeArticleMath(slug, undefined, 'background');
  }
}

// One-time migration: rewrite articles that have the old inline-base64 format
// (<math-i>BASE64</math-i>) to the new hash-reference format. Extracts the SVG
// from each element, stores it in the math table, and replaces the element with
// a compact hash placeholder. Guarded by a meta key.
export async function backfillMathHashFormat(): Promise<void> {
  const done = await getMeta('math_hash_format_v1');
  if (done) return;
  const articles = await getMathArticleHtml();
  const LEGACY_RE = /<math-i([^>]*)>([A-Za-z0-9+/=]+)<\/math-i>/g;
  for (const article of articles) {
    await new Promise<void>(r => setTimeout(r, 32));
    try {
      let changed = false;
      // Collect (hash→putMath) outside the synchronous replace callback so we
      // can await them all before writing the updated HTML. This ensures every
      // math table row exists before content_html is committed.
      const puts: Promise<void>[] = [];
      const updated = article.content_html.replace(LEGACY_RE, (_, attrs, b64) => {
        try {
          const svg = atob(b64);
          const dMatch = attrs.match(/\bd="(\d)"/);
          const wMatch = attrs.match(/\bw="([\d.]+)"/);
          const hMatch = attrs.match(/\bh="([\d.]+)"/);
          const display = dMatch?.[1] === '1';
          const w = parseFloat(wMatch?.[1] ?? '1') || 1;
          const h = parseFloat(hMatch?.[1] ?? '1') || 1;
          // Hash SVG content (TeX unavailable here). Uses the same 64-bit djb2
          // as mathHash so the key space matches newly-fetched articles.
          const hash = hash64(svg, display);
          puts.push(putMath(hash, svg, w, h, display));
          changed = true;
          return `<math-i hash="${hash}" d="${display ? '1' : '0'}" w="${w.toFixed(4)}" h="${h.toFixed(4)}"></math-i>`;
        } catch { return _; }
      });
      // Wait for all math rows to land before updating content_html so a
      // concurrent article open never sees a hash with no matching DB row.
      await Promise.all(puts.map(p => p.catch(() => {})));
      if (changed) await updateArticleHtml(article.slug, updated);
    } catch { }
  }
  await setMeta('math_hash_format_v1', '1');
}

// One-time startup backfill: run substitutemath on all already-cached math
// articles so their stored content_html has SVGs instead of raw TeX.
// Runs entirely from the local DB — no network. Guarded by a meta key.
export async function backfillMathInline(): Promise<void> {
  // Finish any deferred per-article math from a previous run first.
  await resumePendingMath().catch(() => {});
  // v2: v1 ran before the WebView renderer existed and converted nothing
  // (MathJax can't run on Hermes), so re-run once against the real renderer.
  const done = await getMeta('math_inline_v2');
  if (done) return;
  const articles = await getMathArticleHtml();
  for (const article of articles) {
    await yieldThenMathMayRun('background');
    try {
      // Re-read: the snapshot above may be hours old if we were paused, and a
      // reader-triggered completion may have rewritten this article since.
      const current = (await getEntryHtml(article.slug)) ?? article.content_html;
      const updated = await substitutemath(current, 'background');
      if (updated !== current) {
        await updateArticleHtml(article.slug, updated);
      }
    } catch {
      // non-fatal — article will fall back to legacy monospace TeX
    }
  }
  await setMeta('math_inline_v2', '1');
}

// One-time startup backfill: pre-parse AST for all cached articles that don't
// have one yet (articles cached before this feature, or updated by math backfill).
export async function backfillAst(): Promise<void> {
  const slugs = await getUncachedAstSlugs();
  for (const slug of slugs) {
    // One article per unit: yield a macrotask, and stop while the reader is
    // active or a download is running (the work list is re-derived from the DB).
    await yieldThenMathMayRun('background');
    try {
      const html = await getEntryHtml(slug);
      if (!html) continue;
      const ast = JSON.stringify(parseSepHtml(html));
      await setArticleAst(slug, ast);
    } catch { }
  }
}

const BASE = 'https://plato.stanford.edu';
const INDEX_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const SEP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export async function refreshIndexIfStale(): Promise<void> {
  const lastRefresh = await getMeta('index_refreshed_at');
  const count = await getEntryCount();
  const isStale = !lastRefresh ||
    Date.now() - Number(lastRefresh) > INDEX_REFRESH_INTERVAL_MS ||
    count === 0;

  if (!isStale) return;

  let entries: { slug: string; title: string }[];
  try {
    entries = await fetchEntryList();
  } catch {
    // fall back to bundled seed on first launch; if index already exists, skip silently
    if (count === 0) entries = seedEntries as { slug: string; title: string }[];
    else return;
  }

  if (entries.length > 0) {
    await upsertIndexEntries(entries);
    await cleanDenormalizedTitles();
    await setMeta('index_refreshed_at', String(Date.now()));
    // Rebuild link index in background after new index data lands
    buildLinkIndex().catch(() => {});
  }
}

async function buildLinkIndex(): Promise<void> {
  const entries = await getAllEntryTitles();
  const payload = JSON.stringify(
    entries.slice(0, 700).map(e => ({
      s: e.slug,
      t: e.title,
      p: e.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    }))
  );
  await setMeta('link_index_json', payload);
  invalidateLinkCache();
}

export type DownloadProgress = {
  done: number;
  total: number;
  current: string;
};

export function downloadAll(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  scope: 'all' | 'sep' | 'owl' = 'all'
): Promise<void> {
  return withDownloadHold(() => downloadAllUnheld(onProgress, signal, scope));
}

async function downloadAllUnheld(
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal | undefined,
  scope: 'all' | 'sep' | 'owl'
): Promise<void> {
  const { uncached, cached } = await getSlugsByCacheStatus(scope);
  // Report progress against the full library so a resumed download shows
  // "900 / 1800" rather than "0 / 900", making it clear work wasn't lost.
  const alreadyDone = cached.length;
  const total = uncached.length + alreadyDone;
  let done = alreadyDone;

  // Emit once upfront so callers always see the real total, even on a fully-cached library.
  onProgress({ done, total, current: '' });

  // Skip math rendering during bulk download — backfillMathInline runs after
  // and handles all math articles in one pass. Rendering math inline here
  // requires a WebView round-trip per equation and turns a 20-min download
  // into a 2-hour one for a library with ~450 math articles.
  const CONCURRENCY = 6;
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    if (signal?.aborted) return;
    const chunk = uncached.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(({ slug, title }) =>
      fetchAndCacheArticle(slug, { skipMath: true }).then(() => {
        // Increment inside .then() so each article fires its own progress event
        // rather than batching. done++ after await in concurrent callbacks can
        // read the same value twice; .then() serializes via microtask queue safely
        // because each closure captures a separate resolve tick.
        onProgress({ done: ++done, total, current: title });
      })
    ));
    await new Promise<void>(r => setTimeout(r, 100));
  }
}

export function syncCachedArticles(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  return withDownloadHold(() => syncCachedArticlesUnheld(onProgress, signal));
}

async function syncCachedArticlesUnheld(
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal | undefined
): Promise<void> {
  await refreshIndexIfStale();
  const slugs = await getCachedSlugs();
  const total = slugs.length;
  let done = 0;
  const CONCURRENCY = 3;
  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    if (signal?.aborted) return;
    const chunk = slugs.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async ({ slug, title }) => {
      await fetchAndCacheArticle(slug, { awaitMath: true });
      done++;
      onProgress({ done, total, current: title });
    }));
    await new Promise<void>(r => setTimeout(r, 200));
  }
  await setMeta('last_deep_sync', String(Date.now()));
}

// Math handling (articles with TeX only):
//   default        — cache the text now, render equations in the background and
//                    rewrite the article when done (onMathReady fires). Resolves
//                    without waiting for MathJax.
//   awaitMath      — render equations first (old behavior); for bulk sync where
//                    nobody is waiting on the first paint.
//   skipMath       — leave raw TeX; bulk download defers to backfillMathInline.
export async function fetchAndCacheArticle(
  slug: string,
  opts: { skipMath?: boolean; awaitMath?: boolean } = {},
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await perf.time(slug, 'fetch', () => fetch(`${BASE}/entries/${slug}/`, { headers: SEP_HEADERS, signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return false;
    const html = await perf.time(slug, 'fetch-body', () => res.text());

    const { tocHtml, preambleHtml, rawContentHtml } = perf.timeSync(slug, 'extract', () => ({
      title: extractTitle(html) ?? slug,
      tocHtml: extractById(html, 'toc'),
      preambleHtml: extractById(html, 'preamble'),
      rawContentHtml: extractById(html, 'aueditable') || extractById(html, 'article-content'),
    }));

    if (!rawContentHtml) return false;

    // aueditable starts with <h1> (title) which the template re-adds itself.
    const contentHtml = rawContentHtml.replace(/^\s*<!--[^>]*-->\s*/, '').replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '');

    const linkedHtml = perf.timeSync(slug, 'linkify', () => linkifyHtml(contentHtml));
    const hasMath = linkedHtml.includes('\\(') || linkedHtml.includes('\\[');
    // Substitute math unless caller opted out (bulk download defers to backfillMathInline).
    const deferMath = hasMath && !opts.skipMath && !opts.awaitMath;
    const finalHtml = hasMath && !opts.skipMath && opts.awaitMath ? await perf.time(slug, 'math', () => substitutemath(linkedHtml, null)) : linkedHtml;
    // Footnote text lives on a sibling notes.html page; fetch it so footnotes
    // resolve offline. Only when the body actually references it.
    const notesHtml = /notes\.html#note/i.test(finalHtml) ? await perf.time(slug, 'notes', () => fetchNotesHtml(slug)) : null;
    // Pre-parse the AST so ArticleScreen can JSON.parse instead of re-parsing HTML.
    const content_ast = perf.timeSync(slug, 'parse+stringify', () => JSON.stringify(parseSepHtml(finalHtml)));
    await perf.time(slug, 'cache-write', () => cacheArticle(slug, {
      author: extractMetaContent(html, 'citation_author') ?? extractAuthor(html),
      pub_date: extractMetaContent(html, 'citation_publication_date'),
      toc_html: tocHtml,
      preamble_html: preambleHtml,
      content_html: finalHtml,
      notes_html: notesHtml,
      content_ast,
      has_math: hasMath ? 1 : 0,
    }));
    // Index outgoing links for graph view
    indexLinks(slug, contentHtml).catch(() => {});
    if (deferMath) {
      // Fire-and-forget: record the debt first so a kill mid-render resumes at
      // next launch, then render. Errors stay inside completeArticleMath.
      updatePending(s => { s.add(slug); }).then(() => completeArticleMath(slug, finalHtml));
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchEntryList(): Promise<{ slug: string; title: string; parent_label: string | null }[]> {
  const res = await fetch(`${BASE}/contents.html`, { headers: SEP_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const entries: { slug: string; title: string; parent_label: string | null }[] = [];
  const seen = new Set<string>();
  const STRONG_LINK = /href="entries\/([a-z0-9-]+)\/"><strong>([^<]+)<\/strong>/g;
  let m: RegExpExecArray | null;

  // Pass 1: parent groups — <li> HEADER \n <ul> sub-entries </ul>
  // Header may be plain text OR a linked entry
  const parentGroupRe = /<li>\s*([^\n]+)\n\s*<ul>([\s\S]*?)<\/ul>/g;
  while ((m = parentGroupRe.exec(html)) !== null) {
    const header = m[1].trim();
    const subHtml = m[2];
    const strongM = header.match(/<strong>([^<]+)<\/strong>/);
    const parentLabel = decodeEntities(strongM ? strongM[1].trim() : header.replace(/<[^>]*>/g, '').trim());
    if (!parentLabel) continue;
    // If header is a linked entry, add the parent itself (no parent_label — it IS the parent)
    const parentLink = header.match(/href="entries\/([a-z0-9-]+)\/"/);
    if (parentLink && !seen.has(parentLink[1])) {
      seen.add(parentLink[1]);
      entries.push({ slug: parentLink[1], title: parentLabel, parent_label: null });
    }
    // Add sub-entries: store only the sub-title as title, parent_label separately
    const subRe = /href="entries\/([a-z0-9-]+)\/"><strong>([^<]+)<\/strong>/g;
    let sub: RegExpExecArray | null;
    while ((sub = subRe.exec(subHtml)) !== null) {
      const slug = sub[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      entries.push({ slug, title: decodeEntities(sub[2].trim()), parent_label: parentLabel });
    }
  }

  // Pass 2: standalone entries not already captured
  STRONG_LINK.lastIndex = 0;
  while ((m = STRONG_LINK.exec(html)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ slug, title: decodeEntities(m[2].trim()), parent_label: null });
  }

  entries.sort((a, b) => a.title.localeCompare(b.title));
  return entries;
}

// ── HTML extraction ──────────────────────────────────────────────────────────

// SEP keeps footnote text on a sibling notes.html page. Fetch it and return the
// article-content container, so the renderer can resolve footnote refs offline.
async function fetchNotesHtml(slug: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(`${BASE}/entries/${slug}/notes.html`, { headers: SEP_HEADERS, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const html = await res.text();
    return extractById(html, 'aueditable') || extractById(html, 'article-content') || null;
  } catch {
    return null;
  }
}

// Lazy backfill for an already-cached article: if its body references footnotes
// but the notes page wasn't stored (downloaded before this feature), fetch and
// persist it. Returns the notes HTML, or null when there are no footnotes.
export async function ensureNotesCached(slug: string, contentHtml: string | null): Promise<string | null> {
  if (!contentHtml || !/notes\.html#note/i.test(contentHtml)) return null;
  const notes = await fetchNotesHtml(slug);
  if (notes) await setEntryNotes(slug, notes);
  return notes;
}

function extractById(html: string, id: string): string | null {
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

function extractMetaContent(html: string, property: string): string | null {
  const m = html.match(new RegExp(`<meta property="${property}" content="([^"]+)"`));
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title>([^<]+?)\s*\(Stanford/i) ??
            html.match(/<h1[^>]*class="[^"]*pagetitle[^"]*"[^>]*>([^<]+)/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractAuthor(html: string): string | null {
  const m = html.match(/<p[^>]*class="[^"]*author[^"]*"[^>]*>([^<]+)/i);
  return m ? decodeEntities(m[1].trim()).slice(0, 200) : null;
}

const ENTITY_MAP: Record<string, string> = {
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
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITY_MAP[name] ?? m);
}
