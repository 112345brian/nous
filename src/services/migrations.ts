// The migration runner and version stores live in the core (src/core/migrations.ts),
// where the database is a port. This re-export keeps the import path for graphDb.ts
// (owned by another change) and the existing tests.
export * from '../core/migrations';
