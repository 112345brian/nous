import { createPerf } from '../perf';

function setup(enabled = true) {
  let t = 0;
  const lines: string[] = [];
  const perf = createPerf({ enabled, now: () => t, log: l => lines.push(l) });
  return { perf, lines, advance: (ms: number) => { t += ms; } };
}

describe('createPerf', () => {
  it('logs one summary line with per-stage durations in first-seen order', async () => {
    const { perf, lines, advance } = setup();
    perf.begin('kant');
    await perf.time('kant', 'fetch', async () => { advance(120); });
    perf.timeSync('kant', 'parse', () => { advance(30); });
    advance(5); // untimed gap still counts toward total
    perf.end('kant');
    expect(lines).toEqual(['[perf] kant total=155ms fetch=120ms parse=30ms']);
  });

  it('sums repeated stages', () => {
    const { perf, lines, advance } = setup();
    perf.begin('a');
    perf.timeSync('a', 'db', () => { advance(10); });
    perf.timeSync('a', 'db', () => { advance(15); });
    perf.end('a');
    expect(lines[0]).toBe('[perf] a total=25ms db=25ms');
  });

  it('records marks as elapsed-since-begin and keeps only the first', () => {
    const { perf, lines, advance } = setup();
    perf.begin('a');
    advance(40);
    perf.mark('a', 'first-render');
    advance(60);
    perf.mark('a', 'first-render');
    perf.end('a');
    expect(lines[0]).toBe('[perf] a total=100ms @first-render=40ms');
  });

  it('returns the wrapped result and still records time when fn throws', async () => {
    const { perf, lines, advance } = setup();
    perf.begin('a');
    expect(perf.timeSync('a', 's', () => 7)).toBe(7);
    await expect(perf.time('a', 'v', async () => 'x')).resolves.toBe('x');
    await expect(
      perf.time('a', 'boom', async () => { advance(9); throw new Error('nope'); }),
    ).rejects.toThrow('nope');
    expect(() => perf.timeSync('a', 'boom2', () => { advance(1); throw new Error('sync'); })).toThrow('sync');
    perf.end('a');
    expect(lines[0]).toContain('boom=9ms');
    expect(lines[0]).toContain('boom2=1ms');
  });

  it('keeps traces for different keys independent', () => {
    const { perf, lines, advance } = setup();
    perf.begin('a');
    perf.begin('b');
    perf.timeSync('a', 's', () => { advance(5); });
    perf.end('a');
    perf.end('b');
    expect(lines[0]).toBe('[perf] a total=5ms s=5ms');
    expect(lines[1]).toBe('[perf] b total=5ms');
  });

  it('ignores stages/marks/end with no trace and does not log twice', () => {
    const { perf, lines } = setup();
    perf.timeSync('ghost', 's', () => 1);
    perf.mark('ghost', 'm');
    perf.end('ghost');
    perf.begin('a');
    perf.end('a');
    perf.end('a');
    expect(lines).toHaveLength(1);
  });

  it('is a transparent no-op when disabled', async () => {
    const { perf, lines } = setup(false);
    perf.begin('a');
    expect(perf.timeSync('a', 's', () => 3)).toBe(3);
    await expect(perf.time('a', 'v', async () => 4)).resolves.toBe(4);
    await expect(perf.time('a', 'e', async () => { throw new Error('x'); })).rejects.toThrow('x');
    perf.mark('a', 'm');
    perf.end('a');
    expect(lines).toEqual([]);
  });
});
