// SEP adapters: how pages and equations actually reach the app. This module holds no use-case
// logic and no wiring; src/composition.ts builds the use cases from these functions (see
// src/core). `substitutemath` renders and stores equations (tiering, the math cache and the
// priority model live behind it); the fetch functions talk to plato.stanford.edu.
import { getMeta } from './db';
import { ensureMath } from './mathCache';
import { mathHash } from '../utils/mathKey';
import { mathSlice, MathPriority } from './mathPriority';
import { extractById, decodeEntities } from '../utils/sepPage';
import { perf } from './perf';
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
export async function substitutemath(html: string, priority: MathPriority | null = 'current'): Promise<string> {
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

const BASE = 'https://plato.stanford.edu';

const SEP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Rejects on a network failure or timeout; null when the site answers with an error status.
export async function fetchArticleHtml(slug: string): Promise<string | null> {
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

export async function fetchIndexHtml(): Promise<string> {
  const res = await fetch(`${BASE}/contents.html`, { headers: SEP_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── HTML extraction ──────────────────────────────────────────────────────────

// SEP keeps footnote text on a sibling notes.html page. Fetch it and return the
// article-content container, so the renderer can resolve footnote refs offline.
export async function fetchNotesHtml(slug: string): Promise<string | null> {
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
