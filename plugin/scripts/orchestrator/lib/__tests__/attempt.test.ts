// =============================================================
// attempt.test.ts: the pure rules of the attempt model (lib/logic/attempt.js) and the attempt folder rule in
// findTrackReport (lib/logic/resume.js). The command flow through real processes is in __tests__/queueAttempt.test.ts.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Row = Record<string, unknown>;
type Attempt = Record<string, unknown> & { id: string; state: string; round: number };
/* eslint-disable @typescript-eslint/no-require-imports */
const AT = require('../logic/attempt.js') as {
  DEFAULT_RESERVATION_TTL_MIN: number;
  CLOSE_OUTCOMES: string[];
  reservationTtlMin: (config: unknown) => number;
  guardFor: (capabilities: unknown) => { sandbox: boolean; network: string; hooks: boolean };
  current: (o: unknown) => Attempt | null;
  isExpired: (x: Attempt, o: { now: number; ttlMin?: number }) => boolean;
  shownState: (x: Attempt, o: { now: number; ttlMin?: number }) => string;
  startBlock: (attempts: Attempt[] | undefined) => Attempt | null;
  reserve: (attempts: Attempt[] | undefined, o: Row) => { attempts: Attempt[]; attempt?: Attempt; created?: boolean; blocked?: Attempt };
  deriveRunning: (attempts: Attempt[] | undefined, rows: Row[], o: { taskId: string }) => { attempts: Attempt[]; changed: boolean };
  relabelRows: (rows: Row[], lookup: (agent: string) => string | null, o: { from: number }) => Row[];
  close: (attempts: Attempt[], o: Row) => { attempts?: Attempt[]; closed?: Attempt; error?: string };
  receiveOutcome: (o: Row) => string;
  recordReceive: (attempts: Attempt[] | undefined, o: Row) => Attempt[] | undefined;
};
const R = require('../logic/resume.js') as {
  findTrackReport: (
    id: string,
    roots: string[],
    fsx?: unknown,
    pathx?: unknown,
    attempt?: unknown,
  ) => { report: { path: string; round: number } | null; handover: { path: string } | null; nextRound: number };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const T0 = '2026-11-03T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const CAPS = { sandbox: false, resume: true, usage: true, hooks: true, cloud: true, structuredOutput: false };
const base = { client: 'x', role: 'track', round: 0, baseSha: 'abc', now: T0, capabilities: CAPS, scratch: '/s', taskId: 'A' };
const reserved = (over: Row = {}) => AT.reserve([], { ...base, ...over }).attempts;
const startRow = (min: number, over: Row = {}) => ({ time: at(min), track: 'A', event: 'start', agent_id: 'ag1', agent_type: 'track', ...over });
const doneRow = (min: number, over: Row = {}) => ({ ...startRow(min), event: 'done', ...over });

const temporary: string[] = [];
afterAll(() => temporary.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('reserve', () => {
  it('builds the attempt: reserved, with base, round and a guard from the capabilities', () => {
    const r = AT.reserve(undefined, base);
    expect(r.created).toBe(true);
    expect(r.attempt).toEqual({
      id: 'a1',
      client: 'x',
      role: 'track',
      round: 0,
      state: 'reserved',
      reserved: T0,
      base_sha: 'abc',
      guard: { sandbox: false, network: 'hook', hooks: true },
      artifacts: { report: null, handover: null },
    });
  });

  it('the guard comes from capabilities, never from the client name', () => {
    expect(AT.guardFor({ sandbox: true, hooks: false })).toEqual({ sandbox: true, network: 'sandbox', hooks: false });
    expect(AT.guardFor({ sandbox: false, hooks: false })).toEqual({ sandbox: false, network: 'none', hooks: false });
    expect(AT.guardFor(undefined)).toEqual({ sandbox: false, network: 'none', hooks: false });
  });

  it('names an attempt folder only for a client that declares it', () => {
    const own = AT.reserve([], { ...base, capabilities: { ...CAPS, attemptFolder: true } }).attempt!;
    expect(own.artifacts).toEqual({
      report: path.join('/s', 'A', 'a1', 'track-result.md'),
      handover: path.join('/s', 'A', 'a1', 'handover.md'),
    });
    // No scratchpad: no folder to name, so the fallback rule applies.
    expect(AT.reserve([], { ...base, scratch: null, capabilities: { ...CAPS, attemptFolder: true } }).attempt!.artifacts).toEqual({
      report: null,
      handover: null,
    });
  });

  it('a fresh reservation for the same round is reused, so two starts give one attempt', () => {
    const first = reserved();
    const again = AT.reserve(first, { ...base, now: at(5) });
    expect(again.created).toBe(false);
    expect(again.attempt!.id).toBe('a1');
    expect(again.attempts).toHaveLength(1);
  });

  it('an expired reservation is closed and does not block', () => {
    const r = AT.reserve(reserved(), { ...base, now: at(31) });
    expect(r.created).toBe(true);
    expect(r.attempts.map((x) => [x.id, x.state, x.outcome])).toEqual([
      ['a1', 'ended', 'expired'],
      ['a2', 'reserved', undefined],
    ]);
  });

  it('a fresh reservation for another round is superseded and does not block', () => {
    const r = AT.reserve(reserved(), { ...base, round: 1, now: at(1) });
    expect(r.attempts.map((x) => [x.id, x.state, x.outcome, x.round])).toEqual([
      ['a1', 'ended', 'superseded', 0],
      ['a2', 'reserved', undefined, 1],
    ]);
  });

  it('a running attempt blocks until it is closed; the numbers never reuse a closed one', () => {
    const running = AT.deriveRunning(reserved(), [startRow(1)], { taskId: 'A' }).attempts;
    const r = AT.reserve(running, { ...base, now: at(90) });
    expect(r.blocked?.id).toBe('a1');
    expect(r.attempts).toBe(running);
    const closed = AT.close(running, { outcome: 'interrupted', now: at(91) }).attempts!;
    expect(AT.startBlock(closed)).toBeNull();
    expect(AT.reserve(closed, { ...base, now: at(92) }).attempt!.id).toBe('a2');
  });
});

describe('the reservation TTL', () => {
  it('reads as expired after the bound, and only a reservation', () => {
    const x = reserved()[0];
    expect(AT.isExpired(x, { now: Date.parse(at(29)) })).toBe(false);
    expect(AT.isExpired(x, { now: Date.parse(at(31)) })).toBe(true);
    expect(AT.isExpired(x, { now: Date.parse(at(6)), ttlMin: 5 })).toBe(true);
    expect(AT.shownState(x, { now: Date.parse(at(31)) })).toBe('expired');
    const running = AT.deriveRunning([x], [startRow(1)], { taskId: 'A' }).attempts[0];
    expect(AT.isExpired(running, { now: Date.parse(at(999)) })).toBe(false);
    expect(AT.shownState(running, { now: Date.parse(at(999)) })).toBe('running');
  });

  it('takes the bound from the config, the default for anything unusable', () => {
    expect(AT.reservationTtlMin({ attempts: { reservationTtlMin: 5 } })).toBe(5);
    for (const bad of [undefined, {}, { attempts: { reservationTtlMin: 0 } }, { attempts: { reservationTtlMin: 'x' } }])
      expect(AT.reservationTtlMin(bad)).toBe(AT.DEFAULT_RESERVATION_TTL_MIN);
  });
});

describe('deriveRunning (rows and attempts in, attempts out)', () => {
  it('a start row with the track label turns reserved into running', () => {
    const r = AT.deriveRunning(reserved(), [startRow(1)], { taskId: 'A' });
    expect(r.changed).toBe(true);
    expect(r.attempts[0]).toMatchObject({ state: 'running', started: at(1), session_id: 'ag1' });
  });

  it('a late start still counts: expiry is a reading, never a stored state', () => {
    expect(AT.deriveRunning(reserved(), [startRow(45)], { taskId: 'A' }).attempts[0].state).toBe('running');
  });

  it('leaves the input alone and reports no change without a matching row', () => {
    const list = reserved();
    const copy = JSON.parse(JSON.stringify(list));
    for (const rows of [
      [],
      [startRow(1, { track: 'B' })], // another task
      [startRow(1, { track: 'A-r1' })], // another round
      [startRow(-5)], // an earlier agent, from before the reservation
      [startRow(1, { agent_type: 'reviewer' })], // a reviewer's label is the task id too
      [startRow(1, { agent_id: null })],
      [{ time: at(1), track: 'A', event: 'gate', kind: 'quick' }], // a gate row proves nothing
    ]) {
      const r = AT.deriveRunning(list, rows, { taskId: 'A' });
      expect(r.changed).toBe(false);
      expect(r.attempts).toBe(list);
    }
    expect(list).toEqual(copy);
  });

  it('a fix round matches its own label', () => {
    const list = reserved({ round: 2 });
    expect(AT.deriveRunning(list, [startRow(1)], { taskId: 'A' }).changed).toBe(false);
    expect(AT.deriveRunning(list, [startRow(1, { track: 'A-r2' })], { taskId: 'A' }).attempts[0].state).toBe('running');
  });

  it('a start row without a label joins through the same agent\'s labelled done row', () => {
    const r = AT.deriveRunning(reserved(), [startRow(1, { track: 'ag1' }), doneRow(9)], { taskId: 'A' });
    expect(r.attempts[0]).toMatchObject({ state: 'ended', started: at(1), ended: at(9), outcome: 'stopped' });
  });

  it('a done row closes the attempt: the agent stopped, so nothing is running any more', () => {
    const r = AT.deriveRunning(reserved(), [startRow(1), doneRow(9)], { taskId: 'A' }).attempts[0];
    expect(r).toMatchObject({ state: 'ended', ended: at(9), outcome: 'stopped' });
    expect(AT.startBlock([r])).toBeNull();
    const killed = AT.deriveRunning(reserved(), [startRow(1), doneRow(9, { killed: true })], { taskId: 'A' }).attempts[0];
    expect(killed.outcome).toBe('interrupted');
  });

  it('a stopped agent that starts again is running, also from a persisted running attempt', () => {
    const rows = [startRow(1), doneRow(5), startRow(6)];
    expect(AT.deriveRunning(reserved(), rows, { taskId: 'A' }).attempts[0].state).toBe('running');
    const running = AT.deriveRunning(reserved(), [startRow(1)], { taskId: 'A' });
    expect(AT.deriveRunning(running.attempts, [startRow(1)], { taskId: 'A' }).changed).toBe(false);
  });

  it('never reopens an ended attempt', () => {
    const closed = AT.close(reserved(), { outcome: 'abandoned', now: at(1) }).attempts!;
    expect(AT.deriveRunning(closed, [startRow(2)], { taskId: 'A' }).changed).toBe(false);
  });
});

describe('relabelRows', () => {
  it('fills in the label of an unlabelled build agent from the lookup, only inside the window', () => {
    const asked: string[] = [];
    const rows = [
      startRow(-10, { track: 'old', agent_id: 'old1' }), // before the window
      startRow(1, { track: 'ag1' }), // the label is the agent id prefix: unknown
      startRow(1, { track: null, agent_id: 'ag2' }),
      startRow(1, { track: 'rev', agent_id: 'rev1', agent_type: 'reviewer' }), // not a build agent
      startRow(1, { track: 'B', agent_id: 'b1' }), // already labelled
    ];
    const out = AT.relabelRows(rows, (agent) => (asked.push(agent), agent === 'ag1' ? 'A' : null), { from: Date.parse(T0) });
    expect(asked).toEqual(['ag1', 'ag2']);
    expect(out.map((x) => x.track)).toEqual(['old', 'A', null, 'rev', 'B']);
    expect(rows[1].track).toBe('ag1');
  });
});

describe('close', () => {
  it('closes the open attempt with a known outcome', () => {
    const r = AT.close(reserved(), { outcome: 'abandoned', now: at(2) });
    expect(r.closed).toMatchObject({ id: 'a1', state: 'ended', ended: at(2), outcome: 'abandoned' });
    expect(AT.close(reserved(), { outcome: 'nope', now: at(2) }).error).toMatch(/--outcome/);
    expect(AT.close(r.attempts!, { outcome: 'failed', now: at(3) }).error).toMatch(/no open attempt/);
    expect(AT.close([], { outcome: 'failed', now: at(3) }).error).toMatch(/no open attempt/);
  });
});

describe('receive', () => {
  it('the outcome: red checks first, then the RESULT status, a missing line counts as delivered', () => {
    expect(AT.receiveOutcome({ status: 'DONE' })).toBe('delivered');
    expect(AT.receiveOutcome({ status: null })).toBe('delivered');
    expect(AT.receiveOutcome({ status: 'PARTIAL' })).toBe('partial');
    expect(AT.receiveOutcome({ status: 'BLOCKED' })).toBe('blocked');
    expect(AT.receiveOutcome({ status: 'DONE', doneRed: true })).toBe('done-red');
    expect(AT.receiveOutcome({ status: 'DONE', gateRed: true })).toBe('gate-red');
  });

  it('records sha, outcome, end and evidence on the current attempt; a new round adds evidence', () => {
    const one = AT.recordReceive(reserved(), { sha: 's1', outcome: 'gate-red', evidenceId: 'e1', now: at(3) })!;
    expect(one[0]).toMatchObject({ state: 'ended', delivered_sha: 's1', outcome: 'gate-red', ended: at(3), evidence: ['e1'] });
    const two = AT.recordReceive(one, { sha: 's2', outcome: 'delivered', evidenceId: 'e2', now: at(8) })!;
    expect(two[0]).toMatchObject({ delivered_sha: 's2', outcome: 'delivered', ended: at(3), evidence: ['e1', 'e2'] });
    const same = AT.recordReceive(two, { sha: 's2', outcome: 'delivered', evidenceId: 'e2', now: at(9) })!;
    expect(same[0].evidence).toEqual(['e1', 'e2']);
  });

  it('writes no evidence field without an id, and nothing at all for a task without attempts', () => {
    const r = AT.recordReceive(reserved(), { sha: 's1', outcome: 'partial', now: at(3) })!;
    expect(r[0]).not.toHaveProperty('evidence');
    expect(AT.recordReceive(undefined, { sha: 's', outcome: 'delivered', now: at(1) })).toBeUndefined();
    expect(AT.recordReceive([], { sha: 's', outcome: 'delivered', now: at(1) })).toEqual([]);
  });

  it('records the files receive actually read, also for an attempt that named no folder', () => {
    const r = AT.recordReceive(reserved(), { sha: 's', outcome: 'delivered', now: at(1), report: '/r.md', handover: null })!;
    expect(r[0].artifacts).toEqual({ report: '/r.md', handover: null });
  });
});

describe('findTrackReport and the attempt folder', () => {
  /** A scratchpad with `files` relative to it, each with its own age in seconds (a higher age is older). */
  function scratch(files: Record<string, number>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-attempt-'));
    temporary.push(root);
    const now = Date.now() / 1000;
    for (const [file, age] of Object.entries(files)) {
      const p = path.join(root, file);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `RESULT status=DONE ${file}\n`);
      fs.utimesSync(p, now - age, now - age);
    }
    return root;
  }
  const withFolder = (root: string, n: string, round = 0) => ({
    id: n,
    round,
    artifacts: { report: path.join(root, 'A', n, 'track-result.md'), handover: path.join(root, 'A', n, 'handover.md') },
  });

  it('an old report is not accepted for a new attempt that has a folder, however new its mtime', () => {
    const root = scratch({ 'A/track-result.md': 0, 'A/handover.md': 0, 'A-r1/track-result.md': 0 });
    const r = R.findTrackReport('A', [root], undefined, undefined, withFolder(root, 'a2', 2));
    expect(r.report).toBeNull();
    expect(r.handover).toBeNull();
    expect(r.nextRound).toBe(2);
  });

  it('nor one from an earlier attempt\'s folder', () => {
    const root = scratch({ 'A/a1/track-result.md': 0 });
    expect(R.findTrackReport('A', [root], undefined, undefined, withFolder(root, 'a2')).report).toBeNull();
  });

  it('prefers the attempt\'s folder over a newer file elsewhere', () => {
    const root = scratch({ 'A/a2/track-result.md': 100, 'A/a2/handover.md': 100, 'A/track-result.md': 0 });
    const r = R.findTrackReport('A', [root], undefined, undefined, withFolder(root, 'a2', 3));
    expect(r.report?.path).toBe(path.join(root, 'A', 'a2', 'track-result.md'));
    expect(r.report?.round).toBe(3);
    expect(r.handover?.path).toBe(path.join(root, 'A', 'a2', 'handover.md'));
  });

  it('falls back to the mtime rule without an attempt, or with one that names no folder (today\'s flow)', () => {
    const root = scratch({ 'A/track-result.md': 100, 'A-r1/track-result.md': 0 });
    for (const attempt of [undefined, null, { id: 'a1', artifacts: { report: null, handover: null } }, { id: 'a1' }]) {
      const r = R.findTrackReport('A', [root], undefined, undefined, attempt);
      expect(r.report?.path).toBe(path.join(root, 'A-r1', 'track-result.md'));
      expect(r.report?.round).toBe(1);
      expect(r.nextRound).toBe(2);
    }
  });
});

describe('the module stays pure', () => {
  it('has no file system, no exit and no client name in it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'logic', 'attempt.js'), 'utf8');
    expect(src).not.toMatch(/require\(['"](?:node:)?fs['"]\)/);
    expect(src).not.toMatch(/process\.exit/);
    expect(src).not.toMatch(/['"`](?:claude|codex|antigravity)['"`]/i);
    expect(src).not.toContain('\u2014');
  });
});
