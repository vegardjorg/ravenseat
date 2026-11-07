// =============================================================
// redteam/lab.test.ts: the final check goes red when it should (plans/redteam-plan.md, bolk R0).
//
// Why: a check that never fails proves nothing. Each case below breaks one rule on purpose, the way a faulty command
// could, and asserts that userThingsProblems names it. The first case shows that an untouched repo is green, and that
// an allowed change (a merged task) is green too. Temporary git repos only.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, userThingsProblems, userMess } from './lab';

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(d);
  return d;
};
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];

/** A repo with an origin, a queue folder with two tasks, and the user's mess (dirty, untracked, staged, stash, branch). */
function lab() {
  const origin = tmp('rt-lab-origin-');
  const repo = tmp('rt-lab-repo-');
  const folder = tmp('rt-lab-folder-');
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', origin]);
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g('add', '--', 'README.md');
  g('commit', '-q', '-m', 'start');
  g('remote', 'add', 'origin', origin);
  g('push', '-q', 'origin', 'main');
  g('branch', 'queue/A');
  const queue = (tasks: object[]) => fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks }));
  queue([
    { id: 'A', status: 'waiting' },
    { id: 'B', status: 'waiting' },
  ]);
  userMess(repo, { staged: true });
  return { repo, folder, g, queue, before: snapshot(repo, folder) };
}

