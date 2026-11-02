// =============================================================
// eventRows.test.ts: the row builders and pure helpers in lib/eventRows.js (the flow, load, push and session rows).
//
// Locks: the conflict count from merge-track.mjs and plain git output; the load row's limit and stop fields; the session
// throttle (first reading, the $0.50 step, the 10-minute step, a restart, no growth); the state prune; the reflog parse
// and the pushes taken from it (only "update by push", oldest first, the first entry skipped). The CLI side (the moment
// each row is written) is in __tests__/eventRowsCli.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ER = require('../eventRows.js');

describe('flow and load rows', () => {
  it('conflictFiles reads merge-track.mjs and plain git output', () => {
    expect(ER.conflictFiles('Merging...\nConflicts in 3 files.\n')).toBe(3);
    expect(ER.conflictFiles('Conflicts in 1 file.')).toBe(1);
    expect(ER.conflictFiles('No conflicts.\nThe branch is not a queue branch')).toBe(0);
    expect(ER.conflictFiles('CONFLICT (content): Merge conflict in a\nCONFLICT (add/add): Merge conflict in b\n')).toBe(2);
    expect(ER.conflictFiles('fatal: not something we can merge')).toBeNull();
    expect(ER.conflictFiles(undefined)).toBeNull();
  });

  it('the builders keep only the fields the views need', () => {
    expect(ER.fixRoundRow({ time: 0, task: 'A', reason: 'fix', round: 2 })).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      event: 'fixRound',
      task: 'A',
      reason: 'fix',
      round: 2,
    });
    expect(ER.mergeConflictRow({ task: 'A', files: 2, branch: 'queue/A', guard: true })).toMatchObject({ files: 2, guard: true });
    expect(ER.mergeConflictRow({ task: 'A', files: null })).not.toHaveProperty('guard');
    expect(
      ER.baseGateRow({ tip: 'abc', ok: false, run: { durationSec: 12.34 }, madeRedBy: { task: 'B' }, fixTask: 'B-BASE1' }),
    ).toMatchObject({ event: 'baseGate', tip: 'abc', ok: false, duration_s: 12.3, made_red_by: 'B', fix_task: 'B-BASE1' });
    expect(ER.baseGateRow({ tip: 'abc', ok: true, skipped: 'track-gate' })).toMatchObject({ ok: true, duration_s: null, skipped: 'track-gate' });
    expect(ER.triageRow({ task: 'T', verdict: 'stale' })).not.toHaveProperty('by');
  });

  it('loadRow: the limit only when the slots were limited, the stop reason only on a stop', () => {
    const free = ER.loadRow({
      command: 'fill',
      load: { freeMemoryPct: 55, cpuPct: 20 },
      slots: { slots: 5, max: 5, limited: false },
      guard: { active: true, stop: false },
      running: 2,
    });
    expect(free).toMatchObject({ free_memory_pct: 55, cpu_pct: 20, slots: 5, max_slots: 5, running: 2, limited_by: null, stopped: false });
    expect(free).not.toHaveProperty('stop_reason');
    const limited = ER.loadRow({
      command: 'start',
      load: { freeMemoryPct: 18, cpuPct: null },
      slots: { slots: 2, max: 5, limited: true, by: 'memory', reason: 'free memory 18 %' },
      guard: { active: true, stop: true, summary: 'the machine is full: free memory 8 %' },
      running: 0,
    });
    expect(limited).toMatchObject({ limited_by: 'memory', reason: 'free memory 18 %', stopped: true, stop_reason: 'the machine is full: free memory 8 %' });
    expect(ER.loadRow({ command: 'fill', load: null, slots: null, guard: null, running: 0, override: true })).toMatchObject({
      override: true,
      free_memory_pct: null,
      slots: null,
    });
  });
});

