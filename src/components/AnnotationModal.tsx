import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Pressable,
} from 'react-native';
import type { Annotation } from '../types';
import { colors, themedStyles } from '../theme/tokens';

export const ANN_COLORS = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6'];

interface Props {
  annotation: Partial<Annotation> | null;
  onSave: (note: string | null, color: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export default function AnnotationModal({ annotation, onSave, onDelete, onClose }: Props) {
  const [note, setNote] = useState('');
  const [color, setColor] = useState(ANN_COLORS[0]);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (annotation) {
      setNote(annotation.note ?? '');
      setColor(annotation.color ?? ANN_COLORS[0]);
    }
  }, [annotation]);

  if (!annotation) return null;

  const isNew = !annotation.id;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable accessibilityRole="button" style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' || Platform.OS === 'macos' ? 'padding' : undefined}
        style={styles.kav}
        pointerEvents="box-none"
      >
        <View style={styles.sheet}>
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>

          {/* Color picker */}
          <View style={styles.colorRow}>
            {ANN_COLORS.map(c => (
              <TouchableOpacity accessibilityRole="button"
                key={c}
                style={[styles.colorDot, { backgroundColor: c }, color === c && styles.colorDotSelected]}
                onPress={() => setColor(c)}
              />
            ))}
          </View>

          {/* Section label */}
          <Text style={styles.label}>NOTE ON HIGHLIGHT</Text>

          {/* Quote */}
          {annotation.selected_text ? (
            <View style={[styles.quoteBox, { borderLeftColor: color }]}>
              <Text style={styles.quoteText} numberOfLines={4}>
                "{annotation.selected_text}"
              </Text>
            </View>
          ) : null}

          {/* Note input */}
          <TextInput
            ref={inputRef}
            style={styles.noteInput}
            placeholder="Add a note…"
            placeholderTextColor={colors.textMuted}
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={2000}
            textAlignVertical="top"
          />

          {/* Actions */}
          <View style={styles.actions}>
            {!isNew && onDelete && (
              <TouchableOpacity accessibilityRole="button" style={styles.deleteBtn} onPress={onDelete}>
                <Text style={styles.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            )}
            <View style={styles.actionsRight}>
              <TouchableOpacity accessibilityRole="button" style={styles.cancelBtn} onPress={onClose}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button"
                style={[styles.saveBtn, { backgroundColor: color }]}
                onPress={() => onSave(note.trim() || null, color)}
              >
                <Text style={styles.saveBtnText}>{isNew ? 'Highlight' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  kav: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingHorizontal: 16,
    paddingBottom: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 12,
  },
  handleRow: { alignItems: 'center', paddingTop: 10 },
  handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: colors.fillMuted },
  colorRow: {
    flexDirection: 'row',
    gap: 14,
    paddingTop: 4,
  },
  colorDot: {
    width: 26, height: 26, borderRadius: 13,
    borderWidth: 2, borderColor: 'transparent',
  },
  colorDotSelected: {
    borderColor: colors.ring,
    transform: [{ scale: 1.15 }],
  },
  label: {
    fontSize: 11, fontWeight: '600',
    letterSpacing: 0.06 * 11,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  quoteBox: {
    backgroundColor: colors.elevated,
    borderLeftWidth: 2,
    borderRadius: 0,
    borderTopRightRadius: 5,
    borderBottomRightRadius: 5,
    padding: 10,
  },
  quoteText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    fontStyle: 'italic',
    fontFamily: Platform.OS === 'android' ? 'serif' : 'Georgia',
  },
  noteInput: {
    backgroundColor: colors.elevated,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    color: colors.text,
    fontSize: 14,
    minHeight: 70,
    maxHeight: 150,
    caretColor: colors.accent,
  } as any,
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionsRight: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
  },
  deleteBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  deleteBtnText: { color: '#f472b6', fontSize: 14 },
  cancelBtn: {
    paddingVertical: 8, paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: colors.elevated,
  },
  cancelBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: '500' },
  saveBtn: {
    paddingVertical: 8, paddingHorizontal: 20,
    borderRadius: 8,
  },
  saveBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
}));
