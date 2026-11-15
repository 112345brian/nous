import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors, themedStyles } from '../theme/tokens';

// List-style screens (Home, History, Settings…) are designed for a phone column.
// On wide windows (tablet, landscape, macOS) a full-width list stretches rows
// across the screen, so centre them in a readable column instead.
export const WIDE_COLUMN_MAX = 720;

export function withWideFrame<P extends object>(Screen: React.ComponentType<P>): React.ComponentType<P> {
  function Framed(props: P) {
    return (
      <View style={styles.outer}>
        <View style={styles.column}>
          <Screen {...props} />
        </View>
      </View>
    );
  }
  Framed.displayName = `WideFrame(${Screen.displayName ?? Screen.name ?? 'Screen'})`;
  return Framed;
}

const styles = themedStyles(() => StyleSheet.create({
  outer: { flex: 1, backgroundColor: colors.bg },
  column: { flex: 1, width: '100%', maxWidth: WIDE_COLUMN_MAX, alignSelf: 'center' },
}));
