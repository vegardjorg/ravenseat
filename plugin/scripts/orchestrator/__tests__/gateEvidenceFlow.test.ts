// =============================================================
// gateEvidenceFlow.test.ts: owner decision B2 through the real CLI. receive and merge run the gates themselves and
// confirm the owner rows a task relies on against the owner log; gateEvidence.mode external and off change that.
//
// Locks: (1) own: merge does not believe a green gate_check written into queue.json; the trusted evidence on the tip
// decides, and a red one stops the merge before any step; (2) own: merge runs the quick gates itself when there is no
// evidence for the tip, and runs nothing when receive already did on the same tip and setup (no double run); (3) off:
// a track that says gates=OK is taken at its word at receive and merge; without that claim receive still runs them;
// (4) own: an owner row in queue.json that no ravenseat write recorded (a forged answer or edit) stops receive and merge,
// nothing changed; `ravenseat owner-log accept <id> --by owner` lets it go on; off does not check; the first use takes
// the rows there are as the baseline; (5) external: `gates.mjs --full` in the main checkout counts a green CI run of the
// listed checks on exactly the same commit as the full gate and runs nothing, runs locally otherwise, and says so when
// the list is empty; own never asks GitHub.
// Runs queue.mjs and gates.mjs against a temporary queue (QUEUE_FOLDER) and git repo (QUEUE_GIT), an injected merge runner
// (QUEUE_MERGE_RUNNING) and a fake gh (QUEUE_CI_GH). Never the main repo, the real queue or GitHub.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = Record<string, unknown> & { tasks: Task[]; changelog?: Record<string, unknown>[] };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORCH = path.join(ROOT, 'scripts', 'orchestrator');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
const RES_NO_GATES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=- probe=- ownerQuestions=0 edge=-';
// Green only where lib/OK.ts exists (the track adds it); red otherwise.
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
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-b2-'));
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
  // The base gate is off: its check of the base branch (no lib/OK.ts there) is red by design here, and is not what is tested.
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', maxFixRounds: 3, baseGate: { enabled: false }, ...config }));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  // The merge runner: the merge step merges for real (merge checks the tip is in base), every step is logged.
  const steps = path.join(folder, 'steps.log');
  const runner = path.join(folder, 'runner.mjs');
  fs.writeFileSync(
    runner,
    [
      "import fs from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      'export default (x) => {',
      `  fs.appendFileSync(${JSON.stringify(steps)}, x.step + '\\n');`,
      "  if (x.step === 'merge') spawnSync('git', ['-C', process.env.QUEUE_GIT, '-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', 'merge', '--no-ff', '--no-edit', x.args[1]], { encoding: 'utf8' });",
      "  return { code: 0, out: '' };",
      '};',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    QUEUE_MERGE_RUNNING: runner,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ORCH, 'queue.mjs'), ...args], { encoding: 'utf8', env, cwd: folder });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue;
  const setQueue = (q: Queue) => fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify(q));
  const find = () => queue().tasks[0];
  let n = 0;
  const report = (dir: string, text: string) => {
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    const f = path.join(scratch, dir, 'track-result.md');
    fs.writeFileSync(f, text);
    const later = Date.now() / 1000 + 60 * ++n;
    fs.utimesSync(f, later, later);
  };
  const stepsRun = () => (fs.existsSync(steps) ? fs.readFileSync(steps, 'utf8').split('\n').filter(Boolean) : []);
  const tip = () => g(['rev-parse', 'queue/A']);
  const commitOk = () => {
    fs.writeFileSync(path.join(worktree, 'lib', 'OK.ts'), 'export const ok = 1;\n');
    g(['add', '--', 'lib/OK.ts'], worktree);
    g(['commit', '-q', '-m', 'feat: ok'], worktree);
  };
  return { folder, repo, worktree, scratch, g, run, queue, setQueue, find, report, stepsRun, tip, commitOk };
}

