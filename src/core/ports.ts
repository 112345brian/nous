// Ports: the outward-facing interfaces the core needs. Plain TypeScript only.
//
// Direction of dependency: adapters (src/services, UI) import these types and
// implement them; nothing in src/core imports an adapter. The composition code that
// builds adapters and hands them to core functions lives at the edge
// (today: the wrappers in src/services/dataSync.ts; see docs/core-di-audit.md).

/** Wall clock. Core code never reads Date.now() or new Date() itself. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** Reads and writes the user-data file inside the folder the reader chose. */
export interface SyncFolder {
  /** Text of the file at `fileUri`, or null when it does not exist. */
  read(fileUri: string): Promise<string | null>;
  /** Create parent folders as needed and replace the file with `text`. */
  write(fileUri: string, text: string): Promise<void>;
}

/**
 * The slice of the local database the sync-folder use cases need.
 * `T` is the snapshot shape (src/services/db.ts's UserDataExport); the core only
 * relies on its `version` field, so the adapter owns the rest of the shape.
 */
export interface UserDataStore<T extends { version: number }> {
  /** The folder path the reader typed in Settings ('' when unset). */
  getSyncFolder(): Promise<string>;
  exportUserData(): Promise<T>;
  importUserData(data: T): Promise<void>;
}

/** Minimal HTTP surface of the Zotero web API; the adapter adds base URL, key and headers. */
export interface ZoteroHttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<any>;
}
export interface ZoteroHttp {
  /** POST `body` as JSON to `path` (e.g. '/items'), relative to the reader's library. */
  post(path: string, body: unknown): Promise<ZoteroHttpResponse>;
}
