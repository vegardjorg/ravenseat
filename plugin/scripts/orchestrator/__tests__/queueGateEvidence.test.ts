// =============================================================
// queueGateEvidence.test.ts: `cq receive` binds the gate result to the delivered tip (lib/gateEvidence.js).
//
// Locks: (1) a track that claims green (RESULT gates=OK) and has a forged green gate row in the time log for its tip,
// and a forged evidence entry for ANOTHER sha, is not believed: receive runs the quick gate itself in the track's
// worktree, the gate is red, and receive gives a fix round (exit 1), never a review; (2) a green run records evidence
// for exactly the tip (clean, by gates.mjs), and a second receive on the same tip does not run the gate again; a new
// commit does; (3) uncommitted tracked changes in the worktree, or no worktree with the branch, refuse the receive
// (exit 1, nothing changed); (4) a PARTIAL track and a project without quick gates run no gate.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and a temporary git repo (QUEUE_GIT) with a worktree for the
// track branch, as queueDoneCheck.test.ts. Never the main repo or the real queue. The gates are tiny `node -e` scripts.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[] };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
// Green only where lib/OK.ts exists (the track adds it in its fix); red otherwise.
const GATE = `node -e "process.exit(require('fs').existsSync('lib/OK.ts')?0:1)"`;

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
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-gate-evidence-'));
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
    owned_files: ['lib/A.ts', 'lib/OK.ts'],
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
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3, ...config }));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  const timeLog = path.join(folder, 'times.jsonl');
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: timeLog,
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
  const find = () => (JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue).tasks[0];
  let n = 0;
  const report = (dir: string, text: string) => {
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    const f = path.join(scratch, dir, 'report.md');
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
  const tip = () => g(['rev-parse', 'queue/A']);
  return { folder, repo, worktree, scratch, g, run, find, report, evidence, tip, timeLog, env };
}

describe('cq receive with gate evidence', () => {
  it('a self-reported green and forged rows (time log, another sha) are not believed: receive runs the gate', () => {
    const p = project({ gates: { quick: [GATE] } });
    const tipA = p.tip();
    // The forgeries a track can make: a green RESULT line, a green gate row in the time log for its own tip (the file
    // every agent appends to), and a green evidence entry for a different commit.
    fs.writeFileSync(
      p.timeLog,
      JSON.stringify({ time: 't', event: 'gate', kind: 'quick', sha: tipA, ok: true, exit: 0, clean: true, gates: [GATE], failed: [] }) + '\n',
    );
    const other = p.g(['rev-parse', 'develop']);
    fs.writeFileSync(
      path.join(p.folder, 'gate-evidence.json'),
      JSON.stringify({ version: 1, entries: [{ time: 't', by: 'gates.mjs', sha: other, kind: 'quick', ok: true, exit: 0, clean: true, gates: [GATE], failed: [] }] }),
    );
    p.report('A', `${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.out).toContain('GATES (receive) for A');
    expect(r.out).toContain('RESULT gates=OK is self-reported');
    expect(r.out).toContain('NOT DONE');
    expect(r.code).toBe(1);
    expect(r.out).toContain('RESUME A-r1 (fix)');
    expect(p.find()).toMatchObject({ status: 'review', gate_check: { ok: false, tip: tipA, kind: 'quick' } });
    expect((p.find().blocks as { code: string; to?: string }[]).find((b) => !b.to)?.code).toBe('gate-red');
    // The trusted run is recorded for exactly the tip, red.
    expect(p.evidence().at(-1)).toMatchObject({ sha: tipA, kind: 'quick', ok: false, clean: true, by: 'gates.mjs' });
    // No review package reviewers were started.
    expect(r.out).not.toContain('A: review ·');
  });

  it('green records evidence on the tip; the same tip is not run again, a new commit is', () => {
    const p = project({ gates: { quick: [GATE] } });
    fs.writeFileSync(path.join(p.worktree, 'lib', 'OK.ts'), 'export const ok = 1;\n');
    p.g(['add', '--', 'lib/OK.ts'], p.worktree);
    p.g(['commit', '-q', '-m', 'feat: ok'], p.worktree);
    p.report('A', `${RES}\n\n# Report A\n`);
    const r1 = p.run('receive', 'A');
    expect(r1.error).toBe('');
    expect(r1.code).toBe(0);
    expect(r1.out).toContain('GATES (receive) for A');
    expect(r1.out).toContain('Gates GREEN');
    expect(r1.out).toContain('A: review');
    expect(p.find().gate_check).toMatchObject({ ok: true, tip: p.tip(), ran: true });
    expect(p.evidence().filter((e) => e.sha === p.tip() && e.ok === true)).toHaveLength(1);

    const r2 = p.run('receive', 'A');
    expect(r2.code).toBe(0);
    expect(r2.out).toMatch(/Gates green at [0-9a-f]{12} \(quick, cq's own run/);
    expect(r2.out).not.toContain('GATES (receive)');
    expect(p.find().gate_check).toMatchObject({ ok: true, ran: false });

    fs.writeFileSync(path.join(p.worktree, 'lib', 'B.ts'), 'export const b = 1;\n');
    p.g(['add', '--', 'lib/B.ts'], p.worktree);
    p.g(['commit', '-q', '-m', 'feat: b'], p.worktree);
    const r3 = p.run('receive', 'A');
    expect(r3.code).toBe(0);
    expect(r3.out).toContain('GATES (receive) for A');
  });

  it('refuses a dirty worktree and a branch without a worktree (exit 1, nothing changed)', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.report('A', `${RES}\n\n# Report A\n`);
    fs.writeFileSync(path.join(p.worktree, 'lib', 'A.ts'), 'export const a = 2;\n');
    const r1 = p.run('receive', 'A');
    expect(r1.code).toBe(1);
    expect(r1.error).toContain('uncommitted tracked changes');
    expect(p.find().status).toBe('running');
    expect(p.evidence()).toHaveLength(0);

    p.g(['checkout', '-q', '--', 'lib/A.ts'], p.worktree);
    p.g(['worktree', 'remove', '--force', p.worktree]);
    const r2 = p.run('receive', 'A');
    expect(r2.code).toBe(1);
    expect(r2.error).toContain('no worktree has queue/A checked out');
    expect(p.find().status).toBe('running');
  });

  it('runs no gate for a PARTIAL track or without quick gates', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.report('A', `${RES.replace('DONE', 'PARTIAL')}\n\n# Report A\n`);
    const r1 = p.run('receive', 'A');
    expect(r1.code).toBe(0);
    expect(r1.out).not.toContain('GATES (receive)');

    const q = project({});
    q.report('A', `${RES}\n\n# Report A\n`);
    const r2 = q.run('receive', 'A');
    expect(r2.code).toBe(0);
    expect(r2.out).not.toContain('GATES (receive)');
  });
});
