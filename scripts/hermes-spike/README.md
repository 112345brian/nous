# MathJax-in-Hermes spike harness (dev only)

Runs MathJax under the standalone `hermes` CLI that ships with react-native (same
engine version as RN 0.81.6; no JIT, source of truth for "does it run on Hermes").

```bash
npm ci --ignore-scripts
H=node_modules/react-native/sdks/hermesc/osx-bin
npx react-native bundle --entry-file scripts/hermes-spike/bench-run.js --platform ios \
  --dev false --minify false --bundle-output /tmp/bench.js
$H/hermesc -O -emit-binary -out /tmp/bench.hbc /tmp/bench.js
$H/hermes /tmp/bench.hbc           # prints one JSON line of timings
```

Other entries: `entry.js` (smoke), `corpus-run.js` (prints one JSON row per corpus
entry), `slice-run.js` (time-budgeted slicing). `corpus.js` = hand-written fixtures;
`gen500.js` = deterministic 500 unique templated equations. The CLI has no timers,
`Promise`, or `performance.now`, so timings are `Date.now()` (1 ms resolution).
