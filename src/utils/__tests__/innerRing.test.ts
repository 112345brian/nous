// Enforces the architecture rule: the INNER RING does no I/O.
//
// Rings (final)
//   inner (pure):  src/types.ts, src/data/**, src/utils/**, src/core/**
//                  src/utils is pure helpers; src/core holds the ports (interfaces) and the use
//                  cases, which take the ports as parameters. Adapters in src/services implement
//                  the ports, never the reverse. src/utils has NO React, React Native or Expo
//                  import at all: UI code lives in src/ui (and src/screens, src/components,
//                  src/boot, src/theme).
//   outer (I/O):   src/services/**, src/ui/**, src/screens/**, src/components/**, src/boot/**,
//                  src/theme/**, src/tests/**, src/composition.ts, App.tsx
//
// An inner-ring file must not: import from an outer-ring directory (so no concrete adapter
// such as services/db, expo-sqlite, expo-file-system), import any package other than the
// allowlist, load modules dynamically (require / import()), call I/O, timer or clock APIs,
// read process.env, or keep module-level mutable state (a hidden singleton). There are no
// exceptions today. Files are parsed with the TypeScript compiler, so strings, comments and
// regexes (e.g. the JS-in-a-string constants in injectedAssets.ts) never cause false positives.
// Everything flows through scanSource(), which is self-tested below.
import ts from 'typescript';

declare function require(mod: string): any;
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const ROOT: string = path.join(__dirname, '..', '..', '..');

// Pure parsing packages the inner ring may depend on.
const ALLOWED_PACKAGES = new Set(['htmlparser2']);
// Repo-relative prefixes that belong to the outer ring.
const OUTER_PREFIXES = [
  'src/services/', 'src/screens/', 'src/components/', 'src/boot/', 'src/tests/', 'src/composition', 'src/theme/',
  'src/ui/', 'App', 'index',
];
const FORBIDDEN_CALLS = new Set([
  'fetch', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask',
]);
const FORBIDDEN_CTORS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker']);
const FORBIDDEN_MEMBERS = new Set(['Date.now', 'performance.now', 'Math.random']);

export interface Violation { file: string; line: number; what: string }

// Recorded, reasoned exceptions. None today; an entry must name the file and the exact finding, and
// the test below fails if the entry stops matching a real violation, so it cannot outlive its reason.
const KNOWN_EXCEPTIONS: Array<{ file: string; what: string; reason: string }> = [];

export function scanSource(file: string, text: string): Violation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Violation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (n: ts.Node, what: string) => out.push({ file, line: at(n), what });

  const checkSpecifier = (n: ts.Node, spec: string) => {
    if (spec.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (OUTER_PREFIXES.some(p => target === p.replace(/\/$/, '') || target.startsWith(p))) {
        add(n, `imports outer-ring module "${spec}" (${target})`);
      }
    } else if (!ALLOWED_PACKAGES.has(spec)) {
      add(n, `imports package "${spec}" (allowed: ${[...ALLOWED_PACKAGES].join(', ')})`);
    }
  };

  // Hidden singletons: top-level `let`/`var`, or a top-level `new Map/Set/WeakMap/WeakSet`.
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const d of st.declarationList.declarations) {
      if (!isConst) add(d, `module-level mutable binding "${d.name.getText(sf)}"`);
      else if (d.initializer && ts.isNewExpression(d.initializer) && ts.isIdentifier(d.initializer.expression)
        && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(d.initializer.expression.text)
        && (d.initializer.arguments?.length ?? 0) === 0) {  // an empty one is a cache; a seeded one is a constant table
        add(d, `module-level ${d.initializer.expression.text} "${d.name.getText(sf)}" is hidden shared state`);
      }
    }
  }

  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'process') {
      add(n, 'reads process.* (pass the environment in)');
    }
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      checkSpecifier(n, n.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(n)) add(n, 'import = require() is not allowed');
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword) add(n, 'dynamic import()');
      else if (ts.isIdentifier(e) && e.text === 'require') add(n, 'require()');
      else if (ts.isIdentifier(e) && FORBIDDEN_CALLS.has(e.text)) add(n, `calls ${e.text}()`);
      else if (ts.isIdentifier(e) && e.text === 'Date') add(n, 'Date() reads the clock');
      else if (ts.isPropertyAccessExpression(e)) {
        const name = `${e.expression.getText(sf)}.${e.name.text}`;
        if (FORBIDDEN_MEMBERS.has(name)) add(n, `calls ${name}()`);
        if (['globalThis', 'window', 'global', 'self'].includes(e.expression.getText(sf)) && (FORBIDDEN_CALLS.has(e.name.text))) add(n, `calls ${name}()`);
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (FORBIDDEN_CTORS.has(name)) add(n, `new ${name}()`);
      if (name === 'Date' && (n.arguments?.length ?? 0) === 0) add(n, 'new Date() reads the clock');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Repo-relative paths (posix) of every inner-ring source file. */
export function innerRingFiles(): string[] {
  const files: string[] = ['src/types.ts'];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (ent.name === '__tests__') continue;
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(ent.name)) {
        files.push(rel);
      }
    }
  };
  walk('src/utils');
  walk('src/data');
  walk('src/core');
  return files;
}

