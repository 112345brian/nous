// Dedupe + crash-safe progress for equation rendering. The `math` table is the
// progress record: before any rendering the article's equations are hashed
// (src/utils/mathKey.ts), deduplicated, and looked up; only the missing unique
// ones go to the WebView, in small chunks, and each chunk is written to the
// table in its own transaction before the next chunk is requested. Nothing else
// records progress, so nothing can disagree with the table. Finalizing an
// article (rewrite content_html, re-derive the AST, clear math_pending) is a
// separate step in catalog.ts that needs no rendering once every hash is stored.

import type { MathResult, MathStore } from './ports';
import type { ChunkedOptions } from './mathChunked';
import type { MathPriority } from '../utils/mathThrottlePolicy';
import { mathHash, normalizeTex } from '../utils/mathKey';

export interface MathSpotInput { tex: string; display: boolean }
export interface MathDims { w: number; h: number }

/** Render attempts per equation per app run before it is left for the next launch. */
export const MAX_RENDER_ATTEMPTS = 2;
const LOOKUP_CHUNK = 400; // SQLite's default bound-variable limit is 999
const TRANSIENT = new Set(['timeout', 'render-failed', 'missing']);

export interface EnsureResult {
  /** hash -> size, for every hash that is stored when the call returns. */
  dims: Map<string, MathDims>;
  /** True when every equation is stored or definitively unrenderable (bad TeX). */
  complete: boolean;
  /** Counts for tests/diagnostics. */
  stats: { spots: number; unique: number; alreadyStored: number; rendered: number };
}

export interface MathCacheDeps {
  store: MathStore;
  /** The chunked renderer (core/mathChunked), bound to the real renderer and pacing. */
  renderChunked: (items: MathSpotInput[], opts: ChunkedOptions) => Promise<MathResult[]>;
  /** A macrotask pause, then wait until work of this priority may run. */
  pause: (priority: MathPriority) => Promise<void>;
  /** A bare macrotask pause (no policy check). */
  macrotask: () => Promise<void>;
}

export interface MathCache {
  /**
   * Make sure the `math` table holds every equation in `spots`, rendering only what is missing.
   * `priority: null` = ungated (caller owns the schedule). Chunk failures only leave their
   * hashes missing; the rest of the article goes on.
   */
  ensureMath(spots: MathSpotInput[], priority: MathPriority | null, opts?: { chunkSize?: number }): Promise<EnsureResult>;
  /** Which of `hashes` are already stored (with their size). Looked up in bounded IN lists. */
  lookupStored(hashes: string[]): Promise<Map<string, MathDims>>;
  /** Forget this run's failure bookkeeping (a restart does the same). */
  reset(): void;
}

export function createMathCache(deps: MathCacheDeps): MathCache {
  const { store, renderChunked, pause, macrotask } = deps;

  // In memory only, by design: a restart gets a fresh try, but within one run no
  // bad equation or hung engine can loop forever. State of this instance only.
  const attempts = new Map<string, number>();
  const permanentFailures = new Set<string>(); // MathJax rejected the TeX itself
  const reset = () => { attempts.clear(); permanentFailures.clear(); };

  async function lookupStored(hashes: string[]): Promise<Map<string, MathDims>> {
    const found = new Map<string, MathDims>();
    for (let i = 0; i < hashes.length; i += LOOKUP_CHUNK) {
      const rows = await store.getMathByHashes(hashes.slice(i, i + LOOKUP_CHUNK));
      for (const r of rows) found.set(r.hash, { w: r.w, h: r.h });
    }
    return found;
  }

  async function ensureMath(spots: MathSpotInput[], priority: MathPriority | null, opts: { chunkSize?: number } = {}): Promise<EnsureResult> {
    const unique = new Map<string, MathSpotInput>();
    for (const s of spots) {
      const h = mathHash(s.tex, s.display);
      if (!unique.has(h)) unique.set(h, { tex: normalizeTex(s.tex), display: s.display });
    }
    const dims = await lookupStored([...unique.keys()]);
    const stats = { spots: spots.length, unique: unique.size, alreadyStored: dims.size, rendered: 0 };

    for (let pass = 0; ; pass++) {
      const todo = [...unique.keys()].filter(h =>
        !dims.has(h) && !permanentFailures.has(h) && (attempts.get(h) ?? 0) < MAX_RENDER_ATTEMPTS);
      if (!todo.length) break;
      if (pass > 0) {
        if (priority) await pause(priority);
        else await macrotask();
      }

      const onChunk = async (start: number, results: MathResult[]) => {
        const rows: Array<{ hash: string; svg: string; w: number; h: number; display: boolean }> = [];
        results.forEach((r, i) => {
          const hash = todo[start + i];
          if (r.b64 && !r.error) {
            rows.push({ hash, svg: atob(r.b64), w: r.w ?? 1, h: r.h ?? 1, display: unique.get(hash)!.display });
          } else if (r.error && !TRANSIENT.has(r.error)) {
            permanentFailures.add(hash);
          } else {
            attempts.set(hash, (attempts.get(hash) ?? 0) + 1);
          }
        });
        // The unit of durability: stored before the next chunk is requested.
        await store.putMathBatch(rows);
        for (const r of rows) dims.set(r.hash, { w: r.w, h: r.h });
        stats.rendered += rows.length;
      };
      await renderChunked(todo.map(h => unique.get(h)!), { priority, chunkSize: opts.chunkSize, onChunk });
    }

    const complete = [...unique.keys()].every(h => dims.has(h) || permanentFailures.has(h));
    return { dims, complete, stats };
  }

  return { ensureMath, lookupStored, reset };
}
