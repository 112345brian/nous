import type { Annotation } from '../types';
import type { AnnotationStore, AppPrefsStore } from './ports';

export type ZoteroPrep =
  | { status: 'not_configured' }
  | { status: 'ready'; apiKey: string; userId: string; annotations: Annotation[] };

/** The Zotero credentials and the article's highlights, or 'not_configured' when either credential is empty. */
export async function prepareZoteroSend(
  stores: { prefs: Pick<AppPrefsStore, 'getZoteroPrefs'>; annotations: Pick<AnnotationStore, 'getAnnotationsForSlug'> },
  slug: string,
): Promise<ZoteroPrep> {
  const { apiKey, userId } = await stores.prefs.getZoteroPrefs();
  if (!apiKey || !userId) return { status: 'not_configured' };
  return { status: 'ready', apiKey, userId, annotations: await stores.annotations.getAnnotationsForSlug(slug) };
}
