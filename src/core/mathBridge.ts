// The protocol and state machine behind the hidden MathJax WebView, as ONE instance made by a
// factory. All state (the registered inject function, the ready promise, the preload promise,
// the request counter and the pending-request map) is closure state, so two bridges never share
// anything and a test can build a fresh one per case.
//
// The bridge is both:
//   - the `MathRenderer` port the core sees (`render`), and
//   - the host-side surface the WebView component registers into (`attach`, `onMessage`,
//     `onDomReady`, `reset`), so the component imports the instance from the root, never a
//     module in services.
//
// What it does not do: load the MathJax asset or touch a WebView. Those are the adapter's:
// `loadEngineScript` resolves to the JavaScript to inject (the engine plus its loader), and
// `attach` receives the function that injects JavaScript into the page.
//
// Timeouts are unchanged from the module it replaces: a render waits up to 20 s for MathJax to
// report ready (first use), then up to 30 s for the batch to come back; on either, every item of
// the batch gets `error: 'timeout'` so callers fall back to raw TeX instead of blocking.
import type { MathRenderer, MathRequest, MathResult } from './ports';

export const READY_TIMEOUT_MS = 20000;
export const BATCH_TIMEOUT_MS = 30000;

export interface MathBridgeDeps {
  /** Resolves to the JavaScript that installs the MathJax engine in the page. May reject. */
  loadEngineScript(): Promise<string>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface MathBridge extends MathRenderer {
  /** Start loading and injecting the engine. Idempotent; a failed load may be retried. */
  preload(): Promise<void>;
  /** True once a WebView has registered its inject function. */
  isAttached(): boolean;
  /** The WebView component registers the function that runs JavaScript in the page. */
  attach(inject: (js: string) => void): void;
  /** Every postMessage from the page, as the raw string. Malformed or unknown ones are ignored. */
  onMessage(raw: string): void;
  /** The page finished loading (onLoadEnd). Does not inject the engine; see `preload`. */
  onDomReady(): void;
  /** Forget a ready signal and a preload, but only while no WebView is attached (remount safety). */
  reset(): void;
}

export function createMathBridge(deps: MathBridgeDeps): MathBridge {
  let inject: ((js: string) => void) | null = null;
  let resolveReady: (() => void) | null = null;
  const newReady = () => new Promise<void>(r => { resolveReady = r; });
  let readyPromise: Promise<void> = newReady();
  let loading: Promise<void> | null = null;
  let seq = 0;
  const pending = new Map<number, (results: MathResult[]) => void>();

  // Wait for a promise but give up after `ms`, resolving with `fallback` instead.
  function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>(resolve => {
      let done = false;
      const t = deps.setTimer(() => { if (!done) { done = true; resolve(fallback); } }, ms);
      p.then(v => { if (!done) { done = true; deps.clearTimer(t); resolve(v); } });
    });
  }

  function preload(): Promise<void> {
    if (loading) return loading;
    loading = (async () => {
      const js = await deps.loadEngineScript();
      inject?.(js);
    })().catch(() => { loading = null; });
    return loading;
  }

  async function render(items: MathRequest[]): Promise<MathResult[]> {
    if (!items.length) return [];
    const errAll = (): MathResult[] => items.map(it => ({ ...it, error: 'timeout' }));
    // Trigger the engine load if it hasn't been started yet (lazy mode).
    void preload();
    // Wait for MathJax to initialize the first time.
    const ready = await withTimeout(readyPromise.then(() => true), READY_TIMEOUT_MS, false);
    if (!ready || !inject) return errAll();
    const reqId = ++seq;
    const result = new Promise<MathResult[]>(resolve => pending.set(reqId, resolve));
    // JSON.stringify produces a valid JS literal, safe to embed in the injected call.
    inject(`window.__renderMath(${JSON.stringify({ reqId, items })}); true;`);
    // Generous per-batch timeout (large articles, slow devices).
    return withTimeout(result, BATCH_TIMEOUT_MS, errAll()).then(r => { pending.delete(reqId); return r; });
  }

  return {
    render,
    preload,
    isAttached: () => inject != null,
    attach(fn) { inject = fn; },
    onDomReady() { /* nothing to do: the engine is injected by preload(), not by the page load */ },
    onMessage(raw) {
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg?.type === 'ready') { resolveReady?.(); return; }
      if (msg?.type === 'result' && typeof msg.reqId === 'number') {
        const resolve = pending.get(msg.reqId);
        if (resolve) { pending.delete(msg.reqId); resolve(msg.out as MathResult[]); }
      }
    },
    reset() {
      if (!inject) {
        loading = null;
        readyPromise = newReady();
      }
    },
  };
}
