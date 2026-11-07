// =============================================================
// queueFaultInjection.test.ts: the queue is cut off at the worst moments, and must end in one correct state.
//
// Where queueMergeResume.test.ts lets a step answer "I was interrupted" (the process still cleans up), this file kills
// the real process without warning, as a power cut or a crash would: no signal handler, no cleanup, the lock left
// behind. The matrix, also in docs/orchestration.md ("What happens when it is cut off"):
//   - killed right after the git merge, before the queue knows;
//   - killed in the gates, after the merge;
//   - killed right after the task was marked done, with the fill step left;
//   - queue.json half written or broken, and a temporary file left behind;
//   - two merges at the same time (real processes), also of the same task;
//   - an agent dying in the middle of a track;
//   - receive killed in the middle of its checks;
//   - a real conflict in the middle of a merge, undone or resolved by hand.
// Every case checks the same promise: no work lost, nothing merged twice, nothing marked done that is not in the base,
// and the next command says or does the right thing. Runs against a temporary queue (QUEUE_FOLDER) and git repo
// (QUEUE_GIT), with the injected merge runner. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Run = { code: number | null; out: string; error: string };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

/** A temporary project: repo on develop, a queue, no gates, and a merge runner driven by a scenario file. */
function project() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-fault-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const gTry = (args: string[]) => spawnSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8' });
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  g(['add', '--', 'shared.txt']);
  g(['commit', '-q', '-m', 'start']);
  const tasks: Task[] = [];
  const queueFile = path.join(folder, 'queue.json');
  const writeQueue = () =>
    fs.writeFileSync(queueFile, JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks }));
  writeQueue();
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
  // The runner. A scenario entry for a step: { kill: true } = the process dies without warning, before the step does
  // anything; { killAfter: true } = the step runs for real, then the process dies; { sleepMs } = the step takes that
  // long. Otherwise a real merge with plain git, or the real command. Every step is logged.
  const runner = path.join(folder, 'runner.mjs');
  const steps = path.join(folder, 'steps.log');
  const scenarioFile = path.join(folder, 'scenario.json');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      `const ID = ${JSON.stringify(ID)};`,
      // SIGKILL: no handler runs and nothing is cleaned up, also on Windows (TerminateProcess).
      "const die = () => { process.kill(process.pid, 'SIGKILL'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); };",
      'export default ({ step, cmd, args }) => {',
      `  fs.appendFileSync(${JSON.stringify(steps)}, step + '\\n');`,
      `  const sc = fs.existsSync(${JSON.stringify(scenarioFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8')) : {};`,
      '  const x = sc[step] ?? {};',
      '  if (x.kill) die();',
      '  if (x.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, x.sleepMs);',
      '  const repo = process.env.QUEUE_GIT;',
      "  const r = step === 'merge'",
      "    ? spawnSync('git', ['-C', repo, ...ID, 'merge', '--no-ff', '--no-edit', args[1]], { encoding: 'utf8' })",
      "    : step === 'fill' ? { status: 0, stdout: '', stderr: '' } : spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: process.env });",
      '  if (x.killAfter) die();',
      "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') + (step === 'merge' && r.status === 0 ? '\\nMerged by the test runner' : '') };",
      '};',
      '',
    ].join('\n'),
  );
  const scratch = path.join(folder, 'scratch');
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    QUEUE_MERGE_RUNNING: runner,
    QUEUE_LOAD: 'free=100,cpu=5',
    QUEUE_SCRATCHPAD: scratch,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]): Run => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  /** A real process that can be killed or run next to another one. */
  const start = (...args: string[]) => {
    const c = spawn(process.execPath, [QUEUE, ...args], { env, cwd: folder });
    let out = '';
    let error = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (error += d));
    const done = new Promise<Run>((resolve) => c.on('close', (code) => resolve({ code, out, error })));
    return { child: c, done };
  };
  const scenario = (s: Record<string, unknown>) => fs.writeFileSync(scenarioFile, JSON.stringify(s));
  const ranSteps = () => {
    const t = fs.existsSync(steps) ? fs.readFileSync(steps, 'utf8') : '';
    fs.rmSync(steps, { force: true });
    return t.split('\n').filter(Boolean);
  };
  const find = (id: string) => (JSON.parse(fs.readFileSync(queueFile, 'utf8')) as { tasks: Task[] }).tasks.find((t) => t.id === id);
  const lockFile = path.join(folder, 'merge.lock');
  const stateFile = (id: string) => path.join(folder, `merge-state-${id}.json`);
  const state = (id: string) => JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
  /** A task on a branch queue/<id> from develop with the files committed. */
  const track = (id: string, files: Record<string, string>, over: Record<string, unknown> = {}) => {
    g(['switch', '-q', '-c', `queue/${id}`, 'develop']);
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), text);
    g(['add', '--', ...Object.keys(files)]);
    g(['commit', '-q', '-m', `feat: ${id}`]);
    g(['switch', '-q', 'develop']);
    tasks.push({
      id,
      title: `Task ${id}`,
      domain: `dom-${id}`,
      class: 'K',
      status: 'review',
      mission: `The mission for ${id}.`,
      value: 5,
      content_min: 30,
      depends_on: [],
      waiting_on: [],
      owned_files: Object.keys(files),
      started: '2026-01-01T00:00:00.000Z',
      branch: `queue/${id}`,
      ...over,
    } as Task);
    writeQueue();
    return g(['rev-parse', `queue/${id}`]);
  };
  const contains = (tip: string) => gTry(['merge-base', '--is-ancestor', tip, 'develop']).status === 0;
  /** How many times the tip was merged: the merge commits on develop whose second parent is the tip. */
  const mergesOf = (tip: string) =>
    g(['log', '--merges', '--format=%P', 'develop']).split('\n').filter((l) => l.split(' ')[1] === tip).length;
  return { folder, repo, g, gTry, run, start, scenario, ranSteps, find, queueFile, lockFile, stateFile, state, track, contains, mergesOf, scratch };
}

