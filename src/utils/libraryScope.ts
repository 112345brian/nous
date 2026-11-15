// Pure: SQL shaping and text counting moved out of services/db.ts.

// Library scope filter, bound as a parameter. `scope` is typed as a closed union
// but not guaranteed at runtime: getPrefs casts an untyped meta string, and
// importUserData can set that string from a sync-folder file. A value outside
// the union therefore matches no rows instead of being spliced into the SQL.
export function scopeFilter(scope: 'all' | 'sep' | 'owl'): { where: string; params: string[] } {
  return scope === 'all'
    ? { where: '', params: [] }
    : { where: 'WHERE source = ?', params: [scope] };
}

export function countWords(html: string): number {
  return html.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}
