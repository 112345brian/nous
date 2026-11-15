// Tiered math: classify trivially simple TeX so it can be shown as styled text
// in the line instead of a MathJax SVG. Pure — no I/O, no React Native, no
// clock or randomness — and FAIL CLOSED: a strict whitelist grammar; anything
// not fully recognized yields null ("use MathJax"). See docs/tiered-math.md.
//
// Emitted markup uses only <em> and text, which parseSepHtml already
// understands. Sub/superscripts are emitted as Unicode script characters, not
// <sub>/<sup>: the reader's <sub>/<sup> only shrink the font (no baseline
// shift in React Native), so x_1 and x^1 would look identical to "x1". A script
// whose characters have no Unicode script form makes the whole equation fall
// back to MathJax.

// Tiering is applied to every article when on. Bump MATH_TIER_VERSION whenever
// the classifier output changes: db init clears cached article content when the
// stamp (see mathTierStamp) differs, so articles re-fetch and re-process.
export const TIERED_MATH_DEFAULT = false;
export const MATH_TIER_VERSION = 1;
export function mathTierStamp(enabled: boolean): string {
  return enabled ? `on:${MATH_TIER_VERSION}` : 'off';
}

export type TierResult = { ok: true; html: string } | { ok: false; reason: string };

const MAX_LEN = 120;
const THIN = ' ';

type Cls = 'ord' | 'bin' | 'rel' | 'open' | 'close' | 'punct' | 'pre';
interface Sym { ch: string; cls: Cls; italic?: boolean }

const sym = (ch: string, cls: Cls = 'ord', italic = false): Sym => ({ ch, cls, italic });

const COMMANDS: Record<string, Sym> = {};
const greekLower: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
};
for (const [k, v] of Object.entries(greekLower)) COMMANDS[k] = sym(v, 'ord', true);
const greekUpper: Record<string, string> = {
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
for (const [k, v] of Object.entries(greekUpper)) COMMANDS[k] = sym(v);

const ords: Record<string, string> = {
  forall: '∀', exists: '∃', top: '⊤', bot: '⊥', emptyset: '∅', varnothing: '∅', infty: '∞',
  Box: '□', Diamond: '◇', ldots: '…', lbrace: '{', rbrace: '}',
};
for (const [k, v] of Object.entries(ords)) COMMANDS[k] = sym(v);
COMMANDS.neg = sym('¬', 'pre');
COMMANDS.lnot = sym('¬', 'pre');
COMMANDS.langle = sym('⟨', 'open');
COMMANDS.rangle = sym('⟩', 'close');
const bins: Record<string, string> = {
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', cup: '∪', cap: '∩', times: '×', cdot: '⋅',
  pm: '±', setminus: '∖', circ: '∘', oplus: '⊕', otimes: '⊗',
};
for (const [k, v] of Object.entries(bins)) COMMANDS[k] = sym(v, 'bin');
const rels: Record<string, string> = {
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', vdash: '⊢', models: '⊨', vDash: '⊨', nvdash: '⊬', leq: '≤', le: '≤', geq: '≥',
  ge: '≥', neq: '≠', ne: '≠', equiv: '≡', approx: '≈', sim: '∼',
};
for (const [k, v] of Object.entries(rels)) COMMANDS[k] = sym(v, 'rel');

// Unicode script forms. Digits and signs are widely covered; letters less so
// (see "glyph risk" in docs/tiered-math.md).
const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', i: 'ⁱ', n: 'ⁿ',
};
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
  s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

interface Tok { text: string; cls: Cls; italic: boolean; atom: boolean }

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string) => c >= '0' && c <= '9';
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function fail(reason: string): TierResult { return { ok: false, reason }; }

// Script argument: one char, or a flat {…} group of mappable chars. Returns the
// mapped string and the index after it, or a failure reason.
function readScript(
  s: string, i: number, map: Record<string, string>,
): { out: string; next: number } | string {
  const c = s[i];
  if (c === undefined) return 'script-missing-arg';
  if (c === '{') {
    const end = s.indexOf('}', i + 1);
    if (end < 0) return 'unbalanced-braces';
    const inner = s.slice(i + 1, end);
    if (!inner.length) return 'script-empty';
    let out = '';
    for (const ch of inner) {
      if (isSpace(ch)) continue;
      if (ch === '{' || ch === '\\' || ch === '^' || ch === '_') return 'nested-script-or-macro';
      const m = map[ch];
      if (!m) return 'script-unmappable';
      out += m;
    }
    return out ? { out, next: end + 1 } : 'script-empty';
  }
  if (c === '\\' || c === '^' || c === '_' || c === '}') return 'nested-script-or-macro';
  const m = map[c];
  return m ? { out: m, next: i + 1 } : 'script-unmappable';
}

