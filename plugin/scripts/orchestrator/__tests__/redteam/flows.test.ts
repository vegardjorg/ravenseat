// =============================================================
// redteam/flows.test.ts: the final check applied to real flows (plans/redteam-plan.md, bolk R0).
//
// Why: the lab is only worth something when it runs after the commands a user actually runs. Two flows to start
// with, both on a repo with the user's mess (a changed file, an untracked file, a stash, a side branch):
//   1. a cloud track comes home and is merged: only its file may land, its branches may go, it may become done;
//   2. a cloud track comes home with red gates: nothing may land at all.
// The cloud session is simulated with a pushed branch, as in lib/__tests__/queueCloudTracks.test.ts. No real claude.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';

const SCRIPTS = path.resolve(__dirname, '..', '..');
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(d);
  return d;
};

const task = (id: string) => ({
  id,
  title: `Task ${id}`,
  domain: 'app',
  class: 'K',
  status: 'waiting',
  mission: `Mission for ${id}.`,
  value: 5,
  content_min: 30,
  migr_tens: 0,
  depends_on: [],
  waiting_on: [],
  owned_files: [`lib/${id}.ts`],
  owner_db: [],
  shared_patch: [],
});

/** A repo with a bare origin and a queue with cloud on; `run` calls the CLI there. */
function project(gate: string) {
  const origin = tmp('rt-flow-origin-');
  const repo = tmp('rt-flow-repo-');
  const folder = tmp('rt-flow-folder-');
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '--bare'], origin);
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['remote', 'add', 'origin', origin]);
  g(['push', '-q', 'origin', 'main']);
  g(['fetch', '-q', 'origin']);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ features: { cloud: true }, gates: { quick: [gate] } }));
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: new Date().toISOString(), limits: {}, next_migr: 1, resolved: [], tasks: [task('A'), task('B')] }),
  );
  const env = {
    ...process.env,
    QUEUE_CONFIG: configFile,
    QUEUE_FOLDER: folder,
    QUEUE_GIT: repo,
    QUEUE_ROOT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_SCRATCHPAD: path.join(folder, 'scratch'),
    RAVENSEAT_CLOUD_TOKEN: undefined,
    QUEUE_CLOUD_FAKE_CLAUDE: path.join(folder, 'no-claude.cjs'),
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), ...args], { encoding: 'utf8', env, cwd: repo });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  /** What a cloud session does: a branch from the pushed base with one file, and the finish marker. */
  const cloudPush = (branch: string, file: string, marker: string) => {
    g(['checkout', '-q', '-b', 'cloud-work', 'origin/main']);
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), 'from the cloud\n');
    g(['add', '--', file]);
    g(['commit', '-q', '-m', `edit ${file}`]);
    g(['commit', '-q', '--allow-empty', '-m', marker]);
    g(['push', '-q', 'origin', `cloud-work:refs/heads/${branch}`]);
    g(['checkout', '-q', 'main']);
    g(['branch', '-q', '-D', 'cloud-work']);
  };
  return { repo, folder, g, run, cloudPush };
}

// The queue's own space: its worktrees under .claude/worktrees, and the branches it makes for the track.
const QUEUE_SPACE = { untracked: ['.claude/'], branches: ['queue/A', 'claude/A', 'cloud/A'] };

describe('flow 1: a cloud track comes home and is merged, on a repo with the user\'s mess', () => {
  it('only the track\'s file lands, A becomes done, and everything of the user\'s is as it was', () => {
    const p = project('node -e "process.exit(0)"');
    p.run('cloud', 'start', 'A', '--force');
    p.cloudPush('claude/A', 'lib/A.ts', 'CLOUD-DONE A');
    p.g(['fetch', '-q', 'origin']);
    // The merge's identity guard wants the owner's name on main.
    p.g(['config', 'user.name', 'Project Owner']);
    p.g(['config', 'user.email', 'owner@ravenseat.dev']);
    userMess(p.repo);
    const before = snapshot(p.repo, p.folder);

    const c = p.run('cloud', 'collect');
    expect(c.out).toMatch(/Gates GREEN/);
    const m = p.run('merge', 'A', '--scratchpad', path.join(p.repo, '.claude', 'worktrees', 'cloud-A'));
    expect(m.code, m.out).toBe(0);
    // The flow did something: the track's file is on main (a green check on a flow that did nothing proves nothing).
    expect(p.g(['show', 'main:lib/A.ts'])).toBe('from the cloud');

    expectUserThingsIntact(before, {
      ...QUEUE_SPACE,
      files: ['lib/A.ts'],
      done: ['A'],
      // The merge removes the cloud branch from the remote (cloud.deleteBranch, on by default).
      remoteRefs: ['refs/heads/claude/A'],
    });
  }, 240_000);
});

describe('flow 3: the user has a staged change when the merge runs', () => {
  // git merge refuses to merge on top of staged changes. The merge must stop there and leave the staging as it was:
  // nothing lands, A is not done, and the user's index is never reset to make room.
  it('the merge stops, and the staging and everything else of the user\'s is as it was', () => {
    const p = project('node -e "process.exit(0)"');
    p.run('cloud', 'start', 'A', '--force');
    p.cloudPush('claude/A', 'lib/A.ts', 'CLOUD-DONE A');
    p.g(['fetch', '-q', 'origin']);
    p.g(['config', 'user.name', 'Project Owner']);
    p.g(['config', 'user.email', 'owner@ravenseat.dev']);
    userMess(p.repo, { staged: true });
    const before = snapshot(p.repo, p.folder);

    expect(p.run('cloud', 'collect').out).toMatch(/Gates GREEN/);
    const m = p.run('merge', 'A', '--scratchpad', path.join(p.repo, '.claude', 'worktrees', 'cloud-A'));
    expect(m.code).not.toBe(0);
    expect(m.out).toMatch(/STOP in the step merge/);
    // Stopped before git merge ran: with core.autocrlf, git's own save and restore rewrote the user's files.
    expect(m.out).toMatch(/staged changes that are not committed: staged\.txt.*\n.*Nothing was touched/);
    expectUserThingsIntact(before, QUEUE_SPACE);
  }, 240_000);
});

describe('flow 2: a cloud track comes home with red gates', () => {
  it('nothing lands, nothing becomes done, and everything of the user\'s is as it was', () => {
    const p = project('node -e "process.exit(1)"');
    p.run('cloud', 'start', 'A', '--force');
    p.cloudPush('claude/A', 'lib/A.ts', 'CLOUD-DONE A');
    p.g(['fetch', '-q', 'origin']);
    userMess(p.repo);
    const before = snapshot(p.repo, p.folder);

    const c = p.run('cloud', 'collect');
    expect(c.code).toBe(1);
    expectUserThingsIntact(before, QUEUE_SPACE);
  }, 180_000);
});
