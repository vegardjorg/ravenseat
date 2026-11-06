// =============================================================
// eventRowsCli.test.ts: the flow, load, push and session rows (lib/eventRows.js) the commands and hooks append to the
// time log, written at the right moment, never failing the command, and read back by `ravenseat cost --json` and `ravenseat limit`.
//
// Locks: (1) fill and start write one load row each, also when the load guard stops them (exit 7); (2) triage
// --verdict, resume (fixRound) and a merge with a textual conflict write their rows; (3) every recorded base verdict
// writes a baseGate row; (4) a push to the remote is found in the reflog at the next fill and logged once; (5) the
// status line saves the session cost and logs it throttled, the compaction hook and the SessionEnd hook add a row with
// the last reading; (6) a time log that cannot be written (a folder) never fails fill, triage or resume; (7) ravenseat cost
// --json has the orchestration overhead and the flow figures.
// Runs queue.mjs and the hooks as processes against a temporary queue (QUEUE_FOLDER), git repo (QUEUE_GIT) and bare
// remote, with an injected merge runner (QUEUE_MERGE_RUNNING) as in queueBaseGate.test.ts. Never the main repo.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Task = Record<string, unknown> & { id: string; status: string };
type Row = Record<string, unknown> & { event: string };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORCH = path.join(ROOT, 'scripts', 'orchestrator');
const QUEUE = path.join(ORCH, 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

/** A temporary project: repo on develop with a bare remote (origin), a queue, a config and the merge runner. */
function project({ limits = {}, timeLog }: { limits?: Record<string, unknown>; timeLog?: string } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-events-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const remote = path.join(folder, 'remote.git');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  fs.mkdirSync(scratch);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  g(['add', '--', 'a.txt']);
  g(['commit', '-q', '-m', 'start']);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g(['remote', 'add', 'origin', remote]);
  const tasks: Task[] = [];
  const writeQueue = () =>
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits, next_migr: 3600, resolved: [], tasks }),
    );
  writeQueue();
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', remote: 'origin' }));
  const runner = path.join(folder, 'runner.mjs');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      `const ID = ${JSON.stringify(ID)};`,
      'export default ({ step, cmd, args }) => {',
      '  const repo = process.env.QUEUE_GIT;',
      "  const r = step === 'merge'",
      "    ? spawnSync('git', ['-C', repo, ...ID, 'merge', '--no-ff', '--no-edit', args[1]], { encoding: 'utf8' })",
      "    : spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: process.env });",
      "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };",
      '};',
      '',
    ].join('\n'),
  );
  const log = timeLog ?? path.join(folder, 'times.jsonl');
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: log,
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    QUEUE_MERGE_RUNNING: runner,
    QUEUE_LOAD: 'free=100,cpu=5',
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const spawn = (script: string, args: string[], { input, extra }: { input?: string; extra?: NodeJS.ProcessEnv } = {}) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extra }, input, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const run = (...args: string[]) => spawn(QUEUE, args);
  const runWith = (extra: NodeJS.ProcessEnv, ...args: string[]) => spawn(QUEUE, args, { extra });
  const rows = (event?: string): Row[] => {
    if (!fs.existsSync(log) || fs.statSync(log).isDirectory()) return [];
    return fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row)
      .filter((r) => !event || r.event === event);
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] };
  /** A waiting task (no branch). */
  const waiting = (id: string, extra: Record<string, unknown> = {}) => {
    const q = queue();
    q.tasks.push({
      id,
      title: `Task ${id}`,
      domain: 'dom',
      class: 'K',
      status: 'waiting',
      mission: `The mission for ${id}.`,
      value: 5,
      content_min: 30,
      depends_on: [],
      waiting_on: [],
      owned_files: [`${id}.txt`],
      ...extra,
    } as Task);
    tasks.splice(0, tasks.length, ...q.tasks);
    writeQueue();
  };
  /** A track in review: branch queue/<id> with the files committed. */
  const track = (id: string, files: Record<string, string>) => {
    g(['branch', `queue/${id}`, 'develop']);
    const wt = path.join(folder, `wt-${id}`);
    g(['worktree', 'add', '-q', wt, `queue/${id}`]);
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(wt, f), text);
    g(['add', '--', ...Object.keys(files)], wt);
    g(['commit', '-q', '-m', `feat: ${id}`], wt);
    waiting(id, {
      status: 'review',
      owned_files: Object.keys(files),
      started: '2026-01-01T00:00:00.000Z',
      branch: `queue/${id}`,
      scratchpad: scratch,
    });
    return wt;
  };
  return { folder, repo, remote, scratch, g, run, runWith, spawn, rows, queue, waiting, track, log, env };
}

