import { prewarmCommonMath, PrewarmDeps } from '../prewarmCommonMath';

// Hand-written fixtures only (generic formulas we authored; no SEP text).
const LIST = [
  { tex: 'x^2', display: false }, { tex: 'y^2', display: false }, { tex: 'z^2', display: false },
  { tex: 'a+b', display: true }, { tex: 'c+d', display: true },
];
const hash = (tex: string, display: boolean) => `${display ? 'D' : 'I'}:${tex}`;

function fakes(over: Partial<PrewarmDeps> & { cached?: string[]; stamp?: string | null } = {}) {
  const cached = new Set(over.cached ?? []);
  let stamp = over.stamp ?? null;
  const calls = { render: [] as string[][], put: [] as string[][], lookups: 0 };
  const deps: PrewarmDeps = {
    list: LIST,
    stamp: 'v1',
    hash,
    getCachedSvgMap: async hs => { calls.lookups++; const m: Record<string, string> = {}; for (const h of hs) if (cached.has(h)) m[h] = '<svg/>'; return m; },
    render: async items => { calls.render.push(items.map(i => hash(i.tex, i.display))); return items.map(i => ({ ...i, b64: 'PHN2Zy8+', w: 1, h: 1 })); },
    putBatch: async rows => { calls.put.push(rows.map(r => r.hash)); rows.forEach(r => cached.add(r.hash)); },
    getStamp: async () => stamp,
    setStamp: async s => { stamp = s; },
    chunkSize: 2,
    ...over,
  };
  return { deps, calls, cached, getStamp: () => stamp };
}

describe('prewarmCommonMath', () => {
  it('does nothing when the stamp is current (no lookup, no render)', async () => {
    const f = fakes({ stamp: 'v1' });
    const r = await prewarmCommonMath(f.deps);
    expect(r.status).toBe('current');
    expect(f.calls.lookups).toBe(0);
    expect(f.calls.render).toEqual([]);
    expect(f.calls.put).toEqual([]);
  });

  it('renders only hashes missing from the table, in chunks, persisting per chunk', async () => {
    const f = fakes({ cached: ['I:y^2', 'D:c+d'] });
    const r = await prewarmCommonMath(f.deps);
    expect(f.calls.render).toEqual([['I:x^2', 'I:z^2'], ['D:a+b']]);
    expect(f.calls.put).toEqual([['I:x^2', 'I:z^2'], ['D:a+b']]);
    expect(r).toMatchObject({ status: 'done', skipped: 2, rendered: 3, failed: 0, remaining: 0 });
    expect(f.getStamp()).toBe('v1');
  });

  it('writes chunk 1 before chunk 2 is rendered', async () => {
    const order: string[] = [];
    const f = fakes();
    f.deps.render = async items => { order.push('render'); return items.map(i => ({ ...i, b64: 'PHN2Zy8+', w: 1, h: 1 })); };
    f.deps.putBatch = async () => { order.push('put'); };
    await prewarmCommonMath(f.deps);
    expect(order).toEqual(['render', 'put', 'render', 'put', 'render', 'put']);
  });

  it('is a no-render run (but stamps) when everything is already cached', async () => {
    const f = fakes({ cached: LIST.map(e => hash(e.tex, e.display)) });
    const r = await prewarmCommonMath(f.deps);
    expect(f.calls.render).toEqual([]);
    expect(r.status).toBe('done');
    expect(f.getStamp()).toBe('v1');
  });

  it('does not stamp when some equations failed, and a rerun renders only the missing', async () => {
    const f = fakes();
    const real = f.deps.render;
    f.deps.render = async items => (await real(items)).map(r => (r.tex === 'y^2' ? { tex: r.tex, display: r.display, error: 'bad' } : r));
    const r1 = await prewarmCommonMath(f.deps);
    expect(r1.status).toBe('partial');
    expect(r1.failed).toBe(1);
    expect(f.getStamp()).toBeNull();
    f.deps.render = real;
    f.calls.render.length = 0;
    const r2 = await prewarmCommonMath(f.deps);
    expect(f.calls.render).toEqual([['I:y^2']]);
    expect(r2.status).toBe('done');
    expect(f.getStamp()).toBe('v1');
  });

  it('stops after a chunk that renders nothing (engine down) instead of hammering', async () => {
    const f = fakes();
    f.deps.render = async items => { f.calls.render.push([]); return items.map(i => ({ ...i, error: 'timeout' })); };
    const r = await prewarmCommonMath(f.deps);
    expect(f.calls.render.length).toBe(1);
    expect(r.status).toBe('partial');
    expect(f.getStamp()).toBeNull();
  });

  it('a render that throws leaves stamp unset and persists earlier chunks', async () => {
    const f = fakes();
    let n = 0;
    const real = f.deps.render;
    f.deps.render = async items => { if (++n === 2) throw new Error('boom'); return real(items); };
    await expect(prewarmCommonMath(f.deps)).rejects.toThrow('boom');
    expect(f.calls.put.length).toBe(1);
    expect(f.getStamp()).toBeNull();
  });

  it('maxChunks limits work per call and reports what remains', async () => {
    const f = fakes();
    const r = await prewarmCommonMath(f.deps, { maxChunks: 1 });
    expect(f.calls.render).toEqual([['I:x^2', 'I:y^2']]);
    expect(r).toMatchObject({ status: 'partial', rendered: 2, remaining: 3 });
    expect(f.getStamp()).toBeNull();
  });

  it('calls beforeChunk before every chunk (the priority-scheduler hook)', async () => {
    const f = fakes();
    let n = 0;
    f.deps.beforeChunk = async () => { n++; };
    await prewarmCommonMath(f.deps);
    expect(n).toBe(3);
  });

  it('ignores duplicate hashes in the list', async () => {
    const f = fakes({ list: [...LIST, { tex: 'x^2', display: false }] });
    await prewarmCommonMath(f.deps);
    expect(f.calls.render.flat().sort()).toEqual(['D:a+b', 'D:c+d', 'I:x^2', 'I:y^2', 'I:z^2']);
  });
});
