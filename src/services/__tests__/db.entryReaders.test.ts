// Entry readers: getEntry (full row) vs explicit-column readers that skip the
// heavy columns. A fake DB records every SQL string so we can assert which
// columns each reader asks for — no real SQLite needed.

const mockSqlLog: string[] = [];
let mockNextRow: Record<string, unknown> | null = null;

jest.mock('expo-sqlite', () => {
  const fakeDb = {
    execAsync: async () => {},
    runAsync: async () => ({ lastInsertRowId: 0, changes: 0 }),
    getAllAsync: async () => [],
    getFirstAsync: async (sql: string) => {
      mockSqlLog.push(sql);
      return mockNextRow;
    },
    withTransactionAsync: async (fn: () => Promise<void>) => { await fn(); },
    closeAsync: async () => {},
  };
  return { __esModule: true, openDatabaseAsync: async () => fakeDb };
});

import { getEntry, getEntryMeta, getEntryHtml } from '../db';

const HEAVY = ['content_html', 'content_ast', 'notes_html'];
const ENTRY_ROW_COLUMNS = [
  'slug', 'title', 'parent_label', 'source', 'author', 'pub_date', 'content_hash',
  'toc_html', 'preamble_html', 'content_html', 'notes_html', 'content_ast',
  'has_math', 'word_count', 'cached_at',
];

const FULL_ROW = {
  slug: 'aristotle', title: 'Aristotle', parent_label: null, source: 'sep',
  author: 'A. Author', pub_date: '2024', content_hash: 'h1', toc_html: '<li/>',
  preamble_html: '<p>p</p>', content_html: '<p>body</p>', notes_html: '<p>n</p>',
  content_ast: '{"blocks":[]}', has_math: 0, word_count: 1, cached_at: 1,
};

// Column list of a "SELECT a, b FROM entries ..." statement.
function selectedColumns(sql: string): string[] {
  const m = /SELECT\s+([\s\S]*?)\s+FROM\s+entries/i.exec(sql);
  if (!m) throw new Error(`not a SELECT FROM entries: ${sql}`);
  return m[1].split(',').map(c => c.trim());
}

beforeEach(() => { mockSqlLog.length = 0; mockNextRow = null; });

describe('getEntry (full row — current contract)', () => {
  it('returns the row as stored, including all heavy columns', async () => {
    mockNextRow = FULL_ROW;
    const e = await getEntry('aristotle');
    expect(e).toEqual(FULL_ROW);
  });

  it('returns null for an unknown slug', async () => {
    expect(await getEntry('nope')).toBeNull();
  });

  it('names every EntryRow column explicitly (no SELECT *)', async () => {
    mockNextRow = FULL_ROW;
    await getEntry('aristotle');
    const cols = selectedColumns(mockSqlLog[0]);
    expect(cols).not.toContain('*');
    expect([...cols].sort()).toEqual([...ENTRY_ROW_COLUMNS].sort());
  });
});

describe('getEntryMeta (no heavy columns)', () => {
  it('never selects content_html, content_ast or notes_html', async () => {
    mockNextRow = { slug: 'aristotle', title: 'Aristotle' };
    await getEntryMeta('aristotle');
    const cols = selectedColumns(mockSqlLog[0]);
    for (const h of HEAVY) expect(cols).not.toContain(h);
    expect(cols).toEqual(expect.arrayContaining(['slug', 'title', 'toc_html', 'preamble_html', 'content_hash']));
  });

  it('returns null for an unknown slug', async () => {
    expect(await getEntryMeta('nope')).toBeNull();
  });
});

describe('getEntryHtml (body only)', () => {
  it('selects only content_html', async () => {
    mockNextRow = { content_html: '<p>body</p>' };
    expect(await getEntryHtml('aristotle')).toBe('<p>body</p>');
    expect(selectedColumns(mockSqlLog[0])).toEqual(['content_html']);
  });

  it('returns null when the row is missing', async () => {
    expect(await getEntryHtml('nope')).toBeNull();
  });

  it('returns null when the article is indexed but not cached (NULL body)', async () => {
    mockNextRow = { content_html: null };
    expect(await getEntryHtml('aristotle')).toBeNull();
  });

  it('treats an empty body as not cached', async () => {
    mockNextRow = { content_html: '' };
    expect(await getEntryHtml('aristotle')).toBeNull();
  });
});
