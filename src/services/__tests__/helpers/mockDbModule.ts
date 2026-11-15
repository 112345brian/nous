// The test double for services/db now that the database is an injected instance. Tests that used
// `jest.mock('../db', () => ({ getMeta: jest.fn(), ... }))` wrap the same object: the composition
// root's `createDb(...)` hands back that object, and its members are also module exports so a test
// can still reach each jest.fn as `db.getMeta`.
export function asDbModule<T extends object>(api: T): T & { __esModule: true; createDb: () => T } {
  return { __esModule: true, ...api, createDb: () => api };
}
