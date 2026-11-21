// =============================================================
// zeroTestsGate.test.ts: "green, but no tests ran" (GS-1, lib/zeroTests.js) through the real gates.mjs and
// `ravenseat receive`.
//
// Locks: (1) a green quick gate whose output says no test ran gives a NOTE line, `zero_tests` in the evidence entry,
// `gate_check.zeroTests` on the task and a section in the review package, and receive still goes on (never a stop); a
// second receive on the same tip reuses the evidence and keeps the caveat; (2) a normal green run gives none of it;
// (3) a green done command whose tail says no test ran gives `done_check.zeroTests` and the NOTE line.
// Runs against a temporary queue (QUEUE_FOLDER) and git repo (QUEUE_GIT) with a worktree for the track branch, as
// trackFlakyGate.test.ts. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[] };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GATES = path.join(ROOT, 'scripts', 'orchestrator', 'gates.mjs');
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';

// The gate prints what a runner would and exits 0: "none" is vitest with a filter that matched nothing, "tests" a normal
// run, "unittest0" Python's unittest that ran nothing.
const GATE_JS = [
  'const mode = process.argv[2];',
  "if (mode === 'none') console.log('No test files found, exiting with code 0');",
  "if (mode === 'tests') console.log(' Test Files  3 passed (3)\\n      Tests  12 passed (12)');",
  "if (mode === 'unittest0') console.log('Ran 0 tests in 0.000s\\n\\nOK');",
  'process.exit(0);',
  '',
].join('\n');
const gate = (mode: string) => `node gate.js ${mode}`;

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

function project(config: Record<string, unknown>, taskExtra: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-zero-tests-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(repo);
  fs.mkdirSync(scratch);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  fs.writeFileSync(path.join(repo, 'gate.js'), GATE_JS);
  g(['add', '--', 'README.md', 'gate.js']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.mkdirSync(path.join(worktree, 'lib'));
  fs.writeFileSync(path.join(worktree, 'lib', 'A.ts'), 'export const a = 1;\n');
  g(['add', '--', 'lib/A.ts'], worktree);
  g(['commit', '-q', '-m', 'feat: A'], worktree);
  const task: Task = {
    id: 'A',
    title: 'Task A',
    domain: 'dom-A',
    class: 'K',
    status: 'running',
    mission: 'The mission for A.',
    value: 5,
    content_min: 60,
    depends_on: [],
    waiting_on: [],
    owned_files: ['lib/A.ts'],
    started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A',
    migr_block: null,
    scratchpad: scratch,
    ...taskExtra,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({
      created: task.started,
      limits: {},
      next_migr: 3600,
      resolved: [],
      projects: { app: { title: 'App', prefixes: ['A'] } },
      tasks: [task],
    }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3, ...config }));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const gates = (cwd = worktree) => {
    const r = spawnSync(process.execPath, [GATES, '--quick'], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const find = () => (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue).tasks[0];
  const report = (text: string) => {
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    const f = path.join(scratch, 'A', 'track-result.md');
    fs.writeFileSync(f, text);
    const later = Date.now() / 1000 + 60;
    fs.utimesSync(f, later, later);
  };
  const evidence = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(folder, 'gate-evidence.json'), 'utf8')).entries as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  const pkg = () => fs.readFileSync(path.join(String(find().review_package), '00-package.md'), 'utf8');
  return { run, gates, find, report, evidence, pkg };
}

describe('green, but no tests ran', () => {
  it('a quick gate that ran no test: NOTE, evidence, gate_check.zeroTests, package section; receive goes on', () => {
    const p = project({ gates: { quick: [gate('none')] } });
    p.report(`${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Gates GREEN');
    expect(r.out).toMatch(/NOTE A: green, but no tests ran \(quick gate: No test files found/);
    expect(p.evidence().at(-1)).toMatchObject({
      ok: true,
      zero_tests: [{ command: gate('none'), runner: 'vitest', signal: 'No test files found' }],
    });
    expect(p.find().status).toBe('review');
    expect(p.find().gate_check).toMatchObject({
      ok: true,
      zeroTests: [{ gate: 'quick', command: gate('none'), runner: 'vitest', signal: 'No test files found' }],
    });
    expect(p.pkg()).toContain('## Green, but no tests ran');

    // The same tip again: the evidence is reused (nothing runs), and the caveat stays.
    const r2 = p.run('receive', 'A');
    expect(r2.code).toBe(0);
    expect(r2.out).toContain('not run again');
    expect(r2.out).toContain('NOTE A: green, but no tests ran');
    expect((p.find().gate_check as { zeroTests?: unknown[] }).zeroTests).toHaveLength(1);
  }, 240_000);

  it('a normal green run gives no caveat', () => {
    const p = project({ gates: { quick: [gate('tests')] } });
    p.report(`${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('no tests ran');
    expect(p.evidence().at(-1)?.zero_tests).toBeUndefined();
    expect(p.find().gate_check).not.toHaveProperty('zeroTests');
    expect(p.pkg()).not.toContain('no tests ran');
  }, 240_000);

  it("gates.mjs says it on screen for a track's own run", () => {
    const p = project({ gates: { quick: [gate('none')] } });
    const r = p.gates();
    expect(r.code).toBe(0);
    expect(r.out).toContain('NOTE: green, but no tests ran');
  }, 120_000);

  it('a green done command that ran no test: done_check.zeroTests and the NOTE line', () => {
    const p = project({ gates: { quick: [gate('tests')] } }, { done_when: gate('unittest0') });
    p.report(`${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Done command GREEN');
    expect(r.out).toMatch(/NOTE A: green, but no tests ran \(done command: Ran 0 tests/);
    expect(p.find().done_check).toMatchObject({
      ok: true,
      zeroTests: [{ gate: 'done_when', command: gate('unittest0'), runner: 'unittest', signal: 'Ran 0 tests' }],
    });
    expect(p.find().gate_check).not.toHaveProperty('zeroTests');
  }, 240_000);
});
