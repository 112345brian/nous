import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { useBoot } from '../src/boot/useBoot';
import type { BootResult } from '../src/boot/useBoot';

jest.mock('../src/services/db', () => ({
  getEntryCount: jest.fn(),
  getMeta: jest.fn(),
  getPrefs: jest.fn(),
  getRecentSlugs: jest.fn(),
  savePrefs: jest.fn(),
}));
// The use cases come from the composition root. The common-math pre-warm is wired there too; its
// stand-in schedules the same task name through the (mocked) idle scheduler, as the real one does.
jest.mock('../src/composition', () => {
  // The scheduler and the download hold are built in the root; a stand-in schedules the pre-warm
  // under the same task name through the same (mocked) scheduler, as the real one does.
  const idleScheduler = { schedule: jest.fn() };
  return {
    backfillAst: jest.fn(),
    resumePendingMath: jest.fn(),
    downloadAll: jest.fn(),
    refreshIndexIfStale: jest.fn(),
    syncCachedArticles: jest.fn(),
    importSeedFromUrl: jest.fn(),
    idleScheduler,
    withDownloadHold: jest.fn((fn: () => Promise<unknown>) => fn()),
    preloadMathJax: jest.fn(),
    scheduleCommonMathPrewarm: jest.fn(() => idleScheduler.schedule('prewarm-common-math', jest.fn())),
  };
});
jest.mock('../src/services/downloadNotification', () => ({
  startDownloadNotification: jest.fn().mockResolvedValue(undefined),
  updateDownloadNotification: jest.fn().mockResolvedValue(undefined),
  finishDownloadNotification: jest.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require('../src/services/db');
const root = require('../src/composition');
const seed = root; // importSeedFromUrl is wired in the root
const { idleScheduler } = require('../src/composition');

const prefs = (over: object = {}) => ({ homeMode: 'search', downloadAll: false, seedUrl: '', ...over });

let result: BootResult;
let openArticle: jest.Mock;

function Probe() {
  result = useBoot(openArticle);
  return null;
}

async function mount() {
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(<Probe />);
  });
}
const flush = () => ReactTestRenderer.act(async () => { await new Promise<void>(r => setImmediate(() => r())); });

beforeEach(() => {
  jest.clearAllMocks();
  openArticle = jest.fn();
  db.getMeta.mockResolvedValue('1');
  db.getPrefs.mockResolvedValue(prefs());
  db.getEntryCount.mockResolvedValue(10);
  db.getRecentSlugs.mockResolvedValue([]);
  root.refreshIndexIfStale.mockResolvedValue(undefined);
});

test('starts in booting', () => {
  db.getMeta.mockReturnValue(new Promise(() => {}));
  ReactTestRenderer.act(() => { ReactTestRenderer.create(<Probe />); });
  expect(result.phase).toBe('booting');
});

test('not onboarded goes to onboarding', async () => {
  db.getMeta.mockResolvedValue(null);
  await mount();
  expect(result.phase).toBe('onboarding');
  expect(db.getEntryCount).not.toHaveBeenCalled();
});

test('populated index goes straight to ready and schedules backfills', async () => {
  await mount();
  expect(result.phase).toBe('ready');
  expect(root.refreshIndexIfStale).toHaveBeenCalledTimes(1);
  const names = idleScheduler.schedule.mock.calls.map((c: unknown[]) => c[0]);
  expect(names).toEqual(['resume-pending-math', 'backfill-ast', 'auto-deep-sync', 'prewarm-common-math']);
});

test('empty index goes through indexing to ready', async () => {
  db.getEntryCount.mockResolvedValueOnce(0).mockResolvedValueOnce(5);
  let release!: () => void;
  root.refreshIndexIfStale.mockReturnValue(new Promise<void>(r => { release = () => r(); }));
  await mount();
  expect(result.phase).toBe('indexing');
  await ReactTestRenderer.act(async () => { release(); });
  expect(result.phase).toBe('ready');
});

test('empty index that stays empty is index_error', async () => {
  db.getEntryCount.mockResolvedValue(0);
  await mount();
  expect(result.phase).toBe('index_error');
});

test('index refresh failure on empty index is index_error', async () => {
  db.getEntryCount.mockResolvedValue(0);
  root.refreshIndexIfStale.mockRejectedValue(new Error('offline'));
  await mount();
  expect(result.phase).toBe('index_error');
});

test('unexpected boot failure is index_error', async () => {
  db.getPrefs.mockRejectedValue(new Error('db'));
  await mount();
  expect(result.phase).toBe('index_error');
});

test('background failures after ready do not revert the phase', async () => {
  db.getPrefs.mockResolvedValue(prefs({ downloadAll: true }));
  root.downloadAll.mockRejectedValue(new Error('net'));
  await mount();
  await flush();
  expect(result.phase).toBe('ready');
});

test('continue mode opens the most recent article', async () => {
  jest.useFakeTimers();
  try {
    db.getPrefs.mockResolvedValue(prefs({ homeMode: 'continue' }));
    db.getRecentSlugs.mockResolvedValue([{ slug: 'plato', title: 'Plato' }]);
    await mount();
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(200); });
    expect(openArticle).toHaveBeenCalledWith('plato', 'Plato');
  } finally {
    jest.useRealTimers();
  }
});

describe('onOnboardingDone', () => {
  beforeEach(() => { db.getMeta.mockResolvedValue(null); });

  test('without seed saves prefs, indexes, then ready', async () => {
    await mount();
    await ReactTestRenderer.act(async () => { await result.onOnboardingDone(prefs() as never); });
    expect(db.savePrefs).toHaveBeenCalled();
    expect(seed.importSeedFromUrl).not.toHaveBeenCalled();
    expect(result.phase).toBe('ready');
  });

  test('seed progress is exposed then cleared; prefs saved after import', async () => {
    const order: string[] = [];
    seed.importSeedFromUrl.mockImplementation(async (_u: string, cb: (p: unknown) => void) => {
      cb({ phase: 'downloading', bytesWritten: 1, bytesTotal: 2 });
      order.push('import');
    });
    db.savePrefs.mockImplementation(async () => { order.push('save'); });
    await mount();
    let p!: Promise<void>;
    await ReactTestRenderer.act(async () => { p = result.onOnboardingDone(prefs({ seedUrl: 'http://x/seed' }) as never); });
    await ReactTestRenderer.act(async () => { await p; });
    expect(order).toEqual(['import', 'save']);
    expect(result.seedPhase).toBeNull();
    expect(result.phase).toBe('ready');
  });

  test('seed failure is seed_error and prefs are not saved', async () => {
    seed.importSeedFromUrl.mockRejectedValue(new Error('bad'));
    await mount();
    await ReactTestRenderer.act(async () => { await result.onOnboardingDone(prefs({ seedUrl: 'http://x' }) as never); });
    expect(result.phase).toBe('seed_error');
    expect(db.savePrefs).not.toHaveBeenCalled();
  });

  test('index failure after onboarding is index_error', async () => {
    db.getEntryCount.mockRejectedValue(new Error('db'));
    await mount();
    await ReactTestRenderer.act(async () => { await result.onOnboardingDone(prefs() as never); });
    expect(result.phase).toBe('index_error');
  });
});
