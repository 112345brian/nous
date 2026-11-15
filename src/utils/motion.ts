import { AccessibilityInfo, Animated } from 'react-native';

// Honors the OS "Reduce Motion" / "Remove animations" setting. Read once at
// import and kept current by the change event, so animation helpers can check it
// synchronously from gesture callbacks.
let reduceMotion = false;
try {
  AccessibilityInfo.isReduceMotionEnabled?.().then(v => { reduceMotion = !!v; }).catch(() => {});
  AccessibilityInfo.addEventListener?.('reduceMotionChanged', v => { reduceMotion = !!v; });
} catch {
  // Non-RN test environments: motion stays enabled.
}

export function isReduceMotion(): boolean {
  return reduceMotion;
}

export const SHEET_SPRING = { damping: 28, stiffness: 320, mass: 0.9, useNativeDriver: true } as const;

// Slide a sheet to `toValue`. With Reduce Motion on, jump straight there (the
// sheet's scrim still fades with the value, so the change is visible, not animated).
export function springTo(
  value: Animated.Value,
  toValue: number,
  onEnd?: (r: { finished: boolean }) => void,
) {
  if (reduceMotion) {
    value.stopAnimation();
    value.setValue(toValue);
    onEnd?.({ finished: true });
    return;
  }
  Animated.spring(value, { ...SHEET_SPRING, toValue }).start(onEnd);
}
