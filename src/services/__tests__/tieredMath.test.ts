// Tiered math routing in substitutemath (via completeArticleMath): simple TeX
// becomes in-line text, the rest still reaches renderMathBatch. Hand-written TeX.

const mockMeta: Record<string, string> = {};
const mockEntries: Record<string, { content_html: string }> = {};

jest.mock('../db', () => ({
  upsertIndexEntries: jest.fn(),
  cacheArticle: jest.fn(async (slug: string, d: { content_html: string }) => {
    mockEntries[slug] = { content_html: d.content_html };
  }),
  getMeta: jest.fn(async (k: string) => mockMeta[k] ?? null),
  setMeta: jest.fn(async (k: string, v: string) => { mockMeta[k] = v; }),
  getEntryCount: jest.fn(),
  getSlugsByCacheStatus: jest.fn(),
  getCachedSlugs: jest.fn(),
  indexLinks: jest.fn(async () => {}),
  getAllEntryTitles: jest.fn(async () => []),
  invalidateLinkCache: jest.fn(),
  cleanDenormalizedTitles: jest.fn(),
  getMathArticleHtml: jest.fn(async () => []),
  updateArticleHtml: jest.fn(async (slug: string, html: string) => {
    mockEntries[slug] = { content_html: html };
  }),
  setArticleAst: jest.fn(async () => {}),
  getUncachedAstSlugs: jest.fn(async () => []),
  getEntry: jest.fn(async (slug: string) => mockEntries[slug] ?? null),
  getEntryHtml: jest.fn(async (slug: string) => mockEntries[slug]?.content_html ?? null),
  putMathBatch: jest.fn(async () => {}),
  getMathSvgMap: jest.fn(async () => ({})),
  setEntryNotes: jest.fn(),
}));

const mockRender = jest.fn();
jest.mock('../mathRender', () => ({
  renderMathBatch: (...a: unknown[]) => mockRender(...a),
}));

import * as db from '../db';
import { completeArticleMath } from '../catalog';
import { partitionAnnotations } from '../../utils/annotationValidity';
import { reanchorAll } from '../../utils/reanchor';

const T = '\u2009';
const okRender = async (items: Array<{ tex: string; display: boolean }>) =>
  items.map(it => ({ ...it, b64: btoa('<svg/>'), w: 2, h: 1 }));
const page = (inner: string) => `<p>${inner}</p>`;
const run = async (html: string) => {
  mockEntries.a = { content_html: html };
  const ok = await completeArticleMath('a', html);
  return { ok, out: mockEntries.a.content_html };
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockMeta)) delete mockMeta[k];
  for (const k of Object.keys(mockEntries)) delete mockEntries[k];
  mockRender.mockImplementation(okRender);
});

test('flag OFF by default: everything goes to MathJax (old behavior)', async () => {
  const { out } = await run(page('Let \\(x\\) and \\(\\frac{a}{b}\\).'));
  expect(mockRender).toHaveBeenCalledTimes(1);
  expect(mockRender.mock.calls[0][0]).toHaveLength(2);
  expect(out.match(/<math-i /g)).toHaveLength(2);
});

describe('flag ON (meta tiered_math=1)', () => {
  beforeEach(() => { mockMeta.tiered_math = '1'; });

  test('all-simple article: text in the flow, renderer never called, no math rows', async () => {
    const { ok, out } = await run(page('Let \\(x_1\\) and \\(p \\to q\\).'));
    expect(ok).toBe(true);
    expect(mockRender).not.toHaveBeenCalled();
    expect(out).toBe(page(`Let <em>x</em>₁ and <em>p</em>${T}→${T}<em>q</em>.`));
    expect(out).not.toContain('<math-i');
    expect(db.putMathBatch).toHaveBeenCalledWith([]);
    expect(db.setArticleAst).toHaveBeenCalled();
  });

  test('mixed: only the complex equation reaches renderMathBatch', async () => {
    const { out } = await run(page('A \\(x\\), B \\(\\frac{a}{b}\\), C \\[y = 2\\], D \\(z\\).'));
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender.mock.calls[0][0]).toEqual([
      { tex: '\\frac{a}{b}', display: false },
      { tex: 'y = 2', display: true }, // display always stays on MathJax
    ]);
    expect(out).toContain('A <em>x</em>, B <math-i ');
    expect(out).toContain('D <em>z</em>.');
    expect(out.match(/<math-i /g)).toHaveLength(2);
    expect((db.putMathBatch as jest.Mock).mock.calls[0][0]).toHaveLength(2);
  });

  test('renderer timeout on the complex remainder: nothing converted, stays pending', async () => {
    mockRender.mockResolvedValue([]);
    const html = page('\\(x\\) and \\(\\sqrt{2}\\)');
    const { ok, out } = await run(html);
    expect(ok).toBe(false);
    expect(out).toBe(html); // no half-converted article is written
    expect(db.updateArticleHtml).not.toHaveBeenCalled();
  });

  test('entities in TeX are decoded before classifying; output is escaped', async () => {
    const { out } = await run(page('\\(a &lt; b\\)'));
    expect(out).toBe(page(`<em>a</em>${T}&lt;${T}<em>b</em>`));
  });

  test('meta tiered_math=0 switches it off again', async () => {
    mockMeta.tiered_math = '0';
    const { out } = await run(page('\\(x\\)'));
    expect(out).toContain('<math-i ');
  });
});

describe('annotations vs tiered text', () => {
  const before = '<p>Then <math-i hash="h" d="0" w="1" h="1"></math-i> holds for every set.</p>';
  const after = `<p>Then <em>x</em>₁ holds for every set.</p>`;
  test('hash match: valid without scanning', () => {
    const r = partitionAnnotations([{ content_hash: 'cur', selected_text: 'Then x₁ holds' }], 'cur',
      () => { throw new Error('no scan needed'); });
    expect(r.valid).toHaveLength(1);
  });
  test('text beside an equation matches either form', () => {
    for (const html of [before, after]) {
      expect(partitionAnnotations([{ content_hash: 'old', selected_text: 'holds for every set' }], 'cur', () => html).valid).toHaveLength(1);
    }
  });
  test('a selection spanning tiered math survives an article revision (re-anchors)', () => {
    // Made after tiering: selected_text is the rendered text, spanning <em>x</em>₁.
    const ann = { id: 1, content_hash: 'old', selected_text: 'Then x₁ holds', context: 'Then x₁ holds for every set.' };
    const revised = '<p>In the revised text, then <em>x</em>₁ holds for every set, always.</p>'.replace('then', 'Then');
    // The substring scan misses it (HTML markup in between) -> orphaned ...
    expect(partitionAnnotations([ann], 'cur', () => revised).stale).toHaveLength(1);
    // ... and the re-anchor step, which sees through inline tags, finds it.
    const [res] = reanchorAll([ann as any], revised);
    expect(res.found).toBe(true);
    // Text that really changed still orphans.
    expect(reanchorAll([ann as any], '<p>Nothing alike here at all.</p>')[0].found).toBe(false);
  });
  test('a complex (SVG) equation has no selectable text: the anchor is the surrounding text only', () => {
    // The equation contributes nothing to selected_text, so re-anchoring matches
    // the text on either side (tags stripped, whitespace collapsed) and cannot
    // tell WHICH equation sat in the gap. TeX-source anchoring is not built.
    const ann = { id: 2, content_hash: 'old', selected_text: 'Then holds', context: null };
    expect(reanchorAll([ann as any], before)[0].found).toBe(true);
  });
});
