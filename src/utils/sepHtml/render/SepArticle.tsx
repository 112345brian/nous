import React, { useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { FlatList, View, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ParsedArticle, Block } from '../types';
import type { Annotation } from '../../../types';
import { BlockView, type BlockHandlers } from './Blocks';
import { SEP_COLORS, SEP_SIDE_PAD, useSepTheme } from './theme';
import { activeHeadingId, collectHeadings, sepItemType, type ListEngine } from './listHelpers';

// SPIKE FLAG: 'flatlist' is the shipping engine. Flip to 'flashlist' to try
// FlashList v2 (docs/library-research.md §5). The `listEngine` prop overrides it
// per instance for A/B comparison and tests.
export const SEP_LIST_ENGINE: ListEngine = 'flatlist';

export interface SepArticleProps {
  article: ParsedArticle;
  onLinkPress?: (href: string, wl: boolean) => void;
  onFootnotePress?: (href: string, label: string) => void;
  // Reading progress 0..1, throttled to ~2% steps (matches the WebView path).
  onProgress?: (value: number) => void;
  // Active section id as the user scrolls (scroll-spy for the TOC).
  onActiveSection?: (id: string) => void;
  // Fires on every scroll event so callers can keep background work paused.
  onScrollActivity?: () => void;
  renderFallback?: (html: string) => React.ReactNode;
  resolveImageSrc?: (src: string) => string | null;
  annotations?: Annotation[];
  onAnnotationPress?: (ann: Annotation) => void;
  onAnnotationCreate?: (text: string) => void;
  // Rendered inside the scroll view before the article body (title / breadcrumb
  // / preamble). Scrolls away with the content.
  header?: React.ReactNode;
  // Rendered inside the scroll view after the article body (e.g. the
  // "Related by link" backlinks row).
  footer?: React.ReactNode;
  // hash→svg map loaded from the math DB table after the article text renders.
  mathSvgs?: Record<string, string>;
  // Overrides SEP_LIST_ENGINE for this instance (A/B comparison, tests).
  listEngine?: ListEngine;
}

export interface SepArticleHandle {
  scrollToSection: (id: string) => void;
}

export const SepArticle = React.forwardRef<SepArticleHandle, SepArticleProps>(function SepArticle({
  article, onLinkPress, onFootnotePress, onProgress, onActiveSection, onScrollActivity, renderFallback,
  resolveImageSrc, annotations, onAnnotationPress, onAnnotationCreate, header, footer, mathSvgs,
  listEngine,
}, ref) {
  const engine: ListEngine = listEngine ?? SEP_LIST_ENGINE;
  const { bottom: bottomInset } = useSafeAreaInsets();
  const { measure } = useSepTheme();
  const flatListRef = useRef<FlatList<Block>>(null);
  const flashListRef = useRef<FlashListRef<Block>>(null);
  const headingOffsets = useRef<Map<string, number>>(new Map());
  const lastProgress = useRef(0);
  const lastSection = useRef('');

  // Strip leading rule blocks — they're <hr> artifacts from the skipped #toc div.
  const blocks = useMemo(() => {
    let i = 0;
    while (i < article.blocks.length && article.blocks[i].t === 'rule') i++;
    return i > 0 ? article.blocks.slice(i) : article.blocks;
  }, [article.blocks]);

  // Headings in document order (block index + id): feeds the scroll-spy and the
  // id → block index map used for index-based jumps.
  const headings = useMemo(() => collectHeadings(blocks), [blocks]);

  // Map heading id → block index for off-screen scrollToIndex fallback.
  const headingIndexMap = useMemo(
    () => new Map(headings.map(h => [h.id, h.index] as const)),
    [headings],
  );

  const onHeadingLayout = useCallback((id: string, y: number) => {
    headingOffsets.current.set(id, y);
  }, []);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScrollActivity?.();
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const scrollable = Math.max(1, contentSize.height - layoutMeasurement.height);
    const progress = Math.min(1, Math.max(0, contentOffset.y / scrollable));
    if (onProgress && Math.abs(progress - lastProgress.current) >= 0.02) {
      lastProgress.current = progress;
      onProgress(progress);
    }
    if (onActiveSection) {
      let active = '';
      if (engine === 'flashlist') {
        // Index-based spy: heading `onLayout` y is relative to its cell, not the
        // list content, so it can't be compared with the scroll offset here.
        const first = flashListRef.current?.getFirstVisibleIndex();
        active = first === undefined ? '' : activeHeadingId(headings, first);
      } else {
        const spy = contentOffset.y + 80;
        let bestY = -1;
        headingOffsets.current.forEach((y, id) => {
          if (y <= spy && y > bestY) { bestY = y; active = id; }
        });
      }
      if (active && active !== lastSection.current) {
        lastSection.current = active;
        onActiveSection(active);
      }
    }
  }, [onProgress, onActiveSection, onScrollActivity, engine, headings]);

  useImperativeHandle(ref, () => ({
    scrollToSection(id: string) {
      if (engine === 'flashlist') {
        // FlashList measures as it goes; scrollToIndex resolves once the target is placed.
        const index = headingIndexMap.get(id);
        if (index !== undefined) flashListRef.current?.scrollToIndex({ index, animated: true });
        return;
      }
      const y = headingOffsets.current.get(id);
      if (y !== undefined) {
        flatListRef.current?.scrollToOffset({ offset: y, animated: true });
        return;
      }
      // Heading not yet laid out (off-screen) — use index-based scroll.
      const index = headingIndexMap.get(id);
      if (index !== undefined) {
        flatListRef.current?.scrollToIndex({ index, animated: true });
      }
    },
  }), [headingIndexMap, engine]);

  const handlers: BlockHandlers = useMemo(() => ({
    onLinkPress,
    onFootnotePress,
    // FlashList path jumps by index, so skip the per-heading onLayout bookkeeping.
    onHeadingLayout: engine === 'flashlist' ? undefined : onHeadingLayout,
    renderFallback,
    resolveImageSrc,
    annotations,
    onAnnotationPress,
    onAnnotationCreate,
    mathSvgs,
  }), [onLinkPress, onFootnotePress, onHeadingLayout, renderFallback, resolveImageSrc,
      annotations, onAnnotationPress, onAnnotationCreate, mathSvgs, engine]);

  const renderBlock = useCallback(({ item, index }: { item: Block; index: number }) => (
    <BlockView block={item} h={handlers} suppressTopBorder={index === 0} />
  ), [handlers]);

  const keyExtractor = useCallback((_: Block, index: number) => String(index), []);

  const contentStyle = useMemo(
    () => ({ paddingHorizontal: SEP_SIDE_PAD, paddingTop: 16, paddingBottom: 96 + bottomInset }),
    [bottomInset],
  );

  // Read at render, not import: SEP_COLORS follows the active light/dark scheme.
  // (`style` on FlashList is the parent container, so it must not carry padding;
  // padding lives in contentContainerStyle.)
  const listStyle = { backgroundColor: SEP_COLORS.bg };
  // Cap the line length so wide windows (tablet, macOS, landscape) stay readable.
  const flatContentStyle = useMemo(
    () => ({
      ...contentStyle,
      width: '100%' as const,
      maxWidth: measure + SEP_SIDE_PAD * 2,
      alignSelf: 'center' as const,
    }),
    [contentStyle, measure],
  );

  const listHeader = header ? <View>{header}</View> : null;
  const listFooter = footer ? <View>{footer}</View> : null;

  if (engine === 'flashlist') {
    return (
      <FlashList<Block>
        ref={flashListRef}
        data={blocks}
        // Math SVGs and annotations reach cells via `handlers`, not `data`. FlashList
        // documents itself as a pure list that re-renders on data/extraData changes,
        // so pass it defensively. NOTE: in jest (mocked measurement) the math fill-in
        // test passes even without this, so it is unproven on device; verify there
        // before relying on or removing it.
        extraData={handlers}
        renderItem={renderBlock}
        keyExtractor={keyExtractor}
        getItemType={sepItemType}
        style={listStyle}
        // FlashList documents contentContainerStyle as padding/background only, so the
        // line-length cap below (FlatList path) is not applied here. Check on a device.
        contentContainerStyle={contentStyle}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
      />
    );
  }

  return (
    <FlatList<Block>
      ref={flatListRef}
      data={blocks}
      renderItem={renderBlock}
      keyExtractor={keyExtractor}
      style={listStyle}
      contentContainerStyle={flatContentStyle}
      onScroll={handleScroll}
      scrollEventThrottle={32}
      ListHeaderComponent={listHeader}
      ListFooterComponent={listFooter}
      windowSize={3}
      initialNumToRender={12}
      maxToRenderPerBatch={8}
      removeClippedSubviews
      onScrollToIndexFailed={(info) => {
        // Item not yet rendered — scroll to approximate position then retry once rendered.
        flatListRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: false,
        });
        setTimeout(() => {
          flatListRef.current?.scrollToIndex({ index: info.index, animated: true });
        }, 200);
      }}
    />
  );
});
