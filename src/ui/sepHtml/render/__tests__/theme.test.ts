// require() + local declares: the repo has no @types/node (same as __tests__/mockup/_src.ts).
declare const __dirname: string;
declare function require(mod: string): any;
const fs = require('fs');
const path = require('path');
import {
  DEFAULT_READER_FONT, getSepTheme, makeSepTheme, parseReaderFontSize,
} from '../theme';

describe('parseReaderFontSize', () => {
  it('accepts the Settings picker values', () => {
    for (const px of [15, 17, 19, 22]) expect(parseReaderFontSize(String(px))).toBe(px);
  });

  it.each([null, undefined, '', '   ', 'abc', 'NaN', '0', '-5', '11', '33', '1e9'])(
    'falls back to the default for %p',
    (raw) => {
      // '1e9' parses to 1 via parseInt, which is also out of range.
      expect(parseReaderFontSize(raw as any)).toBe(DEFAULT_READER_FONT);
    },
  );

  it('tolerates a trailing unit', () => {
    expect(parseReaderFontSize('19px')).toBe(19);
  });
});

describe('makeSepTheme', () => {
  it('keeps the shipped 17px metrics unchanged at the default size', () => {
    const t = makeSepTheme(17);
    expect(t.text.body.fontSize).toBe(17);
    expect(t.text.body.lineHeight).toBeCloseTo(30.6);
    expect(t.text.h1.fontSize).toBe(31);
    expect(t.text.h2.fontSize).toBe(22);
    expect(t.block.paraGap.marginBottom).toBe(27);
    expect(t.block.h2Margin).toMatchObject({ marginTop: 40, marginBottom: 13, paddingTop: 30 });
    expect(t.block.listIndent).toBe(28);
    expect(t.pxPerEx).toBe(8.5);
  });

  it.each([15, 17, 19, 22])('scales every size with the base (%ipx)', (base) => {
    const t = makeSepTheme(base);
    expect(t.text.body.fontSize).toBe(base);
    expect(t.text.body.lineHeight).toBeCloseTo(base * 1.8);
    expect(t.pxPerEx).toBe(base / 2);
    expect(t.inline.script).toBeLessThan(t.inline.small);
    expect(t.inline.small).toBeLessThan(base);
  });

  it('is monotonic: a larger setting never shrinks any role', () => {
    const small = makeSepTheme(15);
    const big = makeSepTheme(22);
    expect(big.text.h1.fontSize!).toBeGreaterThan(small.text.h1.fontSize!);
    expect(big.header.preambleText.fontSize!).toBeGreaterThan(small.header.preambleText.fontSize!);
    expect(big.block.bibText.fontSize!).toBeGreaterThan(small.block.bibText.fontSize!);
    expect(big.block.paraGap.marginBottom as number).toBeGreaterThan(small.block.paraGap.marginBottom as number);
  });

  it('never sets a heading smaller than body text', () => {
    for (const base of [12, 15, 17, 22, 32]) {
      const { text } = makeSepTheme(base);
      for (const h of [text.h1, text.h2, text.h3, text.h4]) {
        expect(h.fontSize!).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it('orders the heading steps h1 > h2 > h3 >= h4', () => {
    const { text } = makeSepTheme(17);
    expect(text.h1.fontSize!).toBeGreaterThan(text.h2.fontSize!);
    expect(text.h2.fontSize!).toBeGreaterThan(text.h3.fontSize!);
    expect(text.h3.fontSize!).toBeGreaterThanOrEqual(text.h4.fontSize!);
  });

  it('uses a serif family for display roles', () => {
    const { text, header } = makeSepTheme(17);
    expect(typeof text.h1.fontFamily).toBe('string');
    expect(header.title.fontFamily).toBe(text.h1.fontFamily);
    expect(text.h2.fontFamily).toBe(text.h1.fontFamily);
  });

  it('returns a stable object per size (context consumers rely on identity)', () => {
    expect(getSepTheme(19)).toBe(getSepTheme(19));
    expect(getSepTheme(19)).not.toBe(getSepTheme(17));
  });
});

// A caller that imports a static type scale (or hard-codes the base size) would
// silently ignore the reader's Font size setting. Fail if any renderer file does.
describe('renderer files follow the font-size setting', () => {
  const dir = path.join(__dirname, '..');
  const files = ['Blocks.tsx', 'Inline.tsx', 'MathSvg.tsx', 'ArticleHeader.tsx', 'SepArticle.tsx'];
  const banned = /\b(SEP_BASE_FONT|SEP_LINE_HEIGHT|SEP_PARA_GAP|sepText|sepBlock|sepHeader|sepMutedText)\b/;

  it.each(files)('%s uses the theme from context, not static scale exports', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const importLines = src.split('\n').filter(l => /from '\.\/theme'/.test(l)).join('\n');
    expect(importLines).not.toMatch(banned);
    // Destructured local aliases (const { text: sepText } = t) are fine; a
    // module-level fontSize derived from a constant is not.
    expect(src).not.toMatch(/^const \w+ = \{[^}]*fontSize: \d/m);
  });

  it('the article screen provides the theme to the renderer and footnote sheet', () => {
    const src = fs.readFileSync(path.join(dir, '..', '..', '..', 'screens', 'ArticleScreen.tsx'), 'utf8');
    expect(src.match(/<SepThemeProvider base=\{readerFont\}>/g)?.length).toBe(2);
    expect(src).toMatch(/parseReaderFontSize\(/);
  });
});