describe('session cost', () => {
  const T0 = Date.parse('2026-03-01T10:00:00.000Z');
  const input = (usd: number | null, id: string | null = 'S') => ({
    session_id: id,
    cost: { total_cost_usd: usd, total_duration_ms: 90_400 },
    context_window: { total_input_tokens: 5000 },
    model: { id: 'm' },
  });

  it('sessionReading needs a session id and a cost', () => {
    expect(ER.sessionReading(input(1.234), T0)).toMatchObject({ session_id: 'S', usd: 1.23, duration_s: 90, context_tokens: 5000, model: 'm' });
    expect(ER.sessionReading(input(null), T0)).toBeNull();
    expect(ER.sessionReading(input(1, null), T0)).toBeNull();
    expect(ER.sessionReading({}, T0)).toBeNull();
  });

  it('sessionDecision: first reading, the $0.50 step, the 10-minute step, a restart and no growth', () => {
    const r = (usd: number, at = T0) => ER.sessionReading(input(usd), at);
    expect(ER.sessionDecision(undefined, r(0))).toEqual({ log: false, save: true });
    expect(ER.sessionDecision(undefined, r(0.2))).toEqual({ log: true, save: true });
    const prev = { usd: 1, logged_usd: 1, logged_at: new Date(T0).toISOString() };
    expect(ER.sessionDecision(prev, r(1.3), T0 + 60_000)).toEqual({ log: false, save: true });
    expect(ER.sessionDecision(prev, r(1.5), T0 + 60_000)).toEqual({ log: true, save: true });
    expect(ER.sessionDecision(prev, r(1.01), T0 + 10 * 60_000)).toEqual({ log: true, save: true });
    expect(ER.sessionDecision(prev, r(1), T0 + 60 * 60_000)).toEqual({ log: false, save: false });
    expect(ER.sessionDecision(prev, r(0.1), T0 + 60_000)).toEqual({ log: true, save: true });
    expect(ER.sessionDecision(prev, null)).toEqual({ log: false, save: false });
  });

  it('withSession keeps the logged figure until a row is written, and prunes to the most recent sessions', () => {
    const r = (id: string, usd: number, at: number) => ER.sessionReading(input(usd, id), at);
    let state = ER.withSession({ sessions: {} }, r('S', 1, T0), { logged: true });
    state = ER.withSession(state, r('S', 1.2, T0 + 1000));
    expect(state.sessions.S).toMatchObject({ usd: 1.2, logged_usd: 1, logged_at: new Date(T0).toISOString() });
    for (let i = 0; i < ER.SESSION_KEEP + 5; i++) state = ER.withSession(state, r(`X${i}`, 1, T0 + 2000 + i));
    expect(Object.keys(state.sessions)).toHaveLength(ER.SESSION_KEEP);
    expect(state.sessions.S).toBeUndefined();
    expect(ER.sessionRowFromState(state, 'X44', { trigger: 'end', orchestrator: true })).toMatchObject({
      event: 'session',
      session_id: 'X44',
      usd: 1,
      trigger: 'end',
      orchestrator: true,
    });
    expect(ER.sessionRowFromState(state, 'nope', { trigger: 'end' })).toBeNull();
    expect(ER.readSessionState('/does/not/exist.json')).toEqual({ sessions: {} });
  });
});

describe('pushes from the reflog', () => {
  const US = String.fromCharCode(0x1f);
  const line = (sha: string, subject: string, sec: number) => `${sha}${US}${subject}${US}refs/remotes/origin/main@{${sec}}`;

  it('parseReflog and pushesFromReflog: only "update by push", oldest first, the first entry skipped', () => {
    // Newest first, as git prints it.
    const out = [
      line('c3', 'update by push', 300),
      line('c2', 'fetch: fast-forward', 200),
      line('c1', 'update by push', 100),
      line('c0', 'update by push', 50),
      'garbage line',
    ].join('\r\n');
    const entries = ER.parseReflog(out);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ sha: 'c3', subject: 'update by push', time: 300_000 });
    // c0 has no older entry: its batch is unknown, so it is skipped.
    expect(ER.pushesFromReflog(entries)).toEqual([
      { from: 'c0', tip: 'c1', time: 100_000 },
      { from: 'c2', tip: 'c3', time: 300_000 },
    ]);
    expect(ER.pushesFromReflog(entries, { since: 100_000 })).toEqual([{ from: 'c2', tip: 'c3', time: 300_000 }]);
    const row = ER.pushRow({
      time: 300_000,
      detectedAt: 400_000,
      remote: 'origin',
      branch: 'main',
      from: 'c2',
      tip: 'c3',
      batch: { tasks: ['A', 'B'], taskCount: 2, commits: 5 },
      health: 'green',
    });
    expect(row).toMatchObject({ event: 'push', task_count: 2, commits: 5, base_health: 'green', tasks: ['A', 'B'] });
    expect(ER.pushRow({ time: 1, remote: 'o', branch: 'b', from: 'x', tip: 'y', batch: null })).toMatchObject({
      task_count: 0,
      commits: null,
      base_health: 'unknown',
    });
  });
});
