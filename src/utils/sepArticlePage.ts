// Pure: pick an SEP entry page apart. No I/O: callers pass the page HTML in.
import { extractById, extractMetaContent, extractAuthor } from './sepPage';

export interface ArticleParts {
  tocHtml: string | null;
  preambleHtml: string | null;
  /** The article body as it appears on the page (still starts with the <h1> title), or null. */
  rawContentHtml: string | null;
  author: string | null;
  /** Publication date as SEP writes it, e.g. "2002/10/29". */
  pubDate: string | null;
}

export function extractArticleParts(html: string): ArticleParts {
  return {
    tocHtml: extractById(html, 'toc'),
    preambleHtml: extractById(html, 'preamble'),
    rawContentHtml: extractById(html, 'aueditable') || extractById(html, 'article-content'),
    author: extractMetaContent(html, 'citation_author') ?? extractAuthor(html),
    pubDate: extractMetaContent(html, 'citation_publication_date'),
  };
}

/** aueditable starts with <h1> (title) which the template re-adds itself. */
export function stripArticleHeader(rawContentHtml: string): string {
  return rawContentHtml.replace(/^\s*<!--[^>]*-->\s*/, '').replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '');
}

/** True when the body contains TeX written as \( ... \) or \[ ... \]. */
export function hasTex(html: string): boolean {
  return html.includes('\\(') || html.includes('\\[');
}

/** True when the body links to footnotes on the sibling notes.html page. */
export function referencesNotes(html: string): boolean {
  return /notes\.html#note/i.test(html);
}
