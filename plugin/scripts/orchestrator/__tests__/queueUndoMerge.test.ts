// =============================================================
// queueUndoMerge.test.ts: `ravenseat undo <id>` (GS-3, cli/undo.mjs, lib/undoMerge.js) against temporary git repos.
//
// Locks: (1) --dry shows the plan (the merge commit, the later tasks that share a file or depend on it) and changes
// nothing; (2) --yes reverts the merge with `git revert -m 1` as ONE new commit on top (history kept, nothing pushed),
// sets the task back to waiting with a note, and runs the base gate on the new tip as after a merge; (3) without
// merge_commit the merge log (the "Merge branch '<prefix><id>'" subject) finds it; (4) the refusals, each with nothing
// changed: a dirty tree, the main checkout on another branch, a held merge lock, a merge in progress, a commit not in
// base, a second undo of the same merge, a track worktree, no terminal without --yes; (5) a revert that conflicts is
// aborted (clean tree, same tip, task still done) with what to do by hand; (6) a revert that turns the base red exits 9
// with a base fix task, as a red merge does; (7) a queue agent's `ravenseat undo <id>` is denied by the push guard.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and repo (QUEUE_GIT, QUEUE_ROOT). Never the main repo.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PG = require('../lib/pushGuard.js');

type Task = Record<string, unknown> & { id: string; status: string };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', '-c', 'core.autocrlf=false'];
// Loads every file in lib/: red when one requires a file the revert took away.
const CHECK_JS =
  "const fs = require('fs'); const path = require('path');\n" +
  "for (const f of fs.readdirSync('lib').sort()) require(path.resolve('lib', f));\n" +
  "console.log('check ok');\n";

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

function project(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-undo-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  // The repo's own setting, so the CLI's git calls (no -c here) see no line-ending changes on Windows either.
  g(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'check.js'), CHECK_JS);
  fs.writeFileSync(path.join(repo, 'lib', 'a.js'), "exports.name = () => 'a';\n");
  g(['add', '--', 'check.js', 'lib/a.js']);
  g(['commit', '-q', '-m', 'start']);
  const tasks: Task[] = [];
  const writeQueue = () =>
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks }),
    );
  writeQueue();
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', gates: { quick: ['node check.js'] }, ...config }));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    QUEUE_WAIT: 'off',
    GIT_AUTHOR_NAME: 'queue-test',
    GIT_AUTHOR_EMAIL: 'queue-test@example.invalid',
    GIT_COMMITTER_NAME: 'queue-test',
    GIT_COMMITTER_EMAIL: 'queue-test@example.invalid',
  } as NodeJS.ProcessEnv;
  for (const k of ['QUEUE_SCRATCHPAD', 'QUEUE_SESSION']) delete env[k];
  const run = (args: string[], { cwd = repo }: { cwd?: string } = {}) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd, timeout: 90_000 });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as { tasks: Task[] };
  const find = (id: string) => queue().tasks.find((t) => t.id === id) as Task;
  const tip = () => g(['rev-parse', 'develop']);
  /** A merged track: branch queue/<id> with the files, merged --no-ff into develop, the task done with merge_commit. */
  const merged = (id: string, files: Record<string, string | null>, extra: Record<string, unknown> = {}, { record = true } = {}) => {
    g(['checkout', '-q', '-b', `queue/${id}`]);
    for (const [f, text] of Object.entries(files)) {
      if (text === null) g(['rm', '-q', '--', f]);
      else {
        fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
        fs.writeFileSync(path.join(repo, f), text);
        g(['add', '--', f]);
      }
    }
    g(['commit', '-q', '-m', `${id} work`]);
    g(['checkout', '-q', 'develop']);
    g(['merge', '-q', '--no-ff', '--no-edit', `queue/${id}`]);
    const sha = tip();
    tasks.push({
      id, status: 'done', title: `${id} title`, class: 'D', value: 5, files: Object.keys(files),
      done: '2026-11-01T00:00:00.000Z', ...(record ? { merge_commit: sha } : {}), ...extra,
    } as Task);
    writeQueue();
    return sha;
  };
  return { folder, repo, g, run, queue, find, tip, merged, tasks, writeQueue };
}

