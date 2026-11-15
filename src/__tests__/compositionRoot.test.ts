// Keeps the composition root honest. src/composition.ts is the one place that builds concrete
// adapters and hands them to the core use cases; everything else depends on it, never the
// other way round.
//
//   RC1  inner ring and core never import the composition root         (see innerRing.test.ts)
//   RC2  adapters (src/services) never import the composition root
//   RC3  only composition.ts wires core use cases (recorded exception: services/catalog.ts)
//   RC4  screens, components and App.tsx get the converted use cases from the root
//   RC5  ratchet: the files that still import the SQLite adapter directly can only shrink
import ts from 'typescript';

declare function require(mod: string): any;
declare const __dirname: string;
const fs = require('fs');
const path = require('path');
const ROOT: string = path.join(__dirname, '..', '..');

export interface Import { from: string; typeOnly: boolean; names: string[] }

/** Every import/re-export in a file: resolved to a repo-relative path without extension. */
export function importsOf(file: string, text: string): Import[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Import[] = [];
  const resolve = (spec: string) =>
    spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.(tsx?|js)$/, '') : spec;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      const names: string[] = [];
      let valueImport = false;
      if (c?.name) { names.push('default'); valueImport = true; }
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) { names.push('*'); valueImport = true; }
        else for (const e of c.namedBindings.elements) { names.push((e.propertyName ?? e.name).text); if (!e.isTypeOnly) valueImport = true; }
      }
      if (!c) valueImport = true; // import 'x'
      out.push({ from: resolve(st.moduleSpecifier.text), typeOnly: !!c?.isTypeOnly || !valueImport, names });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.map(e => (e.propertyName ?? e.name).text) : ['*'];
      out.push({ from: resolve(st.moduleSpecifier.text), typeOnly: st.isTypeOnly, names });
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) { if (ent.name !== '__tests__' && ent.name !== 'node_modules') walk(rel, acc); }
    else if (/\.(ts|tsx)$/.test(ent.name)) acc.push(rel);
  }
  return acc;
}
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8') as string;
const importsFor = (f: string) => importsOf(f, read(f));

const SRC = walk('src');
const SERVICES = SRC.filter(f => f.startsWith('src/services/'));
const UI = [...SRC.filter(f => f.startsWith('src/screens/') || f.startsWith('src/components/')), 'App.tsx'];

// The use cases that are wired in the root. UI must import these from the root, not from where
// they used to live.
const CONVERTED = [
  'exportToSyncFolder', 'importFromSyncFolder', 'exportToZotero',
  'refreshIndexIfStale', 'fetchAndCacheArticle',
  'onMathReady', 'completeArticleMath', 'resumePendingMath',
];

// RC3 exceptions: a file other than composition.ts that still wires a core use case.
const WIRING_EXCEPTIONS: Array<{ file: string; reason: string }> = [
  { file: 'src/services/catalog.ts',
    reason: 'downloadAll, syncCachedArticles and the backfills still call these use cases, so moving the wiring to the root would make catalog and composition import each other; goes away when those functions are converted' },
];

// RC5: files outside the root that import the SQLite adapter (services/db) directly. Shrink-only.
const DB_DIRECT_ALLOWLIST = [
  'App.tsx',
  'src/components/OrphanedAnnotationsBanner.tsx',
  'src/screens/AnnotationsScreen.tsx',
  'src/screens/ArticleScreen.tsx',
  'src/screens/GraphScreen.tsx',
  'src/screens/HistoryScreen.tsx',
  'src/screens/HomeScreen.tsx',
  'src/screens/ReadingListScreen.tsx',
  'src/screens/SettingsScreen.tsx',
];

describe('the composition root exists', () => {
  test('src/composition.ts is present and exports the converted use cases', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/composition.ts'))).toBe(true);
    const text = read('src/composition.ts');
    for (const name of CONVERTED) expect(text).toMatch(new RegExp(`\\b${name}\\b`));
  });
});

