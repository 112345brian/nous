import type { AnnotationWithTitle } from '../types';

export interface ArticleGroup {
  slug: string;
  title: string | null;
  items: AnnotationWithTitle[];
}

/** Highlights grouped by article, in the order each article first appears. */
export function groupAnnotationsByArticle(annotations: AnnotationWithTitle[]): ArticleGroup[] {
  const map = new Map<string, ArticleGroup>();
  for (const ann of annotations) {
    if (!map.has(ann.slug)) {
      map.set(ann.slug, { slug: ann.slug, title: ann.article_title, items: [] });
    }
    map.get(ann.slug)!.items.push(ann);
  }
  return Array.from(map.values());
}
