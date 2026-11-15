// The composition root: the one place that builds concrete adapters and hands them to the
// core use cases. Screens and App.tsx import the use cases from here; the core imports
// nothing outside itself and the pure inner ring; adapters (src/services/*) never import this
// file. src/__tests__/compositionRoot.test.ts enforces all three.
//
// What lives here today:
//   - sync-folder export/import and Zotero export (wired here, adapters in services/)
// What is re-exported from services/catalog.ts for now:
//   - refreshIndexIfStale, fetchAndCacheArticle, onMathReady, completeArticleMath,
//     resumePendingMath. catalog.ts still wires these itself because downloadAll,
//     syncCachedArticles and the backfills call them; moving the wiring here before those are
//     converted would make catalog.ts and this file import each other. When they are converted,
//     the wiring moves here and the re-export below becomes real code.
import { Platform } from 'react-native';
import {
  getSyncFolder, exportUserData, importUserData, getArticleVersionDate,
  type UserDataExport, type BookmarkRow,
} from './services/db';
import type { Annotation } from './types';
import type { UserDataStore } from './core/ports';
import { exportUserDataToFolder, importUserDataFromFolder } from './core/syncUserData';
import { exportBookmarkToZotero } from './core/zotero';
import { expoSyncFolder } from './services/expoSyncFolder';
import { zoteroHttp } from './services/zoteroHttp';

// ── Sync folder and Zotero ───────────────────────────────────────────────────

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

export function exportToSyncFolder(): Promise<'ok' | 'no_folder' | 'error'> {
  return exportUserDataToFolder(syncDeps());
}

export function importFromSyncFolder(): Promise<'ok' | 'no_folder' | 'not_found' | 'error'> {
  return importUserDataFromFolder(syncDeps());
}

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

// ── Wired in services/catalog.ts for now (see the header) ────────────────────

export {
  refreshIndexIfStale,
  fetchAndCacheArticle,
  onMathReady,
  completeArticleMath,
  resumePendingMath,
} from './services/catalog';
