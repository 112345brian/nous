// buildFtsQuery against the real FTS5 engine (node:sqlite), so "does not throw"
// and "finds the right rows" are proved, not assumed. Hand-written titles.
import { buildFtsQuery } from '../ftsQuery';

declare function require(mod: string): any;
const { DatabaseSync } = require('node:sqlite');

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE VIRTUAL TABLE t USING fts5(slug UNINDEXED, title, tokenize='porter ascii')");
  d.exec(`INSERT INTO t VALUES
    ('kant', 'Kant and the Enlightenment'),
    ('descartes', 'Descartes'),
    ('plato', 'Plato''s Republic'),
    ('quine', 'Quine on "analytic" truth')`);
  return d;
}
const search = (d: any, input: string): string[] => {
  const q = buildFtsQuery(input);
  if (q === null) return [];
  return d.prepare('SELECT slug FROM t WHERE t MATCH ?').all(q).map((r: any) => r.slug).sort();
};

describe('buildFtsQuery', () => {
  test('blank input means "nothing to search"', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   \t ')).toBeNull();
  });

  test('plain words become quoted prefix terms joined by space', () => {
    expect(buildFtsQuery('kant enl')).toBe('"kant"* "enl"*');
    expect(buildFtsQuery('  kant   enl ')).toBe('"kant"* "enl"*');
  });

  test('an embedded double quote is doubled', () => {
    expect(buildFtsQuery('a"b')).toBe('"a""b"*');
  });

  test('prefix search finds the right rows', () => {
    const d = makeDb();
    expect(search(d, 'kan')).toEqual(['kant']);
    expect(search(d, 'des')).toEqual(['descartes']);
    expect(search(d, 'kant enlight')).toEqual(['kant']);
    expect(search(d, 'kant plato')).toEqual([]);
  });

  test.each([
    ['a lone double quote', '"'],
    ['a quote inside a word', 'Ka"nt'],
    ['an unbalanced quote after a word', 'kant "'],
    ['only quotes', '"""'],
    ['an apostrophe', "Plato's"],
    ['a leading dash', '-kant'],
    ['a colon (column filter syntax)', 'title:kant'],
    ['parentheses', '(kant)'],
    ['an asterisk', 'kan*'],
    ['AND / OR / NOT words', 'kant OR descartes NOT plato'],
    ['punctuation only', '-- ?! ()'],
    ['a caret', '^kant'],
  ])('%s never throws', (_name, input) => {
    const d = makeDb();
    expect(() => search(d, input)).not.toThrow();
  });

  test('typing quotes around a word still finds it', () => {
    const d = makeDb();
    expect(search(d, '"analytic"')).toEqual(['quine']);
    expect(search(d, "Plato's")).toEqual(['plato']);
  });

  test('operator words are searched as words, not interpreted', () => {
    const d = makeDb();
    // "OR" inside quotes is a literal term, so this must not match kant OR descartes
    expect(search(d, 'kant OR descartes')).toEqual([]);
  });
});
