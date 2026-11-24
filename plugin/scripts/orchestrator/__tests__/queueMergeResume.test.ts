// =============================================================
// queueMergeResume.test.ts: `ravenseat merge` that survives interruptions (review 2026-11-02, package C: M6, M7, M8).
//
// Locks: (1) a merge left in place (MERGE_HEAD from an earlier conflict) refuses `ravenseat merge B` with how to finish or
// undo it, and merge-track.mjs refuses too (exit 5); finished by hand, `ravenseat merge A --resume` runs the rest; (2) the
// track tip must be in the base: a merge step that says "merged" without merging is a stop, and a base that loses the
// merge before `done` is never marked done; (3) the merge lock: a held lock refuses a second merge (nothing runs), a
// stale one (dead pid, or too old on another host) is taken over, and the lock is gone after a stop; (4) an interrupted
// merge (Ctrl-C in a step, or a crash) leaves the merge state and no lock; a plain `ravenseat merge` then says to resume, and
// `ravenseat merge <id> --resume` runs only the steps that are left, marks done once and removes the state.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and git repo (QUEUE_GIT), with an injected merge runner
// (QUEUE_MERGE_RUNNING) that merges with plain git (merge-track.mjs refuses a test identity) and runs the other steps
// as ravenseat merge would, unless the scenario file says otherwise for a step. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const MERGE_TRACK = path.join(ROOT, 'scripts', 'orchestrator', 'merge-track.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

/** A temporary project: repo on develop, a queue, a config without gates, and the merge runner with a scenario file. */
function project() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-mergeresume-'));
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
  const writeQueue = () =>
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks }),
    );
  writeQueue();
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
  // The runner: the scenario file can answer a step itself ({ code, out }, { signal }, { crash: true }, { fake: true } =
  // "merged" without merging, { resetBase: true } = run the step, then reset develop to before the merge). Otherwise a
  // real merge with plain git, or the real command. Every step is logged.
  const runner = path.join(folder, 'runner.mjs');
  const steps = path.join(folder, 'steps.log');
  const scenarioFile = path.join(folder, 'scenario.json');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      `const ID = ${JSON.stringify(ID)};`,
      'export default ({ step, cmd, args }) => {',
      `  fs.appendFileSync(${JSON.stringify(steps)}, step + '\\n');`,
      `  const sc = fs.existsSync(${JSON.stringify(scenarioFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8')) : {};`,
      '  const x = sc[step];',
      "  if (x && x.crash) throw new Error('the test runner crashed in ' + step);",
      "  if (x && x.signal) return { code: null, signal: x.signal, out: '' };",
      "  if (x && x.fake) return { code: 0, out: 'Merged (fake)' };",
      "  if (x && 'code' in x) return x;",
      '  const repo = process.env.QUEUE_GIT;',
      "  const r = step === 'merge'",
      "    ? spawnSync('git', ['-C', repo, ...ID, 'merge', '--no-ff', '--no-edit', args[1]], { encoding: 'utf8' })",
      "    : spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: process.env });",
      "  if (x && x.resetBase) spawnSync('git', ['-C', repo, 'reset', '-q', '--hard', 'HEAD~1'], { encoding: 'utf8' });",
      "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') + (step === 'merge' && r.status === 0 ? '\\nMerged by the test runner' : '') };",
      '};',
      '',
    ].join('\n'),
  );
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
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const scenario = (s: Record<string, unknown>) => fs.writeFileSync(scenarioFile, JSON.stringify(s));
  const ranSteps = () => {
    const t = fs.existsSync(steps) ? fs.readFileSync(steps, 'utf8') : '';
    fs.rmSync(steps, { force: true });
    return t.split('\n').filter(Boolean);
  };
  const find = (id: string) =>
    (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] }).tasks.find((t) => t.id === id);
  const lockFile = path.join(folder, '.mergeLock'); // a lib/queueLock.js folder (LAGRING step 6)
  const legacyLock = path.join(folder, 'merge.lock'); // the lock file of older versions, still honoured
  const stateFile = (id: string) => path.join(folder, `merge-state-${id}.json`);
  const state = (id: string) => JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
  /** A track in review: branch queue/<id> from develop with the files committed. */
  const track = (id: string, files: Record<string, string>) => {
    g(['switch', '-q', '-c', `queue/${id}`, 'develop']);
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), text);
    g(['add', '--', ...Object.keys(files)]);
    g(['commit', '-q', '-m', `feat: ${id}`]);
    g(['switch', '-q', 'develop']);
    tasks.push({
      id,
      title: `Task ${id}`,
      domain: 'dom',
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
    } as Task);
    writeQueue();
    return g(['rev-parse', `queue/${id}`]);
  };
  const contains = (tip: string) => gTry(['merge-base', '--is-ancestor', tip, 'develop']).status === 0;
  return { folder, repo, g, gTry, run, scenario, ranSteps, find, lockFile, legacyLock, stateFile, state, track, contains };
}

