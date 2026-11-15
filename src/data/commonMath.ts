// Curated list of GENERIC, well-known formulas that the reader pre-renders in
// the background (see src/services/prewarmCommonMath.ts) so the first articles
// find their common equations already cached.
//
// PROVENANCE RULE (AGENTS.md, NOTICE.md): every string below was hand-authored
// for this file as a textbook-standard formula (Bayes' theorem, De Morgan's
// laws, set identities, ...). No SEP text is copied here and no rendering of
// any kind is committed: the SVGs are produced on-device at runtime from these
// strings. Do NOT add anything pasted from an SEP page, anything specific to one
// article's argument, or any pre-rendered output.
//
// Notation follows common textbook usage (\mid, \neg, \wedge, \vee, \rightarrow,
// \vDash, \vdash). Only TeX that classifySimpleTex (tiered math) would NOT
// render as styled text belongs here for inline entries; display entries always
// go through MathJax.
//
// Adding/removing/changing an entry changes COMMON_MATH_STAMP automatically, so
// devices re-run the pre-warm (already-cached hashes are skipped).

export interface CommonMathEntry { tex: string; display: boolean }

const r = String.raw;
const inline = (xs: string[]): CommonMathEntry[] => xs.map(tex => ({ tex, display: false }));
const display = (xs: string[]): CommonMathEntry[] => xs.map(tex => ({ tex, display: true }));

// ── Probability ──────────────────────────────────────────────────────────────
const probabilityInline = inline([
  r`P(A \mid B)`, r`P(B \mid A)`, r`P(A \mid \neg B)`, r`P(A \mid B \wedge C)`, r`P(\neg A \mid B)`,
  r`P(E \mid H)`, r`P(H \mid E)`, r`P(E \mid \neg H)`, r`P(\neg H \mid E)`, 
  r`P(h \mid e)`, r`P(e \mid h)`, r`P(e \mid \neg h)`, r`P(A_i \mid B)`, r`P(B \mid A_i)`,
  r`P(X = x \mid Y = y)`, 
  r`P(A \mid B) > P(A)`, r`P(A \mid B) = P(A)`, 
  r`\Pr(A \mid B)`, r`\Pr(H \mid E)`, r`\Pr(E \mid H)`,
  r`\frac{P(E \mid H)}{P(E \mid \neg H)}`, r`\frac{P(H)}{P(\neg H)}`,
  r`\mathbb{E}[X]`, r`\mathrm{Var}(X)`, r`\mathrm{Cov}(X, Y)`, 
  r`(\Omega, \mathcal{F}, P)`, r`\sum_{i=1}^{n} P(A_i)`, r`\sum_{i=1}^{n} p_i = 1`,
]);

