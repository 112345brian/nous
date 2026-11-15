// The sync-folder and Zotero use cases moved to src/core and are wired in src/composition.ts;
// the adapters are services/expoSyncFolder.ts and services/zoteroHttp.ts.

// Legacy no-op kept for App.tsx compatibility
export async function syncOnLaunch(): Promise<void> {}