/** A pid that is certainly not running: a child that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

describe('ravenseat merge refuses a merge left in place (M6)', () => {
  it('MERGE_HEAD from an earlier conflict: ravenseat merge B and merge-track refuse; finished by hand, A --resume runs the rest', () => {
    const p = project();
    const tipA = p.track('A', { 'shared.txt': 'from A\n' });
    p.track('B', { 'b.txt': 'from B\n' });
    // A conflicting commit on develop, then a merge of A by hand that stops on the conflict (MERGE_HEAD stays).
    fs.writeFileSync(path.join(p.repo, 'shared.txt'), 'from develop\n');
    p.g(['add', '--', 'shared.txt']);
    p.g(['commit', '-q', '-m', 'develop changes shared']);
    expect(p.gTry(['merge', '--no-ff', '--no-edit', 'queue/A']).status).not.toBe(0);
    const m = p.run('merge', 'B', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.error).toMatch(/A merge is in progress/);
    expect(m.error).toContain(`MERGE_HEAD ${tipA.slice(0, 12)}, the tip of queue/A`);
    expect(m.error).toContain('git merge --abort');
    expect(m.error).toContain('merge A --resume');
    expect(p.ranSteps()).toEqual([]);
    expect(p.find('B')?.status).toBe('review');
    expect(fs.existsSync(p.lockFile)).toBe(false);
    // merge-track.mjs refuses on its own too (exit 5), before the merge (an identity that passes its identity guard).
    const mt = spawnSync(process.execPath, [MERGE_TRACK, 'queue/B'], {
      cwd: p.repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        QUEUE_FOLDER: p.folder,
        QUEUE_CONFIG: path.join(p.folder, 'queue.config.json'),
        GIT_AUTHOR_NAME: 'Owner',
        GIT_AUTHOR_EMAIL: 'owner@ravenseat.test',
        GIT_COMMITTER_NAME: 'Owner',
        GIT_COMMITTER_EMAIL: 'owner@ravenseat.test',
      },
    });
    expect(mt.status).toBe(5);
    expect(mt.stderr).toMatch(/A merge is in progress in this checkout \(MERGE_HEAD/);
    expect(p.contains(p.g(['rev-parse', 'queue/B']))).toBe(false);
    // --resume while the merge is still unfinished: the same refusal, nothing runs.
    const r0 = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r0.code).toBe(1);
    expect(r0.error).toMatch(/A merge is in progress/);
    expect(p.ranSteps()).toEqual([]);
    // Resolved and committed by hand: --resume runs the steps after the merge and marks A done.
    fs.writeFileSync(path.join(p.repo, 'shared.txt'), 'from develop and A\n');
    p.g(['add', '--', 'shared.txt']);
    p.g(['commit', '-q', '--no-edit']);
    const mergeCommit = p.g(['rev-parse', 'develop']);
    const r1 = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r1.error).toBe('');
    expect(r1.code).toBe(0);
    expect(r1.out).toContain(`RESUME A: queue/A at ${tipA.slice(0, 12)} is in develop (merge commit ${mergeCommit.slice(0, 12)})`);
    expect(p.ranSteps()).toEqual(['gates', 'done']);
    expect(p.find('A')).toMatchObject({ status: 'done', merge_commit: mergeCommit });
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
    // B merges normally now.
    expect(p.run('merge', 'B', '--without-fill').code).toBe(0);
    expect(p.find('B')?.status).toBe('done');
  });
});

describe('ravenseat merge checks that the track tip is in the base before done (M6)', () => {
  it('a merge step that says merged without merging is a stop, never a done task', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ merge: { fake: true } });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.out).toMatch(/STOP in the step merge/);
    expect(m.out).toContain('NOT MERGED');
    expect(p.ranSteps()).toEqual(['merge']);
    expect(p.find('A')?.status).toBe('review');
    expect(p.find('A')?.merge_commit).toBeUndefined();
    expect(fs.existsSync(p.lockFile)).toBe(false);
  });

  it('a base that loses the merge before done: not marked done, the reason is printed', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ gates: { resetBase: true } });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.out).toMatch(/STOP in the step done: NOT DONE: queue\/A at [0-9a-f]{12} is not in develop/);
    expect(p.ranSteps()).toEqual(['merge', 'gates']);
    expect(p.contains(tip)).toBe(false);
    expect(p.find('A')?.status).toBe('review');
    // The merge commit was recorded when the merge went through (doctor can see it is no longer in base).
    expect(typeof p.find('A')?.merge_commit).toBe('string');
    expect(fs.existsSync(p.lockFile)).toBe(false);
  });

  it('a green merge stores merge_commit, the commit that holds the tip', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(0);
    const mc = p.find('A')?.merge_commit as string;
    expect(mc).toBe(p.g(['rev-parse', 'develop']));
    expect(p.gTry(['merge-base', '--is-ancestor', tip, mc]).status).toBe(0);
    expect(p.find('A')?.status).toBe('done');
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
    // The merged queue branch is gone; its commits are in the base.
    expect(m.out).toContain('Branch: queue/A deleted (merged).');
    expect(p.gTry(['rev-parse', '-q', '--verify', 'refs/heads/queue/A']).status).not.toBe(0);
  });

  it('--resume removes the worktree and the branch too', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    const wt = path.join(p.repo, '.claude', 'worktrees', 'a');
    p.g(['worktree', 'add', '-q', wt, 'queue/A']);
    p.scenario({ gates: { signal: 'SIGINT' } });
    p.run('merge', 'A', '--without-fill');
    p.scenario({});
    const r = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Worktree: removed/);
    expect(fs.existsSync(wt)).toBe(false);
    expect(r.out).toContain('Branch: queue/A deleted (merged).');
  });
});

// These write a merge.lock FILE as an older version left it: lib/mergeLock.js judges it by the old rule
// (staleReason), so a live holder still refuses and a stale one is taken over with the same message.
describe('the merge lock: one ravenseat merge at a time (M8)', () => {
  it('a held lock refuses a second merge; nothing runs and the lock stays', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    const holder = { pid: process.pid, host: os.hostname(), started: new Date().toISOString(), task: 'OTHER', command: 'merge' };
    fs.writeFileSync(p.legacyLock, JSON.stringify(holder));
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.error).toMatch(/Another ravenseat merge is running in this repo: merge OTHER \(pid \d+ on .+, started /);
    expect(m.error).toContain('One merge at a time; nothing was done.');
    expect(p.ranSteps()).toEqual([]);
    expect(p.find('A')?.status).toBe('review');
    expect(JSON.parse(fs.readFileSync(p.legacyLock, 'utf8'))).toEqual(holder);
  });

  it('a stale lock is taken over: a dead pid on this host, or an old lock from another host', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    p.track('B', { 'b.txt': 'from B\n' });
    fs.writeFileSync(
      p.legacyLock,
      JSON.stringify({ pid: deadPid(), host: os.hostname(), started: new Date().toISOString(), task: 'GONE', command: 'merge' }),
    );
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).toMatch(/took over a stale merge lock \(merge GONE: the process \d+ on .+ is no longer running\)/);
    expect(m.out).toContain('merge GONE --resume');
    expect(fs.existsSync(p.legacyLock)).toBe(false);
    const old = new Date(Date.now() - 7 * 3600_000).toISOString();
    fs.writeFileSync(p.legacyLock, JSON.stringify({ pid: process.pid, host: 'another-machine', started: old, task: 'FAR' }));
    const m2 = p.run('merge', 'B', '--without-fill');
    expect(m2.code).toBe(0);
    expect(m2.out).toMatch(/took over a stale merge lock \(merge FAR: it is older than 360 min/);
    expect(fs.existsSync(p.legacyLock)).toBe(false);
    expect(fs.existsSync(p.lockFile)).toBe(false);
  });

  it('the lock is released after a stop', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ gates: { code: 1, out: 'FAIL lint' } });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.out).toMatch(/STOP in the step gates/);
    expect(m.out).toContain('merge A --resume runs the steps that are left (gates, done)');
    expect(fs.existsSync(p.lockFile)).toBe(false);
  });
});

describe('ravenseat merge --resume after an interruption (M7)', () => {
  it('Ctrl-C in the gates: state kept, no lock; plain merge says resume; --resume runs gates and done once', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ gates: { signal: 'SIGINT' } });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(130);
    expect(m.error).toMatch(/INTERRUPTED \(SIGINT\) in the step gates/);
    expect(m.error).toContain('merge A --resume');
    expect(p.ranSteps()).toEqual(['merge', 'gates']);
    expect(fs.existsSync(p.lockFile)).toBe(false);
    expect(p.contains(tip)).toBe(true);
    const s = p.state('A');
    expect(s).toMatchObject({ task: 'A', current: 'gates', steps_done: ['merge'], track_tip: tip });
    expect(s.interrupted).toMatchObject({ step: 'gates', by: 'SIGINT' });
    expect(s.merge_commit).toBe(p.g(['rev-parse', 'develop']));
    expect(p.find('A')).toMatchObject({ status: 'review', merge_commit: s.merge_commit });
    // A plain merge: the branch is in base already, and the message says what to run.
    p.scenario({});
    const again = p.run('merge', 'A', '--without-fill');
    expect(again.code).toBe(1);
    expect(again.error).toMatch(/already merged into develop .* but A is still in review/);
    expect(again.error).toContain('steps done: merge');
    expect(again.error).toContain('merge A --resume');
    expect(p.ranSteps()).toEqual([]);
    // --resume: only the steps that are left.
    const r = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MERGE A \(queue\/A\): gates → done/);
    expect(p.ranSteps()).toEqual(['gates', 'done']);
    expect(p.find('A')).toMatchObject({ status: 'done', merge_commit: s.merge_commit });
    expect(typeof p.find('A')?.t_merge).toBe('string');
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
    expect(fs.existsSync(p.lockFile)).toBe(false);
    // Nothing is left: a second resume says so and does nothing.
    const r2 = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r2.code).toBe(0);
    expect(r2.out).toContain('A is done; nothing to resume.');
    expect(p.ranSteps()).toEqual([]);
  });

  it('a crash in the done step: the lock goes, the state says done is left, --resume runs only done', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    p.scenario({ done: { crash: true } });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).not.toBe(0);
    expect(p.ranSteps()).toEqual(['merge', 'gates', 'done']);
    expect(fs.existsSync(p.lockFile)).toBe(false);
    expect(p.state('A')).toMatchObject({ current: 'done', steps_done: ['merge', 'gates'] });
    p.scenario({});
    const r = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r.code).toBe(0);
    expect(p.ranSteps()).toEqual(['done']);
    expect(p.find('A')?.status).toBe('done');
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
  });

  it('--resume on a branch that is not merged refuses and points to a plain merge', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    const r = p.run('merge', 'A', '--resume', '--without-fill');
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/is not in develop, so there is nothing to resume/);
    expect(r.error).toContain('(without --resume)');
    expect(p.ranSteps()).toEqual([]);
    expect(fs.existsSync(p.lockFile)).toBe(false);
  });
});

describe('ravenseat merge --allow-partial keeps the rest of the task (MERGE-PARTIAL-REVIEW)', () => {
  /** Edits a task in queue.json directly (after p.track, which writes the whole file again). */
  const patch = (folder: string, id: string, fn: (t: Task) => void) => {
    const file = path.join(folder, 'queue.json');
    const q = JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks: Task[] };
    fn(q.tasks.find((x) => x.id === id) as Task);
    fs.writeFileSync(file, JSON.stringify(q));
  };
  // What the receive of a PARTIAL delivery leaves on the task.
  const markPartial = (t: Task) => {
    t.delivered_partial = true;
  };

  it('merges, but the task stays in review with a remark, delivered_partial stays, and resume --reason context continues it', () => {
    const p = project();
    const tip = p.track('A', { 'a.txt': 'from A\n' });
    p.track('B', { 'b.txt': 'from B\n' });
    // B waits on A: a merge that carries only part of A must not free it.
    patch(p.folder, 'B', (t) => {
      t.depends_on = ['A'];
      t.status = 'waiting';
    });
    patch(p.folder, 'A', markPartial);
    const m = p.run('merge', 'A', '--allow-partial', '--without-fill');
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    // The merge itself happened as today: the tip is in the base and the merge commit is on the task.
    expect(p.contains(tip)).toBe(true);
    expect(p.ranSteps()).toEqual(['merge', 'gates']);
    const a = p.find('A') as Task;
    expect(a.status).toBe('review');
    expect(a.delivered_partial).toBe(true);
    expect(a.done).toBeUndefined();
    expect(typeof a.merge_commit).toBe('string');
    expect((a.remarks as string[]).join('\n')).toMatch(/--allow-partial.*the rest of the task remains/);
    expect(p.find('B')?.status).toBe('waiting');
    // Said plainly, with the command that continues it.
    expect(m.out).toMatch(/A stays in review/);
    expect(m.out).toContain('resume A --reason context');
    // The branch is kept for the continuation (a done merge deletes a merged queue branch).
    expect(p.gTry(['rev-parse', '-q', '--verify', 'refs/heads/queue/A']).status).toBe(0);
    expect(fs.existsSync(p.stateFile('A'))).toBe(false);
    // A second merge, or a resume of the merge, points to the rest instead of the cut-off-merge advice.
    for (const args of [['merge', 'A', '--without-fill'], ['merge', 'A', '--resume', '--without-fill']]) {
      const again = p.run(...args);
      expect(again.code).toBe(1);
      expect(again.error).toContain('stays in review');
      expect(again.error).toContain('resume A --reason context');
    }
    expect(p.ranSteps()).toEqual([]);
    expect(p.find('A')?.status).toBe('review');
    // The continuation of the rest.
    const scratch = path.join(p.folder, 'scratch');
    const r = p.run('resume', 'A', '--reason', 'context', '--scratchpad', scratch);
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('RESUME A-r1 (context)');
    expect(p.find('A')).toMatchObject({ status: 'review', delivered_partial: true });
  });

  it('a merge without the flag still stops, and a merge of a finished delivery still ends done', () => {
    const p = project();
    p.track('A', { 'a.txt': 'from A\n' });
    patch(p.folder, 'A', markPartial);
    const stop = p.run('merge', 'A', '--without-fill');
    expect(stop.code).not.toBe(0);
    expect(stop.error).toContain('--allow-partial');
    expect(p.ranSteps()).toEqual([]);
    p.track('C', { 'c.txt': 'from C\n' });
    expect(p.run('merge', 'C', '--without-fill').code).toBe(0);
    expect(p.find('C')?.status).toBe('done');
  });
});
