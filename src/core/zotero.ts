// Use case UC-E4: export a bookmark (and its annotations, one Zotero item per article
// version) to Zotero. HTTP, the version-date lookup and the clock are injected.
import type { Annotation } from '../types';
import type { Clock, ZoteroHttp } from './ports';

export interface ZoteroDeps {
  http: ZoteroHttp;
  /** When this reader downloaded the version of `slug` with content hash `hash` (epoch ms). */
  versionDate(slug: string, hash: string): Promise<number | null>;
  clock: Clock;
}

export interface ZoteroBookmark {
  slug: string;
  title: string;
  author: string | null;
  pub_date: string | null;
}

export async function exportBookmarkToZotero(
  deps: ZoteroDeps,
  item: ZoteroBookmark,
  annotations: Annotation[] = []
): Promise<'ok' | 'auth_error' | 'error'> {
  // Group annotations by content_hash — each unique hash is a separate article version
  const byVersion = new Map<string, Annotation[]>();
  for (const ann of annotations) {
    const key = ann.content_hash ?? '__current__';
    const bucket = byVersion.get(key) ?? [];
    bucket.push(ann);
    byVersion.set(key, bucket);
  }
  // If there are no annotations at all, still export one item
  if (byVersion.size === 0) byVersion.set('__current__', []);

  const creators = parseCreators(item.author);
  const today = new Date(deps.clock.now()).toISOString().slice(0, 10);

  try {
    for (const [hash, versionAnns] of byVersion) {
      // Resolve the access date: when we downloaded this specific version
      let accessDate = today;
      if (hash !== '__current__') {
        const ts = await deps.versionDate(item.slug, hash);
        if (ts) accessDate = new Date(ts).toISOString().slice(0, 10);
      }

      const entryItem = {
        itemType: 'encyclopediaArticle',
        title: item.title,
        encyclopediaTitle: 'Stanford Encyclopedia of Philosophy',
        creators: [
          ...creators,
          { creatorType: 'editor', lastName: 'Zalta', firstName: 'Edward N.' },
          { creatorType: 'editor', lastName: 'Nodelman', firstName: 'Uri' },
        ],
        url: `https://plato.stanford.edu/entries/${item.slug}/`,
        accessDate,
        date: item.pub_date?.replace(/\//g, '-') ?? '',
        language: 'en',
        // Surface the version hash in Zotero's extra field for traceability
        extra: hash !== '__current__' ? `Version: ${hash}\nAccessed: ${accessDate}` : `Accessed: ${accessDate}`,
      };

      const res = await deps.http.post('/items', [entryItem]);
      if (res.status === 401 || res.status === 403) return 'auth_error';
      if (!res.ok) return 'error';

      if (versionAnns.length > 0) {
        const payload = await res.json();
        const parentKey = payload?.successful?.['0']?.key;
        if (parentKey) {
          const noteHtml = buildAnnotationNote(item.title, versionAnns, accessDate);
          await deps.http.post('/items', [{ itemType: 'note', parentItem: parentKey, note: noteHtml }]);
        }
      }
    }

    return 'ok';
  } catch {
    return 'error';
  }
}

function buildAnnotationNote(title: string, annotations: Annotation[], accessDate: string): string {
  const items = annotations.map(a => {
    const swatch = `background:${a.color}44;border-left:3px solid ${a.color};padding:2px 6px;border-radius:2px;`;
    const note = a.note ? `<br/><em style="color:#888;font-size:0.9em">${escHtml(a.note)}</em>` : '';
    return `<li style="${swatch} margin:6px 0;">"${escHtml(a.selected_text)}"${note}</li>`;
  }).join('\n');
  return (
    `<h3>Highlights: ${escHtml(title)}</h3>` +
    `<p style="color:#888;font-size:0.85em">Version accessed ${accessDate}</p>` +
    `<ul style="list-style:none;padding:0;">${items}</ul>`
  );
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseCreators(author: string | null) {
  if (!author) return [];
  const parts = author.split(',').map(s => s.trim());
  if (parts.length >= 2) {
    return [{ creatorType: 'author', lastName: parts[0], firstName: parts[1] }];
  }
  return [{ creatorType: 'author', name: author }];
}
