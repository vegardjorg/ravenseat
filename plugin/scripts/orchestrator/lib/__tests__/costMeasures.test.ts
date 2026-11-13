// =============================================================
// costMeasures.test.ts: the measurement additions to the cost (lib/costMeasures.js, lib/timeCost.js):
//   1. thinking tokens, output per turn, turns and the Claude Code version per agent (absent thinking = unknown, not 0),
//   2. the WARN at 2x an agent type's 14-day median per turn (a minimum n, measurement only),
//   3. the split into build, review and fix round (`<id>-rN`, and a continuation of the same agent after receive),
//   4. the per-task statistics by start date,
//   5. the cost breakdown: orchestrator line, the unknown share with its source, week over week.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../timeCost');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const C = require('../costMeasures');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic');

const T0 = Date.parse('2026-11-12T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const daysAgo = (d: number) => new Date(T0 - d * 86_400_000).toISOString();

/** A transcript line: an assistant turn with usage, optionally with the Claude Code version on the entry. */
const turn = (id: string, min: number, usage: object, version?: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(min),
    ...(version ? { version } : {}),
    message: { id, model: 'claude-opus-5-5', usage, content: [] },
  });

/** A done row in the time log (cumulative, as hook-time.mjs writes it). */
const done = (o: Record<string, unknown>) => ({
  event: 'done',
  cumulative: true,
  wave: 'w',
  model: 'claude-opus-5-5',
  ...o,
});

describe('1. thinking tokens, output per turn and the version per agent', () => {
  it('sums thinking_tokens from output_tokens_details and keeps the last version seen', () => {
    const text = [
      turn('m1', 0, { input_tokens: 1, output_tokens: 300, output_tokens_details: { thinking_tokens: 200 } }, '2.1.300'),
      // Streamed: the same message again, the last usage wins.
      turn('m1', 0.1, { input_tokens: 1, output_tokens: 400, output_tokens_details: { thinking_tokens: 250 } }, '2.1.300'),
      turn('m2', 1, { input_tokens: 1, output_tokens: 100, output_tokens_details: { thinking_tokens: 50 } }, '2.1.301'),
    ].join('\n');
    const a = T.analyzeTranscript(text);
    expect(a.thinking_tokens).toBe(300);
    expect(a.thinking_turns).toBe(2);
    expect(a.cc_version).toBe('2.1.301');
  });

  it('no thinking field anywhere means unknown (null), never 0; no version means null', () => {
    const a = T.analyzeTranscript(turn('m1', 0, { input_tokens: 1, output_tokens: 100 }));
    expect(a.thinking_tokens).toBeNull();
    expect(a.thinking_turns).toBe(0);
    expect(a.cc_version).toBeNull();
  });

  it('perTurn: output per turn, and thinking per turn over the turns that reported it', () => {
    expect(C.perTurn({ turns: 4, output: 1000, thinking_tokens: 300, thinking_turns: 3 })).toEqual({
      turns: 4,
      output_per_turn: 250,
      thinking_per_turn: 100,
    });
    // Unknown thinking stays unknown; no turns gives nothing to divide.
    expect(C.perTurn({ turns: 4, output: 1000, thinking_tokens: null })).toEqual({
      turns: 4,
      output_per_turn: 250,
      thinking_per_turn: null,
    });
    expect(C.perTurn({ turns: 0, output: 0 })).toEqual({ turns: 0, output_per_turn: null, thinking_per_turn: null });
  });

  it('sumCost stores turns, output per turn, thinking and the version per agent, and leaves unknowns out', () => {
    const k = L.sumCost([
      {
        agent: 'a',
        type: 'track',
        tokens: { output: 1200 },
        turns: 4,
        thinking_tokens: 400,
        thinking_turns: 4,
        cc_version: '2.1.301',
      },
      { agent: 'b', type: 'track', tokens: { output: 10 }, turns: 2 },
    ]);
    expect(k.agents[0]).toMatchObject({
      turns: 4,
      output_per_turn: 300,
      thinking_tokens: 400,
      thinking_per_turn: 100,
      cc_version: '2.1.301',
    });
    expect(k.agents[1]).toMatchObject({ turns: 2, output_per_turn: 5 });
    expect(k.agents[1]).not.toHaveProperty('thinking_tokens');
    expect(k.agents[1]).not.toHaveProperty('thinking_per_turn');
    expect(k.agents[1]).not.toHaveProperty('cc_version');
  });
});

