// =============================================================
// transcriptMetrics.test.ts: the transcript metrics in the done rows and their readers.
//   - per-model split and pricing (lib/timeCost.js PRICE_TABLE, priceFor, the `prices` override, byModel, costOf)
//   - tool calls and errors per tool name, API error entries (rate limit, overloaded, other)
//   - active time (gaps longer than the idle threshold left out)
//   - killed agents: a done row with killed: true from the transcript (lib/timeLogRows.js and `ravenseat cost measure`),
//     never counted twice when a real done row arrives later
//   - older rows without the new fields still work (lib/transcriptMetrics.js metricsSummary)
// =============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Tokens = Record<string, number>;
type Row = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../timeCost') as {
  costUsd: (t: Tokens, model?: string) => number;
  costOf: (r: Row) => number;
  priceFor: (m: string) => { price: Record<string, number>; family: string; known: boolean };
  setPriceOverrides: (o: unknown) => void;
  analyzeTranscript: (t: string, o?: { idleGapMin?: number }) => {
    tokens: Tokens;
    modelTurns: number;
    toolCall: number;
    model: string | null;
    byModel: Record<string, { turns: number; tokens: Tokens; cost_usd: number }>;
    tools: Record<string, { calls: number; errors: number }>;
    api_errors: { rate_limit: number; overloaded: number; other: number };
    duration_s: number | null;
    active_s: number | null;
    idle_gaps: number;
    cost_usd: number;
    track: string | null;
  };
  usageEvents: (r: Row[]) => { agent: string; usd: number; assumed: boolean }[];
  summarizeCost: (r: Row[]) => { total: number; assumed: boolean };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const R = require('../timeLogRows') as {
  agentsWithoutDone: (rows: Row[], o?: { from?: string | null }) => Row[];
  killedDoneRow: (a: { start: Row; stat: Row; time?: string }) => Row;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const M = require('../transcriptMetrics') as {
  metricsSummary: (
    rows: Row[],
    o?: { day?: string | null; from?: number | null; to?: number | null },
  ) => {
    perModel: { model: string; known: boolean; usd: number; turns: number; share: number }[];
    tools: { name: string; calls: number; errors: number; errorRate: number | null }[];
    toolTotal: { calls: number; errors: number; errorRate: number | null };
    apiErrors: { rate_limit: number; overloaded: number; other: number };
    time: { active_s: number; duration_s: number; idle_gaps: number; rowsWithActive: number };
    agents: number;
    killed: number;
    total_usd: number;
    assumed: boolean;
  };
  metricsLines: (m: unknown) => string[];
};

const MILL = 1_000_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** A transcript line: an assistant turn with usage (and optional tool calls). */
const turn = (id: string, s: number, model: string, usage: Tokens, tools: { id: string; name: string }[] = []) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(s),
    message: {
      id,
      model,
      usage,
      content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: {} })),
    },
  });
/** A user entry with tool results (is_error per id). */
const results = (s: number, list: { id: string; error?: boolean }[]) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(s),
    message: {
      role: 'user',
      content: list.map((r) => ({ type: 'tool_result', tool_use_id: r.id, is_error: r.error ?? false, content: 'x' })),
    },
  });
const mission = (s: number, text: string) =>
  JSON.stringify({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } });
/** An API error entry as Claude Code writes it (model <synthetic>, isApiErrorMessage, apiErrorStatus, error). */
const apiError = (s: number, fields: Row, text: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(s),
    ...fields,
    message: {
      id: `err-${s}`,
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text }],
    },
  });

afterEach(() => T.setPriceOverrides(null));

