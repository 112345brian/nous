// Characterization tests: written against the helpers while they still lived in
// services/catalog.ts and services/db.ts, then re-pointed at their new homes.
// The snapshots hold values produced by the original code.
import { hash64 as mathHash } from '../mathKey';   // was utils/mathHash.ts before the math-throttle merge
import { extractById, extractMetaContent, extractTitle, extractAuthor, decodeEntities } from '../sepPage';
import { formatCitation } from '../citation';
import { contentHash } from '../contentHash';

describe('mathHash', () => {
  test('16 hex chars, display flag changes it, deterministic', () => {
    const a = mathHash('x^2', false);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(mathHash('x^2', false)).toBe(a);
    expect(mathHash('x^2', true)).not.toBe(a);
  });
  test('pinned values (stored hashes in users DBs depend on these)', () => {
    expect(mathHash('x', false)).toMatchSnapshot();
    expect(mathHash('\\alpha+\\beta', true)).toMatchSnapshot();
  });
});

describe('extractById', () => {
  test('returns inner html of matching div', () => {
    expect(extractById('<div id="toc"><ul><li>a</li></ul></div>', 'toc')).toBe('<ul><li>a</li></ul>');
  });
  test('handles nested same-tag', () => {
    expect(extractById('<div id="a"><div>x</div><div>y</div></div><div>z</div>', 'a')).toBe('<div>x</div><div>y</div>');
  });
  test('missing id / empty content -> null', () => {
    expect(extractById('<p>hi</p>', 'toc')).toBeNull();
    expect(extractById('<div id="toc">  </div>', 'toc')).toBeNull();
    expect(extractById('', 'toc')).toBeNull();
  });
  test('works on nav/section/ol/ul but not p', () => {
    expect(extractById('<nav id="n"><a>x</a></nav>', 'n')).toBe('<a>x</a>');
    expect(extractById('<p id="n">x</p>', 'n')).toBeNull();
  });
  test('unterminated tag: stops without throwing', () => {
    expect(() => extractById('<div id="a"><div>x</div>', 'a')).not.toThrow();
  });
});

describe('meta/title/author extraction', () => {
  test('extractMetaContent', () => {
    const h = '<meta property="citation_author" content="Zalta, E. &amp; Co">';
    expect(extractMetaContent(h, 'citation_author')).toBe('Zalta, E. & Co');
    expect(extractMetaContent(h, 'citation_title')).toBeNull();
  });
  test('extractTitle prefers <title>, falls back to h1.pagetitle', () => {
    expect(extractTitle('<title>Free Will (Stanford Encyclopedia of Philosophy)</title>')).toBe('Free Will');
    expect(extractTitle('<h1 class="x pagetitle">Kant &amp; co</h1>')).toBe('Kant & co');
    expect(extractTitle('<p>none</p>')).toBeNull();
  });
  test('extractAuthor trims, decodes and caps at 200', () => {
    expect(extractAuthor('<p class="author">Jane &eacute; Doe</p>')).toBe('Jane é Doe');
    expect(extractAuthor(`<p class="author">${'a'.repeat(300)}</p>`)).toHaveLength(200);
    expect(extractAuthor('<p>none</p>')).toBeNull();
  });
});

describe('decodeEntities', () => {
  test('numeric, hex, named, unknown named left alone', () => {
    expect(decodeEntities('&#65;&#x42;&amp;&eacute;&mdash;')).toBe('AB&é—');
    expect(decodeEntities('&bogus; plain')).toBe('&bogus; plain');
    expect(decodeEntities('')).toBe('');
  });
  test('does not double-decode', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('formatCitation', () => {
  test('full entry', () => {
    expect(formatCitation({ slug: 'free-will', title: 'Free Will', author: 'Timothy O’Connor', pub_date: '2002/10/29' }))
      .toBe('Timothy O’Connor. "Free Will". The Stanford Encyclopedia of Philosophy (Oct 2002). Edward N. Zalta and Uri Nodelman (eds.). <https://plato.stanford.edu/entries/free-will/>');
  });
  test('missing author and date', () => {
    expect(formatCitation({ slug: 's', title: 'T', author: null, pub_date: null }))
      .toBe('Unknown. "T". The Stanford Encyclopedia of Philosophy. Edward N. Zalta and Uri Nodelman (eds.). <https://plato.stanford.edu/entries/s/>');
  });
  test('edge dates: year only, bad month', () => {
    expect(formatCitation({ slug: 's', title: 'T', author: 'A', pub_date: '2002' })).toContain('(Jan 2002)');
    expect(formatCitation({ slug: 's', title: 'T', author: 'A', pub_date: '2002/13/01' })).toContain('(2002)');
  });
});

describe('contentHash', () => {
  test('deterministic, hex, differs by content', () => {
    expect(contentHash('hello nous')).toBe(contentHash('hello nous'));
    expect(contentHash('hello nous')).not.toBe(contentHash('different content'));
    expect(contentHash('hello')).toMatch(/^[0-9a-f]+$/);
  });
  test('only first 50000 chars count', () => {
    const base = 'a'.repeat(50000);
    expect(contentHash(base + 'X')).toBe(contentHash(base + 'Y'));
    expect(contentHash('b' + base)).not.toBe(contentHash('c' + base));
  });
  test('empty string is the djb2 seed', () => {
    expect(contentHash('')).toBe((5381).toString(16));
  });
  test('pinned value', () => {
    expect(contentHash('<p>Test content for Nous.</p>')).toMatchSnapshot();
  });
});
