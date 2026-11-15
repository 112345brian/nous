import React, { useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, LogBox, StatusBar } from 'react-native';

LogBox.ignoreAllLogs();
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NavigationContainerRef } from '@react-navigation/native';
import { useBoot } from './src/boot/useBoot';
import { ThemeProvider, useScheme, withTheme } from './src/theme/ThemeProvider';
import { withWideFrame } from './src/components/WideFrame';
import { isReduceMotion } from './src/utils/motion';
import { APP_ACCENT } from './src/utils/sepHtml/render/theme';
import { IS_TEST_BUILD } from './src/testConfig';
import MathRenderWebView from './src/components/MathRenderWebView';
import TestRunnerScreen from './src/screens/TestRunnerScreen';
import HomeScreen from './src/screens/HomeScreen';
import ArticleScreen from './src/screens/ArticleScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ReadingListScreen from './src/screens/ReadingListScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import AnnotationsScreen from './src/screens/AnnotationsScreen';
import GraphScreen from './src/screens/GraphScreen';
import LoadingArticleScreen from './src/screens/LoadingArticleScreen';
import { colors, themedStyles, palettes, type Scheme } from './src/theme/tokens';

export type RootStackParamList = {
  Home: { openSearch?: boolean } | undefined;
  Article: { slug: string; title: string; fromSlug?: string };
  History: undefined;
  ReadingList: undefined;
  Settings: undefined;
  Annotations: undefined;
  Graph: { centerSlug?: string; centerTitle?: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Centre the list-style screens in a readable column on wide windows.
const FramedHome = withTheme(withWideFrame(HomeScreen));
const FramedHistory = withTheme(withWideFrame(HistoryScreen));
const FramedReadingList = withTheme(withWideFrame(ReadingListScreen));
const FramedSettings = withTheme(withWideFrame(SettingsScreen));
const FramedAnnotations = withTheme(withWideFrame(AnnotationsScreen));
// The reader re-renders without remounting, so a scheme change keeps its scroll position.
const ThemedArticle = withTheme(ArticleScreen, false);
const ThemedGraph = withTheme(GraphScreen);

// Android 16 forces edge-to-edge: the app draws behind the translucent status
// and navigation bars, so scrolling content bleeds through them. These opaque
// bars sit over the system-bar regions (pointerEvents none, so the OS still
// owns taps/gestures) to give the bars a solid backdrop. Must live inside
// SafeAreaProvider to read the insets.
function SystemBarScrim() {
  const insets = useSafeAreaInsets();
  return (
    <>
      <View pointerEvents="none" style={[barStyles.bar, { top: 0, height: insets.top }]} />
      <View pointerEvents="none" style={[barStyles.bar, { bottom: 0, height: insets.bottom }]} />
    </>
  );
}
const barStyles = themedStyles(() => StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, backgroundColor: colors.bg, zIndex: 50 },
}));

const NAV_FONTS = {
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' as const },
    medium: { fontFamily: 'System', fontWeight: '500' as const },
    bold: { fontFamily: 'System', fontWeight: '700' as const },
    heavy: { fontFamily: 'System', fontWeight: '900' as const },
  },
};

function navTheme(scheme: Scheme) {
  const c = palettes[scheme];
  return {
    dark: scheme === 'dark',
    colors: {
      primary: scheme === 'dark' ? APP_ACCENT : c.accent,
      background: c.bg,
      card: c.bg,
      text: c.text,
      border: c.border,
      notification: scheme === 'dark' ? APP_ACCENT : c.accent,
    },
    ...NAV_FONTS,
  };
}

// Status-bar glyphs must contrast with the scheme's background.
function ThemedStatusBar() {
  const { scheme } = useScheme();
  return <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} backgroundColor={colors.bg} />;
}

export default function App() {
  return (
    <ThemeProvider>
      <ThemedStatusBar />
      {IS_TEST_BUILD ? <TestApp /> : <MainApp />}
    </ThemeProvider>
  );
}

