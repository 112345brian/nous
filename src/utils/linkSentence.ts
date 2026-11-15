// The sentence in an article's HTML that contains a link to another entry, as plain text.

/** Find the sentence in `html` that contains a link to `linkSlug`; null when there is none. */
export function findLinkSentence(html: string, linkSlug: string): string | null {
  const linkRe = new RegExp(`[^.!?]*<a [^>]*href=["'][^"']*\\/entries\\/${linkSlug}\\/[^"']*["'][^>]*>[^<]*<\\/a>[^.!?]*[.!?]?`, 'i');
  const m = html.match(linkRe);
  if (!m) return null;
  // Strip all HTML tags, decode common entities, normalise whitespace
  const decoded = m[0]
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:ldquo|rdquo);/g, '"')
    .replace(/&(?:lsquo|rsquo|squo);/g, "’")
    .replace(/&(?:mdash|ndash);/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/^[\s"'‘’“”.,;:]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded.slice(0, 480) || null;
}
