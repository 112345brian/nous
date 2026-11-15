import type { Annotation } from '../types';
import type { AnnotationStore } from './ports';
import { reanchorAll } from '../utils/reanchor';

export interface ReanchorOutcome {
  /** Highlights moved onto the new version. */
  succeededIds: number[];
  /** How many could not be found in the new version. */
  failed: number;
  total: number;
  /** The text to show the reader. */
  message: string;
}

export function reanchorMessage(succeeded: number, total: number): string {
  return succeeded === total
    ? `All ${succeeded} highlight${succeeded > 1 ? 's' : ''} re-anchored to the new version.`
    : `${succeeded} re-anchored. ${total - succeeded} could not be found in the new version.`;
}

/** Look for each orphaned highlight in the new article text and save the ones that are found. */
export async function reanchorOrphans(
  store: Pick<AnnotationStore, 'updateAnnotationAnchor'>,
  annotations: Annotation[],
  currentContent: string,
  currentHash: string,
): Promise<ReanchorOutcome> {
  const results = reanchorAll(annotations, currentContent);
  const succeeded = results.filter(r => r.found);
  await Promise.all(succeeded.map(r => store.updateAnnotationAnchor(r.id, r.newText, currentHash)));
  return {
    succeededIds: succeeded.map(r => r.id),
    failed: results.length - succeeded.length,
    total: results.length,
    message: reanchorMessage(succeeded.length, results.length),
  };
}

/** Delete orphaned highlights; resolves to the ids deleted. */
export async function deleteOrphans(
  store: Pick<AnnotationStore, 'deleteAnnotations'>,
  ids: number[],
): Promise<number[]> {
  await store.deleteAnnotations(ids);
  return ids;
}
