// Characterizes how the article content hash is produced, stored and read back.

const mockRun = jest.fn(async (..._args: unknown[]) => ({ lastInsertRowId: 0, changes: 1 }));
const mockFirst = jest.fn(async (..._args: unknown[]): Promise<unknown> => null);

jest.mock('expo-sqlite', () => {
  const db = {
    execAsync: async () => {},
    runAsync: (...args: unknown[]) => mockRun(...args),
    getAllAsync: async () => [],
    getFirstAsync: (...args: unknown[]) => mockFirst(...args),
    withTransactionAsync: async (fn: () => Promise<void>) => { await fn(); },
    closeAsync: async () => {},
  };
  return { __esModule: true, openDatabaseAsync: async () => db, openDatabaseSync: () => db };
});

import { cacheArticle, contentHash, resolveEntryHash } from '../db';

beforeEach(() => {
  mockRun.mockClear();
  mockFirst.mockReset();
  mockFirst.mockResolvedValue(null);
});

describe('contentHash', () => {
  it('is deterministic and content-sensitive', () => {
    expect(contentHash('hello nous')).toBe(contentHash('hello nous'));
    expect(contentHash('hello nous')).not.toBe(contentHash('different content'));
  });

  it('only looks at the first 50,000 characters', () => {
    const head = 'a'.repeat(50000);
    expect(contentHash(head + 'tail one')).toBe(contentHash(head + 'tail two'));
    expect(contentHash('b' + head)).not.toBe(contentHash('c' + head));
  });

  it('handles the empty string', () => {
    expect(typeof contentHash('')).toBe('string');
  });
});

describe('resolveEntryHash', () => {
  it('returns the stored hash without touching the HTML', () => {
    // A getter that throws proves the (potentially large) HTML is never read.
    const entry = {
      content_hash: 'stored',
      get content_html(): string { throw new Error('content_html must not be read'); },
    };
    expect(resolveEntryHash(entry)).toBe('stored');
  });

  it('falls back to hashing the HTML for rows cached before the column existed', () => {
    expect(resolveEntryHash({ content_hash: null, content_html: '<p>x</p>' })).toBe(contentHash('<p>x</p>'));
    expect(resolveEntryHash({ content_hash: '', content_html: '<p>x</p>' })).toBe(contentHash('<p>x</p>'));
  });

  it('handles a row with neither hash nor content', () => {
    expect(resolveEntryHash({ content_hash: null, content_html: null })).toBe(contentHash(''));
  });
});

describe('cacheArticle', () => {
  const html = '<p>Some article body.</p>';
  const data = {
    author: 'A. Author', pub_date: '2020', toc_html: null, preamble_html: '<p>pre</p>',
    content_html: html, content_ast: null, has_math: 0,
  };

  it('stores the content hash on the entry row', async () => {
    await cacheArticle('slug', data);
    // (initSchema also issues parameterless UPDATE entries statements; pick the cache write.)
    const update = mockRun.mock.calls.find(c => String(c[0]).includes('content_hash = ?'));
    expect(update).toBeDefined();
    expect(update![1]).toContain(contentHash(html));
  });

  it('records the same hash as an article version', async () => {
    await cacheArticle('slug', data);
    const version = mockRun.mock.calls.filter(c => String(c[0]).includes('INSERT OR IGNORE INTO article_versions'));
    expect(version.at(-1)![1]).toEqual(['slug', contentHash(html), expect.any(Number)]);
  });

  it('keeps the previous version when re-caching', async () => {
    mockFirst.mockResolvedValueOnce({ content_hash: 'prevhash', cached_at: 123 });
    await cacheArticle('slug', data);
    const versions = mockRun.mock.calls.filter(c => String(c[0]).includes('INSERT OR IGNORE INTO article_versions'));
    expect(versions[0][1]).toEqual(['slug', 'prevhash', 123]);
  });
});
