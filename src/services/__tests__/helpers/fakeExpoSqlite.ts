// A real-SQLite stand-in for `expo-sqlite`, backed by node:sqlite (FTS5 included),
// with hooks to hold operations open so concurrency bugs can be reproduced
// deterministically. Used by the db / graphDb connection and migration tests.
//
//   jest.mock('expo-sqlite', () => require('./helpers/fakeExpoSqlite').module);
//
// Databases persist by name in `state.raws` across close/reopen (like the file
// on disk does); each openDatabaseAsync call returns a fresh handle that
// throws once it has been closed, so use-after-close shows up as a failure.

declare function require(mod: string): any;
const { DatabaseSync } = require('node:sqlite');

export interface Gate {
  promise: Promise<void>;
  release: () => void;
}

export function makeGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>(res => { release = res; });
  return { promise, release };
}

export const state: {
  raws: Map<string, any>;
  handles: FakeDb[];
  openCalls: number;
  openGate: Gate | null;
  opGate: Gate | null;
  closeGate: Gate | null;
  failOpen: Error | null;
  failSql: ((sql: string) => Error | null) | null;
} = {
  raws: new Map(),
  handles: [],
  openCalls: 0,
  openGate: null,
  opGate: null,
  closeGate: null,
  failOpen: null,
  failSql: null,
};

export function reset(): void {
  for (const open of state.raws.values()) { try { open.close(); } catch { /* already closed */ } }
  state.raws = new Map();
  state.handles = [];
  state.openCalls = 0;
  state.openGate = null;
  state.opGate = null;
  state.closeGate = null;
  state.failOpen = null;
  state.failSql = null;
}

/** The raw node:sqlite database behind a name — for seeding legacy schemas and asserting. */
export function raw(name = 'sep.db'): any {
  let r = state.raws.get(name);
  if (!r) { r = new DatabaseSync(':memory:'); state.raws.set(name, r); }
  return r;
}

/** Simulates the file being replaced on disk (e.g. a seed import). */
export function dropDatabase(name = 'sep.db'): void {
  const r = state.raws.get(name);
  if (r) { try { r.close(); } catch { /* already closed */ } }
  state.raws.delete(name);
}

const asParams = (p: unknown): unknown[] => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
const plain = (row: any) => (row ? { ...row } : row);

export class FakeDb {
  closed = false;
  constructor(readonly name: string) {}

  private async before(sql?: string): Promise<any> {
    if (state.opGate) await state.opGate.promise;
    await Promise.resolve();
    if (this.closed) throw new Error('FakeDb: use after close');
    if (sql && state.failSql) {
      const err = state.failSql(sql);
      if (err) throw err;
    }
    return raw(this.name);
  }

  async execAsync(sql: string): Promise<void> {
    (await this.before(sql)).exec(sql);
  }
  async runAsync(sql: string, params?: unknown) {
    const r = (await this.before(sql)).prepare(sql).run(...asParams(params));
    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
  }
  async getFirstAsync<T = any>(sql: string, params?: unknown): Promise<T | null> {
    const row = (await this.before(sql)).prepare(sql).get(...asParams(params));
    return row ? (plain(row) as T) : null;
  }
  async getAllAsync<T = any>(sql: string, params?: unknown): Promise<T[]> {
    return (await this.before(sql)).prepare(sql).all(...asParams(params)).map(plain) as T[];
  }
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const r = await this.before();
    r.exec('BEGIN');
    try {
      await task();
      r.exec('COMMIT');
    } catch (e) {
      try { r.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  }
  async closeAsync(): Promise<void> {
    if (state.closeGate) await state.closeGate.promise;
    this.closed = true;
  }
}

async function openDatabaseAsync(name: string): Promise<FakeDb> {
  state.openCalls += 1;
  if (state.openGate) await state.openGate.promise;
  await Promise.resolve();
  if (state.failOpen) {
    const e = state.failOpen;
    state.failOpen = null;
    throw e;
  }
  const h = new FakeDb(name);
  state.handles.push(h);
  return h;
}

export const module = { __esModule: true, openDatabaseAsync };

/** 'pending' if p has not settled within a few ms, else 'settled'. */
export async function settledState(p: Promise<unknown>): Promise<'pending' | 'settled'> {
  return Promise.race([
    p.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>(res => setTimeout(() => res('pending'), 25)),
  ]);
}

export const tick = (ms = 0) => new Promise<void>(res => setTimeout(res, ms));
