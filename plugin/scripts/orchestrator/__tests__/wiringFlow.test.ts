// =============================================================
// wiringFlow.test.ts: the wiring spec as open items that stop `done` (lib/wiringItems.js), through the real CLI.
//
// Locks: (1) `receive` records each WIRE line of track-result.md as an open item on the task, and a second receive of
// the same report adds nothing; (2) info, state, next and show name the open items; (3) the done step of `merge` and
// `set <id> done` refuse while one is open, with one line per item and the commands that close it; (4) `wiring <task>
// <item> --commit <sha>` refuses an unknown sha, a non-sha, a commit outside the base branch and a commit that does not
// touch the target file, and closes the item with a commit on the base that does; (5) `--reject` refuses an empty
// reason and closes with one; (6) `merge --resume` then sets the task done; (7) a track worktree cannot close items;
// (8) wiring.stop false lets `set done` pass with open items, says so, and doctor and settings report it as weakened.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER), a temporary git repo (QUEUE_GIT) with a worktree for the track
// branch and an injected merge runner (QUEUE_MERGE_RUNNING), as queueDoneCheck.test.ts. Never the main repo or queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Item = { id: string; file: string | null; text: string; status: string; commit?: string; reason?: string; closed?: string };
type Task = Record<string, unknown> & { id: string; status: string; wiring?: Item[] };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

/** A temporary project: a repo on develop with src/routes.ts and src/registry.ts, and a track branch queue/A in a worktree. */
function project(config: object = {}, extra: Partial<Task> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-wiring-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(scratch);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'src', 'routes.ts'), 'export const routes = [];\n');
  fs.writeFileSync(path.join(repo, 'src', 'registry.ts'), 'export const registry = [];\n');
  g(['add', '--', 'src/routes.ts', 'src/registry.ts']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.mkdirSync(path.join(worktree, 'lib'));
  fs.writeFileSync(path.join(worktree, 'lib', 'A.ts'), 'export const a = 1;\n');
  g(['add', '--', 'lib/A.ts'], worktree);
  g(['commit', '-q', '-m', 'feat: A'], worktree);
  const task: Task = {
    id: 'A',
    title: 'Task A',
    domain: 'dom-A',
    class: 'K',
    status: 'running',
    mission: 'The mission for A.',
    value: 5,
    content_min: 60,
    depends_on: [],
    waiting_on: [],
    owned_files: ['lib/A.ts'],
    started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A',
    migr_block: null,
    scratchpad: scratch,
    ...extra,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', ...config }));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  // The merge runner: the merge step merges for real, the done step runs the real `set <id> done`, the rest is green.
  const runner = path.join(folder, 'runner.mjs');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      'export default (x) => {',
      "  if (x.step === 'merge') spawnSync('git', ['-C', process.env.QUEUE_GIT, '-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', 'merge', '--no-ff', '--no-edit', x.args[1]], { encoding: 'utf8' });",
      "  if (x.step === 'done') { const r = spawnSync(x.cmd, x.args, { encoding: 'utf8', env: process.env }); return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; }",
      "  return { code: 0, out: '' };",
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
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (args: string[], cwd = folder) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env,
      cwd,
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const find = () => (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] }).tasks[0];
  const report = (text: string) => {
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    const f = path.join(scratch, 'A', 'track-result.md');
    fs.writeFileSync(f, text);
    const later = Date.now() / 1000 + 60;
    fs.utimesSync(f, later, later);
  };
  return { folder, repo, worktree, g, run, find, report };
}

const SPEC = [
  RES,
  '',
  '# Report A',
  '',
  '## Wiring specification',
  'WIRE src/routes.ts | after the last import add the A route: `{ path: "/a", view: A }`',
  '- WIRE src/registry.ts | append `registry.push(A)` at the end of the list',
  '',
].join('\n');

