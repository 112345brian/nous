import { exportBookmarkToZotero, type ZoteroDeps } from '../zotero';
import type { ZoteroHttpResponse } from '../ports';
import type { Annotation } from '../../types';

const ITEM = { slug: 'ethics', title: 'Ethics', author: 'Doe, Jane', pub_date: '2020/05/01' };
const ann = (o: Partial<Annotation> = {}): Annotation => ({
  id: 1, slug: 'ethics', selected_text: 'x', context: null, note: null, color: '#fff',
  content_hash: null, created_at: 0, updated_at: 0, ...o,
});
const resp = (status: number, body: any = {}): ZoteroHttpResponse =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body });

function setup(responses: Array<ZoteroHttpResponse | Error>, versions: Record<string, number> = {}) {
  const posts: Array<{ path: string; body: any }> = [];
  const queue = [...responses];
  const deps: ZoteroDeps = {
    http: { post: async (path, body) => {
      posts.push({ path, body });
      const next = queue.shift() ?? resp(200);
      if (next instanceof Error) throw next;
      return next;
    } },
    versionDate: async (_slug, hash) => versions[hash] ?? null,
    clock: { now: () => Date.UTC(2031, 0, 15, 12) },
  };
  return { posts, deps };
}

describe('exportBookmarkToZotero with fakes', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
    (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
  });
  afterEach(() => jest.restoreAllMocks());

  test('the access date is whatever the injected clock says', async () => {
    const { deps, posts } = setup([resp(200)]);
    expect(await exportBookmarkToZotero(deps, ITEM)).toBe('ok');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('/items');
    expect(posts[0].body[0].accessDate).toBe('2031-01-15');
  });

  test('versions use the injected lookup; unknown versions fall back to the clock', async () => {
    const { deps, posts } = setup([resp(200), resp(200)], { v1: Date.UTC(2019, 6, 4) });
    await exportBookmarkToZotero(deps, ITEM, [ann({ content_hash: 'v1' }), ann({ id: 2, content_hash: 'v2' })]);
    expect(posts.map(p => p.body[0].accessDate)).toEqual(['2019-07-04', '2031-01-15']);
    expect(posts.map(p => p.body[0].extra)).toEqual(['Version: v1\nAccessed: 2019-07-04', 'Version: v2\nAccessed: 2031-01-15']);
  });

  test('a note is attached to the parent key Zotero returns', async () => {
    const { deps, posts } = setup([resp(200, { successful: { '0': { key: 'PK' } } }), resp(200)]);
    await exportBookmarkToZotero(deps, ITEM, [ann({ selected_text: '<script>', note: 'a&b' })]);
    expect(posts).toHaveLength(2);
    expect(posts[1].body[0]).toMatchObject({ itemType: 'note', parentItem: 'PK' });
    expect(posts[1].body[0].note).toContain('&lt;script&gt;');
    expect(posts[1].body[0].note).toContain('a&amp;b');
  });

  test('error mapping and early stop', async () => {
    const two = [ann({ content_hash: 'a' }), ann({ id: 2, content_hash: 'b' })];
    const unauth = setup([resp(401)]);
    expect(await exportBookmarkToZotero(unauth.deps, ITEM, two)).toBe('auth_error');
    expect(unauth.posts).toHaveLength(1);
    expect(await exportBookmarkToZotero(setup([resp(503)]).deps, ITEM)).toBe('error');
    expect(await exportBookmarkToZotero(setup([new Error('offline')]).deps, ITEM)).toBe('error');
  });
});
