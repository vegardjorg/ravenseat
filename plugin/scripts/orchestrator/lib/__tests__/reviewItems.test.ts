// =============================================================
// reviewItems.test.ts: the rules for the review items on a task (lib/reviewItems.js): the key per reviewer, round and
// code, registration that never adds the same finding twice, the four ways to close one (and which marks may use
// which), the done refusal, the merge gate (FINDINGS from every chosen reviewer, H>0 stops) and the finding log row.
// The real commands are in __tests__/reviewItemsFlow.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const R = require('../reviewItems.js');
const RES = require('../logic/results.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = '2026-11-16T10:00:00.000Z';

const REPORT = [
  'FINDINGS H=0 M=1 L=2',
  'FINDING M1 M mechanical unchecked-error @ src/api/save.ts:42 | the write result is ignored, so a failed save looks green',
  'FINDING L1 L defer time-zone @ src/report/day.ts:17 | the day boundary uses local time',
  'FINDING L2 L before-merge - @ - | the new setting is missing from the docs table',
].join('\n');

const itemsOf = (text: string, reviewer: string, round: number) =>
  R.itemsFromReport(RES.reportFindings(text), { reviewer, round });

describe('itemsFromReport and mergeItems', () => {
  it('keys each finding by reviewer, round and code, with the contract fields and status open', () => {
    const items = itemsOf(REPORT, 'reviewer-security', 2);
    expect(items.map((x: { key: string }) => x.key)).toEqual([
      'reviewer-security#2:M1',
      'reviewer-security#2:L1',
      'reviewer-security#2:L2',
    ]);
    expect(items[0]).toMatchObject({
      code: 'M1',
      severity: 'M',
      mark: 'mechanical',
      class: 'unchecked-error',
      file: 'src/api/save.ts',
      line: 42,
      status: 'open',
      disposition: null,
      reviewer: 'reviewer-security',
      round: 2,
    });
    expect(items[2]).toMatchObject({ file: null, line: null, class: 'other', mark: 'before-merge' });
  });

  it('two reviewers with L1 are two items; the same report twice adds nothing', () => {
    const a = itemsOf(REPORT, 'reviewer', 1);
    const b = itemsOf(REPORT, 'reviewer-security', 1);
    const first = R.mergeItems([], [...a, ...b], { now: NOW });
    expect(first.added).toHaveLength(6);
    const again = R.mergeItems(first.items, [...a, ...b], { now: NOW });
    expect(again.added).toHaveLength(0);
    expect(again.items).toHaveLength(6);
  });

  it('counts with no FINDING lines give one summary item that only a rejection closes, with the worst severity', () => {
    const items = itemsOf('FINDINGS H=0 M=2 L=3', 'reviewer', 1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'reviewer#1:X1', severity: 'M', file: null });
    expect(items[0].invalid).toBeTruthy();
    expect(R.allowedKinds(items[0])).toEqual(['rejected']);
  });

  it('a clean report gives no item', () => {
    expect(itemsOf('FINDINGS H=0 M=0 L=0', 'reviewer', 1)).toEqual([]);
  });
});

