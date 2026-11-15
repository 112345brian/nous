import { upsertIndexEntries, cacheArticle, getMeta, setMeta, getEntryCount, getSlugsByCacheStatus, getCachedSlugs, indexLinks, getAllEntryTitles, invalidateLinkCache, cleanDenormalizedTitles, getMathArticleHtml, updateArticleHtml, setArticleAst, getUncachedAstSlugs, getEntryHtml, putMath, putMathBatch, getMathSvgMap, setEntryNotes } from './db';
import { linkifyHtml } from '../utils/linkifier';
import seedEntries from '../assets/entry-seed.json';
import { renderMathBatch } from './mathRender';
import { parseSepHtml } from '../utils/sepHtml/parse';
import { mathHash } from '../utils/mathHash';
import { refreshIndexIfStale as refreshIndexUseCase } from '../core/refreshIndex';
import { fetchAndCacheArticle as cacheArticleUseCase, type CacheArticleDeps } from '../core/cacheArticle';
import type { IndexEntry } from '../types';
import { extractById, decodeEntities } from '../utils/sepPage';
import { perf } from './perf';

// Replace all \(…\) and \[…\] TeX math in the raw HTML with compact <math-i>
// placeholder elements. SVGs are stored in the `math` DB table by hash so
// content_html stays small — no inlined base64, no multi-MB HTML.
const MATH_SUBST_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
async function substitutemath(html: string): Promise<string> {
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

  const results = await renderMathBatch(spots.map(s => ({ tex: s.tex, display: s.display })));

  let out = html;
  const rows: Array<{ hash: string; svg: string; w: number; h: number; display: boolean }> = [];
  for (let i = spots.length - 1; i >= 0; i--) {
    const r = results[i];
    if (!r || r.error || !r.b64) continue;
    const { index, len, display, tex } = spots[i];
    const hash = mathHash(tex, display);
    const w = (r.w ?? 1).toFixed(4);
    const h = (r.h ?? 1).toFixed(4);
    rows.push({ hash, svg: atob(r.b64), w: r.w ?? 1, h: r.h ?? 1, display });
    // Tiny placeholder — no base64 in HTML.
    const tag = `<math-i hash="${hash}" d="${display ? '1' : '0'}" w="${w}" h="${h}"></math-i>`;
    out = out.slice(0, index) + tag + out.slice(index + len);
  }
  // Store SVGs in the math table in one transaction (idempotent on hash). Done
  // before the caller writes the substituted HTML, so no placeholder can ever
  // reference a missing row.
  await putMathBatch(rows);
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
export function completeArticleMath(slug: string, html?: string): Promise<boolean> {
  const existing = mathInFlight.get(slug);
  if (existing) return existing;
  const p = (async () => {
    try {
      const src = html ?? (await getEntryHtml(slug));
      if (!src) return false;
      const updated = await substitutemath(src);
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
    await new Promise<void>(r => setTimeout(r, 32));
    await completeArticleMath(slug);
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
          const hash = mathHash(svg, display);
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
    await new Promise<void>(r => setTimeout(r, 0));
    try {
      const updated = await substitutemath(article.content_html);
      if (updated !== article.content_html) {
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
    // Yield one animation frame between parses so background AST generation
    // doesn't monopolize the JS thread and drop frames while the user is active.
    await new Promise<void>(r => setTimeout(r, 32));
    try {
      const html = await getEntryHtml(slug);
      if (!html) continue;
      const ast = JSON.stringify(parseSepHtml(html));
      await setArticleAst(slug, ast);
    } catch { }
  }
}

const BASE = 'https://plato.stanford.edu';

const SEP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// The logic lives in src/core/refreshIndex.ts; this wires it to the real fetch, SQLite
// and bundled seed. Same name and behaviour as before, so callers are unchanged.
export function refreshIndexIfStale(): Promise<void> {
  return refreshIndexUseCase({
    source: { fetchIndexHtml },
    store: { getEntryCount, upsertIndexEntries, cleanDenormalizedTitles, getAllEntryTitles, invalidateLinkCache },
    meta: { getMeta, setMeta },
    clock: { now: () => Date.now() },
    bundledEntries: seedEntries as IndexEntry[],
  });
}

export type DownloadProgress = {
  done: number;
  total: number;
  current: string;
};

export async function downloadAll(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  scope: 'all' | 'sep' | 'owl' = 'all'
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

export async function syncCachedArticles(
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
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
export function fetchAndCacheArticle(
  slug: string,
  opts: { skipMath?: boolean; awaitMath?: boolean } = {},
): Promise<boolean> {
  return cacheArticleUseCase(articleDeps(), slug, opts);
}

// Adapters for the use case in src/core/cacheArticle.ts.
function articleDeps(): CacheArticleDeps {
  return {
    source: { fetchArticleHtml, fetchNotesHtml },
    library: { cacheArticle, indexLinks },
    math: { substitute: substitutemath, completeLater },
    timing: perf,
    linkify: linkifyHtml,
  };
}

// Rejects on a network failure or timeout; null when the site answers with an error status.
async function fetchArticleHtml(slug: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await perf.time(slug, 'fetch', () => fetch(`${BASE}/entries/${slug}/`, { headers: SEP_HEADERS, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;
  return perf.time(slug, 'fetch-body', () => res.text());
}

// Record the debt first so a kill mid-render resumes at next launch, then render.
// Errors stay inside updatePending / completeArticleMath.
function completeLater(slug: string, html: string): void {
  updatePending(s => { s.add(slug); }).then(() => completeArticleMath(slug, html));
}

async function fetchIndexHtml(): Promise<string> {
  const res = await fetch(`${BASE}/contents.html`, { headers: SEP_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
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
