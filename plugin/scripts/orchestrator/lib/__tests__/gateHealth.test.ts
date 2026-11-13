// =============================================================
// gateHealth.test.ts: the gate health view (lib/gateHealth.js, `ravenseat gates --health`): per gate command the runs,
// the red and flaky ones, p50/p95 duration, the slowest, and the commands never red over many runs (a hint that the
// gate may not catch anything). Read from the time log's gate rows (lib/timeLogRows.js gateRow) and flakyGate rows,
// across the rotated archives.
// =============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require('../gateHealth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TL = require('../timeLogRows');

const T0 = Date.parse('2026-11-01T10:00:00Z');
const at = (i: number) => new Date(T0 + i * 60_000).toISOString();

/** A gate row as gates.mjs writes it. */
const gate = (i: number, o: Record<string, unknown>) =>
  TL.gateRow({ time: at(i), kind: 'quick', exit: 0, durationSec: 1, ...o });

describe('gateRow keeps the per-command durations', () => {
  it('durations is { command: seconds } rounded to 0.1, and left out when not given', () => {
    const row = TL.gateRow({ kind: 'quick', durationSec: 3, exit: 0, gates: ['a', 'b'], durations: { a: 1.234, b: 1.76 } });
    expect(row.durations).toEqual({ a: 1.2, b: 1.8 });
    expect(TL.gateRow({ kind: 'quick', durationSec: 3, exit: 0 })).not.toHaveProperty('durations');
  });
});

describe('gateHealth', () => {
  it('per command: runs, red, flaky, p50 and p95, slowest first', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) =>
        gate(i, { gates: ['lint', 'test'], durations: { lint: 2, test: 10 + i }, durationSec: 12 + i }),
      ),
      gate(30, { gates: ['lint', 'test'], failed: ['test'], exit: 1, durations: { lint: 2, test: 50 } }),
      // A flaky run (red, then green on the rerun): green, with `flaky`.
      gate(31, { gates: ['lint', 'test'], flaky: ['test'], durations: { lint: 2, test: 12 } }),
      // The base gate's flaky check writes a flakyGate row of its own.
      { time: at(32), event: 'flakyGate', tip: 'abc', commands: ['lint'], source: 'base gate' },
    ];
    const h = G.gateHealth(rows, { minRuns: 50 });
    expect(h.runs).toBe(22);
    const test = h.commands.find((c: { command: string }) => c.command === 'test');
    expect(test).toMatchObject({ runs: 22, red: 1, flaky: 1, timed: 22 });
    expect(test.p50).toBe(19);
    expect(test.p95).toBe(29);
    expect(h.commands[0].command).toBe('test'); // slowest by p95 first
    const lint = h.commands.find((c: { command: string }) => c.command === 'lint');
    expect(lint).toMatchObject({ red: 0, flaky: 1 });
  });

  it('a single-command run without durations uses the run total; a multi-command one has no per-command time', () => {
    const h = G.gateHealth([gate(1, { gates: ['only'], durationSec: 7 }), gate(2, { gates: ['x', 'y'], durationSec: 9 })]);
    expect(h.commands.find((c: { command: string }) => c.command === 'only')).toMatchObject({ timed: 1, p50: 7 });
    expect(h.commands.find((c: { command: string }) => c.command === 'x')).toMatchObject({ runs: 1, timed: 0, p50: null });
  });

  it('never red over at least minRuns runs gives the hint; fewer runs or one red does not', () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => gate(i, { gates: ['quiet', 'caught'], durations: { quiet: 1, caught: 1 } })),
      gate(60, { gates: ['caught'], failed: ['caught'], exit: 1 }),
      ...Array.from({ length: 10 }, (_, i) => gate(70 + i, { gates: ['young'] })),
    ];
    const h = G.gateHealth(rows, { minRuns: 50 });
    expect(h.neverRed.map((c: { command: string }) => c.command)).toEqual(['quiet']);
    const text = G.healthLines(h).join('\n');
    expect(text).toMatch(/never red in 50 run\(s\)/);
    expect(text).toMatch(/quiet/);
    expect(text).toMatch(/try breaking the code it guards and see that it goes red/);
    expect(text).not.toMatch(/never red.*young/);
  });

  it('reads the gate rows straight from the log text, skipping other rows and broken lines', () => {
    const text = [
      JSON.stringify(gate(1, { gates: ['a'] })),
      '{"event":"gate", broken',
      JSON.stringify({ time: at(2), event: 'done', agent_id: 'x', tokens: {} }),
      JSON.stringify({ time: at(3), event: 'flakyGate', commands: ['a'] }),
    ].join('\n');
    const rows = G.rowsFromText(text);
    expect(rows.map((r: { event: string }) => r.event)).toEqual(['gate', 'flakyGate']);
  });

  it('an empty log says so', () => {
    expect(G.healthLines(G.gateHealth([])).join('\n')).toMatch(/No gate runs in the time log/);
  });
});

