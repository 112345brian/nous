import { hasTexSpan } from '../sepMath';

describe('hasTexSpan', () => {
  test('complete inline and display spans', () => {
    expect(hasTexSpan('a \\(x\\) b')).toBe(true);
    expect(hasTexSpan('a \\[x = 1\\] b')).toBe(true);
    expect(hasTexSpan('multi \\(x\n+ y\\) line')).toBe(true);
  });
  test('no span: plain text, brackets, or an opening delimiter with no end', () => {
    expect(hasTexSpan('plain (x) [y]')).toBe(false);
    expect(hasTexSpan('costs \\(5 dollars')).toBe(false);
    expect(hasTexSpan('')).toBe(false);
  });
  test('carries no state between calls', () => {
    for (let i = 0; i < 4; i++) {
      expect(hasTexSpan('a \\(x\\) b')).toBe(true);
      expect(hasTexSpan('none here')).toBe(false);
    }
  });
});