const probabilityDisplay = display([
  r`P(A \mid B) = \frac{P(A \wedge B)}{P(B)}`,
  r`P(A \mid B) = \frac{P(A \cap B)}{P(B)}`,
  r`P(A \wedge B) = P(A \mid B)\,P(B)`,
  r`P(A \mid B) = \frac{P(B \mid A)\,P(A)}{P(B)}`,
  r`P(H \mid E) = \frac{P(E \mid H)\,P(H)}{P(E)}`,
  r`P(h \mid e) = \frac{P(e \mid h)\,P(h)}{P(e)}`,
  r`P(H \mid E) = \frac{P(E \mid H)\,P(H)}{P(E \mid H)\,P(H) + P(E \mid \neg H)\,P(\neg H)}`,
  r`P(A \mid B) = \frac{P(B \mid A)\,P(A)}{P(B \mid A)\,P(A) + P(B \mid \neg A)\,P(\neg A)}`,
  r`P(A_i \mid B) = \frac{P(B \mid A_i)\,P(A_i)}{\sum_{j} P(B \mid A_j)\,P(A_j)}`,
  r`P(A_i \mid B) = \frac{P(B \mid A_i)\,P(A_i)}{\sum_{j=1}^{n} P(B \mid A_j)\,P(A_j)}`,
  r`P(B) = P(B \mid A)\,P(A) + P(B \mid \neg A)\,P(\neg A)`,
  r`P(B) = \sum_{i} P(B \mid A_i)\,P(A_i)`,
  r`P(A \vee B) = P(A) + P(B) - P(A \wedge B)`,
  r`P(A \cup B) = P(A) + P(B) - P(A \cap B)`,
  r`P(\neg A) = 1 - P(A)`,
  r`0 \le P(A) \le 1`,
  r`P(\Omega) = 1`,
  r`P\Big(\bigcup_{i=1}^{\infty} A_i\Big) = \sum_{i=1}^{\infty} P(A_i)`,
  r`P(A \wedge B) = P(A)\,P(B)`,
  r`P(A \wedge B \mid C) = P(A \mid C)\,P(B \mid C)`,
  r`P(A \wedge B \wedge C) = P(A \mid B \wedge C)\,P(B \mid C)\,P(C)`,
  r`\frac{P(H \mid E)}{P(\neg H \mid E)} = \frac{P(H)}{P(\neg H)} \cdot \frac{P(E \mid H)}{P(E \mid \neg H)}`,
  r`P(H \mid E) \propto P(E \mid H)\,P(H)`,
  r`P(H \mid E) > P(H) \iff P(E \mid H) > P(E)`,
  r`E[X] = \sum_{x} x\,P(X = x)`,
  r`E[X] = \sum_{i=1}^{n} x_i\,p_i`,
  r`E[X + Y] = E[X] + E[Y]`,
  r`E[X] = E\big[E[X \mid Y]\big]`,
  r`\mathrm{Var}(X) = E[X^2] - (E[X])^2`,
  r`\mathrm{Cov}(X, Y) = E[XY] - E[X]\,E[Y]`,
  r`\bar{x} = \frac{1}{n} \sum_{i=1}^{n} x_i`,
  r`f(x) = \frac{1}{\sigma\sqrt{2\pi}}\, e^{-\frac{(x - \mu)^2}{2\sigma^2}}`,
  r`P(X = k) = \binom{n}{k}\,p^k (1 - p)^{n-k}`,
  r`\binom{n}{k} = \frac{n!}{k!\,(n - k)!}`,
  r`(x + y)^n = \sum_{k=0}^{n} \binom{n}{k}\,x^{n-k} y^k`,
  r`P(|X - \mu| \ge k\sigma) \le \frac{1}{k^2}`,
  r`\lim_{n \to \infty} \frac{1}{n} \sum_{i=1}^{n} X_i = \mu`,
  r`P(A) = \lim_{n \to \infty} \frac{n_A}{n}`,
  r`P(A) = \frac{|A|}{|\Omega|}`,
  r`\text{odds}(A) = \frac{P(A)}{1 - P(A)}`,
  r`H(X) = -\sum_{x} P(x) \log P(x)`,
  r`P_{\text{new}}(A) = P_{\text{old}}(A \mid E)`,
  r`P_{\text{new}}(A) = P_{\text{old}}(A \mid E)\,P_{\text{new}}(E) + P_{\text{old}}(A \mid \neg E)\,P_{\text{new}}(\neg E)`,
]);

// ── Decision theory ──────────────────────────────────────────────────────────
const decisionInline = inline([
  r`P(s \mid a)`, r`P(o \mid a)`,
  r`A \succ B`, r`A \succeq B`, 
  r`u : X \to \mathbb{R}`, r`\arg\max_{a} EU(a)`, r`\max_{a} \min_{s} u(a, s)`,
  r`\sum_{i} p_i u_i`, r`\sum_{s} P(s)\,u(a, s)`, r`\sum_{o} P(o \mid a)\,U(o)`,
]);

