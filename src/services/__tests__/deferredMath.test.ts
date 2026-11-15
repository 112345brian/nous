// Deferred math: the article text is cached and returned before MathJax runs;
// equations are rendered afterwards, stored in one batch, and the article is
// rewritten with <math-i> hash references. No network / DB / WebView.

const mockMeta: Record<string, string> = {};
const mockEntries: Record<string, { content_html: string }> = {};

jest.mock('../db', () => ({
  upsertIndexEntries: jest.fn(),
  cacheArticle: jest.fn(async (slug: string, d: { content_html: string }) => {
    mockEntries[slug] = { content_html: d.content_html };
  }),
  getMeta: jest.fn(async (k: string) => mockMeta[k] ?? null),
  setMeta: jest.fn(async (k: string, v: string) => { mockMeta[k] = v; }),
  getEntryCount: jest.fn(),
  getSlugsByCacheStatus: jest.fn(),
  getCachedSlugs: jest.fn(),
  indexLinks: jest.fn(async () => {}),
  getAllEntryTitles: jest.fn(async () => []),
  invalidateLinkCache: jest.fn(),
  cleanDenormalizedTitles: jest.fn(),
  updateArticleHtml: jest.fn(async (slug: string, html: string) => {
    mockEntries[slug] = { content_html: html };
  }),
  setArticleAst: jest.fn(async () => {}),
  getUncachedAstSlugs: jest.fn(async () => []),
  getEntry: jest.fn(async (slug: string) => mockEntries[slug] ?? null),
  getEntryHtml: jest.fn(async (slug: string) => mockEntries[slug]?.content_html ?? null),
  putMathBatch: jest.fn(async () => {}),
  getMathSvgMap: jest.fn(async () => ({})),
  getMathByHashes: jest.fn(async () => []),
  setEntryNotes: jest.fn(),
}));

const mockRender = jest.fn();
jest.mock('../mathRender', () => ({
  renderMathBatch: (...a: unknown[]) => mockRender(...a),
}));

import * as db from '../db';
import { _resetMathCacheState } from '../../composition';   // the math runtime is built in the root
import { fetchAndCacheArticle, onMathReady, completeArticleMath, resumePendingMath } from '../../composition';   // wired in the composition root

const PAGE = `<html><head><title>Logic (Stanford Encyclopedia of Philosophy)</title></head>
<body><div id="aueditable"><h1>Logic</h1><p>Let \\(x\\) be a set and \\[y = 2\\] hold.</p></div></body></html>`;

const okRender = async (items: Array<{ tex: string; display: boolean }>) =>
  items.map(it => ({ ...it, b64: btoa('<svg/>'), w: 2, h: 1 }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
  _resetMathCacheState();
  jest.clearAllMocks();
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  for (const k of Object.keys(mockEntries)) delete mockEntries[k];
  (globalThis as any).fetch =jest.fn(async () => ({ ok: true, text: async () => PAGE }));
});

test('default: text is cached with raw TeX and the call returns before math renders', async () => {
  const gate = deferred<ReturnType<typeof okRender> extends Promise<infer R> ? R : never>();
  mockRender.mockReturnValue(gate.promise);

  const ok = await fetchAndCacheArticle('logic');

  expect(ok).toBe(true); // resolved while MathJax is still "running"
  const cached = (db.cacheArticle as jest.Mock).mock.calls[0][1];
  expect(cached.content_html).toContain('\\(x\\)'); // placeholder phase: TeX, no SVG refs yet
  expect(cached.content_html).not.toContain('<math-i');
  expect(cached.has_math).toBe(1);
  expect(db.updateArticleHtml).not.toHaveBeenCalled();
  gate.resolve(await okRender([{ tex: 'x', display: false }, { tex: 'y = 2', display: true }]));
  await flush();
});

