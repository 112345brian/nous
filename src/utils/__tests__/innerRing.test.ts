// Enforces the architecture rule: the INNER RING does no I/O.
//
// Rings
//   inner (pure):  src/types.ts, src/data/**, src/utils/**
//   outer (I/O):   src/services/**, src/screens/**, src/components/**, src/tests/**, App.tsx
//   UI render:     src/utils/sepHtml/render/** is React Native UI code that happens to live
//                  under utils/. It is an OUTER-ring directory, so it is not scanned here,
//                  and inner-ring files must not import it.
//
// An inner-ring file must not: import from an outer-ring directory, import any package
// other than the allowlist, load modules dynamically (require / import()), or call
// I/O, timer or clock APIs. Files are parsed with the TypeScript compiler, so strings,
// comments and regexes (e.g. the JS-in-a-string constants in injectedAssets.ts) never
// cause false positives. Everything flows through scanSource(), which is self-tested below.
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
  'src/services/', 'src/screens/', 'src/components/', 'src/tests/',
  'src/utils/sepHtml/render/', 'App', 'index',
];
const FORBIDDEN_CALLS = new Set([
  'fetch', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask',
]);
const FORBIDDEN_CTORS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker']);
const FORBIDDEN_MEMBERS = new Set(['Date.now', 'performance.now', 'Math.random']);

export interface Violation { file: string; line: number; what: string }

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

  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      checkSpecifier(n, n.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(n)) add(n, 'import = require() is not allowed');
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword) add(n, 'dynamic import()');
      else if (ts.isIdentifier(e) && e.text === 'require') add(n, 'require()');
      else if (ts.isIdentifier(e) && FORBIDDEN_CALLS.has(e.text)) add(n, `calls ${e.text}()`);
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
        if (ent.name === '__tests__' || rel === 'src/utils/sepHtml/render') continue;
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(ent.name)) {
        files.push(rel);
      }
    }
  };
  walk('src/utils');
  walk('src/data');
  return files;
}

describe('inner ring has no I/O', () => {
  const files = innerRingFiles();

  test('the ring is non-trivial (guards against a silently empty scan)', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of ['src/types.ts', 'src/utils/forceLayout.ts', 'src/utils/linkifier.ts', 'src/utils/sepHtml/parse.ts',
      'src/utils/sepPage.ts', 'src/utils/citation.ts', 'src/utils/contentHash.ts', 'src/utils/mathHash.ts']) {
      expect(files).toContain(f);
    }
    expect(files).not.toContain('src/utils/sepHtml/render/Blocks.tsx');
  });

  test('no inner-ring file imports outer-ring code or does I/O', () => {
    const violations = files.flatMap(f => scanSource(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(violations.map(v => `${v.file}:${v.line} ${v.what}`)).toEqual([]);
  });
});

describe('scanSource (the check itself)', () => {
  const run = (src: string, file = 'src/utils/x.ts') => scanSource(file, src).map(v => v.what);

  test('flags outer-ring imports, including type-only and re-exports', () => {
    expect(run(`import type { G } from '../services/graphDb';`)).toHaveLength(1);
    expect(run(`import { a } from '../screens/HomeScreen';`)).toHaveLength(1);
    expect(run(`export { a } from '../components/X';`)).toHaveLength(1);
    expect(run(`import { R } from './sepHtml/render/Blocks';`)).toHaveLength(1);
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
