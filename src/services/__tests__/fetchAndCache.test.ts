// Behaviour of catalog.fetchAndCacheArticle for everything except the math modes (those are
// pinned in deferredMath.test.ts). Written BEFORE the logic moved into src/core and kept
// unchanged afterwards. db, the renderer and fetch are fakes.
import { fetchAndCacheArticle } from '../../composition';   // wired in the composition root
import * as db from '../db';
import { _resetMathCacheState } from '../../composition';   // the math runtime is built in the root
import { parseSepHtml } from '../../utils/sepHtml/parse';

jest.mock('../db', () => ({
  cacheArticle: jest.fn(async () => {}),
  indexLinks: jest.fn(async () => {}),
  getMeta: jest.fn(async () => null),
  setMeta: jest.fn(async () => {}),
  putMathBatch: jest.fn(async () => {}),
  getMathByHashes: jest.fn(async () => []),
  getEntryHtml: jest.fn(async () => null),
  updateArticleHtml: jest.fn(async () => {}),
  setArticleAst: jest.fn(async () => {}),
}));
jest.mock('../../core/mathBridge', () => ({ createMathBridge: () => require('./fakeMathBridge').fakeMathBridge(jest.fn(async () => [])) }));

// Records the dev-only timing stages in the order they run.
const mockStages: string[] = [];
jest.mock('../perf', () => ({
  perf: {
    enabled: true,
    begin: () => {}, end: () => {}, mark: () => {},
    time: async (_k: string, stage: string, fn: () => Promise<unknown>) => { mockStages.push(stage); return fn(); },
    timeSync: (_k: string, stage: string, fn: () => unknown) => { mockStages.push(stage); return fn(); },
  },
}));

const m = db as jest.Mocked<typeof db>;
const page = (body: string, ok = true, status = 200) => ({ ok, status, text: async () => body });

const ARTICLE = `<html><head>
<title>Free Will (Stanford Encyclopedia of Philosophy)</title>
<meta property="citation_author" content="O&#39;Connor, Timothy">
<meta property="citation_publication_date" content="2002/10/29">
</head><body>
<div id="toc"><ul><li><a href="#a">A</a></li></ul></div>
<div id="preamble"><p>Preamble text.</p></div>
<div id="aueditable"><!-- c --><h1>Free Will</h1><p>The problem of free will is old.</p></div>
</body></html>`;
const CONTENT = '<p>The problem of free will is old.</p>';

