// The deferred-math completion pipeline as seen through catalog's exports (onMathReady,
// completeArticleMath, resumePendingMath, fetchAndCacheArticle). Complements
// deferredMath.test.ts, which pins the main flow. Written BEFORE the state machine moved into
// src/core/mathCompletion.ts and kept unchanged afterwards. db and the renderer are fakes.
import { completeArticleMath, onMathReady, resumePendingMath, fetchAndCacheArticle } from '../../composition';   // wired in the composition root
import * as dbModule from '../db';
import type { Db } from '../db';
const db = dbModule as unknown as jest.Mocked<Db>;
import { _resetMathCacheState } from '../../composition';   // the math runtime is built in the root
import { parseSepHtml } from '../../utils/sepHtml/parse';

const mockMeta: Record<string, string> = {};
const mockEntries: Record<string, string> = {};
let mockMetaLag = false;

jest.mock('../db', () => require('./helpers/mockDbModule').asDbModule({
  getMeta: jest.fn(async (k: string) => { if (mockMetaLag) await new Promise<void>(r => setTimeout(r, 0)); return mockMeta[k] ?? null; }),
  setMeta: jest.fn(async (k: string, v: string) => { if (mockMetaLag) await new Promise<void>(r => setTimeout(r, 0)); mockMeta[k] = v; }),
  cacheArticle: jest.fn(async (slug: string, d: { content_html: string }) => { mockEntries[slug] = d.content_html; }),
  indexLinks: jest.fn(async () => {}),
  getEntryHtml: jest.fn(async (slug: string) => mockEntries[slug] ?? null),
  updateArticleHtml: jest.fn(async (slug: string, html: string) => { mockEntries[slug] = html; }),
  setArticleAst: jest.fn(async () => {}),
  putMathBatch: jest.fn(async () => {}),
  getMathByHashes: jest.fn(async () => []),
}));
const mockRender = jest.fn();
jest.mock('../../core/mathBridge', () => ({ createMathBridge: () => require('./fakeMathBridge').fakeMathBridge((...a: unknown[]) => mockRender(...a)) }));
jest.mock('../perf', () => ({ perf: { enabled: false, begin() {}, end() {}, mark() {}, time: (_k: string, _s: string, fn: () => unknown) => fn(), timeSync: (_k: string, _s: string, fn: () => unknown) => fn() } }));

const m = db as jest.Mocked<typeof db>;
const TEX = '<p>Let \\(x\\) be a set.</p>';
const okRender = async (items: Array<{ tex: string; display: boolean }>) =>
  items.map(it => ({ ...it, b64: btoa('<svg/>'), w: 2, h: 1 }));
const pending = () => JSON.parse(mockMeta.math_pending ?? '[]') as string[];
const tick = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
  _resetMathCacheState();
  jest.clearAllMocks();
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  for (const k of Object.keys(mockEntries)) delete mockEntries[k];
  mockMetaLag = false;
  mockRender.mockImplementation(okRender);
  m.getEntryHtml.mockImplementation(async slug => mockEntries[slug] ?? null);
  m.updateArticleHtml.mockImplementation(async (slug, html) => { mockEntries[slug] = html; });
  (globalThis as any).fetch = jest.fn(async () => ({ ok: true, text: async () => `<div id="aueditable"><h1>T</h1>${TEX}</div>` }));
});

describe('the pending record (meta "math_pending")', () => {
  test('a slug is recorded before rendering starts and removed when it finishes', async () => {
    let release!: () => void;
    mockRender.mockImplementation(async items => { await new Promise<void>(r => { release = r; }); return okRender(items); });
    await fetchAndCacheArticle('logic');
    await tick(); await tick();
    expect(pending()).toEqual(['logic']);
    release();
    await tick(); await tick(); await tick();
    expect(pending()).toEqual([]);
  });

  test('a corrupt record is survived: caching still succeeds, nothing throws', async () => {
    mockMeta.math_pending = '{not json';
    await expect(fetchAndCacheArticle('logic')).resolves.toBe(true);
    await tick(); await tick(); await tick();
    expect(mockMeta.math_pending).toBe('{not json');   // the failed update is dropped, not "repaired"
  });

  test('concurrent completions do not lose each other (updates are serialized)', async () => {
    mockMetaLag = true;
    mockMeta.math_pending = JSON.stringify(['a', 'b']);
    mockEntries.a = TEX; mockEntries.b = TEX;
    await Promise.all([completeArticleMath('a'), completeArticleMath('b')]);
    expect(pending()).toEqual([]);
  });
});

