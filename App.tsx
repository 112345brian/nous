import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, LogBox, StatusBar } from 'react-native';

LogBox.ignoreAllLogs();
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NavigationContainerRef } from '@react-navigation/native';
import { getEntryCount, getMeta, getPrefs, getRecentSlugs, savePrefs } from './src/services/db';
import { ThemeProvider, useScheme, withTheme } from './src/theme/ThemeProvider';
import { withWideFrame } from './src/components/WideFrame';
import { isReduceMotion } from './src/utils/motion';
import { APP_ACCENT } from './src/utils/sepHtml/render/theme';
import { syncOnLaunch } from './src/services/dataSync';
import { importSeedFromUrl } from './src/services/seedImport';
import type { SeedPhase } from './src/services/seedImport';
import { backfillAst, backfillMathHashFormat, backfillMathInline, downloadAll, refreshIndexIfStale, syncCachedArticles } from './src/services/catalog';
import { preloadMathJax } from './src/services/mathRender';
import { idleScheduler } from './src/services/idleScheduler';
import type { Prefs } from './src/services/db';
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
import { startDownloadNotification, updateDownloadNotification, finishDownloadNotification } from './src/services/downloadNotification';
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

type AppPhase = 'booting' | 'onboarding' | 'seeding' | 'seed_error' | 'indexing' | 'index_error' | 'ready';

export default function App() {
  return (
    <ThemeProvider>
      <ThemedStatusBar />
      <AppInner />
    </ThemeProvider>
  );
}

function AppInner() {
  const { scheme } = useScheme(); // re-render the shell when the scheme changes
  if (IS_TEST_BUILD) {
    return (
      <SafeAreaProvider>
        <TestRunnerScreen />
      </SafeAreaProvider>
    );
  }

  const [phase, setPhase] = useState<AppPhase>('booting');
  const [seedPhase, setSeedPhase] = useState<SeedPhase | null>(null);
  const navRef = useRef<NavigationContainerRef<RootStackParamList>>(null);

  useEffect(() => {
    boot().catch(() => setPhase('index_error'));
  }, []);

  async function boot() {
    const onboardingDone = await getMeta('onboarding_done');
    if (!onboardingDone) {
      setPhase('onboarding');
      return;
    }
    await initialize(await getPrefs());
  }

  async function initialize(prefs: Prefs) {
    syncOnLaunch();

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
              navRef.current?.navigate('Article', {
                slug: recent[0].slug,
                title: recent[0].title,
              });
            }, 100);
          }
        }).catch(() => {});
      }

      // Preload MathJax eagerly only if the math backfill hasn't completed yet
      // (meaning there are cached articles whose TeX still needs SVG rendering)
      // or if a bulk download is about to bring in new articles that will need it.
      // Otherwise let it load lazily on first use — no point paying boot cost.
      const mathDone = await getMeta('math_inline_v2');
      if (!mathDone || prefs.downloadAll) preloadMathJax();

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
      idleScheduler.schedule('backfill-math-inline', backfillMathInline);
      idleScheduler.schedule('backfill-math-hash-format', backfillMathHashFormat);
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
    })().catch(() => {});
  }

  async function handleOnboardingDone(prefs: Prefs) {
    if (prefs.seedUrl) {
      setPhase('seeding');
      try {
        await importSeedFromUrl(prefs.seedUrl, p => setSeedPhase(p));
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
  }

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

