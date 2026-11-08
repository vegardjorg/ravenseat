// =============================================================
// redteam/rt25-no-first-commit.test.ts: RT-25 "a project without git, or without a first commit, starts work that cannot
// run" (finding 12).
//
// Why: an agent makes its worktree from the base branch. In a folder without git there is nothing to set up, and init
// says so. In a repo with git but no commit yet, init and add worked, `start` marked the task running, and the agent
// then stopped at its first step with "fatal: invalid reference: main". Start and fill now refuse before anything is
// marked, with the way forward, and the task stays waiting. After a first commit the same task starts.
// =============================================================
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS, task, tmp } from './project';

const ID = ['-c', 'user.email=owner@ravenseat.dev', '-c', 'user.name=Project Owner', '-c', 'commit.gpgsign=false'];

/** A repo with `git init` and no commit, a queue folder with one waiting task, and the CLI as a real process. */
function emptyRepo() {
  const repo = tmp('rt25-repo-');
  const folder = tmp('rt25-folder-');
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', gates: { quick: ['node -e "process.exit(0)"'] } }));
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: new Date().toISOString(), limits: {}, next_migr: 1, resolved: [], tasks: [task('A')] }),
  );
  const env = {
    ...process.env,
    QUEUE_CONFIG: configFile,
    QUEUE_FOLDER: folder,
    QUEUE_GIT: repo,
    QUEUE_ROOT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_SCRATCHPAD: path.join(folder, 'scratch'),
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), ...args], { encoding: 'utf8', env, cwd: repo, timeout: 120_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const status = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks[0].status;
  const branches = () => g('branch', '--list', '--format=%(refname:short)');
  return { repo, g, run, status, branches };
}

describe('RT-25: no git, or no first commit, never starts work that cannot run', () => {
  it('start and fill refuse in a repo with no commit, mark nothing, and say to make a first commit; after one, start works', () => {
    const p = emptyRepo();
    const start = p.run('start', 'A', '--force');
    expect(start.code).not.toBe(0);
    expect(start.out).toMatch(/no commit yet/);
    expect(start.out).toMatch(/first commit/);
    expect(p.status()).toBe('waiting');

    const fill = p.run('fill', '--ids', 'A', '--over-load');
    expect(fill.code).not.toBe(0);
    expect(fill.out).toMatch(/no commit yet/);
    expect(p.status()).toBe('waiting');
    expect(p.branches()).toBe('');

    fs.writeFileSync(path.join(p.repo, 'README.md'), 'start\n');
    p.g('add', '--', 'README.md');
    p.g('commit', '-q', '-m', 'first commit');
    const again = p.run('start', 'A', '--force');
    expect(again.out).toMatch(/Started A/);
    expect(p.status()).toBe('running');
  }, 120_000);

  it('a base branch that does not exist, in a repo that has commits, gets its own message', () => {
    const p = emptyRepo();
    fs.writeFileSync(path.join(p.repo, 'README.md'), 'start\n');
    p.g('add', '--', 'README.md');
    p.g('commit', '-q', '-m', 'first commit');
    p.g('branch', '-q', '-m', 'main', 'trunk');
    const start = p.run('start', 'A', '--force');
    expect(start.code).not.toBe(0);
    expect(start.out).toMatch(/Could not find baseBranch main/);
    expect(start.out).not.toMatch(/no commit yet/);
    expect(p.status()).toBe('waiting');
  }, 120_000);

  it('without git, init refuses and says why the queue needs git', () => {
    const plain = tmp('rt25-plain-');
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), 'init'], {
      encoding: 'utf8',
      cwd: plain,
      env: { ...process.env, QUEUE_CONFIG: undefined, QUEUE_FOLDER: undefined, QUEUE_GIT: undefined, QUEUE_ROOT: undefined, GIT_CEILING_DIRECTORIES: path.dirname(plain) },
      timeout: 60_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status).not.toBe(0);
    expect(out).toMatch(/not under git yet/);
    expect(out).toMatch(/git init/);
    expect(fs.readdirSync(plain)).toEqual([]);
  }, 60_000);
});
