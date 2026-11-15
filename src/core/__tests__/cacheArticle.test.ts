// The article-caching use case run with plain in-memory fakes: no jest.mock, no fetch, no SQLite,
// no renderer. Date.now and fetch throw, to prove the core never reaches for them.
import { fetchAndCacheArticle, type CacheArticleDeps } from '../cacheArticle';
import type { CachedArticleFields } from '../ports';

const PAGE = (body: string, extra = '') => `<html><head>
<meta property="citation_author" content="Doe, Jane">
<meta property="citation_publication_date" content="2020/05/01">
</head><body>${extra}<div id="aueditable"><h1>T</h1>${body}</div></body></html>`;

function world(o: {
  page?: string | null | Error;
  notes?: string | null;
  cacheFails?: boolean;
  substituteFails?: boolean;
  indexFails?: boolean;
} = {}) {
  const log: string[] = [];
  const cached: Array<{ slug: string; data: CachedArticleFields }> = [];
  const indexed: Array<[string, string]> = [];
  const deferred: Array<[string, string]> = [];
  const deferredPriorities: unknown[] = [];
  const queued: string[] = [];
  const stages: string[] = [];
  const deps: CacheArticleDeps = {
    source: {
      fetchArticleHtml: async slug => {
        log.push(`fetch:${slug}`);
        if (o.page instanceof Error) throw o.page;
        return o.page === undefined ? PAGE('<p>Plain text.</p>') : o.page;
      },
      fetchNotesHtml: async slug => { log.push(`notes:${slug}`); return o.notes ?? null; },
    },
    library: {
      cacheArticle: async (slug, data) => {
        log.push('cache');
        if (o.cacheFails) throw new Error('disk');
        cached.push({ slug, data });
      },
      indexLinks: async (slug, html) => { log.push('index'); indexed.push([slug, html]); if (o.indexFails) throw new Error('db'); },
    },
    math: {
      substitute: async html => { log.push('substitute'); if (o.substituteFails) throw new Error('renderer'); return html.replace(/\\\(.*?\\\)/g, '<math-i hash="h"></math-i>'); },
      completeLater: (slug, html, priority) => { log.push('completeLater'); deferred.push([slug, html]); deferredPriorities.push(priority); },
      queueForLater: async slug => { log.push('queue'); queued.push(slug); },
    },
    timing: {
      time: async (_k, stage, fn) => { stages.push(stage); return fn(); },
      timeSync: (_k, stage, fn) => { stages.push(stage); return fn(); },
    },
    linkify: html => html.replace('Plain', '[Plain]'),
  };
  return { deps, log, cached, indexed, deferred, deferredPriorities, queued, stages };
}

