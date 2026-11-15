// The TeX-to-placeholder substitution with fakes: a scripted equation cache and an in-memory
// preference. No renderer, no database, no timers.
import { createSubstituteMath, tieredMathEnabled } from '../substituteMath';
import type { SubstituteMathDeps } from '../substituteMath';
import { mathHash } from '../../utils/mathKey';
import type { MathPriority } from '../../utils/mathThrottlePolicy';

function world(o: { complete?: boolean; missing?: string[]; tiered?: string | null; metaFails?: boolean } = {}) {
  const calls: Array<{ spots: Array<{ tex: string; display: boolean }>; priority: MathPriority | null }> = [];
  let checkpoints = 0;
  const slicePriorities: Array<MathPriority | null> = [];
  const deps: SubstituteMathDeps = {
    ensureMath: async (spots, priority) => {
      calls.push({ spots, priority });
      const dims = new Map<string, { w: number; h: number }>();
      for (const s of spots) {
        if (o.missing?.includes(s.tex)) continue;
        dims.set(mathHash(s.tex, s.display), { w: 2.5, h: 1 });
      }
      return { dims, complete: o.complete ?? true };
    },
    meta: { getMeta: async k => { if (o.metaFails) throw new Error('db'); return k === 'tiered_math' ? (o.tiered ?? null) : null; } },
    mathSlice: p => { slicePriorities.push(p); return { checkpoint: async () => { checkpoints++; } }; },
  };
  return { substitute: createSubstituteMath(deps), calls, checkpoints: () => checkpoints, slicePriorities };
}

const realFetch = (globalThis as any).fetch;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('core read the clock'); });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => { throw new Error('core used a timer'); }) as any);
  (globalThis as any).fetch = () => { throw new Error('core called fetch'); };
});
afterEach(() => { jest.restoreAllMocks(); (globalThis as any).fetch = realFetch; });

const tag = (tex: string, display: boolean) =>
  `<math-i hash="${mathHash(tex, display)}" d="${display ? '1' : '0'}" w="2.5000" h="1.0000"></math-i>`;

describe('createSubstituteMath with fakes', () => {
  test('inline and display TeX become placeholders carrying hash, size and display flag', async () => {
    const w = world();
    const out = await w.substitute('<p>Let \\(x\\) and \\[y = 2\\] hold.</p>');
    expect(out).toBe(`<p>Let ${tag('x', false)} and ${tag('y = 2', true)} hold.</p>`);
  });

  test('HTML entities in the TeX are decoded before hashing and rendering', async () => {
    const w = world();
    await w.substitute('<p>\\(a &lt; b\\)</p>');
    expect(w.calls[0].spots).toEqual([{ tex: 'a < b', display: false }]);
  });

  test('no TeX: the HTML is returned untouched and the cache is not consulted', async () => {
    const w = world();
    expect(await w.substitute('<p>plain \\(unclosed</p>')).toBe('<p>plain \\(unclosed</p>');
    expect(w.calls).toEqual([]);
  });

  test('an incomplete render leaves the article untouched (it stays pending)', async () => {
    const w = world({ complete: false });
    const html = '<p>\\(x\\)</p>';
    expect(await w.substitute(html)).toBe(html);
    expect(w.checkpoints()).toBe(0);
  });

  test('TeX the cache has no size for stays raw; the rest is replaced', async () => {
    const w = world({ missing: ['bad'] });
    expect(await w.substitute('<p>\\(bad\\) \\(ok\\)</p>')).toBe(`<p>\\(bad\\) ${tag('ok', false)}</p>`);
  });

  test('the priority is passed on: current by default, null when the caller owns the schedule', async () => {
    const w = world();
    await w.substitute('<p>\\(a\\)</p>');
    await w.substitute('<p>\\(b\\)</p>', 'background');
    await w.substitute('<p>\\(c\\)</p>', null);
    expect(w.calls.map(c => c.priority)).toEqual(['current', 'background', null]);
    expect(w.slicePriorities).toEqual(['current', 'background', null]);
  });

  test('one slice checkpoint per equation while splicing', async () => {
    const w = world();
    await w.substitute('<p>\\(a\\) \\(b\\) \\(c\\)</p>');
    expect(w.checkpoints()).toBe(3);
  });

  test('repeated calls on the same input give the same output', async () => {
    const w = world();
    const html = '<p>\\(a\\) and \\(b\\)</p>';
    const first = await w.substitute(html);
    for (let i = 0; i < 4; i++) expect(await w.substitute(html)).toBe(first);
  });

  describe('tiered math (flag-gated)', () => {
    test('off by default, so every equation goes to the renderer', async () => {
      const w = world();
      await w.substitute('<p>\\(x\\)</p>');
      expect(w.calls[0].spots).toHaveLength(1);
    });
    test("a stored '0' keeps it off and a failing preference read falls back to the default", async () => {
      expect(await tieredMathEnabled({ getMeta: async () => '0' })).toBe(false);
      expect(await tieredMathEnabled({ getMeta: async () => { throw new Error('db'); } })).toBe(false);
      expect(await tieredMathEnabled({ getMeta: async () => 'banana' })).toBe(false);
    });
    test("a stored '1' turns it on: trivially simple TeX is replaced by text and never reaches the renderer", async () => {
      expect(await tieredMathEnabled({ getMeta: async () => '1' })).toBe(true);
      const w = world({ tiered: '1' });
      const out = await w.substitute('<p>\\(x\\)</p>');
      expect(out).not.toContain('\\(x\\)');
      expect(w.calls).toEqual([]);                 // nothing left for MathJax
    });
  });
});