describe('gateEvidence.mode own (the default)', () => {
  it('merge does not believe a green gate_check written into queue.json', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.report('A', `${RES}\n\n# Report A\n`);
    expect(p.run('receive', 'A').code).toBe(1); // red: a fix round
    // The forgery: the record receive wrote, turned green by hand, and the blocker closed.
    const q = p.queue();
    q.tasks[0].gate_check = { ok: true, kind: 'quick', tip: p.tip(), at: new Date().toISOString(), ran: true };
    q.tasks[0].blocks = [];
    p.setQueue(q);
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.code).toBe(1);
    expect(r.error).toContain('The quick gates were red on this exact commit');
    expect(p.stepsRun()).toEqual([]);
  });

  it('merge runs the quick gates itself when there is no evidence for the tip', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.commitOk();
    p.report('A', `${RES}\n\n# Report A\n`);
    expect(p.run('receive', 'A').code).toBe(0);
    // The evidence store is gone (or never had this tip): the record in queue.json is not enough.
    fs.rmSync(path.join(p.folder, 'gate-evidence.json'));
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.error).toBe('');
    expect(r.out).toContain('GATES (merge) for A');
    expect(r.code).toBe(0);
    expect(p.stepsRun()).toContain('merge');
  });

  it('no double run: merge reuses the evidence receive recorded on the same tip and setup', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.commitOk();
    p.report('A', `${RES}\n\n# Report A\n`);
    expect(p.run('receive', 'A').out).toContain('GATES (receive) for A');
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Gates green at [0-9a-f]{12} \(quick, ravenseat's own run at [^)]*\); not run again\./);
    expect(r.out).not.toContain('GATES (');
    expect(p.stepsRun()).toContain('merge');
  });

  it('a red quick gate found at merge stops it before any step, with the record in the queue', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.report('A', `${RES}\n\n# Report A\n`);
    expect(p.run('receive', 'A').code).toBe(1);
    fs.rmSync(path.join(p.folder, 'gate-evidence.json'));
    const q = p.queue();
    delete q.tasks[0].gate_check;
    q.tasks[0].blocks = [];
    p.setQueue(q);
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.out).toContain('GATES (merge) for A');
    expect(r.code).toBe(1);
    expect(r.error).toContain('STOP: A is not merged');
    expect(p.stepsRun()).toEqual([]);
    expect(p.find().gate_check).toMatchObject({ ok: false, tip: p.tip() });
  });
});

describe('gateEvidence.mode own and the base gate', () => {
  it('a red base stops the merge first (exit 9); the track\'s own gate run waits until the base is settled', () => {
    // GATE is red on the base branch (no lib/OK.ts there), so the base gate's check before the merge is red.
    const p = project({ gates: { quick: [GATE] }, baseGate: { enabled: true } });
    p.commitOk();
    const q = p.queue();
    q.tasks[0].status = 'review';
    p.setQueue(q);
    const r = p.run('merge', 'A', '--without-fill');
    expect(r.code).toBe(9);
    expect(r.out).toContain('BASE RED');
    expect(r.out).not.toContain('GATES (merge)');
    expect(p.stepsRun()).toEqual([]);
  });
});

