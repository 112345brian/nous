// The UI use cases (reader load, orphaned highlights, library tab, settings, auto sync, Zotero
// send) run with plain fakes: no jest.mock, no SQLite, no timers. Date.now, fetch and setTimeout
// throw to prove the core never reaches for them. Several tests also compare against the inline
// code the screens used to hold ("legacy" copies below), so the extraction cannot drift.
import { loadArticleForReading, type LoadArticleDeps } from '../loadArticle';
import { reanchorOrphans, deleteOrphans, reanchorMessage } from '../orphanedAnnotations';
import { loadHomeData } from '../homeData';
import { loadReaderSettings } from '../readerSettings';
import { autoDeepSyncDue, runAutoDeepSync } from '../autoDeepSync';
import { prepareZoteroSend } from '../zoteroSend';
import { groupAnnotationsByArticle } from '../../utils/annotationGroups';
import { recentWithoutBookmarks, toggledReadProgress } from '../../utils/homeLists';
import { zoteroSavedMessage } from '../../utils/zoteroMessage';
import { linkPreviewValue } from '../../utils/readerSettings';
import type { Annotation, AnnotationWithTitle, EntryRow, EntrySummary } from '../../types';

const realFetch = (globalThis as any).fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
  (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

const ann = (over: Partial<Annotation> = {}): Annotation => ({
  id: 1, slug: 'plato', selected_text: 'the good', context: null, note: null, color: 'yellow',
  content_hash: null, created_at: 1, updated_at: 1, ...over,
});
const annT = (over: Partial<AnnotationWithTitle> = {}): AnnotationWithTitle => ({ ...ann(), article_title: 'Plato', ...over });
const entry = (over: Partial<EntryRow> = {}): EntryRow => ({
  slug: 'plato', title: 'Plato', content_html: '<p>the good life</p>', content_hash: 'H1', ...over,
} as EntryRow);

// ── loadArticleForReading ────────────────────────────────────────────────────

function readerWorld(o: { entries?: Array<EntryRow | null>; fetchOk?: boolean; anns?: Annotation[]; meta?: Record<string, string> } = {}) {
  const log: string[] = [];
  const queue = [...(o.entries ?? [entry()])];
  const deps: LoadArticleDeps = {
    library: { getEntry: async () => { log.push('getEntry'); return queue.length > 1 ? queue.shift()! : queue[0]; } },
    annotations: { getAnnotationsForSlug: async () => { log.push('anns'); return o.anns ?? []; } },
    meta: { getMeta: async k => { log.push(`meta:${k}`); return o.meta?.[k] ?? null; } },
    timing: { time: (_k, stage, fn) => { log.push(`time:${stage}`); return fn(); }, timeSync: (_k, _s, fn) => fn() },
    fetchArticle: async () => { log.push('fetch'); return o.fetchOk ?? true; },
  };
  return { deps, log };
}

describe('loadArticleForReading', () => {
  test('a stored article loads without a download, and the highlight and setting reads start before the entry read', async () => {
    const w = readerWorld({ meta: { custom_css: 'p{}', font_size: '19' }, anns: [ann({ content_hash: 'H1' })] });
    const r = await loadArticleForReading(w.deps, 'plato', false);
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.customCss).toBe('p{}');
    expect(r.fontSize).toBe('19');
    expect(r.valid).toHaveLength(1);
    expect(w.log.indexOf('anns')).toBeLessThan(w.log.indexOf('getEntry'));
    expect(w.log.indexOf('meta:font_size')).toBeLessThan(w.log.indexOf('getEntry'));
    expect(w.log).not.toContain('fetch');
  });

  test('a missing article is downloaded, announced, then read again', async () => {
    const w = readerWorld({ entries: [null, entry()] });
    const seen: string[] = [];
    const r = await loadArticleForReading(w.deps, 'plato', false, () => seen.push('fetching'));
    expect(r.status).toBe('ready');
    expect(seen).toEqual(['fetching']);
    expect(w.log.filter(x => x === 'getEntry')).toHaveLength(2);
  });

  test('an entry without a body counts as missing', async () => {
    const w = readerWorld({ entries: [entry({ content_html: null }), entry()] });
    expect((await loadArticleForReading(w.deps, 'plato', false)).status).toBe('ready');
    expect(w.log).toContain('fetch');
  });

  test('forceRefetch downloads even when stored, and skips the first read', async () => {
    const w = readerWorld();
    await loadArticleForReading(w.deps, 'plato', true);
    expect(w.log.filter(x => x === 'getEntry')).toHaveLength(1);
    expect(w.log.indexOf('fetch')).toBeLessThan(w.log.indexOf('getEntry'));
  });

  test('a failed download is an error and the highlight reads are not left unhandled', async () => {
    const w = readerWorld({ entries: [null], fetchOk: false });
    w.deps.annotations.getAnnotationsForSlug = async () => { throw new Error('db'); };
    expect(await loadArticleForReading(w.deps, 'plato', false)).toEqual({
      status: 'error', message: 'Could not load this article. Check your connection.',
    });
  });

  test('a download that stores nothing usable is "unavailable"', async () => {
    const w = readerWorld({ entries: [null, null] });
    expect(await loadArticleForReading(w.deps, 'plato', false)).toEqual({ status: 'error', message: 'Article content unavailable.' });
  });

  test('highlights from an older version split into valid (text still there) and stale (gone); a blank hash is valid', async () => {
    const anns = [
      ann({ id: 1, content_hash: 'H1' }),
      ann({ id: 2, content_hash: 'OLD', selected_text: 'the good' }),
      ann({ id: 3, content_hash: 'OLD', selected_text: 'vanished' }),
      ann({ id: 4, content_hash: null, selected_text: 'vanished' }),
    ];
    const r = await loadArticleForReading(readerWorld({ anns }).deps, 'plato', false);
    if (r.status !== 'ready') throw new Error('expected ready');
    expect(r.valid.map(a => a.id)).toEqual([1, 2, 4]);
    expect(r.stale.map(a => a.id)).toEqual([3]);
  });

  test('an entry stored without a hash is compared against a hash computed from its body', async () => {
    const e = entry({ content_hash: null as any });
    const { contentHash } = require('../../utils/contentHash');
    const anns = [ann({ id: 1, content_hash: contentHash(e.content_html!) }), ann({ id: 2, content_hash: 'OLD', selected_text: 'nope' })];
    const r = await loadArticleForReading(readerWorld({ entries: [e], anns }).deps, 'plato', false);
    if (r.status !== 'ready') throw new Error('expected ready');
    expect(r.valid.map(a => a.id)).toEqual([1]);
    expect(r.stale.map(a => a.id)).toEqual([2]);
  });

  test('a store that rejects rejects the load (the screen catches it)', async () => {
    const w = readerWorld();
    w.deps.library.getEntry = async () => { throw new Error('db'); };
    await expect(loadArticleForReading(w.deps, 'plato', false)).rejects.toThrow('db');
  });
});