const decisionDisplay = display([
  r`EU(A) = \sum_{i} P(s_i)\,u(A, s_i)`,
  r`EU(A) = \sum_{s \in S} P(s)\,u(A, s)`,
  r`EU(A) = \sum_{i=1}^{n} p_i\,u(x_i)`,
  r`EU(A) = \sum_{o \in O} P(o \mid A)\,U(o)`,
  r`V(A) = \sum_{i} P(S_i \mid A)\,U(A \wedge S_i)`,
  r`V(A) = \sum_{i} P(S_i)\,U(A \wedge S_i)`,
  r`EU(A) = \int_{S} u(A(s))\,dP(s)`,
  r`A \succeq B \iff EU(A) \ge EU(B)`,
  r`x \succeq y \iff u(x) \ge u(y)`,
  r`u(p\,x + (1 - p)\,y) = p\,u(x) + (1 - p)\,u(y)`,
  r`u'(x) = a\,u(x) + b \quad (a > 0)`,
  r`A \succeq B \implies pA + (1 - p)C \succeq pB + (1 - p)C`,
  r`A \succ B \succ C \implies \exists\, p \in (0, 1) : B \sim pA + (1 - p)C`,
  r`a^{*} = \arg\max_{a \in A} \sum_{s \in S} P(s)\,u(a, s)`,
  r`a^{*} = \arg\max_{a} \min_{s} u(a, s)`,
  r`\text{regret}(a, s) = \max_{a'} u(a', s) - u(a, s)`,
  r`CE(L) = u^{-1}\big(EU(L)\big)`,
  r`u(x) = \frac{x^{1 - \gamma}}{1 - \gamma}`,
  r`r(x) = -\frac{u''(x)}{u'(x)}`,
  r`E[u(X)] \le u(E[X])`,
  r`u_i(s_i^{*}, s_{-i}^{*}) \ge u_i(s_i, s_{-i}^{*}) \quad \text{for all } s_i \in S_i`,
  r`u_i(s_i, s_{-i}) > u_i(s_i', s_{-i}) \quad \text{for all } s_{-i}`,
  r`EU_i(\sigma) = \sum_{s \in S} \sigma(s)\,u_i(s)`,
  r`\max_{\sigma_1} \min_{\sigma_2} u_1(\sigma_1, \sigma_2) = \min_{\sigma_2} \max_{\sigma_1} u_1(\sigma_1, \sigma_2)`,
  r`\sum_{t=0}^{\infty} \delta^t\,u_t`,
  r`E[X] = \sum_{k=1}^{\infty} \frac{1}{2^k} \cdot 2^k = \infty`,
  r`\sum_{k=0}^{\infty} r^k = \frac{1}{1 - r} \quad (|r| < 1)`,
  r`\sum_{i=1}^{n} i = \frac{n(n + 1)}{2}`,
]);

// ── Propositional, predicate and modal logic ────────────────────────────────
const logicInline = inline([
  
  
  
  
  r`\mathcal{M} \vDash \varphi`, r`\mathcal{M}, w \vDash \varphi`, r`\mathcal{M}, w \nvDash \varphi`,
  
  r`\ulcorner\varphi\urcorner`,
  
  r`\mathcal{M} = (W, R, V)`, r`w \Vdash \varphi`,
  r`\varphi \mathrel{\Box\!\!\rightarrow} \psi`, r`\varphi \mathrel{\mid\!\sim} \psi`,
  r`\mathbf{S4}`, r`\mathbf{S5}`, r`\mathbf{PA}`, r`\mathbf{ZFC}`,
]);

