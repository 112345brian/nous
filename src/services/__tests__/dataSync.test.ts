// Behaviour of services/dataSync.ts as seen by its callers (SettingsScreen, ReadingListScreen).
// Written BEFORE the logic moved into src/core, and kept unchanged afterwards: these tests
// are what proves the extraction preserved behaviour. File system, fetch and db are fakes.
import { exportToSyncFolder, importFromSyncFolder, exportToZotero } from '../../composition';
import * as dbModule from '../db';
import type { Db } from '../db';
const db = dbModule as unknown as jest.Mocked<Db>;
import type { Annotation } from '../../types';

// ── in-memory file system standing in for expo-file-system ───────────────────
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockOps: string[] = [];
let mockFailCopy = false;

jest.mock('expo-file-system', () => {
  // One argument is a URI used as-is; several are joined with exactly one slash.
  const join = (...p: any[]) => {
    const parts = p.map(x => (typeof x === 'string' ? x : x.uri));
    return parts.length === 1
      ? parts[0]
      : parts.map((x, i) => (i === 0 ? x.replace(/\/+$/, '') : x.replace(/^\/+|\/+$/g, ''))).join('/');
  };
  class File {
    uri: string;
    constructor(...p: any[]) { this.uri = join(...p); }
    get exists() { return mockFiles.has(this.uri); }
    write(t: string) { mockOps.push(`write ${this.uri}`); mockFiles.set(this.uri, t); }
    copy(dest: File) {
      if (mockFailCopy) throw new Error('disk full');
      mockOps.push(`copy ${this.uri} -> ${dest.uri}`);
      mockFiles.set(dest.uri, mockFiles.get(this.uri) as string);
    }
    delete() { mockOps.push(`delete ${this.uri}`); mockFiles.delete(this.uri); }
    async text() { return mockFiles.get(this.uri) as string; }
  }
  class Directory {
    uri: string;
    constructor(...p: any[]) { this.uri = join(...p); }
    get exists() { return mockDirs.has(this.uri); }
    create() { mockOps.push(`mkdir ${this.uri}`); mockDirs.add(this.uri); }
  }
  return { File, Directory, Paths: { cache: 'file:///cache/' } };
});

jest.mock('../db', () => require('./helpers/mockDbModule').asDbModule({
  getSyncFolder: jest.fn(),
  exportUserData: jest.fn(),
  importUserData: jest.fn(),
  getArticleVersionDate: jest.fn(),
}));

const m = db as jest.Mocked<typeof db>;
const DEST = 'file:///Users/me/notes/sep_user.json';
const DATA = { version: 1, exported_at: 5, reads: [], bookmarks: [], annotations: [], prefs: { a: 'b' } } as any;

beforeEach(() => {
  mockFiles.clear(); mockDirs.clear(); mockOps.length = 0; mockFailCopy = false;
  jest.resetAllMocks();
  m.exportUserData.mockResolvedValue(DATA);
});

