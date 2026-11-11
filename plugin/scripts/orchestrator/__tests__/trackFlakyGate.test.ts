// =============================================================
// trackFlakyGate.test.ts: the flaky check on a track's gate (lib/trackFlaky.js) through the real gates.mjs and
// `ravenseat receive`.
//
// Locks: (1) a red quick gate in a track's worktree reruns ONLY its red commands once on the same commit; green then is
// green with FLAKY on screen, `flaky` in the gate row and a flakyGate row with the track's id in the time log; (2) red
// twice stays red; (3) gates.flakyRerun false reruns nothing; (4) no rerun on a dirty tree, and a rerun that dirties the
// tree or moves HEAD is red; (5) a run in the main checkout is the base gate's and reruns nothing here; (6) receive:
// a flaky gate gives green evidence for exactly the delivered tip with `flaky`, gate_check.flaky, a finding (deduplicated
// on the command, its count going up when the command is flaky on the same track again), the FLAKY line and a section in
// the review package; red twice is a fix round as before.
// Runs against a temporary queue (QUEUE_FOLDER) and git repo (QUEUE_GIT) with a worktree for the track branch, as
// queueGateEvidence.test.ts. Never the main repo or the real queue. The gate is a tiny `node gate.js <name> <mode>` that
// counts its runs in a file and, in the flaky modes, is red the first time and green the second (a marker file).
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

// The gate: counts each run (COUNT_FILE), then by mode: green, red, or red the first time and on the second run green
// (flaky), green after a write to a tracked file (dirty), or green after a commit that moves HEAD (commit).
const GATE_JS = [
  "const fs = require('fs'); const cp = require('child_process');",
  'const [name, mode] = process.argv.slice(2);',
  "if (process.env.COUNT_FILE) fs.appendFileSync(process.env.COUNT_FILE, name + '\\n');",
  "if (mode === 'green') process.exit(0);",
  "if (mode === 'red') { console.log(name + ' red'); process.exit(1); }",
  "const marker = process.env.MARK_DIR + '/' + name;",
  "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); console.log(name + ' red the first time'); process.exit(1); }",
  "if (mode === 'dirty') fs.appendFileSync('README.md', 'changed by the gate\\n');",
  "if (mode === 'commit') cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'moved']);",
  'process.exit(0);',
  '',
].join('\n');
const gate = (name: string, mode: string) => `node gate.js ${name} ${mode}`;
const LINT = gate('lint', 'green');
const TEST = gate('test', 'flaky');

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

function project(config: Record<string, unknown>) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-track-flaky-'));
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-track-flaky-marks-'));
  temporary.push(folder, marks);
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
  const timeLog = path.join(folder, 'times.jsonl');
  const countFile = path.join(marks, 'count.txt');
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    COUNT_FILE: countFile,
    MARK_DIR: marks,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  /** gates.mjs itself, as `ravenseat gates --quick` from the folder (the track's worktree by default). */
  const gates = (cwd = worktree, ...extra: string[]) => {
    const r = spawnSync(process.execPath, [GATES, '--quick', ...extra], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const find = () => (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue).tasks[0];
  let n = 0;
  const report = (dir: string, text: string) => {
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    const f = path.join(scratch, dir, 'track-result.md');
    fs.writeFileSync(f, text);
    const later = Date.now() / 1000 + 60 * ++n;
    fs.utimesSync(f, later, later);
  };
  const evidence = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(folder, 'gate-evidence.json'), 'utf8')).entries as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  const rows = (event: string) =>
    fs.existsSync(timeLog)
      ? fs
          .readFileSync(timeLog, 'utf8')
          .split('\n')
          .filter((l) => l.includes(`"${event}"`))
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((r) => r.event === event)
      : [];
  /** How often each gate command ran, by its name. */
  const counts = () => {
    const out: Record<string, number> = {};
    if (!fs.existsSync(countFile)) return out;
    for (const l of fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean)) out[l] = (out[l] ?? 0) + 1;
    return out;
  };
  const resetCounts = () => fs.rmSync(countFile, { force: true });
  const unmark = (name: string) => fs.rmSync(path.join(marks, name), { force: true });
  const findings = () => {
    const file = path.join(folder, 'plans.json');
    if (!fs.existsSync(file)) return [];
    return (JSON.parse(fs.readFileSync(file, 'utf8')).entries as { title: string; finding?: { count: number } }[]).filter((e) => e.finding);
  };
  const tip = () => g(['rev-parse', 'queue/A']);
  return { folder, repo, worktree, scratch, g, run, gates, find, report, evidence, rows, counts, resetCounts, unmark, findings, tip, env };
}

