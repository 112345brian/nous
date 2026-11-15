export {};
// Guards for the accessibility / platform fixes from the audit. Source-level so
// they run without a device: a regression fails here instead of in review.
declare const __dirname: string;
declare function require(mod: string): any;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const srcFiles: string[] = walk(path.join(root, 'src'));
const read = (f: string): string => fs.readFileSync(f, 'utf8');
const rel = (f: string) => path.relative(root, f);

function lum(hex: string) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('text contrast', () => {
  // Decorative or on-accent colours that are intentionally not body-contrast text.
  const allowed = new Set(['#111', '#0a0f1e', '#333']);
  it('no text colour falls below 4.5:1 on the lightest dark surface (#252525)', () => {
    const bad: string[] = [];
    for (const f of srcFiles.concat([path.join(root, 'App.tsx')])) {
      read(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(?<![A-Za-z])color: *'(#[0-9a-fA-F]{3,6})'/g)) {
          if (allowed.has(m[1].toLowerCase())) continue;
          if (contrast(m[1], '#252525') < 4.5) bad.push(`${rel(f)}:${i + 1} ${m[1]}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });
});

describe('controls', () => {
  it('every TouchableOpacity / Pressable declares a role', () => {
    const bad: string[] = [];
    for (const f of srcFiles.filter(f => f.endsWith('.tsx'))) {
      const s = read(f);
      for (const m of s.matchAll(/<(TouchableOpacity|Pressable)\b/g)) {
        // look at the opening tag up to ~700 chars; role must appear before the tag closes
        const chunk = s.slice(m.index!, m.index! + 700);
        const tagEnd = chunk.search(/>\s*(\n|<|\{)/);
        const tag = tagEnd > 0 ? chunk.slice(0, tagEnd) : chunk;
        // The paragraph wrapper is long-press-to-annotate, not a button.
        if (rel(f).endsWith('render/Blocks.tsx')) continue;
        if (!/accessibilityRole|accessible=\{false\}/.test(tag)) bad.push(`${rel(f)}:${s.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('icon-only buttons on Home and Graph are named', () => {
    const home = read(path.join(root, 'src/screens/HomeScreen.tsx'));
    expect(home).toMatch(/accessibilityLabel="Settings"/);
    expect(home).toMatch(/'Collapse' : 'Expand'/);
    expect(home).toMatch(/'Remove bookmark' : 'Bookmark'/);
    expect(read(path.join(root, 'src/screens/GraphScreen.tsx'))).toMatch(/accessibilityLabel="Back"/);
  });
});

describe('motion', () => {
  it('only utils/motion.ts drives sheet springs (so Reduce Motion is honored)', () => {
    const offenders = srcFiles
      .filter(f => !f.endsWith('utils/motion.ts'))
      .filter(f => /Animated\.spring\(/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
  it('graph and navigation transitions honor Reduce Motion', () => {
    expect(read(path.join(root, 'src/screens/GraphScreen.tsx'))).toMatch(/reduceMotion: ReduceMotion\.System/);
    expect(read(path.join(root, 'App.tsx'))).toMatch(/isReduceMotion\(\) \? 'fade'/);
  });
});

describe('platform conformance', () => {
  const article = read(path.join(root, 'src/screens/ArticleScreen.tsx'));
  it('custom edge-back is Android-only', () => {
    expect(article).toMatch(/\.enabled\(Platform\.OS === 'android'\)/);
  });
  it('overlays close on Android Back', () => {
    expect((article.match(/useBackDismiss\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it('orientation is not locked and the UI style is declared', () => {
    const app = JSON.parse(read(path.join(root, 'app.json')));
    expect(app.expo.orientation).toBe('default');
    expect(app.expo.userInterfaceStyle).toBe('automatic');
  });
  it('the reader caps its line length', () => {
    expect(read(path.join(root, 'src/utils/sepHtml/render/SepArticle.tsx'))).toMatch(/maxWidth: measure/);
  });
});

describe('type floor', () => {
  it('no text smaller than 11', () => {
    const bad = srcFiles.filter(f => /fontSize: *(\d|10)\b(?!\.)/.test(read(f).replace(/fontSize: *\d{2,}/g, ''))).map(rel);
    expect(bad).toEqual([]);
  });
});

describe('wide windows', () => {
  it('list screens are centred in a capped column', () => {
    const app = read(path.join(root, 'App.tsx'));
    for (const n of ['Home', 'History', 'ReadingList', 'Settings', 'Annotations']) {
      expect(app).toMatch(new RegExp(`name="${n}" component=\\{Framed${n}\\}`));
    }
    expect(read(path.join(root, 'src/components/WideFrame.tsx'))).toMatch(/maxWidth: WIDE_COLUMN_MAX/);
  });
});

describe('graph text alternative', () => {
  const graph = read(path.join(root, 'src/screens/GraphScreen.tsx'));
  it('offers a list view of the same nodes', () => {
    expect(graph).toMatch(/Show as list/);
    expect(graph).toMatch(/listRows/);
    expect(graph).toMatch(/<FlatList/);
  });
  it('names each list row for screen readers', () => {
    expect(graph).toMatch(/accessibilityLabel=\{`\$\{item\.title\}/);
  });
});
