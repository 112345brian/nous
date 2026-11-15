// Pure: TeX detection in SEP article HTML.

// Same pattern as the substitution regex in services/catalog.ts, but without the `g` flag, so
// testing with it carries no `lastIndex` state between calls.
const TEX_SPAN = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/;

/** True when `html` contains a complete TeX span, \( ... \) or \[ ... \], still to be rendered. */
export function hasTexSpan(html: string): boolean {
  return TEX_SPAN.test(html);
}