describe('the event rows written by the commands', () => {
  it('fill and start write a load row, also when the load guard stops them (exit 7)', () => {
    const p = project({ limits: { minFreeMemoryPct: 10 } });
    p.waiting('A');
    p.waiting('B');
    // The machine is full: fill and start stop with exit 7, and the row says why.
    const stopFill = p.runWith({ QUEUE_LOAD: 'free=4,cpu=5' }, 'fill', '--scratchpad', p.scratch);
    expect(stopFill.code).toBe(7);
    const stopStart = p.runWith({ QUEUE_LOAD: 'free=4,cpu=5' }, 'start', 'A', '--scratchpad', p.scratch);
    expect(stopStart.code).toBe(7);
    const stops = p.rows('load');
    expect(stops).toHaveLength(2);
    expect(stops[0]).toMatchObject({ command: 'fill', free_memory_pct: 4, cpu_pct: 5, stopped: true, running: 0 });
    expect(String(stops[0].stop_reason)).toContain('free memory 4 %');
    expect(stops[1]).toMatchObject({ command: 'start', stopped: true });
    // start --force: nothing measured, logged as an override; A then runs.
    expect(p.run('start', 'A', '--force', '--scratchpad', p.scratch).code).toBe(0);
    expect(p.rows('load').at(-1)).toMatchObject({ command: 'start', override: true, free_memory_pct: null, stopped: false });
    // A normal fill: the slots against maxConcurrent and the running track.
    const fill = p.run('fill', '--scratchpad', p.scratch);
    expect(fill.error).toBe('');
    expect(fill.code).toBe(0);
    const last = p.rows('load').at(-1)!;
    expect(last).toMatchObject({ command: 'fill', free_memory_pct: 100, stopped: false, running: 1 });
    expect(typeof last.max_slots).toBe('number');

    // ravenseat limit shows the history.
    const limit = p.run('limit');
    expect(limit.code).toBe(0);
    expect(limit.out).toMatch(/Load history \(last 7 days\): 4 fill\/start/);
    expect(limit.out).toContain('stopped (machine full, exit 7) 2');
    expect(limit.out).toContain('guard skipped by the owner 1');
    expect(limit.out).toContain('STOPPED');
  });

  it('triage --verdict, resume and a merge conflict write their rows', () => {
    const p = project();
    p.waiting('T');
    expect(p.run('triage', 'T', '--verdict', 'ready', '--by', 'helper').code).toBe(0);
    expect(p.rows('triage')).toEqual([expect.objectContaining({ task: 'T', verdict: 'ready', by: 'helper' })]);

    p.track('R', { 'r.txt': 'r\n' });
    const resume = p.run('resume', 'R', '--reason', 'fix', '--scratchpad', p.scratch);
    expect(resume.error).toBe('');
    expect(resume.code).toBe(0);
    expect(p.rows('fixRound')).toEqual([expect.objectContaining({ task: 'R', reason: 'fix', round: 1 })]);
    expect(p.rows('fixRound')[0].from).toBeUndefined();
    // --from: the reviewer types whose findings caused the round, in `resumed` and the row; an unknown name is kept
    // with a warning.
    const from = p.run('resume', 'R', '--reason', 'fix', '--from', 'reviewer,reviewer-made-up', '--scratchpad', p.scratch);
    expect(from.code).toBe(0);
    expect(from.out).toContain('WARNING: --from reviewer-made-up is not a reviewer type here');
    expect(p.rows('fixRound')[1]).toMatchObject({ task: 'R', round: 2, from: ['reviewer', 'reviewer-made-up'] });
    expect(p.queue().tasks.find((t) => t.id === 'R')?.resumed[1].from).toEqual(['reviewer', 'reviewer-made-up']);
    expect(p.run('resume', 'R', '--from', 'bad name', '--scratchpad', p.scratch).error).toContain('--from takes agent type names');

    // Two tracks that change the same line: the second merge stops in the merge step with one conflicted file.
    p.track('M1', { 'a.txt': 'from M1\n' });
    p.track('M2', { 'a.txt': 'from M2\n' });
    expect(p.run('merge', 'M1', '--without-fill').code).toBe(0);
    expect(p.rows('mergeConflict')).toHaveLength(0);
    const m2 = p.run('merge', 'M2', '--without-fill');
    expect(m2.code).not.toBe(0);
    expect(m2.out).toContain('STOP in the step merge');
    expect(p.rows('mergeConflict')).toEqual([expect.objectContaining({ task: 'M2', files: 1, branch: 'queue/M2' })]);
    expect(p.rows('mergeConflict')[0].guard).toBeUndefined();
  });

  it('a recorded base verdict writes a baseGate row', () => {
    const p = project();
    const cfg = path.join(p.folder, 'queue.config.json');
    fs.writeFileSync(cfg, JSON.stringify({ baseBranch: 'develop', remote: 'origin', gates: { quick: ['node -e "0"'] } }));
    p.track('G', { 'g.txt': 'g\n' });
    const m = p.run('merge', 'G', '--without-fill');
    expect(m.code).toBe(0);
    const gates = p.rows('baseGate');
    expect(gates.length).toBeGreaterThanOrEqual(1);
    const tip = p.g(['rev-parse', 'develop']);
    expect(gates.at(-1)).toMatchObject({ tip, ok: true });
  });

  it('a push to the remote is found in the reflog at the next fill and logged once', () => {
    const p = project();
    p.g(['push', '-q', 'origin', 'develop']);
    // The first push creates the remote ref (no older entry: its batch is unknown, so it is skipped).
    p.run('fill', '--scratchpad', p.scratch);
    expect(p.rows('push')).toHaveLength(0);
    const before = p.g(['rev-parse', 'develop']);
    fs.writeFileSync(path.join(p.repo, 'b.txt'), 'b\n');
    p.g(['add', '--', 'b.txt']);
    p.g(['commit', '-q', '-m', 'second']);
    fs.writeFileSync(path.join(p.repo, 'c.txt'), 'c\n');
    p.g(['add', '--', 'c.txt']);
    p.g(['commit', '-q', '-m', 'third']);
    p.g(['push', '-q', 'origin', 'develop']);
    // A fetch moves nothing new and writes no "update by push".
    p.g(['fetch', '-q', 'origin']);
    p.run('fill', '--scratchpad', p.scratch);
    const pushes = p.rows('push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      remote: 'origin',
      branch: 'develop',
      from: before,
      tip: p.g(['rev-parse', 'develop']),
      commits: 2,
    });
    // The next fill logs it no more.
    p.run('fill', '--scratchpad', p.scratch);
    expect(p.rows('push')).toHaveLength(1);
    const cost = JSON.parse(p.run('cost', '--json').out);
    expect(cost.flow.pushes).toMatchObject({ count: 1 });
  });

  it('a time log that cannot be written never fails fill, triage or resume', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-events-bad-'));
    temporary.push(folder);
    // A folder where the file should be: every append fails.
    const p = project({ timeLog: folder, limits: { minFreeMemoryPct: 10 } });
    p.waiting('T');
    expect(p.run('triage', 'T', '--verdict', 'ready').code).toBe(0);
    expect(p.runWith({ QUEUE_LOAD: 'free=4' }, 'fill', '--scratchpad', p.scratch).code).toBe(7);
    const fill = p.run('fill', '--scratchpad', p.scratch);
    expect(fill.code).toBe(0);
    expect(fill.out).toContain('FILLED 1 track(s)');
    p.track('R', { 'r.txt': 'r\n' });
    expect(p.run('resume', 'R', '--reason', 'fix', '--scratchpad', p.scratch).code).toBe(0);
    expect(p.queue().tasks.find((t) => t.id === 'R')?.resumed).toHaveLength(1);
  });
});

