export {};
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

jest.mock('../services/db', () => require('../services/__tests__/helpers/mockDbModule').asDbModule({ getMeta: jest.fn(), setMeta: jest.fn() }));

import { scheduleCommonMathPrewarm, realPrewarmDeps } from '../composition';

// The wiring lives in the composition root (it used to be services/commonMathWiring.ts).
describe('common-math pre-warm wiring', () => {
  it('schedules exactly one idle task under a stable key', () => {
    const schedule = jest.fn(() => true);
    scheduleCommonMathPrewarm({ schedule }, realPrewarmDeps(jest.fn()));
    expect(schedule).toHaveBeenCalledTimes(1);
    expect((schedule.mock.calls[0] as unknown[])[0]).toBe('prewarm-common-math');
  });

  it("renders at the lowest ('background') priority, never ungated", async () => {
    const ensure = jest.fn().mockResolvedValue({ complete: true });
    await realPrewarmDeps(ensure).ensure([{ tex: 'x^2', display: false }]);
    expect(ensure).toHaveBeenCalledWith([{ tex: 'x^2', display: false }], 'background');
  });

  it('source guard: the pre-warm only ever asks for the equation cache at "background" priority', () => {
    const all = fs.readFileSync(path.join(__dirname, '..', 'composition.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    const section = all.slice(all.indexOf('export function realPrewarmDeps'), all.indexOf('export function scheduleCommonMathPrewarm'));
    expect(section.match(/ensure\(/g)?.length).toBe(1);
    expect(section).toMatch(/ensure\(spots, 'background'\)/);
    expect(section).not.toMatch(/renderMathBatch|renderMathChunked|null\)/);
  });
});
