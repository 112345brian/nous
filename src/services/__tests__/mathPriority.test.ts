// The priority model end to end through catalog.ts, with the real idleScheduler
// singleton, fake timers, and no DB/WebView. Hand-written fixtures only.

const mockMeta: Record<string, string> = {};
const mockEntries: Record<string, { content_html: string }> = {};

jest.mock('../db', () => ({
  upsertIndexEntries: jest.fn(),
  cacheArticle: jest.fn(async (slug: string, d: { content_html: string }) => { mockEntries[slug] = { content_html: d.content_html }; }),
  getMeta: jest.fn(async (k: string) => mockMeta[k] ?? null),
  setMeta: jest.fn(async (k: string, v: string) => { mockMeta[k] = v; }),
  getEntryCount: jest.fn(async () => 1),
  getSlugsByCacheStatus: jest.fn(async () => ({ uncached: [{ slug: 'a', title: 'A' }], cached: [] })),
  getCachedSlugs: jest.fn(async () => []),
  indexLinks: jest.fn(async () => {}),
  getAllEntryTitles: jest.fn(async () => []),
  invalidateLinkCache: jest.fn(),
  cleanDenormalizedTitles: jest.fn(),
  getMathArticleHtml: jest.fn(async () => []),
  updateArticleHtml: jest.fn(async (slug: string, html: string) => { mockEntries[slug] = { content_html: html }; }),
  setArticleAst: jest.fn(async () => {}),
  getUncachedAstSlugs: jest.fn(async () => []),
  getEntry: jest.fn(async (slug: string) => mockEntries[slug] ?? null),
  getEntryHtml: jest.fn(async (slug: string) => mockEntries[slug]?.content_html ?? null),
  putMathBatch: jest.fn(async () => {}),
  putMath: jest.fn(async () => {}),
  getMathSvgMap: jest.fn(async () => ({})),
  getMathByHashes: jest.fn(async () => []),
  setEntryNotes: jest.fn(),
}));

const mockRender = jest.fn();
jest.mock('../mathRender', () => ({ renderMathBatch: (...a: unknown[]) => mockRender(...a) }));

import { _resetMathCacheState } from '../../composition';   // the math runtime is built in the root
import { idleScheduler } from '../../composition';
import { fetchAndCacheArticle, completeArticleMath, resumePendingMath } from '../../composition';   // wired in the composition root
import { downloadAll } from '../../composition';   // moved to the composition root

const okRender = async (items: Array<{ tex: string; display: boolean }>) =>
  items.map(it => ({ ...it, b64: btoa('<svg/>'), w: 2, h: 1 }));
const PAGE = `<html><head><title>T (Stanford Encyclopedia of Philosophy)</title></head>
<body><div id="aueditable"><h1>T</h1><p>Let \\(x\\) be.</p></div></body></html>`;
const tick = (ms: number) => jest.advanceTimersByTimeAsync(ms);

// The scheduler singleton remembers the last activity time; give every test a
// clock far ahead of the previous one so that state can't leak between tests.
let clockBase = Date.now();
beforeEach(() => {
  _resetMathCacheState();
  clockBase += 1e9;
  jest.useFakeTimers({ now: clockBase });
  jest.clearAllMocks();
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  for (const k of Object.keys(mockEntries)) delete mockEntries[k];
  mockRender.mockImplementation(okRender);
  (globalThis as any).fetch = jest.fn(async () => ({ ok: true, text: async () => PAGE }));
});
afterEach(() => jest.useRealTimers());

test('reading hold: article text is cached and math stays recorded as pending, unrendered', async () => {
  const release = idleScheduler.hold('reading');
  await fetchAndCacheArticle('t');
  await tick(60_000);
  expect(mockRender).not.toHaveBeenCalled();
  expect(JSON.parse(mockMeta.math_pending)).toEqual(['t']); // paused, not dropped
  release();
  await tick(399);
  expect(mockRender).not.toHaveBeenCalled(); // still inside the quiet gap
  await tick(2000);
  expect(mockRender).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
});

