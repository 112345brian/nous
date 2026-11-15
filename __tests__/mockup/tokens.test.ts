// TOKEN-xx + HOME-TABS-xx — design tokens and the inline home tabs (NAV-xx bottom nav was removed).
import { SRC, flat } from './_src';

describe('TOKEN — design tokens', () => {
  const home = () => SRC.home();
  const toc = () => SRC.toc();
  // Colours now live in one place (src/theme/tokens.ts); the dark palette is the spec.
  const dark = () => {
    const t = SRC.tokens();
    return t.slice(t.indexOf('const dark'), t.indexOf('const light'));
  };

  test('TOKEN-01 bg #111111', () => expect(dark()).toContain("bg: '#111111'"));
  test('TOKEN-02 bg-surface #1c1c1c', () => expect(dark()).toContain("surface: '#1c1c1c'"));
  test('TOKEN-03 bg-elevated #252525', () => expect(dark()).toContain("elevated: '#252525'"));
  test('TOKEN-05 border #2e2e2e', () => expect(dark()).toContain("border: '#2e2e2e'"));
  test('TOKEN-06 border-subtle #222222', () => expect(dark()).toContain("borderSubtle: '#222222'"));
  test('TOKEN-07 text #e4e4e4', () => expect(dark()).toContain("text: '#e4e4e4'"));
  // Spec changed with the contrast pass: #9a9a9a → #a8a8a8 (7.6:1 on bg).
  test('TOKEN-08 text-sec #a8a8a8', () => expect(dark()).toContain("textSecondary: '#a8a8a8'"));
  // Spec changed deliberately: #555555 is 2.5:1 on #111 (fails WCAG AA). The hint
  // role now resolves to the shared token src/theme/tokens.ts `textMuted` (#909090).
  test('TOKEN-09 text-hint uses the AA-contrast token', () => expect(home()).toContain('colors.textMuted'));
  test('TOKEN-10 accent #5b8ef5', () => expect(dark()).toContain("accent: '#5b8ef5'"));
  test('TOKEN-11 accent-dim rgba(91,142,245,.14)', () =>
    expect(home()).toMatch(/rgba\(91,\s*142,\s*245,\s*\.?0?\.14\)/));
  test('TOKEN-12 accent-border rgba(91,142,245,.35)', () =>
    expect(home()).toMatch(/rgba\(91,\s*142,\s*245,\s*\.?0?\.35\)/));
  test('TOKEN-13 highlight yellow #fbbf24', () => expect(toc()).toContain('#fbbf24'));
  test('TOKEN-14 highlight green #34d399', () => expect(toc()).toContain('#34d399'));
  test('TOKEN-15 highlight blue #60a5fa', () => expect(toc()).toContain('#60a5fa'));
  test('TOKEN-16 highlight pink #f472b6', () => expect(toc()).toContain('#f472b6'));
  test('TOKEN-19 svg stroke width 1.8', () => expect(home()).toMatch(/strokeWidth=\{1\.8\}/));
});

describe('HOME-TABS — inline tabs (replaced the bottom nav; see MOCKUP_SPEC NAV section)', () => {
  const home = () => flat(SRC.home());

  test('HOME-TABS-01 Reading, Notes and Browse tabs in that order', () => {
    const h = home();
    const r = h.indexOf('>Reading</Text>'), n = h.indexOf('>Notes</Text>'), b = h.indexOf('>Browse</Text>');
    expect(r).toBeGreaterThan(-1);
    expect(n).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(n);
  });
  test('HOME-TABS-02 active tab shows an underline; no bottom nav bar remains', () => {
    expect(home()).toMatch(/tabUnderline/);
    expect(home()).not.toMatch(/\bbnPill\b|\bbn:\s*\{/);
  });
});