// ---- Process: `gates.mjs --health` reads the time log and its rotated archives ----
describe('gates.mjs --health', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const f of temporary.splice(0)) fs.rmSync(f, { recursive: true, force: true });
  });

  it('prints the health table from the current log and an archive, runs no gate, and exits 0', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-health-'));
    temporary.push(folder);
    const log = path.join(folder, 'times.jsonl');
    fs.writeFileSync(log, JSON.stringify(gate(1, { gates: ['now-cmd'], durationSec: 4 })) + '\n');
    fs.writeFileSync(path.join(folder, 'times-2026-10.jsonl'), JSON.stringify(gate(-50_000, { gates: ['old-cmd'], durationSec: 2 })) + '\n');
    const configFile = path.join(folder, 'queue.config.json');
    // A gate that would fail loudly if --health ran it.
    fs.writeFileSync(configFile, JSON.stringify({ gates: { quick: ['node -e "process.exit(7)"'] } }));
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'gates.mjs'), '--health'], {
      encoding: 'utf8',
      env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, QUEUE_TIME_LOG: log },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Gate health/);
    expect(r.stdout).toMatch(/now-cmd/);
    expect(r.stdout).toMatch(/old-cmd/);
    const json = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'gates.mjs'), '--health', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, QUEUE_TIME_LOG: log },
    });
    expect(JSON.parse(json.stdout).runs).toBe(2);
  });
});

