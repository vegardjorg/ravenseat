// =============================================================
// kickstartFlow.test.ts: `ravenseat kickstart` through the real CLI, in a temporary project.
//
// Locks: (1) it works with no git and no queue, and writes nothing; (2) gates are written only with --apply and never over
// existing ones; (3) `add` gives a PROPOSED task, in lite and in full mode, and asks nothing twice; (4) a cancelled step is
// not proposed again.
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

function project({ git = true, remote = '', config = {}, files = {} as Record<string, string>, queue = true } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-kickstart-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), text);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', ...config }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // A temporary folder can sit under a git repo on a developer's machine: stop the search at the folder.
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  if (git) {
    const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { env, stdio: 'ignore' });
    g(['init', '-q', '-b', 'main']);
    g(['commit', '-q', '--allow-empty', '-m', 'start']);
    if (remote) g(['remote', 'add', 'origin', remote]);
  }
  if (queue) fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks: [] }));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: repo });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const json = () => JSON.parse(run('kickstart', '--json').all);
  const gates = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).gates;
  const task = (id: string) => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks.find((o: { id: string }) => o.id === id);
  return { repo, run, json, gates, task, folder };
}

const NODE = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } }) };

describe('ravenseat kickstart: the overview', () => {
  it('works with no git and no queue, says git comes first, and writes nothing', () => {
    const p = project({ git: false, queue: false, files: NODE });
    const before = fs.readdirSync(p.folder).sort();
    const r = p.run('kickstart');
    expect(r.code).toBe(0);
    expect(r.all).toContain('Next: Put the project under git');
    expect(r.all).toContain('npm test (package.json)');
    expect(fs.readdirSync(p.folder).sort()).toEqual(before);
    expect(fs.readdirSync(p.repo)).toEqual(['package.json']);
  });
  it('outside any git repo it reads the folder the user stands in, and refuses to write', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-kickstart-nogit-'));
    temporary.push(folder);
    fs.writeFileSync(path.join(folder, 'package.json'), NODE['package.json']);
    // Only the real fallback counts here: no QUEUE_* or project variable, and no git repo above the temporary folder.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('QUEUE_') && k !== 'CLAUDE_PROJECT_DIR'));
    const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: folder, env, encoding: 'utf8' }).status === 0;
    if (inGit) return;
    const run = (...args: string[]) => spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder });
    const seen = JSON.parse(run('kickstart', '--json').stdout);
    expect(seen.facts.git).toBe(false);
    expect(seen.facts.stacks).toEqual(['Node']);
    expect(seen.next).toBe('git');
    const applied = run('kickstart', 'gates', '--apply');
    expect(applied.status).toBe(1);
    expect(`${applied.stdout}${applied.stderr}`).toContain('git init');
  });
  it('explains the next step in plain words and says nothing starts by itself', () => {
    const r = project().run('kickstart');
    expect(r.all).toContain('Next: Add a first automatic check');
    expect(r.all).toContain('Why: ');
    expect(r.all).toContain('Nothing here starts by itself');
  });
});

describe('ravenseat kickstart gates', () => {
  it('shows the lists and writes nothing without --apply', () => {
    const p = project({ files: NODE });
    const r = p.run('kickstart', 'gates');
    expect(r.all).toContain('gates.quick (before every delivery): npm test');
    expect(r.all).toContain('Nothing written');
    expect(p.gates()).toBeUndefined();
  });
  it('--apply writes them, keeps the rest of the config, and the step is then done', () => {
    const p = project({ files: NODE, config: { projectName: 'x' } });
    expect(p.run('kickstart', 'gates', '--apply').code).toBe(0);
    expect(p.gates()).toEqual({ quick: ['npm test'], full: ['npm test', 'npm run build'] });
    expect(p.json().steps.find((s: { key: string }) => s.key === 'gates').state).toBe('done');
  });
  it('never replaces gates that are set', () => {
    const p = project({ files: NODE, config: { gates: { quick: ['my check'] } } });
    expect(p.run('kickstart', 'gates', '--apply').all).toContain('already set');
    expect(p.gates()).toEqual({ quick: ['my check'] });
  });
});

describe('ravenseat kickstart add', () => {
  it('proposes the next step in lite mode: it does not start, and it is not asked twice', () => {
    const p = project({ config: { mode: 'lite' } });
    const r = p.run('kickstart', 'add');
    expect(r.code).toBe(0);
    expect(r.all).toContain('uses tokens');
    expect(p.task('KS-CHECK').status).toBe('proposed');
    expect(p.run('kickstart', 'add', 'gates').all).toContain('already in the queue');
  });
  it('works in full mode too, with its own project', () => {
    const p = project({ config: { gates: { quick: ['x'] } }, remote: 'git@github.com:a/b.git' });
    const r = p.run('kickstart', 'add', 'ci');
    expect(r.code).toBe(0);
    expect(p.task('KS-CI')).toMatchObject({ status: 'proposed', project: 'cicd', labels: ['kickstart'] });
  });
  it('a cancelled step stays declined', () => {
    const p = project({ config: { mode: 'lite' } });
    p.run('kickstart', 'add');
    expect(p.run('set', 'KS-CHECK', 'cancelled', '--remark', 'not now').code).toBe(0);
    expect(p.json().steps.find((s: { key: string }) => s.key === 'gates').state).toBe('declined');
    expect(p.run('kickstart', 'add', 'gates').all).toContain('was cancelled');
  });
  it('without a queue it says to run init', () => {
    const r = project({ queue: false }).run('kickstart', 'add');
    expect(r.code).toBe(1);
    expect(r.all).toContain('init');
  });
});