describe('completeArticleMath', () => {
  test('an article that is not in the library: false, nothing rendered, still pending', async () => {
    mockMeta.math_pending = JSON.stringify(['gone']);
    expect(await completeArticleMath('gone')).toBe(false);
    expect(mockRender).not.toHaveBeenCalled();
    expect(pending()).toEqual(['gone']);
  });

  test('html passed in is used and the library is not read', async () => {
    expect(await completeArticleMath('a', TEX)).toBe(true);
    expect(m.getEntryHtml).not.toHaveBeenCalled();
    expect(m.updateArticleHtml).toHaveBeenCalledTimes(1);
  });

  test('the rewritten article and its AST are written together, AST of the new HTML', async () => {
    mockEntries.a = TEX;
    await completeArticleMath('a');
    const html = m.updateArticleHtml.mock.calls[0][1];
    expect(html).toContain('<math-i');
    expect(m.setArticleAst).toHaveBeenCalledWith('a', JSON.stringify(parseSepHtml(html)));
  });

  test('an article with no TeX at all counts as done: true, no write, pending cleared, listeners told', async () => {
    mockEntries.plain = '<p>No maths.</p>';
    mockMeta.math_pending = JSON.stringify(['plain']);
    const seen: string[] = [];
    const off = onMathReady(s => seen.push(s));
    expect(await completeArticleMath('plain')).toBe(true);
    off();
    expect(m.updateArticleHtml).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
    expect(seen).toEqual(['plain']);
  });

  test('once finished, a second call neither re-renders nor stays "in flight"', async () => {
    mockEntries.a = TEX;
    expect(await completeArticleMath('a')).toBe(true);
    expect(await completeArticleMath('a')).toBe(true);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  test('a failing database write is false, not an exception, and leaves it pending', async () => {
    mockEntries.a = TEX;
    mockMeta.math_pending = JSON.stringify(['a']);
    m.updateArticleHtml.mockRejectedValue(new Error('disk'));
    expect(await completeArticleMath('a')).toBe(false);
    expect(pending()).toEqual(['a']);
  });
});

describe('onMathReady', () => {
  test('every subscriber is told, unsubscribing stops delivery', async () => {
    mockEntries.a = TEX; mockEntries.b = TEX;
    const one: string[] = []; const two: string[] = [];
    const offOne = onMathReady(s => one.push(s));
    const offTwo = onMathReady(s => two.push(s));
    await completeArticleMath('a');
    offOne();
    await completeArticleMath('b');
    offTwo();
    expect(one).toEqual(['a']);
    expect(two).toEqual(['a', 'b']);
  });
});

describe('resumePendingMath', () => {
  test('a corrupt record is ignored without throwing', async () => {
    mockMeta.math_pending = 'nope';
    await expect(resumePendingMath()).resolves.toBeUndefined();
    expect(mockRender).not.toHaveBeenCalled();
  });

  test('finishes interrupted articles one at a time, in order, and keeps going after a failure', async () => {
    mockMeta.math_pending = JSON.stringify(['a', 'missing', 'b']);
    mockEntries.a = TEX; mockEntries.b = TEX;
    const order: string[] = [];
    let active = 0; let maxActive = 0;
    mockRender.mockImplementation(async items => {
      active++; maxActive = Math.max(maxActive, active);
      order.push(items[0].tex);
      await tick();
      active--;
      return okRender(items);
    });
    await resumePendingMath();
    expect(maxActive).toBe(1);
    expect(m.updateArticleHtml.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
    expect(pending()).toEqual(['missing']);
  });

  // Before the math priority model this paused a fixed 32 ms; it now yields to the model
  // (yieldThenMathMayRun), whose gating policy is covered in mathPriority.test.ts.
  test('it yields to the event loop before each article instead of starting at once', async () => {
    jest.useFakeTimers();
    mockMeta.math_pending = JSON.stringify(['a']);
    mockEntries.a = TEX;
    const p = resumePendingMath();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(m.updateArticleHtml).not.toHaveBeenCalled();
    await jest.runAllTimersAsync();
    await p;
    expect(m.updateArticleHtml).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
