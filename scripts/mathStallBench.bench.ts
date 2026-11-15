// Synthetic JS-thread stall benchmark for completeArticleMath. NOT part of the
// jest suite (the name does not match testMatch). Run with:
//   npx jest --testMatch '**/scripts/mathStallBench.bench.ts' --runInBand
// It stubs the WebView renderer and the DB, so it measures only the JS work that
// stays on the RN thread in this pipeline's own code: JSON.parse of the result
// message, atob, string splice, parseSepHtml + JSON.stringify. It does NOT
// measure SQLite, the real WebView message bridge, or the SvgXml re-render.
// Equation counts and SVG size are hand-written approximations. Node, not Hermes.

const mockEntries: Record<string, { content_html: string }> = {};
jest.mock('../src/services/db', () => ({
  getMeta: async () => null, setMeta: async () => {},
  getEntryHtml: async (s: string) => mockEntries[s]?.content_html ?? null,
  updateArticleHtml: async (s: string, h: string) => { mockEntries[s] = { content_html: h }; },
  setArticleAst: async () => {}, putMathBatch: async () => {}, putMath: async () => {},
  upsertIndexEntries() {}, cacheArticle: async () => {}, getEntryCount: async () => 1,
  getSlugsByCacheStatus: async () => ({ uncached: [], cached: [] }), getCachedSlugs: async () => [],
  indexLinks: async () => {}, getAllEntryTitles: async () => [], invalidateLinkCache() {},
  cleanDenormalizedTitles() {}, getMathArticleHtml: async () => [], getUncachedAstSlugs: async () => [],
  getMathSvgMap: async () => ({}), getMathByHashes: async () => [], setEntryNotes() {},
}));

const mockN = Number((globalThis as any).process.env.BENCH_EQ ?? 400);
const mockSvgBytes = Number((globalThis as any).process.env.BENCH_SVG_BYTES ?? 4000);
const mockItems: string[] = [];
const mockSvg = btoa('<svg>' + 'M0 0L1 1'.repeat(Math.ceil(mockSvgBytes / 8)) + '</svg>');
for (let i = 0; i < mockN; i++) mockItems.push(JSON.stringify({ tex: `x_{${i}}`, display: i % 5 === 0, b64: mockSvg, w: 3.2, h: 1.4 }));

jest.mock('../src/services/mathRender', () => ({
  renderMathBatch: async (req: Array<unknown>) => {
    await new Promise<void>(r => setTimeout(r, 2)); // "MathJax in the WebView" (off-thread)
    // The bridge delivers one JSON string; parsing it is main-thread work.
    const off = (globalThis as any).__benchOffset ?? 0;
    const msg = '[' + mockItems.slice(off, off + req.length).join(',') + ']';
    (globalThis as any).__benchOffset = (off + req.length) % mockN;
    return JSON.parse(msg);
  },
}));

const performance: { now(): number } = (globalThis as any).performance;
import { completeArticleMath } from '../src/composition';
import { createStallDetector } from '../src/utils/stallDetector';

const para = (i: number) => `<p>Paragraph ${i} of a hand-written fixture with \\(x_{${i}}\\) inline and some filler words to give the parser work.</p>`;
const html = Array.from({ length: mockN }, (_, i) => para(i)).join('\n');

test(`stalls while completing an article with ${mockN} equations`, async () => {
  const runs: Array<{ maxMs: number; over16: number; over50: number }> = [];
  for (let r = 0; r < 5; r++) {
    mockEntries.bench = { content_html: html };
    (globalThis as any).__benchOffset = 0;
    const d = createStallDetector({
      now: () => performance.now(), setInterval: (f, ms) => setInterval(f, ms), clearInterval: h => clearInterval(h as any), intervalMs: 4,
    });
    d.start();
    const t0 = performance.now();
    await completeArticleMath('bench');
    const wall = performance.now() - t0;
    const rep = d.stop();
    runs.push(rep);
    if (r > 0) console.log(`RESULT run=${r} wall=${wall.toFixed(0)}ms max=${rep.maxMs}ms over16=${rep.over16} over50=${rep.over50}`);
  }
}, 120000);
