// Adapter: the sync folder on the device's file system (expo-file-system).
// Implements the SyncFolder port from src/core/ports.ts; wired in src/composition.ts.
import { File, Directory, Paths } from 'expo-file-system';
import type { SyncFolder } from '../core/ports';

/**
 * What "~" means on-device: the app's Documents directory (file:// URI, no trailing slash).
 * An iOS app is sandboxed, so the POSIX $HOME is not a place the reader can see or share,
 * and React Native's process.env has no HOME anyway. Documents is the one container
 * directory the Files app can expose. Needs a device check: confirm `~/Sync` lands in
 * Files > On My iPhone > Nous. Returns '' if the platform reports no document directory.
 */
export function expoSyncHome(): string {
  try {
    return (Paths.document?.uri ?? '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export const expoSyncFolder: SyncFolder = {
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