describe('the wiring spec stops done until each item is closed', () => {
  it('receive records two items, done refuses, one closed by commit, one rejected with a reason, then done passes', () => {
    const p = project();
    p.report(SPEC);

    // ---- 1. receive records each WIRE line as an open item, and says so ----
    const r1 = p.run(['receive', 'A']);
    expect(r1.error).toBe('');
    expect(r1.code).toBe(0);
    expect(r1.out).toContain('WIRING: 2 open item(s)');
    expect(r1.out).toContain('W1 src/routes.ts');
    expect(p.find().wiring).toMatchObject([
      { id: 'W1', file: 'src/routes.ts', status: 'open', text: 'after the last import add the A route: `{ path: "/a", view: A }`' },
      { id: 'W2', file: 'src/registry.ts', status: 'open', text: 'append `registry.push(A)` at the end of the list' },
    ]);
    // The same report again: nothing new.
    expect(p.run(['receive', 'A']).code).toBe(0);
    expect(p.find().wiring).toHaveLength(2);

    // ---- 2. Shown where the orchestrator looks ----
    const info = p.run(['show', 'A']);
    expect(info.out).toMatch(/wiring: 2 open of 2/);
    expect(info.out).toContain('W2 src/registry.ts');
    const state = JSON.parse(p.run(['state']).out);
    expect(state.wiring).toEqual([
      expect.objectContaining({ task: 'A', item: 'W1', file: 'src/routes.ts' }),
      expect.objectContaining({ task: 'A', item: 'W2', file: 'src/registry.ts' }),
    ]);
    expect(p.run(['next']).all).toContain('OPEN WIRING (2): A W1 src/routes.ts, A W2 src/registry.ts');
    expect(p.run(['show']).all).toContain('OPEN WIRING (2)');
    expect(p.run(['wiring', 'A']).out).toContain('open     W1 src/routes.ts');

    // ---- 3. merge: the merge goes in, the done step refuses with the items and the commands ----
    const m1 = p.run(['merge', 'A', '--without-fill']);
    expect(m1.code).toBe(1);
    expect(m1.out).toContain('STOP in the step done');
    expect(m1.out).toContain('NOT DONE: A has 2 open wiring item(s)');
    expect(m1.out).toContain('W1 src/routes.ts');
    expect(m1.out).toContain('wiring A W1 --commit <sha>');
    expect(m1.out).toContain('wiring A W2 --reject "<reason>"');
    expect(m1.out).toContain('merge A --resume');
    expect(p.find().status).toBe('review');
    const mergeCommit = p.find().merge_commit as string;
    expect(mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    // set done by hand refuses the same way, one line per item.
    const s1 = p.run(['set', 'A', 'done']);
    expect(s1.code).toBe(1);
    expect(s1.all).toContain('NOT DONE: A has 2 open wiring item(s)');
    expect(s1.all).toContain('W2 src/registry.ts');
    expect(p.find().status).toBe('review');

    // ---- 4. Closing by commit: bad sha, a non-sha, a commit that does not touch the file are refused ----
    const bad = p.run(['wiring', 'A', 'W1', '--commit', 'deadbeefdeadbeef']);
    expect(bad.code).toBe(1);
    expect(bad.all).toContain('no commit deadbeefdeadbeef');
    const option = p.run(['wiring', 'A', 'W1', '--commit', '--output=x']);
    expect(option.code).toBe(1);
    expect(option.all).toMatch(/--commit needs a commit sha/);
    const notTouching = p.run(['wiring', 'A', 'W1', '--commit', mergeCommit]);
    expect(notTouching.code).toBe(1);
    expect(notTouching.all).toContain('does not change src/routes.ts');
    // A commit that touches the file but is not on the base branch.
    p.g(['checkout', '-q', '-b', 'side']);
    fs.writeFileSync(path.join(p.repo, 'src', 'routes.ts'), 'export const routes = ["side"];\n');
    p.g(['commit', '-q', '-am', 'side']);
    const side = p.g(['rev-parse', 'HEAD']);
    p.g(['checkout', '-q', 'develop']);
    const offBase = p.run(['wiring', 'A', 'W1', '--commit', side]);
    expect(offBase.code).toBe(1);
    expect(offBase.all).toContain('is not in develop');
    expect(p.find().wiring?.[0].status).toBe('open');
    // A track worktree cannot close one.
    const fromTrack = p.run(['wiring', 'A', 'W2', '--reject', 'not needed'], p.worktree);
    expect(fromTrack.code).toBe(1);
    expect(fromTrack.all).toContain('track worktree');
    // The real one: on develop, touching src/routes.ts.
    fs.writeFileSync(path.join(p.repo, 'src', 'routes.ts'), 'export const routes = [{ path: "/a" }];\n');
    p.g(['commit', '-q', '-am', 'wire A route']);
    const wire = p.g(['rev-parse', 'HEAD']);
    const ok1 = p.run(['wiring', 'A', 'W1', '--commit', wire.slice(0, 10)]);
    expect(ok1.error).toBe('');
    expect(ok1.code).toBe(0);
    expect(ok1.out).toContain('W1 done');
    expect(p.find().wiring?.[0]).toMatchObject({ status: 'done', commit: wire });
    expect(p.find().wiring?.[0].closed).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Closed is closed.
    expect(p.run(['wiring', 'A', 'W1', '--commit', wire]).all).toContain('already done');

    // ---- 5. Rejecting: an empty reason is refused, a reason closes it ----
    for (const empty of [[], [''], ['   ']]) {
      const r = p.run(['wiring', 'A', 'W2', '--reject', ...empty]);
      expect(r.code, JSON.stringify(empty)).toBe(1);
      expect(r.all).toMatch(/--reject needs a reason/);
    }
    // Neither, or both, is refused too.
    expect(p.run(['wiring', 'A', 'W2']).code).toBe(1);
    expect(p.run(['wiring', 'A', 'W2', '--commit', wire, '--reject', 'x']).code).toBe(1);
    const ok2 = p.run(['wiring', 'A', 'W2', '--reject', 'the registry reads the folder itself']);
    expect(ok2.code).toBe(0);
    expect(p.find().wiring?.[1]).toMatchObject({ status: 'rejected', reason: 'the registry reads the folder itself' });
    expect(p.find().wiring?.[1].closed).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.parse(p.run(['state']).out).wiring).toEqual([]);

    // ---- 6. Nothing open: the merge's remaining steps set it done ----
    const m2 = p.run(['merge', 'A', '--resume', '--without-fill']);
    expect(m2.all).not.toContain('NOT DONE');
    expect(m2.code).toBe(0);
    expect(p.find().status).toBe('done');
  });

  it('a WIRE line with a path that leaves the repo still stops done, and can only be rejected', () => {
    const p = project();
    p.report(`${RES}\n\nWIRE ../outside.ts | add it\nWIRE none\n`);
    const r = p.run(['receive', 'A']);
    expect(r.code).toBe(0);
    expect(p.find().wiring).toMatchObject([{ id: 'W1', file: null, status: 'open' }]);
    expect(p.run(['set', 'A', 'done']).code).toBe(1);
    expect(p.run(['wiring', 'A', 'W1', '--commit', p.g(['rev-parse', 'HEAD'])]).all).toContain('no valid target file');
    expect(p.run(['wiring', 'A', 'W1', '--reject', 'applied by hand in src/routes.ts']).code).toBe(0);
    expect(p.run(['set', 'A', 'done']).code).toBe(0);
  });

  it('wiring.stop false lets done pass with open items, says so, and is reported as a weakened guard', () => {
    const item: Item = { id: 'W1', file: 'src/routes.ts', text: 'add the A route', status: 'open' };
    const p = project({ wiring: { stop: false } }, { status: 'review', delivered: '2026-01-01T01:00:00.000Z', wiring: [item] });
    const s = p.run(['set', 'A', 'done']);
    expect(s.error).not.toContain('NOT DONE');
    expect(s.code).toBe(0);
    expect(s.all).toContain('WIRING STOP OFF');
    expect(s.all).toContain('W1 src/routes.ts');
    expect(p.find().status).toBe('done');
    expect(p.find().wiring?.[0].status).toBe('open');
    // Still shown as open, and the weakening is named.
    expect(JSON.parse(p.run(['state']).out).wiring).toHaveLength(1);
    expect(p.run(['doctor']).all).toContain('wiring.stop off');
    expect(p.run(['settings']).all).toMatch(/Weakened guards: 1 \(wiring\.stop/);
    expect(p.run(['settings', '--advanced']).all).toMatch(/wiring\.stop[^\n]*\[weakened\]/);
  });
});
