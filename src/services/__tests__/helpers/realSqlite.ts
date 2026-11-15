// A real SQLite database (node:sqlite, in-memory) behind the slice of the
// expo-sqlite async API that src/services/db.ts uses. The repo-wide
// __mocks__/expo-sqlite.js is a no-op fake, which can't prove query behavior,
// transaction rollback, or index use. Tests here need the real engine.

declare function require(mod: string): any;
const { DatabaseSync } = require('node:sqlite');

export interface RealDb {
  raw: any;
  // Called with the SQL of every runAsync before it executes; throw to simulate
  // a failure at that statement.
  beforeRun: ((sql: string) => void) | null;
  // Rows returned by getAllAsync, keyed by SQL substring match, for "how much
  // did this query pull in" assertions.
  rowsReturned: Array<{ sql: string; rows: number }>;
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getAllAsync<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

const plain = (row: any) => ({ ...row });

export function createRealDb(): RealDb {
  const raw = new DatabaseSync(':memory:');
  const db: RealDb = {
    raw,
    beforeRun: null,
    rowsReturned: [],
    execAsync: async sql => {
      raw.exec(sql);
    },
    runAsync: async (sql, params = []) => {
      db.beforeRun?.(sql);
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    getAllAsync: async (sql, params = []) => {
      const rows = raw.prepare(sql).all(...params).map(plain);
      db.rowsReturned.push({ sql, rows: rows.length });
      return rows;
    },
    getFirstAsync: async (sql, params = []) => {
      const row = raw.prepare(sql).get(...params);
      return row ? plain(row) : null;
    },
    // Mirrors expo-sqlite: BEGIN, run the callback, COMMIT; ROLLBACK on throw.
    withTransactionAsync: async fn => {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    closeAsync: async () => {},
  };
  return db;
}
