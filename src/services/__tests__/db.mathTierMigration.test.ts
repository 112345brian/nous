// Tiering stamp: cached article content is cleared when the effective tiering
// state changes, and only then. Fake DB — no real SQLite.
const mockMeta: Record<string, string> = {};
const mockRuns: string[] = [];

jest.mock('expo-sqlite', () => {
  const fakeDb = {
    execAsync: async () => {},
    runAsync: async (sql: string, params: unknown[] = []) => {
      mockRuns.push(sql);
      const m = /INSERT OR REPLACE INTO meta \(key, value\) VALUES \('([^']+)', \?\)/.exec(sql);
      if (m) mockMeta[m[1]] = String(params[0]);
      const lit = /INSERT OR REPLACE INTO meta \(key, value\) VALUES \('([^']+)', '([^']*)'\)/.exec(sql);
      if (lit) mockMeta[lit[1]] = lit[2];
      return { lastInsertRowId: 0, changes: 0 };
    },
    getAllAsync: async () => [],
    getFirstAsync: async (sql: string) => {
      const m = /SELECT value FROM meta WHERE key = '([^']+)'/.exec(sql);
      return m && m[1] in mockMeta ? { value: mockMeta[m[1]] } : null;
    },
    withTransactionAsync: async (fn: () => Promise<void>) => { await fn(); },
    closeAsync: async () => {},
  };
  return { __esModule: true, openDatabaseAsync: async () => fakeDb };
});

import { mathTierStamp, TIERED_MATH_DEFAULT } from '../../utils/mathTier';

const cleared = () => mockRuns.some(s => /UPDATE entries SET content_html = NULL[\s\S]*cached_at = NULL WHERE cached_at IS NOT NULL/.test(s)
  && s.includes('notes_html = NULL'));

async function boot(meta: Record<string, string>) {
  jest.resetModules();
  mockRuns.length = 0;
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  Object.assign(mockMeta, meta, { migrated_clear_cache_v2: '1', ast_parser_version: '2' });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const db = require('../db');
  await db.getDb();
}

test('default is OFF', () => expect(TIERED_MATH_DEFAULT).toBe(false));

test('first run: stamp recorded, nothing cleared', async () => {
  await boot({});
  expect(cleared()).toBe(false);
  expect(mockMeta.math_tier_stamp).toBe(mathTierStamp(false));
});

test('same state again: nothing cleared', async () => {
  await boot({ math_tier_stamp: mathTierStamp(false) });
  expect(cleared()).toBe(false);
});

test('flag turned on: cached content cleared, pending math dropped, stamp updated', async () => {
  await boot({ math_tier_stamp: mathTierStamp(false), tiered_math: '1' });
  expect(cleared()).toBe(true);
  expect(mockRuns.some(s => s.includes("DELETE FROM meta WHERE key = 'math_pending'"))).toBe(true);
  expect(mockMeta.math_tier_stamp).toBe(mathTierStamp(true));
});

test('older tier version (stamp mismatch) while on: cleared', async () => {
  await boot({ math_tier_stamp: 'on:0', tiered_math: '1' });
  expect(cleared()).toBe(true);
});

test('flag turned back off: cleared so articles re-process with SVG math', async () => {
  await boot({ math_tier_stamp: mathTierStamp(true), tiered_math: '0' });
  expect(cleared()).toBe(true);
  expect(mockMeta.math_tier_stamp).toBe('off');
});
