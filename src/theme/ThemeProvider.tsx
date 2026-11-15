import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import type { KeyValueStore } from '../core/ports';
import { setScheme, type Scheme } from './tokens';

export type Appearance = 'system' | 'light' | 'dark';

export function parseAppearance(raw: string | null | undefined): Appearance {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function resolveScheme(pref: Appearance, system: string | null | undefined): Scheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return system === 'light' ? 'light' : 'dark'; // unknown/unspecified → the original dark look
}

interface Ctx { scheme: Scheme; appearance: Appearance; setAppearance: (a: Appearance) => void }
const ThemeCtx = createContext<Ctx>({ scheme: 'dark', appearance: 'system', setAppearance: () => {} });

export function useScheme(): Ctx {
  return useContext(ThemeCtx);
}

/** `store` holds the saved choice (the `meta` table in the app); the root provides it. */
export function ThemeProvider({ children, store }: { children: React.ReactNode; store: KeyValueStore }) {
  const system = useColorScheme();
  const [appearance, setAppearanceState] = useState<Appearance>('system');
  const scheme = resolveScheme(appearance, system);
  // Set before children render so every `colors.x` read in this pass is correct.
  setScheme(scheme);

  useEffect(() => {
    // The DB opens during boot; until the stored choice loads we follow the system.
    let cancelled = false;
    const load = (n: number) => store.getMeta('appearance')
      .then(v => { if (!cancelled) setAppearanceState(parseAppearance(v)); })
      .catch(() => { if (!cancelled && n < 5) setTimeout(() => load(n + 1), 1000); });
    load(0);
    return () => { cancelled = true; };
  }, [store]);

  const setAppearance = useCallback((a: Appearance) => {
    setAppearanceState(a);
    store.setMeta('appearance', a).catch(() => {});
  }, [store]);

  const value = useMemo(() => ({ scheme, appearance, setAppearance }), [scheme, appearance, setAppearance]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

// Re-renders a screen when the scheme changes. `remount` rebuilds its subtree
// (right for list screens with memoised rows); the reader passes false so its
// scroll position survives.
export function withTheme<P extends object>(Screen: React.ComponentType<P>, remount = true): React.ComponentType<P> {
  function Themed(props: P) {
    const { scheme } = useScheme();
    return remount ? <Screen key={scheme} {...props} /> : <Screen {...props} />;
  }
  Themed.displayName = `Themed(${Screen.displayName ?? Screen.name ?? 'Screen'})`;
  return Themed;
}
