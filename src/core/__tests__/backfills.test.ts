// The one-time backfills and ensureNotesCached run with plain fakes: no jest.mock, no SQLite, no
// renderer, no timers. Date.now, fetch and setTimeout throw to prove the core never reaches for them.
import { backfillMathInline, backfillAst, MATH_INLINE_DONE_KEY } from '../backfills';
import { ensureNotesCached } from '../ensureNotes';
import type { MathPriority } from '../../utils/mathThrottlePolicy';

const TEX = (n: string) => `<p>CURRENT \\(${n}\\)</p>`;

function world(o: { articles?: Array<{ slug: string; content_html: string }>; current?: Record<string, string>; failing?: string[]; resumeFails?: boolean; flag?: boolean; astSlugs?: string[]; astFailing?: string[] } = {}) {
  const log: string[] = [];
  const meta = new Map<string, string>();
  if (o.flag) meta.set(MATH_INLINE_DONE_KEY, '1');
  const store: Record<string, string> = { ...(o.current ?? {}) };
  const asts: Record<string, string> = {};
  const priorities: MathPriority[] = [];
  const mathDeps = {
    resumePendingMath: async () => { log.push('resume'); if (o.resumeFails) throw new Error('resume'); },
    meta: {
      getMeta: async (k: string) => meta.get(k) ?? null,
      setMeta: async (k: string, v: string) => { log.push(`set:${k}`); meta.set(k, v); },
    },
    library: { getMathArticleHtml: async () => { log.push('list'); return o.articles ?? []; } },
    articles: {
      getEntryHtml: async (slug: string) => store[slug] ?? null,
      updateArticleHtml: async (slug: string, html: string) => { log.push(`write:${slug}`); store[slug] = html; },
    },
    substitute: async (html: string, priority: MathPriority) => {
      priorities.push(priority);
      if (o.failing?.some(f => html.includes(`\\(${f}\\)`))) throw new Error('renderer');
      return html.replace(/\\\((.*?)\\\)/g, '<math-i hash="$1"></math-i>');
    },
    pause: async (priority: MathPriority) => { log.push(`pause:${priority}`); },
  };
  const astDeps = {
    library: { getUncachedAstSlugs: async () => o.astSlugs ?? [] },
    articles: {
      getEntryHtml: async (slug: string) => store[slug] ?? null,
      setArticleAst: async (slug: string, ast: string) => {
        log.push(`ast:${slug}`);
        if (o.astFailing?.includes(slug)) throw new Error('disk');
        asts[slug] = ast;
      },
    },
    pause: mathDeps.pause,
  };
  return { mathDeps, astDeps, log, meta, store, asts, priorities };
}

const realFetch = (globalThis as any).fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
  (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

describe('backfillMathInline with fakes', () => {
  test('resumes pending math first, then renders each article at background priority, then sets the flag', async () => {
    const w = world({ articles: [{ slug: 'a', content_html: TEX('a') }, { slug: 'b', content_html: '<p>no tex</p>' }], current: { a: TEX('a'), b: '<p>no tex</p>' } });
    await backfillMathInline(w.mathDeps);
    expect(w.log).toEqual(['resume', 'list', 'pause:background', 'write:a', 'pause:background', `set:${MATH_INLINE_DONE_KEY}`]);
    expect(w.store.a).toContain('<math-i');
    expect(w.store.b).toBe('<p>no tex</p>');                       // unchanged articles are not rewritten
    expect(w.priorities).toEqual(['background', 'background']);
  });

  test('works from the current copy, falling back to the listed snapshot when the article is gone', async () => {
    const w = world({ articles: [{ slug: 'a', content_html: '<p>SNAPSHOT \\(a\\)</p>' }, { slug: 'gone', content_html: '<p>SNAP \\(g\\)</p>' }], current: { a: TEX('a') } });
    await backfillMathInline(w.mathDeps);
    expect(w.store.a).toContain('CURRENT');
    expect(w.store.a).not.toContain('SNAPSHOT');
    expect(w.store.gone).toContain('SNAP');
  });

  test('already done: only the resume runs', async () => {
    const w = world({ flag: true, articles: [{ slug: 'a', content_html: TEX('a') }] });
    await backfillMathInline(w.mathDeps);
    expect(w.log).toEqual(['resume']);
  });

  test('a failing resume does not block the pass; a failing article does not stop the rest', async () => {
    const w = world({ resumeFails: true, failing: ['a'], articles: [{ slug: 'a', content_html: TEX('a') }, { slug: 'b', content_html: TEX('b') }], current: { a: TEX('a'), b: TEX('b') } });
    await backfillMathInline(w.mathDeps);
    expect(w.store.a).toBe(TEX('a'));
    expect(w.store.b).toContain('<math-i');
    expect(w.meta.get(MATH_INLINE_DONE_KEY)).toBe('1');
  });

  test('a failure reading the list leaves the flag unset (retried next launch)', async () => {
    const w = world();
    w.mathDeps.library.getMathArticleHtml = async () => { throw new Error('db'); };
    await expect(backfillMathInline(w.mathDeps)).rejects.toThrow('db');
    expect(w.meta.has(MATH_INLINE_DONE_KEY)).toBe(false);
  });
});

describe('backfillAst with fakes', () => {
  test('pauses at background priority before each article and stores the AST of its body', async () => {
    const w = world({ astSlugs: ['a', 'b'], current: { a: '<p>one</p>', b: '<p>two</p>' } });
    await backfillAst(w.astDeps);
    expect(w.log).toEqual(['pause:background', 'ast:a', 'pause:background', 'ast:b']);
    expect(JSON.parse(w.asts.a)).toBeTruthy();
  });
  test('missing bodies are skipped and a failure does not stop the rest', async () => {
    const w = world({ astSlugs: ['gone', 'a', 'b'], astFailing: ['a'], current: { a: '<p>x</p>', b: '<p>y</p>' } });
    await backfillAst(w.astDeps);
    expect(w.log.filter(l => l.startsWith('ast:'))).toEqual(['ast:a', 'ast:b']);
    expect(Object.keys(w.asts)).toEqual(['b']);
  });
});

describe('ensureNotesCached with fakes', () => {
  const NOTED = '<p>x<a href="notes.html#note-1">1</a></p>';
  function notesWorld(notes: string | null) {
    const calls: string[] = []; const saved: Array<[string, string]> = [];
    return {
      calls, saved,
      deps: {
        source: { fetchNotesHtml: async (slug: string) => { calls.push(slug); return notes; } },
        library: { setEntryNotes: async (slug: string, n: string) => { saved.push([slug, n]); } },
      },
    };
  }
  test('fetches and stores notes only when the body refers to them', async () => {
    const w = notesWorld('<ol><li>n</li></ol>');
    expect(await ensureNotesCached(w.deps, 'a', NOTED)).toBe('<ol><li>n</li></ol>');
    expect(w.saved).toEqual([['a', '<ol><li>n</li></ol>']]);
    expect(await ensureNotesCached(w.deps, 'a', '<p>plain</p>')).toBeNull();
    expect(await ensureNotesCached(w.deps, 'a', null)).toBeNull();
    expect(w.calls).toEqual(['a']);
  });
  test('unusable notes are not stored', async () => {
    const w = notesWorld(null);
    expect(await ensureNotesCached(w.deps, 'a', NOTED)).toBeNull();
    expect(w.saved).toEqual([]);
  });
});
