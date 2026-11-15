// Chunked front end for renderMathBatch. A large article becomes a series of
// small WebView messages, one in flight at a time, each preceded by a yield
// point so a higher-priority hold or reader activity stops the work at the next
// chunk boundary. A batch already inside the WebView cannot be cancelled, so
// chunkSize bounds how much work can still run after the reader acts.

import { renderMathBatch, MathReq, MathResult } from './mathRender';
import { DEFAULT_THROTTLE_CONFIG, MathPriority, chunkRanges } from '../utils/mathThrottlePolicy';
import { whenMathMayRun, yieldThenMathMayRun, macrotask } from './mathPriority';

export interface ChunkedOptions {
  /** null = ungated: the caller owns the schedule (e.g. runs under a download hold); only yields a macrotask between chunks. */
  priority: MathPriority | null;
  /** Equations per message. Infinity (or >= items.length) = the old single batch. */
  chunkSize?: number;
  /**
   * Awaited after each chunk's results arrive and BEFORE the next chunk is requested
   * (the chunk is the unit of durability). Also called, with timeout results, for the
   * remainder that is skipped after a fully timed-out chunk. If it throws, rendering
   * stops and the error propagates.
   */
  onChunk?: (start: number, results: MathResult[]) => Promise<void>;
  render?: (items: MathReq[]) => Promise<MathResult[]>;
  /** Yield point before the first chunk / between chunks (injectable for tests). */
  firstGate?: (p: MathPriority) => Promise<void>;
  nextGate?: (p: MathPriority) => Promise<void>;
}

const isTimeout = (r: MathResult) => r.error === 'timeout';

export async function renderMathChunked(items: MathReq[], opts: ChunkedOptions): Promise<MathResult[]> {
  if (!items.length) return [];
  const render = opts.render ?? renderMathBatch;
  const first = opts.firstGate ?? whenMathMayRun;
  const next = opts.nextGate ?? yieldThenMathMayRun;
  const ranges = chunkRanges(items.length, opts.chunkSize ?? DEFAULT_THROTTLE_CONFIG.chunkSize);
  const out: MathResult[] = [];

  for (let c = 0; c < ranges.length; c++) {
    const [a, b] = ranges[c];
    // Awaited: this is the point where a hold or fresh activity pauses the work.
    const p = opts.priority;
    if (p) await (c === 0 ? first(p) : next(p));
    else if (c > 0) await macrotask();
    let res: MathResult[];
    try {
      res = await render(items.slice(a, b));
    } catch {
      res = items.slice(a, b).map(it => ({ ...it, error: 'render-failed' }));
    }
    // Per-item contract: always one result per request, in order.
    const chunkOut: MathResult[] = [];
    for (let i = a; i < b; i++) chunkOut.push(res[i - a] ?? { ...items[i], error: 'missing' });
    out.push(...chunkOut);
    await opts.onChunk?.(a, chunkOut);
    // An entirely timed-out chunk means the engine is hung: do not burn another
    // 30 s timeout per remaining chunk. The caller keeps the article pending.
    if (res.length > 0 && res.every(isTimeout)) {
      if (b < items.length) {
        const rest = items.slice(b).map(it => ({ ...it, error: 'timeout' }));
        out.push(...rest);
        await opts.onChunk?.(b, rest);
      }
      break;
    }
  }
  return out;
}
