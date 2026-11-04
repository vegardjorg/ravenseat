// =============================================================
// liteMode.test.ts: the zero-config mode ("mode": "lite", lib/liteMode.js).
//
// Why: a new user met classes, value, content_min, focus, the batch queue and a small-task guard that refused tiny
// tasks before anything ran. Lite keeps the core loop: `add` with only a title, nothing refused for its size, the order
// added, a short help, and owner questions as before. Full mode stays the default for every config without `mode`, and
// an existing install is never switched by `init` without a flag. The pure parts are asserted directly; the CLI is run
// once per flow (init, add, help, mode) against a temporary queue, because that is where the rules are enforced.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown>;
/* eslint-disable @typescript-eslint/no-require-imports */
const LM = require('../liteMode') as {
  MODES: string[];
  LITE_DEFAULTS: Task;
  mode: (cfg: unknown) => string;
  isLite: (cfg: unknown) => boolean;
  nextId: (ids: string[], prefix: string) => string;
  liteDefaults: (tasks: Task[], queue?: Task) => { tasks: Task[]; notes: string[] };
  quickTask: (f: Task) => { task?: Task; error: string[] };
  setModeText: (text: string | null, mode: string) => string;
};
const H = require('../cliHelp') as {
  QUEUE_COMMANDS: string[];
  LITE_GROUPS: { commands: { cmd: string }[] }[];
  shortHelp: (cq?: string, o?: { lite?: boolean }) => string[];
};
const KK = require('../queueConfig') as { STANDARD: Task; merge: (a: Task, b: Task) => Task };
/* eslint-enable @typescript-eslint/no-require-imports */

describe('mode', () => {
  it('is full unless the config says lite (a config without the key keeps full)', () => {
    expect(LM.mode(KK.merge(KK.STANDARD, {}))).toBe('full');
    expect(LM.mode({})).toBe('full');
    expect(LM.mode({ mode: 'something' })).toBe('full');
    expect(LM.isLite(KK.merge(KK.STANDARD, { mode: 'lite' }))).toBe(true);
  });
});

describe('liteDefaults and quickTask', () => {
  const queue = { tasks: [{ id: 'T-001' }, { id: 'T-007' }, { id: 'X-99' }], projects: { tasks: { prefixes: ['T-'] } } };

  it('a title alone becomes a full task: next padded id, class K, neutral value and size, mission = title', () => {
    const { tasks, notes } = LM.liteDefaults([{ title: 'Fix the login bug' }, { title: 'Second' }], queue);
    expect(tasks[0]).toEqual({
      id: 'T-008',
      title: 'Fix the login bug',
      class: 'K',
      domain: 'general',
      feature: 'General',
      value: 5,
      content_min: 30,
      mission: 'Fix the login bug',
      project: 'tasks',
    });
    expect(tasks[1].id).toBe('T-009');
    expect(notes).toEqual([]);
  });

  it('given fields win, and the batch flag is dropped with a note (lite has no batch queue)', () => {
    const { tasks, notes } = LM.liteDefaults(
      [{ id: 'A-1', title: 't', class: 'D', value: 9, content_min: 5, project: 'other', batched: true }],
      queue,
    );
    expect(tasks[0]).toMatchObject({ id: 'A-1', class: 'D', value: 9, content_min: 5, project: 'other' });
    expect(tasks[0]).not.toHaveProperty('batched');
    expect(notes.join()).toMatch(/no batch queue/);
  });

  it('ids sort in the order they were added, and use the first project when "tasks" is missing', () => {
    expect(LM.nextId([], 'T-')).toBe('T-001');
    expect(LM.nextId(['T-009'], 'T-') < LM.nextId(['T-010'], 'T-')).toBe(true);
    const { tasks } = LM.liteDefaults([{ title: 'x' }], { tasks: [], projects: { example: { prefixes: ['EX-'] } } });
    expect(tasks[0]).toMatchObject({ id: 'EX-001', project: 'example' });
  });

  it('quickTask: --priority is the value (1-10), --files the owned files, no title is an error', () => {
    expect(LM.quickTask({ title: ' Do it ', priority: '8', files: 'src/a.js, src/b/' }).task).toEqual({
      title: 'Do it',
      value: 8,
      owned_files: ['src/a.js', 'src/b/'],
    });
    expect(LM.quickTask({ title: 'x', priority: '11' }).error.join()).toMatch(/1-10/);
    expect(LM.quickTask({ title: 'x', depends: 'T-001, T-002' }).task?.depends_on).toEqual(['T-001', 'T-002']);
    expect(LM.quickTask({}).error.join()).toMatch(/needs a title/);
  });
});

