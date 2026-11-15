import React, { useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { springTo } from '../utils/motion';
import { InlineContent } from '../utils/sepHtml/render/Inline';
import type { Inline } from '../utils/sepHtml/types';
import { colors, themedStyles, roleMap } from '../theme/tokens';

// Shares the table-of-contents sheet's visual language: a rounded bottom sheet
// that slides up over a fading scrim, with a drag handle and a header. The note
// renders inline (no active links — it's content to read, not navigate).
const C = roleMap({
  bgSurface: 'surface',
  border: 'border',
  borderSubtle: 'borderSubtle',
  textSec: 'textMuted',
});

// Slide distance — larger than the sheet ever gets (maxHeight 60%), so the
// closed position is fully off-screen on any phone.
const SHEET_TRAVEL = 700;

interface Props {
  inlines: Inline[];
  onClose: () => void;
}

export default function FootnoteSheet({ inlines, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(SHEET_TRAVEL)).current;

  useEffect(() => {
    springTo(slide, 0);
  }, [slide]);

  const close = () => {
    springTo(slide, SHEET_TRAVEL, ({ finished }) => { if (finished) onClose(); });
  };

  const backdropOpacity = slide.interpolate({
    inputRange: [0, SHEET_TRAVEL],
    outputRange: [0.55, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="auto">
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" style={StyleSheet.absoluteFillObject} onPress={close} />
      </Animated.View>

      <Animated.View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: insets.bottom + 8, transform: [{ translateY: slide }] }]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.headerText}>Note</Text>
        </View>
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          <InlineContent inlines={inlines} handlers={{}} baseStyle={styles.noteText} />
          <View style={{ height: 16 }} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  sheet: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    maxHeight: '60%',
    backgroundColor: C.bgSurface,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    overflow: 'hidden',
  },
  handle: {
    width: 36, height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: C.borderSubtle,
    paddingVertical: 12,
    alignItems: 'center',
  },
  headerText: { fontSize: 13, fontWeight: '600', color: C.textSec, letterSpacing: 0.3 },
  list: { flexGrow: 0 },
  listContent: { paddingHorizontal: 18, paddingTop: 14 },
  noteText: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
}));
