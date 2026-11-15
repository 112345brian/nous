// resumePendingMath / downloadAll / syncCachedArticles as callers of the math
// pipeline. Pins current behavior before the priority model changes how they
// pace themselves. Hand-written fixtures only.

const mockMeta: Record<string, string> = {};
const mockEntries: Record<string, { content_html: string }> = {};
let mockMathArticles: Array<{ slug: string; content_html: string }> = [];

jest.mock('../db', () => ({
  upsertIndexEntries: jest.fn(),
  cacheArticle: jest.fn(async (slug: string, d: { content_html: string }) => { mockEntries[slug] = { content_html: d.content_html }; }),
  getMeta: jest.fn(async (k: string) => mockMeta[k] ?? null),
  setMeta: jest.fn(async (k: string, v: string) => { mockMeta[k] = v; }),
  getEntryCount: jest.fn(async () => 1),
  getSlugsByCacheStatus: jest.fn(async () => ({ uncached: [{ slug: 'a', title: 'A' }, { slug: 'b', title: 'B' }], cached: [] })),
  getCachedSlugs: jest.fn(async () => [{ slug: 'a', title: 'A' }]),
  indexLinks: jest.fn(async () => {}),
  getAllEntryTitles: jest.fn(async () => []),
  invalidateLinkCache: jest.fn(),
  cleanDenormalizedTitles: jest.fn(),
  getMathArticleHtml: jest.fn(async () => mockMathArticles),
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

import { _resetMathCacheState } from '../mathCache';
import { fetchAndCacheArticle, resumePendingMath, downloadAll, syncCachedArticles } from '../../composition';   // wired in the composition root

const okRender = async (items: Array<{ tex: string; display: boolean }>) =>
  items.map(it => ({ ...it, b64: btoa('<svg/>'), w: 2, h: 1 }));

const PAGE = `<html><head><title>T (Stanford Encyclopedia of Philosophy)</title></head>
<body><div id="aueditable"><h1>T</h1><p>Let \\(x\\) be.</p></div></body></html>`;

beforeEach(() => {
  _resetMathCacheState();
  jest.clearAllMocks();
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  for (const k of Object.keys(mockEntries)) delete mockEntries[k];
  mockMathArticles = [];
  mockRender.mockImplementation(okRender);
  (globalThis as any).fetch = jest.fn(async () => ({ ok: true, text: async () => PAGE }));
});

describe('resumePendingMath (launch drain)', () => {
  test('finishes pending math and clears the list', async () => {
    mockMeta.math_pending = JSON.stringify(['p']);
    mockEntries.p = { content_html: '<p>\\(p\\)</p>' };
    await resumePendingMath();
    expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
    expect(mockEntries.p.content_html).toContain('<math-i ');
  });

  test('a failing article does not stop the rest and stays pending', async () => {
    mockMeta.math_pending = JSON.stringify(['a', 'b']);
    mockEntries.a = { content_html: '<p>\\(a\\)</p>' };
    mockEntries.b = { content_html: '<p>\\(b\\)</p>' };
    mockRender.mockImplementation(async (items: Array<{ tex: string; display: boolean }>) => {
      if (items.some(i => i.tex === 'a')) throw new Error('boom');
      return okRender(items);
    });
    await resumePendingMath();
    expect(mockEntries.a.content_html).toBe('<p>\\(a\\)</p>');
    expect(mockEntries.b.content_html).toContain('<math-i ');
    expect(JSON.parse(mockMeta.math_pending)).toEqual(['a']);
  });

  test('a killed run resumes with only the missing hashes', async () => {
    mockMeta.math_pending = JSON.stringify(['a']);
    mockEntries.a = { content_html: '<p>\\(x\\) and \\(y\\)</p>' };
    mockRender.mockImplementationOnce(async () => { throw new Error('killed'); });
    mockRender.mockImplementationOnce(async () => { throw new Error('killed'); });
    await resumePendingMath(); // run 1 dies; nothing persisted
    _resetMathCacheState();    // fresh process
    mockRender.mockClear();
    mockRender.mockImplementation(okRender);
    await resumePendingMath();
    expect(mockEntries.a.content_html).toContain('<math-i ');
  });
});

describe('skipMath articles are queued and drained (was: never rendered)', () => {
  test('an article cached with skipMath gets its equations at the next launch', async () => {
    await fetchAndCacheArticle('a', { skipMath: true });
    expect(mockEntries.a.content_html).toContain('\\(x\\)');
    await resumePendingMath();
    expect(mockEntries.a.content_html).toContain('<math-i ');
  });
});

describe('bulk downloads', () => {
  test('downloadAll renders nothing inline and queues every math article on math_pending', async () => {
    const hold = jest.spyOn(require('../mathPriority'), 'yieldThenMathMayRun').mockImplementation(() => new Promise<void>(() => {}));
    await downloadAll(() => {});
    hold.mockRestore();
    expect(mockRender).not.toHaveBeenCalled();
    expect(JSON.parse(mockMeta.math_pending).sort()).toEqual(['a', 'b']);
    expect(Object.keys(mockEntries).sort()).toEqual(['a', 'b']);
  });

  test('after downloadAll the pending list drains', async () => {
    await downloadAll(() => {});
    await new Promise<void>(r => setTimeout(() => r(), 1500));
    for (let i = 0; i < 50 && JSON.parse(mockMeta.math_pending).length; i++) await new Promise<void>(r => setTimeout(() => r(), 200));
    expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
    expect(mockEntries.a.content_html).toContain('<math-i ');
  });

  test('syncCachedArticles renders math inline (awaitMath) and stamps last_deep_sync', async () => {
    await syncCachedArticles(() => {});
    expect(mockRender).toHaveBeenCalled();
    expect(mockEntries.a.content_html).toContain('<math-i ');
    expect(mockMeta.last_deep_sync).toBeDefined();
  });
});
