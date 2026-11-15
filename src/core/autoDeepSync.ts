import type { KeyValueStore } from './ports';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the scheduled re-download of cached articles is due: the setting is on and more than
 * its interval ('2days' = 2 days, anything else = 7) has passed since `last_deep_sync`
 * (never synced counts as the epoch, so it is due at once).
 */
export function autoDeepSyncDue(autoSync: string | null, lastDeepSync: string | null, now: number): boolean {
  if (!autoSync || autoSync === 'off') return false;
  const days = autoSync === '2days' ? 2 : 7;
  const elapsed = now - (lastDeepSync ? Number(lastDeepSync) : 0);
  return elapsed > days * DAY_MS;
}

/** Run `sync` when it is due. Resolves to whether it ran. */
export async function runAutoDeepSync(
  deps: { meta: Pick<KeyValueStore, 'getMeta'>; clock: { now(): number }; sync(): Promise<void> },
): Promise<boolean> {
  const [autoSync, last] = await Promise.all([deps.meta.getMeta('auto_sync'), deps.meta.getMeta('last_deep_sync')]);
  if (!autoDeepSyncDue(autoSync, last, deps.clock.now())) return false;
  await deps.sync();
  return true;
}
