import { useCallback, useEffect, useRef, useState } from 'react';
import { getEntryCount, getMeta, getPrefs, getRecentSlugs, savePrefs } from '../services/db';
import type { Prefs } from '../services/db';
import { importSeedFromUrl } from '../composition';
import type { SeedPhase } from '../composition';
import { backfillAst, resumePendingMath, downloadAll, refreshIndexIfStale, syncCachedArticles, scheduleCommonMathPrewarm, idleScheduler, withDownloadHold, startDownloadNotification, updateDownloadNotification, finishDownloadNotification } from '../composition';
import { preloadMathJax } from '../services/mathRender';

export type AppPhase = 'booting' | 'onboarding' | 'seeding' | 'seed_error' | 'indexing' | 'index_error' | 'ready';

export interface BootResult {
  phase: AppPhase;
  seedPhase: SeedPhase | null;
  onOnboardingDone: (prefs: Prefs) => Promise<void>;
}

/**
 * Boot state machine: onboarding check, optional seed import, index refresh,
 * then (once 'ready') fire-and-forget background work. `openArticle` is used
 * for the "continue where I left off" home mode.
 */
export function useBoot(openArticle: (slug: string, title: string) => void): BootResult {
  const [phase, setPhase] = useState<AppPhase>('booting');
  const [seedPhase, setSeedPhase] = useState<SeedPhase | null>(null);

  // Latest callback without making the boot callbacks depend on its identity.
  const openArticleRef = useRef(openArticle);
  useEffect(() => { openArticleRef.current = openArticle; }, [openArticle]);

  const initialize = useCallback(async (prefs: Prefs) => {
    const count = await getEntryCount();

    if (count === 0) {
      setPhase('indexing');
      try {
        await refreshIndexIfStale();
        const newCount = await getEntryCount();
        if (newCount === 0) { setPhase('index_error'); return; }
      } catch {
        setPhase('index_error');
        return;
      }
    } else {
      await refreshIndexIfStale();
    }

    setPhase('ready');

    // Everything below is fire-and-forget — errors must NOT propagate to boot().catch(),
    // which would snap the phase from 'ready' back to 'index_error'.
    (async () => {
      if (prefs.homeMode === 'continue') {
        getRecentSlugs(1).then(recent => {
          if (recent.length > 0) {
            setTimeout(() => {
              openArticleRef.current(recent[0].slug, recent[0].title);
            }, 100);
          }
        }).catch(() => {});
      }

      // Preload MathJax eagerly only if the math queue is non-empty
      // (meaning math_pending lists articles whose TeX still needs SVG rendering)
      // or if a bulk download is about to bring in new articles that will need it.
      // Otherwise let it load lazily on first use — no point paying boot cost.
      const mathPending = ((await getMeta('math_pending')) ?? '[]') !== '[]';
      if (mathPending || prefs.downloadAll) preloadMathJax();

      if (prefs.downloadAll) {
        await startDownloadNotification();
        let lastTotal = 0;
        await downloadAll(p => {
          lastTotal = p.total;
          updateDownloadNotification(p.done, p.total).catch(() => {});
        }, undefined, prefs.libraryScope);
        finishDownloadNotification(lastTotal).catch(() => {});
      }

      // Heavy catch-up work runs one task at a time, only while the reader is idle
      // (and never while an article is opening or scrolling). The scheduler swallows
      // task errors, so nothing here can reach boot().catch().
      idleScheduler.schedule('resume-pending-math', resumePendingMath);
      idleScheduler.schedule('backfill-ast', backfillAst);
      idleScheduler.schedule('auto-deep-sync', async () => {
        const [autoSync, lastDeepSync] = await Promise.all([getMeta('auto_sync'), getMeta('last_deep_sync')]);
        if (autoSync && autoSync !== 'off') {
          const days = autoSync === '2days' ? 2 : 7;
          const elapsed = Date.now() - (lastDeepSync ? Number(lastDeepSync) : 0);
          if (elapsed > days * 24 * 60 * 60 * 1000) {
            await syncCachedArticles(() => {});
          }
        }
      });
      // Lowest priority: queued last (FIFO), so it runs after everything above.
      scheduleCommonMathPrewarm();
    })().catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      const onboardingDone = await getMeta('onboarding_done');
      if (!onboardingDone) {
        setPhase('onboarding');
        return;
      }
      await initialize(await getPrefs());
    })().catch(() => setPhase('index_error'));
  }, [initialize]);

  const onOnboardingDone = useCallback(async (prefs: Prefs) => {
    if (prefs.seedUrl) {
      setPhase('seeding');
      try {
        await withDownloadHold(() => importSeedFromUrl(prefs.seedUrl, p => setSeedPhase(p)));
      } catch {
        setPhase('seed_error');
        return;
      }
      setSeedPhase(null);
    }
    // Save prefs after any seed import so they land in the final DB, not the pre-seed one.
    await savePrefs(prefs);
    setPhase('indexing');
    try {
      await initialize(prefs);
    } catch {
      setPhase('index_error');
    }
  }, [initialize]);

  return { phase, seedPhase, onOnboardingDone };
}