/** A commit on main made the way a merge would, without touching the user's working tree or index. */
function commitBehind(l: ReturnType<typeof lab>, file: string, message = 'work') {
  const tree = l.g('rev-parse', 'HEAD^{tree}');
  const blob = execFileSync('git', ['-C', l.repo, 'hash-object', '-w', '--stdin'], { input: 'new\n', encoding: 'utf8' }).trim();
  const idx = path.join(l.folder, 'tmp-index');
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const run = (args: string[]) =>
    execFileSync('git', ['-C', l.repo, ...ID, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(['read-tree', tree]);
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
  const newTree = run(['write-tree']);
  const commit = run(['commit-tree', newTree, '-p', 'HEAD', '-m', message]);
  l.g('update-ref', 'refs/heads/main', commit);
  fs.rmSync(idx, { force: true });
  // What a merge does to the user's tree: the new file appears, the user's own changes stay.
  fs.mkdirSync(path.dirname(path.join(l.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(l.repo, file), 'new\n');
  l.g('update-index', '--add', '--cacheinfo', `100644,${blob},${file}`);
  return commit;
}

describe('the final check is green when nothing that matters changed', () => {
  it('an untouched repo with the user\'s mess', () => {
    const l = lab();
    expect(userThingsProblems(l.before)).toEqual([]);
  });

  it('an allowed change: a task merged into main, its file, its branch, done in the queue', () => {
    const l = lab();
    commitBehind(l, 'lib/A.ts', 'Merge queue/A (A)');
    l.g('branch', '-D', 'queue/A');
    l.queue([
      { id: 'A', status: 'done' },
      { id: 'B', status: 'waiting' },
    ]);
    expect(userThingsProblems(l.before, { files: ['lib/'], done: ['A'], branches: ['queue/A'] })).toEqual([]);
  });

  it('a lock held by a live process is fine', () => {
    const l = lab();
    const dir = path.join(l.folder, '.lockState');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner-1.json'), JSON.stringify({ generation: 1, pid: process.pid, hostname: os.hostname(), nonce: 'x' }));
    expect(userThingsProblems(l.before)).toEqual([]);
  });
});

describe('the final check goes red for each broken rule', () => {
  const red = (breakIt: (l: ReturnType<typeof lab>) => void, pattern: RegExp, allow = {}) => {
    const l = lab();
    breakIt(l);
    const problems = userThingsProblems(l.before, allow);
    expect(problems.join('\n')).toMatch(pattern);
  };

  it('an uncommitted file with changed content', () => red((l) => fs.appendFileSync(path.join(l.repo, 'README.md'), 'x'), /uncommitted file README\.md has changed content/));
  it('an untracked file removed', () => red((l) => fs.rmSync(path.join(l.repo, 'notes.txt')), /notes\.txt is no longer uncommitted/));
  it('an uncommitted change reverted', () => red((l) => l.g('checkout', '--', 'README.md'), /README\.md is no longer uncommitted/));
  it('a new stray file', () => red((l) => fs.writeFileSync(path.join(l.repo, 'stray.txt'), 'x'), /did not touch is now uncommitted: stray\.txt/));
  it('the staging changed', () => red((l) => l.g('reset', '-q', '--', 'staged.txt'), /staged changes are not the same/));
  it('the stash dropped', () => red((l) => l.g('stash', 'drop', '-q'), /the stash changed/));
  it('another branch checked out', () => red((l) => l.g('symbolic-ref', 'HEAD', 'refs/heads/user-side'), /the user is on user-side, was on main/));
  it('history rewritten', () =>
    red((l) => {
      const c = commitBehind(l, 'lib/A.ts');
      l.g('update-ref', 'refs/heads/main', l.g('commit-tree', `${c}^{tree}`, '-m', 'rewritten'));
    }, /history was rewritten/));
  it('a file outside what the scenario allows', () => red((l) => commitBehind(l, 'secret/other.ts'), /does not allow: secret\/other\.ts/, { files: ['lib/'] }));
  it('a user branch moved or deleted', () => {
    red((l) => l.g('branch', '-f', 'user-side', commitBehind(l, 'lib/A.ts')), /branch user-side has moved/, { files: ['lib/'] });
    red((l) => l.g('branch', '-D', 'user-side'), /branch user-side is gone/);
  });
  it('a branch nobody allowed', () => red((l) => l.g('branch', 'surprise'), /branch the scenario does not allow appeared: surprise/));
  it('the remote changed', () => red((l) => l.g('push', '-q', 'origin', 'main:refs/heads/pushed'), /remote refs\/heads\/pushed appeared/));
  it('a merge left half done', () =>
    red((l) => {
      const gitDir = path.join(l.repo, '.git');
      fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), `${l.g('rev-parse', 'HEAD')}\n`);
    }, /left half done: MERGE_HEAD/));
  it('queue.json broken', () => red((l) => fs.writeFileSync(path.join(l.folder, 'queue.json'), '{"tasks": ['), /queue\.json does not parse/));
  it('a task lost', () => red((l) => l.queue([{ id: 'A', status: 'waiting' }]), /task B has disappeared/));
  it('a task doubled', () =>
    red((l) => l.queue([{ id: 'A', status: 'waiting' }, { id: 'B', status: 'waiting' }, { id: 'B', status: 'picked' }]), /task B is in the queue 2 times/));
  it('a task done without leave', () => red((l) => l.queue([{ id: 'A', status: 'done' }, { id: 'B', status: 'waiting' }]), /task A became done/));
  it('a task merged twice', () =>
    red((l) => {
      for (const n of [1, 2]) {
        const head = l.g('rev-parse', 'HEAD');
        const side = l.g('commit-tree', `${head}^{tree}`, '-p', head, '-m', `side ${n}`);
        l.g('update-ref', 'refs/heads/main', l.g('commit-tree', `${head}^{tree}`, '-p', head, '-p', side, '-m', `Merge queue/A (A) try ${n}`));
      }
    }, /task A was merged 2 times/));
  it('an orphan lock (its process is gone) and a token without an owner', () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    red((l) => {
      const dir = path.join(l.folder, '.lockState');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner-1.json'), JSON.stringify({ generation: 1, pid: Number(dead.stdout), hostname: os.hostname(), nonce: 'x' }));
    }, /orphan lock is left by process \d+/);
    red((l) => {
      const dir = path.join(l.folder, '.lockState');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner-1.json'), 'not json');
    }, /lock token without an owner/);
  });
});
