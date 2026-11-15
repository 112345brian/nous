// The WebView math bridge with fakes: a hand-driven timer, a fake `inject`, a fake engine
// loader. Date.now, setTimeout and fetch throw, so the bridge can only reach time through the
// injected timer. The scenarios were first written against the module-level bridge this
// replaces (ready timeout, batch timeout, routing by reqId, malformed messages, one preload,
// reset) and passed there unchanged.
import { createMathBridge, READY_TIMEOUT_MS, BATCH_TIMEOUT_MS } from '../mathBridge';
import type { MathRequest } from '../ports';

const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
  (globalThis as any).fetch = () => { throw new Error('core used fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); globalThis.setTimeout = realSetTimeout; delete (globalThis as any).fetch; });

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const items: MathRequest[] = [{ tex: 'x', display: false }, { tex: 'y', display: true }];
const msg = (o: unknown) => JSON.stringify(o);

function world(loader: () => Promise<string> = async () => 'ENGINE;') {
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const injected: string[] = [];
  const loads = { n: 0 };
  const bridge = createMathBridge({
    loadEngineScript: () => { loads.n++; return loader(); },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimer: h => { timers.delete(h as number); },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
  };
  const inject = (js: string) => { injected.push(js); };
  const renders = () => injected.filter(j => j.startsWith('window.__renderMath('));
  const parse = (js: string) => JSON.parse(js.slice('window.__renderMath('.length, js.lastIndexOf(');'))) as { reqId: number; items: MathRequest[] };
  return { bridge, advance, inject, injected, renders, parse, loads, timers };
}

describe('render', () => {
  test('an empty batch resolves [] and touches nothing', async () => {
    const w = world();
    expect(await w.bridge.render([])).toEqual([]);
    expect(w.injected).toEqual([]);
    expect(w.loads.n).toBe(0);
  });

  test('no ready signal: after READY_TIMEOUT_MS every item gets error "timeout" and nothing is injected', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    const p = w.bridge.render(items);
    await flush();
    w.advance(READY_TIMEOUT_MS - 1);
    await flush();
    expect(w.renders()).toHaveLength(0);
    w.advance(1);
    expect(await p).toEqual(items.map(it => ({ ...it, error: 'timeout' })));
    expect(w.renders()).toHaveLength(0);
  });

  test('no webview attached: times out the same way', async () => {
    const w = world();
    w.bridge.onMessage(msg({ type: 'ready' }));
    expect(await w.bridge.render([items[0]])).toEqual([{ ...items[0], error: 'timeout' }]);
  });

  test('the batch is injected as window.__renderMath({reqId, items}) and resolved from the matching result', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    w.bridge.onMessage(msg({ type: 'ready' }));
    const p = w.bridge.render(items);
    await flush();
    const js = w.renders()[0];
    expect(js.endsWith('); true;')).toBe(true);
    const { reqId, items: sent } = w.parse(js);
    expect(sent).toEqual(items);
    const out = [{ tex: 'x', display: false, b64: 'A', w: 1, h: 1 }, { tex: 'y', display: true, b64: 'B', w: 2, h: 2 }];
    w.bridge.onMessage(msg({ type: 'result', reqId, out }));
    expect(await p).toEqual(out);
    expect(w.timers.size).toBe(0); // the batch timer was cleared
  });

  test('concurrent batches get distinct ids and each receives only its own result', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    w.bridge.onMessage(msg({ type: 'ready' }));
    const a = w.bridge.render([items[0]]);
    const b = w.bridge.render([items[1]]);
    await flush();
    const [ja, jb] = w.renders();
    const [ida, idb] = [w.parse(ja).reqId, w.parse(jb).reqId];
    expect(ida).not.toBe(idb);
    w.bridge.onMessage(msg({ type: 'result', reqId: idb, out: [{ tex: 'y', display: true, b64: 'FOR-B', w: 1, h: 1 }] }));
    w.bridge.onMessage(msg({ type: 'result', reqId: ida, out: [{ tex: 'x', display: false, b64: 'FOR-A', w: 1, h: 1 }] }));
    expect((await a)[0].b64).toBe('FOR-A');
    expect((await b)[0].b64).toBe('FOR-B');
  });

  test('a batch that never comes back times out after BATCH_TIMEOUT_MS; a late result is ignored', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    w.bridge.onMessage(msg({ type: 'ready' }));
    const p = w.bridge.render([items[0]]);
    await flush();
    const { reqId } = w.parse(w.renders()[0]);
    w.advance(BATCH_TIMEOUT_MS - 1);
    let done = false; void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    w.advance(1);
    expect(await p).toEqual([{ ...items[0], error: 'timeout' }]);
    expect(() => w.bridge.onMessage(msg({ type: 'result', reqId, out: [] }))).not.toThrow();
  });

  test('the ready timer is cleared once ready arrives (no stray timeout fires later)', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    w.bridge.onMessage(msg({ type: 'ready' }));
    const p = w.bridge.render([items[0]]);
    await flush();
    const { reqId } = w.parse(w.renders()[0]);
    w.bridge.onMessage(msg({ type: 'result', reqId, out: [{ tex: 'x', display: false, b64: 'Z', w: 1, h: 1 }] }));
    await p;
    w.advance(READY_TIMEOUT_MS + BATCH_TIMEOUT_MS);
    expect(w.timers.size).toBe(0);
  });
});

