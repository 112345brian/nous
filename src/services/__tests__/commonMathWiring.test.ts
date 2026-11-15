export {};
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const mockEnsure = jest.fn();
jest.mock('../db', () => ({ getMeta: jest.fn(), setMeta: jest.fn() }));
jest.mock('../mathCache', () => ({ ensureMath: (...a: unknown[]) => mockEnsure(...a) }));
jest.mock('../idleScheduler', () => ({ idleScheduler: { schedule: jest.fn() } }));

import { scheduleCommonMathPrewarm, realPrewarmDeps } from '../commonMathWiring';

describe('commonMathWiring', () => {
  it('schedules exactly one idle task under a stable key', () => {
    const schedule = jest.fn(() => true);
    scheduleCommonMathPrewarm({ schedule }, realPrewarmDeps());
    expect(schedule).toHaveBeenCalledTimes(1);
    expect((schedule.mock.calls[0] as unknown[])[0]).toBe('prewarm-common-math');
  });

  it("renders at the lowest ('background') priority, never ungated", async () => {
    mockEnsure.mockResolvedValue({ complete: true });
    await realPrewarmDeps().ensure([{ tex: 'x^2', display: false }]);
    expect(mockEnsure).toHaveBeenCalledWith([{ tex: 'x^2', display: false }], 'background');
  });

  it('source guard: only ensureMath(..., "background") is used for the pre-warm', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'commonMathWiring.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src.match(/ensureMath\(/g)?.length).toBe(1);
    expect(src).toMatch(/ensureMath\(spots, 'background'\)/);
    expect(src).not.toMatch(/renderMathBatch|renderMathChunked/);
  });
});
