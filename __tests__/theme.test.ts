export {};
declare const __dirname: string;
declare function require(mod: string): any;
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

import { palettes, colors, setScheme, getScheme, themedStyles, roleMap } from '../src/theme/tokens';
import { parseAppearance, resolveScheme } from '../src/theme/ThemeProvider';

function lum(hex: string) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

afterEach(() => setScheme('dark'));

describe('palettes', () => {
  it('light defines every role dark does, and vice versa', () => {
    expect(Object.keys(palettes.light).sort()).toEqual(Object.keys(palettes.dark).sort());
  });

  for (const scheme of ['dark', 'light'] as const) {
    const p = palettes[scheme] as Record<string, string>;
    const surfaces = [p.bg, p.surface, p.elevated];
    it(`${scheme}: every text role is AA (4.5:1) on every surface`, () => {
      for (const role of ['text', 'textSecondary', 'textMuted', 'prose', 'proseStrong', 'accent', 'accentSoft', 'danger']) {
        for (const s of surfaces) expect(contrast(p[role], s)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${scheme}: accent notice text meets AA on its wash`, () => {
      expect(contrast(p.warnText, p.warnWash)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.accent, p.accentWash)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${scheme}: text on an accent-filled button is readable`, () => {
      expect(contrast(p.onAccentText, p.accent)).toBeGreaterThanOrEqual(3);
    });
  }

  it('light is warm paper: not pure white, not pure black', () => {
    expect(palettes.light.bg.toLowerCase()).not.toBe('#ffffff');
    expect(palettes.light.text.toLowerCase()).not.toBe('#000000');
  });

  it('keeps the original dark look for the core roles', () => {
    expect(palettes.dark).toMatchObject({
      bg: '#111111', surface: '#1c1c1c', elevated: '#252525', border: '#2e2e2e',
      text: '#e4e4e4', textMuted: '#909090', accent: '#5b8ef5',
    });
  });
});

describe('scheme resolution', () => {
  it('colors resolve at read time', () => {
    setScheme('dark');
    expect(colors.bg).toBe(palettes.dark.bg);
    setScheme('light');
    expect(colors.bg).toBe(palettes.light.bg);
    expect(getScheme()).toBe('light');
  });

  it('themedStyles builds once per scheme and follows the current scheme', () => {
    let builds = 0;
    const styles = themedStyles(() => { builds++; return { box: { backgroundColor: colors.bg } }; });
    setScheme('dark');
    expect(styles.box.backgroundColor).toBe(palettes.dark.bg);
    expect(styles.box.backgroundColor).toBe(palettes.dark.bg);
    setScheme('light');
    expect(styles.box.backgroundColor).toBe(palettes.light.bg);
    setScheme('dark');
    expect(styles.box.backgroundColor).toBe(palettes.dark.bg);
    expect(builds).toBe(2);
  });

  it('roleMap maps local names onto roles and passes raw values through', () => {
    const C = roleMap({ page: 'bg', wash: 'rgba(1,2,3,.1)' });
    setScheme('light');
    expect(C.page).toBe(palettes.light.bg);
    expect(C.wash).toBe('rgba(1,2,3,.1)');
  });

  it('parseAppearance tolerates junk', () => {
    expect(parseAppearance('light')).toBe('light');
    expect(parseAppearance('dark')).toBe('dark');
    for (const v of [null, undefined, '', 'sepia', 'LIGHT', '{}']) expect(parseAppearance(v as any)).toBe('system');
  });

  it('system appearance follows the OS, defaulting to dark when unknown', () => {
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', null)).toBe('dark');
    expect(resolveScheme('system', undefined)).toBe('dark');
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });
});

describe('screens use roles, not hex', () => {
  // Data colours that are the same in both schemes: annotation highlights, and
  // text/glyphs drawn on fixed-colour buttons.
  const allowed = /^#(fbbf24|34d399|60a5fa|f472b6|f87171|a78bfa|ffe566|66dd99|66aaff|ff6b6b|fff|000|111|ffffff|7ba4ff)$/i;
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['__tests__', 'theme'].includes(e.name)) walk(p, out); }
      else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  it('no screen or component hard-codes a chrome colour', () => {
    const skip = /injectedAssets|readerCss|annotationJs|TestRunnerScreen|render\/theme\.ts/;
    const bad: string[] = [];
    const files = walk(path.join(root, 'src')).concat([path.join(root, 'App.tsx')]);
    for (const f of files) {
      if (skip.test(f)) continue;
      fs.readFileSync(f, 'utf8').split('\n').forEach((line: string, i: number) => {
        for (const m of line.matchAll(/['"](#[0-9a-fA-F]{3,6})['"]/g)) {
          if (!allowed.test(m[1])) bad.push(`${path.relative(root, f)}:${i + 1} ${m[1]}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('no module reads colors at import time (it would freeze the first scheme)', () => {
    // A top-level `const X = { … colors.role … }` is evaluated once, at import.
    const bad: string[] = [];
    const files = walk(path.join(root, 'src')).concat([path.join(root, 'App.tsx')]);
    for (const f of files) {
      if (/theme\/tokens/.test(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/^(export )?const \w+(: [^=]+)? = [{[]/.test(lines[i]) || /themedStyles|roleMap/.test(lines[i])) continue;
        let depth = 0; let j = i; let hit = false;
        for (; j < lines.length; j++) {
          depth += (lines[j].match(/[{[]/g) ?? []).length - (lines[j].match(/[}\]]/g) ?? []).length;
          if (/\bcolors\./.test(lines[j])) hit = true;
          if (depth <= 0) break;
        }
        if (hit) bad.push(`${path.relative(root, f)}:${i + 1}`);
        i = j;
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('wiring', () => {
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  it('App wraps everything in the provider and passes the scheme to navigation', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/<ThemeProvider store=\{metaStore\}>/);
    expect(app).toMatch(/navTheme\(scheme\)/);
    expect(app).toMatch(/barStyle=\{scheme === 'light' \? 'dark-content' : 'light-content'\}/);
  });
  it('the reader re-renders on a scheme change without remounting', () => {
    expect(read('App.tsx')).toMatch(/withTheme\(ArticleScreen, false\)/);
  });
  it('Settings offers Auto / Light / Dark and persists it', () => {
    const s = read('src/screens/SettingsScreen.tsx');
    expect(s).toMatch(/'system', 'light', 'dark'/);
    expect(s).toMatch(/setAppearance\(a\)/);
    expect(read('src/theme/ThemeProvider.tsx')).toMatch(/store\.setMeta\('appearance'/);
  });
  it('reader theme is cached per scheme', () => {
    expect(read('src/ui/sepHtml/render/theme.ts')).toMatch(/getScheme\(\) === 'light' \? -base : base/);
  });
});
