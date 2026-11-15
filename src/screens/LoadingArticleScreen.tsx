import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { APP_ACCENT } from '../utils/sepHtml/render/theme';
import { colors, themedStyles } from '../theme/tokens';

interface Props {
  phase: 'booting' | 'indexing' | 'index_error';
}

export default function LoadingArticleScreen({ phase }: Props) {
  return (
    <View style={s.root}>
      <Text style={s.logo}>Nous</Text>
      {phase === 'index_error' ? (
        <Text style={s.error}>
          Could not reach plato.stanford.edu.{'\n'}Check your connection and relaunch.
        </Text>
      ) : (
        <ActivityIndicator color={APP_ACCENT} />
      )}
    </View>
  );
}

const s = themedStyles(() => themedStyles(() => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 32,
  },
  logo: {
    color: APP_ACCENT,
    fontSize: 22,
    fontWeight: '400',
    letterSpacing: 6,
  },
  error: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
})));
