// I/O edge for link prefetch. Policy (what/when/how many) lives in
// `src/utils/prefetchPolicy.ts`; this file only wires it to NetInfo, SQLite,
// the network (via the `fetchOne` it is given) and RN's InteractionManager.
import { InteractionManager } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { getLinksFrom } from './db';
import {
  PREFETCH_IDLE_DELAY_MS,
  canPrefetchOn,
  runPrefetch,
  selectPrefetchTargets,
} from '../utils/prefetchPolicy';

// Slugs we already tried this app session (success or failure) — failures are
// not retried until relaunch, so a flaky article can't be hammered.
const attempted = new Set<string>();

/**
 * Once the reader has stayed on `slug` for a while (and interactions have
 * settled), quietly cache a few of its uncached outgoing-link targets, one at a
 * time. Math is skipped (backfillMathInline fills it in later). Returns a
 * cancel function: call it on navigation/unmount. Never throws.
 * `fetchOne` caches one article (the composition root passes fetchAndCacheArticle with
 * skipMath); it is a parameter so this adapter never imports a use case.
 */
export function startPrefetch(slug: string, fetchOne: (slug: string) => Promise<boolean>): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interaction: { cancel: () => void } | null = null;

  const sleep = (ms: number) => new Promise<void>(r => { timer = setTimeout(r, ms); });

  async function run() {
    try {
      await sleep(PREFETCH_IDLE_DELAY_MS);
      if (cancelled) return;
      const net = await NetInfo.fetch();
      if (cancelled) return;
      const ok = canPrefetchOn({
        isConnected: net.isConnected,
        isInternetReachable: net.isInternetReachable,
        isExpensive:
          (net.details as { isConnectionExpensive?: boolean } | null)?.isConnectionExpensive ?? null,
      });
      if (!ok) return;
      const links = await getLinksFrom(slug);
      if (cancelled) return;
      const targets = selectPrefetchTargets(slug, links, attempted);
      await runPrefetch(targets, {
        fetchOne,
        sleep,
        shouldContinue: () => !cancelled,
        onAttempt: s => { attempted.add(s); },
      });
    } catch {
      // best-effort
    }
  }

  // Wait for animations/gestures to settle before starting the idle clock.
  interaction = InteractionManager.runAfterInteractions(() => {
    if (!cancelled) void run();
  });

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    interaction?.cancel();
  };
}
