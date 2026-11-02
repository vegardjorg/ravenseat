// =============================================================
// eventStatistics.test.ts: the views over the event rows (lib/eventStatistics.js): the cumulative session cost and
// the orchestration overhead, the flow figures (first pass, fix rounds, merge conflicts, base gate, pushes, triage) and
// the load history.
//
// Locks: growth per session from cumulative readings, with a restart and a window; the overhead minus the subagents
// the session started (from the transcript folders), the share and the per merged figure, other sessions apart; the
// flow figures from a queue and rows (fix tasks and external tasks are not merged changes, guard stops are not
// conflicts, a push logged twice counts once); the load counts and the latest stops.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ES = require('../eventStatistics.js');

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const session = (id: string, usd: number, ms: number, orchestrator = true) => ({
  time: at(ms),
  event: 'session',
  session_id: id,
  usd,
  orchestrator,
});

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('session cost and the orchestration overhead', () => {
  it('sessionCosts: growth per session, a restart counts from 0, and only the growth inside the window', () => {
    const rows = [
      session('S', 1, 0),
      session('S', 3, 1000),
      session('S', 0.5, 2000), // the counter started over
      session('S', 2, 3000),
      session('O', 4, 1000, false),
      { time: at(1000), event: 'done', usd: 99 },
    ];
    const all = ES.sessionCosts(rows);
    expect(all).toEqual([
      { session_id: 'S', usd: 5, orchestrator: true, readings: 4, last_usd: 2 }, // 1 + 2 + 0.5 + 1.5
      { session_id: 'O', usd: 4, orchestrator: false, readings: 1, last_usd: 4 },
    ]);
    // The window [1500, 3500): the restart (0.5) and the growth to 2 (1.5).
    expect(ES.sessionCosts(rows, { from: T0 + 1500, to: T0 + 3500 })).toEqual([
      { session_id: 'S', usd: 2, orchestrator: true, readings: 2, last_usd: 2 },
    ]);
  });

  it('orchestrationOverhead subtracts the subagents the session started, and readAgentsBySession finds them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-stat-'));
    temporary.push(dir);
    fs.mkdirSync(path.join(dir, 'S', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'S', 'subagents', 'agent-a1.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'S', 'subagents', 'notes.txt'), '');
    const agents = ES.readAgentsBySession(dir, ['S', 'O']);
    expect([...agents.get('S')]).toEqual(['a1']);
    expect(agents.get('O').size).toBe(0);

    const rows = [session('S', 2, 0), session('S', 10, DAY), session('O', 3, DAY, false)];
    const events = [
      { agent: 'a1', time: at(DAY / 2), usd: 6 },
      { agent: 'a1', time: at(-DAY), usd: 100 }, // outside the window
      { agent: 'zz', time: at(DAY / 2), usd: 50 }, // not the session's
    ];
    const o = ES.orchestrationOverhead({ rows, events, from: T0 - 1, to: T0 + 2 * DAY, merged: 4, trackUsd: 12, agentsBySession: agents });
    expect(o).toMatchObject({
      sessions: 1,
      gross_usd: 10,
      subagent_usd: 6,
      usd: 4,
      usd_per_merged: 1,
      share_pct: 25,
      subagents_known: true,
      other: { sessions: 1, gross_usd: 3, subagent_usd: 0, usd: 3 },
    });
    const text = ES.overheadLines(o, 'last 28 days').join('\n');
    expect(text).toContain('Orchestration overhead (last 28 days): $4.00 in 1 orchestrator session(s) = $1.00 per merged change, 25 % of track cost + overhead');
    expect(text).toContain('minus $6.00 for the subagents');
    expect(text).toContain('other main sessions');
    // Without rows: the line says how to get them.
    const none = ES.orchestrationOverhead({ rows: [], from: 0, to: 1 });
    expect(none).toMatchObject({ sessions: 0, usd: 0, usd_per_merged: null, share_pct: null });
    expect(ES.overheadLines(none, 'x')[0]).toContain('no session cost recorded');
  });
});