describe('inner ring has no I/O', () => {
  const files = innerRingFiles();

  test('the ring is non-trivial (guards against a silently empty scan)', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of ['src/types.ts', 'src/utils/forceLayout.ts', 'src/utils/linkifier.ts', 'src/utils/sepHtml/parse.ts',
      'src/utils/sepPage.ts', 'src/utils/citation.ts', 'src/utils/contentHash.ts', 'src/utils/mathKey.ts',
      'src/core/ports.ts', 'src/core/syncUserData.ts', 'src/core/zotero.ts', 'src/utils/syncPath.ts',
      'src/core/refreshIndex.ts', 'src/utils/sepIndex.ts', 'src/core/cacheArticle.ts', 'src/utils/sepArticlePage.ts',
      'src/core/mathCompletion.ts', 'src/utils/sepMath.ts', 'src/core/libraryDownload.ts',
      'src/core/backfills.ts', 'src/core/ensureNotes.ts', 'src/core/idleScheduler.ts', 'src/core/mathPacing.ts',
      'src/core/mathChunked.ts', 'src/core/mathCache.ts', 'src/core/substituteMath.ts',
      'src/core/downloadNotifier.ts', 'src/core/prefetch.ts',
      'src/core/graph.ts', 'src/core/graphAssembly.ts', 'src/utils/linkSentence.ts',
      // db-pure-logic slice
      'src/core/annotationMerge.ts', 'src/core/readsMerge.ts', 'src/core/migrations.ts',
      'src/utils/readSessions.ts', 'src/utils/libraryScope.ts']) {
      expect(files).toContain(f);
    }
    // nothing is carved out of src/utils: the parser is in, and no UI file is
    expect(files).toContain('src/utils/sepHtml/collectMathHashes.ts');
    expect(files.filter(f => f.startsWith('src/ui/') || f.includes('/render/'))).toEqual([]);
  });

  test('no inner-ring file imports outer-ring code or does I/O', () => {
    const violations = files.flatMap(f => scanSource(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
    const unexcused = violations.filter(v => !KNOWN_EXCEPTIONS.some(x => x.file === v.file && x.what === v.what));
    expect(unexcused.map(v => `${v.file}:${v.line} ${v.what}`)).toEqual([]);
  });

  test('src/utils holds no React, React Native or Expo import (UI code lives in src/ui)', () => {
    const bad = files.filter(f => f.startsWith('src/utils/'))
      .filter(f => /from ['"](react|react-native|expo[^'"]*|@react-native[^'"]*)['"]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(bad).toEqual([]);
  });

  test('src/ui is outer ring: not scanned, and every top-level file there is real UI code', () => {
    expect(files.some(f => f.startsWith('src/ui/'))).toBe(false);
    const ui = fs.readdirSync(path.join(ROOT, 'src/ui')).filter((f: string) => /\.tsx?$/.test(f));
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) {
      expect({ f, usesRn: /from 'react(-native)?'/.test(fs.readFileSync(path.join(ROOT, 'src/ui', f), 'utf8')) }).toEqual({ f, usesRn: true });
    }
  });

  test('every recorded exception still matches a real violation (none are stale)', () => {
    for (const x of KNOWN_EXCEPTIONS) {
      const hits = scanSource(x.file, fs.readFileSync(path.join(ROOT, x.file), 'utf8'));
      expect({ exception: x.file, stillViolates: hits.some(v => v.what === x.what) }).toEqual({ exception: x.file, stillViolates: true });
      expect(x.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('ports are plain interfaces', () => {
  test('src/core/ports.ts declares only types: no values, no functions, no classes', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/core/ports.ts'), 'utf8');
    const sf = ts.createSourceFile('ports.ts', text, ts.ScriptTarget.Latest, true);
    const bad = sf.statements.filter(st => !(ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)
      || (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly)));
    expect(bad.map(st => st.getText(sf).slice(0, 60))).toEqual([]);
  });
});

describe('scanSource (the check itself)', () => {
  const run = (src: string, file = 'src/utils/x.ts') => scanSource(file, src).map(v => v.what);

  test('flags outer-ring imports, including type-only and re-exports', () => {
    expect(run(`import type { G } from '../services/graphDb';`)).toHaveLength(1);
    expect(run(`import { a } from '../screens/HomeScreen';`)).toHaveLength(1);
    expect(run(`export { a } from '../components/X';`)).toHaveLength(1);
    expect(run(`import { R } from '../ui/sepHtml/render/Blocks';`)).toHaveLength(1);
    expect(run(`import x from '../../App';`)).toHaveLength(1);
  });
  test('flags non-allowlisted packages', () => {
    expect(run(`import { Linking } from 'react-native';`)).toHaveLength(1);
    expect(run(`import * as S from 'expo-sqlite';`)).toHaveLength(1);
    expect(run(`import * as FS from 'expo-file-system/legacy';`)).toHaveLength(1);
  });
  test('flags dynamic loading', () => {
    expect(run(`const m = require('x');`)).toEqual(['require()']);
    expect(run(`const m = import('x');`)).toEqual(['dynamic import()']);
  });
  test('flags I/O, timers and clock reads', () => {
    expect(run(`fetch('https://a');`)).toEqual(['calls fetch()']);
    expect(run(`setTimeout(() => {}, 1);`)).toEqual(['calls setTimeout()']);
    expect(run(`const t = Date.now();`)).toEqual(['calls Date.now()']);
    expect(run(`const t = new Date();`)).toHaveLength(1);
    expect(run(`const r = Math.random();`)).toEqual(['calls Math.random()']);
    expect(run(`new XMLHttpRequest();`)).toEqual(['new XMLHttpRequest()']);
    expect(run(`globalThis.fetch('x');`)).toHaveLength(1);
  });
  test('core files may not import concrete adapters', () => {
    const core = (src: string) => scanSource('src/core/x.ts', src).map(v => v.what);
    expect(core(`import { getDb } from '../services/db';`)).toHaveLength(1);
    expect(core(`import * as SQLite from 'expo-sqlite';`)).toHaveLength(1);
    expect(core(`import { File } from 'expo-file-system';`)).toHaveLength(1);
    expect(core(`import { Platform } from 'react-native';`)).toHaveLength(1);
    expect(core(`import type { Clock } from './ports';`)).toEqual([]);
    expect(core(`import type { Annotation } from '../types';`)).toEqual([]);
  });
  test('flags process.env, Date(), and hidden module-level state', () => {
    expect(run(`const h = process.env.HOME;`)).toHaveLength(1);
    expect(run(`const s = Date();`)).toEqual(['Date() reads the clock']);
    expect(run(`let _db = null;`)).toEqual(['module-level mutable binding "_db"']);
    expect(run(`var cache = 1;`)).toHaveLength(1);
    expect(run(`const m = new Map<string, string>();`)).toHaveLength(1);
    expect(run(`export const S = new Set<string>();`)).toHaveLength(1);
    expect(run(`const T = new Set(['a', 'b']);`)).toEqual([]);  // seeded constant table
  });
  test('allows constants, local state and non-clock Date use', () => {
    expect(run(`const TABLE = { a: 1 }; const L = [1, 2];`)).toEqual([]);
    expect(run(`export function f() { let n = 0; const m = new Map(); return n + m.size; }`)).toEqual([]);
    expect(run(`const iso = new Date(1700000000000).toISOString();`)).toEqual([]);
  });
  test('allows pure code, sibling/inner imports, the allowlisted package, and explicit dates', () => {
    expect(run(`import { parseDocument } from 'htmlparser2';`)).toEqual([]);
    expect(run(`import type { Annotation } from '../types';`)).toEqual([]);
    expect(run(`import { LINK_MAP_JSON } from '../assets/linkMapData';`)).toEqual([]);
    expect(run(`import { x } from './sepPage';`)).toEqual([]);
    expect(run(`const d = new Date(2020, 1, 1); const n = Math.max(1, 2);`)).toEqual([]);
  });
  test('ignores I/O words inside strings, comments and regexes', () => {
    expect(run('const s = `fetch(\'x\'); setTimeout(() => {}); require(\'y\')`; // fetch(1)\n/* Date.now() */ const r = /fetch\\(/;')).toEqual([]);
  });
});