describe('2. the WARN at 2x the 14-day median per turn', () => {
  // Six earlier track agents at 1,000 output and 400 thinking per turn (10 turns each).
  const baselineRows = [1, 2, 3, 4, 5, 6].map((d) =>
    done({
      time: daysAgo(d),
      agent_id: `old${d}`,
      agent_type: 'track',
      track: `T${d}`,
      modelTurns: 10,
      tokens: { input: 0, output: 10_000, cache_read: 0, cache_written: 0 },
      thinking_tokens: 4000,
      thinking_turns: 10,
    }),
  );

  it('the baseline is the median per agent type of the last row per agent, with n', () => {
    const stats = C.agentTurnStats(baselineRows, { from: T0 - 14 * 86_400_000, to: T0 });
    const b = C.turnBaseline(stats, { minN: 5 });
    expect(b.track).toMatchObject({ output: { n: 6, median: 1000 }, thinking: { n: 6, median: 400 } });
  });

  it('warns when output or thinking per turn is over 2x the median, and not under the minimum n', () => {
    const b = C.turnBaseline(C.agentTurnStats(baselineRows, { from: T0 - 14 * 86_400_000, to: T0 }), { minN: 5 });
    const w = C.turnWarnings(
      [
        { agent: 'new1', type: 'track', output_per_turn: 2500, thinking_per_turn: 900 },
        { agent: 'new2', type: 'track', output_per_turn: 1900, thinking_per_turn: null },
        { agent: 'new3', type: 'reviewer-tests', output_per_turn: 99_999, thinking_per_turn: 99_999 },
      ],
      b,
    );
    expect(w.map((x: { agent: string; metric: string }) => `${x.agent}:${x.metric}`)).toEqual([
      'new1:output',
      'new1:thinking',
    ]);
    expect(w[0]).toMatchObject({ type: 'track', value: 2500, median: 1000, n: 6, ratio: 2.5 });
    const lines = C.turnWarningLines(w);
    expect(lines[0]).toMatch(/^WARN: track new1 output per turn 2,500 is 2\.5x its 14-day median 1,000 \(n 6\)/);
    expect(lines.join('\n')).toMatch(/measurement only/);
    // Fewer than minN agents: no baseline, so no warning at all.
    const thin = C.turnBaseline(C.agentTurnStats(baselineRows.slice(0, 4), { from: 0, to: T0 }), { minN: 5 });
    expect(C.turnWarnings([{ agent: 'x', type: 'track', output_per_turn: 99_999, thinking_per_turn: null }], thin)).toEqual([]);
  });

  it('older rows without thinking count for the output baseline only; excluded agents are left out', () => {
    const rows = baselineRows.map((r) => {
      const { thinking_tokens: _a, thinking_turns: _b, ...rest } = r as Record<string, unknown>;
      return rest;
    });
    const b = C.turnBaseline(C.agentTurnStats(rows, { from: 0, to: T0, exclude: new Set(['old1']) }), { minN: 5 });
    expect(b.track.output.n).toBe(5);
    expect(b.track.thinking).toMatchObject({ n: 0, median: null });
  });

  it('turnCheck for ravenseat cost: the last 24 h against the 14 days before, with the versions seen', () => {
    const recent = [0, 1].map((h) =>
      done({
        time: new Date(T0 - h * 3_600_000).toISOString(),
        agent_id: `new${h}`,
        agent_type: 'track',
        track: `N${h}`,
        modelTurns: 10,
        tokens: { input: 0, output: 30_000, cache_read: 0, cache_written: 0 },
        thinking_tokens: 4000,
        thinking_turns: 10,
        cc_version: '2.1.320',
      }),
    );
    const c = C.turnCheck([...baselineRows, ...recent], { now: T0 + 1 });
    const track = c.perType.find((x: { type: string }) => x.type === 'track');
    expect(track).toMatchObject({ recent: { n: 2, output: 3000, thinking: 400 }, baseline: { output: { n: 6, median: 1000 } } });
    expect(c.warnings.map((w: { metric: string }) => w.metric)).toEqual(['output']);
    expect(c.versions).toEqual([{ version: '2.1.320', agents: 2 }]);
    const text = C.turnCheckLines(c).join('\n');
    expect(text).toMatch(/Per turn/);
    expect(text).toMatch(/WARN: track output per turn 3,000/);
    expect(text).toMatch(/2\.1\.320/);
  });
});

