import { renderMathChunked } from '../mathChunked';
import type { MathReq, MathResult } from '../mathRender';

const items = (n: number): MathReq[] => Array.from({ length: n }, (_, i) => ({ tex: `t${i}`, display: i % 2 === 0 }));
const ok = async (its: MathReq[]): Promise<MathResult[]> => its.map(it => ({ ...it, b64: 'AA==', w: 1, h: 1 }));
const now = async () => {};

it('splits into chunks, preserves order, one request in flight at a time', async () => {
  let inFlight = 0, max = 0;
  const sizes: number[] = [];
  const render = async (its: MathReq[]) => {
    inFlight++; max = Math.max(max, inFlight); sizes.push(its.length);
    await new Promise<void>(r => setTimeout(() => r(), 1));
    inFlight--;
    return ok(its);
  };
  const out = await renderMathChunked(items(7), { priority: 'current', chunkSize: 3, render, firstGate: now, nextGate: now });
  expect(sizes).toEqual([3, 3, 1]);
  expect(max).toBe(1);
  expect(out.map(r => r.tex)).toEqual(items(7).map(i => i.tex));
});

it('awaits the gate before every chunk, with the right priority', async () => {
  const log: string[] = [];
  await renderMathChunked(items(5), {
    priority: 'background', chunkSize: 2,
    render: async its => { log.push(`render${its.length}`); return ok(its); },
    firstGate: async p => { log.push(`first:${p}`); },
    nextGate: async p => { log.push(`next:${p}`); },
  });
  expect(log).toEqual(['first:background', 'render2', 'next:background', 'render2', 'next:background', 'render1']);
});

it('does not start the next chunk while the gate is closed (paused, not dropped)', async () => {
  let open!: () => void;
  const closed = new Promise<void>(r => { open = () => r(); });
  const render = jest.fn(async (its: MathReq[]) => ok(its));
  const p = renderMathChunked(items(4), { priority: 'current', chunkSize: 2, render, firstGate: now, nextGate: () => closed });
  await new Promise<void>(r => setTimeout(() => r(), 20));
  expect(render).toHaveBeenCalledTimes(1);
  open();
  const out = await p;
  expect(render).toHaveBeenCalledTimes(2);
  expect(out).toHaveLength(4);
});

it('single-batch fallback: Infinity or a big chunk size makes exactly one call', async () => {
  for (const chunkSize of [Infinity, 1000]) {
    const render = jest.fn(ok);
    await renderMathChunked(items(50), { priority: 'current', chunkSize, render, firstGate: now, nextGate: now });
    expect(render).toHaveBeenCalledTimes(1);
  }
});

it('empty input renders nothing and never touches the gate', async () => {
  const gate = jest.fn(now);
  expect(await renderMathChunked([], { priority: 'current', firstGate: gate })).toEqual([]);
  expect(gate).not.toHaveBeenCalled();
});

it('keeps per-item errors in place', async () => {
  const render = async (its: MathReq[]): Promise<MathResult[]> =>
    its.map(it => (it.tex === 't1' ? { ...it, error: 'bad tex' } : { ...it, b64: 'AA==' }));
  const out = await renderMathChunked(items(3), { priority: 'current', chunkSize: 2, render, firstGate: now, nextGate: now });
  expect(out.map(r => r.error ?? 'ok')).toEqual(['ok', 'bad tex', 'ok']);
});

it('a throwing or short-answering chunk yields per-item errors, other chunks still run', async () => {
  let n = 0;
  const render = async (its: MathReq[]): Promise<MathResult[]> => {
    n++;
    if (n === 1) throw new Error('boom');
    if (n === 2) return [];                       // renderer returned nothing
    return ok(its);
  };
  const out = await renderMathChunked(items(5), { priority: 'current', chunkSize: 2, render, firstGate: now, nextGate: now });
  expect(out).toHaveLength(5);
  expect(out.map(r => r.error ?? 'ok')).toEqual(['render-failed', 'render-failed', 'missing', 'missing', 'ok']);
});

it('a fully timed-out chunk stops rendering the rest instead of timing out per chunk', async () => {
  const render = jest.fn(async (its: MathReq[]): Promise<MathResult[]> => its.map(it => ({ ...it, error: 'timeout' })));
  const out = await renderMathChunked(items(10), { priority: 'current', chunkSize: 3, render, firstGate: now, nextGate: now });
  expect(render).toHaveBeenCalledTimes(1);
  expect(out).toHaveLength(10);
  expect(out.every(r => r.error === 'timeout')).toBe(true);
});

it('priority null is ungated (no gate call) so a download-held caller cannot deadlock', async () => {
  const gate = jest.fn(now);
  const out = await renderMathChunked(items(3), { priority: null, chunkSize: 2, render: ok, firstGate: gate, nextGate: gate });
  expect(gate).not.toHaveBeenCalled();
  expect(out).toHaveLength(3);
});