const logicDisplay = display([
  r`\neg(A \wedge B) \equiv \neg A \vee \neg B`,
  r`\neg(A \vee B) \equiv \neg A \wedge \neg B`,
  r`\neg(\varphi \wedge \psi) \equiv \neg\varphi \vee \neg\psi`,
  r`\neg(\varphi \vee \psi) \equiv \neg\varphi \wedge \neg\psi`,
  r`A \wedge (B \vee C) \equiv (A \wedge B) \vee (A \wedge C)`,
  r`A \vee (B \wedge C) \equiv (A \vee B) \wedge (A \vee C)`,
  r`A \wedge (A \vee B) \equiv A`, r`A \vee (A \wedge B) \equiv A`,
  r`A \rightarrow B \equiv \neg A \vee B`, r`A \rightarrow B \equiv \neg B \rightarrow \neg A`,
  r`A \leftrightarrow B \equiv (A \rightarrow B) \wedge (B \rightarrow A)`,
  r`\neg(A \rightarrow B) \equiv A \wedge \neg B`,
  r`(A \wedge B) \rightarrow C \equiv A \rightarrow (B \rightarrow C)`,
  r`\frac{A \quad A \rightarrow B}{B}`, r`\frac{A \rightarrow B \quad \neg B}{\neg A}`,
  r`\frac{A \quad B}{A \wedge B}`, r`\frac{A \wedge B}{A}`, r`\frac{A}{A \vee B}`,
  r`\frac{A \vee B \quad \neg A}{B}`, r`\frac{A \rightarrow B \quad B \rightarrow C}{A \rightarrow C}`,
  r`\frac{\Gamma \vdash \varphi \quad \Gamma \vdash \varphi \rightarrow \psi}{\Gamma \vdash \psi}`,
  r`\frac{\Gamma, \varphi \vdash \psi}{\Gamma \vdash \varphi \rightarrow \psi}`,
  r`\frac{\vdash \varphi}{\vdash \Box\varphi}`, r`\frac{\forall x\,\varphi(x)}{\varphi(t)}`,
  r`\neg\forall x\,\varphi(x) \equiv \exists x\,\neg\varphi(x)`,
  r`\neg\exists x\,\varphi(x) \equiv \forall x\,\neg\varphi(x)`,
  r`\forall x\,(\varphi \wedge \psi) \equiv \forall x\,\varphi \wedge \forall x\,\psi`,
  r`\exists x\,(\varphi \vee \psi) \equiv \exists x\,\varphi \vee \exists x\,\psi`,
  r`\exists x\,\forall y\,\varphi \rightarrow \forall y\,\exists x\,\varphi`,
  r`\exists! x\,\varphi(x) \equiv \exists x\,\big(\varphi(x) \wedge \forall y\,(\varphi(y) \rightarrow y = x)\big)`,
  r`\Gamma \vDash \varphi \iff \Gamma \vdash \varphi`,
  r`\Gamma \vdash \varphi \iff \Gamma \cup \{\neg\varphi\} \vdash \bot`,
  r`\mathcal{M}, w \vDash \Box\varphi \iff \forall v\,(wRv \Rightarrow \mathcal{M}, v \vDash \varphi)`,
  r`\mathcal{M}, w \vDash \Diamond\varphi \iff \exists v\,(wRv \wedge \mathcal{M}, v \vDash \varphi)`,
  r`\mathcal{M}, w \vDash \neg\varphi \iff \mathcal{M}, w \nvDash \varphi`,
  r`\mathcal{M}, w \vDash \varphi \wedge \psi \iff \mathcal{M}, w \vDash \varphi \text{ and } \mathcal{M}, w \vDash \psi`,
  r`\mathcal{M}, w \vDash p \iff w \in V(p)`,
  r`\Box(\varphi \rightarrow \psi) \rightarrow (\Box\varphi \rightarrow \Box\psi)`,
  r`\Box\varphi \rightarrow \varphi`, r`\Diamond\varphi \rightarrow \Box\Diamond\varphi`,
  r`\Box(\Box\varphi \rightarrow \varphi) \rightarrow \Box\varphi`,
  r`K_a(\varphi \rightarrow \psi) \rightarrow (K_a\varphi \rightarrow K_a\psi)`,
  r`\neg\bigwedge_{i} \varphi_i \equiv \bigvee_{i} \neg\varphi_i`,
  r`\begin{array}{cc|c} A & B & A \wedge B \\ \hline T & T & T \\ T & F & F \\ F & T & F \\ F & F & F \end{array}`,
  r`\begin{array}{cc|c} A & B & A \rightarrow B \\ \hline T & T & T \\ T & F & F \\ F & T & T \\ F & F & T \end{array}`,
  r`\mathrm{Th}(\mathcal{M}) = \{\varphi \mid \mathcal{M} \vDash \varphi\}`,
  r`\mathrm{Cn}(\Gamma) = \{\varphi \mid \Gamma \vdash \varphi\}`,
  r`\mathrm{PA} \nvdash \mathrm{Con}(\mathrm{PA})`,
  r`\mathrm{Con}(T) \equiv \neg\mathrm{Prov}_T(\ulcorner\bot\urcorner)`,
]);

