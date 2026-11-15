// Linkifies an HTML string by wrapping first-occurrence article title mentions
// in <a class="wl" href="/entries/slug/"> tags. Runs at article cache time
// (not at render time) so the stored content_html is already linked.
//
// Skips text inside <a>, <code>, <pre>, <script>, <style>, <h1-3>, <cite>,
// <blockquote> to avoid double-linking or corrupting existing markup.

import { LINK_MAP_JSON } from '../assets/linkMapData';

type LinkEntry = { s: string; t: string; p: string };

// The link index is a parameter: createLinkifier() takes the index JSON and keeps its
// compiled state in a closure, so it can be tested with a tiny fake index. linkifyHtml()
// is the app's default, a lazily built instance over the bundled index.

const SKIP_OPEN  = /^<(a|code|pre|script|style|h[123]|cite|blockquote)\b/i;
const SKIP_CLOSE = /^<\/(a|code|pre|script|style|h[123]|cite|blockquote)>/i;

export function createLinkifier(linkMapJson: string): (html: string) => string {
  const entries: LinkEntry[] = JSON.parse(linkMapJson);
  // An empty index would compile to /(?:)/, which matches the empty string forever (lastIndex
  // never advances in the loop below). The original code hung here; link nothing instead.
  if (entries.length === 0) return (html: string) => html;
  const map: Record<string, string> = Object.create(null);
  for (const e of entries) map[e.t.toLowerCase()] = e.s;
  const re = new RegExp('(?:' + entries.map(e => e.p).join('|') + ')', 'gi');
  return (html: string): string => {
    const linked = new Set<string>();
    let skipDepth = 0;

    return html.split(/(<[^>]*>)/g).map(part => {
      if (part.startsWith('<')) {
        if (SKIP_OPEN.test(part))  skipDepth++;
        else if (SKIP_CLOSE.test(part)) skipDepth = Math.max(0, skipDepth - 1);
        return part;
      }
      if (skipDepth > 0 || !part.trim()) return part;

      re.lastIndex = 0;
      let result = '';
      let last = 0;
      let m: RegExpExecArray | null;

      while ((m = re.exec(part)) !== null) {
        const lo = m[0].toLowerCase();
        if (m.index > last) result += part.slice(last, m.index);
        if (!linked.has(lo) && map[lo]) {
          linked.add(lo);
          result += `<a href="/entries/${map[lo]}/" class="wl">${m[0]}</a>`;
        } else {
          result += m[0];
        }
        last = m.index + m[0].length;
      }
      result += part.slice(last);
      return result;
    }).join('');
  };
}

// Default instance over the bundled index, built on first use (parsing the index and
// compiling its regex is deferred until the first article is cached).
// KNOWN EXCEPTION in src/utils/__tests__/innerRing.test.ts: this is the one remaining hidden
// cache in the inner ring. Move it next to the other wiring in src/services once catalog.ts
// is no longer being edited, then delete the exception.
let _default: ((html: string) => string) | null = null;

export function linkifyHtml(html: string): string {
  if (!_default) _default = createLinkifier(LINK_MAP_JSON);
  return _default(html);
}