describe('ravenseat undo <id>: the plan and the revert', () => {
  it('--dry shows the merge and the later tasks that share a file or depend on it, and changes nothing', () => {
    const p = project();
    const m = p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n", 'lib/x.js': 'exports.x = 1;\n' });
    p.merged('B-1', { 'lib/x.js': 'exports.x = 2;\n' });
    p.merged('C-1', { 'lib/c.js': 'exports.c = 1;\n' }, { depends_on: ['A-1'] });
    p.merged('D-1', { 'lib/d.js': 'exports.d = 1;\n' });
    p.tasks.push({ id: 'E-1', status: 'waiting', title: 'E', class: 'D', value: 5, depends_on: ['A-1'] } as Task);
    p.writeQueue();
    const before = p.tip();
    const r = p.run(['undo', 'A-1', '--dry']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(m.slice(0, 12));
    expect(r.out).toMatch(/B-1.*lib\/x\.js/);
    expect(r.out).toMatch(/C-1.*depends on A-1/);
    expect(r.out).not.toMatch(/D-1/);
    expect(r.out).toMatch(/E-1/);
    expect(r.out).toMatch(/--dry: nothing was done/i);
    expect(p.tip()).toBe(before);
    expect(p.find('A-1').status).toBe('done');
  });

  it('--yes reverts the merge as one new commit, sets the task to waiting with a note and runs the base gate', () => {
    const p = project();
    const m = p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    const before = p.tip();
    const r = p.run(['undo', 'A-1', '--yes']);
    expect(r.code, r.out).toBe(0);
    const after = p.tip();
    expect(after).not.toBe(before);
    // One new commit on top of the old tip: nothing rewritten.
    expect(p.g(['rev-parse', `${after}^`])).toBe(before);
    expect(p.g(['log', '-1', '--format=%s', after])).toBe(`Undo A-1: revert merge ${m.slice(0, 12)}`);
    expect(p.g(['log', '-1', '--format=%B', after])).toMatch(/Queue: orchestrator/);
    expect(fs.readFileSync(path.join(p.repo, 'lib', 'a.js'), 'utf8')).toBe("exports.name = () => 'a';\n");
    expect(p.g(['status', '--porcelain', '--untracked-files=no'])).toBe('');
    const t = p.find('A-1');
    expect(t.status).toBe('waiting');
    expect(t.merge_commit).toBeUndefined();
    expect(t.undone).toEqual([expect.objectContaining({ merge_commit: m, revert_commit: after })]);
    expect((t.remarks as string[]).at(-1)).toMatch(/undone/);
    // The base gate ran on the new tip, as after a merge.
    const health = JSON.parse(fs.readFileSync(path.join(p.folder, 'base-health.json'), 'utf8'));
    expect(health.current).toMatchObject({ tip: after, status: 'green' });
    expect(r.out).toMatch(/BASE GREEN/);
    expect(r.out).toMatch(/not pushed/i);
  });

  it('without merge_commit the merge log finds the merge', () => {
    const p = project();
    const m = p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" }, {}, { record: false });
    const r = p.run(['undo', 'A-1', '--dry']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(m.slice(0, 12));
    expect(r.out).toMatch(/merge log/);
  });

  it('a revert that turns the base red exits 9 with a base fix task, as a red merge does', () => {
    const p = project();
    p.merged('A-1', { 'lib/b.js': "exports.b = () => 'b';\n" });
    // B-1 builds on A-1's file without sharing it: the revert is clean, the base gate goes red.
    p.merged('B-1', { 'lib/c.js': "require('./b.js');\n" });
    const r = p.run(['undo', 'A-1', '--yes']);
    expect(r.code, r.out).toBe(9);
    expect(p.find('A-1').status).toBe('waiting');
    const health = JSON.parse(fs.readFileSync(path.join(p.folder, 'base-health.json'), 'utf8'));
    expect(health.current).toMatchObject({ tip: p.tip(), status: 'red' });
    expect(p.queue().tasks.some((t) => /BASE/.test(t.id))).toBe(true);
    // The red text names the undo and its way back, never a `revert -m 1` of the revert (not a merge commit).
    expect(r.out).toMatch(/after the undo of A-1 \(revert commit/);
    expect(r.out).toContain(`revert ${p.tip()}`);
    expect(r.out).not.toMatch(/revert -m 1 [0-9a-f]+;/);
  });
});

describe('ravenseat undo <id>: the refusals change nothing', () => {
  const refused = (p: ReturnType<typeof project>, args: string[], text: RegExp, opts = {}) => {
    const before = p.tip();
    const r = p.run(args, opts);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(text);
    expect(p.tip()).toBe(before);
    return r;
  };

  it('a dirty tree', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    fs.writeFileSync(path.join(p.repo, 'lib', 'a.js'), 'changed\n');
    refused(p, ['undo', 'A-1', '--yes'], /uncommitted/);
    expect(p.find('A-1').status).toBe('done');
  });

  it('the main checkout on another branch', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    p.g(['checkout', '-q', '-b', 'other']);
    const r = p.run(['undo', 'A-1', '--yes']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/on other, not develop/);
    expect(p.find('A-1').status).toBe('done');
  });

  it('a held merge lock', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    fs.writeFileSync(
      path.join(p.folder, 'merge.lock'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString(), task: 'B-9', command: 'merge' }),
    );
    refused(p, ['undo', 'A-1', '--yes'], /merge B-9/);
    expect(fs.existsSync(path.join(p.folder, 'merge.lock'))).toBe(true);
  });

  it('a merge in progress in the main checkout', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    p.g(['checkout', '-q', '-b', 'side', 'develop~1']);
    fs.writeFileSync(path.join(p.repo, 'lib', 'a.js'), 'side\n');
    p.g(['commit', '-q', '-am', 'side']);
    p.g(['checkout', '-q', 'develop']);
    spawnSync('git', ['-C', p.repo, ...ID, 'merge', '--no-edit', 'side'], { encoding: 'utf8' });
    refused(p, ['undo', 'A-1', '--yes'], /merge is in progress/);
  });

  it('a recorded commit that is not in base', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    p.g(['checkout', '-q', '-b', 'loose']);
    fs.writeFileSync(path.join(p.repo, 'lib', 'z.js'), 'z\n');
    p.g(['add', '--', 'lib/z.js']);
    p.g(['commit', '-q', '-m', 'loose']);
    const loose = p.g(['rev-parse', 'HEAD']);
    p.g(['checkout', '-q', 'develop']);
    p.tasks[0].merge_commit = loose;
    p.writeQueue();
    refused(p, ['undo', 'A-1', '--yes'], /not in develop/);
  });

  it('a second undo of the same merge', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    expect(p.run(['undo', 'A-1', '--yes']).code).toBe(0);
    // Back to done by hand (as if merged again), but the merge log still names the old merge: refused.
    const q = p.queue();
    q.tasks[0].status = 'done';
    fs.writeFileSync(path.join(p.folder, 'queue.json'), JSON.stringify(q));
    refused(p, ['undo', 'A-1', '--yes'], /already undone/);
  });

  it('from a track worktree', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    const wt = path.join(p.folder, 'wt-B-2');
    p.g(['worktree', 'add', '-q', '-b', 'queue/B-2', wt]);
    refused(p, ['undo', 'A-1', '--yes'], /track/, { cwd: wt });
    expect(p.find('A-1').status).toBe('done');
  });

  it('no terminal and no --yes: nothing is done', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    refused(p, ['undo', 'A-1'], /--yes/);
    expect(p.find('A-1').status).toBe('done');
  });

  it('a task that is not merged', () => {
    const p = project();
    p.tasks.push({ id: 'W-1', status: 'waiting', title: 'W', class: 'D', value: 5 } as Task);
    p.writeQueue();
    refused(p, ['undo', 'W-1', '--yes'], /status waiting/);
  });

  it('bare undo is still the changelog undo', () => {
    const p = project();
    const r = p.run(['undo', '--show']);
    expect(r.out).not.toMatch(/merge commit/);
  });
});