describe('onMessage ignores what it does not understand', () => {
  test('malformed and unrelated messages change nothing', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    w.bridge.onMessage(msg({ type: 'ready' }));
    const p = w.bridge.render([items[0]]);
    await flush();
    const { reqId } = w.parse(w.renders()[0]);
    for (const raw of ['not json', '', msg(null), msg(7), msg({ type: 'result' }), msg({ type: 'result', reqId: String(reqId), out: [] }),
      msg({ type: 'result', reqId: reqId + 99, out: [] }), msg({ type: 'error', error: 'x' }), msg({ type: 'other' })]) {
      expect(() => w.bridge.onMessage(raw)).not.toThrow();
    }
    w.bridge.onMessage(msg({ type: 'result', reqId, out: [{ tex: 'x', display: false, b64: 'OK', w: 1, h: 1 }] }));
    expect((await p)[0].b64).toBe('OK');
  });
});

describe('preload', () => {
  test('loads the engine once, injects it into the attached page, a second call is a no-op', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    await w.bridge.preload();
    await w.bridge.preload();
    expect(w.loads.n).toBe(1);
    expect(w.injected).toEqual(['ENGINE;']);
  });

  test('a render starts the lazy preload (once, however many renders)', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    const p1 = w.bridge.render([items[0]]);
    const p2 = w.bridge.render([items[1]]);
    await flush();
    expect(w.loads.n).toBe(1);
    w.advance(READY_TIMEOUT_MS);
    await Promise.all([p1, p2]);
    expect(w.loads.n).toBe(1);
  });

  test('a failed load is swallowed and may be retried', async () => {
    let fail = true;
    const w = world(async () => { if (fail) { fail = false; throw new Error('disk'); } return 'ENGINE;'; });
    w.bridge.attach(w.inject);
    await expect(w.bridge.preload()).resolves.toBeUndefined();
    await w.bridge.preload();
    expect(w.loads.n).toBe(2);
    expect(w.injected).toEqual(['ENGINE;']);
  });

  test('instances share nothing: a second bridge has its own preload, ready state and ids', async () => {
    const a = world(); const b = world();
    a.bridge.attach(a.inject); b.bridge.attach(b.inject);
    a.bridge.onMessage(msg({ type: 'ready' }));
    await a.bridge.preload();
    expect(b.loads.n).toBe(0);
    const pb = b.bridge.render([items[0]]); // b never became ready
    await flush();
    b.advance(READY_TIMEOUT_MS);
    expect(await pb).toEqual([{ ...items[0], error: 'timeout' }]);
  });
});

describe('attach, onDomReady, reset', () => {
  test('isAttached reflects registration', () => {
    const w = world();
    expect(w.bridge.isAttached()).toBe(false);
    w.bridge.attach(w.inject);
    expect(w.bridge.isAttached()).toBe(true);
  });

  test('onDomReady does not inject the engine', async () => {
    const w = world();
    w.bridge.attach(w.inject);
    w.bridge.onDomReady();
    await flush();
    expect(w.injected).toEqual([]);
    expect(w.loads.n).toBe(0);
  });

  test('reset with no webview attached forgets a ready signal and the preload; with one attached it does nothing', async () => {
    const w = world();
    w.bridge.onMessage(msg({ type: 'ready' }));
    await w.bridge.preload();
    w.bridge.reset(); // nothing attached: back to not-ready, not-loaded
    w.bridge.attach(w.inject);
    const p = w.bridge.render([items[0]]);
    await flush();
    expect(w.loads.n).toBe(2); // preload ran again
    w.advance(READY_TIMEOUT_MS);
    expect(await p).toEqual([{ ...items[0], error: 'timeout' }]);

    w.bridge.onMessage(msg({ type: 'ready' }));
    w.bridge.reset(); // attached: no-op, ready stays
    const q = w.bridge.render([items[0]]);
    await flush();
    expect(w.renders()).toHaveLength(1);
    w.bridge.onMessage(msg({ type: 'result', reqId: w.parse(w.renders()[0]).reqId, out: [] }));
    await q;
  });
});
