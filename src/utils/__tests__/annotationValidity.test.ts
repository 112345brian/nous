import { partitionAnnotations } from '../annotationValidity';

type A = { id: number; content_hash: string | null; selected_text: string };
const a = (id: number, content_hash: string | null, selected_text: string): A => ({ id, content_hash, selected_text });

// The behavior ArticleScreen.load() had before the hash was read from the row:
// two filters, each scanning the full HTML for every hash-mismatched annotation.
function legacy(anns: A[], currentHash: string, html: string) {
  const valid = anns.filter(x => !x.content_hash || x.content_hash === currentHash || html.includes(x.selected_text));
  const stale = anns.filter(x => x.content_hash && x.content_hash !== currentHash && !html.includes(x.selected_text));
  return { valid, stale };
}

const HTML = '<p>The quick brown fox jumps over the lazy dog.</p>';

describe('partitionAnnotations', () => {
  const cases: Array<[string, A[]]> = [
    ['empty', []],
    ['missing hash (legacy annotation)', [a(1, null, 'anything at all')]],
    ['empty-string hash is treated as missing', [a(1, '', 'not in the article')]],
    ['matching hash', [a(1, 'abc', 'not in the article')]],
    ['stale hash, text still present', [a(1, 'old', 'brown fox')]],
    ['stale hash, text gone (orphaned)', [a(1, 'old', 'purple cow')]],
    ['mixed', [a(1, null, 'x'), a(2, 'abc', 'y'), a(3, 'old', 'lazy dog'), a(4, 'old', 'nope')]],
  ];

  it.each(cases)('matches the previous filter semantics: %s', (_name, anns) => {
    expect(partitionAnnotations(anns, 'abc', () => HTML)).toEqual(legacy(anns, 'abc', HTML));
  });

  it('preserves annotation order within each side', () => {
    const anns = [a(1, 'old', 'nope'), a(2, 'abc', 'x'), a(3, 'old', 'nope2'), a(4, null, 'y')];
    const { valid, stale } = partitionAnnotations(anns, 'abc', () => HTML);
    expect(valid.map(x => x.id)).toEqual([2, 4]);
    expect(stale.map(x => x.id)).toEqual([1, 3]);
  });

  it('never reads the article HTML when every annotation resolves by hash', () => {
    const getHtml = jest.fn(() => HTML);
    partitionAnnotations([a(1, null, 'x'), a(2, 'abc', 'y'), a(3, '', 'z')], 'abc', getHtml);
    expect(getHtml).not.toHaveBeenCalled();
  });

  it('reads the HTML once, however many annotations are hash-mismatched', () => {
    const getHtml = jest.fn(() => HTML);
    partitionAnnotations([a(1, 'old', 'fox'), a(2, 'old', 'nope'), a(3, 'older', 'dog')], 'abc', getHtml);
    expect(getHtml).toHaveBeenCalledTimes(1);
  });

  it('a mismatched hash is not enough to orphan an annotation whose text survives', () => {
    const { valid, stale } = partitionAnnotations([a(1, 'old', 'quick brown')], 'abc', () => HTML);
    expect(valid).toHaveLength(1);
    expect(stale).toHaveLength(0);
  });
});