describe('prices per model family', () => {
  it('has its own price per family; the specific version wins over the family', () => {
    T.setPriceOverrides(null);
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-opus-5-5')).toBeCloseTo(24);
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-opus-4-8')).toBeCloseTo(30);
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-sonnet-5-5')).toBeCloseTo(12);
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-sonnet-4-6')).toBeCloseTo(18);
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-haiku-5-5')).toBeCloseTo(0.6);
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-haiku-4-5')).toBeCloseTo(6);
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-fable-5-1')).toBeCloseTo(60);
    // Cache reads per model; cache writes 1.25x (5 min) and 2x (1 h) the input price.
    expect(T.costUsd({ cache_read: MILL }, 'claude-fable-5-1')).toBeCloseTo(0.25);
    expect(T.costUsd({ cache_read: MILL }, 'claude-fable-5')).toBeCloseTo(1);
    expect(T.costUsd({ cache_written: MILL, cache_written_5m: MILL, cache_written_1h: 0 }, 'claude-sonnet-5')).toBeCloseTo(2.5);
    expect(T.costUsd({ cache_written: MILL, cache_written_5m: 0, cache_written_1h: MILL }, 'claude-sonnet-5')).toBeCloseTo(4);
    // A suffix or a provider prefix still hits the family.
    expect(T.priceFor('claude-opus-5-5[1m]').family).toBe('opus-5-5');
    expect(T.priceFor('us.anthropic.claude-sonnet-5-5').family).toBe('sonnet-5');
  });

  it('prices an unknown model as Opus 5.5 and marks it assumed', () => {
    T.setPriceOverrides(null);
    expect(T.priceFor('some-other-model').known).toBe(false);
    expect(T.costUsd({ input: MILL }, 'some-other-model')).toBeCloseTo(4);
    const rows = [{ time: at(0), event: 'done', agent_id: 'a', tokens: { input: MILL }, model: 'some-other-model' }];
    expect(T.summarizeCost(rows).assumed).toBe(true);
  });

  it('the `prices` override wins (exact id or a part of it); cache writes follow its input price', () => {
    T.setPriceOverrides({ 'opus-4-1': { input: 15, output: 75, cache_read: 1.5 } });
    expect(T.costUsd({ input: MILL, output: MILL }, 'claude-opus-4-1')).toBeCloseTo(90);
    expect(T.costUsd({ cache_written: MILL, cache_written_5m: MILL, cache_written_1h: 0 }, 'claude-opus-4-1')).toBeCloseTo(18.75);
    // Other models keep the table.
    expect(T.costUsd({ input: MILL }, 'claude-opus-5-5')).toBeCloseTo(4);
  });
});

