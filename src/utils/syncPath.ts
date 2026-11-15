// Pure: where the user-data file lives for a folder the reader typed in.
// The environment (platform, home directory) is passed in, never read from globals.

export const USER_DATA_FILENAME = 'sep_user.json';

export interface SyncEnv {
  /** react-native Platform.OS: 'ios' | 'android' | 'macos' | ... */
  platform: string;
  /**
   * What a leading "~" means. The adapter supplies it (src/services/expoSyncFolder.ts:
   * `expoSyncHome`): on a device it is the app's own Documents directory as a file:// URI,
   * because a sandboxed iOS app has no usable $HOME and React Native's process.env has none.
   * May or may not end in "/". '' when unknown, in which case "~" paths resolve to null.
   */
  home: string;
}

/** file:// URI of the user-data file, or null when no folder is set. */
export function resolveSyncFileUri(folder: string, env: SyncEnv): string | null {
  let path = folder.trim();
  if (!path) return null;
  if ((path === '~' || path.startsWith('~/')) && (env.platform === 'macos' || env.platform === 'ios')) {
    const home = env.home.trim().replace(/\/+$/, '');
    if (!home) return null; // unknown home: never build an invalid URI like file://Sync/...
    path = home + path.slice(1);
  }
  if (!path.startsWith('file://')) path = 'file://' + path;
  if (!path.endsWith('/')) path += '/';
  return path + USER_DATA_FILENAME;
}
