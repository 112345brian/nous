// Dedupe across spots/articles and chunk-level crash safety, with an in-memory
// `math` table standing in for SQLite. Hand-written fixtures only.

const mockMeta: Record<string, string> = {};
const mockEntries: Record<string, { content_html: string }> = {};
const mockTable = new Map<string, { hash: string; svg: string; w: number; h: number; d: boolean }>();
let mockPutFailAt = 0;      // 1-based putMathBatch call number that "kills the app"
let mockPutCalls = 0;
let mockUpdateFail = false; // updateArticleHtml "kills the app" once

jest.mock('../db', () => require('./helpers/mockDbModule').asDbModule({
  getMeta: jest.fn(async (k: string) => mockMeta[k] ?? null),
  setMeta: jest.fn(async (k: string, v: string) => { mockMeta[k] = v; }),
  getEntryHtml: jest.fn(async (s: string) => mockEntries[s]?.content_html ?? null),
  updateArticleHtml: jest.fn(async (s: string, h: string) => {
    if (mockUpdateFail) { mockUpdateFail = false; throw new Error('killed'); }
    mockEntries[s] = { content_html: h };
  }),
  setArticleAst: jest.fn(async () => {}),
  getMathByHashes: jest.fn(async (hs: string[]) => hs.filter(h => mockTable.has(h)).map(h => mockTable.get(h)!)),
  putMathBatch: jest.fn(async (rows: Array<{ hash: string; svg: string; w: number; h: number; display: boolean }>) => {
    if (!rows.length) return;
    mockPutCalls++;
    if (mockPutFailAt && mockPutCalls === mockPutFailAt) throw new Error('killed');
    for (const r of rows) if (!mockTable.has(r.hash)) mockTable.set(r.hash, { hash: r.hash, svg: r.svg, w: r.w, h: r.h, d: r.display });
  }),
  // unused by these paths but imported by catalog.ts
  upsertIndexEntries: jest.fn(), cacheArticle: jest.fn(), getEntryCount: jest.fn(), getSlugsByCacheStatus: jest.fn(),
  getCachedSlugs: jest.fn(), indexLinks: jest.fn(), getAllEntryTitles: jest.fn(), invalidateLinkCache: jest.fn(),
  cleanDenormalizedTitles: jest.fn(), getUncachedAstSlugs: jest.fn(async () => []),
  putMath: jest.fn(), getMathSvgMap: jest.fn(async () => ({})), setEntryNotes: jest.fn(),
}));

const mockRender = jest.fn();
jest.mock('../../core/mathBridge', () => ({ createMathBridge: () => require('./fakeMathBridge').fakeMathBridge((...a: unknown[]) => mockRender(...a)) }));

import { completeArticleMath } from '../../composition';   // wired in the composition root
import { ensureMath, _resetMathCacheState } from '../../composition';   // built in the root
import { mathHash } from '../../utils/mathKey';

type Req = { tex: string; display: boolean };
const okRender = async (items: Req[]) => items.map(it => ({ ...it, b64: btoa(`<svg>${it.tex}</svg>`), w: 2, h: 1 }));
const rendered = () => mockRender.mock.calls.flatMap(c => (c[0] as Req[]).map(i => `${i.display ? 'D' : 'I'}:${i.tex}`));
const article = (texs: string[]) => `<p>${texs.map(t => `\\(${t}\\)`).join(' and ')}</p>`;
const uniq = (n: number, prefix = 'v') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const refs = (html: string) => (html.match(/<math-i /g) ?? []).length;

// "New process": in-memory retry/failure state is gone; the DB survives.
const restart = () => { _resetMathCacheState(); mockRender.mockClear(); mockPutCalls = 0; mockPutFailAt = 0; };

beforeEach(() => {
  jest.clearAllMocks();
  _resetMathCacheState();
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  for (const k of Object.keys(mockEntries)) delete mockEntries[k];
  mockTable.clear();
  mockPutFailAt = 0; mockPutCalls = 0; mockUpdateFail = false;
  mockRender.mockImplementation(okRender);
});

