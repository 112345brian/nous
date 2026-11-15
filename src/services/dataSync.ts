// Adapters + wiring for the sync-folder and Zotero use cases.
//
// The logic lives in src/core (syncUserData.ts, zotero.ts) and reaches the outside world
// only through the ports in src/core/ports.ts. This file supplies the concrete pieces
// (expo-file-system, fetch, the SQLite store, Platform) and keeps the original exported
// functions so existing callers (SettingsScreen, ReadingListScreen, App) are unchanged.
import { File, Directory, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import {
  getSyncFolder, exportUserData, importUserData, getArticleVersionDate,
  type UserDataExport, type BookmarkRow,
} from './db';
import type { Annotation } from '../types';
import type { SyncFolder, UserDataStore, ZoteroHttp } from '../core/ports';
import { exportUserDataToFolder, importUserDataFromFolder } from '../core/syncUserData';
import { exportBookmarkToZotero } from '../core/zotero';

// ── Adapters ─────────────────────────────────────────────────────────────────

const expoSyncFolder: SyncFolder = {
  async read(fileUri) {
    const file = new File(fileUri);
    if (!file.exists) return null;
    return file.text();
  },
  async write(fileUri, text) {
    const dirPath = fileUri.slice(0, fileUri.lastIndexOf('/') + 1);
    const dir = new Directory(dirPath);
    if (!dir.exists) dir.create();

    // Write via a temp file in cache then move
    const tmp = new File(Paths.cache, 'sep_user_tmp.json');
    tmp.write(text);
    tmp.copy(new File(fileUri));
    if (tmp.exists) tmp.delete();
  },
};

const dbUserData: UserDataStore<UserDataExport> = {
  getSyncFolder: () => getSyncFolder() as Promise<string>,
  exportUserData,
  importUserData,
};

function syncDeps() {
  return {
    folder: expoSyncFolder,
    store: dbUserData,
    env: {
      platform: Platform.OS as string,
      home: (process.env as Record<string, string | undefined>).HOME ?? '',
    },
  };
}

function zoteroHttp(apiKey: string, userId: string): ZoteroHttp {
  const apiBase = `https://api.zotero.org/users/${userId}`;
  const headers = {
    'Zotero-API-Key': apiKey,
    'Zotero-API-Version': '3',
    'Content-Type': 'application/json',
  };
  return {
    post: (path, body) =>
      fetch(`${apiBase}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

// ── Public API (unchanged signatures) ────────────────────────────────────────

export function exportToSyncFolder(): Promise<'ok' | 'no_folder' | 'error'> {
  return exportUserDataToFolder(syncDeps());
}

export function importFromSyncFolder(): Promise<'ok' | 'no_folder' | 'not_found' | 'error'> {
  return importUserDataFromFolder(syncDeps());
}

// Legacy no-op kept for App.tsx compatibility
export async function syncOnLaunch(): Promise<void> {}

export function exportToZotero(
  apiKey: string,
  userId: string,
  item: Pick<BookmarkRow, 'slug' | 'title' | 'author' | 'pub_date'>,
  annotations: Annotation[] = []
): Promise<'ok' | 'auth_error' | 'error'> {
  return exportBookmarkToZotero(
    { http: zoteroHttp(apiKey, userId), versionDate: getArticleVersionDate, clock: { now: () => Date.now() } },
    item,
    annotations,
  );
}
