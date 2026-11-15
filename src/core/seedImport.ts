// Use case UC-A2: replace the local database with a downloaded one without losing the reader's
// data. sep.db holds the user's reads, bookmarks, annotations, prefs and reading progress as well
// as the cached articles, so the swap snapshots the user data, backs the file up, replaces it,
// restores the data into the new file, and rolls back if anything fails. Everything outside the
// core (files, the connection, the clock) arrives through `deps`.
import type { Clock, KeyValueStore, SeedDatabase, SeedFiles, SeedUserDataShape, UserDataStore } from './ports';

export type SeedPhase =
  | { phase: 'downloading'; bytesWritten: number; bytesTotal: number }
  | { phase: 'validating' }
  | { phase: 'installing' };

export interface SeedImportDeps<T extends SeedUserDataShape> {
  files: SeedFiles;
  db: SeedDatabase;
  userData: Pick<UserDataStore<T>, 'exportUserData' | 'importUserData'>;
  meta: Pick<KeyValueStore, 'setMeta'>;
  clock: Clock;
}

// SQLite writes these next to the main file; stale ones must never be replayed onto a different
// database.
const SUFFIXES: readonly string[] = ['', '-wal', '-shm'];
const MIN_SEED_BYTES = 50_000;

// ── What survives a seed import ──────────────────────────────────────────────
// sep.db holds three kinds of `meta` rows:
//   • user settings       → carried over (PRESERVED_*)
//   • cache/migration state of THIS database file (index freshness, link index,
//     parser version, backfill flags) → the seed brings its own; restoring ours
//     over it would describe articles the new file does not have (CACHE_*)
// seedImport.test.ts fails when a meta key in the source is in neither list, so a
// new key is classified on purpose instead of being lost or clobbered by default.
export const PRESERVED_META_KEYS: ReadonlySet<string> = new Set([
  'onboarding_done', // not in the user-data export; losing it re-runs onboarding
  'custom_css',
  'font_size',
  'appearance', // Auto/Light/Dark theme choice (src/theme/ThemeProvider.tsx)
  'auto_sync',
  'link_preview',
  'graph_visited_only',
  'sync_folder',
  'zotero_api_key',
  'zotero_user_id',
  'tiered_math', // math rendering pref ('1'/'0')
]);
export const PRESERVED_META_PREFIXES: readonly string[] = ['pref_'];
export const CACHE_META_KEYS: ReadonlySet<string> = new Set([
  'index_refreshed_at',
  'link_index_json',
  'last_deep_sync',
  'math_pending', // slugs whose equations are not rendered yet
  'ast_parser_version',
  'math_tier_stamp', // which math pipeline produced the cached articles
]);

const isPreservedMetaKey = (key: string): boolean =>
  PRESERVED_META_KEYS.has(key) || PRESERVED_META_PREFIXES.some(p => key.startsWith(p));

// ── Entry point ──────────────────────────────────────────────────────────────

export async function importSeed<T extends SeedUserDataShape>(
  deps: SeedImportDeps<T>,
  url: string,
  onProgress: (p: SeedPhase) => void,
): Promise<void> {
  const { files } = deps;
  // Clean up any previous failed attempt
  await files.discardDownload();

  try {
    const result = await files.download(url, (bytesWritten, bytesTotal) => {
      onProgress({ phase: 'downloading', bytesWritten, bytesTotal });
    });
    if (result.status == null || result.status < 200 || result.status >= 300) {
      throw new Error(`Download failed: HTTP ${result.status ?? 'unknown'}`);
    }

    onProgress({ phase: 'validating' });

    const size = await files.downloadedSize();
    if (size == null || size < MIN_SEED_BYTES) {
      throw new Error('Downloaded file is too small — probably not a valid database');
    }

    onProgress({ phase: 'installing' });

    await files.prepareDbDir();
    await installSeedKeepingUserData(deps);
  } finally {
    await files.discardDownload().catch(() => {});
  }
}

// ── Swap the file, keep the user's data ──────────────────────────────────────

interface UserDataSnapshot<T> {
  data: T; // reads, bookmarks, annotations (+ their content_hash), preserved meta
  progress: Array<{ slug: string; read_progress: number }>;
}