export function analyzeSimpleTex(tex: string, display: boolean): TierResult {
  if (display) return fail('display');
  if (typeof tex !== 'string') return fail('not-a-string');
  if (tex.length === 0 || tex.length > MAX_LEN) return fail('length');
  const s = tex;
  const toks: Tok[] = [];
  let sawSub = false, sawSup = false; // for the atom just before the cursor
  let scriptRun = 0; // script tokens emitted since the base atom
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (code > 126 || (code < 32 && !isSpace(c))) return fail('non-ascii-or-control');
    if (isSpace(c)) { i++; continue; }

    if (isLetter(c)) {
      let j = i;
      while (j < s.length && isLetter(s[j])) j++;
      toks.push({ text: s.slice(i, j), cls: 'ord', italic: true, atom: true });
      i = j; sawSub = sawSup = false; scriptRun = 0;
      continue;
    }
    if (isDigit(c)) {
      let j = i;
      while (j < s.length && isDigit(s[j])) j++;
      if (s[j] === '.' && isDigit(s[j + 1] ?? '')) {
        j++;
        while (j < s.length && isDigit(s[j])) j++;
      }
      toks.push({ text: s.slice(i, j), cls: 'ord', italic: false, atom: true });
      i = j; sawSub = sawSup = false; scriptRun = 0;
      continue;
    }
    if (c === '\\') {
      let j = i + 1;
      while (j < s.length && isLetter(s[j])) j++;
      if (j === i + 1) {
        // control symbol
        const n = s[j];
        if (n === ',') { toks.push({ text: THIN, cls: 'ord', italic: false, atom: false }); i = j + 1; continue; }
        if (n === '{' || n === '}') {
          toks.push({ text: n, cls: n === '{' ? 'open' : 'close', italic: false, atom: n === '}' });
          i = j + 1; sawSub = sawSup = false; scriptRun = 0; continue;
        }
        return fail('macro:\\' + (n ?? ''));
      }
      const name = s.slice(i + 1, j);
      const d = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : undefined;
      if (!d) return fail('macro:\\' + name);
      toks.push({ text: d.ch, cls: d.cls, italic: !!d.italic, atom: d.cls === 'ord' || d.cls === 'close' });
      i = j; sawSub = sawSup = false; scriptRun = 0;
      continue;
    }
    if (c === '_' || c === '^') {
      const p = toks[toks.length - 1 - (scriptRun ? scriptRun : 0)];
      if (!p || !p.atom) return fail('script-without-base');
      if (c === '_' ? sawSub : sawSup) return fail('double-script');
      const r = readScript(s, i + 1, c === '_' ? SUB : SUP);
      if (typeof r === 'string') return fail(r);
      toks.push({ text: r.out, cls: 'ord', italic: false, atom: false });
      if (c === '_') sawSub = true; else sawSup = true;
      scriptRun++;
      i = r.next;
      continue;
    }
    sawSub = sawSup = false; scriptRun = 0;
    switch (c) {
      case '+': case '-':
        toks.push({ text: c === '-' ? '−' : '+', cls: 'bin', italic: false, atom: false }); break;
      case '=': case '<': case '>':
        toks.push({ text: c, cls: 'rel', italic: false, atom: false }); break;
      case '/': case '!':
        toks.push({ text: c, cls: 'ord', italic: false, atom: c === '!' }); break;
      case '(': case '[':
        toks.push({ text: c, cls: 'open', italic: false, atom: false }); break;
      case ')': case ']':
        toks.push({ text: c, cls: 'close', italic: false, atom: true }); break;
      case ',':
        toks.push({ text: ',', cls: 'punct', italic: false, atom: false }); break;
      case "'": {
        const p = toks[toks.length - 1];
        if (!p || !p.atom) return fail('prime-without-base');
        toks.push({ text: '′', cls: 'ord', italic: false, atom: true }); break;
      }
      default:
        // includes braces groups, ^_ handled above, |, :, ;, &, %, #, $, ~, ", `
        return fail(c === '{' || c === '}' ? 'group' : 'char:' + c);
    }
    i++;
  }
  if (!toks.some(t => t.text.trim() !== '' && t.text !== THIN)) return fail('empty');

  // Bracket balance for ( ) [ ] \{ \} \langle \rangle (already single chars).
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{', '⟩': '⟨' };
  for (const t of toks) {
    if (t.cls === 'open') stack.push(t.text);
    else if (t.cls === 'close' && pairs[t.text]) {
      if (stack.pop() !== pairs[t.text]) return fail('unbalanced-brackets');
    }
  }
  if (stack.length) return fail('unbalanced-brackets');

  // Spacing + segments.
  const segs: Array<{ em: boolean; s: string }> = [];
  const push = (text: string, em: boolean) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && last.em === em) last.s += text; else segs.push({ em, s: text });
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const before = toks[k - 1];
    if (t.cls === 'bin') {
      const unary = !before || before.cls === 'bin' || before.cls === 'rel' || before.cls === 'open'
        || before.cls === 'punct' || before.cls === 'pre';
      if (unary || k === toks.length - 1) { push(t.text, false); continue; }
      push(THIN + t.text + THIN, false);
    } else if (t.cls === 'rel') {
      if (k === 0 || k === toks.length - 1) { push(t.text, false); continue; }
      push(THIN + t.text + THIN, false);
    } else if (t.cls === 'punct') {
      push(k === toks.length - 1 ? t.text : t.text + THIN, false);
    } else {
      push(t.text, t.italic);
    }
  }
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = segs.map(g => (g.em ? `<em>${esc(g.s)}</em>` : esc(g.s))).join('');
  return { ok: true, html };
}

// Inline-HTML markup for trivially simple TeX, or null → use MathJax SVG.
export function classifySimpleTex(tex: string, display: boolean): string | null {
  try {
    const r = analyzeSimpleTex(tex, display);
    return r.ok ? r.html : null;
  } catch {
    return null;
  }
}
