// NOTE: SDK 54 — the async file functions on the main `expo-file-system` entry
// throw at runtime. They live on `expo-file-system/legacy`.
import {
  cacheDirectory,
  copyAsync,
  createDownloadResumable,
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  moveAsync,
} from 'expo-file-system/legacy';
import { closeDb, exportUserData, getDb, importUserData, setMeta } from './db';
import type { UserDataExport } from './db';

export type SeedPhase =
  | { phase: 'downloading'; bytesWritten: number; bytesTotal: number }
  | { phase: 'validating' }
  | { phase: 'installing' };

const DB_DIR = `${documentDirectory}SQLite/`;
const DB_PATH = `${DB_DIR}sep.db`;
const BACKUP_PATH = `${DB_DIR}sep.db.pre-seed-backup`;
const TMP_PATH = `${cacheDirectory}seed_import.db`;
// SQLite writes these next to the main file; stale ones must never be replayed
// onto a different database.
const SUFFIXES = ['', '-wal', '-shm'];

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
  'auto_sync',
  'link_preview',
  'graph_visited_only',
  'sync_folder',
  'zotero_api_key',
  'zotero_user_id',
]);
export const PRESERVED_META_PREFIXES: readonly string[] = ['pref_'];
export const CACHE_META_KEYS: ReadonlySet<string> = new Set([
  'index_refreshed_at',
  'link_index_json',
  'last_deep_sync',
  'math_inline_v2',
  'math_hash_format_v1',
  'ast_parser_version',
]);

const isPreservedMetaKey = (key: string): boolean =>
  PRESERVED_META_KEYS.has(key) || PRESERVED_META_PREFIXES.some(p => key.startsWith(p));

// ── Public entry point ───────────────────────────────────────────────────────

export async function importSeedFromUrl(
  url: string,
  onProgress: (p: SeedPhase) => void,
): Promise<void> {
  // Clean up any previous failed attempt
  await deleteAsync(TMP_PATH, { idempotent: true });

  try {
    const download = createDownloadResumable(
      url,
      TMP_PATH,
      {},
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        onProgress({ phase: 'downloading', bytesWritten: totalBytesWritten, bytesTotal: totalBytesExpectedToWrite });
      },
    );

    const result = await download.downloadAsync();
    if (!result || result.status < 200 || result.status >= 300) {
      throw new Error(`Download failed: HTTP ${result?.status ?? 'unknown'}`);
    }

    onProgress({ phase: 'validating' });

    const info = await getInfoAsync(TMP_PATH);
    if (!info.exists || (info as any).size < 50_000) {
      throw new Error('Downloaded file is too small — probably not a valid database');
    }

    onProgress({ phase: 'installing' });

    await makeDirectoryAsync(DB_DIR, { intermediates: true });
    await installSeedKeepingUserData(TMP_PATH);
  } finally {
    await deleteAsync(TMP_PATH, { idempotent: true }).catch(() => {});
  }
}

// ── Swap the file, keep the user's data ──────────────────────────────────────

interface UserDataSnapshot {
  data: UserDataExport; // reads, bookmarks, annotations (+ their content_hash), preserved meta
  progress: Array<{ slug: string; read_progress: number }>;
}

// Read-only. If this throws, nothing has been touched yet.
async function snapshotUserData(): Promise<UserDataSnapshot> {
  const data = await exportUserData();
  const db = await getDb();

  // exportUserData's `prefs` is every meta row but onboarding_done, including this
  // file's caches. Rebuild it from an explicit list instead.
  const metaRows = await db.getAllAsync<{ key: string; value: string | null }>('SELECT key, value FROM meta');
  const prefs: Record<string, string> = {};
  for (const { key, value } of metaRows) {
    if (value != null && isPreservedMetaKey(key)) prefs[key] = value;
  }

  // Reading progress lives in `entries`, which the seed replaces, and is not in the export.
  const progress = await db.getAllAsync<{ slug: string; read_progress: number }>(
    'SELECT slug, read_progress FROM entries WHERE read_progress > 0',
  );

  return { data: { ...data, prefs }, progress };
}

