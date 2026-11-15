// Turns what the reader typed into an FTS5 MATCH expression: every word becomes a
// quoted prefix term ("word"*), joined by spaces (AND). Inside an FTS5 string a
// double quote is written "" so the reader can type quotes, apostrophes, dashes,
// parentheses and so on without producing a syntax error ("unterminated string").
// Returns null when there is nothing to search for.
export function buildFtsQuery(input: string): string | null {
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return words.map(w => `"${w.replace(/"/g, '""')}"*`).join(' ');
}