describe('3. build, review and fix round', () => {
  const isReviewer = (t: string) => t.startsWith('reviewer-');

  it('<id>-rN is a fix round, also -r1 next to the bare track agent; reviewers are review', () => {
    const p = C.costPhases({
      taskId: 'A-1',
      agents: [
        { agent: 'a0', type: 'track', usd: 5, track: 'A-1' },
        { agent: 'a1', type: 'track', usd: 2, track: 'A-1-r1' },
        { agent: 'a2', type: 'track', usd: 1, track: 'A-1-r2' },
        { agent: 'rv', type: 'reviewer-tests', usd: 0.5, track: 'A-1' },
      ],
      isReviewer,
    });
    expect(p.phases).toEqual({ build: 5, review: 0.5, fix: 3, fix_rounds: 2 });
    expect(p.perAgent.a1).toEqual({ phase: 'fix' });
  });

  it('a round that `resumed` records as a context continuation is build, not a fix round', () => {
    const p = C.costPhases({
      taskId: 'A-1',
      agents: [
        { agent: 'a0', type: 'track', usd: 5, track: 'A-1' },
        { agent: 'a1', type: 'track', usd: 2, track: 'A-1-r1' },
      ],
      resumed: [{ round: 1, reason: 'context' }],
      isReviewer,
    });
    expect(p.phases).toEqual({ build: 7, review: 0, fix: 0, fix_rounds: 0 });
  });

  it('the same agent continued after receive (SendMessage): the growth after t_receive is a fix round', () => {
    const rows = [
      done({ time: at(10), agent_id: 'a0', agent_type: 'track', track: 'A-1', tokens: { output: 200_000 }, modelTurns: 5 }),
      done({ time: at(30), agent_id: 'a0', agent_type: 'track', track: 'A-1', tokens: { output: 300_000 }, modelTurns: 8 }),
    ];
    const p = C.costPhases({
      taskId: 'A-1',
      // $6 in all: $4 at the first stop (200k output at $20/MTok), the rest after the receive at minute 20.
      agents: [{ agent: 'a0', type: 'track', usd: 6, track: 'A-1' }],
      tReceive: at(20),
      rows,
      isReviewer,
    });
    expect(p.phases).toEqual({ build: 4, review: 0, fix: 2, fix_rounds: 1 });
    expect(p.perAgent.a0).toEqual({ phase: 'build', fix_usd: 2 });
    // No stop before the receive: nothing to split, all build.
    const none = C.costPhases({
      taskId: 'A-1',
      agents: [{ agent: 'a0', type: 'track', usd: 6, track: 'A-1' }],
      tReceive: at(5),
      rows,
      isReviewer,
    });
    expect(none.phases).toEqual({ build: 6, review: 0, fix: 0, fix_rounds: 0 });
  });

  it('a fix round `resume` ran as a continuation (mode continue) is the growth after t_receive, one round each', () => {
    const rows = [
      done({ time: at(10), agent_id: 'a0', agent_type: 'track', track: 'A-1', tokens: { output: 200_000 }, modelTurns: 5 }),
      done({ time: at(30), agent_id: 'a0', agent_type: 'track', track: 'A-1', tokens: { output: 300_000 }, modelTurns: 8 }),
      done({ time: at(50), agent_id: 'a0', agent_type: 'track', track: 'A-1', tokens: { output: 350_000 }, modelTurns: 10 }),
    ];
    const agents = [
      { agent: 'a0', type: 'track', usd: 7, track: 'A-1' },
      { agent: 'rv', type: 'reviewer-tests', usd: 0.5, track: 'A-1' },
    ];
    // One continuation: the same split as a SendMessage round without a `resumed` entry, and no -r1 agent is needed.
    const one = C.costPhases({
      taskId: 'A-1',
      agents,
      resumed: [{ round: 1, reason: 'fix', mode: 'continue', agent: 'a0' }],
      tReceive: at(20),
      rows,
      isReviewer,
    });
    expect(one.phases).toEqual({ build: 4, review: 0.5, fix: 3, fix_rounds: 1 });
    expect(one.perAgent.a0).toEqual({ phase: 'build', fix_usd: 3 });
    // Two continuations of the same agent are two fix rounds (the growth after the first receive is their sum).
    const two = C.costPhases({
      taskId: 'A-1',
      agents,
      resumed: [
        { round: 1, reason: 'fix', mode: 'continue', agent: 'a0' },
        { round: 2, reason: 'fix', mode: 'continue', agent: 'a0' },
      ],
      tReceive: at(20),
      rows,
      isReviewer,
    });
    expect(two.phases).toEqual({ build: 4, review: 0.5, fix: 3, fix_rounds: 2 });
    // A new-agent round (-r1) that was then continued as round 2: all of -r1 is fix, and both rounds count once each.
    const mixed = C.costPhases({
      taskId: 'A-1',
      agents: [{ agent: 'a0', type: 'track', usd: 4, track: 'A-1' }, { agent: 'a1', type: 'track', usd: 2, track: 'A-1-r1' }],
      resumed: [
        { round: 1, reason: 'fix' },
        { round: 2, reason: 'fix', mode: 'continue', agent: 'a1' },
      ],
      tReceive: at(20),
      rows,
      isReviewer,
    });
    expect(mixed.phases).toEqual({ build: 4, review: 0, fix: 2, fix_rounds: 2 });
  });

  it('usageEvents marks the fix-round label with its round number', () => {
    const ev = T.usageEvents([
      done({ time: at(1), agent_id: 'x', agent_type: 'track', track: 'B-2-r3', tokens: { output: 1 } }),
      done({ time: at(1), agent_id: 'y', agent_type: 'track', track: 'B-2', tokens: { output: 1 } }),
    ]);
    expect(ev.map((h: { round: number | null }) => h.round)).toEqual([3, null]);
  });
});