describe('dedupe', () => {
  test('a duplicate within an article is sent once and both spots get the same hash', async () => {
    mockEntries.a = { content_html: article(['x', 'y', 'x', 'x', 'y']) };
    expect(await completeArticleMath('a')).toBe(true);
    expect(rendered().sort()).toEqual(['I:x', 'I:y']);
    const hashes = [...mockEntries.a.content_html.matchAll(/hash="([0-9a-f]+)"/g)].map(m => m[1]);
    expect(hashes).toHaveLength(5);
    expect(new Set(hashes).size).toBe(2);
    expect(mockTable.size).toBe(2);
  });

  test('two articles sharing an equation render it once', async () => {
    mockEntries.a = { content_html: article(['x', 'shared']) };
    mockEntries.b = { content_html: article(['shared', 'z']) };
    await completeArticleMath('a');
    await completeArticleMath('b');
    expect(rendered().filter(r => r === 'I:shared')).toHaveLength(1);
    expect(refs(mockEntries.b.content_html)).toBe(2);
  });

  test('whitespace variants hit the same row; display flag keeps them apart', async () => {
    mockEntries.a = { content_html: '<p>\\(a  +\n b\\) \\(a + b\\) \\[a + b\\]</p>' };
    await completeArticleMath('a');
    expect(rendered().sort()).toEqual(['D:a + b', 'I:a + b']);
  });

  test('x_1 and x_{1} are different equations', async () => {
    mockEntries.a = { content_html: article(['x_1', 'x_{1}']) };
    await completeArticleMath('a');
    expect(rendered().sort()).toEqual(['I:x_1', 'I:x_{1}']);
  });

  test('reports counts', async () => {
    mockTable.set(mathHash('old', false), { hash: mathHash('old', false), svg: '<svg/>', w: 1, h: 1, d: false });
    const r = await ensureMath([{ tex: 'old', display: false }, { tex: 'n', display: false }, { tex: 'n', display: false }], null);
    expect(r.stats).toEqual({ spots: 3, unique: 2, alreadyStored: 1, rendered: 1 });
    expect(r.complete).toBe(true);
  });

  test('a large lookup is split into bounded IN lists', async () => {
    const db = require('../db');
    const spots = uniq(1000).map(t => ({ tex: t, display: false }));
    await ensureMath(spots, null);
    const sizes = db.getMathByHashes.mock.calls.map((c: unknown[][]) => (c[0] as string[]).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(400);
    expect(sizes.reduce((a: number, b: number) => a + b, 0)).toBe(1000);
  });
});

describe('crash safety: the chunk is the unit of durability', () => {
  test('chunks are written one by one, each before the next is requested', async () => {
    mockEntries.a = { content_html: article(uniq(50)) };
    const order: string[] = [];
    mockRender.mockImplementation(async (items: Req[]) => { order.push('render'); return okRender(items); });
    const db = require('../db');
    db.putMathBatch.mockImplementationOnce(async () => { order.push('put'); })
      .mockImplementationOnce(async () => { order.push('put'); })
      .mockImplementationOnce(async () => { order.push('put'); });
    await completeArticleMath('a');
    expect(order).toEqual(['render', 'put', 'render', 'put', 'render', 'put']); // 24 + 24 + 2
  });

  test('kill after k chunks: resume renders only the missing hashes, nothing twice', async () => {
    mockEntries.a = { content_html: article(uniq(60)) };
    mockMeta.math_pending = JSON.stringify(['a']);
    mockPutFailAt = 3; // dies while storing the third chunk (24 + 24 + 12)
    expect(await completeArticleMath('a')).toBe(false);
    expect(mockTable.size).toBe(48);
    expect(mockEntries.a.content_html).not.toContain('<math-i'); // not finalized
    expect(JSON.parse(mockMeta.math_pending)).toEqual(['a']);    // still pending
    const first = rendered();
    expect(first).toHaveLength(60); // the third chunk was rendered but lost: at most one chunk

    restart();
    expect(await completeArticleMath('a')).toBe(true);
    const second = rendered();
    expect(second).toHaveLength(12);
    expect(second.filter(x => first.slice(0, 48).includes(x))).toEqual([]); // no stored equation rendered again
    expect(refs(mockEntries.a.content_html)).toBe(60);
    expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
  });

  test('kill between the last chunk and finalization: resume finalizes with zero rendering', async () => {
    mockEntries.a = { content_html: article(uniq(30)) };
    mockMeta.math_pending = JSON.stringify(['a']);
    mockUpdateFail = true;
    expect(await completeArticleMath('a')).toBe(false);
    expect(mockTable.size).toBe(30);
    expect(mockEntries.a.content_html).not.toContain('<math-i');

    restart();
    expect(await completeArticleMath('a')).toBe(true);
    expect(mockRender).not.toHaveBeenCalled();
    expect(refs(mockEntries.a.content_html)).toBe(30);
    expect(JSON.parse(mockMeta.math_pending)).toEqual([]);
  });

  test('a failing chunk does not block the rest of the article; retries are bounded', async () => {
    const texs = uniq(72); // chunks of 24: v0-23, v24-47, v48-71
    mockEntries.a = { content_html: article(texs) };
    mockRender.mockImplementation(async (items: Req[]) => {
      if (items.some(i => i.tex === 'v30')) throw new Error('webview died'); // poisons the middle chunk
      return okRender(items);
    });
    expect(await completeArticleMath('a')).toBe(false); // stays pending
    expect(mockTable.size).toBe(48);                    // the other two chunks are safe
    expect(mockRender.mock.calls.length).toBeLessThanOrEqual(3 + 1);  // 3 chunks + 1 retry of the failed one, then stop
    const callsAfterFirstRun = mockRender.mock.calls.length;
    expect(await completeArticleMath('a')).toBe(false);  // same process: attempts exhausted, no loop
    expect(mockRender.mock.calls.length).toBe(callsAfterFirstRun);

    restart(); // next launch, renderer healthy again
    mockRender.mockImplementation(okRender);
    expect(await completeArticleMath('a')).toBe(true);
    expect(rendered()).toHaveLength(24); // only the failed chunk
    expect(refs(mockEntries.a.content_html)).toBe(72);
  });

  test('one bad article does not block another', async () => {
    mockEntries.bad = { content_html: article(['poison']) };
    mockEntries.ok = { content_html: article(['fine']) };
    mockRender.mockImplementation(async (items: Req[]) => {
      if (items.some(i => i.tex === 'poison')) throw new Error('boom');
      return okRender(items);
    });
    expect(await completeArticleMath('bad')).toBe(false);
    expect(await completeArticleMath('ok')).toBe(true);
  });

  test('TeX MathJax rejects is left as raw text and does not hold the article pending', async () => {
    mockEntries.a = { content_html: article(['good', '\\bad{']) };
    mockRender.mockImplementation(async (items: Req[]) =>
      items.map(it => it.tex === '\\bad{' ? { ...it, error: 'Missing close brace' } : { ...it, b64: btoa('<svg/>'), w: 1, h: 1 }));
    expect(await completeArticleMath('a')).toBe(true);
    expect(refs(mockEntries.a.content_html)).toBe(1);
    expect(mockEntries.a.content_html).toContain('\\(\\bad{\\)');
    expect(mockRender).toHaveBeenCalledTimes(1); // not retried
  });
});
