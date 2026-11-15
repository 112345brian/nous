// The math-completion pipeline run with plain in-memory fakes: no jest.mock, no SQLite, no renderer,
// no timers. Date.now and fetch throw, to prove the core never reaches for them.
import { createMathCompletion, MATH_PENDING_KEY, type MathCompletionDeps } from '../mathCompletion';

const TEX = '<p>Let \\(x\\) be a set.</p>';
const RENDERED = '<p>Let <math-i hash="h"></math-i> be a set.</p>';

function world(o: { entries?: Record<string, string>; pending?: string[]; rendered?: string | ((html: string) => string); substituteFails?: boolean; metaLag?: boolean } = {}) {
  const log: string[] = [];
  const entries: Record<string, string> = { ...(o.entries ?? {}) };
  const meta = new Map<string, string>();
  if (o.pending) meta.set(MATH_PENDING_KEY, JSON.stringify(o.pending));
  const asts: Record<string, string> = {};
  const lag = () => (o.metaLag ? new Promise<void>(r => setTimeout(r, 0)) : Promise.resolve());
  const deps: MathCompletionDeps = {
    substitute: async html => {
      log.push('substitute');
      if (o.substituteFails) throw new Error('renderer');
      const r = o.rendered ?? RENDERED;
      return typeof r === 'function' ? r(html) : html.replace(/\\\(.*?\\\)/g, r === RENDERED ? '<math-i hash="h"></math-i>' : r);
    },
    articles: {
      getEntryHtml: async slug => { log.push(`read:${slug}`); return entries[slug] ?? null; },
      updateArticleHtml: async (slug, html) => { log.push(`write:${slug}`); entries[slug] = html; },
      setArticleAst: async (slug, ast) => { log.push(`ast:${slug}`); asts[slug] = ast; },
    },
    meta: {
      getMeta: async k => { await lag(); return meta.get(k) ?? null; },
      setMeta: async (k, v) => { await lag(); log.push(`set:${k}`); meta.set(k, v); },
    },
    sleep: async ms => { log.push(`sleep:${ms}`); },
  };
  const pending = () => JSON.parse(meta.get(MATH_PENDING_KEY) ?? '[]') as string[];
  return { deps, log, entries, asts, meta, pending };
}

