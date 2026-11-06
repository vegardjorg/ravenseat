// =============================================================
// trackAddFlow.test.ts: `ravenseat add` from a track's own worktree, through the real CLI.
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

function project(mode = 'lite') {
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
    JSON.stringify({ limits: {}, resolved: [], projects: { p: { title: 'P' } }, tasks: [{ id: 'A-1', title: 'a', domain: 'x', class: 'K', status: 'running', mission: 'm', project: 'p', feature: 'f' }, { id: 'B-1', title: 'b', domain: 'y', class: 'D', status: 'running', mission: 'm' }] }),
  );
  const configFile = path.join(repo, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode }));
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
  const worktreeB = path.join(folder, 'wt-b');
  g(['worktree', 'add', '-q', '-b', 'queue/B-1', worktreeB]);
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
    fromTrackB: (...args: string[]) => runIn(worktreeB, ...args),
    task: (id: string) => JSON.parse(fs.readFileSync(queueFile, 'utf8')).tasks.find((o: { id: string }) => o.id === id),
  };
}

describe('ravenseat add from a track', () => {
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

describe('ravenseat add from a track in full mode', () => {
  it('needs only id, title and mission: the rest follows the track, and the class is K', () => {
    const p = project('full');
    const r = p.fromTrack('add', '--json', JSON.stringify({ id: 'N-1', title: 'New', mission: 'm' }));
    expect(r.code).toBe(0);
    expect(p.task('N-1')).toMatchObject({ status: 'proposed', added_by: 'A-1', domain: 'x', class: 'K', project: 'p', feature: 'f' });
    expect(r.out).not.toContain('WARNING');
    expect(r.out).not.toContain('edit-many');
  });
  it('what the task says itself wins, and a D track does not make its proposal D', () => {
    const p = project('full');
    expect(p.fromTrack('add', '--json', JSON.stringify({ id: 'N-1', title: 'New', mission: 'm', domain: 'own', class: 'D' })).code).toBe(0);
    expect(p.task('N-1')).toMatchObject({ domain: 'own', class: 'D', project: 'p' });
    expect(p.fromTrackB('add', '--json', JSON.stringify({ id: 'N-2', title: 'New', mission: 'm' })).code).toBe(0);
    expect(p.task('N-2')).toMatchObject({ domain: 'y', class: 'K' });
  });
  it('a track without a project is not told to run a command it may not run', () => {
    const p = project('full');
    const r = p.fromTrackB('add', '--json', JSON.stringify({ id: 'N-1', title: 'New', mission: 'm' }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('nothing for you to do');
    expect(r.out).not.toContain('edit-many');
  });
  it('the small-task guard and the batch queue do not apply to a proposal', () => {
    const p = project('full');
    const small = { id: 'N-1', title: 'New', mission: 'm', value: 2, content_min: 10 };
    expect(p.fromTrack('add', '--json', JSON.stringify(small)).code).toBe(0);
    expect(p.task('N-1')).toMatchObject({ status: 'proposed', content_min: 10 });
    const r = p.fromTrack('add', '--json', JSON.stringify({ ...small, id: 'N-2', batched: true }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('does not go in the batch queue');
    expect(p.task('N-2').batched).toBeUndefined();
    // Approved, it can be started: nothing holds it back.
    expect(p.fromMain('approve', 'N-2').out).not.toContain('batch queue');
  });
  it('the guard still stops the same task from the main checkout', () => {
    const p = project('full');
    const r = p.fromMain('add', '--json', JSON.stringify({ id: 'M-1', title: 'New', mission: 'm', domain: 'x', class: 'K', value: 2, content_min: 10 }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('small task');
  });
  it('still needs a mission', () => {
    const p = project('full');
    const r = p.fromTrack('add', '--json', JSON.stringify({ id: 'N-1', title: 'New' }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('mission missing');
    expect(p.task('N-1')).toBeUndefined();
  });
});

describe('the owner sees the proposals', () => {
  it('show names them with where they came from, and proposals lists all of them', () => {
    const p = project('full');
    expect(p.fromTrack('add', '--json', JSON.stringify({ id: 'N-1', title: 'Document it', mission: 'm' })).code).toBe(0);
    const show = p.fromMain('show').out;
    expect(show).toContain('PROPOSED (1;');
    expect(show).toMatch(/N-1\s+from A-1\s+Document it/);
    const proposals = p.fromMain('proposals').out;
    expect(proposals).toContain('Proposals waiting (1;');
    expect(proposals).toMatch(/N-1\s+from A-1\s+Document it/);
  });
  it('a proposal in the batch queue is named everywhere, and approving it says it does not start alone', () => {
    const p = project('full');
    const small = { id: 'M-1', title: 'Small one', mission: 'm', domain: 'x', class: 'K', project: 'p', feature: 'f', value: 2, content_min: 10, batched: true, added_by: 'A-1' };
    expect(p.fromMain('add', '--json', JSON.stringify(small)).code).toBe(0);
    expect(p.task('M-1')).toMatchObject({ status: 'proposed', batched: true });
    const show = p.fromMain('show').out;
    expect(show).toContain('1 proposed');
    expect(show).toMatch(/M-1\s+from A-1\s+\[batch queue\]\s+Small one/);
    expect(p.fromMain('proposals').out).toMatch(/M-1\s+from A-1\s+\[batch queue\]\s+Small one/);
    expect(p.fromMain('decide', '--json').out).toContain('M-1');
    const approved = p.fromMain('approve', 'M-1').out;
    expect(approved).toContain('M-1 is in the batch queue');
    expect(approved).toContain('{"batched":false}');
  });
  it('with only the batch queue left, the summary does not say the queue is out of work', () => {
    const { stateLine } = require('../lib/queueLogic.js');
    const base = { activeOnes: 0, picked: 0, waiting: 0, proposed: 0, canStart: 0, empty: true };
    expect(stateLine({ ...base, batched: 1 })).toContain('ONLY THE BATCH QUEUE IS LEFT');
    expect(stateLine({ ...base, batched: 0 })).toContain('THE QUEUE IS OUT OF WORK');
  });
  it('show cuts the list at 5 and says where the rest is', () => {
    const { summaryView } = require('../lib/queueLogic.js');
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `N-${i}`, title: 't', domain: 'x', class: 'K', status: 'proposed', mission: 'm' }));
    const lines: string[] = summaryView({ limits: {}, resolved: [], projects: {}, tasks });
    expect(lines.filter((l) => /^ {2}N-\d/.test(l))).toHaveLength(5);
    expect(lines).toContain('  ... and 2 more (ravenseat proposals)');
  });
});

describe('the mission', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'mission-template.md'), 'utf8');
  const rendered = fs.readFileSync(path.resolve(__dirname, '..', 'lib', '__tests__', '__snapshots__', 'claudeDispatch', 'prompt-K1.md'), 'utf8');
  it('says it once, without the fields that send a track to the small-task guard', () => {
    expect(rendered.match(/New work/g)).toHaveLength(1);
    expect(rendered).not.toContain('content_min');
    expect(template).not.toContain('New work');
  });
  it('tells a track how to propose, and the form works as it stands', () => {
    expect(rendered).toContain('ravenseat add --json');
    const form = rendered.match(/ravenseat add --json '(\{.*\})'/);
    expect(form).not.toBeNull();
    const p = project('full');
    const r = p.fromTrack('add', '--json', (form as RegExpMatchArray)[1].replace('<new id>', 'N-1'));
    expect(r.code).toBe(0);
    expect(p.task('N-1').status).toBe('proposed');
  });
  it('gives --log a file name, not a folder', () => {
    expect(template).not.toContain('<folder>\\gates"');
    expect(template).toContain('<folder>\\gates.log"');
  });
});

describe('the hook', () => {
  it('lets a track add from its worktree, and nowhere else', () => {
    const p = project();
    expect(p.hook(p.worktree, 'track', 'ravenseat add --file task.json')).toBeNull();
    expect(p.hook(p.worktree, 'track', 'ravenseat add --file task.json --approved')).toBe('deny');
    expect(p.hook(p.worktree, 'track', `cd "${p.repo}" && ravenseat add --file task.json`)).toBe('deny');
    expect(p.hook(p.repo, 'track', 'ravenseat add --file task.json')).toBe('deny');
    expect(p.hook(p.repo, 'reviewer', 'ravenseat add --file task.json')).toBe('deny');
    // The main session has no agent_type and is not touched.
    expect(p.hook(p.repo, null, 'ravenseat add --file task.json --approved')).toBeNull();
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

describe('ravenseat add from the main checkout', () => {
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