function TestApp() {
  return (
    <SafeAreaProvider>
      <TestRunnerScreen />
    </SafeAreaProvider>
  );
}

function MainApp() {
  const { scheme } = useScheme(); // re-render the shell when the scheme changes
  const navRef = useRef<NavigationContainerRef<RootStackParamList>>(null);
  const openArticle = useCallback((slug: string, title: string) => {
    navRef.current?.navigate('Article', { slug, title });
  }, []);
  const { phase, seedPhase, onOnboardingDone: handleOnboardingDone } = useBoot(openArticle);

  // Always mounted so the math backfill can use it during boot.
  const mathWebView = <MathRenderWebView />;

  if (phase === 'seeding' || phase === 'seed_error') {
    return (
      <>
        {mathWebView}
        <View style={styles.boot}>
          <Text style={styles.bootLogo}>Nous</Text>
          {phase === 'seed_error' ? (
            <Text style={styles.bootError}>Could not download the seed database.{'\n'}Check the URL and relaunch.</Text>
          ) : seedPhase?.phase === 'downloading' ? (
            <>
              <View style={styles.bootProgressTrack}>
                <View style={[styles.bootProgressFill, {
                  width: seedPhase.bytesTotal > 0
                    ? `${Math.round((seedPhase.bytesWritten / seedPhase.bytesTotal) * 100)}%` as any
                    : '0%' as any,
                }]} />
              </View>
              <Text style={styles.bootLabel}>
                {seedPhase.bytesTotal > 0
                  ? `${Math.round(seedPhase.bytesWritten / 1_048_576)} / ${Math.round(seedPhase.bytesTotal / 1_048_576)} MB`
                  : `${Math.round(seedPhase.bytesWritten / 1_048_576)} MB…`}
              </Text>
            </>
          ) : (
            <>
              <ActivityIndicator color={APP_ACCENT} style={{ marginTop: 32 }} />
              <Text style={styles.bootLabel}>
                {seedPhase?.phase === 'validating' ? 'Validating…' : 'Installing…'}
              </Text>
            </>
          )}
        </View>
      </>
    );
  }

  if (phase === 'booting' || phase === 'indexing' || phase === 'index_error') {
    return (
      <>
        {mathWebView}
        <LoadingArticleScreen phase={phase} />
      </>
    );
  }

  if (phase === 'onboarding') {
    return (
      <>
        {mathWebView}
        <SafeAreaProvider>
          <OnboardingScreen onDone={handleOnboardingDone} />
        </SafeAreaProvider>
      </>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer theme={navTheme(scheme)} ref={navRef}>
          <Stack.Navigator
            id="root"
            screenOptions={{
              headerShown: false,
              // Native Android swipe-back is unreliable here (3-button nav, no
              // edge gesture); ArticleScreen implements its own edge-swipe Pan.
              animation: isReduceMotion() ? 'fade' : 'slide_from_right',
            }}
          >
            <Stack.Screen name="Home" component={FramedHome} />
            <Stack.Screen name="Article" component={ThemedArticle} />
            <Stack.Screen name="History" component={FramedHistory} />
            <Stack.Screen name="ReadingList" component={FramedReadingList} />
            <Stack.Screen name="Settings" component={FramedSettings} />
            <Stack.Screen name="Annotations" component={FramedAnnotations} />
            <Stack.Screen name="Graph" component={ThemedGraph} />
          </Stack.Navigator>
        </NavigationContainer>
        {/* Opaque backdrop behind the translucent system bars (edge-to-edge) */}
        <SystemBarScrim />
        {mathWebView}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bootLogo: {
    color: APP_ACCENT,
    fontSize: 22,
    fontWeight: '400',
    letterSpacing: 6,
  },
  bootError: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 22,
  },
  bootLabel: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 12,
  },
  bootProgressTrack: {
    width: 200,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginTop: 32,
  },
  bootProgressFill: {
    height: '100%',
    borderRadius: 1,
    backgroundColor: APP_ACCENT,
  },
}));