describe('4. per-task statistics by start date', () => {
  it('--since keeps the tasks STARTED in the window (finished later or not), not the ones finished in it', () => {
    const queue = {
      tasks: [
        { id: 'OLD', class: 'K', status: 'done', started: daysAgo(10), done: daysAgo(1), cost: { usd: 9, agents: [] } },
        { id: 'NEW', class: 'K', status: 'done', started: daysAgo(2), done: daysAgo(1), cost: { usd: 3, agents: [] } },
        // No start time (done outside the queue): the done time stands in.
        { id: 'BARE', class: 'K', status: 'done', done: daysAgo(1), cost: { usd: 1, agents: [] } },
      ],
    };
    const s = L.costStatistics(queue, { since: daysAgo(5) });
    expect(s.rows.map((x: { id: string }) => x.id).sort()).toEqual(['BARE', 'NEW']);
    expect(s.by).toBe('started');
  });
});

describe('5. the breakdown: orchestrator, unknown with its source, week over week', () => {
  const queue = {
    tasks: [
      { id: 'A-1', class: 'K', status: 'done', started: daysAgo(2), done: daysAgo(1), cost: { usd: 4, agents: [] } },
      { id: 'B-1', class: 'D', status: 'done', started: daysAgo(9), done: daysAgo(8), cost: { usd: 10, agents: [] } },
    ],
  };
  const ev = (o: Record<string, unknown>) => ({ usd: 1, turns: 1, cache_expiry: 0, assumed: false, tokens: {}, ...o });

  it('unknown is split by why it could not be attributed, with the agent types', () => {
    const exists = (id: string) => queue.tasks.some((o) => o.id === id);
    const u = C.unknownSources(
      [
        ev({ agent: 'abc123456789xyz', track: 'abc123456789', type: 'general-purpose', usd: 3 }),
        ev({ agent: 'def', track: 'Z-9', type: 'track', usd: 2 }),
        ev({ agent: 'ghi', track: 'ghi', type: 'unknown', usd: 1 }),
        ev({ agent: 'jkl', track: 'A-1', type: 'track', usd: 7 }),
      ],
      { exists },
    );
    expect(u.usd).toBe(6);
    expect(u.reasons.map((r: { reason: string; usd: number }) => [r.reason, r.usd])).toEqual([
      ['no-task-id', 3],
      ['not-a-task', 2],
      ['no-agent-type', 1],
    ]);
    expect(u.reasons[0].types).toEqual([{ type: 'general-purpose', usd: 3, agents: 1 }]);
  });

  it('breakdown lines: the orchestrator session is its own line next to the subagent parts and the unknown share', () => {
    const lines = C.breakdownLines(
      {
        total_usd: 20,
        parts: { merged: 10, cancelled: 1, open: 3, unattributed: 6 },
        orchestrator: { usd: 5, sessions: 1 },
        other_sessions: { usd: 0, sessions: 0 },
        unknown: {
          usd: 6,
          reasons: [{ reason: 'no-task-id', usd: 6, agents: 2, types: [{ type: 'general-purpose', usd: 6, agents: 2 }] }],
        },
        assumed_usd: 0,
      },
      'last 28 days',
    ).join('\n');
    expect(lines).toMatch(/Where the cost went \(last 28 days\): \$25\.00/);
    expect(lines).toMatch(/orchestrator session\(s\) \$5\.00/);
    expect(lines).toMatch(/unknown \$6\.00 \(24 %\)/);
    expect(lines).toMatch(/no task id in the mission.*general-purpose/);
  });

  it('week over week: spend by usage time, tasks by start date, with n', () => {
    const events = [
      ev({ agent: 'a', track: 'A-1', time: daysAgo(1), usd: 4 }),
      ev({ agent: 'b', track: 'B-1', time: daysAgo(8), usd: 10 }),
      ev({ agent: 'c', track: 'x', time: daysAgo(3), usd: 2 }),
    ];
    const w = C.weekOverWeek({ queue, events, now: T0, orchestratorUsd: (from: number) => (from > T0 - 7.5 * 86_400_000 ? 3 : 1) });
    expect(w.this).toMatchObject({ usd: 6, agents: 2, orchestrator_usd: 3, started: 1, done: 1, median_usd: 4 });
    expect(w.last).toMatchObject({ usd: 10, agents: 1, orchestrator_usd: 1, started: 1, done: 1, median_usd: 10 });
    const text = C.weekLines(w).join('\n');
    expect(text).toMatch(/Week over week \(spend by usage time; tasks by start date\)/);
    expect(text).toMatch(/this week.*\$6\.00.*n=1/);
    expect(text).toMatch(/-40 %/);
  });
});

