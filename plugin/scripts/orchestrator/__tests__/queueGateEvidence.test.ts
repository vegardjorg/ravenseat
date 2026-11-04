// =============================================================
// queueGateEvidence.test.ts: `cq receive` binds the gate result to the delivered tip (lib/gateEvidence.js).
//
// Locks: (1) a track that claims green (RESULT gates=OK) and has a forged green gate row in the time log for its tip,
// and a forged evidence entry for ANOTHER sha, is not believed: receive runs the quick gate itself in the track's
// worktree, the gate is red, and receive gives a fix round (exit 1), never a review; (2) a green run records evidence
// for exactly the tip (clean, by gates.mjs), and a second receive on the same tip does not run the gate again; a new
// commit does; (3) uncommitted tracked changes in the worktree, or no worktree with the branch, refuse the receive
// (exit 1, nothing changed); (4) a PARTIAL track and a project without quick gates run no gate; (5) a gate command that
// writes the evidence store (directly to the file, or through QUEUE_FOLDER) never produces evidence: the direct write is
// dropped and the run recorded red (tampered), and the gate command gets neither QUEUE_FOLDER nor GITHUB_TOKEN;
// (6) the same tip with a changed gate setup, or with only a legacy green entry, runs the gates again; (7) the receive
// lines say where the gates ran and what they could see; (8) the done command runs scrubbed, and a done command or a gate
// that changes the git hooks or the executing config is an owner stop: TAMPERED on screen, no fix round, the queue unchanged.
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

    // An earlier gate-red is over once a delivery is green: the owner is not told about it any more.
    p.run('block', 'A', 'gate-red');
    const r2 = p.run('receive', 'A');
    expect((p.find().blocks as { code: string; to?: string }[]).every((b) => !!b.to)).toBe(true);
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

