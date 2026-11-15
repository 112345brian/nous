import { createStallDetector } from '../stallDetector';

function rig() {
  let t = 0;
  let cb: (() => void) | null = null;
  const d = createStallDetector({
    now: () => t,
    setInterval: fn => { cb = fn; return 1; },
    clearInterval: () => { cb = null; },
    intervalMs: 8,
  });
  const tick = (dt: number) => { t += dt; cb?.(); };
  return { d, tick };
}

it('reports lateness over the nominal interval', () => {
  const { d, tick } = rig();
  d.start();
  tick(8);    // on time
  tick(30);   // 22 late  -> >16
  tick(120);  // 112 late -> >16 and >50
  tick(9);    // 1 late
  expect(d.stop()).toEqual({ maxMs: 112, over16: 2, over50: 1, ticks: 4 });
});

it('stop is idempotent and ticks after stop are ignored', () => {
  const { d, tick } = rig();
  d.start();
  tick(100);
  const a = d.stop();
  tick(500);
  expect(d.stop()).toEqual(a);
});

it('a fresh start resets the report', () => {
  const { d, tick } = rig();
  d.start(); tick(100); d.stop();
  d.start(); tick(8);
  expect(d.stop()).toEqual({ maxMs: 0, over16: 0, over50: 0, ticks: 1 });
});

it('counts a stall that is still running when stop() is called (the late tick never fired)', () => {
  let t = 0;
  const d = createStallDetector({ now: () => t, setInterval: () => 1, clearInterval: () => {}, intervalMs: 8 });
  d.start();
  t = 108;
  expect(d.stop()).toEqual({ maxMs: 100, over16: 1, over50: 1, ticks: 0 });
});
