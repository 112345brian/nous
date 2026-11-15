// Use case UC-A3: build or refresh the entry index (the list of SEP entries).
// Everything outside the core arrives through `deps`; nothing here reads a clock,
// the network or storage on its own.
import type { IndexEntry } from '../types';
import type { ArticleSource, Clock, KeyValueStore, LibraryIndexStore } from './ports';
import { parseContentsHtml, buildLinkIndexPayload } from '../utils/sepIndex';

/** How old the index may get before it is fetched again. */
export const INDEX_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

export interface RefreshIndexDeps {
  source: Pick<ArticleSource, 'fetchIndexHtml'>;
  store: LibraryIndexStore;
  meta: KeyValueStore;
  clock: Clock;
  /** Title index shipped with the app (facts only), used when the first launch is offline. */
  bundledEntries: IndexEntry[];
}

export async function refreshIndexIfStale(deps: RefreshIndexDeps): Promise<void> {
  const { source, store, meta, clock } = deps;
  const lastRefresh = await meta.getMeta('index_refreshed_at');
  const count = await store.getEntryCount();
  const isStale = !lastRefresh ||
    clock.now() - Number(lastRefresh) > INDEX_REFRESH_INTERVAL_MS ||
    count === 0;

  if (!isStale) return;

  let entries: IndexEntry[];
  let fromSource = true;
  try {
    entries = parseContentsHtml(await source.fetchIndexHtml());
  } catch {
    // fall back to bundled seed on first launch; if index already exists, skip silently
    if (count === 0) { entries = deps.bundledEntries; fromSource = false; }
    else return;
  }

  if (entries.length > 0) {
    await store.upsertIndexEntries(entries);
    await store.cleanDenormalizedTitles();
    // The bundled seed only fills in until the real index can be fetched: do not stamp it as a
    // successful refresh, or an offline first launch would skip the real fetch for a week.
    if (fromSource) await meta.setMeta('index_refreshed_at', String(clock.now()));
    // Rebuild link index in background after new index data lands
    rebuildLinkIndex(deps).catch(() => {});
  }
}

async function rebuildLinkIndex({ store, meta }: RefreshIndexDeps): Promise<void> {
  const entries = await store.getAllEntryTitles();
  await meta.setMeta('link_index_json', buildLinkIndexPayload(entries));
  store.invalidateLinkCache();
}
