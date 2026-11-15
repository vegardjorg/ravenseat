// =============================================================
// reviewFindings.test.ts: the review report's FINDINGS line with the FINDING lines under it (lib/logic/results.js
// through lib/queueLogic.js): old reports read as before, new ones derive deferrable from the marks, the sum keys codes
// per reviewer, and the reviewer prompt asks for the new contract.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const L = require('../queueLogic.js');

const NEW = [
  'FINDINGS H=0 M=1 L=2',
  'FINDING M1 M mechanical unchecked-error @ src/api/save.ts:42 | the write result is ignored',
  'FINDING L1 L defer time-zone @ src/report/day.ts:17 | the day boundary uses local time',
  'FINDING L2 L before-merge - @ - | the new setting is missing from the docs table',
].join('\n');

describe('parseFindings with FINDING lines', () => {
  it('an old report reads exactly as before', () => {
    const a = L.parseFindings('FINDINGS H=0 M=1 L=3 deferrable=L2,L3');
    expect(a).toEqual({ line: 'FINDINGS H=0 M=1 L=3 deferrable=L2,L3', H: 0, M: 1, L: 3, deferrable: ['L2', 'L3'] });
  });
  it('a new report derives deferrable from the defer marks', () => {
    expect(L.parseFindings(NEW)).toMatchObject({ H: 0, M: 1, L: 2, deferrable: ['L1'] });
  });
  it('the marks win over a deferrable= that is also there', () => {
    expect(L.parseFindings(NEW.replace('L=2', 'L=2 deferrable=L1,L2')).deferrable).toEqual(['L1']);
  });
  it('counts that differ from the lines: the lines count and the note says so', () => {
    const f = L.parseFindings(NEW.replace('M=1', 'M=4'));
    expect(f.M).toBe(1);
    expect(f.note).toMatch(/differ/);
  });
});

describe('batchFindings keys codes per reviewer', () => {
  it('two reviewers with L1 give two deferrable findings', () => {
    const line = 'FINDINGS H=0 M=0 L=1\nFINDING L1 L defer - @ - | x';
    const a = L.parseFindings(line, { reviewer: 'reviewer' });
    const b = L.parseFindings(line, { reviewer: 'reviewer-security' });
    expect(L.batchFindings([a, b])).toEqual({ H: 0, M: 0, L: 2, deferrable: ['reviewer:L1', 'reviewer-security:L1'], reports: 2 });
  });
  it('the same reviewer twice is still one', () => {
    const a = L.parseFindings('FINDINGS H=0 M=0 L=1 deferrable=L1', { reviewer: 'reviewer' });
    expect(L.batchFindings([a, a]).deferrable).toEqual(['reviewer:L1']);
  });
});

describe('reportFindings: the findings of one report', () => {
  it('gives the items with the reviewer and the round', () => {
    const r = L.reportFindings(NEW, { reviewer: 'reviewer-security', round: 2 });
    expect(r.items.map((x: { code: string }) => x.code)).toEqual(['M1', 'L1', 'L2']);
    expect(r).toMatchObject({ reviewer: 'reviewer-security', round: 2, counts: { H: 0, M: 1, L: 2 } });
  });
  it('an old report with counts and no lines gives one summary item', () => {
    const r = L.reportFindings('FINDINGS H=0 M=2 L=3 deferrable=L1');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].invalid).toBe('no lines');
  });
  it('no FINDINGS line and no FINDING lines: null', () => {
    expect(L.reportFindings('nothing here')).toBeNull();
  });
});

describe('reviewerPrompt asks for the new contract', () => {
  it('the counts line first, then one FINDING line per finding with the class ids', () => {
    const p = L.reviewerPrompt({ o: { id: 'A', class: 'D' }, type: 'reviewer', folder: '/x' });
    expect(p).toContain('FINDINGS H=<n> M=<n> L=<n>');
    expect(p).not.toContain('deferrable=');
    expect(p).toContain('FINDING <code> <H|M|L> <mark> <class> @ <file:line|-> | <one sentence>');
    expect(p).toContain('unchecked-error');
  });
});
