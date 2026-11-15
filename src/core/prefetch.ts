// Link prefetch: once the reader has stayed on an article, quietly cache a few of its uncached
// outgoing links. Policy (which links, when, how many) is pure in src/utils/prefetchPolicy.ts;
// this wires it to the ports. The slugs already tried this session are instance state, so a flaky
// article is not hammered and a test gets a fresh instance.
import type { Connectivity, Delay, Interactions, LinkLookup } from './ports';
import {
  PREFETCH_IDLE_DELAY_MS, canPrefetchOn, runPrefetch, selectPrefetchTargets,
} from '../utils/prefetchPolicy';

export interface PrefetchDeps {
  connectivity: Connectivity;
  interactions: Interactions;
  delay: Delay;
  links: LinkLookup;
  /** Caches one article; resolves true on success. */
  fetchOne: (slug: string) => Promise<boolean>;
}

/** Returns `start(slug)`, which returns a cancel function (call it on navigation/unmount). Never throws. */
export function createPrefetcher(deps: PrefetchDeps): (slug: string) => () => void {
  const attempted = new Set<string>();

  return function startPrefetch(slug) {
    let cancelled = false;
    let pause: { cancel(): void } | null = null;

    const sleep = (ms: number) => {
      const p = deps.delay.start(ms);
      pause = p;
      return p.done;
    };

    async function run() {
      try {
        await sleep(PREFETCH_IDLE_DELAY_MS);
        if (cancelled) return;
        const net = await deps.connectivity.current();
        if (cancelled) return;
        if (!canPrefetchOn(net)) return;
        const links = await deps.links.getLinksFrom(slug);
        if (cancelled) return;
        const targets = selectPrefetchTargets(slug, links, attempted);
        await runPrefetch(targets, {
          fetchOne: deps.fetchOne,
          sleep,
          shouldContinue: () => !cancelled,
          onAttempt: s => { attempted.add(s); },
        });
      } catch {
        // best-effort
      }
    }

    // Wait for animations/gestures to settle before starting the idle clock.
    const interaction = deps.interactions.afterInteractions(() => {
      if (!cancelled) void run();
    });

    return () => {
      cancelled = true;
      pause?.cancel();
      interaction.cancel();
    };
  };
}