let fetchMock: jest.Mock;
beforeEach(() => {
  _resetMathCacheState();
  jest.clearAllMocks();
  // clearAllMocks keeps implementations, so a rejection set in one test would leak into the next.
  m.cacheArticle.mockImplementation(async () => {});
  m.indexLinks.mockImplementation(async () => {});
  mockStages.length = 0;
  fetchMock = jest.fn(async () => page(ARTICLE));
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => jest.useRealTimers());

const cached = () => m.cacheArticle.mock.calls[0][1] as any;

describe('the request', () => {
  test('GETs the entry page with browser-like headers and an abort signal', async () => {
    await fetchAndCacheArticle('free-will');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://plato.stanford.edu/entries/free-will/');
    expect(init.headers['User-Agent']).toMatch(/Mozilla/);
    expect(init.headers.Accept).toMatch(/text\/html/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('gives up after 30 seconds by aborting the request', async () => {
    jest.useFakeTimers();
    let signal!: AbortSignal;
    fetchMock.mockImplementation((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
      signal = init.signal;
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    const p = fetchAndCacheArticle('free-will');
    await jest.advanceTimersByTimeAsync(29_999);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(p).resolves.toBe(false);
    expect(m.cacheArticle).not.toHaveBeenCalled();
  });

  test('the timeout timer is cleared once the response arrives', async () => {
    jest.useFakeTimers();
    await fetchAndCacheArticle('free-will');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('failure returns false and caches nothing', () => {
  test.each([
    ['HTTP error', () => fetchMock.mockResolvedValue(page('x', false, 503))],
    ['network error', () => fetchMock.mockRejectedValue(new Error('offline'))],
    ['a page without article content', () => fetchMock.mockResolvedValue(page('<html><body>maintenance</body></html>'))],
    ['a failing cache write', () => m.cacheArticle.mockRejectedValue(new Error('disk'))],
  ])('%s', async (_n, arrange) => {
    arrange();
    expect(await fetchAndCacheArticle('free-will')).toBe(false);
    if (_n !== 'a failing cache write') expect(m.cacheArticle).not.toHaveBeenCalled();
    expect(m.indexLinks).not.toHaveBeenCalled();
  });
});

describe('what is cached', () => {
  test('metadata, toc, preamble, header-stripped and linked content, AST', async () => {
    expect(await fetchAndCacheArticle('free-will')).toBe(true);
    const c = cached();
    expect(m.cacheArticle.mock.calls[0][0]).toBe('free-will');
    expect(c.author).toBe("O'Connor, Timothy");
    expect(c.pub_date).toBe('2002/10/29');
    expect(c.toc_html).toBe('<ul><li><a href="#a">A</a></li></ul>');
    expect(c.preamble_html).toBe('<p>Preamble text.</p>');
    expect(c.content_html).not.toContain('<h1');
    expect(c.content_html).not.toContain('<!--');
    expect(c.content_html).toContain('class="wl"');           // linkified against the real index
    expect(c.content_html.replace(/<a [^>]*class="wl">([^<]*)<\/a>/g, '$1')).toBe(CONTENT);
    expect(c.content_ast).toBe(JSON.stringify(parseSepHtml(c.content_html)));
    expect(c.has_math).toBe(0);
    expect(c.notes_html).toBeNull();
    expect(Object.keys(c).sort()).toEqual(['author', 'content_ast', 'content_html', 'has_math', 'notes_html', 'preamble_html', 'pub_date', 'toc_html']);
  });

  test('falls back to #article-content, and to the <p class="author"> byline', async () => {
    fetchMock.mockResolvedValue(page('<div id="article-content"><p>Body.</p></div><p class="author">Jane Doe</p>'));
    expect(await fetchAndCacheArticle('x')).toBe(true);
    expect(cached().content_html).toBe('<p>Body.</p>');
    expect(cached().author).toBe('Jane Doe');
    expect(cached().pub_date).toBeNull();
    expect(cached().toc_html).toBeNull();
  });

  test('links are indexed from the article text as fetched (not linkified), and a failure there is ignored', async () => {
    m.indexLinks.mockRejectedValue(new Error('db'));
    expect(await fetchAndCacheArticle('free-will')).toBe(true);
    expect(m.indexLinks).toHaveBeenCalledWith('free-will', CONTENT);
  });
});

describe('footnotes', () => {
  const WITH_NOTE = ARTICLE.replace('is old.', 'is old<a href="notes.html#note-1">[1]</a>.');
  test('the notes page is fetched only when the body refers to it, and stored with the article', async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u.endsWith('/notes.html') ? page('<div id="aueditable"><ol><li>Note one</li></ol></div>') : page(WITH_NOTE));
    expect(await fetchAndCacheArticle('free-will')).toBe(true);
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      'https://plato.stanford.edu/entries/free-will/',
      'https://plato.stanford.edu/entries/free-will/notes.html',
    ]);
    expect(cached().notes_html).toBe('<ol><li>Note one</li></ol>');
  });
  test('no footnote reference means no second request', async () => {
    await fetchAndCacheArticle('free-will');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test.each([
    ['HTTP error', () => fetchMock.mockImplementation(async (u: string) => (u.endsWith('/notes.html') ? page('x', false, 404) : page(WITH_NOTE)))],
    ['network error', () => fetchMock.mockImplementation(async (u: string) => { if (u.endsWith('/notes.html')) throw new Error('offline'); return page(WITH_NOTE); })],
    ['empty notes page', () => fetchMock.mockImplementation(async (u: string) => (u.endsWith('/notes.html') ? page('<p>nothing</p>') : page(WITH_NOTE)))],
  ])('a notes page that cannot be used (%s) still caches the article, without notes', async (_n, arrange) => {
    arrange();
    expect(await fetchAndCacheArticle('free-will')).toBe(true);
    expect(cached().notes_html).toBeNull();
  });
});

describe('dev-only timing stages', () => {
  test('run in this order for an article with footnotes and no math', async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u.endsWith('/notes.html') ? page('<div id="aueditable"><p>n</p></div>') : page(ARTICLE.replace('is old.', 'is old<a href="notes.html#note-1">[1]</a>.')));
    await fetchAndCacheArticle('free-will');
    expect(mockStages).toEqual(['fetch', 'fetch-body', 'extract', 'linkify', 'notes', 'parse+stringify', 'cache-write']);
  });
});
