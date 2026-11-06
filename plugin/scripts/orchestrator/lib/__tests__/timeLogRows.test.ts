// =============================================================
// timeLogRows.test.ts: the gate and compaction rows ravenseat appends to the time log (lib/timeLogRows.js).
//
// Locks: the task comes from a queue branch only, the attempt counts earlier runs of the same kind for the same task
// (or the same branch when the task is unknown), a timeout is marked, one track row per NEW compaction, and appendRows
// never throws. gates.mjs end to end is in gatePrecheck.test.ts, the hooks in contextGuardTrack.test.ts.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const TL = require('../timeLogRows.js') as {
  trackFromBranch: (branch: string | null, prefix?: string) => string | null;
  gateAttempt: (text: string | null, key: { kind: string; track?: string | null; branch?: string | null }) => number;
  gateRow: (r: Record<string, unknown>) => Record<string, unknown>;
  sessionCompactRow: (r: Record<string, unknown>) => Record<string, unknown>;
  trackCompactRows: (r: Record<string, unknown>) => Record<string, unknown>[];
  appendRows: (file: string, rows: unknown) => boolean;
};

const T = '2026-10-31T10:00:00.000Z';
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n');

describe('trackFromBranch', () => {
  it('takes the id after the prefix, nothing for other branches', () => {
    expect(TL.trackFromBranch('queue/AB-1')).toBe('AB-1');
    expect(TL.trackFromBranch('work/AB-1', 'work/')).toBe('AB-1');
    expect(TL.trackFromBranch('main')).toBeNull();
    expect(TL.trackFromBranch('queue/')).toBeNull();
    expect(TL.trackFromBranch(null)).toBeNull();
  });
});

describe('gateAttempt', () => {
  const log = jsonl([
    { event: 'start', agent_id: 'a', track: 'X' },
    { event: 'gate', kind: 'quick', track: 'X', branch: 'queue/X' },
    { event: 'gate', kind: 'quick', track: 'X', branch: 'main' },
    { event: 'gate', kind: 'full', track: 'X' },
    { event: 'gate', kind: 'quick', track: 'Y' },
    { event: 'gate', kind: 'quick', track: null, branch: 'main' },
  ]);
  it('counts earlier runs of the same kind for the same task, whatever the branch', () => {
    expect(TL.gateAttempt(log, { kind: 'quick', track: 'X' })).toBe(3);
    expect(TL.gateAttempt(log, { kind: 'full', track: 'X' })).toBe(2);
    expect(TL.gateAttempt(log, { kind: 'precheck', track: 'X' })).toBe(1);
  });
  it('without a task, counts runs on the same branch that had no task either', () => {
    expect(TL.gateAttempt(log, { kind: 'quick', track: null, branch: 'main' })).toBe(2);
    expect(TL.gateAttempt(log, { kind: 'quick', track: null, branch: 'dev' })).toBe(1);
  });
  it('no log or broken lines: the first attempt', () => {
    expect(TL.gateAttempt(null, { kind: 'quick', track: 'X' })).toBe(1);
    expect(TL.gateAttempt('{"event":"gate", broken\n', { kind: 'quick', track: 'X' })).toBe(1);
  });
});

describe('gateRow', () => {
  it('has the fixed fields, ok from the exit code, and timed_out only on a timeout', () => {
    const row = TL.gateRow({
      time: T,
      track: 'X',
      branch: 'queue/X',
      kind: 'precheck',
      gates: ['node --check', 'tsc'],
      failed: ['tsc'],
      durationSec: 12.345,
      exit: 3,
      timedOut: true,
      attempt: 2,
    });
    expect(row).toEqual({
      time: T,
      event: 'gate',
      track: 'X',
      branch: 'queue/X',
      kind: 'precheck',
      gates: ['node --check', 'tsc'],
      failed: ['tsc'],
      duration_s: 12.3,
      ok: false,
      exit: 3,
      attempt: 2,
      timed_out: true,
    });
    const green = TL.gateRow({ kind: 'quick', durationSec: 1, exit: 0 });
    expect(green).toMatchObject({ track: null, branch: null, gates: [], failed: [], ok: true, attempt: 1 });
    expect(green).not.toHaveProperty('timed_out');
  });
});

describe('compaction rows', () => {
  it('a session row says whether it is the bound orchestrator', () => {
    expect(TL.sessionCompactRow({ time: T, sessionId: 's1', orchestrator: true })).toEqual({
      time: T,
      event: 'compact',
      scope: 'session',
      session_id: 's1',
      orchestrator: true,
    });
    expect(TL.sessionCompactRow({ time: T, sessionId: 's2' }).orchestrator).toBe(false);
  });
  it('one track row per new compaction, none when the count did not rise', () => {
    const rows = TL.trackCompactRows({ time: T, agentId: 'a1', agentType: 'track', track: 'X', before: 1, after: 3 });
    expect(rows.map((r) => r.compactions)).toEqual([2, 3]);
    expect(rows[0]).toEqual({
      time: T,
      event: 'compact',
      scope: 'track',
      agent_id: 'a1',
      agent_type: 'track',
      track: 'X',
      compactions: 2,
    });
    expect(TL.trackCompactRows({ agentId: 'a1', before: 2, after: 2 })).toEqual([]);
    expect(TL.trackCompactRows({ agentId: 'a1', before: 3, after: 1 })).toEqual([]);
  });
});

describe('appendRows', () => {
  it('appends JSONL, creates the folder, and never throws', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-timelogrows-'));
    try {
      const file = path.join(folder, 'sub', 'times.jsonl');
      expect(TL.appendRows(file, [{ a: 1 }, { b: 2 }])).toBe(true);
      expect(TL.appendRows(file, { c: 3 })).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
      expect(TL.appendRows(file, [])).toBe(false);
      // A folder where the file should be: false, no exception.
      expect(TL.appendRows(folder, [{ a: 1 }])).toBe(false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