describe('gateEvidence.mode off', () => {
  it('the track\'s gates=OK is taken at its word at receive and merge; without the claim receive runs them', () => {
    const p = project({ gates: { quick: [GATE] }, gateEvidence: { mode: 'off' } });
    p.report('A', `${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('GATES (receive)');
    expect(r.out).toContain('gateEvidence.mode off');
    expect(p.find()).toMatchObject({ status: 'review', gate_check: { ok: true, ran: false, source: 'track', tip: p.tip() } });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(0);
    expect(m.out).not.toContain('GATES (');
    expect(p.stepsRun()).toContain('merge');

    const p2 = project({ gates: { quick: [GATE] }, gateEvidence: { mode: 'off' } });
    p2.report('A', `${RES_NO_GATES}\n\n# Report A\n`);
    const r2 = p2.run('receive', 'A');
    expect(r2.out).toContain('GATES (receive) for A');
    expect(r2.code).toBe(1);
  });
});

describe('owner rows against the owner log', () => {
  /** A changelog entry by the owner that widens A's files, written straight into queue.json. */
  const forge = (q: Queue) => {
    const nr = (q.changelog ?? []).reduce((m, e) => Math.max(m, Number(e.nr) || 0), 0) + 1;
    q.changelog = [
      ...(q.changelog ?? []),
      { nr, at: new Date().toISOString(), by: 'owner', action: 'edit', changes: [{ id: 'A', field: 'owned_files', before: ['lib/A.ts'], after: ['lib/A.ts', '.claude/'] }] },
    ];
    return nr;
  };

  it('own: a forged owner row stops receive and merge; accept lets it go on; an owner row made with the CLI never stops', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.commitOk();
    // A real owner edit through the CLI: recorded, never a stop.
    expect(p.run('edit', 'A', '--json', JSON.stringify({ value: 6 }), '--by', 'owner').code).toBe(0);
    const q = p.queue();
    const nr = forge(q);
    p.setQueue(q);
    p.report('A', `${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.code).toBe(1);
    expect(r.error).toContain(`changelog #${nr} (edit by owner)`);
    expect(r.error).toContain('owner-log accept A --by owner');
    expect(r.error).toContain('Nothing changed');
    expect(r.error).not.toContain(`changelog #${nr - 1} `);
    expect(p.find().status).toBe('running');
    expect(r.out).not.toContain('GATES (receive)');

    // merge too (a task already in review whose row was forged after receive).
    const m = p.run('merge', 'A', '--without-fill', '--force');
    expect(m.code).toBe(1);
    expect(m.error).toContain(`changelog #${nr} (edit by owner)`);
    expect(p.stepsRun()).toEqual([]);

    // The owner says it was theirs.
    const acc = p.run('owner-log', 'accept', 'A', '--by', 'owner');
    expect(acc.error).toBe('');
    expect(acc.code).toBe(0);
    expect(p.run('receive', 'A').code).toBe(0);
  });

  it('accept needs --by owner; the list command shows the rows and changes nothing', () => {
    const p = project({});
    const q = p.queue();
    forge(q);
    p.setQueue(q);
    // The first use is the baseline: what is there now is accepted.
    expect(p.run('owner-log', 'A').out).toMatch(/no owner row of A is missing|every owner row of A/i);
    const q2 = p.queue();
    const nr = forge(q2);
    p.setQueue(q2);
    const show = p.run('owner-log', 'A');
    expect(show.code).toBe(0);
    expect(show.out).toContain(`changelog #${nr} (edit by owner)`);
    const no = p.run('owner-log', 'accept', 'A');
    expect(no.code).toBe(1);
    expect(no.error).toContain('--by owner');
  });

  it('the first use takes the rows there are as the baseline; off does not check', () => {
    const p = project({ gates: { quick: [GATE] } });
    p.commitOk();
    const q = p.queue();
    forge(q);
    p.setQueue(q);
    p.report('A', `${RES}\n\n# Report A\n`);
    const r = p.run('receive', 'A');
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(p.folder, 'owner-log.json'))).toBe(true);

    const off = project({ gates: { quick: [GATE] }, gateEvidence: { mode: 'off' } });
    off.commitOk();
    expect(off.run('edit', 'A', '--json', JSON.stringify({ value: 6 }), '--by', 'owner').code).toBe(0);
    const q2 = off.queue();
    forge(q2);
    off.setQueue(q2);
    off.report('A', `${RES}\n\n# Report A\n`);
    expect(off.run('receive', 'A').code).toBe(0);
  });
});