describe('setModeText', () => {
  it('a nested mode key (push.mode) stays as it is, and only the one word changes', () => {
    const src = '{\n  "push": { "mode": "owner" },\n  "mode": "lite",\n  "gates": { "quick": [] }\n}\n';
    expect(LM.setModeText(src, 'full')).toBe(src.replace('"lite"', '"full"'));
    const same = '{\n  "push": { "mode": "lite" },\n  "mode": "lite"\n}\n';
    expect(LM.setModeText(same, 'full')).toBe('{\n  "push": { "mode": "lite" },\n  "mode": "full"\n}\n');
  });

  it('inserts the key with the file own indentation and keeps the rest as written', () => {
    const src = '{\n    "projectName": "x",\n    "gates": { "quick": [] }\n}\n';
    const out = LM.setModeText(src, 'lite');
    expect(out).toBe('{\n    "mode": "lite",\n    "projectName": "x",\n    "gates": { "quick": [] }\n}\n');
    expect(LM.setModeText(out, 'full')).toBe(out.replace('"lite"', '"full"'));
    expect(LM.setModeText(out, 'lite')).toBe(out);
  });

  it('handles an empty file, a one-line object and refuses what is not a JSON object', () => {
    expect(JSON.parse(LM.setModeText('', 'lite'))).toEqual({ mode: 'lite' });
    expect(JSON.parse(LM.setModeText('{"a":"$1"}', 'lite'))).toEqual({ mode: 'lite', a: '$1' });
    expect(() => LM.setModeText('[1]', 'lite')).toThrow();
    expect(() => LM.setModeText('{', 'lite')).toThrow();
    expect(() => LM.setModeText('{}', 'turbo')).toThrow();
  });
});

describe('the lite help', () => {
  it('lists only core commands that exist, and says how to switch to full mode', () => {
    for (const c of H.LITE_GROUPS.flatMap((g) => g.commands)) expect(H.QUEUE_COMMANDS).toContain(c.cmd);
    const lite = H.shortHelp('cq', { lite: true }).join('\n');
    expect(lite).toMatch(/lite mode/);
    expect(lite).toMatch(/cq mode full/);
    expect(lite).not.toMatch(/approve|takeover|pick/);
    expect(H.shortHelp('cq').join('\n')).not.toMatch(/lite mode/);
  });
});

// ---- The CLI against a temporary queue -------------------------------------------------------------------------
let root = '';
let env: NodeJS.ProcessEnv = {};
const DIR = path.resolve(__dirname, '..', '..');
// Async (not spawnSync), so a slow, loaded machine does not block the vitest worker.
const run = (script: string, ...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(DIR, script), ...args], { cwd: root, env });
    let stdout = '';
    let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    p.on('error', reject);
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const cq = (...args: string[]) => run('queue.mjs', ...args);
const configFile = () => path.join(root, 'queue.config.json');
const queue = () => JSON.parse(fs.readFileSync(path.join(root, 'q', 'queue.json'), 'utf8'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-lite-'));
  env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: path.join(root, 'q'),
    QUEUE_CONFIG: configFile(),
    QUEUE_TIME_LOG: path.join(root, 'times.jsonl'),
    QUEUE_GIT: root,
    DISABLE_UPDATES: '1',
  };
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('cq init and .gitignore', () => {
  it('in a git repo, a fresh init adds the data folder once; a second init adds nothing', async () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    const init = await cq('init');
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain('Added q/ to .gitignore');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('\nq/\n');
    expect(spawnSync('git', ['check-ignore', '-q', 'q'], { cwd: root }).status).toBe(0);
    await cq('init');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').match(/^q\/$/gm)).toHaveLength(1);
  });

  it('a folder git already ignores is left alone, and outside git nothing is written', async () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    fs.writeFileSync(path.join(root, '.gitignore'), 'q/\n');
    expect((await cq('init')).stdout).not.toContain('to .gitignore');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('q/\n');
  });

  it('outside a git repo: no .gitignore', async () => {
    const init = await cq('init');
    expect(init.status, init.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });
});

