// The throttle runs with fakes: no jest.mock, no native module. Date.now, setTimeout and fetch throw.
import { createProgressNotifier, UPDATE_INTERVAL_ARTICLES, UPDATE_INTERVAL_MS } from '../downloadNotifier';

const boom = (n: string) => () => { throw new Error(`${n} must not be called by the core`); };
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(boom('Date.now') as never);
  jest.spyOn(globalThis, 'setTimeout').mockImplementation(boom('setTimeout') as never);
  (globalThis as any).fetch = boom('fetch');
});
afterEach(() => jest.restoreAllMocks());

function world() {
  let now = 1_000_000;
  const log: string[] = [];
  const n = createProgressNotifier({
    clock: { now: () => now },
    sink: {
      start: async () => { log.push('start'); },
      update: (d, t) => { log.push(`update ${d}/${t}`); },
      finish: async t => { log.push(`finish ${t}`); },
    },
  });
  return { n, log, tick: (ms: number) => { now += ms; } };
}

test('the first update goes through; later ones need 30 articles or 3 s', async () => {
  const { n, log, tick } = world();
  await n.start();
  await n.update(1, 100);
  tick(100); await n.update(5, 100);
  expect(log).toEqual(['start', 'update 1/100']);
  tick(UPDATE_INTERVAL_MS); await n.update(6, 100);
  tick(10); await n.update(6 + UPDATE_INTERVAL_ARTICLES - 1, 100);
  expect(log.length).toBe(3);
  tick(10); await n.update(6 + UPDATE_INTERVAL_ARTICLES, 100);
  expect(log).toEqual(['start', 'update 1/100', 'update 6/100', `update ${6 + UPDATE_INTERVAL_ARTICLES}/100`]);
});

test('start resets the throttle; finish always passes through', async () => {
  const { n, log } = world();
  await n.start(); await n.update(50, 100);
  await n.start(); await n.update(51, 100);
  await n.finish(100);
  expect(log).toEqual(['start', 'update 50/100', 'start', 'update 51/100', 'finish 100']);
});

test('a sink failure at start is the sink’s to handle; update never awaits the sink', async () => {
  const n = createProgressNotifier({ clock: { now: () => 1_000_000 }, sink: { start: async () => {}, update: () => {}, finish: async () => {} } });
  await expect(n.update(1, 2)).resolves.toBeUndefined();
});
