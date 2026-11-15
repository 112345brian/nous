import { buildTree, groupSessions, sessionIdFor, SESSION_GAP_MS } from '../readSessions';
import { scopeFilter, countWords } from '../libraryScope';
import { resolveEntryHash, contentHash } from '../contentHash';

const r = (id: number, slug: string, at: number, from: string | null, session = 's') =>
  ({ id, slug, title: slug, visited_at: at, from_slug: from, session_id: session });

describe('sessionIdFor', () => {
  it('reuses the last session inside the gap and starts a new one at/after it', () => {
    const last = { visited_at: 1000, session_id: 'old' };
    expect(sessionIdFor(last, 1000 + SESSION_GAP_MS - 1)).toBe('old');
    expect(sessionIdFor(last, 1000 + SESSION_GAP_MS)).toBe(String(1000 + SESSION_GAP_MS));
    expect(sessionIdFor(null, 77)).toBe('77');
  });
});
describe('buildTree / groupSessions', () => {
  it('wires parents, computes depth, orphans become roots', () => {
    const roots = buildTree([r(1, 'a', 1, null), r(2, 'b', 2, 'a'), r(3, 'c', 3, 'b'), r(4, 'x', 4, 'missing')]);
    expect(roots.map(n => [n.slug, n.depth])).toEqual([['a', 0], ['x', 0]]);
    expect(roots[0].children[0].children[0]).toMatchObject({ slug: 'c', depth: 2 });
  });
  it('groups by session and returns the newest first', () => {
    const out = groupSessions([r(1, 'a', 1, null, 'one'), r(2, 'b', 5, null, 'two'), r(3, 'c', 6, 'b', 'two')]);
    expect(out.map(s => [s.session_id, s.started_at, s.total])).toEqual([['two', 5, 2], ['one', 1, 1]]);
  });
});
describe('scopeFilter / countWords / resolveEntryHash', () => {
  it('binds the scope as a parameter', () => {
    expect(scopeFilter('all')).toEqual({ where: '', params: [] });
    expect(scopeFilter('x; DROP' as any)).toEqual({ where: 'WHERE source = ?', params: ['x; DROP'] });
  });
  it('counts words ignoring tags', () => {
    expect(countWords('<p>a  b</p><br/> c')).toBe(3);
    expect(countWords('')).toBe(0);
  });
  it('prefers the stored hash, else rehashes', () => {
    expect(resolveEntryHash({ content_hash: 'h', content_html: 'x' })).toBe('h');
    expect(resolveEntryHash({ content_hash: '', content_html: 'x' })).toBe(contentHash('x'));
    expect(resolveEntryHash({ content_hash: null, content_html: null })).toBe(contentHash(''));
  });
});
