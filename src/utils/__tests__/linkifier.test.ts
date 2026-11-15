// Characterization of linkifyHtml against the real bundled link index, written before the
// linkifier was split into an injectable createLinkifier(). Snapshots hold the original output.
import { createLinkifier } from '../linkifier';
import { LINK_MAP_JSON } from '../../assets/linkMapData';

// The app builds this instance in src/composition.ts; here it is the same factory over the same index.
const linkifyHtml = createLinkifier(LINK_MAP_JSON);

const CASES: Record<string, string> = {
  'first mention only, case-insensitive': '<p>The problem of free will is old. Free will again, and FREE WILL.</p>',
  'skips a, code, pre, headings, cite, blockquote': '<a href="/x">free will</a> <code>free will</code> <h2>free will</h2> <cite>free will</cite> <blockquote>free will</blockquote> then free will',
  'skip depth recovers after the closing tag': '<a href="/x">free will</a> and free will',
  'no match / empty / markup only': '<p>zzzz qqqq</p>',
  'empty string': '',
  'tags only': '<p></p><br/>',
  'longest title wins': '<p>Kant, Immanuel on ethics and Kant</p>',
};

describe('linkifyHtml (real index)', () => {
  for (const [name, html] of Object.entries(CASES)) {
    test(name, () => expect(linkifyHtml(html)).toMatchSnapshot());
  }
  test('is deterministic across calls (shared regex state is reset)', () => {
    const a = linkifyHtml(CASES['first mention only, case-insensitive']);
    expect(linkifyHtml(CASES['first mention only, case-insensitive'])).toBe(a);
    expect(a).toContain('class="wl"');
  });
  test('wraps with an /entries/<slug>/ link and keeps the original casing', () => {
    expect(linkifyHtml('<p>Free Will</p>')).toMatch(/<a href="\/entries\/[a-z0-9-]+\/" class="wl">Free Will<\/a>/);
  });
});

describe('createLinkifier with an injected index', () => {
  const INDEX = JSON.stringify([
    { s: 'long-slug', t: 'Moral Luck', p: '\\bMoral Luck\\b' },
    { s: 'luck', t: 'Luck', p: '\\bLuck\\b' },
  ]);
  const link = createLinkifier(INDEX);

  test('uses only the index it was given', () => {
    expect(link('<p>moral luck and free will</p>')).toBe('<p><a href="/entries/long-slug/" class="wl">moral luck</a> and free will</p>');
  });
  test('each linkifier keeps its own state; calls do not leak into each other', () => {
    const other = createLinkifier(JSON.stringify([{ s: 'x', t: 'Luck', p: '\\bLuck\\b' }]));
    expect(other('<p>Luck</p>')).toContain('/entries/x/');
    expect(link('<p>Luck</p>')).toContain('/entries/luck/');
    expect(link('<p>Luck</p>')).toBe(link('<p>Luck</p>'));
  });
  test('an empty index links nothing', () => {
    // An empty alternation matches the empty string; the original behaviour is "no links".
    expect(createLinkifier('[]')('<p>anything</p>')).toBe('<p>anything</p>');
  });
});
