// Pure: where the user-data file lives for a folder the reader typed in.
// The environment (platform, home directory) is passed in, never read from globals.

export const USER_DATA_FILENAME = 'sep_user.json';

export interface SyncEnv {
  /** react-native Platform.OS: 'ios' | 'android' | 'macos' | ... */
  platform: string;
  /** Home directory used to expand a leading "~" on ios/macos; '' when unknown. */
  home: string;
}

/** file:// URI of the user-data file, or null when no folder is set. */
export function resolveSyncFileUri(folder: string, env: SyncEnv): string | null {
  let path = folder.trim();
  if (!path) return null;
  if (path.startsWith('~') && (env.platform === 'macos' || env.platform === 'ios')) {
    path = env.home + path.slice(1);
  }
  if (!path.startsWith('file://')) path = 'file://' + path;
  if (!path.endsWith('/')) path += '/';
  return path + USER_DATA_FILENAME;
}
