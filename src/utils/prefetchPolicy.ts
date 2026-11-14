// Pure prefetch policy: which linked articles to warm, when it is allowed, and a
// sequential runner with injected side effects. No I/O, no timers of its own, no
// React Native imports — the edge wiring lives in `src/services/prefetch.ts`.

export const PREFETCH_MAX_TARGETS = 4;     // per opened article
export const PREFETCH_CONCURRENCY = 1;     // be polite to plato.stanford.edu
export const PREFETCH_GAP_MS = 400;        // pause between requests (bulk download uses 100-200ms at 3-6x concurrency)
export const PREFETCH_IDLE_DELAY_MS = 2500; // reader must stay on the article this long first

export interface PrefetchCandidate {
  slug: string;
  cached_at: number | null;
}

export interface ConnectionState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  /** NetInfo `details.isConnectionExpensive` (cellular / metered). */
  isExpensive: boolean | null;
}

/** Slugs worth prefetching: uncached, not the current article, not already tried, deduped, capped. */
export function selectPrefetchTargets(
  currentSlug: string,
  candidates: readonly PrefetchCandidate[],
  attempted: ReadonlySet<string>,
  max: number = PREFETCH_MAX_TARGETS,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (out.length >= max) break;
    if (!c.slug || c.slug === currentSlug) continue;
    if (c.cached_at != null) continue;
    if (attempted.has(c.slug) || seen.has(c.slug)) continue;
    seen.add(c.slug);
    out.push(c.slug);
  }
  return out;
}

/** Only prefetch when online and the connection is known to be unmetered. Unknown => skip. */
export function canPrefetchOn(conn: ConnectionState | null | undefined): boolean {
  if (!conn) return false;
  if (conn.isConnected !== true) return false;
  if (conn.isInternetReachable === false) return false;
  return conn.isExpensive === false;
}

export interface RunDeps {
  /** Fetch+cache one article; resolves true on success. May throw. */
  fetchOne: (slug: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** Checked before every request. Return false to stop (navigated away, went offline, ...). */
  shouldContinue: () => boolean;
  /** Called for every slug we start, so failures are not retried this session. */
  onAttempt?: (slug: string) => void;
}

/**
 * Fetch `targets` one at a time (concurrency is 1 by construction), pausing
 * `gapMs` between requests, stopping as soon as `shouldContinue()` is false.
 * Never throws: a failing fetch is swallowed and the run moves on. Returns the
 * slugs that were cached successfully.
 */
export async function runPrefetch(
  targets: readonly string[],
  deps: RunDeps,
  gapMs: number = PREFETCH_GAP_MS,
): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (!deps.shouldContinue()) break;
    const slug = targets[i];
    deps.onAttempt?.(slug);
    try {
      if (await deps.fetchOne(slug)) done.push(slug);
    } catch {
      // swallow: prefetch is best-effort
    }
    if (i < targets.length - 1) {
      await deps.sleep(gapMs);
    }
  }
  return done;
}
