// =============================================================
// queueGateBroken.test.ts: "the gate cannot run" at `ravenseat receive` (lib/gateBroken.js, gates.brokenVerdict).
//
// Locks: (1) a quick gate whose first program is missing on this machine (on the delivered tip AND on the base) starts
// no fix round: receive exits 8, registers one owner question tied to the hash of the gates setup, opens the blocker
// owner-question and keeps the verdict on the task (gate_broken); (2) a second receive with the same setup asks no new
// question and starts no round; (3) a changed gates setup forgets the old verdict (a new hash, a new question);
// (4) "Cannot find module" from the track's own code is a code failure: a fix round as before; (5) with
// gates.brokenVerdict false the old behaviour is kept (a fix round).
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and a temporary git repo (QUEUE_GIT) with a worktree for the
// track branch, as queueGateEvidence.test.ts. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[]; question?: Record<string, { text: string }> };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
// A program no machine has: the shell cannot start it, on the tip or on the base.
const MISSING = 'ravenseat-test-no-such-tool --check';
// The track's own code requires a module that does not exist: node starts fine, the code fails.
const CODE_RED = 'node lib/start.js';

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
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gate-broken-'));
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
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.mkdirSync(path.join(worktree, 'lib'));
  fs.writeFileSync(path.join(worktree, 'lib', 'start.js'), "require('./not-written-yet.js');\n");
  g(['add', '--', 'lib/start.js'], worktree);
  g(['commit', '-q', '-m', 'feat: start'], worktree);
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
    owned_files: ['lib/start.js'],
    started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A',
    migr_block: null,
    scratchpad: scratch,
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  const writeConfig = (c: Record<string, unknown>) =>
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3, ...c }));
  writeConfig(config);
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
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env,
      cwd: folder,
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue;
  const find = () => queue().tasks[0];
  const report = () => {
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'A', 'track-result.md'), `${RES}\n\n# Report A\n`);
  };
  return { folder, run, find, queue, report, writeConfig };
}

const openBlocks = (t: Task) => ((t.blocks ?? []) as { code: string; to?: string }[]).filter((b) => !b.to).map((b) => b.code);

describe('ravenseat receive: the gate cannot run', () => {
  it('a missing first program on the tip and the base is an owner question at once, not a fix round', () => {
    const p = project({ gates: { quick: [MISSING] } });
    p.report();
    const r = p.run('receive', 'A');
    expect(r.out).toContain('GATE CANNOT RUN');
    expect(r.out).toContain('ravenseat-test-no-such-tool');
    expect(r.out).not.toContain('RESUME A-r1');
    expect(r.code).toBe(8);
    const t = p.find();
    const broken = t.gate_broken as { setup_hash: string; question: string; program: string; commands: string[] };
    expect(broken).toMatchObject({ program: 'ravenseat-test-no-such-tool', commands: [MISSING] });
    expect(broken.setup_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(broken.question).toContain(broken.setup_hash.slice(0, 8));
    expect(p.queue().question?.[broken.question]?.text).toContain('cannot run');
    expect(t.waiting_on).toContain(broken.question);
    expect(openBlocks(t)).toContain('owner-question');
    expect(t.resumed ?? []).toHaveLength(0);

    // The same setup again: the same verdict, no second question, still no round.
    const r2 = p.run('receive', 'A');
    expect(r2.code).toBe(8);
    expect(r2.out).not.toContain('RESUME A-r1');
    expect(Object.keys(p.queue().question ?? {}).filter((q) => q.includes('nogate'))).toHaveLength(1);

    // A changed gates setup forgets the old verdict: a new hash and a new question.
    p.writeConfig({ gates: { quick: [MISSING, 'node -e "process.exit(0)"'] } });
    const r3 = p.run('receive', 'A');
    expect(r3.code).toBe(8);
    const again = p.find().gate_broken as { setup_hash: string; question: string };
    expect(again.setup_hash).not.toBe(broken.setup_hash);
    expect(again.question).not.toBe(broken.question);

    // The owner's answer allows a fix round, as for the cap and the plateau.
    expect(p.run('resolve', again.question, '--answer', 'Try a round anyway.').code).toBe(0);
    const r4 = p.run('receive', 'A');
    expect(r4.out).not.toContain('GATE CANNOT RUN');
    expect(r4.out).toContain('RESUME A-r1 (fix)');
  });

  it('"Cannot find module" from the track\'s own code stays a code failure: a fix round', () => {
    const p = project({ gates: { quick: [CODE_RED] } });
    p.report();
    const r = p.run('receive', 'A');
    expect(r.out).not.toContain('GATE CANNOT RUN');
    expect(r.out).toContain('RESUME A-r1 (fix)');
    expect(r.code).toBe(1);
    expect(p.find().gate_broken).toBeUndefined();
  });

  it('gates.brokenVerdict false keeps the old behaviour: a fix round', () => {
    const p = project({ gates: { quick: [MISSING], brokenVerdict: false } });
    p.report();
    const r = p.run('receive', 'A');
    expect(r.out).not.toContain('GATE CANNOT RUN');
    expect(r.out).toContain('RESUME A-r1 (fix)');
    expect(r.code).toBe(1);
  });
});
