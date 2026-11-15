// Download-progress notifications: when to show an update. What is shown (an Android progress bar,
// an iOS text notification) is the sink's business. The clock is a parameter.
import type { Clock, ProgressNotifier, ProgressSink } from './ports';

// Update at most once per 3 seconds or every 30 articles, whichever comes first.
export const UPDATE_INTERVAL_MS = 3000;
export const UPDATE_INTERVAL_ARTICLES = 30;

export function createProgressNotifier(deps: { sink: ProgressSink; clock: Clock }): ProgressNotifier {
  const { sink, clock } = deps;
  let lastUpdateTime = 0;
  let lastUpdateDone = -1;

  return {
    async start() {
      lastUpdateTime = 0;
      lastUpdateDone = -1;
      await sink.start();
    },
    async update(done, total) {
      const now = clock.now();
      if (done - lastUpdateDone < UPDATE_INTERVAL_ARTICLES && now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
      lastUpdateDone = done;
      lastUpdateTime = now;
      sink.update(done, total);
    },
    finish: total => sink.finish(total),
  };
}