// ---- The load factor: the latest time against the best seen, now and on a calm machine ----
describe('the load factor', () => {
  it('gateRow keeps the free memory at the start of the run', () => {
    expect(TL.gateRow({ kind: 'quick', durationSec: 3, exit: 0, startFreeMemoryPct: 37.5 }).start_free_memory_pct).toBe(37.5);
    expect(TL.gateRow({ kind: 'quick', durationSec: 3, exit: 0 })).not.toHaveProperty('start_free_memory_pct');
  });

  it('is the latest green time over the best green time, and on a calm machine the p50 of the recent calm runs', () => {
    const rows = [
      gate(1, { gates: ['test'], durations: { test: 10 }, startFreeMemoryPct: 60 }), // the best, calm
      gate(2, { gates: ['test'], durations: { test: 11 }, minFreeMemoryPct: 55 }), // calm
      gate(3, { gates: ['test'], durations: { test: 12 }, minFreeMemoryPct: 50 }), // calm
      gate(4, { gates: ['test'], failed: ['test'], exit: 1, durations: { test: 2 } }), // red: never a time for the factor
      gate(5, { gates: ['test'], durations: { test: 24 }, minFreeMemoryPct: 8 }), // the latest, busy
    ];
    const h = G.gateHealth(rows, { calmFreePct: 40 });
    const test = h.commands.find((c: { command: string }) => c.command === 'test');
    expect(test).toMatchObject({ best: 10, latest: 24, loadNow: 2.4, loadCalm: 1.1 });
    const text = G.healthLines(h).join('\n');
    expect(text).toContain('x2.4 now, x1.1 on a calm machine');
    expect(text).toMatch(/LOAD: test .*busy machine/);
    expect(text).not.toMatch(/slower even on a calm machine/);
  });

  it('a gate that became slower on a calm machine says so', () => {
    const rows = [
      gate(1, { gates: ['test'], durations: { test: 10 }, minFreeMemoryPct: 60 }),
      gate(2, { gates: ['test'], durations: { test: 10 }, minFreeMemoryPct: 60 }),
      gate(3, { gates: ['test'], durations: { test: 18 }, minFreeMemoryPct: 60 }),
      gate(4, { gates: ['test'], durations: { test: 19 }, minFreeMemoryPct: 60 }),
      gate(5, { gates: ['test'], durations: { test: 20 }, minFreeMemoryPct: 60 }),
    ];
    const test = G.gateHealth(rows, { calmFreePct: 40 }).commands[0];
    expect(test.loadNow).toBe(2);
    expect(test.loadCalm).toBe(1.8);
    const text = G.healthLines(G.gateHealth(rows, { calmFreePct: 40 })).join('\n');
    expect(text).toMatch(/HINT: test is slower even on a calm machine \(x1\.8 of its best\)/);
    expect(text).not.toMatch(/LOAD: test/);
  });

  it('has no factor with fewer than 3 green timed runs, and no calm factor without a calm run', () => {
    const two = G.gateHealth([gate(1, { gates: ['a'], durations: { a: 5 } }), gate(2, { gates: ['a'], durations: { a: 9 } })]);
    expect(two.commands[0]).toMatchObject({ loadNow: null, loadCalm: null });
    expect(G.healthLines(two).join('\n')).not.toMatch(/ x\d/);
    const busy = G.gateHealth([1, 2, 3].map((i) => gate(i, { gates: ['a'], durations: { a: 5 * i }, minFreeMemoryPct: 5 })), { calmFreePct: 40 });
    expect(busy.commands[0]).toMatchObject({ loadNow: 3, loadCalm: null });
    expect(G.healthLines(busy).join('\n')).toContain('x3 now, no calm run yet');
  });

  it('counts the best only over the window of recent green runs', () => {
    const rows = [
      gate(0, { gates: ['a'], durations: { a: 1 } }), // outside a window of 3
      ...[1, 2, 3].map((i) => gate(i, { gates: ['a'], durations: { a: 10 } })),
    ];
    expect(G.gateHealth(rows, { window: 3 }).commands[0]).toMatchObject({ best: 10, loadNow: 1 });
  });
});

// ---- Process: the start memory reaches the gate row, and --health takes the calm level from the load guard ----
describe('gates.mjs and the load factor', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const f of temporary.splice(0)) fs.rmSync(f, { recursive: true, force: true });
  });
  const GATES = path.join(__dirname, '..', '..', 'gates.mjs');

  it('a gate run records the free memory at its start', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-load-start-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const g = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'develop');
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    g('add', '--', 'README.md');
    g('commit', '-q', '-m', 'start');
    const log = path.join(folder, 'times.jsonl');
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ gates: { quick: ['node -e "0"'] }, loadGuard: { minFreeMemoryPct: 10 } }));
    const r = spawnSync(process.execPath, [GATES, '--quick', '--cwd', repo], {
      encoding: 'utf8',
      env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: repo, QUEUE_GIT: repo, QUEUE_TIME_LOG: log, QUEUE_LOAD: 'free=33' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const row = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop() as string);
    expect(row.start_free_memory_pct).toBe(33);
  });

  it('--health counts a run as calm from loadGuard.allSlotsFreeMemoryPct', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-load-health-'));
    temporary.push(folder);
    const log = path.join(folder, 'times.jsonl');
    fs.writeFileSync(log, [10, 10, 20].map((d, i) => JSON.stringify(gate(i, { gates: ['t'], durations: { t: d }, minFreeMemoryPct: 35 }))).join('\n') + '\n');
    const health = (allSlots: number) => {
      const configFile = path.join(folder, `queue-${allSlots}.config.json`);
      fs.writeFileSync(configFile, JSON.stringify({ gates: { quick: ['node -e "process.exit(7)"'] }, loadGuard: { allSlotsFreeMemoryPct: allSlots } }));
      return spawnSync(process.execPath, [GATES, '--health'], {
        encoding: 'utf8',
        env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, QUEUE_TIME_LOG: log },
      }).stdout;
    };
    expect(health(50)).toContain('x2 now, no calm run yet');
    expect(health(30)).toContain('x2 now, x1 on a calm machine');
  });
});