describe('analyzeTranscript: per model, tools, API errors and active time', () => {
  const text = [
    mission(0, 'Read prompt-A-1.md and build it'),
    turn('m1', 10, 'claude-opus-5-5', { input_tokens: MILL, output_tokens: 0 }, [
      { id: 't1', name: 'Bash' },
      { id: 't2', name: 'Read' },
    ]),
    results(20, [{ id: 't1', error: true }, { id: 't2' }]),
    // The same streamed message again (same id): counted once.
    turn('m1', 21, 'claude-opus-5-5', { input_tokens: MILL, output_tokens: 0 }),
    turn('m2', 30, 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: MILL }, [{ id: 't3', name: 'Bash' }]),
    results(40, [{ id: 't3', error: true }]),
    apiError(50, { isApiErrorMessage: true, apiErrorStatus: 529, error: 'server_error' }, 'API Error: 529 Overloaded.'),
    apiError(60, { isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit' }, 'API Error: Request rejected (429)'),
    // Older or other versions: only the text tells the kind.
    apiError(70, { isApiErrorMessage: true }, 'API Error: rate limit reached'),
    apiError(80, { isApiErrorMessage: true, apiErrorStatus: 500 }, 'API Error: 500 Internal server error'),
    // A 20 minute pause (idle), then one more Opus turn.
    turn('m3', 80 + 20 * 60, 'claude-opus-5-5', { input_tokens: MILL, output_tokens: 0 }),
  ].join('\n');

  it('splits tokens and cost per model; cost_usd is the sum; model is the most used one', () => {
    const t = T.analyzeTranscript(text);
    expect(Object.keys(t.byModel).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(t.byModel['claude-opus-5-5'].turns).toBe(2);
    expect(t.byModel['claude-opus-5-5'].tokens.input).toBe(2 * MILL);
    expect(t.byModel['claude-opus-5-5'].cost_usd).toBeCloseTo(8);
    expect(t.byModel['claude-sonnet-5-5'].cost_usd).toBeCloseTo(10);
    expect(t.cost_usd).toBeCloseTo(18);
    expect(t.model).toBe('claude-opus-5-5');
    // The API error entries are not model turns and not a model.
    expect(t.modelTurns).toBe(3);
    expect(t.byModel['<synthetic>']).toBeUndefined();
    // The row's cost is the per-model sum, not all tokens at the most used model's price.
    expect(T.costOf({ tokens: t.tokens, model: t.model, byModel: t.byModel })).toBeCloseTo(18);
    expect(T.costOf({ tokens: t.tokens, model: t.model })).toBeCloseTo(28);
  });

  it('counts tool calls and errors per tool name and the API errors by kind', () => {
    const t = T.analyzeTranscript(text);
    expect(t.tools).toEqual({ Bash: { calls: 2, errors: 2 }, Read: { calls: 1, errors: 0 } });
    expect(t.toolCall).toBe(3);
    expect(t.api_errors).toEqual({ rate_limit: 2, overloaded: 1, other: 1 });
  });

  it('active time leaves out gaps longer than the idle threshold; duration_s stays the wall time', () => {
    const t = T.analyzeTranscript(text);
    expect(t.duration_s).toBe(80 + 20 * 60);
    expect(t.idle_gaps).toBe(1);
    expect(t.active_s).toBe(80);
    // A threshold above the gap: everything is active.
    const wide = T.analyzeTranscript(text, { idleGapMin: 30 });
    expect(wide.idle_gaps).toBe(0);
    expect(wide.active_s).toBe(80 + 20 * 60);
  });
});

describe('killed agents (lib/timeLogRows.js)', () => {
  const start = (agent: string, s: number) => ({
    time: at(s),
    wave: 'w1',
    track: agent.slice(0, 12),
    event: 'start',
    agent_id: agent,
    agent_type: 'track',
  });

  it('finds the agents with a start row and no done row, from the given time', () => {
    const rows = [
      start('a', 0),
      start('b', 10),
      { time: at(20), event: 'done', agent_id: 'b', tokens: {} },
      start('c', 100),
    ];
    expect(R.agentsWithoutDone(rows).map((r) => r.agent_id)).toEqual(['a', 'c']);
    expect(R.agentsWithoutDone(rows, { from: at(50) }).map((r) => r.agent_id)).toEqual(['c']);
  });

  it('the killed done row has the analysis, killed: true and the start row ids; a later real done row is not double counted', () => {
    const stat = T.analyzeTranscript(
      [mission(0, 'TRACK B-2 go'), turn('m1', 5, 'claude-opus-5-5', { input_tokens: 0, output_tokens: MILL })].join('\n'),
    );
    const killed = R.killedDoneRow({ start: start('k', 0), stat, time: at(600) });
    expect(killed).toMatchObject({
      event: 'done',
      killed: true,
      cumulative: true,
      agent_id: 'k',
      agent_type: 'track',
      wave: 'w1',
      track: 'B-2',
      cost_usd: 20,
    });
    // The agent was alive after all: a real done row arrives later with the whole transcript (cumulative).
    const later = {
      ...killed,
      time: at(900),
      killed: undefined,
      tokens: { ...stat.tokens, output: 2 * MILL },
      byModel: { 'claude-opus-5-5': { turns: 2, tokens: { ...stat.tokens, output: 2 * MILL }, cost_usd: 40 } },
    };
    const rows = [start('k', 0), killed, later];
    const total = T.usageEvents(rows).reduce((s, h) => s + h.usd, 0);
    expect(total).toBeCloseTo(40);
    const m = M.metricsSummary(rows);
    expect(m.total_usd).toBeCloseTo(40);
    // Not killed after all: the last row decides.
    expect(m.killed).toBe(0);
    expect(M.metricsSummary([start('k', 0), killed]).killed).toBe(1);
  });
});

describe('metricsSummary: growth per agent and older rows', () => {
  it('sums the growth per agent (cumulative rows), per model, tools, API errors and active time', () => {
    const rows = [
      // Agent a: two cumulative rows.
      {
        time: at(100),
        event: 'done',
        agent_id: 'a',
        tokens: { input: MILL },
        byModel: { 'claude-opus-5-5': { turns: 1, tokens: { input: MILL } } },
        tools: { Bash: { calls: 4, errors: 1 } },
        api_errors: { rate_limit: 1, overloaded: 0, other: 0 },
        duration_s: 100,
        active_s: 60,
        idle_gaps: 1,
      },
      {
        time: at(200),
        event: 'done',
        agent_id: 'a',
        tokens: { input: MILL, output: MILL },
        byModel: {
          'claude-opus-5-5': { turns: 1, tokens: { input: MILL } },
          'claude-haiku-5-5': { turns: 3, tokens: { output: MILL } },
        },
        tools: { Bash: { calls: 6, errors: 1 }, Edit: { calls: 2, errors: 1 } },
        api_errors: { rate_limit: 1, overloaded: 2, other: 0 },
        duration_s: 200,
        active_s: 120,
        idle_gaps: 1,
      },
      // An older row: no byModel, tools or active time. Priced by its one model.
      { time: at(300), event: 'done', agent_id: 'old', tokens: { output: MILL }, model: 'claude-sonnet-5', modelTurns: 2 },
    ];
    const m = M.metricsSummary(rows);
    expect(m.agents).toBe(2);
    const byName = Object.fromEntries(m.perModel.map((x) => [x.model, x]));
    expect(byName['claude-opus-5-5'].usd).toBeCloseTo(4);
    expect(byName['claude-opus-5-5'].turns).toBe(1);
    expect(byName['claude-haiku-5-5'].usd).toBeCloseTo(0.5);
    expect(byName['claude-sonnet-5'].usd).toBeCloseTo(10);
    expect(byName['claude-sonnet-5'].turns).toBe(2);
    expect(m.total_usd).toBeCloseTo(14.5);
    // The same total as the budget guard's numbers (usageEvents).
    expect(T.usageEvents(rows).reduce((s, h) => s + h.usd, 0)).toBeCloseTo(14.5);
    expect(m.tools).toEqual([
      { name: 'Bash', calls: 6, errors: 1, errorRate: 16.7 },
      { name: 'Edit', calls: 2, errors: 1, errorRate: 50 },
    ]);
    expect(m.toolTotal).toEqual({ calls: 8, errors: 2, errorRate: 25 });
    expect(m.apiErrors).toEqual({ rate_limit: 1, overloaded: 2, other: 0 });
    // Only rows with an active time count in the time part (the old row adds no wall time).
    expect(m.time).toEqual({ active_s: 120, duration_s: 200, idle_gaps: 1, rowsWithActive: 2 });
    // A window gets only the growth in it.
    const late = M.metricsSummary(rows, { from: T0 + 150_000 });
    expect(late.tools.find((x) => x.name === 'Bash')?.calls).toBe(2);
    expect(late.time.active_s).toBe(60);
    const lines = M.metricsLines(m).join('\n');
    expect(lines).toMatch(/Per model:/);
    expect(lines).toMatch(/Bash\s+6 calls\s+1 errors\s+16\.7 %/);
    expect(lines).toMatch(/API errors: 1 rate limit \(429\), 2 overloaded \(529\), 0 other/);
    expect(lines).toMatch(/Active time: 2 min of 3 min wall time/);
  });

  it('older logs with only model and tokens still give a summary and the same cost as before', () => {
    const rows = [{ time: at(0), event: 'done', agent_id: 'x', tokens: { output: MILL }, model: 'claude-opus-5-5' }];
    const m = M.metricsSummary(rows);
    expect(m.perModel).toMatchObject([{ model: 'claude-opus-5-5', usd: 20 }]);
    expect(m.tools).toEqual([]);
    expect(m.time.rowsWithActive).toBe(0);
    expect(T.usageEvents(rows)[0].usd).toBeCloseTo(20);
    expect(M.metricsSummary([]).agents).toBe(0);
    expect(M.metricsLines(M.metricsSummary([]))).toEqual([]);
  });
});

// ---- Process: `ravenseat cost measure` against a temporary queue writes the killed agent's row once ----
describe('queue.mjs cost measure: a killed agent is measured from its transcript', () => {
  const ORCHESTRATOR = path.join(__dirname, '..', '..');
  const temporary: string[] = [];
  afterEach(() => {
    for (const f of temporary.splice(0)) fs.rmSync(f, { recursive: true, force: true });
  });

  it('writes one killed done row, counts its cost and does not write it again', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-killed-'));
    temporary.push(folder);
    const now = Date.now();
    const iso = (min: number) => new Date(now - min * 60_000).toISOString();
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        resolved: [],
        projects: {},
        tasks: [
          { id: 'X-1', title: 'x', domain: 'a', class: 'K', status: 'running', started: iso(120), mission: 'm' },
        ],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    const log = path.join(folder, 'times.jsonl');
    const startRow = (agent: string, min: number) =>
      JSON.stringify({ time: iso(min), wave: 'w', track: agent, event: 'start', agent_id: agent, agent_type: 'track' });
    fs.writeFileSync(log, [startRow('killed1', 100), startRow('fresh1', 90), startRow('other1', 80)].join('\n') + '\n');
    const transcripts = path.join(folder, 'transcripts');
    const write = (agent: string, text: string, oldMin: number | null) => {
      const dir = path.join(transcripts, 'session-1', 'subagents');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `agent-${agent}.jsonl`);
      fs.writeFileSync(file, text);
      if (oldMin != null) {
        const t = new Date(now - oldMin * 60_000);
        fs.utimesSync(file, t, t);
      }
    };
    const usage = { input_tokens: 0, output_tokens: MILL };
    // The killed agent: its mission names the task; quiet for an hour.
    write('killed1', [mission(0, 'Read prompt-X-1.md'), turn('m1', 5, 'claude-opus-5-5', usage)].join('\n'), 60);
    // Written just now: may be alive, left for the next measurement.
    write('fresh1', [mission(0, 'Read prompt-X-1.md'), turn('m1', 5, 'claude-opus-5-5', usage)].join('\n'), null);
    // Another task's agent: never part of X-1.
    write('other1', [mission(0, 'Read prompt-Y-9.md'), turn('m1', 5, 'claude-opus-5-5', usage)].join('\n'), 60);
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: folder,
      QUEUE_TIME_LOG: log,
      QUEUE_TRANSCRIPTS: transcripts,
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ORCHESTRATOR, 'queue.mjs'), ...args], { encoding: 'utf8', env });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const killedRows = () =>
      fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.event === 'done' && r.killed);

    const first = run('cost', 'measure', 'X-1');
    expect(first.code, first.error).toBe(0);
    expect(first.out).toMatch(/Cost X-1: \$20 \(1 agent\(s\)/);
    expect(killedRows().map((r) => [r.agent_id, r.track, r.cost_usd])).toEqual([['killed1', 'X-1', 20]]);
    expect(killedRows()[0].byModel['claude-opus-5-5'].turns).toBe(1);

    // Again: the done row exists now, so nothing new is written and the cost is the same.
    const second = run('cost', 'measure', 'X-1');
    expect(second.out).toMatch(/Cost X-1: \$20 \(1 agent\(s\)/);
    expect(killedRows()).toHaveLength(1);
  });
});
