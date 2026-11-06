// =============================================================
// gateFlow.test.ts: `ravenseat gate`, and `ravenseat init` outside git, through the real CLI in a temporary project.
//
// Locks: (1) a known bug is proposed by default and never starts by itself; (2) the setting auto approves it and off does
// nothing; (3) the same class again does not add a second task, and a cancelled one is not proposed again; (4) full mode
// works too; (5) init does not write into the plugin's own folder outside git.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
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

function project(config: object = { mode: 'lite' }) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gate-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...config }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  execFileSync('git', ['-C', repo, ...ID, 'init', '-q', '-b', 'main'], { env, stdio: 'ignore' });
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks: [] }));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: repo });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const tasks = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks as { id: string; status: string; mission: string; project?: string; labels: string[] }[];
  return { run, tasks };
}

describe('ravenseat gate', () => {
  it('proposes by default: the task waits for the owner', () => {
    const p = project();
    const r = p.run('gate', 'a missing error check', '--from', 'T-1', '--where', 'a.js:3');
    expect(r.code).toBe(0);
    expect(r.all).toContain('GATE-1 proposed');
    expect(p.tasks()[0]).toMatchObject({ id: 'GATE-1', status: 'proposed', labels: ['gate'] });
    expect(p.tasks()[0].mission).toContain('a.js:3');
  });
  it('auto approves it at once, and off adds nothing', () => {
    const auto = project({ mode: 'lite', gates: { fromKnownBugs: 'auto' } });
    expect(auto.run('gate', 'x').all).toContain('approved');
    expect(auto.tasks()[0].status).toBe('waiting');
    const off = project({ mode: 'lite', gates: { fromKnownBugs: 'off' } });
    expect(off.run('gate', 'x').all).toContain('nothing was added');
    expect(off.tasks()).toEqual([]);
  });
  it('the same class adds the new place to the open task, not a second task', () => {
    const p = project();
    p.run('gate', 'a missing check', '--from', 'T-1');
    const r = p.run('gate', 'A missing check!', '--from', 'T-2');
    expect(r.all).toContain('new place was added');
    expect(p.tasks()).toHaveLength(1);
    expect(p.tasks()[0].mission).toContain('task T-2');
  });
  it('a cancelled class is not proposed again', () => {
    const p = project();
    p.run('gate', 'a missing check');
    expect(p.run('set', 'GATE-1', 'cancelled', '--remark', 'no').code).toBe(0);
    expect(p.run('gate', 'a missing check').all).toContain('was cancelled');
    expect(p.tasks()).toHaveLength(1);
  });
  it('stops at three open gate tasks and says what to do', () => {
    const p = project();
    for (const x of ['a', 'b', 'c']) p.run('gate', x);
    const r = p.run('gate', 'd');
    expect(r.all).toContain('already open');
    expect(p.tasks()).toHaveLength(3);
    expect(p.run('gate', 'list').all).toContain('GATE-3');
  });
  it('works in full mode, in the project for this work', () => {
    const p = project({});
    const r = p.run('gate', 'a missing check');
    expect(r.code).toBe(0);
    expect(p.tasks()[0]).toMatchObject({ status: 'proposed', project: 'cicd' });
  });
  it('the overview counts it', () => {
    const p = project();
    p.run('gate', 'a missing check');
    expect(JSON.parse(p.run('kickstart', '--json').all).knownBugs).toMatchObject({ mode: 'propose', proposed: 1, open: 1 });
  });
});

describe('init outside git', () => {
  it('stops with the way forward, and writes nothing into the folder of the scripts', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-init-nogit-'));
    temporary.push(folder);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('QUEUE_') && k !== 'CLAUDE_PROJECT_DIR'));
    // Only the real fallback counts: no git repo above the temporary folder.
    if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: folder, env, encoding: 'utf8' }).status === 0) return;
    const pluginRoot = path.resolve(__dirname, '..', '..', '..');
    const before = fs.readdirSync(pluginRoot).sort();
    const r = spawnSync(process.execPath, [QUEUE, 'init'], { encoding: 'utf8', env, cwd: folder });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('git init');
    expect(fs.readdirSync(pluginRoot).sort()).toEqual(before);
  });
});
