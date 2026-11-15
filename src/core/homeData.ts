import type { AnnotationWithTitle, EntrySummary } from '../types';
import type { AnnotationStore, BookmarkStore, ReaderStateStore } from './ports';

export interface HomeData {
  history: EntrySummary[];
  bookmarks: EntrySummary[];
  annotations: AnnotationWithTitle[];
}

export const HOME_RECENT_LIMIT = 12;

/** The three lists the library tab shows, read together. */
export async function loadHomeData(stores: {
  reads: Pick<ReaderStateStore, 'getRecentSlugs'>;
  bookmarks: Pick<BookmarkStore, 'getBookmarks'>;
  annotations: Pick<AnnotationStore, 'getAllAnnotations'>;
}): Promise<HomeData> {
  const [history, bookmarks, annotations] = await Promise.all([
    stores.reads.getRecentSlugs(HOME_RECENT_LIMIT),
    stores.bookmarks.getBookmarks(),
    stores.annotations.getAllAnnotations(),
  ]);
  return { history, bookmarks, annotations };
}
