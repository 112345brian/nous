// Use cases UC-G1 / UC-G2: download the whole library, and keep cached articles current.
// The library, the article-caching use case, the index refresh, the clock and the pacing all
// arrive through `deps`; nothing here owns a timer or reads the clock.
import type { DownloadProgress, LibraryScope } from '../types';
import type { Clock, KeyValueStore, LibraryCacheStatus, Sleep } from './ports';
import type { CacheArticleOptions } from './cacheArticle';

/** Articles fetched at once by downloadAll, and the pause after each group (ms). */
export const DOWNLOAD_CONCURRENCY = 6;
export const DOWNLOAD_PAUSE_MS = 100;
/** The same for syncCachedArticles, which also renders equations and so goes gently. */
export const SYNC_CONCURRENCY = 3;
export const SYNC_PAUSE_MS = 200;

/** Caches one article; resolves true on success. The use case from core/cacheArticle, bound to its adapters. */
export type CacheArticle = (slug: string, opts: CacheArticleOptions) => Promise<boolean>;

export interface DownloadAllDeps {
  library: Pick<LibraryCacheStatus, 'getSlugsByCacheStatus'>;
  cacheArticle: CacheArticle;
  sleep: Sleep;
}

export async function downloadAll(
  deps: DownloadAllDeps,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  scope: LibraryScope = 'all',
): Promise<void> {
  const { uncached, cached } = await deps.library.getSlugsByCacheStatus(scope);
  // Report progress against the full library so a resumed download shows
  // "900 / 1800" rather than "0 / 900", making it clear work wasn't lost.
  const alreadyDone = cached.length;
  const total = uncached.length + alreadyDone;
  let done = alreadyDone;

  // Emit once upfront so callers always see the real total, even on a fully-cached library.
  onProgress({ done, total, current: '' });

  // Skip math rendering during bulk download — each article is queued on the pending list and
  // drained afterwards (resumePendingMath, background priority). Rendering math inline here
  // requires a WebView round-trip per equation and turns a 20-min download
  // into a 2-hour one for a library with ~450 math articles.
  for (let i = 0; i < uncached.length; i += DOWNLOAD_CONCURRENCY) {
    if (signal?.aborted) return;
    const chunk = uncached.slice(i, i + DOWNLOAD_CONCURRENCY);
    await Promise.all(chunk.map(({ slug, title }) =>
      deps.cacheArticle(slug, { skipMath: true }).then(() => {
        // Increment inside .then() so each article fires its own progress event
        // rather than batching. done++ after await in concurrent callbacks can
        // read the same value twice; .then() serializes via microtask queue safely
        // because each closure captures a separate resolve tick.
        onProgress({ done: ++done, total, current: title });
      })
    ));
    await deps.sleep(DOWNLOAD_PAUSE_MS);
  }
}

export interface SyncCachedDeps {
  library: Pick<LibraryCacheStatus, 'getCachedSlugs'>;
  /** The index refresh use case, bound to its adapters. */
  refreshIndex(): Promise<void>;
  cacheArticle: CacheArticle;
  meta: Pick<KeyValueStore, 'setMeta'>;
  clock: Clock;
  sleep: Sleep;
}

export async function syncCachedArticles(
  deps: SyncCachedDeps,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await deps.refreshIndex();
  const slugs = await deps.library.getCachedSlugs();
  const total = slugs.length;
  let done = 0;
  for (let i = 0; i < slugs.length; i += SYNC_CONCURRENCY) {
    if (signal?.aborted) return;
    const chunk = slugs.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(chunk.map(async ({ slug, title }) => {
      await deps.cacheArticle(slug, { awaitMath: true });
      done++;
      onProgress({ done, total, current: title });
    }));
    await deps.sleep(SYNC_PAUSE_MS);
  }
  await deps.meta.setMeta('last_deep_sync', String(deps.clock.now()));
}
