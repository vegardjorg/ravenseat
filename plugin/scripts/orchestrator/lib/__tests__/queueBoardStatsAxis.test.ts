// =============================================================
// queueBoardStatsAxis.test.ts: the y-axis ticks of the Statistics charts (queue-board/board/statistics.js axisTop).
//
// Why: the "Do the tracks wait on a gate slot?" chart read "1 s, 1 s, 0 s" for a small range: the axis top was 1 and
// the middle tick 0.5 was shown in whole seconds. The three ticks (0, top/2, top) must be distinct and say their value.
// axisTop is self-contained, so this test runs the function alone (read out of the client script), without a board.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '..', '..', 'queue-board', 'board', 'statistics.js'), 'utf8');
const fn = /\r?\nfunction axisTop\([\s\S]*?\r?\n}\r?\n/.exec(source)?.[0];
// eslint-disable-next-line no-new-func
const axisTop = new Function(`${fn}; return axisTop;`)() as (max: number, format: (v: number) => string) => number;

const counts = (x: number, d = 0) => Number(x ?? 0).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const seconds = (v: number) => `${counts(v)} s`;
const oneDecimal = (v: number) => counts(v, v % 1 ? 1 : 0);
const labels = (max: number, format: (v: number) => string) => {
  const top = axisTop(max, format);
  return [top, top / 2, 0].map(format);
};

describe('axisTop: three distinct ticks that say their value', () => {
  it('the function is found in the client script', () => expect(fn).toBeTruthy());

  it('whole seconds over a small range: no "1 s, 1 s, 0 s" any more', () => {
    expect(labels(1, seconds)).toEqual(['2 s', '1 s', '0 s']);
    expect(labels(0.4, seconds)).toEqual(['2 s', '1 s', '0 s']);
    expect(labels(0, seconds)).toEqual(['2 s', '1 s', '0 s']);
    // 5 would put "3 s" at 2.5: the next top that reads well.
    expect(labels(4, seconds)).toEqual(['4 s', '2 s', '0 s']);
    expect(labels(5, seconds)).toEqual(['6 s', '3 s', '0 s']);
  });

  it('every small max gives distinct labels that say their value', () => {
    for (let max = 0; max <= 60; max += 0.5) {
      const l = labels(max, seconds);
      expect(new Set(l).size, `max ${max}`).toBe(3);
      const top = axisTop(max, seconds);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(l.map((x) => Number(x.split(' ')[0].replace(/,/g, '')))).toEqual([top, top / 2, 0]);
    }
  });

  it('a range that read well before keeps its top', () => {
    expect(axisTop(10, seconds)).toBe(10);
    expect(axisTop(80, seconds)).toBe(100);
    expect(axisTop(160, seconds)).toBe(200);
    // A format with a decimal shows 2.5 as it is, so 5 stays.
    expect(axisTop(4, oneDecimal)).toBe(5);
    expect(labels(4, oneDecimal)).toEqual(['5', '2.5', '0']);
  });

  it('a label that is no plain number is checked for distinctness only', () => {
    const k = (v: number) => `${counts(v / 1000)}k`;
    expect(axisTop(1800, k)).toBe(2000);
  });
});
