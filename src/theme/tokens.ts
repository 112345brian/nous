// Shared colour roles, resolved per colour scheme. Screens never name a hex: they
// read `colors.<role>` at render time (or build styles lazily with themedStyles),
// so the same code paints both schemes.
//
// Dark is the original look and must not drift. Light is "warm paper": a slightly
// cream ground, soft ink-black text, and an accent darkened until it reads as text.
// Every text role meets WCAG AA (4.5:1) on every surface in both schemes
// (asserted in __tests__/audit.test.ts).
export type Scheme = 'dark' | 'light';

const dark = {
  // surfaces
  bg: '#111111',
  surface: '#1c1c1c',
  elevated: '#252525',
  // lines & fills (decorative / non-text)
  border: '#2e2e2e',
  borderSubtle: '#222222',
  fillMuted: '#3a3a3a', // tracks, handles, inactive pills
  // text roles
  text: '#e4e4e4',
  textSecondary: '#a8a8a8',
  textMuted: '#909090', // the floor for any text
  prose: '#d0d0d0', // article body (a step below `text`, easier on dark)
  proseStrong: '#e4e4e4',
  // accents
  accent: '#5b8ef5',
  accentSoft: '#7ba4ff',
  accentHi: '#87adf8',
  accentWash: '#162040', // tinted surface behind accent content
  danger: '#ff6b6b',
  onAccent: '#ffffff',
  scrim: 'rgba(0,0,0,0.55)',
  ring: '#ffffff', // selection ring on swatches
  onAccentText: '#0a0f1e', // text sitting on an accent-filled button
  overlay: 'rgba(28,28,28,0.92)', // floating chips over content
  overlaySoft: 'rgba(17,17,17,0.82)',
  // notices
  warnWash: '#2a1f00',
  warnText: '#c8a800',
  warnBright: '#ffe566',
  dangerWash: '#3a0000',
  // graph chrome
  graphBand: 'rgba(22,22,30,0.85)',
  graphLine: '#2a2a38',
  graphBreakText: '#333344',
  graphBreakTextSoft: '#38384e',
  graphReadFill: '#1a3528',
  graphReadStroke: '#4aaf70',
  graphProgFill: '#1e2a40',
  graphProgStroke: '#4a7fd4',
  graphIdleFill: '#1e1e26',
  graphIdleStroke: '#3a3a4a',
  graphRail: '#2e2e3e',
} as const;

export type Palette = { [K in keyof typeof dark]: string };

const light: Palette = {
  bg: '#f7f2e8',
  surface: '#fdfaf3',
  elevated: '#efe8d9',
  border: '#d9d0bd',
  borderSubtle: '#e6dfcd',
  fillMuted: '#cfc6b2',
  text: '#231f1a',
  textSecondary: '#4a443b',
  textMuted: '#6a6255',
  prose: '#2b2620',
  proseStrong: '#17130f',
  accent: '#2a58c8',
  accentSoft: '#2a58c8',
  accentHi: '#1f47a8',
  accentWash: '#e3ebfb',
  danger: '#b3261e',
  onAccent: '#ffffff',
  scrim: 'rgba(35,31,26,0.45)',
  ring: '#231f1a',
  onAccentText: '#ffffff',
  overlay: 'rgba(253,250,243,0.94)',
  overlaySoft: 'rgba(247,242,232,0.88)',
  warnWash: '#f6e8c0',
  warnText: '#6b5200',
  warnBright: '#6b5200',
  dangerWash: '#f8dcd8',
  graphBand: 'rgba(237,229,212,0.9)',
  graphLine: '#d9d0bd',
  graphBreakText: '#a89f8a',
  graphBreakTextSoft: '#a89f8a',
  graphReadFill: '#d6efe0',
  graphReadStroke: '#2e7d4f',
  graphProgFill: '#dbe6fb',
  graphProgStroke: '#2a58c8',
  graphIdleFill: '#ece6d6',
  graphIdleStroke: '#9a917c',
  graphRail: '#d9d0bd',
};

export const palettes: Record<Scheme, Palette> = { dark, light };

let current: Scheme = 'dark';
export function setScheme(s: Scheme) { current = s; }
export function getScheme(): Scheme { return current; }

// Reads resolve against the scheme current at the moment of the read, so values
// must be read inside render (or inside a themedStyles factory), never at import.
export const colors: Palette = new Proxy({} as Palette, {
  get: (_t, key: string) => palettes[current][key as keyof Palette],
  ownKeys: () => Object.keys(dark),
  getOwnPropertyDescriptor: (_t, key: string) => (
    key in dark ? { enumerable: true, configurable: true, value: palettes[current][key as keyof Palette] } : undefined
  ),
});

// StyleSheet built lazily per scheme: `styles.x` always returns the style for the
// current scheme, and each scheme's sheet is built once.
export function themedStyles<T extends object>(factory: () => T): T {
  const cache: Partial<Record<Scheme, T>> = {};
  const sheet = (): T => (cache[current] ??= factory());
  return new Proxy({} as T, {
    get: (_t, key) => (sheet() as any)[key],
    ownKeys: () => Reflect.ownKeys(sheet()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Object.getOwnPropertyDescriptor(sheet(), key);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}

// A palette whose keys are screen-local names mapped onto roles, e.g.
// roleMap({ bgSurface: 'surface' }) → C.bgSurface reads colors.surface.
// Raw strings (rgba washes etc.) pass through unchanged.
export function roleMap<M extends Record<string, string>>(map: M): { [K in keyof M]: string } {
  return new Proxy({} as { [K in keyof M]: string }, {
    get: (_t, key: string) => {
      const v = map[key];
      return v in dark ? palettes[current][v as keyof Palette] : v;
    },
  });
}

// Lowest contrast any text may use (dark scheme); kept for tests.
export const TEXT_FLOOR = dark.textMuted;
