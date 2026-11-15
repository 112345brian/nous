import { parseContentsHtml, buildLinkIndexPayload } from '../sepIndex';

describe('parseContentsHtml', () => {
  const HTML = `<ul>
<li><a href="entries/abduction/"><strong>abduction</strong></a></li>
<li>Ancient Philosophy
<ul>
<li><a href="entries/plato/"><strong>Plato</strong></a></li>
</ul></li>
<li><a href="entries/ethics/"><strong>Ethics</strong></a>
<ul>
<li><a href="entries/virtue-ethics/"><strong>Virtue Ethics</strong></a></li>
</ul></li>
<li><a href="entries/kant/"><strong>Kant &amp; Co</strong></a></li>
</ul>`;

  test('groups, linked parents and standalone entries, sorted by title', () => {
    expect(parseContentsHtml(HTML)).toEqual([
      { slug: 'abduction', title: 'abduction', parent_label: null },
      { slug: 'ethics', title: 'Ethics', parent_label: null },
      { slug: 'kant', title: 'Kant & Co', parent_label: null },
      { slug: 'plato', title: 'Plato', parent_label: 'Ancient Philosophy' },
      { slug: 'virtue-ethics', title: 'Virtue Ethics', parent_label: 'Ethics' },
    ]);
  });
  test('a slug listed twice is kept once (first occurrence wins)', () => {
    const dup = '<li><a href="entries/a/"><strong>One</strong></a></li><li><a href="entries/a/"><strong>Two</strong></a></li>';
    expect(parseContentsHtml(dup)).toEqual([{ slug: 'a', title: 'One', parent_label: null }]);
  });
  test('nothing recognisable gives an empty list', () => {
    expect(parseContentsHtml('')).toEqual([]);
    expect(parseContentsHtml('<html>maintenance</html>')).toEqual([]);
  });
});

describe('buildLinkIndexPayload', () => {
  test('maps to slug/title/escaped pattern, keeps order', () => {
    expect(JSON.parse(buildLinkIndexPayload([{ slug: 's', title: 'C++ (a)' }, { slug: 't', title: 'Plain' }])))
      .toEqual([{ s: 's', t: 'C++ (a)', p: 'C\\+\\+ \\(a\\)' }, { s: 't', t: 'Plain', p: 'Plain' }]);
  });
  test('caps at 700 and handles empty', () => {
    expect(JSON.parse(buildLinkIndexPayload(Array.from({ length: 900 }, (_, i) => ({ slug: `${i}`, title: `T${i}` }))))).toHaveLength(700);
    expect(buildLinkIndexPayload([])).toBe('[]');
  });
});