describe('flow figures', () => {
  it('flowStatistics: first pass, fix rounds, conflicts, base gate, pushes and triage in the window', () => {
    const done = at(DAY);
    const queue = {
      tasks: [
        { id: 'A', status: 'done', done, resumed: [] },
        { id: 'B', status: 'done', done, resumed: [{ reason: 'fix' }, { reason: 'context' }, { reason: 'fix' }] },
        { id: 'C', status: 'done', done },
        { id: 'B-FIX', status: 'done', done, fixes: ['B'] }, // a fix task is no merged change
        { id: 'X', status: 'done', done, external: true },
        { id: 'OLD', status: 'done', done: at(-10 * DAY) },
        { id: 'R', status: 'running' },
      ],
    };
    const rows = [
      { time: at(DAY), event: 'fixRound', task: 'B', reason: 'fix' },
      { time: at(DAY), event: 'fixRound', task: 'B', reason: 'context' },
      { time: at(DAY), event: 'mergeConflict', task: 'B', files: 2 },
      { time: at(DAY), event: 'mergeConflict', task: 'C', files: null, guard: true },
      { time: at(DAY), event: 'baseGate', tip: 't1', ok: true, skipped: null, duration_s: 10 },
      { time: at(DAY), event: 'baseGate', tip: 't2', ok: false, skipped: null, duration_s: 30 },
      { time: at(DAY), event: 'baseGate', tip: 't2', ok: false, skipped: null, duration_s: 20 },
      { time: at(DAY), event: 'baseGate', tip: 't3', ok: true, skipped: 'track-gate', duration_s: null },
      { time: at(DAY), event: 'push', tip: 'p1', task_count: 2, commits: 4, base_health: 'green' },
      { time: at(DAY), event: 'push', tip: 'p1', task_count: 2, commits: 4, base_health: 'green' }, // logged twice
      { time: at(2 * DAY), event: 'push', tip: 'p2', task_count: 1, commits: 1, base_health: 'red' },
      { time: at(DAY), event: 'triage', task: 'T', verdict: 'ready' },
      { time: at(DAY), event: 'triage', task: 'U', verdict: 'ready' },
      { time: at(DAY), event: 'triage', task: 'V', verdict: 'stale' },
      { time: at(-20 * DAY), event: 'mergeConflict', task: 'Z', files: 1 }, // outside the window
    ];
    const f = ES.flowStatistics(queue, rows, { from: T0, to: T0 + 14 * DAY });
    expect(f.firstPass).toEqual({ merged: 3, first_pass: 2, rate_pct: 66.7 });
    expect(f.fixRounds).toEqual({ per_task: 0.67, started: 1, continuations: 1 });
    expect(f.mergeConflicts).toEqual({ count: 1, per_week: 0.5, files: 2, guard_stops: 1 });
    expect(f.baseGate).toEqual({ verdicts: 4, skipped: 1, red: 2, red_tips: 1, median_s: 20 });
    expect(f.pushes).toEqual({ count: 2, per_week: 1, tasks_per_push: 1.5, max_tasks: 2, commits_per_push: 2.5, red_tip: 1 });
    expect(f.triage).toEqual({ ready: 2, stale: 1 });
    const text = ES.flowLines(f, 'last 14 days').join('\n');
    expect(text).toContain('first pass: 2 of 3 merged with 0 fix rounds (66.7 %)');
    expect(text).toContain('merge conflicts: 1 (0.5 per week, 2 file(s)); merge guard stops 1');
    expect(text).toContain('triage verdicts: ready 2, stale 1');
    // Nothing in the window: no division by zero.
    const empty = ES.flowStatistics({ tasks: [] }, [], { from: T0, to: T0 + DAY });
    expect(empty.firstPass.rate_pct).toBeNull();
    expect(empty.fixRounds.per_task).toBeNull();
    expect(empty.pushes.tasks_per_push).toBeNull();
  });
});

describe('load history', () => {
  it('loadStatistics counts the limits by reason, the stops, the overrides and the latest stops first', () => {
    const load = (ms: number, x: Record<string, unknown>) => ({
      time: at(ms),
      event: 'load',
      command: 'fill',
      free_memory_pct: 50,
      slots: 5,
      max_slots: 5,
      running: 1,
      limited_by: null,
      stopped: false,
      ...x,
    });
    const rows = [
      load(1, {}),
      load(2, { limited_by: 'memory', reason: 'free memory 20 %', slots: 2, free_memory_pct: 20 }),
      load(3, { limited_by: 'cpu', reason: 'cpu 95 %', slots: 3 }),
      load(4, { stopped: true, stop_reason: 'the machine is full: free memory 4 %', free_memory_pct: 4, command: 'start' }),
      load(5, { override: true, free_memory_pct: null }),
    ];
    const s = ES.loadStatistics(rows, { from: T0, to: T0 + DAY });
    expect(s).toMatchObject({ rows: 5, limited: 2, stopped: 1, override: 1, by: { memory: 1, cpu: 1 }, min_free_memory_pct: 4 });
    expect(s.recent.map((r: { reason: string }) => r.reason)).toEqual([
      'the machine is full: free memory 4 %',
      'cpu 95 %',
      'free memory 20 %',
    ]);
    const text = ES.loadLines(s, 'last 7 days').join('\n');
    expect(text).toContain('Load history (last 7 days): 5 fill/start, slots limited 2 (memory 1, cpu 1)');
    expect(text).toContain('stopped (machine full, exit 7) 1, guard skipped by the owner 1; lowest free memory 4 %');
    expect(text).toContain('start STOPPED: the machine is full');
    expect(ES.loadLines(ES.loadStatistics([], { from: 0, to: 1 }), 'x')[0]).toContain('no fill or start recorded yet');
  });
});
