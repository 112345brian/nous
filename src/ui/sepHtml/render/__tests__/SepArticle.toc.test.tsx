// TOC jumps and scroll-spy on the shipping FlatList path. Both are index-based:
// heading onLayout y is cell-relative, so it can't be used as a scroll offset.
// Jest cannot scroll or measure, so this asserts the calls made to the list and
// the section reported for a given first visible index; scroll feel needs a device.

import React from 'react';
import { FlatList } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { ParsedArticle, Block } from '../../../../utils/sepHtml/types';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
require('@shopify/flash-list/jestSetup');

import { SepArticle, type SepArticleHandle } from '../SepArticle';

const para = (text: string): Block => ({ t: 'para', children: [{ t: 'text', v: text }] });
const heading = (id: string): Block => ({ t: 'heading', level: 2, id, children: [{ t: 'text', v: id }] });

// 2 leading rules are stripped, so block 0 below is the first paragraph.
const blocks: Block[] = [
  { t: 'rule' }, { t: 'rule' },
  para('intro'),          // 0
  heading('s1'),          // 1  (rendered in the initial window)
  para('a'), para('b'),   // 2,3
  heading('s2'),          // 4
  ...Array.from({ length: 40 }, (_, i) => para(`p${i}`)), // 5..44
  heading('s3'),          // 45 (far off-screen)
  para('end'),
] as Block[];
const article: ParsedArticle = { blocks, hasUnsupported: false, footnotes: {} };

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(async () => {
  jest.useRealTimers();
  await ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); });
});

async function setup(onActiveSection?: (id: string) => void) {
  const ref = React.createRef<SepArticleHandle>();
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    r = ReactTestRenderer.create(
      <SepArticle ref={ref} article={article} listEngine="flatlist" onActiveSection={onActiveSection} />,
    );
  });
  await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(res, 0)); });
  mounted.push(r);
  const list = r.root.findByType(FlatList);
  const inst = list.instance as FlatList<Block>;
  const scrollToIndex = jest.spyOn(inst, 'scrollToIndex').mockImplementation(() => {});
  const scrollToOffset = jest.spyOn(inst, 'scrollToOffset').mockImplementation(() => {});
  return { ref, list, scrollToIndex, scrollToOffset };
}

describe('scrollToSection (FlatList)', () => {
  it.each([['s1', 1], ['s2', 4], ['s3', 45]])('jumps to block index of %s', async (id, index) => {
    const { ref, scrollToIndex, scrollToOffset } = await setup();
    ref.current!.scrollToSection(id);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index, viewPosition: 0, animated: true }));
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('ignores unknown ids', async () => {
    const { ref, scrollToIndex } = await setup();
    ref.current!.scrollToSection('nope');
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('retries by index after onScrollToIndexFailed', async () => {
    const { list, scrollToIndex, scrollToOffset } = await setup();
    jest.useFakeTimers();
    list.props.onScrollToIndexFailed({ index: 45, highestMeasuredFrameIndex: 10, averageItemLength: 50 });
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 50 * 45, animated: false });
    expect(scrollToIndex).not.toHaveBeenCalled();
    jest.advanceTimersByTime(250);
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 45, viewPosition: 0, animated: true }));
  });
});

describe('scroll-spy (FlatList)', () => {
  const vt = (...idx: number[]) => ({
    viewableItems: idx.map(index => ({ index, isViewable: true, key: String(index), item: blocks[index] })),
    changed: [],
  });

  it('reports the section of the first viewable item and dedupes', async () => {
    const seen: string[] = [];
    const { list } = await setup(id => seen.push(id));
    const cb = list.props.onViewableItemsChanged;
    expect(list.props.viewabilityConfig).toBeDefined();
    ReactTestRenderer.act(() => { cb(vt(0, 1, 2)); }); // 0 = intro, above any heading
    expect(seen).toEqual([]);
    ReactTestRenderer.act(() => { cb(vt(3, 2, 4)); }); // first is 2 -> s1
    ReactTestRenderer.act(() => { cb(vt(3)); });       // still s1
    ReactTestRenderer.act(() => { cb(vt(10, 11)); });  // -> s2
    ReactTestRenderer.act(() => { cb(vt(46)); });      // -> s3
    expect(seen).toEqual(['s1', 's2', 's3']);
  });

  it('keeps the same callback and config across re-renders', async () => {
    const { list } = await setup(() => {});
    const r = mounted[0];
    const cb = list.props.onViewableItemsChanged;
    const cfg = list.props.viewabilityConfig;
    await ReactTestRenderer.act(async () => {
      r.update(<SepArticle article={article} listEngine="flatlist" onActiveSection={() => {}} />);
    });
    const after = r.root.findByType(FlatList);
    expect(after.props.onViewableItemsChanged).toBe(cb);
    expect(after.props.viewabilityConfig).toBe(cfg);
  });
});