// ── orphaned highlights ──────────────────────────────────────────────────────

describe('reanchorOrphans / deleteOrphans', () => {
  const store = () => {
    const saved: Array<[number, string, string]> = [];
    const deleted: number[][] = [];
    return {
      saved, deleted,
      s: {
        updateAnnotationAnchor: async (id: number, t: string, h: string) => { saved.push([id, t, h]); },
        deleteAnnotations: async (ids: number[]) => { deleted.push(ids); },
      },
    };
  };

  test('saves the highlights it finds against the new hash, counts the rest, and words the result', async () => {
    const st = store();
    const orphans = [ann({ id: 1, selected_text: 'the good' }), ann({ id: 2, selected_text: 'zzzz qqqq' })];
    const out = await reanchorOrphans(st.s, orphans, '<p>the good life</p>', 'H2');
    expect(out.succeededIds).toEqual([1]);
    expect(out.failed).toBe(1);
    expect(out.total).toBe(2);
    expect(out.message).toBe('1 re-anchored. 1 could not be found in the new version.');
    expect(st.saved).toEqual([[1, 'the good', 'H2']]);
  });

  test('all found → "All N ..." with the right plural, and nothing found saves nothing', async () => {
    expect(reanchorMessage(1, 1)).toBe('All 1 highlight re-anchored to the new version.');
    expect(reanchorMessage(2, 2)).toBe('All 2 highlights re-anchored to the new version.');
    const st = store();
    const out = await reanchorOrphans(st.s, [ann({ selected_text: 'zzzz qqqq' })], '<p>x</p>', 'H');
    expect(out.succeededIds).toEqual([]);
    expect(st.saved).toEqual([]);
  });

  test('a save that fails rejects (so the screen does not report success)', async () => {
    const st = store();
    st.s.updateAnnotationAnchor = async () => { throw new Error('db'); };
    await expect(reanchorOrphans(st.s, [ann()], '<p>the good</p>', 'H')).rejects.toThrow('db');
  });

  test('deleteOrphans deletes then reports the ids; an empty list is passed through', async () => {
    const st = store();
    expect(await deleteOrphans(st.s, [3, 4])).toEqual([3, 4]);
    expect(await deleteOrphans(st.s, [])).toEqual([]);
    expect(st.deleted).toEqual([[3, 4], []]);
  });
});