describe('the gate commands cannot write their own evidence', () => {
  const GE_PATH = path.join(ROOT, 'scripts', 'orchestrator', 'lib', 'gateEvidence.js');
  const REPORT = `${RES}\n\n# Report A\n`;
  const setGates = (folder: string, quick: string[]) =>
    fs.writeFileSync(path.join(folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3, gates: { quick } }));
  const addOk = (p: ReturnType<typeof project>) => {
    fs.writeFileSync(path.join(p.worktree, 'lib', 'OK.ts'), 'export const ok = 1;\n');
    p.g(['add', '--', 'lib/OK.ts'], p.worktree);
    p.g(['commit', '-q', '-m', 'feat: ok'], p.worktree);
  };
  /**
   * A gate that tries to forge a green entry for the tip (time far in the future, the right writer and setup hash), in
   * the store file it knows (mode "direct", exit 0) or through QUEUE_FOLDER (mode "env", exit 1), and notes what it saw
   * of QUEUE_FOLDER and GITHUB_TOKEN in seen-<mode>.json.
   */
  const forger = (folder: string, mode: 'direct' | 'env') => {
    const script = path.join(folder, `forge-${mode}.cjs`);
    const command = `node "${script.split(path.sep).join('/')}"`;
    const seen = path.join(folder, `seen-${mode}.json`);
    const target =
      mode === 'env'
        ? "process.env.QUEUE_FOLDER ? path.join(process.env.QUEUE_FOLDER, 'gate-evidence.json') : null"
        : JSON.stringify(path.join(folder, 'gate-evidence.json'));
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs'), path = require('path'), cp = require('child_process');",
        `const GE = require(${JSON.stringify(GE_PATH)});`,
        `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ queue: process.env.QUEUE_FOLDER || null, token: process.env.GITHUB_TOKEN || null }));`,
        "const sha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
        `const target = ${target};`,
        `const gates = [${JSON.stringify(command)}];`,
        "const e = GE.entry({ kind: 'quick', sha, setupHash: GE.setupHash({ quick: gates }), clean: true, exit: 0, gates, failed: [], time: '2099-01-01T00:00:00.000Z' });",
        'if (target) fs.writeFileSync(target, JSON.stringify({ version: 1, entries: [e] }));',
        `process.exit(${mode === 'env' ? 1 : 0});`,
        '',
      ].join('\n'),
    );
    return { command, seen: () => JSON.parse(fs.readFileSync(seen, 'utf8')) };
  };
  const forged = (ev: Record<string, unknown>[]) => ev.some((x) => x.time === '2099-01-01T00:00:00.000Z');

  it('a direct write to the store is dropped and the run is red (tampered)', () => {
    const p = project({});
    const f = forger(p.folder, 'direct');
    setGates(p.folder, [f.command]);
    p.report('A', REPORT);
    const r = p.run('receive', 'A');
    expect(r.out).toContain('GATES (receive) for A');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Gates RED');
    const ev = p.evidence();
    expect(forged(ev)).toBe(false);
    expect(ev.at(-1)).toMatchObject({ sha: p.tip(), ok: false, tampered: true, writer: 'orchestrator' });
    // The owner's decision: nothing in the queue changed (__tests__/gitSurfaceBaseline.test.ts).
    expect(p.find()).not.toHaveProperty('gate_check');
    expect(p.find().status).toBe('running');
  });

  it('the gate gets neither QUEUE_FOLDER nor GITHUB_TOKEN, so the env route writes nothing', () => {
    const p = project({});
    const f = forger(p.folder, 'env');
    setGates(p.folder, [f.command]);
    p.env.GITHUB_TOKEN = 'test-token-not-for-gates';
    p.report('A', REPORT);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(1);
    expect(f.seen()).toEqual({ queue: null, token: null });
    const ev = p.evidence();
    expect(forged(ev)).toBe(false);
    expect(ev.at(-1)).toMatchObject({ sha: p.tip(), ok: false, writer: 'orchestrator' });
    expect(ev.at(-1)).not.toHaveProperty('tampered');
  });

  it('the same tip with a changed gate setup runs again; both entries stay', () => {
    const p = project({ gates: { quick: [GATE] } });
    addOk(p);
    p.report('A', REPORT);
    expect(p.run('receive', 'A').out).toContain('Gates GREEN');
    setGates(p.folder, [GATE, 'node -e "process.exit(0)"']);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).toContain('GATES (receive) for A');
    const ev = p.evidence().filter((x) => x.sha === p.tip() && x.ok === true);
    expect(ev).toHaveLength(2);
    expect(ev[0].setup_hash).not.toBe(ev[1].setup_hash);
  });

  it('a legacy green entry for the tip is read but not reused by receive', () => {
    const p = project({ gates: { quick: [GATE] } });
    addOk(p);
    fs.writeFileSync(
      path.join(p.folder, 'gate-evidence.json'),
      JSON.stringify({ version: 1, entries: [{ time: 't', by: 'gates.mjs', sha: p.tip(), kind: 'quick', ok: true, exit: 0, clean: true, gates: [GATE], failed: [] }] }),
    );
    p.report('A', REPORT);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).toContain('GATES (receive) for A');
    expect(r.out).toContain('Gates GREEN');
    // The legacy entry stays as history; the new one is the orchestrator's.
    const ev = p.evidence();
    expect(ev).toHaveLength(2);
    expect(ev[0]).not.toHaveProperty('writer');
    expect(ev[1]).toMatchObject({ writer: 'orchestrator', ok: true });
    // The task's gate record points to the evidence entry (the later attempt's `evidence: [id]`).
    expect(p.find().gate_check).toMatchObject({ ok: true, ran: true, evidence_id: ev[1].id });
  });
});

