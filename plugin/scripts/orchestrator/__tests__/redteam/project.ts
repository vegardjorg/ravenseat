// =============================================================
// redteam/project.ts: the one setup the red team scenarios share (plans/redteam-plan.md, rule 2).
//
// A temporary repo with a bare origin, a queue folder with tasks, and the CLI run as a real process. Only the agent is
// fake: a cloud session is simulated with a pushed branch and its finish marker. Git is never mocked. The repo's identity
// is the owner's, so the merge's identity guard lets the merge through.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

export const SCRIPTS = path.resolve(__dirname, '..', '..');
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
export const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(d);
  return d;
};

/** A task add would accept: its own file under lib/, big enough for the small-task guard. */
export const task = (id: string, extra: object = {}) => ({
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
  ...extra,
});

/** The queue's own space: its worktrees under .claude/, and the branches it makes for track A. */
export const queueSpace = (id = 'A') => ({ untracked: ['.claude/'], branches: [`queue/${id}`, `claude/${id}`, `cloud/${id}`] });

/**
 * A project with cloud on and the given quick gates. `config` is merged into queue.config.json.
 * `run` returns { code, out, ms }; out is stdout and stderr together.
 */
export function project({ gates = ['node -e "process.exit(0)"'], config = {}, tasks = [task('A'), task('B')] }: {
  gates?: string[];
  config?: Record<string, unknown>;
  tasks?: object[];
} = {}) {
  const origin = tmp('rt-origin-');
  const repo = tmp('rt-repo-');
  const folder = tmp('rt-folder-');
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
  g(['config', 'user.name', 'Project Owner']);
  g(['config', 'user.email', 'owner@ravenseat.dev']);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ features: { cloud: true }, gates: { quick: gates }, ...config }));
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: new Date().toISOString(), limits: {}, next_migr: 1, resolved: [], tasks }),
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
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env,
      cwd: repo,
      // A last stop for a scenario that would hang: the test then fails on the time, not on vitest's timeout.
      timeout: 170_000,
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: Date.now() - t0 };
  };
  /** What a cloud session does: a branch from the pushed base with one file, and the finish marker. */
  const cloudDelivers = (id: string, file = `lib/${id}.ts`) => {
    run('cloud', 'start', id, '--force');
    g(['checkout', '-q', '-b', 'cloud-work', 'origin/main']);
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), 'from the cloud\n');
    g(['add', '--', file]);
    g(['commit', '-q', '-m', `edit ${file}`]);
    g(['commit', '-q', '--allow-empty', '-m', `CLOUD-DONE ${id}`]);
    g(['push', '-q', 'origin', `cloud-work:refs/heads/claude/${id}`]);
    g(['checkout', '-q', 'main']);
    g(['branch', '-q', '-D', 'cloud-work']);
    g(['fetch', '-q', 'origin']);
  };
  /**
   * What a local track does: the task is running on queue/<id> in an agent worktree under .claude/worktrees (where the
   * Agent tool puts it), the agent commits one file and writes its RESULT line to the scratchpad. Returns the scratchpad.
   */
  const localDelivers = (id: string, file = `lib/${id}.ts`) => {
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(path.join(scratch, id), { recursive: true });
    const wt = path.join(repo, '.claude', 'worktrees', `agent-${id}`);
    g(['worktree', 'add', '-q', '-b', `queue/${id}`, wt, 'main']);
    fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
    fs.writeFileSync(path.join(wt, file), 'from the track\n');
    g(['add', '--', file], wt);
    g(['commit', '-q', '-m', `feat: ${id}`], wt);
    fs.writeFileSync(
      path.join(scratch, id, 'track-result.md'),
      `RESULT status=DONE branch=queue/${id} commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-\n`,
    );
    const qf = path.join(folder, 'queue.json');
    const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
    const t = q.tasks.find((x: { id: string }) => x.id === id);
    Object.assign(t, { status: 'running', started: new Date().toISOString(), branch: `queue/${id}`, scratchpad: scratch });
    fs.writeFileSync(qf, JSON.stringify(q));
    return scratch;
  };
  const worktree = (id: string) => path.join(repo, '.claude', 'worktrees', `cloud-${id}`);
  // The scratchpad cloud collect uses itself (cli/cloud.mjs collectOne). Never the worktree: the merge removes it, and
  // the gates' log would then have nowhere to go.
  const merge = (id: string) => run('merge', id, '--scratchpad', path.join(folder, 'collect', id));
  const taskOf = (id: string) =>
    (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks as { id: string; status: string }[]).find(
      (x) => x.id === id,
    );
  return { repo, folder, configFile, env, g, run, cloudDelivers, localDelivers, worktree, merge, taskOf };
}