describe('RC2: adapters never import the root', () => {
  test('no file in src/services imports composition', () => {
    const bad = SERVICES.filter(f => importsFor(f).some(i => i.from === 'src/composition'));
    expect(bad).toEqual([]);
  });
});

describe('RC3: only the root wires core use cases', () => {
  const coreValueImports = (f: string) =>
    importsFor(f).filter(i => i.from.startsWith('src/core/') && i.from !== 'src/core/ports' && !i.typeOnly);

  test('outside composition.ts and the recorded exceptions, nothing imports a core use case as a value', () => {
    const allowed = new Set(['src/composition.ts', ...WIRING_EXCEPTIONS.map(e => e.file)]);
    const bad = SRC.filter(f => !f.startsWith('src/core/') && !allowed.has(f) && coreValueImports(f).length > 0);
    expect(bad).toEqual([]);
  });

  test('every recorded exception still wires a core use case (none are stale)', () => {
    for (const e of WIRING_EXCEPTIONS) {
      expect({ file: e.file, stillWires: coreValueImports(e.file).length > 0 }).toEqual({ file: e.file, stillWires: true });
      expect(e.reason.length).toBeGreaterThan(30);
    }
  });
});

describe('RC4: UI gets the converted use cases from the root', () => {
  test('no screen, component or App.tsx imports them from services/catalog or services/dataSync', () => {
    const bad: string[] = [];
    for (const f of UI) {
      for (const i of importsFor(f)) {
        if (i.from === 'src/services/catalog' || i.from === 'src/services/dataSync') {
          for (const n of i.names) if (CONVERTED.includes(n)) bad.push(`${f} imports ${n} from ${i.from}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('RC5: direct use of the SQLite adapter can only shrink', () => {
  const importsDb = (f: string) => importsFor(f).some(i => i.from === 'src/services/db' && !i.typeOnly);

  test('no new file outside the allowlist imports services/db', () => {
    const actual = [...SRC.filter(f => !f.startsWith('src/services/') && !f.startsWith('src/core/') && !f.startsWith('src/tests/')), 'App.tsx', 'src/composition.ts']
      .filter(f => f !== 'src/composition.ts' && fs.existsSync(path.join(ROOT, f)) && importsDb(f));
    const extra = actual.filter(f => !DB_DIRECT_ALLOWLIST.includes(f));
    expect(extra).toEqual([]);
  });

  test('every allowlisted file still imports it, so migrated files must leave the list', () => {
    const stale = DB_DIRECT_ALLOWLIST.filter(f => !importsDb(f));
    expect(stale).toEqual([]);
  });
});

describe('importsOf (the check itself)', () => {
  const imp = (src: string, file = 'src/screens/X.tsx') => importsOf(file, src);
  test('resolves relative paths, names, and type-only imports', () => {
    expect(imp(`import { a, type B } from '../services/catalog';`)).toEqual([{ from: 'src/services/catalog', typeOnly: false, names: ['a', 'B'] }]);
    expect(imp(`import type { A } from '../core/ports';`)).toEqual([{ from: 'src/core/ports', typeOnly: true, names: ['A'] }]);
    expect(imp(`import { type A } from '../core/ports';`)[0].typeOnly).toBe(true);
    expect(imp(`import * as db from '../services/db';`)[0].names).toEqual(['*']);
    expect(imp(`export { x as y } from '../services/catalog';`)).toEqual([{ from: 'src/services/catalog', typeOnly: false, names: ['x'] }]);
    expect(imp(`import R from 'react';`)[0]).toEqual({ from: 'react', typeOnly: false, names: ['default'] });
  });
  test('App.tsx specifiers resolve from the repo root', () => {
    expect(importsOf('App.tsx', `import { f } from './src/services/catalog';`)[0].from).toBe('src/services/catalog');
  });
  test('ignores import-like text in strings and comments', () => {
    expect(imp(`// import { a } from '../services/db';\nconst s = "import x from '../services/db'";`)).toEqual([]);
  });
});
