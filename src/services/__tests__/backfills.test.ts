// The AST backfill and ensureNotesCached as seen through the composition root's exports. Written BEFORE
// they moved into src/core and kept unchanged afterwards apart from the import path. (The one-shot
// backfillMathInline that used to be tested here was removed upstream.)
const mockMeta: Record<string, string> = {};
const mockEntries: Record<string, string> = {};
let mockUncachedAst: string[] = [];

jest.mock('../db', () => ({
  getMeta: jest.fn(async (k: string) => mockMeta[k] ?? null),
  setMeta: jest.fn(async (k: string, v: string) => { mockMeta[k] = v; }),
  getUncachedAstSlugs: jest.fn(async () => mockUncachedAst),
  getEntryHtml: jest.fn(async (slug: string) => mockEntries[slug] ?? null),
  updateArticleHtml: jest.fn(async (slug: string, html: string) => { mockEntries[slug] = html; }),
  setArticleAst: jest.fn(async () => {}),
  putMathBatch: jest.fn(async () => {}),
  putMath: jest.fn(async () => {}),
  getMathByHashes: jest.fn(async () => []),
  getMathSvgMap: jest.fn(async () => ({})),
  cacheArticle: jest.fn(), indexLinks: jest.fn(), upsertIndexEntries: jest.fn(), getEntryCount: jest.fn(),
  getSlugsByCacheStatus: jest.fn(), getCachedSlugs: jest.fn(), getAllEntryTitles: jest.fn(), invalidateLinkCache: jest.fn(),
  cleanDenormalizedTitles: jest.fn(), getEntry: jest.fn(), setEntryNotes: jest.fn(async () => {}),
}));
const mockRender = jest.fn();
jest.mock('../mathRender', () => ({ renderMathBatch: (...a: unknown[]) => mockRender(...a) }));

import * as db from '../db';
import { _resetMathCacheState } from '../../composition';   // the math runtime is built in the root
import { backfillAst, ensureNotesCached } from '../../composition';   // wired in the composition root
import { parseSepHtml } from '../../utils/sepHtml/parse';

const m = db as jest.Mocked<typeof db>;
const okRender = async (items: Array<{ tex: string; display: boolean }>) =>
  items.map(it => ({ ...it, b64: btoa('<svg/>'), w: 2, h: 1 }));

beforeEach(() => {
  _resetMathCacheState();
  jest.clearAllMocks();
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  for (const k of Object.keys(mockEntries)) delete mockEntries[k];
  mockUncachedAst = [];
  mockRender.mockImplementation(okRender);
  m.setArticleAst.mockImplementation(async () => {});
});

describe('backfillAst', () => {
  test('visits articles in order, writing each one the AST of its stored body', async () => {
    mockUncachedAst = ['a', 'b', 'c'];
    mockEntries.a = '<p>one</p>'; mockEntries.b = '<p>two</p>'; mockEntries.c = '<p>three</p>';
    await backfillAst();
    expect(m.setArticleAst.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'c']);
    expect(m.setArticleAst).toHaveBeenCalledWith('b', JSON.stringify(parseSepHtml('<p>two</p>')));
  });

  test('a failure on one article does not stop the rest', async () => {
    mockUncachedAst = ['a', 'b'];
    mockEntries.a = '<p>one</p>'; mockEntries.b = '<p>two</p>';
    m.setArticleAst.mockRejectedValueOnce(new Error('disk'));
    await backfillAst();
    expect(m.setArticleAst.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
  });

  test('nothing to do is fine, and a failure reading the work list rejects', async () => {
    await expect(backfillAst()).resolves.toBeUndefined();
    m.getUncachedAstSlugs.mockRejectedValueOnce(new Error('db'));
    await expect(backfillAst()).rejects.toThrow('db');
  });
});

describe('ensureNotesCached (UC-C4)', () => {
  const NOTE_BODY = '<p>Claim<a href="notes.html#note-1">[1]</a>.</p>';
  const notesPage = (body: string, ok = true) => ({ ok, status: ok ? 200 : 404, text: async () => body });
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); (globalThis as any).fetch = fetchMock; });

  test('no body, or a body with no footnote reference: null and no request', async () => {
    expect(await ensureNotesCached('a', null)).toBeNull();
    expect(await ensureNotesCached('a', '')).toBeNull();
    expect(await ensureNotesCached('a', '<p>plain</p>')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fetches the notes page, stores the notes and returns them', async () => {
    fetchMock.mockResolvedValue(notesPage('<div id="aueditable"><ol><li>n</li></ol></div>'));
    expect(await ensureNotesCached('free-will', NOTE_BODY)).toBe('<ol><li>n</li></ol>');
    expect(fetchMock.mock.calls[0][0]).toBe('https://plato.stanford.edu/entries/free-will/notes.html');
    expect(m.setEntryNotes).toHaveBeenCalledWith('free-will', '<ol><li>n</li></ol>');
  });

  test('the reference check is case-insensitive', async () => {
    fetchMock.mockResolvedValue(notesPage('<div id="aueditable"><p>n</p></div>'));
    expect(await ensureNotesCached('a', '<a href="NOTES.html#NOTE-2">2</a>')).toBe('<p>n</p>');
  });

  test('notes that cannot be had: null, nothing stored, no exception', async () => {
    fetchMock.mockResolvedValue(notesPage('x', false));
    expect(await ensureNotesCached('a', NOTE_BODY)).toBeNull();
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await ensureNotesCached('a', NOTE_BODY)).toBeNull();
    fetchMock.mockResolvedValue(notesPage('<p>nothing usable</p>'));
    expect(await ensureNotesCached('a', NOTE_BODY)).toBeNull();
    expect(m.setEntryNotes).not.toHaveBeenCalled();
  });

  test('a failure storing the notes rejects (the caller sees it)', async () => {
    fetchMock.mockResolvedValue(notesPage('<div id="aueditable"><p>n</p></div>'));
    m.setEntryNotes.mockRejectedValueOnce(new Error('disk'));
    await expect(ensureNotesCached('a', NOTE_BODY)).rejects.toThrow('disk');
  });
});
