// =============================================================
// ravenseatRows.test.ts: the rows ravenseat itself writes for the benchmark (plugin/scripts/orchestrator/lib/timeLogRows.js) and the
// task field `fixes`, read by bench/lib/collect.js and counted by bench/lib/metrics.js and report.js.
//   - one "gate" row per gates.mjs run: kind, ok, attempt (attempt > 1 is a rerun), timed_out
//   - "compact" rows: scope "session" (one per compaction; orchestrator true marks the bound orchestrator) and scope
//     "track" (the running count per agent)
//   - `fixes`: a merged task named by a later task is a defect after merge, whatever the window
// All data is synthetic (fixtures.ts). Hand-computed expectations are in the comments.
// =============================================================
import { describe, it, expect } from 'vitest';
import * as FX from './fixtures';

const C = require('../lib/collect.js') as Record<string, any>;
const M = require('../lib/metrics.js') as Record<string, any>;
const R = require('../lib/report.js') as Record<string, any>;

/** ravenseat's gate and compaction rows (English, as gates.mjs and the hooks write them). */
function ravenseatRows() {
  const gate = (min: number, track: string, kind: string, attempt: number, ok: boolean, extra = {}) => ({
    time: FX.at(min),
    event: 'gate',
    track,
    branch: `queue/${track}`,
    kind,
    gates: ['npm test'],
    failed: ok ? [] : ['npm test'],
    duration_s: 100 * attempt,
    ok,
    exit: ok ? 0 : 1,
    attempt,
    ...extra,
  });
  return [
    // X-1: a red quick run, its rerun (green) and a precheck that timed out -> 3 runs, 1 rerun, 1 timeout, 2 red
    gate(30, 'X-1', 'quick', 1, false),
    gate(35, 'X-1', 'quick', 2, true),
    gate(36, 'X-1', 'precheck', 1, false, { exit: 3, timed_out: true }),
    // X-2: one green full run
    gate(60, 'X-2', 'full', 1, true),
    // plan-1 (a main session with no compaction in its transcript) was compacted twice as the bound orchestrator
    { time: FX.at(510), event: 'compact', scope: 'session', session_id: 'plan-1', orchestrator: true },
    { time: FX.at(520), event: 'compact', scope: 'session', session_id: 'plan-1', orchestrator: true },
    // orch-1 already has a compact_boundary in its transcript: the log row is not counted again
    { time: FX.at(5), event: 'compact', scope: 'session', session_id: 'orch-1', orchestrator: false },
    // the X-1 track (a1) compacted twice: the running count, so its total is 2
    { time: FX.at(3), event: 'compact', scope: 'track', agent_id: 'a1', agent_type: 'track', track: 'X-1', compactions: 1 },
    { time: FX.at(4), event: 'compact', scope: 'track', agent_id: 'a1', agent_type: 'track', track: 'X-1', compactions: 2 },
  ];
}

/** The fixture queue plus fix tasks that use `fixes` (X-1 merged at 55, X-2 at 90). */
function queueWithFixes() {
  const q = FX.queue();
  for (const t of q.tasks) if (t.id === 'X-2-F1') (t as any).fixes = ['X-2']; // also an id match: counted once
  q.tasks.push(
    // added before X-2 was merged: not a defect after merge
    { id: 'W-1', class: 'K', content_min: 20, status: 'done', added: FX.at(80), fixes: ['X-2'] } as any,
    // ravenseat's added_at, inside the window
    { id: 'W-2', class: 'K', content_min: 20, status: 'waiting', added_at: FX.at(95), fixes: 'X-2' } as any,
    // long after the 14 day window: an explicit link still counts
    { id: 'Z-9', class: 'K', content_min: 20, status: 'waiting', added_at: FX.at(100_000), fixes: ['X-1'] } as any,
  );
  return q;
}

const records = () => {
  const files = FX.transcriptFiles();
  files.push({ id: 'plan-1', kind: 'main', parent: null, meta: null, text: FX.transcript(null, 1, { startMin: 500 }) });
  return C.build(FX.manifest(), {
    queue: queueWithFixes(),
    timeRows: C.readJsonl(ravenseatRows().map((r) => JSON.stringify(r)).join('\n')),
    transcripts: files.map((t) => ({ ...t, analysis: C.analyzeSession(t.text) })),
  });
};