describe('cq init, add, help and mode', () => {
  it('a fresh init is lite; add takes a title, refuses nothing for its size, keeps owner questions', async () => {
    const init = await cq('init');
    expect(init.status, init.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8'))).toEqual({ mode: 'lite' });
    expect(Object.keys(queue().projects)).toEqual(['tasks']);

    const typo = await cq('add', 'Later', '--depends', 'T-999');
    expect(typo.status).not.toBe(0);
    expect(typo.stderr + typo.stdout).toContain('unknown task(s): T-999');
    const a = await cq('add', 'Fix the login bug');
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toContain('Added: T-001');
    // A 5-minute task with low value: refused by the small-task guard in full mode, added in lite.
    const small = await cq('add', '--json', '{"title":"Tiny fix","content_min":5,"value":2}');
    expect(small.status, small.stderr).toBe(0);
    // Owner questions stay: waiting_on with a registered question blocks the task until it is resolved.
    const q = await cq(
      'add',
      '--json',
      '{"tasks":[{"title":"Needs you","waiting_on":["Q-1"]}],"question":{"Q-1":{"type":"question","text":"Which colour?"}}}',
    );
    expect(q.status, q.stderr).toBe(0);
    const t = queue().tasks;
    expect(t.map((o: Task) => o.id)).toEqual(['T-001', 'T-002', 'T-003']);
    expect(t[0]).toMatchObject({ class: 'K', value: 5, content_min: 30, status: 'waiting', mission: 'Fix the login bug' });
    const next = await cq('next');
    expect(next.stdout).toContain('T-001');
    expect(next.stdout).not.toContain('T-003');

    const help = await run('cq.mjs', 'help');
    expect(help.stdout).toContain('(lite mode)');
    expect(help.stdout).toContain('cq mode full');
  });

  it('cq mode full switches back: the guard and the JSON-only add return', async () => {
    expect((await cq('init', '--lite')).status).toBe(0);
    const m = await cq('mode', 'full');
    expect(m.status, m.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).mode).toBe('full');
    const quick = await cq('add', 'A title');
    expect(quick.status).not.toBe(0);
    expect(quick.stderr).toMatch(/lite mode/);
    const small = await cq(
      'add',
      '--json',
      '{"id":"T-9","title":"t","domain":"d","class":"K","mission":"m","content_min":5,"value":2}',
    );
    expect(small.status).not.toBe(0);
    expect(small.stderr).toMatch(/small task/);
    expect((await cq('mode')).stdout).toMatch(/Mode: full/);
  });

  it('never switches an existing install or a config with its own mode', async () => {
    // A config with mode full: a fresh init keeps full and the example project.
    fs.writeFileSync(configFile(), '{\n  "mode": "full"\n}\n');
    expect((await cq('init')).status).toBe(0);
    expect(Object.keys(queue().projects)).toEqual(['example']);
    // An existing queue with a config without mode: init changes nothing.
    fs.writeFileSync(configFile(), '{\n  "projectName": "x"\n}\n');
    const again = await cq('init');
    expect(again.stdout).toContain('already exists');
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{\n  "projectName": "x"\n}\n');
    // With a flag it does switch (the user asked).
    expect((await cq('init', '--lite')).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8'))).toEqual({ mode: 'lite', projectName: 'x' });
  });
});