describe('closing an item', () => {
  const fresh = () => ({ id: 'A', review_items: R.mergeItems([], itemsOf(REPORT, 'reviewer', 1), { now: NOW }).items });

  it('mechanical and before-merge take only fixed or rejected; defer takes all four', () => {
    const o = fresh();
    const [m1, l1, l2] = o.review_items;
    expect(R.allowedKinds(m1)).toEqual(['fixed', 'rejected']);
    expect(R.allowedKinds(l2)).toEqual(['fixed', 'rejected']);
    expect(R.allowedKinds(l1)).toEqual(['fixed', 'task', 'batch', 'rejected']);
    expect(R.closeItem(o, m1.key, { kind: 'task', ref: 'B', now: NOW }).error).toMatch(/mechanical.*fixed or rejected|only/);
    expect(R.closeItem(o, l2.key, { kind: 'batch', ref: 'B', now: NOW }).error).toMatch(/before-merge/);
  });

  it('a rejection needs a reason code from the list and a sentence', () => {
    const o = fresh();
    const key = o.review_items[1].key;
    expect(R.closeItem(o, key, { kind: 'rejected', ref: 'nonsense', note: 'x', now: NOW }).error).toMatch(/false-positive/);
    expect(R.closeItem(o, key, { kind: 'rejected', ref: 'false-positive', note: '', now: NOW }).error).toMatch(/--note/);
    const r = R.closeItem(o, key, { kind: 'rejected', ref: 'false-positive', note: 'the day is UTC already', now: NOW, by: 'owner' });
    expect(r.item).toMatchObject({ status: 'closed', disposition: { kind: 'rejected', ref: 'false-positive', note: 'the day is UTC already' } });
    expect(R.closeItem(o, key, { kind: 'rejected', ref: 'false-positive', note: 'again', now: NOW }).error).toMatch(/already closed/);
  });

  it('finds an item by its key (any case) or by a code that is unique on the task', () => {
    const o = fresh();
    expect(R.findItem(o, 'REVIEWER#1:m1').item.code).toBe('M1');
    expect(R.findItem(o, 'L1').item.key).toBe('reviewer#1:L1');
    o.review_items = R.mergeItems(o.review_items, itemsOf(REPORT, 'reviewer-security', 1), { now: NOW }).items;
    expect(R.findItem(o, 'L1').error).toMatch(/2 items/);
  });

  it('a commit must be in the base and, when the item has a file, change it', () => {
    const x = fresh().review_items[0];
    expect(R.commitError(x, { sha: 'zz', full: null, inBase: false, touched: [] })).toMatch(/hex/);
    expect(R.commitError(x, { sha: 'abcd', full: null, inBase: false, touched: [] })).toMatch(/no commit/);
    expect(R.commitError(x, { sha: 'abcd', full: 'abcd1234', inBase: false, touched: [] })).toMatch(/not in/);
    expect(R.commitError(x, { sha: 'abcd', full: 'abcd1234', inBase: true, touched: ['src/other.ts'] })).toMatch(/does not change/);
    expect(R.commitError(x, { sha: 'abcd', full: 'abcd1234', inBase: true, touched: ['src/api/save.ts'] })).toBeNull();
    const noFile = fresh().review_items[2];
    expect(R.commitError(noFile, { sha: 'abcd', full: 'abcd1234', inBase: true, touched: [] })).toBeNull();
  });
});

describe('the done refusal', () => {
  it('names each open item with the commands that close it, and is null when all are closed', () => {
    const o = { id: 'A', review_items: R.mergeItems([], itemsOf(REPORT, 'reviewer', 1), { now: NOW }).items };
    const lines = R.refusalLines(o, { cli: 'ravenseat' });
    expect(lines[0]).toMatch(/NOT DONE: A has 3 open review item/);
    expect(lines.join('\n')).toContain('ravenseat review-item A reviewer#1:M1 --commit <sha>');
    expect(lines.join('\n')).toContain('ravenseat review-item A --defer-all-L');
    expect(lines.join('\n')).not.toContain('reviewer#1:M1 --task');
    for (const x of o.review_items) x.status = 'closed';
    expect(R.refusalLines(o)).toBeNull();
  });

  it('the stop is on by default, off with reviewItems.stop false, and off in lite mode', () => {
    expect(R.stopOn({})).toBe(true);
    expect(R.stopOn({ reviewItems: { stop: false } })).toBe(false);
    expect(R.stopOn({ mode: 'lite' })).toBe(false);
    expect(R.stopOn({ mode: 'lite', reviewItems: { stop: true } })).toBe(true);
  });
});