// ── library tab ──────────────────────────────────────────────────────────────

describe('loadHomeData and the list helpers', () => {
  test('reads the 12 newest recents, the reading list and all highlights together', async () => {
    const limits: Array<number | undefined> = [];
    const out = await loadHomeData({
      reads: { getRecentSlugs: async l => { limits.push(l); return [{ slug: 'a', title: 'A' } as EntrySummary]; } },
      bookmarks: { getBookmarks: async () => [{ slug: 'b', title: 'B' } as EntrySummary] },
      annotations: { getAllAnnotations: async () => [annT()] },
    });
    expect(limits).toEqual([12]);
    expect(out.history.map(h => h.slug)).toEqual(['a']);
    expect(out.bookmarks.map(h => h.slug)).toEqual(['b']);
    expect(out.annotations).toHaveLength(1);
  });

  test('recentWithoutBookmarks matches the old inline filter', () => {
    const hist = ['a', 'b', 'c'].map(slug => ({ slug, title: slug }) as EntrySummary);
    const marks = [{ slug: 'b' }];
    const legacy = (() => { const s = new Set(marks.map(b => b.slug)); return hist.filter(h => !s.has(h.slug)); })();
    expect(recentWithoutBookmarks(hist, marks)).toEqual(legacy);
    expect(recentWithoutBookmarks([], marks)).toEqual([]);
  });

  test('mark read/unread flips at progress 1, with null and undefined meaning unread', () => {
    const legacy = (p: number | null | undefined) => ((p ?? 0) >= 1 ? 0 : 1);
    for (const p of [null, undefined, 0, 0.5, 0.99, 1, 1.2]) expect(toggledReadProgress(p)).toBe(legacy(p));
  });

  test('groupAnnotationsByArticle matches the old inline grouping and keeps first-seen order', () => {
    const anns = [annT({ id: 1, slug: 'b', article_title: 'B' }), annT({ id: 2, slug: 'a', article_title: null }), annT({ id: 3, slug: 'b', article_title: 'B' })];
    const legacy = (() => {
      const map = new Map<string, { slug: string; title: string | null; items: AnnotationWithTitle[] }>();
      for (const a of anns) { if (!map.has(a.slug)) map.set(a.slug, { slug: a.slug, title: a.article_title, items: [] }); map.get(a.slug)!.items.push(a); }
      return Array.from(map.values());
    })();
    expect(groupAnnotationsByArticle(anns)).toEqual(legacy);
    expect(groupAnnotationsByArticle(anns).map(g => [g.slug, g.items.length])).toEqual([['b', 2], ['a', 1]]);
    expect(groupAnnotationsByArticle([])).toEqual([]);
  });
});

// ── settings ─────────────────────────────────────────────────────────────────

describe('loadReaderSettings', () => {
  const meta = (m: Record<string, string>) => ({ getMeta: async (k: string) => m[k] ?? null });

  test('defaults when nothing is stored', async () => {
    expect(await loadReaderSettings(meta({}))).toEqual({ indexRefreshedAt: null, customCss: '', fontSize: 17, autoSync: 'off', linkPreview: true });
  });
  test('parses what is stored; only "0" turns link previews off', async () => {
    const s = await loadReaderSettings(meta({ index_refreshed_at: '1700000000000', custom_css: 'p{}', font_size: '21', auto_sync: '2days', link_preview: '0' }));
    expect(s).toEqual({ indexRefreshedAt: 1700000000000, customCss: 'p{}', fontSize: 21, autoSync: '2days', linkPreview: false });
    expect((await loadReaderSettings(meta({ link_preview: '1' }))).linkPreview).toBe(true);
    expect((await loadReaderSettings(meta({ link_preview: '' }))).linkPreview).toBe(true);
  });
  test('the stored form of the link-preview switch round-trips', () => {
    expect(linkPreviewValue(true)).toBe('1');
    expect(linkPreviewValue(false)).toBe('0');
  });
});

// ── auto deep sync (rule moved out of useBoot) ───────────────────────────────

