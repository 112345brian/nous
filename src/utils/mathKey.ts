// The key of the `math` table: one definition, pure (no I/O). An equation is
// identified by its normalized TeX plus the display flag, so the same equation
// typed with different whitespace, or appearing in many articles, is typeset once.

// Only whitespace is normalized. Braces and commands are left alone: `x_1` and
// `x_{1}` render identically but are different TeX, and rewriting TeX could
// change its meaning.
export function normalizeTex(tex: string): string {
  return tex.replace(/\s+/g, ' ').trim();
}

// 64-bit hash: two independent djb2-xor passes with different seeds (birthday
// collision at ~2^32 unique inputs, essentially impossible across the SEP corpus).
// Takes the string exactly as given; normalization happens in mathHash.
export function hash64(input: string, display: boolean): string {
  let h1 = 5381, h2 = 52711;
  const s = input + (display ? '\x01' : '\x00');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (((h1 << 5) + h1) ^ c) >>> 0;
    h2 = (((h2 << 5) + h2) ^ c) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** The `math` table key for an equation. */
export function mathHash(tex: string, display: boolean): string {
  return hash64(normalizeTex(tex), display);
}
