// backfillMathInline / downloadAll / syncCachedArticles as callers of the math
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

import * as db from '../db';
import { _resetMathCacheState } from '../mathCache';
import { backfillMathInline } from '../../composition';   // wired in the composition root
import { downloadAll, syncCachedArticles } from '../../composition';   // moved to the composition root

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

describe('backfillMathInline', () => {
  test('finishes pending math first, rewrites each article, then sets the one-shot flag', async () => {
    mockMeta.math_pending = JSON.stringify(['p']);
    mockEntries.p = { content_html: '<p>\\(p\\)</p>' };
    mockEntries.a = { content_html: '<p>\\(a\\)</p>' };
    mockEntries.b = { content_html: '<p>no tex</p>' };
    mockMathArticles = [
      { slug: 'a', content_html: '<p>\\(a\\)</p>' },
      { slug: 'b', content_html: '<p>no tex</p>' },
    ];
    await backfillMathInline();
    expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
    expect(mockEntries.p.content_html).toContain('<math-i ');
    expect(mockEntries.a.content_html).toContain('<math-i ');
    expect(mockEntries.b.content_html).toBe('<p>no tex</p>'); // untouched
    expect(mockMeta.math_inline_v2).toBe('1');
  });

  test('is a no-op after the flag is set (but still resumes pending math)', async () => {
    mockMeta.math_inline_v2 = '1';
    mockMeta.math_pending = JSON.stringify(['p']);
    mockEntries.p = { content_html: '<p>\\(p\\)</p>' };
    await backfillMathInline();
    expect(db.getMathArticleHtml).not.toHaveBeenCalled();
    expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
  });

  test('a failing article does not stop the rest', async () => {
    mockEntries.a = { content_html: '<p>\\(a\\)</p>' };
    mockEntries.b = { content_html: '<p>\\(b\\)</p>' };
    mockMathArticles = [
      { slug: 'a', content_html: '<p>\\(a\\)</p>' },
      { slug: 'b', content_html: '<p>\\(b\\)</p>' },
    ];
    // 'a' always fails (a single failure is now retried once, see mathCache.ts).
    mockRender.mockImplementation(async (items: Array<{ tex: string; display: boolean }>) => {
      if (items.some(i => i.tex === 'a')) throw new Error('boom');
      return okRender(items);
    });
    await backfillMathInline();
    expect(mockEntries.a.content_html).toBe('<p>\\(a\\)</p>');
    expect(mockEntries.b.content_html).toContain('<math-i ');
    expect(mockMeta.math_inline_v2).toBe('1');
  });
});

describe('bulk downloads', () => {
  test('downloadAll skips math and records nothing in math_pending (known gap)', async () => {
    await downloadAll(() => {});
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockMeta.math_pending).toBeUndefined();
    expect(Object.keys(mockEntries).sort()).toEqual(['a', 'b']);
  });

  test('syncCachedArticles renders math inline (awaitMath) and stamps last_deep_sync', async () => {
    await syncCachedArticles(() => {});
    expect(mockRender).toHaveBeenCalled();
    expect(mockEntries.a.content_html).toContain('<math-i ');
    expect(mockMeta.last_deep_sync).toBeDefined();
  });
});
