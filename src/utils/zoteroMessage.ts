import type { Annotation } from '../types';

/** The confirmation shown after a successful send. */
export function zoteroSavedMessage(title: string, annotations: Pick<Annotation, 'content_hash'>[]): string {
  const versionCount = new Set(annotations.map(a => a.content_hash ?? '__current__')).size;
  const versionNote = versionCount > 1 ? ` across ${versionCount} versions` : '';
  return annotations.length > 0
    ? `"${title}" and ${annotations.length} highlight${annotations.length > 1 ? 's' : ''}${versionNote} added to your Zotero library.`
    : `"${title}" was added to your Zotero library.`;
}
