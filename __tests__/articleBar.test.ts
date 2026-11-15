export {};
// Source-level checks for the article app bar (same approach as __tests__/mockup).
// The reader's core study actions must be one labeled tap away, not behind a
// gesture or an unlabeled menu.
declare const __dirname: string;
declare function require(mod: string): any;
const { readFileSync } = require('fs');
const { join } = require('path');

const article: string = readFileSync(join(__dirname, '..', 'src/screens/ArticleScreen.tsx'), 'utf8');
const home: string = readFileSync(join(__dirname, '..', 'src/screens/HomeScreen.tsx'), 'utf8');
const app: string = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');

const bar = article.slice(article.indexOf('styles.appBar'), article.indexOf('Loading states'));

describe('article app bar', () => {
  it('puts contents, bookmark and graph directly in the bar', () => {
    expect(bar).toMatch(/onPress=\{openToc\}/);
    expect(bar).toMatch(/onPress=\{handleBookmark\}/);
    expect(bar).toMatch(/onPress=\{openGraph\}/);
  });

  it('labels every icon button', () => {
    const buttons = bar.split('<IBtn').slice(1);
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    // label sits in the opening tag, before the icon child
    for (const b of buttons) expect(b.split('<Icon')[0]).toMatch(/label=(\{[^}]+\}|"[^"]+")/);
  });

  it('keeps at most four actions on the right (back excluded)', () => {
    const buttons = bar.match(/<IBtn\b/g) ?? [];
    expect(buttons.length - 1).toBeLessThanOrEqual(4);
  });

  it('bookmark label reflects state', () => {
    expect(bar).toMatch(/bookmarked \? 'Remove bookmark' : 'Bookmark this article'/);
  });

  it('opens the contents sheet through one animated path', () => {
    // Mounting the sheet alone leaves it off-screen; every opener must animate.
    expect(article).not.toMatch(/onPress=\{\(\) => setShowToc\(true\)\}/);
    expect(article.match(/onPress=\{openToc\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(article).toMatch(/const openToc = useCallback\(\(\) => \{[\s\S]*?springTo\(tocSlideAnim, 0\)/);
  });

  it('touch targets are at least 48dp', () => {
    expect(article).toMatch(/iBtn: \{\s*width: 48, height: 48/);
  });

  it('search no longer masquerades as a back-to-root icon', () => {
    expect(bar).not.toMatch(/popToTop/);
    expect(bar).toMatch(/popTo\('Home', \{ openSearch: true \}\)/);
  });
});

describe('Home accepts the openSearch hand-off', () => {
  it('declares the param and consumes it once', () => {
    expect(app).toMatch(/Home: \{ openSearch\?: boolean \} \| undefined/);
    expect(home).toMatch(/route\.params\?\.openSearch === true/);
    expect(home).toMatch(/nav\.setParams\(\{ openSearch: false \}\)/);
  });
});