// ---- Process: `set <id> done` prints the WARN, stores the new fields, and `cost` shows the new sections ----
describe('queue.mjs set done and cost with the new measurements', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process');
  const ORCHESTRATOR = path.join(__dirname, '..', '..');

  it('WARN at set done for a track agent over 2x its median, and the breakdown, week and per-turn lines in cost', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-measures-'));
    try {
      const now = Date.now();
      const iso = (min: number) => new Date(now - min * 60_000).toISOString();
      fs.writeFileSync(
        path.join(folder, 'queue.json'),
        JSON.stringify({
          resolved: [],
          projects: {},
          tasks: [
            { id: 'X-1', title: 'x', domain: 'a', class: 'K', status: 'review', started: iso(120), delivered: iso(30), t_receive: iso(25), mission: 'm' },
          ],
        }),
      );
      const configFile = path.join(folder, 'queue.config.json');
      fs.writeFileSync(configFile, '{}');
      const log = path.join(folder, 'times.jsonl');
      // Six earlier track agents from other tasks: 1,000 output per turn.
      const old = [1, 2, 3, 4, 5, 6].map((d) =>
        JSON.stringify(
          done({
            time: new Date(now - d * 86_400_000).toISOString(),
            agent_id: `old${d}`,
            agent_type: 'track',
            track: `OLD-${d}`,
            modelTurns: 10,
            tokens: { input: 0, output: 10_000, cache_read: 0, cache_written: 0 },
          }),
        ),
      );
      // The task's track: 5,000 output per turn (no transcript, so the time log row is the measurement).
      const own = JSON.stringify(
        done({
          time: iso(40),
          agent_id: 'own1',
          agent_type: 'track',
          track: 'X-1',
          modelTurns: 4,
          tokens: { input: 0, output: 20_000, cache_read: 0, cache_written: 0 },
          cc_version: '2.1.320',
        }),
      );
      // An agent with no task id: unknown in the breakdown.
      const stray = JSON.stringify(
        done({ time: iso(50), agent_id: 'stray123456789', agent_type: 'general-purpose', track: 'stray1234567', modelTurns: 1, tokens: { output: 1000 } }),
      );
      fs.writeFileSync(log, [...old, own, stray].join('\n') + '\n');
      const env = {
        ...process.env,
        QUEUE_FOLDER: folder,
        QUEUE_CONFIG: configFile,
        QUEUE_ROOT: folder,
        QUEUE_GIT: folder,
        QUEUE_TIME_LOG: log,
        QUEUE_TRANSCRIPTS: path.join(folder, 'no-transcripts'),
      };
      const run = (...args: string[]) => {
        const r = spawnSync(process.execPath, [path.join(ORCHESTRATOR, 'queue.mjs'), ...args], { encoding: 'utf8', env });
        return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
      };
      const set = run('set', 'X-1', 'done');
      expect(set.code, set.error).toBe(0);
      expect(set.out).toMatch(/WARN: track own1 output per turn 5,000 is 5x its 14-day median 1,000 \(n 6\)/);
      expect(set.out).toMatch(/build \$0\.40/);
      const stored = JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks[0].cost;
      expect(stored.agents[0]).toMatchObject({ turns: 4, output_per_turn: 5000, cc_version: '2.1.320', phase: 'build' });
      expect(stored.agents[0]).not.toHaveProperty('thinking_tokens');
      expect(stored.phases).toMatchObject({ build: 0.4, review: 0, fix: 0, fix_rounds: 0 });

      const cost = run('cost');
      expect(cost.code, cost.error).toBe(0);
      expect(cost.out).toMatch(/Where the cost went/);
      expect(cost.out).toMatch(/no task id in the mission/);
      expect(cost.out).toMatch(/Week over week/);
      expect(cost.out).toMatch(/Per turn/);
      expect(cost.out).toMatch(/by start date/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
