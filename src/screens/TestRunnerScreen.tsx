import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runTests, getTestList } from '../tests/runTests';
import type { TestResult, TestReport } from '../tests/runTests';
import { colors, themedStyles } from '../theme/tokens';

type Phase = 'idle' | 'running' | 'done';

export default function TestRunnerScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [results, setResults] = useState<TestResult[]>(getTestList());
  const [report, setReport] = useState<TestReport | null>(null);

  useEffect(() => {
    // Auto-start after 1s so the UI is visible first
    const t = setTimeout(start, 1000);
    return () => clearTimeout(t);
  }, []);

  async function start() {
    setPhase('running');
    setResults(getTestList());
    const r = await runTests(updated => {
      setResults(updated);
      scrollRef.current?.scrollToEnd({ animated: true });
    });
    setReport(r);
    setPhase('done');
  }

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const done = results.filter(r => r.status === 'pass' || r.status === 'fail').length;
  const total = results.length;
  const progress = total > 0 ? done / total : 0;

  const groups = [...new Set(results.map(r => r.group))];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Nous · Test Build</Text>
        <Text style={styles.subtitle}>
          {phase === 'idle' && 'Starting…'}
          {phase === 'running' && `Running ${done} / ${total}`}
          {phase === 'done' && `${passed} passed · ${failed} failed · ${report?.summary.durationMs}ms`}
        </Text>
      </View>

      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${progress * 100}%` },
            failed > 0 && styles.progressFail,
            phase === 'done' && failed === 0 && styles.progressPass,
          ]}
        />
      </View>

      {/* Results list */}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
      >
        {groups.map(group => {
          const groupResults = results.filter(r => r.group === group);
          return (
            <View key={group} style={styles.group}>
              <Text style={styles.groupLabel}>{group}</Text>
              {groupResults.map(r => (
                <View key={r.name} style={styles.row}>
                  <View style={styles.rowLeft}>
                    {r.status === 'pending' && <View style={[styles.dot, styles.dotPending]} />}
                    {r.status === 'running' && <ActivityIndicator size="small" color={colors.accentSoft} style={styles.spinner} />}
                    {r.status === 'pass'    && <Text style={styles.iconPass}>✓</Text>}
                    {r.status === 'fail'    && <Text style={styles.iconFail}>✗</Text>}
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={[
                      styles.testName,
                      r.status === 'fail' && styles.testNameFail,
                      r.status === 'pass' && styles.testNamePass,
                    ]}>
                      {r.name}
                    </Text>
                    {r.status === 'fail' && r.error && (
                      <Text style={styles.errorMsg}>{r.error}</Text>
                    )}
                    {r.status === 'pass' && (
                      <Text style={styles.duration}>{r.durationMs}ms</Text>
                    )}
                  </View>
                </View>
              ))}
            </View>
          );
        })}

        {/* DB snapshot */}
        {phase === 'done' && report && (
          <View style={styles.snapshot}>
            <Text style={styles.snapshotTitle}>DB Snapshot</Text>
            <Row label="Platform"         value={report.platform} />
            <Row label="Index entries"    value={String(report.db_snapshot.entry_count)} />
            <Row label="Annotations"      value={String(report.db_snapshot.annotation_count)} />
            <Row label="Recent reads"     value={report.db_snapshot.recent_reads.map(r => r.title).join(', ') || 'none'} />
            <Row label="Report written"   value="nous_test_report.json" />
            <Row label="Pull with"        value="adb pull /data/user/0/com.nous.app/files/nous_test_report.json" mono />
          </View>
        )}
      </ScrollView>

      {/* Re-run button */}
      {phase === 'done' && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
          <TouchableOpacity accessibilityRole="button" style={styles.rerunBtn} onPress={start}>
            <Text style={styles.rerunLabel}>Run Again</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.snapshotRow}>
      <Text style={styles.snapshotLabel}>{label}</Text>
      <Text style={[styles.snapshotValue, mono && styles.snapshotMono]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  title: { color: colors.accentSoft, fontSize: 18, fontWeight: '500', letterSpacing: 2 },
  subtitle: { color: colors.textMuted, fontSize: 13, marginTop: 4 },

  progressTrack: { height: 2, backgroundColor: colors.surface, marginHorizontal: 0 },
  progressFill: { height: '100%', backgroundColor: colors.accentWash, borderRadius: 1 },
  progressPass: { backgroundColor: '#34d399' },
  progressFail: { backgroundColor: colors.danger },

  scroll: { flex: 1 },

  group: { marginTop: 24, marginHorizontal: 16 },
  groupLabel: {
    color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    textTransform: 'uppercase', marginBottom: 8,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    gap: 10,
  },
  rowLeft: { width: 22, alignItems: 'center', paddingTop: 1 },
  rowBody: { flex: 1 },

  dot: { width: 8, height: 8, borderRadius: 4 },
  dotPending: { backgroundColor: colors.elevated },
  spinner: { transform: [{ scale: 0.7 }] },

  iconPass: { color: '#34d399', fontSize: 14, fontWeight: '700' },
  iconFail: { color: colors.danger, fontSize: 14, fontWeight: '700' },

  testName: { color: colors.textMuted, fontSize: 14 },
  testNamePass: { color: colors.textSecondary },
  testNameFail: { color: colors.danger },
  errorMsg: {
    color: colors.danger, fontSize: 11, marginTop: 3, lineHeight: 16,
    fontFamily: 'monospace',
  },
  duration: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  snapshot: {
    margin: 16, marginTop: 32,
    backgroundColor: colors.bg, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    padding: 14,
  },
  snapshotTitle: {
    color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    textTransform: 'uppercase', marginBottom: 10,
  },
  snapshotRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle,
    gap: 12,
  },
  snapshotLabel: { color: colors.textMuted, fontSize: 12, flex: 0.4 },
  snapshotValue: { color: colors.textMuted, fontSize: 11, flex: 0.6, textAlign: 'right' },
  snapshotMono: { fontFamily: 'monospace', fontSize: 11, color: colors.textMuted },

  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle,
    padding: 16,
  },
  rerunBtn: {
    backgroundColor: colors.accentWash, borderRadius: 10, paddingVertical: 12,
    alignItems: 'center',
  },
  rerunLabel: { color: colors.accentSoft, fontSize: 15, fontWeight: '600' },
}));
