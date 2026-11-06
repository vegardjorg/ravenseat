// =============================================================
// trackAddFlow.test.ts: `cq add` from a track's own worktree, through the real CLI.
//
// Locks: (1) from a track branch it is always a proposal, whatever the file says; added_by comes from the branch; (2)
// --approved is refused there; (3) a track may have 3 open proposals; (4) the same command in the main checkout still gives a
// task that is ready, so the orchestrator's flow did not change; (5) the real hook lets a track add from its worktree and
// refuses it from the main checkout; (6) the new dependency files are protected, and only warn with dependencyFiles warn.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const HOOK = path.resolve(__dirname, '..', 'hook-push-guard.mjs');
const { assessGuard } = require('../lib/mergeGuard.js');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

function project() {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-trackadd-')));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt');
  fs.mkdirSync(repo);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const data = path.join(folder, 'data');
  fs.mkdirSync(data);
  const queueFile = path.join(data, 'queue.json');
  fs.writeFileSync(
    queueFile,
    JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks: [{ id: 'A-1', title: 'a', domain: 'x', class: 'K', status: 'running', mission: 'm' }] }),
  );
  const configFile = path.join(repo, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite' }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: data,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
  } as NodeJS.ProcessEnv;
  for (const k of ['QUEUE_ROOT', 'QUEUE_GIT', 'QUEUE_CONFIG', 'CLAUDE_PROJECT_DIR']) delete env[k];
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { env, stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['add', '--', 'queue.config.json']);
  g(['commit', '-q', '-m', 'start']);
  g(['worktree', 'add', '-q', '-b', 'queue/A-1', worktree]);
  const runIn = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const hook = (cwd: string, agent_type: string | null, command: string) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd, ...(agent_type ? { agent_type } : {}) }), encoding: 'utf8', env, cwd });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
  };
  return {
    repo,
    worktree,
    hook,
    fromTrack: (...args: string[]) => runIn(worktree, ...args),
    fromMain: (...args: string[]) => runIn(repo, ...args),
    task: (id: string) => JSON.parse(fs.readFileSync(queueFile, 'utf8')).tasks.find((o: { id: string }) => o.id === id),
  };
}

describe('cq add from a track', () => {
  it('is a proposal from that track, whatever the task says about itself', () => {
    const p = project();
    const task = { id: 'N-1', title: 'New', mission: 'm', added_by: 'owner', status: 'waiting', approved: 'x', approved_by: 'owner' };
    const r = p.fromTrack('add', '--json', JSON.stringify(task));
    expect(r.code).toBe(0);
    const n = p.task('N-1');
    expect(n).toMatchObject({ status: 'proposed', added_by: 'A-1' });
    expect(n.approved).toBeUndefined();
    expect(n.approved_by).toBeUndefined();
  });
  it('a title with --by works the same', () => {
    const p = project();
    expect(p.fromTrack('add', 'A title', '--id', 'N-2', '--by', 'owner').code).toBe(0);
    expect(p.task('N-2')).toMatchObject({ status: 'proposed', added_by: 'A-1' });
  });
  it('--approved is refused, and nothing is added', () => {
    const p = project();
    const r = p.fromTrack('add', 'A title', '--id', 'N-3', '--approved');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--approved');
    expect(p.task('N-3')).toBeUndefined();
  });
  it('stops at 3 open proposals, and counts one approved as no longer open', () => {
    const p = project();
    for (const id of ['N-1', 'N-2', 'N-3']) expect(p.fromTrack('add', id, '--id', id).code).toBe(0);
    const over = p.fromTrack('add', 'Fourth', '--id', 'N-4');
    expect(over.code).not.toBe(0);
    expect(over.out).toContain('3 open proposal(s)');
    expect(p.task('N-4')).toBeUndefined();
    expect(p.fromMain('approve', 'N-1').code).toBe(0);
    expect(p.fromTrack('add', 'Fourth', '--id', 'N-4').code).toBe(0);
  });
});

describe('the hook', () => {
  it('lets a track add from its worktree, and nowhere else', () => {
    const p = project();
    expect(p.hook(p.worktree, 'track', 'cq add --file task.json')).toBeNull();
    expect(p.hook(p.worktree, 'track', 'cq add --file task.json --approved')).toBe('deny');
    expect(p.hook(p.worktree, 'track', `cd "${p.repo}" && cq add --file task.json`)).toBe('deny');
    expect(p.hook(p.repo, 'track', 'cq add --file task.json')).toBe('deny');
    expect(p.hook(p.repo, 'reviewer', 'cq add --file task.json')).toBe('deny');
    // The main session has no agent_type and is not touched.
    expect(p.hook(p.repo, null, 'cq add --file task.json --approved')).toBeNull();
  });
});

describe('the dependency files', () => {
  const files = ['requirements.txt', 'requirements-dev.txt', 'api/go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json'];
  it.each(files)('%s stops a task that does not own it, and only warns in lite', (f) => {
    const check = (dependencyFiles: string) => assessGuard({ changes: [{ status: 'M', paths: [f] }], dependencyFiles });
    expect(check('stop').violations.map((v: { path: string }) => v.path)).toEqual([f]);
    const soft = check('warn');
    expect(soft.violations).toEqual([]);
    expect(soft.warned).toEqual([f]);
  });
});

describe('cq add from the main checkout', () => {
  it('is as it was: ready to run, and --approved works', () => {
    const p = project();
    expect(p.fromMain('add', 'Ready', '--id', 'M-1').code).toBe(0);
    expect(p.task('M-1').status).toBe('waiting');
    expect(p.fromMain('add', 'From an agent', '--id', 'M-2', '--by', 'A-1').code).toBe(0);
    expect(p.task('M-2').status).toBe('proposed');
    expect(p.fromMain('add', 'Approved', '--id', 'M-3', '--by', 'A-1', '--approved').code).toBe(0);
    expect(p.task('M-3').status).toBe('waiting');
  });
});
