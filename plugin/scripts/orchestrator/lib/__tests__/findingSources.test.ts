// =============================================================
// findingSources.test.ts: what each existing source writes to the finding log (lib/findingSources.js, step 4 of the
// finding format contract).
//
// Locks: (1) every builder gives an input findingLog.makeRow accepts, with the source's caught_by, its severity and the
// class `other` (the GATE line keeps its own class); (2) the gate and CI rows carry the inspection queue's signature, and
// an infrastructure CI failure or a green run gives nothing; (3) a flaky command is L and the base gate's flaky run is
// base-gate; (4) red on base logs only unproven and tip-red; (5) the secret row has paths and rule names and never the
// matched value; (6) the fix links and the QA deviation are built from ids, never from a title or the owner's text;
// (7) record never throws: a failed write or build gives one WARNING, success gives nothing; (8) `once` skips a report
// the log already has (the same source, task, place and excerpt).
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const S = require('../findingSources.js') as any;
const FL = require('../findingLog.js') as any;
const FSIG = require('../failureSignature.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const NOW = Date.parse('2026-11-16T10:00:00Z');
const row = (x: object) => FL.makeRow(x, { now: NOW, seq: 1 });

describe('the time log sources', () => {
  it('a red gate row gives one row per red command with the inspection signature', () => {
    const gate = { event: 'gate', time: '2026-11-16T09:00:00Z', track: 'A', failed: ['npm test', 'npm run lint'], errors: { 'npm test': 'FAIL src/a.test.ts' } };
    const inputs = S.fromGateRow(gate);
    expect(inputs).toHaveLength(2);
    const sig = FSIG.fromGateRow(gate);
    const r = row(inputs[0]);
    expect(r).toMatchObject({ caught_by: 'gate', severity: 'M', class: 'other', task: 'A', signature: sig[0].id, counts: false });
    expect(r.excerpt).toContain('npm test');
    expect(row(inputs[1]).excerpt).toBe('npm run lint: red');
    expect(S.fromGateRow({ event: 'gate', failed: [] })).toEqual([]);
  });

  it('a flaky row is L; the base gate run is base-gate, a track run is gate', () => {
    const track = S.fromFlakyRow({ event: 'flakyGate', commands: ['npm test'], source: 'track gate (quick)', task: 'A' });
    expect(row(track[0])).toMatchObject({ caught_by: 'gate', severity: 'L', task: 'A', counts: false });
    const base = S.fromFlakyRow({ event: 'flakyGate', commands: ['npm test'], source: 'base gate' });
    expect(base[0].caught_by).toBe('base-gate');
    expect(S.fromFlakyRow({ event: 'flakyGate', commands: [] })).toEqual([]);
  });

  it('a failed CI check gives one row per job; infra and green give nothing', () => {
    const ci = { event: 'ciWatch', verdict: 'check', sha: 'abc1234', task: 'CI-abc1234', failures: [{ name: 'ci: CI / test / Run', excerpt: 'FAIL a.test.ts' }] };
    const r = row(S.fromCiRow(ci)[0]);
    expect(r).toMatchObject({ caught_by: 'ci', severity: 'M', task: 'CI-abc1234', signature: FSIG.fromCiRow(ci)[0].id });
    expect(S.fromCiRow({ ...ci, verdict: 'infra' })).toEqual([]);
    expect(S.fromTimeRow({ event: 'ciWatch', verdict: 'green' })).toEqual([]);
    expect(S.fromTimeRow({ event: 'baseGate', ok: false })).toEqual([]);
  });
});

describe('the task sources', () => {
  it('a base fix is H with a signature and the merge that made it red', () => {
    const r = row(S.baseFix({ run: { failed: 'npm test', tail: ['Error: boom 42'] }, causeId: 'A', madeRedBy: { task: 'A' } }));
    expect(r).toMatchObject({ caught_by: 'base-gate', severity: 'H', task: 'A', cause_task: 'A', counts: false });
    expect(r.signature).toMatch(/^[0-9a-f]{12}$/);
  });

  it('a red done command is M, a tampered one H, a green one nothing', () => {
    expect(row(S.doneCheck({ id: 'A', command: 'npm test', run: { ok: false, tail: ['Error: x'] } }))).toMatchObject({ caught_by: 'done-check', severity: 'M', task: 'A' });
    expect(S.doneCheck({ id: 'A', command: 'npm test', run: { ok: false, tail: [] }, tamperReason: 'a hook changed' }).severity).toBe('H');
    expect(S.doneCheck({ id: 'A', command: 'npm test', run: { ok: true, tail: [] } })).toBeNull();
  });

  it('red on base logs unproven and tip-red only', () => {
    const r = row(S.redOnBase({ id: 'A', record: { verdict: 'unproven', files: [{ path: 'src/a.test.ts', base: 'green' }] } }));
    expect(r).toMatchObject({ caught_by: 'red-on-base', severity: 'L', test_added: 'src/a.test.ts', where: { files: ['src/a.test.ts'] } });
    expect(S.redOnBase({ id: 'A', record: { verdict: 'tip-red', files: [] } }).severity).toBe('M');
    for (const verdict of ['proven', 'no-tests', 'tests-only', 'error']) expect(S.redOnBase({ id: 'A', record: { verdict } })).toBeNull();
  });

  it('the secret row has the paths and the rule names, never a value', () => {
    const found = { count: 2, hits: [{ file: 'src/k.ts', line: 3, rule: 'aws-access-key' }, { file: 'src/j.ts', line: 9, rule: 'aws-access-key' }] };
    const r = row(S.secretFound({ id: 'A', found }));
    expect(r).toMatchObject({ caught_by: 'secret-scan', severity: 'H', where: { files: ['src/k.ts', 'src/j.ts'], line: null } });
    expect(r.excerpt).toBe('2 secret hit(s) at receive (rules: aws-access-key)');
    expect(S.secretFound({ id: 'A', found: { hits: [] } })).toBeNull();
  });

  it('the GATE line keeps its class and place', () => {
    const r = row(S.gateLine({ id: 'A', gate: { title: 'unchecked error or result', where: 'src/a.ts:12', class: 'unchecked-error', text: 'the save result was ignored' } }));
    expect(r).toMatchObject({ caught_by: 'gate-line', class: 'unchecked-error', class_source: 'agent', where: { files: ['src/a.ts'], line: 12 }, counts: true });
    expect(row(S.gateLine({ id: 'A', gate: { title: 'old free text', where: null } }))).toMatchObject({ class: 'other', excerpt: 'old free text' });
  });

  it('finding, fixes and QA: the cause, and ids instead of free text', () => {
    expect(row(S.finding({ title: 'the cache is never cleared', task: 'A', files: ['src/c.ts'], causes: ['B'] }))).toMatchObject({ caught_by: 'finding', task: 'A', cause_task: 'B' });
    const fx = S.fixLinks({ id: 'B-FIX', fixes: ['B', 'C', 'B-FIX'] });
    expect(fx.map((x: { cause_task: string }) => x.cause_task)).toEqual(['B', 'C']);
    expect(row(fx[0])).toMatchObject({ caught_by: 'post-merge', task: 'B-FIX', excerpt: 'fix task B-FIX fixes B, a defect after merge' });
    expect(row(S.qaDeviation({ id: 'B', fixId: 'B-QA1' }))).toMatchObject({ caught_by: 'qa', task: 'B-QA1', cause_task: 'B', excerpt: 'QA deviation on B, fix task B-QA1' });
  });
});

describe('record', () => {
  it('writes each input and says nothing on success', () => {
    const seen: object[] = [];
    const warn: string[] = [];
    const r = S.record([{ a: 1 }, null, { b: 2 }], { append: (_root: unknown, x: object) => seen.push(x), warn: (l: string) => warn.push(l) });
    expect(r).toEqual({ written: 2, failed: 0 });
    expect(seen).toHaveLength(2);
    expect(warn).toEqual([]);
  });

  it('once: the same report again adds no row, another one does', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-finding-sources-'));
    const before = process.env.QUEUE_FOLDER;
    process.env.QUEUE_FOLDER = root;
    try {
      const gate = { title: 'unchecked error or result', where: 'src/a.ts:12', class: 'unchecked-error', text: 'the save result was ignored' };
      expect(S.record(S.gateLine({ id: 'A', gate }), { once: true }).written).toBe(1);
      expect(S.record(S.gateLine({ id: 'A', gate }), { once: true }).written).toBe(0);
      expect(S.record(S.gateLine({ id: 'B', gate }), { once: true }).written).toBe(1);
      // Without once (a gate that ran again) every call is a row.
      expect(S.record(S.gateLine({ id: 'A', gate })).written).toBe(1);
      expect(FL.read(null).rows.map((r: { task: string }) => r.task)).toEqual(['A', 'B', 'A']);
    } finally {
      if (before === undefined) delete process.env.QUEUE_FOLDER;
      else process.env.QUEUE_FOLDER = before;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('a failed write or build gives one WARNING and never throws', () => {
    const warn: string[] = [];
    const boom = () => {
      throw new Error('disk full');
    };
    expect(S.record([{ a: 1 }, { b: 2 }], { append: boom, warn: (l: string) => warn.push(l) })).toEqual({ written: 0, failed: 2 });
    expect(warn).toEqual(['WARNING: the finding log did not get 2 row(s) (disk full); nothing else changed.']);
    expect(S.record(boom, { warn: (l: string) => warn.push(l) }).failed).toBe(1);
    expect(warn).toHaveLength(2);
    expect(() => S.record([{ a: 1 }], { append: boom, warn: boom })).not.toThrow();
  });
});
