import { hash64, mathHash, normalizeTex } from '../mathKey';

it('pins hash determinism (changing these values orphans every stored equation)', () => {
  // Golden values: identical to the pre-existing catalog.ts mathHash for these inputs.
  expect(mathHash('x', false)).toBe(GOLDEN.x0);
  expect(mathHash('x', true)).toBe(GOLDEN.x1);
  expect(mathHash('\\frac{a}{b}', true)).toBe(GOLDEN.frac);
  expect(mathHash('x', false)).toHaveLength(16);
});

const GOLDEN = {
  x0: '0059717d036be29f',
  x1: '0059717c036be29e',
  frac: 'df17660d48ec396f',
};

it('display flag is part of the key', () => {
  expect(mathHash('x', true)).not.toBe(mathHash('x', false));
});

it('whitespace variants share one key', () => {
  const a = mathHash('a  +\n\tb', false);
  expect(mathHash('a + b', false)).toBe(a);
  expect(mathHash('  a +  b ', false)).toBe(a);
});

it('does not touch braces or commands: x_1 and x_{1} stay separate', () => {
  expect(mathHash('x_1', false)).not.toBe(mathHash('x_{1}', false));
  expect(normalizeTex('\\frac { a } { b }')).toBe('\\frac { a } { b }');
});

it('hash64 hashes the string exactly as given (normalization happens in mathHash)', () => {
  expect(hash64('a  b', false)).not.toBe(hash64('a b', false));
});