test('prefetch path (deferPriority background): queued, held while reading, then rendered and announced', async () => {
  const { onMathReady } = require('../../composition');
  const ready = jest.fn();
  const off = onMathReady(ready);
  const release = idleScheduler.hold('reading'); // user opened the prefetched article
  await fetchAndCacheArticle('t', { deferPriority: 'background' });
  await tick(60_000);
  expect(mockRender).not.toHaveBeenCalled();
  expect(JSON.parse(mockMeta.math_pending)).toEqual(['t']);
  expect(mockEntries.t.content_html).toContain('\\(x\\)');
  release();
  await tick(5000);
  expect(mockEntries.t.content_html).toContain('<math-i ');
  expect(ready).toHaveBeenCalledWith('t'); // ArticleScreen swaps the AST on this
  off();
});

test('scroll activity pauses current-article math until the reader is quiet again', async () => {
  idleScheduler.noteActivity();
  const p = completeArticleMath('x', '<p>\\(x\\)</p>');
  await tick(300);
  idleScheduler.noteActivity();
  await tick(300);
  expect(mockRender).not.toHaveBeenCalled();
  await tick(200);
  await p;
  expect(mockRender).toHaveBeenCalledTimes(1);
});

test('downloadAll holds math for its whole duration, then math resumes', async () => {
  let finishFetch!: () => void;
  const gate = new Promise<void>(r => { finishFetch = r; });
  (globalThis as any).fetch = jest.fn(async () => { await gate; return { ok: true, text: async () => PAGE }; });
  const dl = downloadAll(() => {});
  await tick(10);
  const cur = completeArticleMath('x', '<p>\\(x\\)</p>');
  await tick(30_000);
  expect(mockRender).not.toHaveBeenCalled(); // paused for the download
  finishFetch();
  await tick(1000);
  await dl;
  await tick(5000);
  await cur;
  // 'x' (current) plus the downloaded article, drained after the hold ended.
  expect(mockRender).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
});

test('downloadAll releases its hold when it throws', async () => {
  const db = require('../db');
  db.getSlugsByCacheStatus.mockRejectedValueOnce(new Error('db down'));
  await expect(downloadAll(() => {})).rejects.toThrow('db down');
  const p = completeArticleMath('x', '<p>\\(x\\)</p>');
  await tick(1000);
  await p;
  expect(mockRender).toHaveBeenCalledTimes(1);
});

test('resumePendingMath waits out a hold, keeps the queue in math_pending, then finishes every article', async () => {
  mockMeta.math_pending = JSON.stringify(['a', 'b']);
  mockEntries.a = { content_html: '<p>\\(a\\)</p>' };
  mockEntries.b = { content_html: '<p>\\(b\\)</p>' };
  const release = idleScheduler.hold('reading');
  const p = resumePendingMath();
  await tick(60_000);
  expect(mockRender).not.toHaveBeenCalled();
  expect(JSON.parse(mockMeta.math_pending)).toEqual(['a', 'b']);
  release();
  await tick(10_000);
  await p;
  expect(mockRender).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
});

test('a hold taken mid-run stops resumePendingMath at the next article boundary (killed app: slug still pending)', async () => {
  mockMeta.math_pending = JSON.stringify(['a', 'b']);
  mockEntries.a = { content_html: '<p>\\(a\\)</p>' };
  mockEntries.b = { content_html: '<p>\\(b\\)</p>' };
  let release: (() => void) | null = null;
  mockRender.mockImplementation(async (items: any) => {
    if (!release) release = idleScheduler.hold('reading'); // reader opens an article during article a's render
    return okRender(items);
  });
  const p = resumePendingMath();
  await tick(30_000);
  expect(mockRender).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockMeta.math_pending)).toEqual(['b']); // a done, b waiting on disk
  release!();
  await tick(10_000);
  await p;
  expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
});

test('a large article is rendered in several small WebView batches', async () => {
  const body = Array.from({ length: 60 }, (_, i) => `\\(v${i}\\)`).join(' ');
  mockEntries.big = { content_html: `<p>${body}</p>` };
  const p = completeArticleMath('big');
  await tick(5000);
  expect(await p).toBe(true);
  const sizes = mockRender.mock.calls.map(c => (c[0] as unknown[]).length);
  expect(sizes).toEqual([24, 24, 12]);
  expect((mockEntries.big.content_html.match(/<math-i /g) ?? []).length).toBe(60);
});
