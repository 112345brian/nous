import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Modal, FlatList, Pressable, Alert, ActivityIndicator,
} from 'react-native';
import type { Annotation } from '../types';
import { reanchorOrphans, deleteOrphans } from '../composition';
import { colors, themedStyles } from '../theme/tokens';

interface Props {
  annotations: Annotation[];          // orphaned annotations
  currentContent: string;             // new article HTML
  currentHash: string;                // hash of new content
  onResolved: (ids: number[]) => void; // IDs that were re-anchored or deleted
  onDismiss: () => void;
}

export default function OrphanedAnnotationsBanner({
  annotations, currentContent, currentHash, onResolved, onDismiss,
}: Props) {
  const [showSheet, setShowSheet] = useState(false);
  const [reanchoring, setReanchoring] = useState(false);
  const [localAnns, setLocalAnns] = useState(annotations);
  const count = localAnns.length;

  const handleReanchorAll = async () => {
    setReanchoring(true);
    // Finds each highlight in the new text and saves the ones that are found.
    const { succeededIds: successIds, failed, message } = await reanchorOrphans(localAnns, currentContent, currentHash);
    onResolved(successIds);
    setLocalAnns(prev => prev.filter(a => !successIds.includes(a.id)));

    Alert.alert('Re-anchor complete', message);
    setReanchoring(false);
    if (failed === 0) setShowSheet(false);
  };

  const handleDeleteAll = () => {
    Alert.alert(
      `Delete ${count} orphaned highlight${count > 1 ? 's' : ''}?`,
      'These no longer match the current article text.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All', style: 'destructive',
          onPress: async () => {
            const ids = localAnns.map(a => a.id);
            await deleteOrphans(ids);
            onResolved(ids);
            setLocalAnns([]);
            setShowSheet(false);
          },
        },
      ]
    );
  };

  const handleDeleteOne = async (id: number) => {
    await deleteOrphans([id]);
    onResolved([id]);
    setLocalAnns(prev => prev.filter(a => a.id !== id));
    if (localAnns.length === 1) setShowSheet(false);
  };

  if (count === 0) return null;

  return (
    <>
      <TouchableOpacity accessibilityRole="button" style={styles.banner} onPress={() => setShowSheet(true)} activeOpacity={0.8}>
        <Text style={styles.bannerIcon}>⚠</Text>
        <Text style={styles.bannerText}>
          {count} highlight{count > 1 ? 's' : ''} from a previous version
        </Text>
        <Text style={styles.bannerReview}>Review</Text>
      </TouchableOpacity>

      <Modal
        visible={showSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowSheet(false)}
      >
        <Pressable accessibilityRole="button" style={styles.backdrop} onPress={() => setShowSheet(false)} />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Previous version highlights</Text>
            <Text style={styles.sheetSub}>
              These no longer match the current article text. You can try to re-anchor them automatically, or delete them.
            </Text>
          </View>

          <FlatList
            data={localAnns}
            keyExtractor={i => String(i.id)}
            style={styles.list}
            renderItem={({ item }) => (
              <View style={[styles.annRow, { borderLeftColor: item.color }]}>
                <View style={styles.annContent}>
                  <Text style={styles.annText} numberOfLines={3}>"{item.selected_text}"</Text>
                  {item.note && <Text style={styles.annNote}>{item.note}</Text>}
                </View>
                <TouchableOpacity accessibilityRole="button"
                  style={styles.deleteOne}
                  onPress={() => handleDeleteOne(item.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.deleteOneText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.allResolved}>All highlights resolved.</Text>
            }
          />

          <View style={styles.sheetActions}>
            <TouchableOpacity accessibilityRole="button" style={styles.dismissBtn} onPress={() => { setShowSheet(false); onDismiss(); }}>
              <Text style={styles.dismissBtnText}>Keep for now</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" style={styles.reanchorBtn} onPress={handleReanchorAll} disabled={reanchoring}>
              {reanchoring
                ? <ActivityIndicator color={colors.accentSoft} size="small" />
                : <Text style={styles.reanchorBtnText}>Re-anchor ✦</Text>}
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" style={styles.deleteAllBtn} onPress={handleDeleteAll}>
              <Text style={styles.deleteAllBtnText}>Delete all</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  banner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.warnWash,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#FFE56633',
    paddingHorizontal: 14, paddingVertical: 9, gap: 8,
  },
  bannerIcon: { fontSize: 13, color: colors.warnBright },
  bannerText: { flex: 1, color: colors.warnText, fontSize: 13 },
  bannerReview: { color: colors.warnBright, fontSize: 13, fontWeight: '600' },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
    maxHeight: '72%',
  },
  sheetHeader: {
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: 6 },
  sheetSub: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },

  list: { maxHeight: 280 },
  annRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 20, paddingVertical: 12,
    borderLeftWidth: 3, marginLeft: 16, marginTop: 10, gap: 10,
  },
  annContent: { flex: 1 },
  annText: { color: colors.textMuted, fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  annNote: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  deleteOne: { paddingLeft: 8 },
  deleteOneText: { color: colors.textMuted, fontSize: 15 },
  allResolved: { color: colors.textMuted, fontSize: 14, textAlign: 'center', padding: 32 },

  sheetActions: {
    flexDirection: 'row', gap: 8, padding: 16, paddingBottom: 32,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  dismissBtn: {
    paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: colors.fillMuted, alignItems: 'center',
  },
  dismissBtnText: { color: colors.textMuted, fontSize: 14 },
  reanchorBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    backgroundColor: colors.accentWash, alignItems: 'center', justifyContent: 'center',
  },
  reanchorBtnText: { color: colors.accentSoft, fontSize: 14, fontWeight: '600' },
  deleteAllBtn: {
    paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: colors.dangerWash, alignItems: 'center',
  },
  deleteAllBtnText: { color: colors.danger, fontSize: 14 },
}));