/** Waits (without blocking vitest) until a file exists. */
async function waitFor(file: string, ms = 30_000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`waited ${ms} ms for ${file}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('ravenseat merge killed without warning', () => {
  it('right after the git merge, before the queue knows: nothing is merged twice, --resume finishes it', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ merge: { killAfter: true } });
    expect(p.run('merge', 'A', '--without-fill').code).not.toBe(0);
    // The merge is in the base, but the queue only knows that it started: still review, not done, and the lock is left.
    expect(p.contains(tip)).toBe(true);
    expect(p.find('A')?.status).toBe('review');
    expect(p.state('A')).toMatchObject({ current: 'merge', steps_done: [] });
    expect(fs.existsSync(p.lockFile)).toBe(true);
    p.ranSteps();
    p.scenario({});
    // A plain merge takes over the stale lock and says what to run instead of merging again.
    const again = p.run('merge', 'A', '--without-fill');
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/took over a stale merge lock/);
    expect(again.error).toContain('merge A --resume');
    expect(p.ranSteps()).toEqual([]);
    expect(fs.existsSync(p.lockFile)).toBe(false);
    const r = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(p.ranSteps()).toEqual(['gates', 'done']);
    expect(p.find('A')).toMatchObject({ status: 'done', merge_commit: p.g(['rev-parse', 'develop']) });
    expect(p.mergesOf(tip)).toBe(1);
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
  });

  it('in the gates, after the merge: --resume takes the stale lock, runs the gates again and marks done once', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ gates: { kill: true } });
    expect(p.run('merge', 'A', '--without-fill').code).not.toBe(0);
    expect(p.find('A')?.status).toBe('review');
    expect(p.state('A')).toMatchObject({ current: 'gates', steps_done: ['merge'] });
    p.ranSteps();
    p.scenario({});
    const r = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/took over a stale merge lock/);
    expect(p.ranSteps()).toEqual(['gates', 'done']);
    expect(p.find('A')?.status).toBe('done');
    expect(p.mergesOf(tip)).toBe(1);
    expect(fs.existsSync(p.lockFile)).toBe(false);
  });

  it('right after the task was marked done: --resume runs only the fill that is left', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ done: { killAfter: true } });
    expect(p.run('merge', 'A').code).not.toBe(0);
    expect(p.find('A')?.status).toBe('done');
    expect(p.state('A')).toMatchObject({ current: 'done' });
    p.ranSteps();
    p.scenario({});
    const r = p.run('merge', 'A', '--resume');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(p.ranSteps()).toEqual(['fill']);
    expect(p.find('A')?.status).toBe('done');
    expect(p.mergesOf(tip)).toBe(1);
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
    expect(fs.existsSync(p.lockFile)).toBe(false);
  });
});

describe('queue.json cut off in the middle of a write', () => {
  it('a temporary file left behind changes nothing', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    // The write is a temporary file renamed over the old one: killed before the rename, this is what stays.
    fs.writeFileSync(`${p.queueFile}.99999.tmp`, '{"tasks": [');
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    expect(p.find('A')?.status).toBe('done');
  });

  it('a broken queue.json stops the merge before anything happens and names the good copy; restored, it goes on', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    // A write through the queue makes the copy of the previous good state.
    expect(p.run('limit', 'maxConcurrent', '3').code).toBe(0);
    const good = `${p.queueFile}.prev`;
    expect(fs.existsSync(good)).toBe(true);
    const whole = fs.readFileSync(p.queueFile, 'utf8');
    fs.writeFileSync(p.queueFile, whole.slice(0, Math.floor(whole.length / 2)));
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).not.toBe(0);
    expect(m.error).toContain('queue.json.prev');
    expect(p.ranSteps()).toEqual([]);
    expect(p.contains(tip)).toBe(false);
    expect(fs.existsSync(p.lockFile)).toBe(false);
    fs.copyFileSync(good, p.queueFile);
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    expect(p.find('A')?.status).toBe('done');
    expect(p.mergesOf(tip)).toBe(1);
  });
});

describe('two merges at the same time (real processes)', () => {
  it('a second task waits its turn: it is refused, unchanged, and merges afterwards', async () => {
    const p = project();
    const tipA = p.track('A', { 'a.txt': 'from A\n' });
    const tipB = p.track('B', { 'b.txt': 'from B\n' });
    p.scenario({ gates: { sleepMs: 3000 } });
    const first = p.start('merge', 'A', '--without-fill');
    await waitFor(p.lockFile);
    const second = await p.start('merge', 'B', '--without-fill').done;
    expect(second.code).toBe(1);
    expect(second.error).toMatch(/Another ravenseat merge is running in this repo: merge A/);
    expect(p.find('B')?.status).toBe('review');
    expect(p.contains(tipB)).toBe(false);
    expect((await first.done).code).toBe(0);
    expect(p.find('A')?.status).toBe('done');
    p.scenario({});
    expect((await p.start('merge', 'B', '--without-fill').done).code).toBe(0);
    expect(p.mergesOf(tipA)).toBe(1);
    expect(p.mergesOf(tipB)).toBe(1);
  }, 120_000);

  it('the same task twice at once: merged once, marked done once', async () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ gates: { sleepMs: 2000 } });
    const results = await Promise.all([p.start('merge', 'A', '--without-fill').done, p.start('merge', 'A', '--without-fill').done]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    expect(p.ranSteps().filter((s) => s === 'merge')).toEqual(['merge']);
    expect(p.find('A')?.status).toBe('done');
    expect(p.mergesOf(tip)).toBe(1);
    expect(fs.existsSync(p.lockFile)).toBe(false);
  }, 120_000);
});

describe('an agent dying in the middle of a track', () => {
  it('its commits and uncommitted work stay, and a new agent on the same branch is no fix round', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' }, { status: 'running' });
    const wt = path.join(p.repo, '.claude', 'worktrees', 'a');
    p.g(['worktree', 'add', '-q', wt, 'queue/A']);
    fs.writeFileSync(path.join(wt, 'unfinished.txt'), 'not committed yet\n');
    const r = p.run('resume', 'A', '--reason', 'context');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(p.find('A')?.status).toBe('running');
    expect(p.g(['rev-parse', 'queue/A'])).toBe(tip);
    expect(fs.readFileSync(path.join(wt, 'unfinished.txt'), 'utf8')).toBe('not committed yet\n');
    expect((p.find('A')?.resumed as { reason: string }[]).map((x) => x.reason)).toEqual(['context']);
    expect(fs.existsSync(path.join(p.scratch, 'prompt-A-r1.md'))).toBe(true);
    // Nothing was merged or marked delivered by the agent's death.
    expect(p.contains(tip)).toBe(false);
  });
});

describe('ravenseat receive killed in the middle of its checks', () => {
  it('the task stays running with no half-made review state, and the next receive finishes it', async () => {
    const p = project();
    const marker = path.join(p.folder, 'check-started');
    const pidFile = path.join(p.folder, 'check-pid');
    const quick = path.join(p.folder, 'second-run');
    const check = path.join(p.folder, 'check.mjs');
    // The done command: the first run says it started and then hangs; once the flag exists it passes at once.
    fs.writeFileSync(
      check,
      [
        "import fs from 'node:fs';",
        `if (fs.existsSync(${JSON.stringify(quick)})) process.exit(0);`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `fs.writeFileSync(${JSON.stringify(marker)}, 'x');`,
        'setTimeout(() => {}, 60000);',
        '',
      ].join('\n'),
    );
    const tip = p.track('A', { 'a.txt': 'from A\n' }, { status: 'running', done_when: `node "${check}"` });
    const wt = path.join(p.repo, '.claude', 'worktrees', 'a');
    p.g(['worktree', 'add', '-q', wt, 'queue/A']);
    const before = fs.readFileSync(p.queueFile, 'utf8');
    const first = p.start('receive', 'A');
    await waitFor(marker);
    first.child.kill('SIGKILL');
    await first.done;
    // The check itself is left running by the kill; it is ended here so nothing stays behind the test.
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ }
    expect(p.find('A')).toMatchObject({ status: 'running' });
    expect(p.find('A')?.done_check).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(p.queueFile, 'utf8')).tasks).toEqual(JSON.parse(before).tasks);
    // Receive makes its package again every time, so the next one just runs.
    fs.writeFileSync(quick, 'x');
    const again = await p.start('receive', 'A').done;
    expect(again.error).toBe('');
    expect(again.code).toBe(0);
    expect(p.find('A')?.status).toBe('review');
    expect(p.find('A')?.done_check).toMatchObject({ ok: true, tip });
    expect(p.contains(tip)).toBe(false);
  }, 120_000);
});

describe('a real conflict in the middle of a merge', () => {
  /** A task that conflicts with a commit made on develop after the branch. */
  function conflicting() {
    const p = project();
    const tip = p.track('A', { 'shared.txt': 'from A\n' });
    fs.writeFileSync(path.join(p.repo, 'shared.txt'), 'from develop\n');
    p.g(['add', '--', 'shared.txt']);
    p.g(['commit', '-q', '-m', 'develop changes shared']);
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.out).toMatch(/STOP in the step merge/);
    expect(p.ranSteps()).toEqual(['merge']);
    expect(p.gTry(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status).toBe(0);
    expect(p.find('A')?.status).toBe('review');
    expect(fs.existsSync(p.lockFile)).toBe(false);
    return { p, tip, out: m.out };
  }

  it('undone with git merge --abort: the task is untouched, and the next merge tries again', () => {
    const { p, tip } = conflicting();
    // While git has the merge open, every merge refuses and says how to get out.
    const busy = p.run('merge', 'A', '--without-fill');
    expect(busy.code).toBe(1);
    expect(busy.error).toContain('git merge --abort');
    p.g(['merge', '--abort']);
    expect(p.contains(tip)).toBe(false);
    // Moved out of the way, the merge goes through.
    p.g(['revert', '--no-edit', 'HEAD']);
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(p.find('A')?.status).toBe('done');
    expect(p.mergesOf(tip)).toBe(1);
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
  });

  it('resolved by hand: --resume runs only the rest', () => {
    const { p, tip, out } = conflicting();
    expect(out).toContain('merge A --resume');
    fs.writeFileSync(path.join(p.repo, 'shared.txt'), 'from develop and A\n');
    p.g(['add', '--', 'shared.txt']);
    p.g(['commit', '-q', '--no-edit']);
    p.ranSteps();
    const r = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(p.ranSteps()).toEqual(['gates', 'done']);
    expect(p.find('A')?.status).toBe('done');
    expect(p.mergesOf(tip)).toBe(1);
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
  });
});