describe('createMathCompletion with fakes', () => {
  const realFetch = (globalThis as any).fetch;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
    (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
  });
  afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

  test('completing renders, rewrites the article and its AST, clears the debt, tells listeners', async () => {
    const w = world({ entries: { a: TEX }, pending: ['a', 'other'] });
    const mc = createMathCompletion(w.deps);
    const seen: string[] = [];
    mc.onMathReady(s => seen.push(s));
    expect(await mc.completeArticleMath('a')).toBe(true);
    expect(w.entries.a).toBe(RENDERED);
    expect(JSON.parse(w.asts.a)).toBeTruthy();
    expect(w.log.slice(0, 4)).toEqual(['read:a', 'substitute', 'write:a', 'ast:a']);
    expect(w.pending()).toEqual(['other']);
    expect(seen).toEqual(['a']);
  });

  test('an instance owns its state: listeners and in-flight work are not shared', async () => {
    const one = world({ entries: { a: TEX } });
    const two = world({ entries: { a: TEX } });
    const a = createMathCompletion(one.deps);
    const b = createMathCompletion(two.deps);
    const heardA: string[] = []; const heardB: string[] = [];
    a.onMathReady(s => heardA.push(s));
    b.onMathReady(s => heardB.push(s));
    await Promise.all([a.completeArticleMath('a'), b.completeArticleMath('a')]);
    expect(heardA).toEqual(['a']);
    expect(heardB).toEqual(['a']);
    expect(one.log.filter(l => l === 'substitute')).toHaveLength(1);
    expect(two.log.filter(l => l === 'substitute')).toHaveLength(1);
  });

  test('two calls for one slug at once render once and share the result', async () => {
    const w = world({ entries: { a: TEX } });
    const mc = createMathCompletion(w.deps);
    const [x, y] = await Promise.all([mc.completeArticleMath('a'), mc.completeArticleMath('a')]);
    expect([x, y]).toEqual([true, true]);
    expect(w.log.filter(l => l === 'substitute')).toHaveLength(1);
  });

  test('read-modify-write on the pending record is serialized (no lost updates)', async () => {
    const w = world({ entries: { a: TEX, b: TEX }, pending: ['a', 'b'], metaLag: true });
    const mc = createMathCompletion(w.deps);
    await Promise.all([mc.completeArticleMath('a'), mc.completeArticleMath('b')]);
    expect(w.pending()).toEqual([]);
  });

  describe('when it cannot finish', () => {
    test('a missing article: false, stays pending', async () => {
      const w = world({ pending: ['gone'] });
      expect(await createMathCompletion(w.deps).completeArticleMath('gone')).toBe(false);
      expect(w.pending()).toEqual(['gone']);
      expect(w.log).toEqual(['read:gone']);
    });
    test('a renderer that throws: false, nothing written, stays pending, no exception', async () => {
      const w = world({ entries: { a: TEX }, pending: ['a'], substituteFails: true });
      const mc = createMathCompletion(w.deps);
      const seen: string[] = [];
      mc.onMathReady(s => seen.push(s));
      expect(await mc.completeArticleMath('a')).toBe(false);
      expect(w.log).not.toContain('write:a');
      expect(w.pending()).toEqual(['a']);
      expect(seen).toEqual([]);
    });
    test('a renderer that returned nothing for an article that still has TeX: false, stays pending', async () => {
      const w = world({ entries: { a: TEX }, pending: ['a'], rendered: html => html });
      expect(await createMathCompletion(w.deps).completeArticleMath('a')).toBe(false);
      expect(w.pending()).toEqual(['a']);
    });
    test('an unclosed delimiter is not TeX to render, so an unchanged article is done', async () => {
      const w = world({ entries: { a: '<p>costs \\(5 dollars</p>' }, pending: ['a'], rendered: html => html });
      expect(await createMathCompletion(w.deps).completeArticleMath('a')).toBe(true);
      expect(w.pending()).toEqual([]);
    });
  });

  test('a throwing listener does not stop the others or the result', async () => {
    const w = world({ entries: { a: TEX } });
    const mc = createMathCompletion(w.deps);
    const seen: string[] = [];
    mc.onMathReady(() => { throw new Error('bug'); });
    mc.onMathReady(s => seen.push(s));
    expect(await mc.completeArticleMath('a')).toBe(true);
    expect(seen).toEqual(['a']);
  });

  test('completeLater records the debt before it renders, and does not wait', async () => {
    const w = world({ entries: { a: TEX } });
    const mc = createMathCompletion(w.deps);
    expect(mc.completeLater('a', TEX)).toBeUndefined();
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
    const setFirst = w.log.indexOf(`set:${MATH_PENDING_KEY}`);
    expect(setFirst).toBeGreaterThanOrEqual(0);
    expect(setFirst).toBeLessThan(w.log.indexOf('substitute'));
    expect(w.pending()).toEqual([]);     // and cleared again once rendering finished
  });

  test('resumePendingMath: one at a time, in order, yielding through the injected sleep, surviving failures', async () => {
    const w = world({ entries: { a: TEX, b: TEX }, pending: ['a', 'missing', 'b'] });
    await createMathCompletion(w.deps).resumePendingMath();
    expect(w.log.filter(l => l.startsWith('sleep:') || l.startsWith('write:'))).toEqual(
      ['sleep:32', 'write:a', 'sleep:32', 'sleep:32', 'write:b']);
    expect(w.pending()).toEqual(['missing']);
  });

  test('resumePendingMath with a corrupt or empty record does nothing', async () => {
    const w = world();
    w.meta.set(MATH_PENDING_KEY, '{nope');
    await expect(createMathCompletion(w.deps).resumePendingMath()).resolves.toBeUndefined();
    const empty = world();
    await createMathCompletion(empty.deps).resumePendingMath();
    expect(empty.log).toEqual([]);
  });
});