describe('ravenseat undo <id>: a conflicting revert is aborted', () => {
  it('a later task changed the same lines: git revert --abort, the tip and the task stay, the text says what to do by hand', () => {
    const p = project();
    const m = p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    p.merged('B-1', { 'lib/a.js': "exports.name = () => 'B';\n" });
    const before = p.tip();
    const r = p.run(['undo', 'A-1', '--yes']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/conflict/i);
    expect(r.out).toMatch(/lib\/a\.js/);
    expect(r.out).toContain(`git revert -m 1 ${m}`);
    expect(p.tip()).toBe(before);
    expect(p.g(['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(fs.existsSync(path.join(p.repo, '.git', 'REVERT_HEAD'))).toBe(false);
    expect(p.find('A-1').status).toBe('done');
  });
});

describe('ravenseat undo <id>: a long or unreadable history (ARK-1 T2)', () => {
  it('finds the merge when the base log is over 1 MB', () => {
    const p = project();
    const m = p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    // A later commit with a 1.2 MB subject: the first-parent log is over the old 1 MB default buffer.
    const msg = path.join(p.folder, 'long-subject.txt');
    fs.writeFileSync(msg, `${'long subject '.repeat(100_000)}\n`);
    p.g(['commit', '-q', '--allow-empty', '-F', msg]);
    const r = p.run(['undo', 'A-1', '--dry']);
    expect(r.code, r.out.slice(0, 400)).toBe(0);
    expect(r.out).toContain(m.slice(0, 12));
  });

  it('says the log could not be read instead of "merge not found", and changes nothing', () => {
    const p = project();
    p.merged('A-1', { 'lib/a.js': "exports.name = () => 'A';\n" });
    const before = p.tip();
    // Take the first commit away: git log --first-parent cannot walk the history any more.
    const root = p.g(['rev-list', '--max-parents=0', 'develop']);
    const obj = path.join(p.repo, '.git', 'objects', root.slice(0, 2), root.slice(2));
    fs.chmodSync(obj, 0o644);
    fs.rmSync(obj);
    const r = p.run(['undo', 'A-1', '--dry']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/could not read the history/i);
    expect(r.out).not.toMatch(/not found/i);
    expect(p.tip()).toBe(before);
  });
});

describe('a queue agent cannot undo', () => {
  it('the push guard denies `ravenseat undo <id>` for a track', () => {
    const track = { baseBranch: 'develop', agentType: 'track', branch: 'queue/A-1', knownPackage: () => false };
    for (const c of ['ravenseat undo A-1 --yes', 'ravenseat undo A-1 --dry', 'bash -c "ravenseat undo A-1 --yes"'])
      expect(PG.assess(c, track)?.decision, c).toBe('deny');
  });
});
