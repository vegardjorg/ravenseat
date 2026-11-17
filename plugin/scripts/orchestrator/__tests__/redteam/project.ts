// =============================================================
// redteam/project.ts: the one setup the red team scenarios share (plans/redteam-plan.md, rule 2).
//
// A temporary repo with a bare origin, a queue folder with tasks, and the CLI run as a real process. Only the agent is
// fake: a cloud session is simulated with a pushed branch and its finish marker. Git is never mocked. The repo's identity
// is the owner's, so the merge's identity guard lets the merge through.
//
// No process outlives the file (the leftover guard): every temporary folder of this test file is under one folder whose
// name is unique to this run (RUN_MARK), so the gate scripts, fake agents and CLI runs a scenario starts all carry it in
// their command line. After the file, the processes a scenario registered with ownTree are ended with their trees,
// then any process that still has RUN_MARK in its command line is a leak: it is ended too, and the file fails with
// what it was. Another run at the same time has its own mark, so it is never counted. The folder is then removed with
// retries, since Windows can still hold a file of a process that has just ended (EPERM, EBUSY).
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

export const SCRIPTS = path.resolve(__dirname, '..', '..');
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];

/** Unique to this test file's run: the name of the folder every temporary folder of it is made in. */
export const RUN_MARK = `rs-rt-${crypto.randomBytes(6).toString('hex')}`;
const RUN_ROOT = path.join(os.tmpdir(), RUN_MARK);
/** What a hanging fixture waits at most before it ends by itself, so a red run never leaves it for days. */
export const FIXTURE_CAP_MS = 120_000;

/** Kills a process and everything it started, without warning: no signal handler and no exit handler runs. */
export function killTree(pid: number) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

const owned: number[] = [];
/** A process a scenario started: ended with its tree after the file, also when the scenario failed before its own kill. */
export function ownTree(pid: number | undefined) {
  if (pid) owned.push(pid);
}

/**
 * The live processes whose command line has `mark` in it (git's own background processes left out). The mark goes to
 * the listing through the environment, so the listing itself never matches.
 */
export function leftovers(mark = RUN_MARK): { pid: number; name: string; command: string }[] {
  const env = { ...process.env, RS_RT_MARK: mark };
  let out = '';
  if (process.platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter (\"CommandLine like '%\" + $env:RS_RT_MARK + \"%'\") | " +
      'ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
    out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', windowsHide: true }).stdout ?? '';
  } else {
    out = (spawnSync('ps', ['-eo', 'pid=,comm=,args='], { env, encoding: 'utf8' }).stdout ?? '')
      .split('\n')
      .map((l) => l.trim().replace(/^(\d+)\s+(\S+)\s+/, '$1\t$2\t'))
      .join('\n');
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 3 && c.slice(2).join('\t').includes(mark))
    .map(([pid, name, ...rest]) => ({ pid: Number(pid), name, command: rest.join('\t') }))
    .filter((p) => p.pid !== process.pid && !/^git/i.test(p.name));
}

/** leftovers(mark), listed again up to twice a second apart while any are found: a kill can take a moment to land. */
export async function stillAlive(mark: string) {
  let left = leftovers(mark);
  for (let i = 0; i < 2 && left.length; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    left = leftovers(mark);
  }
  return left;
}

afterAll(async () => {
  // A file that never made a temporary folder or started a process has nothing to check (and skips the listing's cost).
  if (!owned.length && !fs.existsSync(RUN_ROOT)) return;
  for (const pid of owned) killTree(pid);
  // A moment for processes that are ending anyway, then whatever still runs is a leak (a listing takes seconds on Windows).
  const left = await stillAlive(RUN_MARK);
  for (const p of left) killTree(p.pid);
  try {
    fs.rmSync(RUN_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    // error-ignored: a file still held after the retries (a virus scanner, the indexer) is the system's temp folder's to
    // clear; the leak check above is what this hook is for
    console.warn(`could not remove ${RUN_ROOT}: ${(e as Error).message}`);
  }
  if (left.length)
    throw new Error(
      `${left.length} process(es) of this run outlived it (ended now): ` +
        left.map((p) => `${p.pid} ${p.command.split(RUN_MARK).join('<run>').slice(0, 200)}`).join(' | '),
    );
}, 90_000);

export const tmp = (prefix: string) => {
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(RUN_ROOT, prefix));
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
export function project({
  gates = ['node -e "process.exit(0)"'],
  config = {},
  tasks = [task('A'), task('B')],
  oddPaths = false,
}: {
  gates?: string[];
  config?: Record<string, unknown>;
  tasks?: object[];
  /** Folder names with spaces and æøå (RT-20), for the repo, the origin and the queue folder. */
  oddPaths?: boolean;
} = {}) {
  const odd = oddPaths ? ' mappe æøå ' : '-';
  const origin = tmp(`rt-origin${odd}`);
  const repo = tmp(`rt-repo${odd}`);
  const folder = tmp(`rt-folder${odd}`);
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