describe('exportToSyncFolder', () => {
  test('blank folder -> no_folder, nothing written', async () => {
    m.getSyncFolder.mockResolvedValue('   ' as any);
    expect(await exportToSyncFolder()).toBe('no_folder');
    expect(mockOps).toEqual([]);
    expect(m.exportUserData).not.toHaveBeenCalled();
  });

  test('writes pretty JSON to <folder>/sep_user.json via a temp file, creating the folder', async () => {
    m.getSyncFolder.mockResolvedValue('/Users/me/notes' as any);
    expect(await exportToSyncFolder()).toBe('ok');
    expect(mockFiles.get(DEST)).toBe(JSON.stringify(DATA, null, 2));
    expect(mockOps).toEqual([
      'mkdir file:///Users/me/notes/',
      'write file:///cache/sep_user_tmp.json',
      `copy file:///cache/sep_user_tmp.json -> ${DEST}`,
      'delete file:///cache/sep_user_tmp.json',
    ]);
  });

  test('does not recreate an existing folder; accepts file:// URIs and trailing slashes', async () => {
    mockDirs.add('file:///Users/me/notes/');
    m.getSyncFolder.mockResolvedValue('file:///Users/me/notes/' as any);
    expect(await exportToSyncFolder()).toBe('ok');
    expect(mockOps.some(o => o.startsWith('mkdir'))).toBe(false);
    expect(mockFiles.has(DEST)).toBe(true);
  });

  test('expands ~ using $HOME on ios/macos', async () => {
    const prev = process.env.HOME;
    process.env.HOME = '/home/tester';
    m.getSyncFolder.mockResolvedValue('~/Sync' as any);
    expect(await exportToSyncFolder()).toBe('ok');
    expect(mockFiles.has('file:///home/tester/Sync/sep_user.json')).toBe(true);
    process.env.HOME = prev;
  });

  test('failure reading the data or writing the file -> error', async () => {
    m.getSyncFolder.mockResolvedValue('/Users/me/notes' as any);
    m.exportUserData.mockRejectedValue(new Error('db'));
    expect(await exportToSyncFolder()).toBe('error');
    m.exportUserData.mockResolvedValue(DATA);
    mockFailCopy = true;
    expect(await exportToSyncFolder()).toBe('error');
  });
});

describe('importFromSyncFolder', () => {
  beforeEach(() => m.getSyncFolder.mockResolvedValue('/Users/me/notes' as any));

  test('blank folder -> no_folder; missing file -> not_found', async () => {
    m.getSyncFolder.mockResolvedValue('' as any);
    expect(await importFromSyncFolder()).toBe('no_folder');
    m.getSyncFolder.mockResolvedValue('/Users/me/notes' as any);
    expect(await importFromSyncFolder()).toBe('not_found');
    expect(m.importUserData).not.toHaveBeenCalled();
  });

  test('valid version-1 file is parsed and imported', async () => {
    mockFiles.set(DEST, JSON.stringify(DATA));
    expect(await importFromSyncFolder()).toBe('ok');
    expect(m.importUserData).toHaveBeenCalledWith(DATA);
  });

  test('wrong version, null, bad JSON, or an import failure -> error, never partial', async () => {
    mockFiles.set(DEST, JSON.stringify({ ...DATA, version: 2 }));
    expect(await importFromSyncFolder()).toBe('error');
    mockFiles.set(DEST, 'null');
    expect(await importFromSyncFolder()).toBe('error');
    mockFiles.set(DEST, '{nope');
    expect(await importFromSyncFolder()).toBe('error');
    expect(m.importUserData).not.toHaveBeenCalled();
    mockFiles.set(DEST, JSON.stringify(DATA));
    m.importUserData.mockRejectedValue(new Error('constraint'));
    expect(await importFromSyncFolder()).toBe('error');
  });
});

