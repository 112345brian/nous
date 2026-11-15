// Pre-render the curated generic formulas (src/data/commonMath.ts) into the
// `math` table so the first articles find them cached. Pure logic with every
// dependency injected (render, hash, cache lookup/write, stamp storage) so it is
// testable with fakes; the real wiring lives in commonMathWiring.ts.
//
// Contract:
//   - stamp current            -> nothing happens (no lookup, no render)
//   - otherwise                -> hashes already in the table are skipped; only
//                                 missing ones are rendered, `chunkSize` at a time,
//                                 and each chunk is written before the next renders
//   - stamp is recorded only when nothing is left to render and nothing failed,
//     so a partial run resumes (cheaply: cached hashes are skipped) next time
//   - a chunk that renders nothing (engine down / timeout) ends the run
//
// Never imports React Native, the DB or the WebView bridge.

import type { MathReq, MathResult } from './mathRender';

export interface PrewarmRow { hash: string; svg: string; w: number; h: number; display: boolean }

export interface PrewarmDeps {
  list: ReadonlyArray<{ tex: string; display: boolean }>;
  /** Version stamp of the list (see commonMathStamp). */
  stamp: string;
  hash(tex: string, display: boolean): string;
  /** hash -> svg for the hashes that exist (db.getMathSvgMap). */
  getCachedSvgMap(hashes: string[]): Promise<Record<string, string>>;
  /** mathRender.renderMathBatch */
  render(items: MathReq[]): Promise<MathResult[]>;
  /** db.putMathBatch */
  putBatch(rows: PrewarmRow[]): Promise<void>;
  getStamp(): Promise<string | null>;
  setStamp(stamp: string): Promise<void>;
  /** Equations per render call. Default 8. */
  chunkSize?: number;
  /** Awaited before every chunk: the hook for a priority/yield API (e.g. whenMayRun). */
  beforeChunk?: () => Promise<void>;
  /** atob; injectable for tests/environments without it. */
  decode?: (b64: string) => string;
}

export interface PrewarmOptions {
  /** Stop after this many chunks (resume on the next call). Default: all. */
  maxChunks?: number;
}

export interface PrewarmResult {
  status: 'current' | 'done' | 'partial';
  skipped: number;   // already cached
  rendered: number;  // newly written this call
  failed: number;    // render errors this call
  remaining: number; // missing hashes not yet attempted or failed
}

const LOOKUP_BATCH = 200; // keep well under SQLite's bound-variable limit

export const DEFAULT_PREWARM_CHUNK = 8;

export async function prewarmCommonMath(deps: PrewarmDeps, opts: PrewarmOptions = {}): Promise<PrewarmResult> {
  if ((await deps.getStamp()) === deps.stamp) {
    return { status: 'current', skipped: 0, rendered: 0, failed: 0, remaining: 0 };
  }
  const chunkSize = Math.max(1, deps.chunkSize ?? DEFAULT_PREWARM_CHUNK);
  const decode = deps.decode ?? ((b: string) => atob(b));

  // Unique entries by hash.
  const byHash = new Map<string, { tex: string; display: boolean }>();
  for (const e of deps.list) {
    const h = deps.hash(e.tex, e.display);
    if (!byHash.has(h)) byHash.set(h, e);
  }
  const hashes = [...byHash.keys()];

  const cached = new Set<string>();
  for (let i = 0; i < hashes.length; i += LOOKUP_BATCH) {
    const map = await deps.getCachedSvgMap(hashes.slice(i, i + LOOKUP_BATCH));
    for (const h of Object.keys(map)) cached.add(h);
  }
  const missing = hashes.filter(h => !cached.has(h));
  const skipped = hashes.length - missing.length;

  let rendered = 0;
  let failed = 0;
  let next = 0;
  let chunks = 0;
  const maxChunks = opts.maxChunks ?? Infinity;
  while (next < missing.length && chunks < maxChunks) {
    await deps.beforeChunk?.();
    const slice = missing.slice(next, next + chunkSize);
    next += slice.length;
    chunks++;
    const items: MathReq[] = slice.map(h => ({ tex: byHash.get(h)!.tex, display: byHash.get(h)!.display }));
    const results = await deps.render(items);
    const rows: PrewarmRow[] = [];
    slice.forEach((h, i) => {
      const r = results[i];
      if (!r || r.error || !r.b64) { failed++; return; }
      rows.push({ hash: h, svg: decode(r.b64), w: r.w ?? 1, h: r.h ?? 1, display: items[i].display });
    });
    if (rows.length) {
      await deps.putBatch(rows);
      rendered += rows.length;
    } else {
      break; // nothing came back: engine unavailable; try again next launch
    }
  }

  if (next >= missing.length && failed === 0) {
    await deps.setStamp(deps.stamp);
    return { status: 'done', skipped, rendered, failed, remaining: 0 };
  }
  // Everything missing that is still not in the table (not yet attempted, or failed).
  return { status: 'partial', skipped, rendered, failed, remaining: missing.length - rendered };
}