describe('the flaky check on a track gate (gates.mjs)', () => {
  it('red, then green on a rerun of only the red command on the same commit: green, FLAKY, the rows', () => {
    const p = project({ gates: { quick: [LINT, TEST] } });
    const r = p.gates();
    expect(r.out).toContain(`FLAKY: \`${TEST}\``);
    expect(r.out).toContain('ALL GREEN');
    expect(r.code).toBe(0);
    // Only the red command ran again: lint once, test twice.
    expect(p.counts()).toEqual({ lint: 1, test: 2 });
    const gateRow = p.rows('gate').at(-1);
    expect(gateRow).toMatchObject({ ok: true, exit: 0, failed: [], flaky: [TEST], track: 'A', sha: p.tip() });
    const flaky = p.rows('flakyGate');
    expect(flaky).toHaveLength(1);
    expect(flaky[0]).toMatchObject({ event: 'flakyGate', tip: p.tip(), commands: [TEST], task: 'A' });
    expect(String(flaky[0].source)).toContain('track gate');
  }, 120_000);

  it('red twice is red, and the rerun happens once only', () => {
    const p = project({ gates: { quick: [LINT, gate('test', 'red')] } });
    const r = p.gates();
    expect(r.code).toBe(1);
    expect(r.out).toContain('red again');
    expect(r.out).not.toContain('FLAKY:');
    expect(p.counts()).toEqual({ lint: 1, test: 2 });
    expect(p.rows('gate').at(-1)).toMatchObject({ ok: false, failed: [gate('test', 'red')] });
    expect(p.rows('gate').at(-1)).not.toHaveProperty('flaky');
    expect(p.rows('flakyGate')).toHaveLength(0);
  }, 120_000);

  it('gates.flakyRerun false: no rerun', () => {
    const p = project({ gates: { quick: [LINT, TEST], flakyRerun: false } });
    const r = p.gates();
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('FLAKY');
    expect(p.counts()).toEqual({ lint: 1, test: 1 });
    expect(p.rows('flakyGate')).toHaveLength(0);
  }, 120_000);

  it('no rerun on a dirty tree; a rerun that dirties the tree or moves HEAD is red', () => {
    const p = project({ gates: { quick: [TEST] } });
    fs.appendFileSync(path.join(p.worktree, 'lib', 'A.ts'), '// not committed\n');
    const dirty = p.gates();
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain('uncommitted');
    expect(p.counts()).toEqual({ test: 1 });
    p.g(['checkout', '-q', '--', 'lib/A.ts'], p.worktree);

    const q = project({ gates: { quick: [gate('test', 'dirty')] } });
    const r1 = q.gates();
    expect(r1.code).toBe(1);
    expect(r1.out).not.toContain('FLAKY:');
    expect(q.counts()).toEqual({ test: 2 });
    expect(q.rows('flakyGate')).toHaveLength(0);

    const s = project({ gates: { quick: [gate('test', 'commit')] } });
    const before = s.tip();
    const r2 = s.gates();
    expect(r2.code).toBe(1);
    expect(r2.out).not.toContain('FLAKY:');
    expect(s.tip()).not.toBe(before);
    expect(s.rows('flakyGate')).toHaveLength(0);
  }, 180_000);

  it('a run in the main checkout is the base gate\'s: no rerun here', () => {
    const p = project({ gates: { quick: [TEST] } });
    const r = p.gates(p.repo);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('FLAKY');
    expect(p.counts()).toEqual({ test: 1 });
  }, 120_000);
});

describe('the flaky check at receive', () => {
  it('green evidence bound to the tip with flaky, the finding, the line and the package section; the count goes up', () => {
    const p = project({ gates: { quick: [LINT, TEST] } });
    p.report('A', `${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Gates GREEN');
    expect(r.out).toContain(`FLAKY A: \`${TEST}\``);
    expect(p.counts()).toEqual({ lint: 1, test: 2 });
    const tipA = p.tip();
    const entry = p.evidence().at(-1);
    expect(entry).toMatchObject({ sha: tipA, ok: true, clean: true, kind: 'quick', track: 'A', flaky: [TEST], failed: [] });
    expect(p.find().gate_check).toMatchObject({ ok: true, tip: tipA, ran: true, flaky: [TEST], flaky_times: { [TEST]: 1 } });
    const pkg = fs.readFileSync(path.join(String(p.find().review_package), '00-package.md'), 'utf8');
    expect(pkg).toContain('## Flaky gate commands');
    expect(pkg).toContain(`\`${TEST}\``);
    expect(p.findings()).toHaveLength(1);
    expect(p.findings()[0].title).toContain(TEST);
    expect(p.findings()[0].finding?.count).toBe(1);
    expect(p.rows('flakyGate')).toHaveLength(1);

    // A new commit and the same command flaky again: still green, the same finding counts 2, and the line says so.
    fs.writeFileSync(path.join(p.worktree, 'lib', 'B.ts'), 'export const b = 1;\n');
    p.g(['add', '--', 'lib/B.ts'], p.worktree);
    p.g(['commit', '-q', '-m', 'feat: b'], p.worktree);
    p.unmark('test');
    const r2 = p.run('receive', 'A');
    expect(r2.code).toBe(0);
    expect(r2.out).toContain('2 times on this track');
    expect(p.find().gate_check).toMatchObject({ ok: true, tip: p.tip(), flaky: [TEST], flaky_times: { [TEST]: 2 } });
    expect(p.findings()).toHaveLength(1);
    expect(p.findings()[0].finding?.count).toBe(2);
    expect(p.rows('flakyGate')).toHaveLength(2);
    expect(p.run('cost').out).toMatch(/flaky gate command\(s\): 2/);
  }, 240_000);

  it('red twice at receive is a fix round as before', () => {
    const p = project({ gates: { quick: [LINT, gate('test', 'red')] } });
    p.report('A', `${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(1);
    expect(r.out).toContain('NOT DONE');
    expect(r.out).toContain('RESUME A-r1 (fix)');
    expect(r.out).not.toContain('FLAKY A');
    expect(p.evidence().at(-1)).toMatchObject({ sha: p.tip(), ok: false });
    expect(p.evidence().at(-1)).not.toHaveProperty('flaky');
    expect(p.findings()).toHaveLength(0);
  }, 240_000);
});
