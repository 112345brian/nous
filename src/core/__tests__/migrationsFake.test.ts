// The runner against a hand-written fake database; clock and timers throw.
import { runMigrations, tableVersionStore, type Migration, type VersionStore } from '../migrations';
import type { MigrationDb } from '../ports';

beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('setTimeout'); }) as any);
});
afterEach(() => jest.restoreAllMocks());

function fake() {
  const log: string[] = [];
  let version = 0;
  const db: MigrationDb = {
    runAsync: async () => ({}), getFirstAsync: async () => null, execAsync: async () => {}, getAllAsync: async () => [],
    // snapshot/rollback of the fake version, as a transaction would
    withTransactionAsync: async task => { const before = version; try { await task(); } catch (e) { version = before; throw e; } },
  };
  const store: VersionStore = { get: async () => version, set: async (_d, v) => { version = v; } };
  const steps = (failAt = 0): Migration[] => [1, 2, 3].map(v => ({
    version: v, name: `s${v}`, up: async () => { log.push(`up${v}`); if (v === failAt) throw new Error('boom'); },
  }));
  return { db, store, steps, log, ver: () => version };
}

it('runs pending steps in order and returns the latest version', async () => {
  const f = fake();
  expect(await runMigrations(f.db, f.steps(), f.store)).toBe(3);
  expect(f.log).toEqual(['up1', 'up2', 'up3']);
});
it('a failing step rolls back its version bump, names the step, and resumes there', async () => {
  const f = fake();
  await expect(runMigrations(f.db, f.steps(2), f.store)).rejects.toThrow('Schema migration 2 (s2) failed: boom');
  expect(f.ver()).toBe(1);
  f.log.length = 0;
  await runMigrations(f.db, f.steps(), f.store);
  expect(f.log).toEqual(['up2', 'up3']);
});
it('rejects a non-contiguous list before touching the database', async () => {
  const f = fake();
  await expect(runMigrations(f.db, [{ version: 2, name: 'x', up: async () => {} }], f.store)).rejects.toThrow('not contiguous');
});
it('leaves a database from a newer app alone', async () => {
  const f = fake();
  await f.store.set(f.db, 9);
  expect(await runMigrations(f.db, f.steps(), f.store)).toBe(9);
  expect(f.log).toEqual([]);
});
it('tableVersionStore rejects an invalid version', async () => {
  await expect(tableVersionStore('x').set(fake().db, -1)).rejects.toThrow('Invalid schema version');
});