describe('the session cost rows (status line, compaction hook, SessionEnd hook)', () => {
  const payload = (session: string, usd: number) =>
    JSON.stringify({
      session_id: session,
      model: { id: 'claude-test' },
      cost: { total_cost_usd: usd, total_duration_ms: 60_000, total_api_duration_ms: 30_000 },
      context_window: { total_input_tokens: 12_345 },
    });

  it('saveSessionCost: the first reading, a throttle below $0.50, a step, and a time step', async () => {
    const p = project();
    const { saveSessionCost } = await import(pathToFileURL(path.join(ORCH, 'statusline.mjs')).href);
    fs.writeFileSync(path.join(p.folder, 'orchestrator.json'), JSON.stringify({ session_id: 'S1' }));
    const t0 = Date.parse('2026-03-01T10:00:00.000Z');
    const save = (usd: number, at: number) => saveSessionCost(p.folder, JSON.parse(payload('S1', usd)), { now: at, log: p.log });
    expect(save(0.1, t0)).toBe(true);
    expect(save(0.3, t0 + 60_000)).toBe(false); // +0.20, one minute: no row
    expect(save(0.65, t0 + 120_000)).toBe(true); // +0.55 since the last row
    expect(save(0.7, t0 + 180_000)).toBe(false);
    expect(save(0.72, t0 + 12 * 60_000)).toBe(true); // grew, 10 minutes after the last row
    expect(save(0.72, t0 + 30 * 60_000)).toBe(false); // no growth: no row
    const rows = p.rows('session');
    expect(rows.map((r) => r.usd)).toEqual([0.1, 0.65, 0.72]);
    expect(rows[0]).toMatchObject({
      session_id: 'S1',
      orchestrator: true,
      trigger: 'statusline',
      duration_s: 60,
      api_duration_s: 30,
      context_tokens: 12_345,
      model: 'claude-test',
    });
    const state = JSON.parse(fs.readFileSync(path.join(p.folder, 'session-cost.json'), 'utf8'));
    expect(state.sessions.S1).toMatchObject({ usd: 0.72, logged_usd: 0.72 });
    // A log that cannot be written: false, no throw, and the state keeps the old logged figure (it is retried).
    expect(save(2, t0 + 40 * 60_000)).toBe(true);
    expect(saveSessionCost(p.folder, JSON.parse(payload('S1', 3)), { now: t0 + 41 * 60_000, log: p.folder })).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(p.folder, 'session-cost.json'), 'utf8')).sessions.S1.logged_usd).toBe(2);
  });

  it('statusline.mjs as a process, then the compaction and SessionEnd hooks add a row with the last reading', () => {
    const p = project();
    fs.writeFileSync(path.join(p.folder, 'orchestrator.json'), JSON.stringify({ session_id: 'S2' }));
    const line = p.spawn(path.join(ORCH, 'statusline.mjs'), [], { input: payload('S2', 1.25) });
    expect(line.code).toBe(0);
    expect(line.out.trim().split('\n')).toHaveLength(1);
    expect(p.rows('session')).toEqual([expect.objectContaining({ session_id: 'S2', usd: 1.25, trigger: 'statusline' })]);
    // A reading below the step: saved, not logged; the hooks then log it.
    p.spawn(path.join(ORCH, 'statusline.mjs'), [], { input: payload('S2', 1.4) });
    expect(p.rows('session')).toHaveLength(1);

    const compact = p.spawn(path.join(ORCH, 'hook-after-compact.mjs'), [], {
      input: JSON.stringify({ session_id: 'S2', source: 'compact', hook_event_name: 'SessionStart' }),
    });
    expect(compact.code).toBe(0);
    expect(p.rows('session').at(-1)).toMatchObject({ usd: 1.4, trigger: 'compact', orchestrator: true });

    const end = p.spawn(path.join(ORCH, 'hook-session-end.mjs'), [], {
      input: JSON.stringify({ session_id: 'S2', reason: 'logout', hook_event_name: 'SessionEnd' }),
    });
    expect(end.code).toBe(0);
    expect(end.out).toBe('');
    expect(p.rows('session').at(-1)).toMatchObject({ usd: 1.4, trigger: 'end', reason: 'logout', orchestrator: true });
    // A session without a saved reading: no row; broken input: still exit 0.
    expect(p.spawn(path.join(ORCH, 'hook-session-end.mjs'), [], { input: JSON.stringify({ session_id: 'nope' }) }).code).toBe(0);
    expect(p.spawn(path.join(ORCH, 'hook-session-end.mjs'), [], { input: '{broken' }).code).toBe(0);
    expect(p.rows('session')).toHaveLength(3);

    // ravenseat cost --json: the overhead from the cumulative rows (1.25 then 1.4 = 1.4), nothing subtracted.
    const cost = p.run('cost', '--json');
    expect(cost.code).toBe(0);
    const j = JSON.parse(cost.out);
    expect(j.orchestration).toMatchObject({ sessions: 1, gross_usd: 1.4, subagent_usd: 0, usd: 1.4 });
    expect(j.flow).toHaveProperty('firstPass');
    expect(j.flow).toHaveProperty('rightFirstTime');
    expect(j.flow).toHaveProperty('reviewers');
    expect(j.flow).toHaveProperty('inflow');
    const text = p.run('cost');
    expect(text.out).toContain('Orchestration overhead');
    expect(text.out).toContain('Flow (');
  });
});
