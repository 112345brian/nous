export {}; // module scope: keeps local declarations from colliding with other tests
// Guard rails for the priority model (see docs/math-throttling.md): a rule in
// prose gets forgotten, a failing test does not.
declare const __dirname: string; // repo has no @types/node; jest provides these at runtime
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const ROOT = path.join(SRC, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'assets') walk(p, out); }
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}
const files = [...walk(SRC), path.join(ROOT, 'App.tsx')];
const rel = (p: string) => path.relative(ROOT, p);

test('only the chunked wrapper calls renderMathBatch (nothing sends one giant batch)', () => {
  const offenders = files.filter(f => /renderMathBatch\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map(rel).filter(f => !/src\/services\/(mathRender|mathChunked)\.ts$/.test(f));
  expect(offenders).toEqual([]);
});

test('every yield point is awaited (a discarded promise would not pause anything)', () => {
  const re = /((?:[\w$]+\.)*)(whenMathMayRun|yieldThenMathMayRun|whenMayRun|yieldThenMayRun|checkpoint)\(/g;
  const bad: string[] = [];
  for (const f of files) {
    if (/idleScheduler\.ts$|mathPriority\.ts$/.test(f)) continue; // definitions
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(code))) {
        if (!/\b(await|return)\s+$/.test(code.slice(0, m.index))) bad.push(`${rel(f)}:${i + 1}`);
      }
    });
  }
  expect(bad).toEqual([]);
});

test('bulk-download entry points take a download hold; seed import call sites do too', () => {
  // The two wrappers live in the composition root (the use cases are in src/core).
  const root = fs.readFileSync(path.join(SRC, 'composition.ts'), 'utf8');
  expect(root).toMatch(/export function downloadAll[\s\S]*?withDownloadHold/);
  expect(root).toMatch(/export function syncCachedArticles[\s\S]*?withDownloadHold/);
  for (const f of [path.join(ROOT, 'App.tsx'), path.join(SRC, 'screens/SettingsScreen.tsx')]) {
    const t = fs.readFileSync(f, 'utf8');
    const calls = t.match(/importSeedFromUrl\(/g) ?? [];
    const held = t.match(/withDownloadHold\(\(\) => importSeedFromUrl\(/g) ?? [];
    expect(held.length).toBe(calls.length);
  }
});

test('the article load path still takes a reading hold', () => {
  const t = fs.readFileSync(path.join(SRC, 'screens/ArticleScreen.tsx'), 'utf8');
  expect(t).toMatch(/idleScheduler\.hold\(/);
});
