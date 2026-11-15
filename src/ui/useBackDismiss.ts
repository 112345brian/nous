import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

// While `active`, the Android system Back button/gesture calls `onBack` (to close
// a sheet, menu or card) instead of leaving the screen. Overlays register when
// they open, so the most recently opened one is dismissed first.
export function useBackDismiss(active: boolean, onBack: () => void) {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      latest.current();
      return true;
    });
    return () => sub.remove();
  }, [active]);
}
