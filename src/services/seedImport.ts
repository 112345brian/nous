// Adapter for the seed import (src/core/seedImport.ts): the expo-file-system and connection
// calls, and nothing else. The orchestration (download, validate, snapshot, swap, restore,
// rollback) lives in the core and is wired in src/composition.ts.
//
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
import type { SQLiteDatabase } from 'expo-sqlite';
import type { SeedDatabase, SeedFiles } from '../core/ports';

const DB_DIR = `${documentDirectory}SQLite/`;
const DB_PATH = `${DB_DIR}sep.db`;
const BACKUP_PATH = `${DB_DIR}sep.db.pre-seed-backup`;
const TMP_PATH = `${cacheDirectory}seed_import.db`;

const exists = async (path: string): Promise<boolean> => (await getInfoAsync(path)).exists;

export const seedFiles: SeedFiles = {
  async download(url, onProgress) {
    const download = createDownloadResumable(url, TMP_PATH, {}, ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      onProgress(totalBytesWritten, totalBytesExpectedToWrite);
    });
    const result = await download.downloadAsync();
    return { status: result?.status ?? null };
  },
  async downloadedSize() {
    const info = await getInfoAsync(TMP_PATH);
    return info.exists ? ((info as { size?: number }).size ?? 0) : null;
  },
  discardDownload: () => deleteAsync(TMP_PATH, { idempotent: true }),
  prepareDbDir: () => makeDirectoryAsync(DB_DIR, { intermediates: true }),
  hasDb: s => exists(`${DB_PATH}${s}`),
  hasBackup: s => exists(`${BACKUP_PATH}${s}`),
  backUpDb: s => copyAsync({ from: `${DB_PATH}${s}`, to: `${BACKUP_PATH}${s}` }),
  removeDb: s => deleteAsync(`${DB_PATH}${s}`, { idempotent: true }),
  restoreBackup: s => moveAsync({ from: `${BACKUP_PATH}${s}`, to: `${DB_PATH}${s}` }),
  setAsideBackup: (s, tag) => moveAsync({ from: `${BACKUP_PATH}${s}`, to: `${BACKUP_PATH}.${tag}${s}` }),
  removeBackup: s => deleteAsync(`${BACKUP_PATH}${s}`, { idempotent: true }),
  installDownload: () => moveAsync({ from: TMP_PATH, to: DB_PATH }),
  backupLocation: BACKUP_PATH,
};

// The connection comes from the caller (the composition root passes the one Db instance's handles).
export function createSeedDatabase({ getDb, closeDb }: {
  getDb: () => Promise<SQLiteDatabase>;
  closeDb: () => Promise<void>;
}): SeedDatabase {
  return {
  close: closeDb,
  async listMeta() {
    const db = await getDb();
    return db.getAllAsync<{ key: string; value: string | null }>('SELECT key, value FROM meta');
  },
  async listReadProgress() {
    const db = await getDb();
    return db.getAllAsync<{ slug: string; read_progress: number }>(
      'SELECT slug, read_progress FROM entries WHERE read_progress > 0',
    );
  },
  async restoreDerived({ annotationHashes, readProgress }) {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const a of annotationHashes) {
        await db.runAsync('UPDATE annotations SET content_hash = ? WHERE id = ?', [a.content_hash, a.id]);
      }
      for (const p of readProgress) {
        await db.runAsync('UPDATE entries SET read_progress = ? WHERE slug = ?', [p.read_progress, p.slug]);
      }
    });
  },
  };
}