describe('autoDeepSyncDue', () => {
  const DAY = 86_400_000;
  // The inline rule from useBoot, verbatim, as the reference.
  const legacy = (autoSync: string | null, last: string | null, now: number) => {
    if (autoSync && autoSync !== 'off') {
      const days = autoSync === '2days' ? 2 : 7;
      const elapsed = now - (last ? Number(last) : 0);
      if (elapsed > days * 24 * 60 * 60 * 1000) return true;
    }
    return false;
  };

  test('matches the old inline rule across settings, ages and the exact boundary', () => {
    const now = 1_000 * DAY;
    for (const a of [null, '', 'off', '2days', 'weekly', 'other']) {
      for (const last of [null, String(now), String(now - 2 * DAY), String(now - 2 * DAY - 1), String(now - 7 * DAY), String(now - 7 * DAY - 1), '0']) {
        expect({ a, last, due: autoDeepSyncDue(a, last, now) }).toEqual({ a, last, due: legacy(a, last, now) });
      }
    }
  });

  test('runs the sync only when due, with the clock from the port', async () => {
    let ran = 0;
    const base = { sync: async () => { ran++; } };
    const m = (auto: string | null, last: string | null) => ({ getMeta: async (k: string) => (k === 'auto_sync' ? auto : last) });
    expect(await runAutoDeepSync({ ...base, meta: m('weekly', null), clock: { now: () => 10 * 86_400_000 } })).toBe(true);
    expect(await runAutoDeepSync({ ...base, meta: m('weekly', String(9 * 86_400_000)), clock: { now: () => 10 * 86_400_000 } })).toBe(false);
    expect(await runAutoDeepSync({ ...base, meta: m('off', null), clock: { now: () => 10 * 86_400_000 } })).toBe(false);
    expect(ran).toBe(1);
  });

  test('a sync that fails rejects (the idle scheduler swallows it)', async () => {
    await expect(runAutoDeepSync({
      meta: { getMeta: async (k: string) => (k === 'auto_sync' ? 'weekly' : null) }, clock: { now: () => 1e12 }, sync: async () => { throw new Error('net'); },
    })).rejects.toThrow('net');
  });
});

// ── Zotero send ──────────────────────────────────────────────────────────────

describe('prepareZoteroSend / zoteroSavedMessage', () => {
  const stores = (creds: { apiKey: string; userId: string }, anns: Annotation[] = []) => {
    const reads: string[] = [];
    return {
      reads,
      s: {
        prefs: { getZoteroPrefs: async () => creds },
        annotations: { getAnnotationsForSlug: async (slug: string) => { reads.push(slug); return anns; } },
      },
    };
  };

  test('missing key or user id means not configured, and highlights are not read', async () => {
    for (const creds of [{ apiKey: '', userId: '1' }, { apiKey: 'k', userId: '' }, { apiKey: '', userId: '' }]) {
      const st = stores(creds);
      expect(await prepareZoteroSend(st.s, 'plato')).toEqual({ status: 'not_configured' });
      expect(st.reads).toEqual([]);
    }
  });
  test('configured: returns the credentials and the article\'s highlights', async () => {
    const st = stores({ apiKey: 'k', userId: '7' }, [ann()]);
    expect(await prepareZoteroSend(st.s, 'plato')).toEqual({ status: 'ready', apiKey: 'k', userId: '7', annotations: [ann()] });
    expect(st.reads).toEqual(['plato']);
  });
  test('the saved message matches the old inline text for 0, 1, many, and mixed versions', () => {
    const legacy = (title: string, annotations: Pick<Annotation, 'content_hash'>[]) => {
      const versionCount = new Set(annotations.map(a => a.content_hash ?? '__current__')).size;
      const versionNote = versionCount > 1 ? ` across ${versionCount} versions` : '';
      return annotations.length > 0
        ? `"${title}" and ${annotations.length} highlight${annotations.length > 1 ? 's' : ''}${versionNote} added to your Zotero library.`
        : `"${title}" was added to your Zotero library.`;
    };
    const cases: Array<Pick<Annotation, 'content_hash'>[]> = [
      [], [{ content_hash: null }], [{ content_hash: 'a' }, { content_hash: 'a' }],
      [{ content_hash: 'a' }, { content_hash: 'b' }], [{ content_hash: null }, { content_hash: 'a' }],
    ];
    for (const c of cases) expect(zoteroSavedMessage('Plato', c)).toBe(legacy('Plato', c));
  });
});
