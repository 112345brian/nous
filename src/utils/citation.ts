// Pure: formats a bibliography citation for an SEP entry. No I/O.
import type { EntryRow } from '../types';

export function formatCitation(entry: Pick<EntryRow, 'slug' | 'title' | 'author' | 'pub_date'>): string {
  const author = entry.author ?? 'Unknown';
  const date = entry.pub_date ? formatPubDate(entry.pub_date) : '';
  const url = `https://plato.stanford.edu/entries/${entry.slug}/`;
  const dateStr = date ? ` (${date})` : '';
  return `${author}. "${entry.title}". The Stanford Encyclopedia of Philosophy${dateStr}. Edward N. Zalta and Uri Nodelman (eds.). <${url}>`;
}

function formatPubDate(raw: string): string {
  const [year, month] = raw.split('/');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = parseInt(month ?? '1') - 1;
  return `${months[m] ?? ''} ${year ?? ''}`.trim();
}
