// The equation cache with plain fakes: an in-memory table, a scripted renderer, no timers, no globals.
import { createMathCache, MAX_RENDER_ATTEMPTS, type MathCacheDeps } from '../mathCache';
import type { MathResult } from '../ports';
import { mathHash } from '../../utils/mathKey';

type Script = (tex: string) => Partial<MathResult>;
const OK: Script = () => ({ b64: btoa('<svg/>'), w: 2, h: 1 });

function world(script: Script = OK, preStored: string[] = []) {
  const table = new Map<string, { w: number; h: number; display: boolean }>(preStored.map(h => [h, { w: 5, h: 5, display: false }]));
  const log: string[] = [];
  const renderedTex: string[] = [];
  const puts: string[][] = [];
  const deps: MathCacheDeps = {
    store: {
      getMathByHashes: async hashes => { log.push(`lookup:${hashes.length}`); return hashes.filter(h => table.has(h)).map(h => ({ hash: h, ...table.get(h)! })); },
      putMathBatch: async rows => { puts.push(rows.map(r => r.hash)); for (const r of rows) table.set(r.hash, { w: r.w, h: r.h, display: r.display }); },
    },
    renderChunked: async (items, opts) => {
      const out = items.map(it => { renderedTex.push(it.tex); return { tex: it.tex, display: it.display, ...script(it.tex) } as MathResult; });
      await opts.onChunk?.(0, out);
      return out;
    },
    pause: async p => { log.push(`pause:${p}`); },
    macrotask: async () => { log.push('macrotask'); },
  };
  return { cache: createMathCache(deps), deps, table, log, renderedTex, puts };
}

const realFetch = (globalThis as any).fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
  (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

describe('createMathCache with fakes', () => {
  test('dedupes by normalized key, renders only what is missing, and stores it', async () => {
    const stored = mathHash('y', false);
    const w = world(OK, [stored]);
    const r = await w.cache.ensureMath([{ tex: 'x', display: false }, { tex: ' x ', display: false }, { tex: 'y', display: false }], null);
    expect(r.stats).toMatchObject({ spots: 3, unique: 2, alreadyStored: 1, rendered: 1 });
    expect(w.renderedTex).toEqual(['x']);
    expect(r.complete).toBe(true);
    expect(r.dims.get(mathHash('x', false))).toEqual({ w: 2, h: 1 });
  });

  test('a display equation and an inline one with the same TeX are different equations', async () => {
    const w = world();
    const r = await w.cache.ensureMath([{ tex: 'x', display: false }, { tex: 'x', display: true }], null);
    expect(r.stats.unique).toBe(2);
  });

  test('the lookup is bounded: hundreds of hashes go to the store in several calls', async () => {
    const w = world();
    await w.cache.ensureMath(Array.from({ length: 900 }, (_, i) => ({ tex: `t${i}`, display: false })), null);
    const lookups = w.log.filter(l => l.startsWith('lookup:')).map(l => Number(l.slice(7)));
    expect(Math.max(...lookups)).toBeLessThanOrEqual(400);
    expect(lookups.reduce((a, b) => a + b, 0)).toBe(900);
  });

  test('transient failures are retried up to the limit, then the article is left incomplete', async () => {
    const w = world(() => ({ error: 'timeout' }));
    const r = await w.cache.ensureMath([{ tex: 'x', display: false }], null);
    expect(r.complete).toBe(false);
    expect(w.renderedTex).toHaveLength(MAX_RENDER_ATTEMPTS);
    await w.cache.ensureMath([{ tex: 'x', display: false }], null);       // within one run: no further attempts
    expect(w.renderedTex).toHaveLength(MAX_RENDER_ATTEMPTS);
  });

  test('TeX the engine rejects is permanent: counted as done, never retried', async () => {
    const w = world(() => ({ error: 'ParseError' }));
    const r = await w.cache.ensureMath([{ tex: 'bad', display: false }], null);
    expect(r.complete).toBe(true);
    expect(r.dims.size).toBe(0);
    await w.cache.ensureMath([{ tex: 'bad', display: false }], null);
    expect(w.renderedTex).toEqual(['bad']);
  });

  test('retry passes pause at the caller\'s priority, or a bare macrotask when ungated', async () => {
    const gated = world(() => ({ error: 'timeout' }));
    await gated.cache.ensureMath([{ tex: 'x', display: false }], 'background');
    expect(gated.log).toContain('pause:background');
    const ungated = world(() => ({ error: 'timeout' }));
    await ungated.cache.ensureMath([{ tex: 'x', display: false }], null);
    expect(ungated.log).toContain('macrotask');
    expect(ungated.log.some(l => l.startsWith('pause:'))).toBe(false);
  });

  test('reset forgets this run\'s failures, as a restart would', async () => {
    const w = world(() => ({ error: 'timeout' }));
    await w.cache.ensureMath([{ tex: 'x', display: false }], null);
    w.cache.reset();
    await w.cache.ensureMath([{ tex: 'x', display: false }], null);
    expect(w.renderedTex).toHaveLength(MAX_RENDER_ATTEMPTS * 2);
  });

  test('an instance owns its failure bookkeeping: another instance is unaffected', async () => {
    const a = world(() => ({ error: 'timeout' }));
    const b = world(() => ({ error: 'timeout' }));
    await a.cache.ensureMath([{ tex: 'x', display: false }], null);
    await b.cache.ensureMath([{ tex: 'x', display: false }], null);
    expect(a.renderedTex).toHaveLength(MAX_RENDER_ATTEMPTS);
    expect(b.renderedTex).toHaveLength(MAX_RENDER_ATTEMPTS);               // b did not inherit a's attempts
  });

  test('each chunk is stored before the next is requested (progress survives a crash)', async () => {
    const w = world();
    const order: string[] = [];
    w.deps.renderChunked = async (items, opts) => {
      for (const it of items) {
        const out = [{ tex: it.tex, display: it.display, ...OK(it.tex) } as MathResult];
        order.push(`render:${it.tex}`);
        await opts.onChunk?.(items.indexOf(it), out);
        order.push(`stored:${it.tex}`);
      }
      return [];
    };
    const origPut = w.deps.store.putMathBatch;
    w.deps.store.putMathBatch = async rows => { order.push(`put:${rows.length}`); await origPut(rows); };
    const cache = createMathCache(w.deps);
    await cache.ensureMath([{ tex: 'a', display: false }, { tex: 'b', display: false }], null);
    expect(order).toEqual(['render:a', 'put:1', 'stored:a', 'render:b', 'put:1', 'stored:b']);
  });
});
