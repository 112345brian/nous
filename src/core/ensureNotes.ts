// Use case UC-C4: make sure an already-cached article has its footnotes. If the body refers to
// them but they were never stored (the article was downloaded before footnotes were fetched),
// fetch and keep them.
import type { ArticleSource, NotesStore } from './ports';
import { referencesNotes } from '../utils/sepArticlePage';

export interface EnsureNotesDeps {
  source: Pick<ArticleSource, 'fetchNotesHtml'>;
  library: NotesStore;
}

/** The notes HTML, or null when the body has no footnotes or they cannot be had. */
export async function ensureNotesCached(
  deps: EnsureNotesDeps,
  slug: string,
  contentHtml: string | null,
): Promise<string | null> {
  if (!contentHtml || !referencesNotes(contentHtml)) return null;
  const notes = await deps.source.fetchNotesHtml(slug);
  if (notes) await deps.library.setEntryNotes(slug, notes);
  return notes;
}