describe('fetchAndCacheArticle with fakes', () => {
  const realFetch = (globalThis as any).fetch;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
    (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
  });
  afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

  test('caches the processed article using the injected linkifier', async () => {
    const w = world();
    expect(await fetchAndCacheArticle(w.deps, 'logic')).toBe(true);
    expect(w.cached).toHaveLength(1);
    const { slug, data } = w.cached[0];
    expect(slug).toBe('logic');
    expect(data.content_html).toBe('<p>[Plain] text.</p>');
    expect(data).toMatchObject({ author: 'Doe, Jane', pub_date: '2020/05/01', has_math: 0, notes_html: null, toc_html: null, preamble_html: null });
    expect(JSON.parse(data.content_ast!)).toBeTruthy();
    expect(w.indexed).toEqual([['logic', '<p>Plain text.</p>']]);   // indexed from the unlinked text
  });

  describe('math modes', () => {
    const TEX = PAGE('<p>Let \\(x\\) be a set.</p>');
    test('default: cached with raw TeX first, then rendering is scheduled; nothing waits for it', async () => {
      const w = world({ page: TEX });
      expect(await fetchAndCacheArticle(w.deps, 'a')).toBe(true);
      expect(w.log).toEqual(['fetch:a', 'cache', 'index', 'completeLater']);
      expect(w.cached[0].data.content_html).toContain('\\(x\\)');
      expect(w.cached[0].data.has_math).toBe(1);
      expect(w.deferred).toEqual([['a', w.cached[0].data.content_html]]);
    });
    test('awaitMath: equations are substituted before caching and nothing is deferred', async () => {
      const w = world({ page: TEX });
      await fetchAndCacheArticle(w.deps, 'a', { awaitMath: true });
      expect(w.log).toEqual(['fetch:a', 'substitute', 'cache', 'index']);
      expect(w.cached[0].data.content_html).toContain('<math-i');
      expect(w.deferred).toEqual([]);
    });
    test('awaitMath renders with no priority (the caller owns the schedule); the deferred path does not render here', async () => {
      const w = world({ page: TEX });
      const seen: unknown[] = [];
      const inner = w.deps.math.substitute;
      w.deps.math.substitute = async (html, priority) => { seen.push(priority); return inner(html, priority); };
      await fetchAndCacheArticle(w.deps, 'a', { awaitMath: true });
      await fetchAndCacheArticle(w.deps, 'b');
      expect(seen).toEqual([null]);
    });
    test('skipMath: raw TeX, no rendering started; the article is queued for the resume pass', async () => {
      const w = world({ page: TEX });
      await fetchAndCacheArticle(w.deps, 'a', { skipMath: true });
      expect(w.log).toEqual(['fetch:a', 'cache', 'index', 'queue']);
      expect(w.cached[0].data.content_html).toContain('\\(x\\)');
      expect(w.queued).toEqual(['a']);
      expect(w.deferred).toEqual([]);
    });
    test('the deferred render runs at the priority asked for, current by default', async () => {
      const w = world({ page: TEX });
      await fetchAndCacheArticle(w.deps, 'a');
      await fetchAndCacheArticle(w.deps, 'b', { deferPriority: 'background' });
      expect(w.deferredPriorities).toEqual(['current', 'background']);
    });
    test('the queue happens only for articles that have TeX and were skipped', async () => {
      const plain = world();
      await fetchAndCacheArticle(plain.deps, 'a', { skipMath: true });
      expect(plain.queued).toEqual([]);
      const tex = world({ page: TEX });
      await fetchAndCacheArticle(tex.deps, 'a', { awaitMath: true });
      expect(tex.queued).toEqual([]);
    });
    test('a failure recording the queue fails the call (the debt is part of caching it)', async () => {
      const w = world({ page: TEX });
      w.deps.math.queueForLater = async () => { throw new Error('db'); };
      expect(await fetchAndCacheArticle(w.deps, 'a', { skipMath: true })).toBe(false);
    });
    test('skipMath wins over awaitMath', async () => {
      const w = world({ page: TEX });
      await fetchAndCacheArticle(w.deps, 'a', { skipMath: true, awaitMath: true });
      expect(w.log).not.toContain('substitute');
    });
    test('an article without TeX never touches the math port', async () => {
      const w = world();
      await fetchAndCacheArticle(w.deps, 'a');
      await fetchAndCacheArticle(w.deps, 'b', { awaitMath: true });
      expect(w.log.filter(l => l === 'substitute' || l === 'completeLater')).toEqual([]);
    });
    test('a renderer failure under awaitMath fails the whole call and caches nothing', async () => {
      const w = world({ page: TEX, substituteFails: true });
      expect(await fetchAndCacheArticle(w.deps, 'a', { awaitMath: true })).toBe(false);
      expect(w.cached).toEqual([]);
      expect(w.indexed).toEqual([]);
    });
  });

  describe('footnotes', () => {
    const NOTED = PAGE('<p>Claim<a href="notes.html#note-1">[1]</a>.</p>');
    test('the notes port is called only when the body references notes, and its text is stored', async () => {
      const w = world({ page: NOTED, notes: '<ol><li>n</li></ol>' });
      await fetchAndCacheArticle(w.deps, 'a');
      expect(w.log).toContain('notes:a');
      expect(w.cached[0].data.notes_html).toBe('<ol><li>n</li></ol>');
      const plain = world();
      await fetchAndCacheArticle(plain.deps, 'a');
      expect(plain.log.some(l => l.startsWith('notes:'))).toBe(false);
    });
    test('notes that cannot be had do not fail the article', async () => {
      const w = world({ page: NOTED, notes: null });
      expect(await fetchAndCacheArticle(w.deps, 'a')).toBe(true);
      expect(w.cached[0].data.notes_html).toBeNull();
    });
    test('the check runs on the HTML after math substitution', async () => {
      const w = world({ page: PAGE('<p>Let \\(x\\).</p>') });
      w.deps.math.substitute = async html => html + '<a href="notes.html#note-9">x</a>';
      await fetchAndCacheArticle(w.deps, 'a', { awaitMath: true });
      expect(w.log).toContain('notes:a');
    });
  });

  describe('failure returns false and leaves nothing behind', () => {
    test.each([
      ['the site returns an error status', { page: null }],
      ['the network fails', { page: new Error('offline') }],
      ['the page has no article body', { page: '<html><body>maintenance</body></html>' }],
      ['the cache write fails', { cacheFails: true }],
    ] as Array<[string, Parameters<typeof world>[0]]>)('%s', async (_n, opts) => {
      const w = world(opts);
      expect(await fetchAndCacheArticle(w.deps, 'a')).toBe(false);
      expect(w.cached).toEqual([]);
      expect(w.indexed).toEqual([]);
      expect(w.deferred).toEqual([]);
    });
    test('a failing link index does not fail the article', async () => {
      const w = world({ indexFails: true });
      expect(await fetchAndCacheArticle(w.deps, 'a')).toBe(true);
    });
  });

  test('the injected timer sees each stage in order', async () => {
    const w = world({ page: PAGE('<p>Let \\(x\\)<a href="notes.html#note-1">1</a></p>') });
    await fetchAndCacheArticle(w.deps, 'a', { awaitMath: true });
    expect(w.stages).toEqual(['extract', 'linkify', 'math', 'notes', 'parse+stringify', 'cache-write']);
  });
});
