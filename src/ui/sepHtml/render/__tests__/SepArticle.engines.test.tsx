// Smoke tests for the two list engines behind SepArticle. FlashList's own jest
// setup mocks measurement (400x900 viewport, 100px items), so this checks that the
// FlashList path mounts, renders real blocks, and re-renders cells when math SVGs
// arrive after first paint (the `extraData` requirement), with the FlatList path
// as the regression baseline. It cannot measure speed or scroll feel; that needs
// a device.

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type { ParsedArticle, Block } from '../../../../utils/sepHtml/types';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
require('@shopify/flash-list/jestSetup');

import { SepArticle } from '../SepArticle';

const para = (text: string): Block => ({ t: 'para', children: [{ t: 'text', v: text }] });

function article(blocks: Block[]): ParsedArticle {
  return { blocks, hasUnsupported: false, footnotes: {} };
}

const mathPara: Block = {
  t: 'para',
  children: [{ t: 'mathref', hash: 'h1', w: 2, h: 1, display: false }],
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(async () => {
  // Unmount so VirtualizedList's pending batch timers don't fire after the test.
  await ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); });
});

async function mount(el: React.ReactElement) {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(el); });
  // Let VirtualizedList's deferred batch/layout updates land inside act().
  await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(res, 0)); });
  mounted.push(r);
  return r;
}

// Flatten the rendered tree to "type" and text tokens. (JSON.stringify on the tree
// follows props like ListHeaderComponent, which are circular React elements.)
function json(r: ReactTestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (n: ReactTestRenderer.ReactTestRendererNode | ReactTestRenderer.ReactTestRendererNode[] | null) => {
    if (n == null) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'string') { out.push(n); return; }
    out.push(`<${n.type}>`);
    n.children?.forEach(walk);
  };
  walk(r.toJSON());
  return out.join(' ');
}

describe.each(['flatlist', 'flashlist'] as const)('SepArticle (%s)', engine => {
  it('renders the first blocks', async () => {
    const blocks = [para('alpha-first'), para('beta-second'), para('gamma-third')];
    const r = await mount(<SepArticle article={article(blocks)} listEngine={engine} />);
    const out = json(r);
    expect(out).toContain('alpha-first');
    expect(out).toContain('beta-second');
  });

  it('renders the header and footer inside the list', async () => {
    const r = await mount(
      <SepArticle
        article={article([para('body-text')])}
        listEngine={engine}
        header={<React.Fragment>{'HEADER-MARK'}</React.Fragment>}
        footer={<React.Fragment>{'FOOTER-MARK'}</React.Fragment>}
      />,
    );
    const out = json(r);
    expect(out).toContain('HEADER-MARK');
    expect(out).toContain('FOOTER-MARK');
  });

  it('fills in a math SVG for an already-visible cell when mathSvgs arrives later', async () => {
    const a = article([para('intro'), mathPara]);
    const r = await mount(<SepArticle article={a} listEngine={engine} />);
    const before = json(r);
    await ReactTestRenderer.act(async () => {
      r.update(<SepArticle article={a} listEngine={engine} mathSvgs={{ h1: SVG }} />);
    });
    const after = json(r);
    // The placeholder is an invisible View; the filled-in cell renders an SVG tree.
    expect(after).not.toBe(before);
    expect(after).toMatch(/RNSVG/i);
    expect(before).not.toMatch(/RNSVG/i);
  });
});
