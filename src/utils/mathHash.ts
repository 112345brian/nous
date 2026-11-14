// 64-bit hash of a TeX equation (or SVG bytes) + display flag. Two independent
// djb2-xor passes with different seeds; birthday collision at ~2^32 unique inputs
// vs. the ~65k bound of a 32-bit hash, making collisions essentially impossible
// across the SEP corpus. Existing 8-char hashes (32-bit) in the DB remain valid.
export function mathHash(input: string, display: boolean): string {
  let h1 = 5381, h2 = 52711;
  const s = input + (display ? '\x01' : '\x00');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (((h1 << 5) + h1) ^ c) >>> 0;
    h2 = (((h2 << 5) + h2) ^ c) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