describe('what receive says about the run, and the done command', () => {
  const REPORT = `${RES}\n\n# Report A\n`;
  /** Sets fields on the task directly: the done lock refuses cq edit once a task has started. */
  const setTask = (p: ReturnType<typeof project>, fields: Record<string, unknown>) => {
    const file = path.join(p.folder, 'queue.json');
    const q = JSON.parse(fs.readFileSync(file, 'utf8')) as Queue;
    Object.assign(q.tasks[0], fields);
    fs.writeFileSync(file, JSON.stringify(q));
  };

  it('the receive lines say the gates ran locally, and how many other files were there', () => {
    const p = project({ gates: { quick: ['node -e "process.exit(0)"'] } });
    fs.writeFileSync(path.join(p.worktree, 'scratch-note.txt'), 'not committed\n');
    p.report('A', REPORT);
    const r1 = p.run('receive', 'A');
    expect(r1.code).toBe(0);
    expect(r1.out).toContain("recorded as evidence for that commit; ran locally in the track's worktree, 1 untracked.");
    const r2 = p.run('receive', 'A');
    expect(r2.out).toMatch(/Gates green at [0-9a-f]{12} \(quick, cq's own run at [^,]+, ran locally in the track's worktree, 1 untracked\); not run again\./);
    expect(p.evidence().at(-1)).toMatchObject({ runner: 'local-worktree', untracked: 1, ignored_present: 0, shared_links: [] });
  });

  it('an entry from before the coverage fields is reused without a phrase', () => {
    const p = project({ gates: { quick: ['node -e "process.exit(0)"'] } });
    p.report('A', REPORT);
    expect(p.run('receive', 'A').code).toBe(0);
    const file = path.join(p.folder, 'gate-evidence.json');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of ['runner', 'shared_links', 'untracked', 'ignored_present']) delete store.entries.at(-1)[k];
    fs.writeFileSync(file, JSON.stringify(store));
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\(quick, cq's own run at [^)]+\); not run again\./);
    expect(r.out).not.toContain('ran locally');
  });

  it('the done command gets neither QUEUE_FOLDER nor GITHUB_TOKEN', () => {
    const p = project({});
    const seen = path.join(p.folder, 'done-saw.json');
    const script = path.join(p.folder, 'done.cjs');
    fs.writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ queue: process.env.QUEUE_FOLDER || null, token: process.env.GITHUB_TOKEN || null, path: !!(process.env.PATH || process.env.Path) }));\n`,
    );
    setTask(p, { done_when: `node "${script.split(path.sep).join('/')}"` });
    p.env.GITHUB_TOKEN = 'test-token-not-for-done';
    p.report('A', REPORT);
    const r = p.run('receive', 'A');
    expect(r.out).toContain('Done command GREEN');
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(seen, 'utf8'))).toEqual({ queue: null, token: null, path: true });
  });

  it('a done command that changes the executing git config is red and an owner stop, with no record on the task', () => {
    const p = project({});
    setTask(p, { done_when: 'git config core.pager cat' });
    p.report('A', REPORT);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Done command RED');
    expect(r.out).toContain('TAMPERED: git hooks or config changed during the run (git config changed: core.pager)');
    expect(p.find()).not.toHaveProperty('done_check');
    expect(p.find().status).toBe('running');
  });

  it('a gate that changes the executing git config: TAMPERED on screen, an owner stop, red in the store', () => {
    const p = project({ gates: { quick: ['git config core.pager cat'] } });
    p.report('A', REPORT);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Gates RED');
    expect(r.out).toContain('TAMPERED: git hooks or config changed during the run (git config changed: core.pager)');
    expect(p.evidence().at(-1)).toMatchObject({ ok: false, tampered: true, exit: 0 });
    expect(r.error).toContain('the owner decides');
    expect(p.find().status).toBe('running');
    expect(JSON.stringify(p.find())).not.toContain('gate-red');
  });
});

describe('cq merge respects what cq receive found', () => {
  // Green on the base branch and on a fixed track; red only on a track that has A.ts without OK.ts, so the base gate says nothing here.
  const TRACK_RED = `node -e "const f=require('fs').existsSync;process.exit(f('lib/A.ts')&&!f('lib/OK.ts')?1:0)"`;
  const merged = (p: ReturnType<typeof project>) => p.g(['branch', '--contains', 'queue/A', '--list', 'develop']) !== '';

  it('red at receive: merge stops, nothing is merged, also when receive and merge are run in a row', () => {
    const p = project({ gates: { quick: [TRACK_RED] } });
    p.g(['config', 'user.name', 'Queue Owner']);
    p.g(['config', 'user.email', 'owner@company.no']);
    p.report('A', `${RES}\n`);
    expect(p.run('receive', 'A').code).toBe(1);
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.code).toBe(1);
    expect(r.error).toContain('The quick gates were red on this exact commit');
    expect(r.error).toContain('--force-red-gate');
    expect(merged(p)).toBe(false);
  });

  it('a commit after the red result needs a new receive, and then the merge goes on', () => {
    const p = project({ gates: { quick: [TRACK_RED] } });
    p.g(['config', 'user.name', 'Queue Owner']);
    p.g(['config', 'user.email', 'owner@company.no']);
    p.report('A', `${RES}\n`);
    expect(p.run('receive', 'A').code).toBe(1);
    fs.writeFileSync(path.join(p.worktree, 'lib', 'OK.ts'), 'export const ok = 1;\n');
    p.g(['add', '--', 'lib/OK.ts'], p.worktree);
    p.g(['commit', '-q', '-m', 'fix'], p.worktree);
    const stopped = p.run('merge', 'A', '--without-fill');
    expect(stopped.code).toBe(1);
    expect(stopped.error).toContain('have not been checked');
    expect(merged(p)).toBe(false);
    p.report('A-r1', `${RES}\n`);
    expect(p.run('receive', 'A').code).toBe(0);
    expect(p.find().gate_check).toMatchObject({ ok: true });
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.error).not.toContain('The quick gates were red');
    expect(merged(p)).toBe(true);
  });

  it('--force-red-gate passes the stop and is logged', () => {
    const p = project({ gates: { quick: [TRACK_RED] } });
    p.g(['config', 'user.name', 'Queue Owner']);
    p.g(['config', 'user.email', 'owner@company.no']);
    p.report('A', `${RES}\n`);
    expect(p.run('receive', 'A').code).toBe(1);
    const r = p.run('merge', 'A', '--without-fill', '--force-red-gate');
    expect(r.out).toContain('WARNING: --force-red-gate');
    expect(fs.readFileSync(p.timeLog, 'utf8')).toContain('gate-red-overridden');
    expect(merged(p)).toBe(true);
  });

  it('a project that removed its quick gates is not stopped by an old red result', () => {
    const p = project({ gates: { quick: [TRACK_RED] } });
    p.g(['config', 'user.name', 'Queue Owner']);
    p.g(['config', 'user.email', 'owner@company.no']);
    p.report('A', `${RES}\n`);
    expect(p.run('receive', 'A').code).toBe(1);
    fs.writeFileSync(path.join(p.folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3 }));
    expect(p.run('receive', 'A').code).toBe(0);
    expect(p.find()).not.toHaveProperty('gate_check');
  });
});

describe('the report can be refused by the client', () => {
  // The track's answer as cq finds it: its transcript and its row in the time log.
  const reply = (p: ReturnType<typeof project>, text: string) => {
    const session = path.join(p.folder, 'transcripts', 'session1', 'subagents');
    fs.mkdirSync(session, { recursive: true });
    const time = new Date().toISOString();
    fs.writeFileSync(
      path.join(session, 'agent-trackA1.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp: time, message: { id: 's1', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n',
    );
    fs.writeFileSync(
      p.timeLog,
      JSON.stringify({ time, wave: 'queue', track: 'A', event: 'done', agent_id: 'trackA1', agent_type: 'track', tokens: { input: 1, output: 1 } }) + '\n',
    );
  };

  it('no report file: the answer gives the result and the GATE line, and receive says the file is missing', () => {
    const p = project({ mode: 'lite' });
    reply(p, `${RES}\nGATE a fetch result used without checking the error\ntrack-result.md was refused.`);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).toContain('A: review · RESULT status=DONE');
    expect(r.out).toContain('WARNING: A has no track-result.md');
    const queue = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8')) as Queue;
    expect(queue.tasks.map((o) => o.title).join('\n')).toContain('a fetch result used without checking the error');
  });

  it('a report under the old name is still read', () => {
    const p = project({});
    fs.mkdirSync(path.join(p.scratch, 'A'), { recursive: true });
    fs.writeFileSync(path.join(p.scratch, 'A', 'report.md'), `${RES}\n`);
    const later = Date.now() / 1000 + 60;
    fs.utimesSync(path.join(p.scratch, 'A', 'report.md'), later, later);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).toContain('A: review · RESULT status=DONE');
    expect(r.out).not.toContain('has no track-result.md');
  });
});
