// The AST backfill and ensureNotesCached run with plain fakes: no jest.mock, no SQLite, no timers.
// Date.now, fetch and setTimeout throw to prove the core never reaches for them.
import { backfillAst } from '../backfills';
import { ensureNotesCached } from '../ensureNotes';
import type { MathPriority } from '../../utils/mathThrottlePolicy';

function world(o: { astSlugs?: string[]; astFailing?: string[]; current?: Record<string, string> } = {}) {
  const log: string[] = [];
  const store: Record<string, string> = { ...(o.current ?? {}) };
  const asts: Record<string, string> = {};
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
    pause: async (priority: MathPriority) => { log.push(`pause:${priority}`); },
  };
  return { astDeps, log, asts };
}

const realFetch = (globalThis as any).fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
  (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

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
  test('a failure reading the work list rejects', async () => {
    const w = world();
    w.astDeps.library.getUncachedAstSlugs = async () => { throw new Error('db'); };
    await expect(backfillAst(w.astDeps)).rejects.toThrow('db');
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
