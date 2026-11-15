// Native reader type scale. Every size, leading and gap derives from one base
// font size (the reader's "Font size" setting), so changing it rescales the whole
// article. Components read the theme via useSepTheme(); the default base is 17.
import React from 'react';
import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import { colors, roleMap, getScheme } from '../../../theme/tokens';

export const APP_ACCENT = '#7ba4ff';

// Resolves per colour scheme at read time (see theme/tokens).
export const SEP_COLORS = roleMap({
  bg: 'bg',
  bgRaised: 'surface',
  border: 'border',
  borderMid: 'fillMuted',
  text: 'prose',
  textBright: 'proseStrong',
  textMuted: 'textMuted',
  accent: 'accent',
  accentHi: 'accentHi',
});

export const SEP_SIDE_PAD = 20;

export const DEFAULT_READER_FONT = 17;
const MIN_READER_FONT = 12;
const MAX_READER_FONT = 32;

// Android ships no Georgia: the generic 'serif' resolves to the system serif
// (Noto Serif). Apple platforms have Georgia.
const SERIF = Platform.select({ android: 'serif', default: 'Georgia' }) as string;

// The stored `font_size` meta is a string that may be missing, non-numeric, or
// out of range (hand-edited backup, old build). Anything unusable → default.
export function parseReaderFontSize(raw: string | null | undefined): number {
  const n = raw == null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_READER_FONT || n > MAX_READER_FONT) return DEFAULT_READER_FONT;
  return n;
}

export function makeSepTheme(base: number) {
  const k = base / DEFAULT_READER_FONT; // spacing authored at 17px; scale with the text
  const sp = (n: number) => Math.round(n * k);
  const lineHeight = base * 1.8;
  const paraGap = Math.round(base * 1.6);

  const text = {
    body: { fontSize: base, lineHeight, color: SEP_COLORS.text } as TextStyle,
    h1: {
      fontFamily: SERIF,
      fontSize: Math.round(base * 1.85),
      fontWeight: '700',
      letterSpacing: -0.6,
      color: SEP_COLORS.textBright,
      lineHeight: Math.round(base * 1.85 * 1.3),
    } as TextStyle,
    h2: {
      fontFamily: SERIF,
      fontSize: Math.round(base * 1.3),
      fontWeight: '600',
      color: SEP_COLORS.textBright,
      lineHeight: Math.round(base * 1.3 * 1.3),
    } as TextStyle,
    // Sub-headings stay at or above body size; weight, colour and the serif
    // carry the step, so a heading never reads smaller than the text it heads.
    h3: {
      fontFamily: SERIF,
      fontSize: Math.round(base * 1.12),
      fontWeight: '600',
      color: SEP_COLORS.textBright,
      lineHeight: Math.round(base * 1.12 * 1.3),
    } as TextStyle,
    h4: {
      fontSize: base,
      fontWeight: '600',
      color: SEP_COLORS.textBright,
      lineHeight: Math.round(base * 1.3),
    } as TextStyle,
  };

  return {
    base,
    // Reading column: ~38em of text ≈ 65–75 characters in the body face.
    measure: Math.round(base * 38),
    // MathJax sizes SVGs in ex against em:16; 1ex ≈ base/2 px at this size.
    pxPerEx: base / 2,
    text,
    // Blockquote / preamble: slightly smaller, muted.
    muted: { fontSize: Math.round(base * 0.97), color: SEP_COLORS.textMuted } as TextStyle,
    // Inline run sizes (footnote marker, code chip, sup/sub, <small>).
    inline: {
      footnote: base * 0.85,
      code: base * 0.9,
      script: base * 0.75,
      small: base * 0.85,
      mathFallback: base * 0.95,
    },
    header: {
      wrap: { marginBottom: 0 } as ViewStyle,
      breadcrumb: {
        alignSelf: 'flex-start',
        fontFamily: 'System',
        fontSize: 12,
        fontWeight: '500',
        letterSpacing: 0.5,
        color: SEP_COLORS.accent,
        backgroundColor: 'rgba(91, 142, 245, 0.13)',
        borderWidth: 1,
        borderColor: 'rgba(91, 142, 245, 0.30)',
        borderRadius: 5,
        paddingVertical: 2,
        paddingHorizontal: 9,
        overflow: 'hidden',
        marginBottom: 10,
      } as TextStyle,
      title: {
        fontFamily: SERIF,
        fontSize: Math.round(base * 1.85),
        fontWeight: '700',
        letterSpacing: -0.6,
        color: SEP_COLORS.textBright,
        lineHeight: Math.round(base * 1.85 * 1.2),
        marginBottom: 10,
      } as TextStyle,
      preamble: { paddingBottom: 8 } as ViewStyle,
      preambleText: {
        fontSize: Math.round(base * 0.9),
        lineHeight: Math.round(base * 0.9 * 1.55),
        color: SEP_COLORS.textMuted,
      } as TextStyle,
    },
    block: {
      h2Margin: { marginTop: sp(40), marginBottom: sp(13), paddingTop: sp(30), borderTopWidth: 1, borderTopColor: colors.borderSubtle } as ViewStyle,
      h3Margin: { marginTop: sp(26), marginBottom: sp(10) } as ViewStyle,
      h4Margin: { marginTop: sp(17), marginBottom: sp(8) } as ViewStyle,
      paraGap: { marginBottom: paraGap } as ViewStyle,
      blockquote: {
        marginVertical: sp(30),
        paddingVertical: sp(17),
        paddingLeft: 24,
        paddingRight: 19,
        borderLeftWidth: 3,
        borderLeftColor: SEP_COLORS.borderMid,
        backgroundColor: SEP_COLORS.bgRaised,
        borderTopRightRadius: 6,
        borderBottomRightRadius: 6,
      } as ViewStyle,
      listIndent: sp(28),
      liGap: sp(6),
      bibItem: { marginBottom: sp(12) } as ViewStyle,
      bibText: {
        fontSize: Math.round(base * 0.94),
        lineHeight: Math.round(base * 0.94 * 1.6),
        color: SEP_COLORS.textMuted,
      } as TextStyle,
    },
  };
}

export type SepTheme = ReturnType<typeof makeSepTheme>;

// One theme object per size, so context consumers keep a stable reference.
const themeCache = new Map<number, SepTheme>();
export function getSepTheme(base: number): SepTheme {
  const key = getScheme() === 'light' ? -base : base; // colours are baked in, so cache per scheme
  let t = themeCache.get(key);
  if (!t) { t = makeSepTheme(base); themeCache.set(key, t); }
  return t;
}

const SepThemeContext = React.createContext<SepTheme>(getSepTheme(DEFAULT_READER_FONT));

export function useSepTheme(): SepTheme {
  return React.useContext(SepThemeContext);
}

export function SepThemeProvider({ base, children }: { base: number; children: React.ReactNode }) {
  return React.createElement(SepThemeContext.Provider, { value: getSepTheme(base) }, children);
}