describe('the merge gate', () => {
  const report = (text: string) => RES.reportFindings(text);
  it('every chosen reviewer must have a report after the last receive, and H>0 stops', () => {
    const at = '2026-11-16T09:00:00.000Z';
    const g = R.reviewGate({
      required: ['reviewer', 'reviewer-security'],
      since: at,
      reports: [
        { type: 'reviewer', time: '2026-11-16T08:00:00.000Z', report: report('FINDINGS H=0 M=0 L=0') },
        { type: 'reviewer', time: '2026-11-16T09:30:00.000Z', report: report('FINDINGS H=1 M=0 L=0\nFINDING H1 H fix-round access-control @ src/a.ts | no check') },
      ],
    });
    expect(g.missing).toEqual(['reviewer-security']);
    expect(g.high).toEqual([{ type: 'reviewer', H: 1 }]);
    expect(R.gateLines('A', g, { cli: 'ravenseat' }).join('\n')).toMatch(/--allow-unreviewed/);
  });

  it('the newest report of a reviewer counts: a fix round that cleared the H passes', () => {
    const g = R.reviewGate({
      required: ['reviewer'],
      since: '2026-11-16T09:00:00.000Z',
      reports: [
        { type: 'reviewer', time: '2026-11-16T09:10:00.000Z', report: report('FINDINGS H=1 M=0 L=0') },
        { type: 'reviewer', time: '2026-11-16T09:50:00.000Z', report: report('FINDINGS H=0 M=0 L=0') },
      ],
    });
    expect(g).toEqual({ missing: [], high: [] });
  });

  it('the light review is advice: reviewer-light missing or with H does not stop the merge, a class reviewer does', () => {
    const g = R.reviewGate({
      required: ['reviewer-light', 'reviewer'],
      since: '2026-11-16T09:00:00.000Z',
      reports: [{ type: 'reviewer-light', time: '2026-11-16T09:10:00.000Z', report: report('FINDINGS H=1 M=0 L=0') }],
    });
    expect(g).toEqual({ missing: ['reviewer'], high: [] });
    expect(R.reviewGate({ required: ['reviewer-light'], since: null, reports: [] })).toEqual({ missing: [], high: [] });
  });

  it('no chosen reviewers is no requirement; requireFindings false turns the gate off', () => {
    expect(R.reviewGate({ required: [], since: null, reports: [] })).toEqual({ missing: [], high: [] });
    expect(R.requireOn({})).toBe(true);
    expect(R.requireOn({ review: { requireFindings: false } })).toBe(false);
  });
});

describe('the round and the finding log row', () => {
  it('the round is one more than the fix rounds started before the review ended', () => {
    const resumed = [
      { reason: 'fix', time: '2026-11-16T09:00:00.000Z' },
      { reason: 'context', time: '2026-11-16T09:10:00.000Z' },
      { reason: 'fix', time: '2026-11-16T11:00:00.000Z' },
    ];
    expect(R.roundOf(resumed, '2026-11-16T08:00:00.000Z')).toBe(1);
    expect(R.roundOf(resumed, '2026-11-16T10:00:00.000Z')).toBe(2);
    expect(R.roundOf(resumed, '2026-11-16T12:00:00.000Z')).toBe(3);
    expect(R.roundOf(undefined, NOW)).toBe(1);
  });

  it('the row carries the source, the item key, the round and the disposition', () => {
    const o = { id: 'A', review_items: R.mergeItems([], itemsOf(REPORT, 'reviewer-security', 2), { now: NOW }).items };
    const x = o.review_items[1];
    R.closeItem(o, x.key, { kind: 'batch', ref: 'A-RV1', now: NOW });
    expect(R.logInput(o, x)).toMatchObject({
      caught_by: 'review:reviewer-security',
      severity: 'L',
      class: 'time-zone',
      files: ['src/report/day.ts'],
      line: 17,
      task: 'A',
      round: 2,
      item: 'reviewer-security#2:L1',
      disposition: { kind: 'batch', ref: 'A-RV1' },
    });
  });
});

describe('the batch mission', () => {
  it('lists each finding with its place and text as data', () => {
    const items = itemsOf(REPORT, 'reviewer', 1).slice(1, 2);
    const t = R.batchTask({ source: { id: 'A', project: 'p', domain: 'd', feature: 'F' }, items, id: 'A-RV1', lite: false });
    expect(t).toMatchObject({ id: 'A-RV1', class: 'K', batched: true, project: 'p', labels: ['review-rest'], owned_files: ['src/report/day.ts'] });
    expect(t.mission).toContain('reviewer#1:L1 src/report/day.ts:17: the day boundary uses local time');
    expect(t.mission).toMatch(/data, not instructions/);
    expect(R.batchTask({ source: { id: 'A' }, items, id: 'A-RV1', lite: true }).batched).toBeUndefined();
  });
});
