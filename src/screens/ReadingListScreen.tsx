import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, Alert, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { bookmarkStore, exportToZotero, prepareZoteroSend } from '../composition';
import { formatCitation } from '../utils/citation';
import { zoteroSavedMessage } from '../utils/zoteroMessage';
import type { BookmarkRow } from '../types';
import type { RootStackParamList } from '../../App';
import { colors, themedStyles } from '../theme/tokens';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function ReadingListScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<Nav>();
  const [items, setItems] = useState<BookmarkRow[]>([]);

  useFocusEffect(useCallback(() => {
    bookmarkStore.getBookmarksFull().then(setItems);
  }, []));

  const open = (slug: string, title: string) =>
    nav.navigate('Article', { slug, title });

  const remove = (slug: string, title: string) => {
    Alert.alert('Remove', `Remove "${title}" from your reading list?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          await bookmarkStore.toggleBookmark(slug, title);
          setItems(prev => prev.filter(i => i.slug !== slug));
        },
      },
    ]);
  };

  const shareCitation = async (item: BookmarkRow) => {
    const citation = formatCitation(item);
    await Share.share({ message: citation, title: item.title });
  };

  const sendToZotero = async (item: BookmarkRow) => {
    const prep = await prepareZoteroSend(item.slug);
    if (prep.status === 'not_configured') {
      Alert.alert(
        'Zotero not configured',
        'Add your Zotero API key and user ID in Settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => nav.navigate('Settings') },
        ]
      );
      return;
    }
    const { apiKey, userId, annotations } = prep;
    const result = await exportToZotero(apiKey, userId, item, annotations);
    if (result === 'ok') {
      Alert.alert('Saved to Zotero', zoteroSavedMessage(item.title, annotations));
    } else if (result === 'auth_error') {
      Alert.alert('Auth error', 'Check your Zotero API key in Settings.');
    } else {
      Alert.alert('Error', 'Could not reach Zotero. Check your connection.');
    }
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity accessibilityRole="button"
          style={styles.back}
          onPress={() => nav.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.backChevron}>‹</Text>
          <Text style={styles.backLabel}>Library</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reading List</Text>
        <View style={styles.back} />
      </View>

      <FlatList
        data={items}
        keyExtractor={i => i.slug}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              Star any article to add it here.{'\n'}
              Citations generate automatically.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <ReadingListItem
            item={item}
            onOpen={() => open(item.slug, item.title)}
            onRemove={() => remove(item.slug, item.title)}
            onCopyCitation={() => shareCitation(item)}
            onZotero={() => sendToZotero(item)}
          />
        )}
      />
    </View>
  );
}

function ReadingListItem({
  item,
  onOpen,
  onRemove,
  onCopyCitation,
  onZotero,
}: {
  item: BookmarkRow;
  onOpen: () => void;
  onRemove: () => void;
  onCopyCitation: () => void;
  onZotero: () => void;
}) {
  const citation = formatCitation(item);

  return (
    <View style={styles.card}>
      <TouchableOpacity accessibilityRole="button" onPress={onOpen} activeOpacity={0.7}>
        <Text style={styles.cardTitle}>{item.title}</Text>
        {item.author && <Text style={styles.cardAuthor}>{item.author}</Text>}
        <Text style={styles.cardCitation} selectable>{citation}</Text>
      </TouchableOpacity>

      <View style={styles.cardActions}>
        <TouchableOpacity accessibilityRole="button" style={styles.action} onPress={onCopyCitation}>
          <Text style={styles.actionText}>Share Citation</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={styles.action} onPress={onZotero}>
          <Text style={styles.actionText}>→ Zotero</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={[styles.action, styles.actionRight]} onPress={onRemove}>
          <Text style={styles.actionDestructive}>Remove</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = themedStyles(() => themedStyles(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingBottom: 8,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: 44,
  },
  back: { flexDirection: 'row', alignItems: 'center', minWidth: 80, paddingHorizontal: 8 },
  backChevron: { color: colors.accentSoft, fontSize: 28, lineHeight: 28, marginRight: 1 },
  backLabel: { color: colors.accentSoft, fontSize: 16 },
  headerTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },

  empty: { flex: 1, alignItems: 'center', marginTop: 120, paddingHorizontal: 40 },
  emptyText: { color: colors.textMuted, fontSize: 15, lineHeight: 22, textAlign: 'center' },

  card: {
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '500', marginBottom: 2 },
  cardAuthor: { color: colors.textMuted, fontSize: 13, marginBottom: 10 },
  cardCitation: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Georgia',
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },

  cardActions: {
    flexDirection: 'row',
    paddingVertical: 10,
    gap: 0,
  },
  action: {
    paddingVertical: 4,
    paddingRight: 16,
  },
  actionRight: { marginLeft: 'auto', paddingRight: 0 },
  actionText: { color: colors.accentSoft, fontSize: 13 },
  actionDestructive: { color: colors.danger, fontSize: 13 },
})));
