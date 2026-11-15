import { extractArticleParts, stripArticleHeader, hasTex, referencesNotes } from '../sepArticlePage';

describe('extractArticleParts', () => {
  const PAGE = `<meta property="citation_author" content="Doe, Jane">
<meta property="citation_publication_date" content="2020/05/01">
<div id="toc"><ul><li>t</li></ul></div><div id="preamble"><p>pre</p></div>
<div id="aueditable"><h1>Title</h1><p>Body</p></div>`;
  test('picks out every part', () => {
    expect(extractArticleParts(PAGE)).toEqual({
      tocHtml: '<ul><li>t</li></ul>', preambleHtml: '<p>pre</p>',
      rawContentHtml: '<h1>Title</h1><p>Body</p>', author: 'Doe, Jane', pubDate: '2020/05/01',
    });
  });
  test('prefers #aueditable, falls back to #article-content, byline when there is no meta', () => {
    expect(extractArticleParts('<div id="article-content"><p>x</p></div><p class="author">By Me</p>')).toEqual({
      tocHtml: null, preambleHtml: null, rawContentHtml: '<p>x</p>', author: 'By Me', pubDate: null,
    });
    expect(extractArticleParts('<div id="article-content">a</div><div id="aueditable">b</div>').rawContentHtml).toBe('b');
  });
  test('nothing recognisable', () => {
    expect(extractArticleParts('')).toEqual({ tocHtml: null, preambleHtml: null, rawContentHtml: null, author: null, pubDate: null });
  });
});

describe('stripArticleHeader', () => {
  test('removes a leading comment and the leading h1 only', () => {
    expect(stripArticleHeader('<!-- c -->\n<h1 class="x">T</h1>\n<p>a</p><h1>Later</h1>')).toBe('<p>a</p><h1>Later</h1>');
    expect(stripArticleHeader('<p>no header</p>')).toBe('<p>no header</p>');
    expect(stripArticleHeader('')).toBe('');
  });
  test('a heading that is not first stays', () => {
    expect(stripArticleHeader('<p>x</p><h1>T</h1>')).toBe('<p>x</p><h1>T</h1>');
  });
});

describe('hasTex / referencesNotes', () => {
  test('TeX delimiters', () => {
    expect(hasTex('a \\(x\\) b')).toBe(true);
    expect(hasTex('a \\[x\\] b')).toBe(true);
    expect(hasTex('plain (x) [y]')).toBe(false);
  });
  test('footnote links, case-insensitive', () => {
    expect(referencesNotes('<a href="notes.html#note-3">3</a>')).toBe(true);
    expect(referencesNotes('<a href="NOTES.html#NOTE-3">3</a>')).toBe(true);
    expect(referencesNotes('<a href="notes.html">all notes</a>')).toBe(false);
  });
});