// Read-only. If this throws, nothing has been touched yet.
async function snapshotUserData<T extends SeedUserDataShape>(deps: SeedImportDeps<T>): Promise<UserDataSnapshot<T>> {
  const data = await deps.userData.exportUserData();

  // exportUserData's `prefs` is every meta row but onboarding_done, including this
  // file's caches. Rebuild it from an explicit list instead.
  const metaRows = await deps.db.listMeta();
  const prefs: Record<string, string> = {};
  for (const { key, value } of metaRows) {
    if (value != null && isPreservedMetaKey(key)) prefs[key] = value;
  }

  // Reading progress lives in `entries`, which the seed replaces, and is not in the export.
  const progress = await deps.db.listReadProgress();

  return { data: { ...data, prefs }, progress };
}

async function restoreUserData<T extends SeedUserDataShape>(deps: SeedImportDeps<T>, snap: UserDataSnapshot<T>): Promise<void> {
  // First use of the connection on the new file opens it and runs the schema migrations, so a
  // seed that is not a usable database fails here, while a rollback is still possible.
  await deps.userData.importUserData(snap.data);

  // importUserData writes only the synced-pref allowlist (it is the sync-file
  // format and must never carry credentials). The settings this swap preserves
  // (onboarding_done, sync_folder, zotero_user_id, ...) are not all in it, so
  // write them back directly. A zotero_api_key meta row (the fallback used when
  // secure storage is unavailable) goes back as a meta row.
  for (const [key, value] of Object.entries(snap.data.prefs ?? {})) {
    await deps.meta.setMeta(key, value);
  }

  // importUserData does not write annotations.content_hash; without it, annotations
  // lose their stale-text check. Progress is restored only for entries the seed has.
  const annotationHashes: Array<{ id: number; content_hash: string }> = [];
  for (const a of snap.data.annotations) {
    if (a.content_hash) annotationHashes.push({ id: a.id, content_hash: a.content_hash });
  }
  await deps.db.restoreDerived({ annotationHashes, readProgress: snap.progress });
}

// A backup that is still here means an earlier import was interrupted (app killed
// mid-swap). It may hold the only copy of the user's data, so keep it, renamed.
async function setAsideLeftoverBackup(files: SeedFiles, clock: Clock): Promise<void> {
  const tag = `interrupted-${clock.now()}`;
  for (const s of SUFFIXES) {
    if (await files.hasBackup(s)) await files.setAsideBackup(s, tag);
  }
}

async function removeDbFiles(files: SeedFiles): Promise<void> {
  for (const s of SUFFIXES) await files.removeDb(s);
}

// Never throws. Returns false if the old database could not be put back.
async function rollback(files: SeedFiles, db: SeedDatabase, backedUp: boolean): Promise<boolean> {
  try {
    await db.close();
  } catch {
    // keep going: the file operations below are what matter
  }
  if (!backedUp) return true;
  try {
    await removeDbFiles(files);
    for (const s of SUFFIXES) {
      if (await files.hasBackup(s)) await files.restoreBackup(s);
    }
    return true;
  } catch {
    return false;
  }
}

async function installSeedKeepingUserData<T extends SeedUserDataShape>(deps: SeedImportDeps<T>): Promise<void> {
  const { files, db } = deps;
  const snapshot = await snapshotUserData(deps);
  await setAsideLeftoverBackup(files, deps.clock);

  let backedUp = false;
  try {
    // Close before touching the file (it is reopened lazily by the next use).
    await db.close();
    for (const s of SUFFIXES) {
      if (await files.hasDb(s)) {
        await files.backUpDb(s);
        backedUp = true;
      }
    }
    await removeDbFiles(files);
    await files.installDownload();
    await restoreUserData(deps, snapshot);
  } catch (err) {
    const restored = await rollback(files, db, backedUp);
    if (!restored && err instanceof Error) {
      err.message += ` (the previous database could not be put back; a copy is kept at ${files.backupLocation})`;
    }
    throw err;
  }

  // Only now, with the user's data verified in the new file, drop the backup.
  for (const s of SUFFIXES) await files.removeBackup(s);
}
