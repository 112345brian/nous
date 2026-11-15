// Test stand-in for the WebView math bridge (core/mathBridge): `render` is whatever the test
// supplies; the host side does nothing. Used through
//   jest.mock('../../core/mathBridge', () => ({ createMathBridge: () => require('./fakeMathBridge').fakeMathBridge(...) }))
// so the composition root's real wiring runs against a fake renderer.
export function fakeMathBridge(render: (items: Array<{ tex: string; display: boolean }>) => Promise<unknown[]>) {
  return {
    render,
    preload: async () => {},
    isAttached: () => false,
    attach: () => {},
    onMessage: () => {},
    onDomReady: () => {},
    reset: () => {},
  };
}
