import type { Block } from '../../types';
import { activeHeadingId, collectHeadings, sepItemType } from '../listHelpers';

const para: Block = { t: 'para', children: [] };
const h = (id?: string): Block => ({ t: 'heading', level: 2, id, children: [] });

describe('sepItemType', () => {
  it('shares one recycle pool per ordinary block type', () => {
    expect(sepItemType(para, 3)).toBe('para');
    expect(sepItemType(para, 90)).toBe('para');
    expect(sepItemType(h('a'), 1)).toBe('heading');
  });

  it('never recycles blocks that keep local state (image, unsupported)', () => {
    const img: Block = { t: 'image', src: 'x.png', alt: '' };
    const uns: Block = { t: 'unsupported', reason: 'nested table', html: '<table/>' };
    expect(sepItemType(img, 4)).not.toBe(sepItemType(img, 5));
    expect(sepItemType(uns, 4)).not.toBe(sepItemType(uns, 5));
    expect(sepItemType(img, 4)).not.toBe(sepItemType(uns, 4));
  });
});

describe('collectHeadings', () => {
  it('returns only headings that carry an id, with their block index', () => {
    expect(collectHeadings([para, h('intro'), para, h(), h('later')])).toEqual([
      { index: 1, id: 'intro' },
      { index: 4, id: 'later' },
    ]);
  });

  it('handles an empty article', () => {
    expect(collectHeadings([])).toEqual([]);
  });
});

describe('activeHeadingId', () => {
  const heads = [
    { index: 2, id: 'a' },
    { index: 10, id: 'b' },
    { index: 40, id: 'c' },
  ];

  it('is empty above the first heading', () => {
    expect(activeHeadingId(heads, 0)).toBe('');
    expect(activeHeadingId(heads, 1)).toBe('');
  });

  it('picks the last heading at or before the first visible block', () => {
    expect(activeHeadingId(heads, 2)).toBe('a');
    expect(activeHeadingId(heads, 9)).toBe('a');
    expect(activeHeadingId(heads, 10)).toBe('b');
    expect(activeHeadingId(heads, 39)).toBe('b');
    expect(activeHeadingId(heads, 40)).toBe('c');
    expect(activeHeadingId(heads, 9999)).toBe('c');
  });

  it('handles no headings and a negative index', () => {
    expect(activeHeadingId([], 5)).toBe('');
    expect(activeHeadingId(heads, -1)).toBe('');
  });
});