describe('ravenseat gate rows', () => {
  it('parseTimeLog makes each one a gate run (rerun_nr = attempt - 1) and a step (for timeouts)', () => {
    const t = C.parseTimeLog(C.readJsonl(ravenseatRows().map((r) => JSON.stringify(r)).join('\n')));
    expect(t.gates).toHaveLength(4);
    expect(t.gates.map((g: any) => [g.track, g.mode, g.rerun_nr, g.green])).toEqual([
      ['X-1', 'quick', 0, false],
      ['X-1', 'quick', 1, true],
      ['X-1', 'precheck', 0, false],
      ['X-2', 'full', 0, true],
    ]);
    expect(t.gates[2]).toMatchObject({ timed_out: true, exit: 3, branch: 'queue/X-1' });
    expect(t.gateSteps.map((s: any) => [s.status, s.timeout])).toEqual([
      ['RED', false],
      ['GREEN', false],
      ['TIMEOUT', true],
      ['GREEN', false],
    ]);
    // An older single-step "gate" row (no kind/attempt) stays a step only.
    const old = C.parseTimeLog([{ time: FX.at(1), event: 'gate', track: 'X-1', gate: 'test', status: 'TIMEOUT' }]);
    expect(old.gates).toHaveLength(0);
    expect(old.gateSteps[0].timeout).toBe(true);
  });

  it('per task: gate runs and reruns; per arm: runs, reruns, red and timeouts', () => {
    const r = records();
    const c = M.taskCosts(r);
    expect(c.find((x: any) => x.id === 'X-1')).toMatchObject({ gate_runs: 3, gate_reruns: 1 });
    expect(c.find((x: any) => x.id === 'X-2')).toMatchObject({ gate_runs: 1, gate_reruns: 0 });
    expect(c.find((x: any) => x.id === 'Y-1')).toMatchObject({ gate_runs: 0, gate_reruns: 0 });
    const [ravenseat] = M.armSummary(r);
    // durations: 100 + 200 + 100 + 100; the rerun is the 200 s one
    expect(ravenseat.gates).toMatchObject({ runs: 4, reruns: 1, red: 2, timeouts: 1, gate_seconds: 500, rerun_seconds: 200 });
  });
});

describe('ravenseat compaction rows', () => {
  it('count for sessions whose transcript has none, never twice, and mark the bound orchestrator', () => {
    const r = M.taskCosts(records());
    const rec = records();
    const by = (id: string) => rec.sessions.find((s: any) => s.id === id);
    expect(by('plan-1')).toMatchObject({ compactions: 0, compactions_log: 2, session_type: 'orchestrator', arm: 'ravenseat' });
    expect(by('orch-1')).toMatchObject({ compactions: 1 });
    expect(by('orch-1').compactions_log).toBeUndefined();
    expect(by('a1')).toMatchObject({ compactions: 0, compactions_log: 2, task: 'X-1' });
    // per task: the X-1 track's 2; per arm: orch-1 1 + plan-1 2 + a1 2 = 5, of which 3 in orchestrator sessions
    expect(r.find((x: any) => x.id === 'X-1').compactions).toBe(2);
    const [ravenseat] = M.armSummary(rec);
    expect(ravenseat).toMatchObject({ compactions: 5, compactions_orchestrator: 3 });
  });
});

describe('fixes and defects after merge', () => {
  it('a later task naming a merged task in fixes is a defect, outside the window too; earlier ones are not', () => {
    const r = records();
    expect(r.queueTasks.find((q: any) => q.id === 'W-2')).toMatchObject({ fixes: ['X-2'], added: FX.at(95) });
    const d = M.defects(r);
    // X-2: X-2-F1 (id and link, counted once) and W-2; W-1 was added before the merge
    expect(d.get('X-2|ravenseat')).toEqual({ fixTasks: ['X-2-F1', 'W-2'], reverts: [], count: 2 });
    // X-1: OTHER (bug label on the same file, in the window) and Z-9 (explicit link, long after the window)
    expect(d.get('X-1|ravenseat')).toEqual({ fixTasks: ['OTHER', 'Z-9'], reverts: [], count: 2 });
    // A cancelled fix task does not count.
    r.queueTasks.find((q: any) => q.id === 'Z-9').status = 'cancelled';
    expect(M.defects(r).get('X-1|ravenseat').fixTasks).toEqual(['OTHER']);
  });

  it('fixesOf accepts one id or a list and ignores anything else', () => {
    expect(C.fixesOf({ fixes: 'A' })).toEqual(['A']);
    expect(C.fixesOf({ fixes: ['A', 3, '', 'B'] })).toEqual(['A', 'B']);
    expect(C.fixesOf({})).toEqual([]);
  });
});

describe('report', () => {
  it('shows gate runs, reruns and compactions per task, and orchestrator compactions per arm', () => {
    const md = R.render(records());
    expect(md).toContain('| Gate runs | Reruns | Compactions | Defects |');
    expect(md).toContain('Orchestrator compactions');
    expect(md).not.toMatch(/NaN|undefined/);
  });
});
