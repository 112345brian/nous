// The math render path has one bridge instance, built in the root, and no module-level state.
//   MB1  services/mathRender.ts (the asset adapter) keeps no module-level mutable state
//   MB2  the WebView component reaches the bridge through the root, not through a service module
//   MB3  the root builds exactly one bridge, and the live instance works end to end
//   MB4  the Hermes spike is a second MathRenderer chosen in the root, not a branch in the bridge
import ts from 'typescript';

declare function require(mod: string): any;
declare const __dirname: string;
const fs = require('fs');
const path = require('path');
const ROOT: string = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8') as string;

jest.mock('expo-asset', () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: 'file:///mathjax.b64' }) },
}));
jest.mock('expo-file-system', () => ({ readAsStringAsync: jest.fn(async () => 'QUJD') }));
jest.mock('../assets/mathjax-full.b64', () => 1, { virtual: true });
jest.mock('../services/db', () => require('../services/__tests__/helpers/mockDbModule').asDbModule({ getMeta: jest.fn(), setMeta: jest.fn() }));

/** Imports of a file as { from (repo-relative, no extension), names }; same resolution as compositionRoot.test. */
function importsOf(file: string, text: string): Array<{ from: string; names: string[] }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ from: string; names: string[] }> = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const from = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.(tsx?|js)$/, '') : spec;
    const nb = st.importClause?.namedBindings;
    const names = nb && ts.isNamedImports(nb) ? nb.elements.map(e => (e.propertyName ?? e.name).text) : [];
    out.push({ from, names });
  }
  return out;
}

/** Top-level `let`/`var`, and top-level `new Map/Set/WeakMap/WeakSet(...)`, of one file. */
function stateIn(text: string): string[] {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const d of st.declarationList.declarations) {
      if (!isConst) out.push(d.name.getText(sf));
      else if (d.initializer && ts.isNewExpression(d.initializer) && /^(Map|Set|WeakMap|WeakSet)$/.test(d.initializer.expression.getText(sf))) out.push(d.name.getText(sf));
    }
  }
  return out;
}
const moduleState = (file: string) => stateIn(read(file));

describe('MB1: no module-level state in the asset adapter', () => {
  test('services/mathRender.ts has no top-level let/var or empty collection', () => {
    expect(moduleState('src/services/mathRender.ts')).toEqual([]);
  });
  test('the old bridge entry points are gone', () => {
    const text = read('src/services/mathRender.ts');
    for (const name of ['_registerInject', '_onMessage', '_signalDomReady', '_resetReady', 'renderMathBatch', 'injectFn']) {
      expect(text).not.toContain(name);
    }
  });
  test('the checker itself sees state when there is some', () => {
    expect(stateIn('let a = 1; var b; const p = new Map(); const ok = 1; const f = () => { let inner = 1; };')).toEqual(['a', 'b', 'p']);
  });
});

describe('MB2: the component takes the bridge from the root', () => {
  test('MathRenderWebView imports the host from composition and nothing from services/mathRender', () => {
    const imps = importsOf('src/components/MathRenderWebView.tsx', read('src/components/MathRenderWebView.tsx'));
    expect(imps.some(i => i.from === 'src/composition' && i.names.includes('mathWebViewHost'))).toBe(true);
    expect(imps.filter(i => i.from === 'src/services/mathRender')).toEqual([]);
  });
  test('only the root imports services/mathRender', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(rel); }
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(rel);
    } };
    walk('src'); files.push('App.tsx');
    const importers = files.filter(f => importsOf(f, read(f)).some(i => i.from === 'src/services/mathRender'));
    expect(importers).toEqual(['src/composition.ts']);
  });
});

describe('MB3: one instance, built in the root', () => {
  test('composition.ts calls createMathBridge exactly once', () => {
    expect((read('src/composition.ts').match(/createMathBridge\(/g) ?? []).length).toBe(1);
  });

  test('the live instance: attach, preload injects the engine once, host calls are accepted', async () => {
    const root = require('../composition');
    const injected: string[] = [];
    expect(root.isMathWebViewReady()).toBe(false);
    root.mathWebViewHost.attach((js: string) => { injected.push(js); });
    expect(root.isMathWebViewReady()).toBe(true);
    await root.preloadMathJax();
    await root.preloadMathJax();
    expect(injected.filter(j => j.includes('atob("QUJD")'))).toHaveLength(1);
    root.mathWebViewHost.onMessage(JSON.stringify({ type: 'ready' }));
    expect(() => root.mathWebViewHost.onDomReady()).not.toThrow();
  });
});

describe('MB4: the Hermes spike plugs in at the root', () => {
  test('composition picks a MathRenderer by the flag; the bridge has no Hermes branch', () => {
    const rootText = read('src/composition.ts');
    expect(rootText).toMatch(/EXPO_PUBLIC_MATH_HERMES/);
    expect(rootText).toMatch(/mathRenderHermes/);
    expect(read('src/core/mathBridge.ts')).not.toMatch(/hermes/i);
  });
  test('nothing else imports the spike at module load', () => {
    expect(importsOf('src/composition.ts', read('src/composition.ts')).filter(i => i.from === 'src/services/mathRenderHermes')).toEqual([]);
  });
});
