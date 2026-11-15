// Builds a real Db instance (services/db createDb) over the real core pieces, the way the
// composition root does, for tests that exercise the adapter itself. Everything is required
// lazily so a test that calls jest.resetModules() gets a fresh instance with fresh module state,
// and so jest.mock of expo-sqlite / secureSecrets applies.
import type { Db, DbDeps } from '../../db';

declare function require(mod: string): any;

export type TestDb = Db & {
  contentHash: typeof import('../../db').contentHash;
  resolveEntryHash: typeof import('../../db').resolveEntryHash;
  formatCitation: typeof import('../../db').formatCitation;
  SYNCED_PREF_KEYS: typeof import('../../db').SYNCED_PREF_KEYS;
};

export function loadDb(over: Partial<DbDeps> = {}): TestDb {
  const mod = require('../../db');
  const { mergeAnnotation } = require('../../../core/annotationMerge');
  const { mergeRead } = require('../../../core/readsMerge');
  const { runMigrations, userVersionStore } = require('../../../core/migrations');
  const { CORE_MIGRATIONS } = require('../../coreMigrations');
  const secrets = () => require('../../secureSecrets');
  const inst: Db = mod.createDb({
    migrate: async (db: any) => { await runMigrations(db, CORE_MIGRATIONS, userVersionStore); },
    mergeAnnotation,
    mergeRead,
    clock: { now: () => Date.now() },
    newUid: () => Math.random().toString(16).slice(2).padEnd(32, '0'),
    secrets: {
      available: () => secrets().secretsAvailable(),
      get: (k: string) => secrets().getSecret(k),
      set: (k: string, v: string) => secrets().setSecret(k, v),
      delete: (k: string) => secrets().deleteSecret(k),
    },
    loadBundledLinkMap: async () => '{}',
    ...over,
  });
  return {
    ...inst,
    contentHash: mod.contentHash,
    resolveEntryHash: mod.resolveEntryHash,
    formatCitation: mod.formatCitation,
    SYNCED_PREF_KEYS: mod.SYNCED_PREF_KEYS,
  };
}