describe('gateEvidence.mode external: gates.mjs --full', () => {
  function main(config: Record<string, unknown>) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-b2-ext-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
    g(['add', '--', 'README.md']);
    g(['commit', '-q', '-m', 'start']);
    // The full gate leaves a marker, so the test sees whether it ran here.
    const FULL = `node -e "require('fs').writeFileSync('ran-full.txt','x')"`;
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', gates: { quick: [], full: [FULL] }, ...config }));
    const state = path.join(folder, 'gh-state.json');
    const calls = path.join(folder, 'gh-calls.log');
    const gh = path.join(folder, 'gh.mjs');
    fs.writeFileSync(
      gh,
      [
        "import fs from 'node:fs';",
        'export default (args) => {',
        `  fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');`,
        `  const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));`,
        "  if (args[0] === 'run' && args[1] === 'list') return { code: 0, out: JSON.stringify(s.runs) };",
        "  return { code: 1, out: 'unknown gh call' };",
        '};',
        '',
      ].join('\n'),
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: repo,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_CI_GH: gh,
      QUEUE_GATE_QUEUE: 'off',
    } as NodeJS.ProcessEnv;
    const sha = g(['rev-parse', 'HEAD']);
    const setRuns = (runs: unknown[]) => fs.writeFileSync(state, JSON.stringify({ runs }));
    setRuns([]);
    const full = () => {
      fs.rmSync(path.join(repo, 'ran-full.txt'), { force: true });
      const r = spawnSync(process.execPath, [path.join(ORCH, 'gates.mjs'), '--full'], { encoding: 'utf8', env, cwd: repo });
      return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ranHere: fs.existsSync(path.join(repo, 'ran-full.txt')) };
    };
    const evidence = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(folder, 'gate-evidence.json'), 'utf8')).entries as Record<string, unknown>[];
      } catch {
        return [];
      }
    };
    const ghCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
    return { folder, sha, setRuns, full, evidence, ghCalls };
  }
  const green = (sha: string, name = 'ci') => ({ databaseId: 7, workflowName: name, name, status: 'completed', conclusion: 'success', headSha: sha });

  it('a green listed check on exactly this commit is the full gate: nothing runs here', () => {
    const p = main({ gateEvidence: { mode: 'external', external: ['ci'] } });
    p.setRuns([green(p.sha)]);
    const r = p.full();
    expect(r.code).toBe(0);
    expect(r.ranHere).toBe(false);
    expect(r.out).toContain('EXTERNAL CI GREEN');
    expect(p.evidence().at(-1)).toMatchObject({ sha: p.sha, kind: 'full', ok: true, runner: 'external-ci', external_checks: ['ci'] });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const GE = require('../lib/gateEvidence.js');
    const cfg = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.config.json'), 'utf8'));
    expect(GE.fullGateVerdict({ folder: p.folder, sha: p.sha, cfg })).toBe('green');
    expect(GE.fullGateVerdict({ folder: p.folder, sha: p.sha, cfg: { ...cfg, gateEvidence: { mode: 'own', external: ['ci'] } } })).toBe('missing');
  });

  it('another commit, a red run or an unlisted name: the full gate runs here', () => {
    const p = main({ gateEvidence: { mode: 'external', external: ['ci'] } });
    p.setRuns([green('c'.repeat(40))]);
    const r = p.full();
    expect(r.ranHere).toBe(true);
    expect(r.out).toContain('EXTERNAL CI:');
    p.setRuns([{ ...green(p.sha), conclusion: 'failure' }]);
    expect(p.full().ranHere).toBe(true);
    p.setRuns([green(p.sha, 'lint')]);
    expect(p.full().ranHere).toBe(true);
  });

  it('an empty list counts nothing and says so; own never asks GitHub', () => {
    const p = main({ gateEvidence: { mode: 'external', external: [] } });
    p.setRuns([green(p.sha)]);
    const r = p.full();
    expect(r.ranHere).toBe(true);
    expect(r.out).toMatch(/gateEvidence\.external is empty/);
    expect(p.ghCalls()).toEqual([]);
    const own = main({});
    own.setRuns([green(own.sha)]);
    expect(own.full().ranHere).toBe(true);
    expect(own.ghCalls()).toEqual([]);
  });
});
