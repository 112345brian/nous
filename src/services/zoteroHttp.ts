// Adapter: the Zotero web API over fetch. Implements the ZoteroHttp port from
// src/core/ports.ts; wired in src/composition.ts.
import type { ZoteroHttp } from '../core/ports';

export function zoteroHttp(apiKey: string, userId: string): ZoteroHttp {
  const apiBase = `https://api.zotero.org/users/${userId}`;
  const headers = {
    'Zotero-API-Key': apiKey,
    'Zotero-API-Version': '3',
    'Content-Type': 'application/json',
  };
  return {
    post: (path, body) =>
      fetch(`${apiBase}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}
