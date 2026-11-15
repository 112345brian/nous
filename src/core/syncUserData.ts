// Use cases UC-H3 / UC-H4: export the reader's data to, and import it from, the
// sync folder. Everything outside the core arrives through `deps`.
import type { SyncFolder, UserDataStore } from './ports';
import { resolveSyncFileUri, type SyncEnv } from '../utils/syncPath';

export interface SyncUserDataDeps<T extends { version: number }> {
  folder: SyncFolder;
  store: UserDataStore<T>;
  env: SyncEnv;
}

export async function exportUserDataToFolder<T extends { version: number }>(
  deps: SyncUserDataDeps<T>,
): Promise<'ok' | 'no_folder' | 'error'> {
  const dest = resolveSyncFileUri(await deps.store.getSyncFolder(), deps.env);
  if (!dest) return 'no_folder';
  try {
    const data = await deps.store.exportUserData();
    await deps.folder.write(dest, JSON.stringify(data, null, 2));
    return 'ok';
  } catch {
    return 'error';
  }
}

export async function importUserDataFromFolder<T extends { version: number }>(
  deps: SyncUserDataDeps<T>,
): Promise<'ok' | 'no_folder' | 'not_found' | 'error'> {
  const src = resolveSyncFileUri(await deps.store.getSyncFolder(), deps.env);
  if (!src) return 'no_folder';
  try {
    const json = await deps.folder.read(src);
    if (json === null) return 'not_found';
    const data: T = JSON.parse(json);
    if (!data || data.version !== 1) return 'error';
    await deps.store.importUserData(data);
    return 'ok';
  } catch {
    return 'error';
  }
}
