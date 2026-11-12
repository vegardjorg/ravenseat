// =============================================================
// redteam/mergeTipLock.test.ts: two holes in the merge that the review of 2026-11-11 found (G2 and V2).
//
// Why:
//   G2. The checks before a merge (the red gate at receive, the done command, the focus markers) look at one tip of the
//       track branch, but merge-track.mjs was given the branch NAME and ran `git merge <branch>`. A commit that landed
//       on the branch between the checks and the merge went in without receive or review, and the check after the merge
//       only asked whether HEAD contains the checked tip (it still does). Now the checked sha is what is merged, a
//       branch that moved stops the merge, and after the merge HEAD^2 must be exactly that sha.
//   V2. A conflict the text merge cannot resolve left the main checkout in the middle of a merge (MERGE_HEAD, conflict
//       markers in the files). Now a trial merge of the same sha (git merge-tree --write-tree, which writes objects
//       only) runs first, and such a conflict stops before git touches the checkout. Conflicts the text merge resolves
//       still merge. A git older than 2.38 (no --write-tree) keeps the old way, with a note.
// Each scenario runs the real scripts in a temporary repo; git is never mocked.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { project } from './project';

const SCRIPT = path.resolve(__dirname, '..', '..', 'merge-track.mjs');
const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** A repo on main with a.txt, a queue where task A owns it, and a runner for merge-track.mjs queue/A. */
function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-tip-lock-'));
  made.push(repo);
  const g = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Merge Track Owner');
  g('config', 'user.email', 'owner@ravenseat.dev');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'base');
  const data = path.join(repo, '.queue-data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.queue-data/\n');
  fs.writeFileSync(
    path.join(data, 'queue.json'),
    JSON.stringify({ tasks: [{ id: 'A', branch: 'queue/A', owned_files: ['a.txt', 'b.txt'], shared_patch: [] }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QUEUE_ROOT: repo,
    QUEUE_CONFIG: path.join(repo, 'no-config.json'),
    QUEUE_FOLDER: data,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
  };
  delete env.QUEUE_GIT_VERSION;
  const run = (extra: string[] = [], more: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, 'queue/A', '--keep-worktree', ...extra], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, ...more },
    });
  const write = (file: string, content: string) => fs.writeFileSync(path.join(repo, file), content);
  const mergeHead = () => fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'));
  return { repo, g, run, write, mergeHead };
}

