// Characterization of the notification / prefetch / secrets behaviour. First written against the
// old module-level services (all green), then ported to the converted shape: the same assertions
// now run through the core use case wired to the real platform adapters (as composition.ts does).
export {};

const mockNet = { isConnected: true, isInternetReachable: true, details: { isConnectionExpensive: false } as any };
const mockLinks: Array<{ slug: string; cached_at: number | null }> = [];
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: async () => mockNet } }));
jest.mock('../db', () => require('./helpers/mockDbModule').asDbModule({ getLinksFrom: async () => mockLinks }));

describe('prefetch (core use case + platform adapters)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    mockLinks.length = 0;
    mockNet.isConnected = true; mockNet.isInternetReachable = true; mockNet.details = { isConnectionExpensive: false };
  });
  afterEach(() => jest.useRealTimers());

  const load = () => {
    const { createPrefetcher } = require('../../core/prefetch');
    const { netInfoConnectivity, rnInteractions } = require('../prefetch');
    return (s: string, fetchOne: (s: string) => Promise<boolean>) => createPrefetcher({
      connectivity: netInfoConnectivity, interactions: rnInteractions,
      delay: { start: (ms: number) => { let t: any; return { done: new Promise<void>(r => { t = setTimeout(r, ms); }), cancel: () => clearTimeout(t) }; } },
      links: { getLinksFrom: async () => mockLinks }, fetchOne,
    })(s);
  };
  const settle = async (ms: number) => { await jest.advanceTimersByTimeAsync(ms); };

  it('waits for the idle delay, then fetches uncached targets with a gap between', async () => {
    mockLinks.push({ slug: 'a', cached_at: null }, { slug: 'b', cached_at: 5 }, { slug: 'c', cached_at: null });
    const fetchOne = jest.fn(async (_s: string) => true);
    load()('self', fetchOne);
    await settle(2400);
    expect(fetchOne).not.toHaveBeenCalled();
    await settle(200);
    expect(fetchOne.mock.calls.map(c => c[0])).toEqual(['a']);
    await settle(400);
    expect(fetchOne.mock.calls.map(c => c[0])).toEqual(['a', 'c']);
  });

  it('does nothing on an expensive connection, offline, or unknown', async () => {
    mockLinks.push({ slug: 'a', cached_at: null });
    for (const tweak of [() => { mockNet.details = { isConnectionExpensive: true }; }, () => { mockNet.isConnected = false; }, () => { mockNet.details = null; }]) {
      jest.resetModules(); mockNet.isConnected = true; mockNet.details = { isConnectionExpensive: false }; tweak();
      const fetchOne = jest.fn(async (_s: string) => true);
      load()('self', fetchOne);
      await settle(5000);
      expect(fetchOne).not.toHaveBeenCalled();
    }
  });

  it('cancel before the idle delay ends fetches nothing', async () => {
    mockLinks.push({ slug: 'a', cached_at: null });
    const fetchOne = jest.fn(async (_s: string) => true);
    const cancel = load()('self', fetchOne);
    await settle(1000);
    cancel();
    await settle(5000);
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it('cancel mid-run stops after the current article', async () => {
    mockLinks.push({ slug: 'a', cached_at: null }, { slug: 'b', cached_at: null });
    const fetchOne = jest.fn(async (_s: string) => true);
    const cancel = load()('self', fetchOne);
    await settle(2600);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    cancel();
    await settle(5000);
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('tried slugs (success or failure) are not retried by a later start in the same session', async () => {
    mockLinks.push({ slug: 'a', cached_at: null }, { slug: 'b', cached_at: null });
    const { createPrefetcher } = require('../../core/prefetch');
    const { netInfoConnectivity, rnInteractions } = require('../prefetch');
    const fetchRef = { f: async (_s: string) => true };
    const start = createPrefetcher({
      connectivity: netInfoConnectivity, interactions: rnInteractions,
      delay: { start: (ms: number) => { let t: any; return { done: new Promise<void>(r => { t = setTimeout(r, ms); }), cancel: () => clearTimeout(t) }; } },
      links: { getLinksFrom: async () => mockLinks }, fetchOne: (s: string) => fetchRef.f(s),
    }) as (slug: string) => () => void;
    const first = jest.fn(async (s: string) => { if (s === 'a') throw new Error('flaky'); return true; });
    fetchRef.f = first;
    start('self');
    await settle(4000);
    expect(first.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
    const second = jest.fn(async (_s: string) => true);
    fetchRef.f = second;
    start('self');
    await settle(4000);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('download notification (core throttle + platform sink)', () => {
  const sched = jest.fn(async (_o?: unknown) => "id");
  const dismiss = jest.fn(async (_id?: string) => {});
  const request = jest.fn(async (_o?: unknown) => ({ status: 'granted' }));
  const native = { start: jest.fn(), update: jest.fn(), finish: jest.fn(), dismiss: jest.fn() };
  let now = 1_000_000;

  function load(os: 'ios' | 'android') {
    jest.resetModules();
    jest.doMock('expo-notifications', () => ({ scheduleNotificationAsync: sched, dismissNotificationAsync: dismiss, requestPermissionsAsync: request }));
    jest.doMock('react-native', () => ({ Platform: { OS: os }, NativeModules: { DownloadNotification: native } }));
    const { createPlatformProgressSink } = require('../downloadNotification');
    const { createProgressNotifier } = require('../../core/downloadNotifier');
    const notifier = createProgressNotifier({ sink: createPlatformProgressSink(), clock: { now: () => Date.now() } });
    return {
      startDownloadNotification: notifier.start,
      updateDownloadNotification: notifier.update,
      finishDownloadNotification: notifier.finish,
    };
  }
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    now = 1_000_000;
    [sched, dismiss, request, ...Object.values(native)].forEach(m => (m as jest.Mock).mockClear());
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('android: start, throttled update (30 articles or 3 s), finish then dismiss after 8 s', async () => {
    const n = load('android');
    await n.startDownloadNotification();
    expect(native.start).toHaveBeenCalledTimes(1);
    await n.updateDownloadNotification(1, 100);      // first update always goes through
    expect(native.update).toHaveBeenCalledTimes(1);
    now += 100; await n.updateDownloadNotification(5, 100);   // <30 articles, <3 s: dropped
    expect(native.update).toHaveBeenCalledTimes(1);
    now += 3000; await n.updateDownloadNotification(6, 100);  // 3 s elapsed: sent
    expect(native.update).toHaveBeenCalledTimes(2);
    now += 10; await n.updateDownloadNotification(36, 100);   // 30 articles: sent
    expect(native.update).toHaveBeenCalledTimes(3);
    expect(native.update).toHaveBeenLastCalledWith(36, 100);
    await n.finishDownloadNotification(100);
    expect(native.finish).toHaveBeenCalledWith(100);
    expect(native.dismiss).not.toHaveBeenCalled();
    jest.advanceTimersByTime(8000);
    expect(native.dismiss).toHaveBeenCalledTimes(1);
  });

  it('start resets the throttle', async () => {
    const n = load('android');
    await n.startDownloadNotification();
    await n.updateDownloadNotification(50, 100);
    await n.startDownloadNotification();
    await n.updateDownloadNotification(51, 100);
    expect(native.update).toHaveBeenCalledTimes(2);
  });

  it('ios: start schedules a text notification, updates are silent, finish replaces it and dismisses after 8 s', async () => {
    const n = load('ios');
    await n.startDownloadNotification();
    expect(sched).toHaveBeenCalledTimes(1);
    await n.updateDownloadNotification(40, 100);
    expect(sched).toHaveBeenCalledTimes(1);
    await n.finishDownloadNotification(100);
    expect(sched).toHaveBeenCalledTimes(2);
    expect((sched.mock.calls as any)[1][0].content.body).toBe('Library ready — 100 articles');
    expect(dismiss).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(8000);
    expect(dismiss).toHaveBeenCalledTimes(2);
    expect(native.start).not.toHaveBeenCalled();
  });

  it('ios: without permission nothing is scheduled; finish without a granted start does nothing', async () => {
    request.mockResolvedValueOnce({ status: 'denied' });
    const n = load('ios');
    await n.startDownloadNotification();
    await n.finishDownloadNotification(5);
    expect(sched).not.toHaveBeenCalled();
  });
});

describe('secureSecrets (adapter; db.ts keeps using the named functions)', () => {
  const kv = new Map<string, string>();
  function load(mod: 'ok' | 'missing' | 'throws') {
    jest.resetModules();
    if (mod === 'missing') jest.doMock('expo-secure-store', () => { throw new Error('not linked'); });
    else jest.doMock('expo-secure-store', () => ({
      isAvailableAsync: async () => true,
      getItemAsync: async (k: string) => { if (mod === 'throws') throw new Error('x'); return kv.get(k) ?? null; },
      setItemAsync: async (k: string, v: string) => { if (mod === 'throws') throw new Error('x'); kv.set(k, v); },
      deleteItemAsync: async (k: string) => { if (mod === 'throws') throw new Error('x'); kv.delete(k); },
    }));
    return require('../secureSecrets');
  }
  beforeEach(() => kv.clear());

  it('round-trips and deletes', async () => {
    const s = load('ok');
    expect(await s.secretsAvailable()).toBe(true);
    expect(await s.setSecret('k', 'v')).toBe(true);
    expect(await s.getSecret('k')).toBe('v');
    expect(await s.deleteSecret('k')).toBe(true);
    expect(await s.getSecret('k')).toBeNull();
  });
  it('reports failure through return values when the module is missing', async () => {
    const s = load('missing');
    expect(await s.secretsAvailable()).toBe(false);
    expect(await s.getSecret('k')).toBeNull();
    expect(await s.setSecret('k', 'v')).toBe(false);
    expect(await s.deleteSecret('k')).toBe(false);
  });
  it('swallows errors from the native module', async () => {
    const s = load('throws');
    expect(await s.getSecret('k')).toBeNull();
    expect(await s.setSecret('k', 'v')).toBe(false);
    expect(await s.deleteSecret('k')).toBe(false);
  });
});

describe('secureSecretStore (the core SecretStore port)', () => {
  it('has the same behaviour as the named functions', async () => {
    jest.resetModules();
    jest.doMock('expo-secure-store', () => { throw new Error('not linked'); });
    const { secureSecretStore } = require('../secureSecrets');
    expect(await secureSecretStore.available()).toBe(false);
    expect(await secureSecretStore.get('k')).toBeNull();
    expect(await secureSecretStore.set('k', 'v')).toBe(false);
    expect(await secureSecretStore.delete('k')).toBe(false);
  });
});
