// Thin wrapper over expo-secure-store (Keychain on iOS, Keystore-backed
// SharedPreferences on Android). Secrets such as the Zotero API key live here
// instead of the plain SQLite `meta` table so they never reach the DB file, DB
// backups, or the user-data export.
//
// expo-secure-store supports Android, iOS and tvOS only. Where it is missing
// (e.g. the react-native-macos target, which has no Expo modules, or a binary
// built before this dependency was added) `secretsAvailable()` is false and
// callers fall back to the plain meta table. Every function here swallows errors
// and reports failure through its return value so a secure-storage problem can
// never break the caller's main flow.
//
// The module is loaded lazily on purpose: expo-secure-store resolves its native
// module at import time and throws when it is not linked, which with a
// top-level import would take down everything that imports db.ts.
import type { SecretStore } from '../core/ports';

type SecureStoreModule = typeof import('expo-secure-store');

let mod: SecureStoreModule | null | undefined;

function store(): SecureStoreModule | null {
  if (mod === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('expo-secure-store') as SecureStoreModule;
    } catch {
      mod = null;
    }
  }
  return mod;
}

export async function secretsAvailable(): Promise<boolean> {
  try {
    return (await store()?.isAvailableAsync()) === true;
  } catch {
    return false;
  }
}

/** The stored secret, or null if absent or unreadable. */
export async function getSecret(key: string): Promise<string | null> {
  try {
    return (await store()?.getItemAsync(key)) ?? null;
  } catch {
    return null;
  }
}

/** True only if the value was stored. A false return means: keep using the old storage. */
export async function setSecret(key: string, value: string): Promise<boolean> {
  try {
    const s = store();
    if (!s) return false;
    await s.setItemAsync(key, value);
    return true;
  } catch {
    return false;
  }
}

/** True if the secret is gone (or never existed); false if deletion failed or storage is missing. */
export async function deleteSecret(key: string): Promise<boolean> {
  try {
    const s = store();
    if (!s) return false;
    await s.deleteItemAsync(key);
    return true;
  } catch {
    return false;
  }
}

/** The same operations as the core's `SecretStore` port (the named functions above are kept for db.ts). */
export const secureSecretStore: SecretStore = {
  available: secretsAvailable,
  get: getSecret,
  set: setSecret,
  delete: deleteSecret,
};