// ── Sets, relations, functions, arithmetic ──────────────────────────────────
const setInline = inline([
  r`A \subsetneq B`, r`A^{c}`, r`\overline{A}`, 
  r`(A \cup B)^{c}`, r`(A \cap B)^{c}`,
  r`A^{c} \cup B^{c}`, r`A^{c} \cap B^{c}`, r`A \cap A^{c} = \emptyset`,
  r`\{x \mid \varphi(x)\}`, r`\{x \in A \mid \varphi(x)\}`, r`\{x_1, \dots, x_n\}`,
  r`\mathcal{P}(A)`, r`\wp(A)`, r`2^{A}`, r`|A|`, r`|\mathcal{P}(A)| = 2^{|A|}`,
  r`\aleph_0`, r`\aleph_1`, r`2^{\aleph_0}`, r`2^{\aleph_0} = \aleph_1`, r`\bigcup_{i \in I} A_i`,
  r`\bigcap_{i \in I} A_i`, r`\bigcup_{n \in \omega} A_n`, r`\mathbb{N}`, r`\mathbb{Z}`, r`\mathbb{Q}`, r`\mathbb{R}`,
  r`f : A \to B`, r`f \upharpoonright A`, r`\mathrm{dom}(f)`, r`\mathrm{ran}(f)`, r`A^{B}`,
  r`x \equiv y \pmod{n}`, r`[x]_{R}`, r`\sup A`, r`\inf A`, r`V_\alpha`, r`V_{\omega}`,
  r`\mathrm{ZFC}`, r`\mathrm{ZF}`, r`\mathrm{CH}`, r`\mathrm{AC}`,
]);

