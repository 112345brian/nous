import type { Annotation, EntryRow } from '../types';
import type { AnnotationStore, KeyValueStore, LibraryReadStore, StageTimer } from './ports';
import { partitionAnnotations } from '../utils/annotationValidity';
import { resolveEntryHash } from '../utils/entryHash';

export interface LoadArticleDeps {
  library: Pick<LibraryReadStore, 'getEntry'>;
  annotations: Pick<AnnotationStore, 'getAnnotationsForSlug'>;
  meta: Pick<KeyValueStore, 'getMeta'>;
  timing: StageTimer;
  /** Download and cache the article; true when it is now in the library. */
  fetchArticle(slug: string): Promise<boolean>;
}

export type LoadArticleResult =
  | {
      status: 'ready';
      entry: EntryRow & { content_html: string };
      /** Highlights that still match this version of the article. */
      valid: Annotation[];
      /** Highlights made on another version whose text is gone. */
      stale: Annotation[];
      customCss: string | null;
      /** The stored font size, unparsed. */
      fontSize: string | null;
    }
  | { status: 'error'; message: string };

/**
 * Everything the reader needs before it can show an article: the entry (fetched first when it is
 * not stored, or when `forceRefetch`), the reader's highlights split into valid and stale, and
 * the two display settings. The highlight and setting reads start before the entry read so they
 * overlap with it and with a cold-open network fetch.
 * `onFetching` fires when a download starts. Rejects only if a store read rejects.
 */
export async function loadArticleForReading(
  deps: LoadArticleDeps,
  slug: string,
  forceRefetch: boolean,
  onFetching: () => void = () => {},
): Promise<LoadArticleResult> {
  const aux = Promise.all([
    deps.annotations.getAnnotationsForSlug(slug),
    deps.meta.getMeta('custom_css'),
    deps.meta.getMeta('font_size'),
  ]);
  aux.catch(() => {}); // early returns below must not leave an unhandled rejection

  const read = () => deps.timing.time(slug, 'get-entry', () => deps.library.getEntry(slug));
  let entry = forceRefetch ? null : await read();

  if (!entry?.content_html || forceRefetch) {
    onFetching();
    const ok = await deps.fetchArticle(slug);
    if (!ok) return { status: 'error', message: 'Could not load this article. Check your connection.' };
    entry = await read();
  }

  if (!entry?.content_html) return { status: 'error', message: 'Article content unavailable.' };

  const [anns, customCss, fontSize] = await aux;
  const { valid, stale } = partitionAnnotations(anns, resolveEntryHash(entry), () => entry!.content_html ?? '');
  return { status: 'ready', entry: entry as EntryRow & { content_html: string }, valid, stale, customCss, fontSize };
}
