// backfillAst: parses cached article HTML into an AST and stores it. It only
// needs the article body — not the whole row.
const mockSetArticleAst = jest.fn(async (_slug: string, _ast: string) => {});
const mockHtml: Record<string, string | null> = {};

jest.mock('../db', () => ({
  getUncachedAstSlugs: async () => Object.keys(mockHtml),
  getEntryHtml: async (slug: string) => mockHtml[slug] ?? null,
  setArticleAst: (slug: string, ast: string) => mockSetArticleAst(slug, ast),
}));
jest.mock('../../core/mathBridge', () => ({ createMathBridge: () => require('./fakeMathBridge').fakeMathBridge(async () => []) }));

import { backfillAst } from '../../composition';   // wired in the composition root

beforeEach(() => {
  mockSetArticleAst.mockClear();
  for (const k of Object.keys(mockHtml)) delete mockHtml[k];
});

describe('backfillAst', () => {
  it('stores a parsed AST for each cached article with a body', async () => {
    mockHtml.plato = '<p>Hello <em>world</em>.</p>';
    await backfillAst();
    expect(mockSetArticleAst).toHaveBeenCalledTimes(1);
    const [slug, ast] = mockSetArticleAst.mock.calls[0];
    expect(slug).toBe('plato');
    expect(JSON.parse(ast)).toHaveProperty('blocks');
  });

  it('skips slugs whose body is missing', async () => {
    mockHtml.ghost = null;
    await backfillAst();
    expect(mockSetArticleAst).not.toHaveBeenCalled();
  });
});
