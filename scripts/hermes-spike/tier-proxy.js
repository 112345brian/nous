// PROXY for the tiered-math classifier (the real src/utils/mathTier.ts lives on another
// branch). "Simple" = what that classifier is described to catch: one variable/digit/Greek/
// logic-symbol token, simple binary op between two such tokens, single-token sub/superscript.
const TOK = String.raw`(?:[A-Za-z0-9]|\\[A-Za-z]+)`;
const SIMPLE = new RegExp(`^${TOK}(?:[_^](?:${TOK}|\\{${TOK}\\}))*(?:\\s*(?:[-+=<>/]|\\\\(?:cdot|times|neq|leq|geq|to|land|lor|in|subset|wedge|vee|leftrightarrow))\\s*${TOK}(?:[_^](?:${TOK}|\\{${TOK}\\}))*)?$`);
const BIG = /\\(frac|sqrt|sum|prod|int|begin|text|mathbb|mathcal|mathbf|left|binom|lim|require|newcommand|def|overline|underbrace|xrightarrow|cancel|boxed|color)\b/;
module.exports = raw => { const t = raw.startsWith('D:') ? raw.slice(2) : raw; return !raw.startsWith('D:') && SIMPLE.test(t.trim()) && !BIG.test(t); };