const setDisplay = display([
  r`(A \cup B)^{c} = A^{c} \cap B^{c}`, r`(A \cap B)^{c} = A^{c} \cup B^{c}`,
  r`\Big(\bigcup_{i \in I} A_i\Big)^{c} = \bigcap_{i \in I} A_i^{c}`,
  r`\Big(\bigcap_{i \in I} A_i\Big)^{c} = \bigcup_{i \in I} A_i^{c}`,
  r`A \setminus (B \cup C) = (A \setminus B) \cap (A \setminus C)`,
  r`A \setminus (B \cap C) = (A \setminus B) \cup (A \setminus C)`,
  r`A \cap (B \cup C) = (A \cap B) \cup (A \cap C)`, r`A \cup (B \cap C) = (A \cup B) \cap (A \cup C)`,
  r`A \cup (A \cap B) = A`, r`A \cap (A \cup B) = A`,
  r`A \subseteq B \iff A \cap B = A`, r`A \subseteq B \iff A \cup B = B`,
  r`A = B \iff A \subseteq B \text{ and } B \subseteq A`,
  r`A \subseteq B \iff \forall x\,(x \in A \rightarrow x \in B)`,
  r`A \cap B = \{x \mid x \in A \wedge x \in B\}`, r`A \cup B = \{x \mid x \in A \vee x \in B\}`,
  r`A \setminus B = \{x \mid x \in A \wedge x \notin B\}`,
  r`A \times B = \{(a, b) \mid a \in A \text{ and } b \in B\}`,
  r`|A \cup B| = |A| + |B| - |A \cap B|`,
  r`\mathcal{P}(A) = \{B \mid B \subseteq A\}`, r`|\mathcal{P}(A)| = 2^{|A|}`, r`|A| < |\mathcal{P}(A)|`,
  r`\bigcup A = \{x \mid \exists y \in A\,(x \in y)\}`, r`\bigcap A = \{x \mid \forall y \in A\,(x \in y)\}`,
  r`\langle a, b \rangle = \{\{a\}, \{a, b\}\}`,
  r`0 = \emptyset, \quad 1 = \{0\}, \quad 2 = \{0, 1\}, \quad n + 1 = n \cup \{n\}`,
  r`\alpha + 1 = \alpha \cup \{\alpha\}`, r`\omega = \{0, 1, 2, \dots\}`,
  r`R = \{x \mid x \notin x\}`, r`R \in R \iff R \notin R`,
  r`\forall x\,\forall y\,\big(\forall z\,(z \in x \leftrightarrow z \in y) \rightarrow x = y\big)`,
  r`\forall x\,\exists y\,\forall z\,(z \in y \leftrightarrow z \subseteq x)`,
  r`\forall x\,\big(x \neq \emptyset \rightarrow \exists y\,(y \in x \wedge y \cap x = \emptyset)\big)`,
  r`\big(\varphi(0) \wedge \forall n\,(\varphi(n) \rightarrow \varphi(n + 1))\big) \rightarrow \forall n\,\varphi(n)`,
  r`\forall x\,\big(S(x) \neq 0\big)`, r`\forall x\,\forall y\,\big(S(x) = S(y) \rightarrow x = y\big)`,
  r`\forall x\,(x + 0 = x)`, r`\forall x\,\forall y\,\big(x + S(y) = S(x + y)\big)`,
  r`\forall x\,(x \cdot 0 = 0)`, r`\forall x\,\forall y\,\big(x \cdot S(y) = x \cdot y + x\big)`,
  r`\kappa < 2^{\kappa}`, r`\aleph_0 < 2^{\aleph_0}`, r`2^{\aleph_0} = |\mathbb{R}|`, r`\aleph_0 + \aleph_0 = \aleph_0 \cdot \aleph_0 = \aleph_0`,
  r`\forall \epsilon > 0\ \exists N\ \forall n > N\ \big(|a_n - L| < \epsilon\big)`,
  r`\forall \epsilon > 0\ \exists \delta > 0\ \forall x\ \big(|x - a| < \delta \rightarrow |f(x) - f(a)| < \epsilon\big)`,
  r`f'(x) = \lim_{h \to 0} \frac{f(x + h) - f(x)}{h}`, r`\int_a^b f(x)\,dx = F(b) - F(a)`,
  r`e = \lim_{n \to \infty}\left(1 + \frac{1}{n}\right)^{n}`, r`\sum_{n=0}^{\infty} \frac{1}{n!} = e`,
  r`y = mx + b`, r`m = \frac{y_2 - y_1}{x_2 - x_1}`, r`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`, r`a^2 + b^2 = c^2`,
]);

// ── Combined list ────────────────────────────────────────────────────────────
export const COMMON_MATH: ReadonlyArray<CommonMathEntry> = [
  ...probabilityInline, ...probabilityDisplay,
  ...decisionInline, ...decisionDisplay,
  ...logicInline, ...logicDisplay,
  ...setInline, ...setDisplay,
];

// Stamp that changes whenever the list's content changes (djb2 over every
// entry). Bump the prefix if the renderer's output format changes and a re-warm
// is wanted without editing the list.
export function commonMathStamp(list: ReadonlyArray<CommonMathEntry> = COMMON_MATH): string {
  let h = 5381;
  for (const e of list) {
    const s = (e.display ? 'D' : 'I') + e.tex + '\n';
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return `cm1:${list.length}:${h.toString(16)}`;
}