test('after math renders: one batched write, article rewritten, listeners notified', async () => {
  mockRender.mockImplementation(okRender);
  const ready: string[] = [];
  const off = onMathReady(s => ready.push(s));

  await fetchAndCacheArticle('logic');
  await flush(); await flush();

  expect(db.putMathBatch).toHaveBeenCalledTimes(1);
  expect((db.putMathBatch as jest.Mock).mock.calls[0][0]).toHaveLength(2); // both equations, one call
  expect(db.updateArticleHtml).toHaveBeenCalledTimes(1);
  const html = (db.updateArticleHtml as jest.Mock).mock.calls[0][1] as string;
  expect(html.match(/<math-i /g)).toHaveLength(2);
  expect(html).not.toContain('\\(x\\)');
  expect(db.setArticleAst).toHaveBeenCalledWith('logic', expect.stringContaining('mathref'));
  expect(ready).toEqual(['logic']);
  expect(JSON.parse(mockMeta.math_pending)).toEqual([]); // debt cleared
  off();
});

test('the batch is stored before the rewritten article is written', async () => {
  mockRender.mockImplementation(okRender);
  await fetchAndCacheArticle('logic');
  await flush(); await flush();
  const putOrder = (db.putMathBatch as jest.Mock).mock.invocationCallOrder[0];
  const updOrder = (db.updateArticleHtml as jest.Mock).mock.invocationCallOrder[0];
  expect(putOrder).toBeLessThan(updOrder); // no placeholder can reference a missing row
});

test('awaitMath keeps the old behavior: SVG refs are in the first cached HTML', async () => {
  mockRender.mockImplementation(okRender);
  await fetchAndCacheArticle('logic', { awaitMath: true });
  const cached = (db.cacheArticle as jest.Mock).mock.calls[0][1];
  expect(cached.content_html).toContain('<math-i ');
  expect(db.updateArticleHtml).not.toHaveBeenCalled();
  expect(mockMeta.math_pending).toBeUndefined();
});

test('skipMath leaves raw TeX, renders nothing, and queues the slug on math_pending', async () => {
  await fetchAndCacheArticle('logic', { skipMath: true });
  await flush();
  expect(mockRender).not.toHaveBeenCalled();
  expect(JSON.parse(mockMeta.math_pending)).toEqual(['logic']);
});

test('renderer timeout: article stays text-only, stays pending, no notification', async () => {
  mockRender.mockImplementation(async (items: Array<{ tex: string; display: boolean }>) =>
    items.map(it => ({ ...it, error: 'timeout' })));
  const ready: string[] = [];
  const off = onMathReady(s => ready.push(s));

  await fetchAndCacheArticle('logic');
  await flush(); await flush();

  expect(db.updateArticleHtml).not.toHaveBeenCalled();
  expect(ready).toEqual([]);
  expect(JSON.parse(mockMeta.math_pending)).toEqual(['logic']);
  off();
});

test('resumePendingMath finishes an interrupted article from the DB', async () => {
  mockMeta.math_pending = JSON.stringify(['logic']);
  mockEntries.logic = { content_html: '<p>Let \\(x\\) be.</p>' };
  mockRender.mockImplementation(okRender);

  await resumePendingMath();

  expect(db.updateArticleHtml).toHaveBeenCalledWith('logic', expect.stringContaining('<math-i '));
  expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
});

test('concurrent completion of one slug renders once', async () => {
  mockEntries.logic = { content_html: '<p>\\(x\\)</p>' };
  mockRender.mockImplementation(okRender);
  const [a, b] = await Promise.all([completeArticleMath('logic'), completeArticleMath('logic')]);
  expect(a && b).toBe(true);
  expect(mockRender).toHaveBeenCalledTimes(1);
});

test('a throwing listener does not break completion', async () => {
  mockEntries.logic = { content_html: '<p>\\(x\\)</p>' };
  mockRender.mockImplementation(okRender);
  const off = onMathReady(() => { throw new Error('boom'); });
  await expect(completeArticleMath('logic')).resolves.toBe(true);
  off();
});