async function restoreUserData(snap: UserDataSnapshot): Promise<void> {
  // First getDb() on the new file opens it and runs the schema migrations, so a
  // seed that is not a usable database fails here, while a rollback is still possible.
  await importUserData(snap.data);

  // importUserData writes only the synced-pref allowlist (it is the sync-file
  // format and must never carry credentials). The settings this swap preserves
  // (onboarding_done, sync_folder, zotero_user_id, ...) are not all in it, so
  // write them back directly. A zotero_api_key meta row (the fallback used when
  // secure storage is unavailable) goes back as a meta row.
  for (const [key, value] of Object.entries(snap.data.prefs ?? {})) {
    await setMeta(key, value);
  }

  const db = await getDb();
  await db.withTransactionAsync(async () => {
    // importUserData does not write annotations.content_hash; without it, annotations
    // lose their stale-text check.
    for (const a of snap.data.annotations) {
      if (a.content_hash) {
        await db.runAsync('UPDATE annotations SET content_hash = ? WHERE id = ?', [a.content_hash, a.id]);
      }
    }
    // Only for entries the seed has; nothing is invented for ones it lacks.
    for (const p of snap.progress) {
      await db.runAsync('UPDATE entries SET read_progress = ? WHERE slug = ?', [p.read_progress, p.slug]);
    }
  });
}

async function exists(path: string): Promise<boolean> {
  return (await getInfoAsync(path)).exists;
}

async function removeDbFiles(): Promise<void> {
  for (const s of SUFFIXES) await deleteAsync(`${DB_PATH}${s}`, { idempotent: true });
}

// A backup that is still here means an earlier import was interrupted (app killed
// mid-swap). It may hold the only copy of the user's data, so keep it, renamed.
async function setAsideLeftoverBackup(): Promise<void> {
  const stamp = Date.now();
  for (const s of SUFFIXES) {
    if (await exists(`${BACKUP_PATH}${s}`)) {
      await moveAsync({ from: `${BACKUP_PATH}${s}`, to: `${BACKUP_PATH}.interrupted-${stamp}${s}` });
    }
  }
}

// Never throws. Returns false if the old database could not be put back.
async function rollback(backedUp: boolean): Promise<boolean> {
  try {
    await closeDb();
  } catch {
    // keep going: the file operations below are what matter
  }
  if (!backedUp) return true;
  try {
    await removeDbFiles();
    for (const s of SUFFIXES) {
      if (await exists(`${BACKUP_PATH}${s}`)) {
        await moveAsync({ from: `${BACKUP_PATH}${s}`, to: `${DB_PATH}${s}` });
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function installSeedKeepingUserData(seedPath: string): Promise<void> {
  const snapshot = await snapshotUserData();
  await setAsideLeftoverBackup();

  let backedUp = false;
  try {
    // Close before touching the file (it is reopened lazily by the next getDb()).
    await closeDb();
    for (const s of SUFFIXES) {
      if (await exists(`${DB_PATH}${s}`)) {
        await copyAsync({ from: `${DB_PATH}${s}`, to: `${BACKUP_PATH}${s}` });
        backedUp = true;
      }
    }
    await removeDbFiles();
    await moveAsync({ from: seedPath, to: DB_PATH });
    await restoreUserData(snapshot);
  } catch (err) {
    const restored = await rollback(backedUp);
    if (!restored && err instanceof Error) {
      err.message += ` (the previous database could not be put back; a copy is kept at ${BACKUP_PATH})`;
    }
    throw err;
  }

  // Only now, with the user's data verified in the new file, drop the backup.
  for (const s of SUFFIXES) await deleteAsync(`${BACKUP_PATH}${s}`, { idempotent: true });
}