describe('G2: the checked tip is the one merged', () => {
  it('a commit that lands on the branch after the checks is not merged: the merge stops and names it', () => {
    const { g, run, write, mergeHead } = setup();
    g('switch', '-q', '-c', 'queue/A');
    write('a.txt', 'one\ntwo\nthree\nfour\n');
    g('commit', '-q', '-am', 'track: checked');
    const checked = g('rev-parse', 'HEAD');
    write('b.txt', 'not checked\n');
    g('add', 'b.txt');
    g('commit', '-q', '-m', 'track: landed after the checks');
    const late = g('rev-parse', 'HEAD');
    g('switch', '-q', 'main');
    const head = g('rev-parse', 'HEAD');
    const r = run(['--tip', checked]);
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/moved after the checks/);
    expect(`${r.stdout}${r.stderr}`).toContain(late.slice(0, 12));
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(mergeHead()).toBe(false);
    expect(spawnSync('git', ['merge-base', '--is-ancestor', late, 'main']).status).not.toBe(0);
  });

  it('the merge commit has the checked sha as its second parent and names the branch', () => {
    const { g, run, write } = setup();
    g('switch', '-q', '-c', 'queue/A');
    write('a.txt', 'one\ntwo\nthree\nfour\n');
    g('commit', '-q', '-am', 'track');
    const checked = g('rev-parse', 'HEAD');
    g('switch', '-q', 'main');
    const r = run(['--tip', checked]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(g('rev-parse', 'HEAD^2')).toBe(checked);
    expect(g('log', '-1', '--format=%s')).toMatch(/^Merge branch 'queue\/A'/);
  });

  it('ravenseat merge stops when the branch moves between its checks and the merge step', () => {
    const p = project();
    const scratch = p.localDelivers('A');
    expect(p.run('receive', 'A', '--scratchpad', scratch).code).toBe(0);
    const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
    // The merge step's runner: a commit lands on queue/A first (the race), then the real step runs with the real args.
    const runner = path.join(p.folder, 'race-runner.mjs');
    fs.writeFileSync(
      runner,
      [
        "import { spawnSync } from 'node:child_process';",
        'export default ({ step, cmd, args }) => {',
        "  if (step === 'merge') spawnSync('git', ['-C', " +
          `${JSON.stringify(wt)}, '-c', 'user.name=Late', '-c', 'user.email=late@example.invalid', 'commit', '-q', ` +
          "'--allow-empty', '-m', 'landed after the checks'], { encoding: 'utf8' });",
        `  const r = spawnSync(cmd, args, { cwd: ${JSON.stringify(p.repo)}, encoding: 'utf8', env: process.env });`,
        "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };",
        '};',
        '',
      ].join('\n'),
    );
    (p.env as NodeJS.ProcessEnv).QUEUE_MERGE_RUNNING = runner;
    const before = p.g(['rev-parse', 'main']);
    const m = p.run('merge', 'A', '--scratchpad', scratch);
    expect(m.code, m.out).not.toBe(0);
    expect(m.out).toMatch(/moved after the checks/);
    expect(p.g(['rev-parse', 'main'])).toBe(before);
    expect(p.taskOf('A')?.status).toBe('review');
  }, 240_000);

  it('ravenseat merge does not mark done when the merge commit holds more than the checked tip', () => {
    const p = project();
    const scratch = p.localDelivers('A');
    expect(p.run('receive', 'A', '--scratchpad', scratch).code).toBe(0);
    const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
    // A merge step that merges the branch by name after it moved: what the check after the merge must catch.
    const runner = path.join(p.folder, 'name-runner.mjs');
    const id = "'-c', 'user.name=Late', '-c', 'user.email=late@example.invalid'";
    fs.writeFileSync(
      runner,
      [
        "import { spawnSync } from 'node:child_process';",
        'export default ({ step, cmd, args }) => {',
        "  if (step === 'merge') {",
        `    spawnSync('git', ['-C', ${JSON.stringify(wt)}, ${id}, 'commit', '-q', '--allow-empty', '-m', 'late'],`,
        "      { encoding: 'utf8' });",
        `    const r = spawnSync('git', ['-C', ${JSON.stringify(p.repo)}, ${id}, 'merge', '--no-ff', '--no-edit', args[1]],`,
        "      { encoding: 'utf8' });",
        "    return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') + '\\nMerged by the test runner' };",
        '  }',
        `  const r = spawnSync(cmd, args, { cwd: ${JSON.stringify(p.repo)}, encoding: 'utf8', env: process.env });`,
        "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };",
        '};',
        '',
      ].join('\n'),
    );
    (p.env as NodeJS.ProcessEnv).QUEUE_MERGE_RUNNING = runner;
    const m = p.run('merge', 'A', '--scratchpad', scratch);
    expect(m.code, m.out).not.toBe(0);
    expect(m.out).toMatch(/NOT MERGED AS CHECKED/);
    expect(p.taskOf('A')?.status).toBe('review');
  }, 240_000);
});

describe('V2: a trial merge of the tip before the real one', () => {
  /** queue/A and main change the same line of a.txt differently: the text merge cannot resolve it. */
  function conflict() {
    const s = setup();
    s.g('switch', '-q', '-c', 'queue/A');
    s.write('a.txt', 'one\nTWO from the track\nthree\n');
    s.g('commit', '-q', '-am', 'track');
    s.g('switch', '-q', 'main');
    s.write('a.txt', 'one\nTWO from main\nthree\n');
    s.g('commit', '-q', '-am', 'main');
    return s;
  }

  it('a conflict the text merge cannot resolve stops before the checkout is touched', () => {
    const { g, run, mergeHead } = conflict();
    const head = g('rev-parse', 'HEAD');
    const r = run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toMatch(/Conflicts in 1 files/);
    expect(r.stdout).toContain('MUST BE RESOLVED BY HAND');
    expect(r.stdout).toMatch(/^\s+a\.txt: /m);
    expect(mergeHead()).toBe(false);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(g('status', '--porcelain')).toBe('');
  });

  it('a conflict the text merge resolves (both sides add at the end) still merges', () => {
    const { g, run, write } = setup();
    g('switch', '-q', '-c', 'queue/A');
    write('a.txt', 'one\ntwo\nthree\nfrom the track\n');
    g('commit', '-q', '-am', 'track');
    g('switch', '-q', 'main');
    write('a.txt', 'one\ntwo\nthree\nfrom main\n');
    g('commit', '-q', '-am', 'main');
    const r = run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/Trial merge: 1 conflicting file\(s\), all resolved automatically/);
    expect(r.stdout).toMatch(/Resolved automatically: a\.txt/);
    expect(g('show', 'HEAD:a.txt')).toBe('one\ntwo\nthree\nfrom main\nfrom the track');
  });

  it('a git without merge-tree --write-tree keeps the old way, with a note', () => {
    const { run, mergeHead } = conflict();
    const r = run([], { QUEUE_GIT_VERSION: '2.30.0' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toMatch(/NOTE: git 2\.30\.0 is older than 2\.38/);
    expect(r.stdout).toContain('MUST BE RESOLVED BY HAND');
    expect(mergeHead()).toBe(true);
  });
});