// ── Zotero ───────────────────────────────────────────────────────────────────
const ITEM = { slug: 'free-will', title: 'Free Will', author: 'O’Connor, Timothy', pub_date: '2002/10/29' };
const ann = (over: Partial<Annotation>): Annotation => ({
  id: 1, slug: 'free-will', selected_text: 'a "quoted" <b>', context: null, note: null,
  color: '#ffcc00', content_hash: null, created_at: 1, updated_at: 1, ...over,
});
const res = (status: number, body: any = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

describe('exportToZotero', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-04T10:00:00Z'));
    fetchMock = jest.fn();
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => jest.useRealTimers());

  const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);

  test('no annotations: posts one encyclopediaArticle with today as the access date', async () => {
    fetchMock.mockResolvedValue(res(200, { successful: { '0': { key: 'K' } } }));
    expect(await exportToZotero('KEY', '42', ITEM)).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.zotero.org/users/42/items');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Zotero-API-Key': 'KEY', 'Zotero-API-Version': '3', 'Content-Type': 'application/json' });
    expect(bodyOf(0)).toEqual([{
      itemType: 'encyclopediaArticle', title: 'Free Will',
      encyclopediaTitle: 'Stanford Encyclopedia of Philosophy',
      creators: [
        { creatorType: 'author', lastName: 'O’Connor', firstName: 'Timothy' },
        { creatorType: 'editor', lastName: 'Zalta', firstName: 'Edward N.' },
        { creatorType: 'editor', lastName: 'Nodelman', firstName: 'Uri' },
      ],
      url: 'https://plato.stanford.edu/entries/free-will/',
      accessDate: '2026-03-04', date: '2002-10-29', language: 'en', extra: 'Accessed: 2026-03-04',
    }]);
  });

  test('author shapes: single name, none; missing pub_date', async () => {
    fetchMock.mockResolvedValue(res(200));
    await exportToZotero('K', '1', { ...ITEM, author: 'Plato', pub_date: null });
    expect(bodyOf(0)[0].creators[0]).toEqual({ creatorType: 'author', name: 'Plato' });
    expect(bodyOf(0)[0].date).toBe('');
    fetchMock.mockClear();
    await exportToZotero('K', '1', { ...ITEM, author: null });
    expect(bodyOf(0)[0].creators.map((c: any) => c.creatorType)).toEqual(['editor', 'editor']);
  });

  test('one item per article version; access date comes from the version timestamp', async () => {
    m.getArticleVersionDate.mockImplementation(async (_s, h) => (h === 'h1' ? Date.parse('2025-01-02T00:00:00Z') : null));
    fetchMock.mockResolvedValue(res(200, { successful: { '0': { key: 'PARENT' } } }));
    const anns = [ann({ id: 1, content_hash: 'h1', note: 'n <1>' }), ann({ id: 2, content_hash: null })];
    expect(await exportToZotero('K', '1', ITEM, anns)).toBe('ok');
    expect(m.getArticleVersionDate).toHaveBeenCalledTimes(1);
    expect(m.getArticleVersionDate).toHaveBeenCalledWith('free-will', 'h1');
    // order: version h1 (item, note) then current (item, note)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(bodyOf(0)[0].accessDate).toBe('2025-01-02');
    expect(bodyOf(0)[0].extra).toBe('Version: h1\nAccessed: 2025-01-02');
    expect(bodyOf(1)).toEqual([{ itemType: 'note', parentItem: 'PARENT', note: expect.any(String) }]);
    const note = bodyOf(1)[0].note as string;
    expect(note).toContain('<h3>Highlights: Free Will</h3>');
    expect(note).toContain('Version accessed 2025-01-02');
    expect(note).toContain('"a &quot;quoted&quot; &lt;b&gt;"');
    expect(note).toContain('n &lt;1&gt;');
    expect(note).toContain('background:#ffcc0044;border-left:3px solid #ffcc00;');
    expect(bodyOf(2)[0].accessDate).toBe('2026-03-04');
    expect(bodyOf(2)[0].extra).toBe('Accessed: 2026-03-04');
  });

  test('no note is posted when Zotero returns no parent key', async () => {
    fetchMock.mockResolvedValue(res(200, { successful: {} }));
    expect(await exportToZotero('K', '1', ITEM, [ann({})])).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('401/403 -> auth_error, other non-2xx -> error, and it stops at the first failure', async () => {
    const two = [ann({ content_hash: 'a' }), ann({ id: 2, content_hash: 'b' })];
    fetchMock.mockResolvedValue(res(401));
    expect(await exportToZotero('K', '1', ITEM, two)).toBe('auth_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset().mockResolvedValue(res(403));
    expect(await exportToZotero('K', '1', ITEM)).toBe('auth_error');
    fetchMock.mockReset().mockResolvedValue(res(500));
    expect(await exportToZotero('K', '1', ITEM)).toBe('error');
  });

  test('network failure, on the item or the note, -> error', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await exportToZotero('K', '1', ITEM)).toBe('error');
    fetchMock.mockReset()
      .mockResolvedValueOnce(res(200, { successful: { '0': { key: 'P' } } }))
      .mockRejectedValueOnce(new Error('offline'));
    expect(await exportToZotero('K', '1', ITEM, [ann({})])).toBe('error');
  });
});
