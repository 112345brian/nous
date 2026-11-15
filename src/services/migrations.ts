// Versioned schema migrations.
//
// A schema is an ordered list of steps. The applied version lives in the
// database itself (a VersionStore), each step runs in its own transaction
// together with the version bump, so a failed step leaves the database exactly
// as the previous step left it and the next launch resumes there.
//
// The core schema stores its version in `PRAGMA user_version`. A module that
// owns extra tables in the same file (services/graphDb.ts) cannot share that
// single integer, so it uses tableVersionStore with its own scope.
//
// Adding a change: append a step with the next version number. Never edit or
// reorder a released step: existing installs have already run it.

import type { SQLiteDatabase } from 'expo-sqlite';

export interface Migration {
  /** 1-based, contiguous, strictly increasing. */
  version: number;
  /** Short description, shown in errors. */
  name: string;
  up(db: SQLiteDatabase): Promise<void>;
}

export interface VersionStore {
  get(db: SQLiteDatabase): Promise<number>;
  /** Called inside the step's transaction, so it commits or rolls back with the step. */
  set(db: SQLiteDatabase, version: number): Promise<void>;
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid schema version: ${String(version)}`);
  }
}

export const userVersionStore: VersionStore = {
  async get(db) {
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    return Number(row?.user_version ?? 0);
  },
  async set(db, version) {
    assertVersion(version);
    // PRAGMA cannot take bound parameters; the value is a validated integer.
    await db.execAsync(`PRAGMA user_version = ${version}`);
  },
};

export function tableVersionStore(scope: string): VersionStore {
  return {
    async get(db) {
      await db.execAsync(
        'CREATE TABLE IF NOT EXISTS schema_versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL)',
      );
      const row = await db.getFirstAsync<{ version: number }>(
        'SELECT version FROM schema_versions WHERE scope = ?',
        [scope],
      );
      return Number(row?.version ?? 0);
    },
    async set(db, version) {
      assertVersion(version);
      await db.runAsync(
        `INSERT INTO schema_versions (scope, version) VALUES (?, ?)
         ON CONFLICT(scope) DO UPDATE SET version = excluded.version`,
        [scope, version],
      );
    },
  };
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migration list is not contiguous: "${m.name}" has version ${m.version}, expected ${i + 1}`,
      );
    }
  });
}

/**
 * Brings the database up to the latest step and returns the resulting version.
 * A database already past the latest known step (written by a newer app
 * version) is left untouched: the schema is additive, so older code keeps
 * working against it.
 */
export async function runMigrations(
  db: SQLiteDatabase,
  migrations: readonly Migration[],
  store: VersionStore,
): Promise<number> {
  assertWellFormed(migrations);
  const latest = migrations.length;
  const current = await store.get(db);
  if (current >= latest) return current;

  for (const m of migrations) {
    if (m.version <= current) continue;
    try {
      await db.withTransactionAsync(async () => {
        await m.up(db);
        await store.set(db, m.version);
      });
    } catch (e) {
      throw new Error(`Schema migration ${m.version} (${m.name}) failed: ${errorMessage(e)}`);
    }
  }
  return latest;
}

// Not `instanceof Error`: native SQLite errors can come from another realm.
function errorMessage(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
}
