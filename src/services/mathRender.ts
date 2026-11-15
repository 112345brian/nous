// Adapter for the hidden MathRenderWebView. MathJax (mathjax-full) cannot run in the Hermes JS
// runtime — it fails at module init ("Cannot read property 'mathjax' of undefined"). So TeX → SVG
// rendering happens inside a real browser engine: an off-screen WebView that loads MathJax and
// converts equations on request. The resulting SVGs are baked into content_html as <math-i>
// elements (see catalog.ts), so the native renderer never needs MathJax at read time.
//
// This file is only the asset side: MathJax is stored as a Metro asset
// (src/assets/mathjax-full.b64) rather than a JS module so it's not parsed on every cold start;
// it is read from disk and wrapped in a snippet that installs it in the page. The bridge protocol
// (ready wait, request ids, timeouts, routing results) is src/core/mathBridge.ts, built once in
// src/composition.ts. No state lives here.

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';

/** Read the MathJax asset from disk and return the JavaScript that installs it in the page. */
export async function loadMathJaxScript(): Promise<string> {
  const asset = Asset.fromModule(require('../assets/mathjax-full.b64'));
  await asset.downloadAsync();
  const b64 = await FileSystem.readAsStringAsync(asset.localUri!);
  return `(function(){
  try {
    var src = atob(${JSON.stringify(b64)});
    var s = document.createElement('script');
    s.text = src;
    document.head.appendChild(s);
  } catch(e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',error:String(e)}));
  }
})(); true;`;
}
