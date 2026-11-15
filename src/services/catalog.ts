// SEP adapters: how pages reach the app. The fetch functions talk to plato.stanford.edu. This
// module holds no use-case logic and no wiring; src/composition.ts builds the use cases from
// these functions (see src/core). Equations are rendered by core/substituteMath.ts.
import { getMeta, setMeta, getMathArticleHtml, updateArticleHtml, putMath } from './db';
import { hash64 } from '../utils/mathKey';
import { extractById } from '../utils/sepPage';
import { perf } from './perf';

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
