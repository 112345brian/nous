export {}; // makes this a module so the local `require` declare below isn't global

// Guard: `getEntry` loads the whole row (content_html + content_ast +
// notes_html). A caller that only needs one piece should use getEntryHtml or
// getEntryMeta instead. This test fails when a new `getEntry(` caller appears
// without being added here on purpose.
declare const __dirname: string;
declare function require(mod: string): any;
const { readdirSync, readFileSync, statSync } = require('fs');
const { join, relative } = require('path');

const ROOT = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Files that legitimately need the full row, and why.
const ALLOWED_FULL_ROW_CALLERS: Record<string, string> = {
  'src/services/db.ts': 'defines getEntry',
  'src/core/ports.ts': 'declares getEntry on LibraryReadStore',
  'src/core/loadArticle.ts':
    'loadArticleForReading(): needs AST + html (hash, annotation check, link index, WebView fallback)',
  'src/screens/ArticleScreen.tsx':
    'the native renderer reads content_ast once the reader is idle (libraryRead.getEntry)',
  'src/tests/runTests.ts': 'on-device test runner asserts stored fields',
};

describe('getEntry callers', () => {
  it('only allow-listed files call getEntry( — others use the narrow readers', () => {
    const offenders: string[] = [];
    const files = [...walk(join(ROOT, 'src')), join(ROOT, 'App.tsx')];
    for (const f of files) {
      const rel = relative(ROOT, f);
      const text = readFileSync(f, 'utf8') as string;
      if (/\bgetEntry\(/.test(text) && !(rel in ALLOWED_FULL_ROW_CALLERS)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('allow-list has no stale entries', () => {
    for (const rel of Object.keys(ALLOWED_FULL_ROW_CALLERS)) {
      const text = readFileSync(join(ROOT, rel), 'utf8') as string;
      expect(/\bgetEntry\(|function getEntry\b/.test(text)).toBe(true);
    }
  });
});
