// =============================================================
// pushBatch.test.ts: the batch push threshold (lib/pushBatch.js, config().push).
//
// Locks: merged tasks are counted from the queue merge commits on <remote>/<baseBranch>..<baseBranch> (distinct ids,
// not commits), each verdict (NOTHING, NOT YET, READY, LARGE, BLOCKED) and maxAgeHours, the push guard's "ask" below
// the threshold and on a red base (never deny, minTasks 0 turns the count question off, tracks are not asked), the hook
// end to end, push-check's batch lines and JSON, and the workflow scan `ravenseat doctor` uses.
//
// The git parts run against TEMPORARY repos with a bare remote in os.tmpdir() (never the main repo, never git config:
// the identity is given with -c per command).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as PB from '../pushBatch';
import { assess } from '../pushGuard';

const G = require('../queueGit.js');
const C = require('../logic/commits.js');

const ORCH = path.resolve(__dirname, '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows can hold a file for a moment; os.tmpdir is cleaned up anyway */
    }
  }
});

const HOUR = 3_600_000;
const SETUP = PB.pushSetup({});

/** A repo with a bare remote: main pushed once (the "last push"), then work on top with fixed committer times. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-push-batch-'));
  temporary.push(root);
  const bare = path.join(root, 'remote.git');
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir);
  const g = (args: string[], env: Record<string, string> = {}, cwd = dir) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  let n = 0;
  // Times from a fixed start, one minute apart (the age tests pass `now` relative to them).
  const START = Date.parse('2026-09-01T10:00:00Z');
  const time = () => {
    n += 1;
    const d = new Date(START + n * 60_000).toISOString();
    return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
  };
  const commit = (file: string, message: string) => {
    fs.writeFileSync(path.join(dir, file), `${file} ${n}\n`);
    g(['add', '--', file]);
    g(['commit', '-q', '-m', message], time());
    return g(['rev-parse', 'HEAD']);
  };
  /** A queue merge the way merge-track.mjs makes it: queue/<id> with `commits` commits, `merge --no-ff --no-edit`. */
  const queueMerge = (id: string, commits = 2) => {
    g(['checkout', '-q', '-B', `queue/${id}`]);
    for (let i = 0; i < commits; i++) commit(`${id}-${i}.txt`, `feat: ${id} part ${i}`);
    g(['checkout', '-q', 'main']);
    g(['merge', '-q', '--no-ff', '--no-edit', `queue/${id}`], time());
    return g(['rev-parse', 'HEAD']);
  };
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  g(['remote', 'add', 'origin', bare]);
  commit('README.md', 'start');
  g(['push', '-q', 'origin', 'main']);
  const read = () => PB.readBatch(G.makeGit(dir), { from: 'origin/main', to: 'main', prefix: 'queue/' });
  return { root, dir, g, commit, queueMerge, read, START };
}

// ---- Pure ---------------------------------------------------------------------------------------------------------
describe('the setup', () => {
  it('defaults: mode owner, minTasks 10, warnTasks 50, no age rule', () => {
    expect(PB.pushSetup({})).toEqual({ mode: 'owner', minTasks: 10, warnTasks: 50, maxAgeHours: null });
    expect(PB.pushSetup({ push: { mode: 'threshold', minTasks: 0, warnTasks: 5, maxAgeHours: 24 } })).toEqual({
      mode: 'threshold',
      minTasks: 0,
      warnTasks: 5,
      maxAgeHours: 24,
    });
  });
  it('invalid values fall back to the defaults, and setupProblems names them', () => {
    const bad = { mode: 'auto', minTasks: -1, warnTasks: 2.5, maxAgeHours: 0 };
    expect(PB.pushSetup({ push: bad })).toEqual(PB.DEFAULTS);
    expect(PB.setupProblems(bad)).toHaveLength(4);
    expect(PB.setupProblems({ mode: 'owner', minTasks: 0, maxAgeHours: null })).toEqual([]);
    expect(PB.setupProblems(undefined)).toEqual([]);
    expect(PB.setupProblems([1])).toEqual(['push must be an object']);
  });
  it('reads the merge id like logic/commits.js', () => {
    for (const s of ["Merge branch 'queue/A-1' into main", "Merge branch 'hotfix/x' into main", 'feat: x', "Merge branch 'queue/B.2'"])
      expect(PB.queueIdFromMerge(s, 'queue/')).toBe(C.queueIdFromMerge(s, 'queue/'));
  });
});

/** A batch from n task merges (plus extra plain commits) without git. */
function fake(n: number, { extra = 0, oldestAt = '2026-09-01T10:00:00.000Z' } = {}) {
  const rows = [
    ...Array.from({ length: extra }, (_, i) => ({ sha: `c${i}`, parents: ['p'], subject: 'chore', time: Date.parse(oldestAt) })),
    ...Array.from({ length: n }, (_, i) => ({
      sha: `m${i}`,
      parents: ['p', 'q'],
      subject: `Merge branch 'queue/T-${i}' into main`,
      time: Date.parse(oldestAt),
    })),
  ];
  return PB.summarize(rows, { prefix: 'queue/' });
}

describe('the verdict', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  it('NOTHING, NOT YET, READY, LARGE', () => {
    expect(PB.batchVerdict({ batch: fake(0), setup: SETUP, now }).verdict).toBe('NOTHING');
    expect(PB.batchVerdict({ batch: null, setup: SETUP, now }).verdict).toBe('NOTHING');
    const notYet = PB.batchVerdict({ batch: fake(4), setup: SETUP, now });
    expect(notYet).toMatchObject({ verdict: 'NOT_YET', reason: '4 of 10 merged tasks' });
    expect(PB.verdictWord(notYet.verdict)).toBe('NOT YET');
    expect(PB.batchVerdict({ batch: fake(10), setup: SETUP, now }).verdict).toBe('READY');
    expect(PB.batchVerdict({ batch: fake(50), setup: SETUP, now }).verdict).toBe('LARGE');
    // warnTasks 0 = no LARGE.
    expect(PB.batchVerdict({ batch: fake(80), setup: { ...SETUP, warnTasks: 0 }, now }).verdict).toBe('READY');
  });
  it('minTasks 0: any batch with something on it is READY, also without merged tasks', () => {
    expect(PB.batchVerdict({ batch: fake(0, { extra: 1 }), setup: { ...SETUP, minTasks: 0 }, now }).verdict).toBe('READY');
  });
  it('BLOCKED on a red base or a failing push-check check, before LARGE', () => {
    expect(PB.batchVerdict({ batch: fake(60), setup: SETUP, health: 'red', now })).toMatchObject({
      verdict: 'BLOCKED',
      reason: 'base is red at m0',
    });
    expect(PB.batchVerdict({ batch: fake(12), setup: SETUP, blocked: ['1 external commit(s)'], now }).verdict).toBe('BLOCKED');
    expect(PB.batchVerdict({ batch: fake(12), setup: SETUP, health: 'unknown', now }).verdict).toBe('READY');
  });
  it('BLOCKED without a green full gate on the tip when it is required (fullGate), never when it is off', () => {
    expect(PB.batchVerdict({ batch: fake(12), setup: SETUP, fullGate: 'missing', now })).toMatchObject({
      verdict: 'BLOCKED',
      reason: 'no green full gate recorded on m0 (run ravenseat gates --full in the main checkout, on the tip, with no uncommitted changes)',
    });
    expect(PB.batchVerdict({ batch: fake(12), setup: SETUP, fullGate: 'red', now }).reason).toMatch(/^the full gate is red at m0/);
    expect(PB.batchVerdict({ batch: fake(12), setup: SETUP, fullGate: 'green', now }).verdict).toBe('READY');
    expect(PB.batchVerdict({ batch: fake(12), setup: SETUP, fullGate: 'off', now }).verdict).toBe('READY');
    expect(PB.batchVerdict({ batch: fake(12), setup: SETUP, now }).verdict).toBe('READY');
  });
  it('maxAgeHours: old work makes the batch READY below minTasks', () => {
    const setup = { ...SETUP, maxAgeHours: 24 };
    const young = fake(2, { oldestAt: new Date(now - 3 * HOUR).toISOString() });
    const old = fake(2, { oldestAt: new Date(now - 30 * HOUR).toISOString() });
    expect(PB.batchVerdict({ batch: young, setup, now }).verdict).toBe('NOT_YET');
    const v = PB.batchVerdict({ batch: old, setup, now });
    expect(v).toMatchObject({ verdict: 'READY', aged: true });
    expect(v.reason).toContain('30 h old (maxAgeHours 24)');
    // Without the setting, age never matters.
    expect(PB.batchVerdict({ batch: old, setup: SETUP, now }).verdict).toBe('NOT_YET');
  });
  it('the board text', () => {
    expect(PB.boardBatch({ batch: fake(4), setup: SETUP, now })?.text).toBe('4 of 10 tasks, NOT YET');
    expect(PB.boardBatch({ batch: fake(0), setup: SETUP, now })?.text).toBe('nothing to push');
    expect(PB.boardBatch({ batch: fake(3), setup: SETUP, health: 'red', now })?.verdict).toBe('BLOCKED');
    expect(PB.boardBatch({ batch: null, setup: SETUP, now })).toBeNull();
  });
});

describe('the guard question', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  it('asks below minTasks and on a red base, not at the threshold', () => {
    expect(PB.guardQuestion({ batch: fake(4), setup: SETUP, now })).toMatch(/^4 of 10 merged tasks since the last push .*push anyway\?$/);
    expect(PB.guardQuestion({ batch: fake(10), setup: SETUP, now })).toBeNull();
    expect(PB.guardQuestion({ batch: fake(60), setup: SETUP, now })).toBeNull();
    expect(PB.guardQuestion({ batch: fake(12), setup: SETUP, health: 'red', now })).toBe('base is red at m0; push anyway?');
    expect(PB.guardQuestion({ batch: fake(0), setup: SETUP, now })).toBeNull();
  });
  it('asks without a green full gate on the tip, also above the threshold and with minTasks 0', () => {
    expect(PB.guardQuestion({ batch: fake(12), setup: SETUP, fullGate: 'missing', now })).toMatch(/^no green full gate recorded on m0 .*push anyway\?$/);
    expect(PB.guardQuestion({ batch: fake(1), setup: { ...SETUP, minTasks: 0 }, fullGate: 'red', now })).toMatch(/^the full gate is red at m0/);
    expect(PB.guardQuestion({ batch: fake(12), setup: SETUP, fullGate: 'green', now })).toBeNull();
    expect(PB.guardQuestion({ batch: fake(0), setup: SETUP, fullGate: 'missing', now })).toBeNull();
  });
  it('minTasks 0 turns the count question off but keeps the red-base one; maxAgeHours counts', () => {
    const zero = { ...SETUP, minTasks: 0 };
    expect(PB.guardQuestion({ batch: fake(1), setup: zero, now })).toBeNull();
    expect(PB.guardQuestion({ batch: fake(1), setup: zero, health: 'red', now })).toMatch(/^base is red/);
    const old = fake(1, { oldestAt: new Date(now - 30 * HOUR).toISOString() });
    expect(PB.guardQuestion({ batch: old, setup: { ...SETUP, maxAgeHours: 24 }, now })).toBeNull();
  });
  it('assess: ask only for a plain push of baseBranch by the main session, never deny, stricter findings win', () => {
    const ctx = { baseBranch: 'main', migrations: {}, batchQuestion: () => '4 of 10 merged tasks since the last push; push anyway?' };
    expect(assess('git push origin main', ctx)).toEqual({ decision: 'ask', reason: ctx.batchQuestion() });
    expect(assess('git push', { ...ctx, branch: 'main' })?.decision).toBe('ask');
    // A track (agent_type set) is never asked about the batch: it may not push at all (H1, denied with its own reason).
    expect(assess('git push origin main', { ...ctx, agentType: 'track', guardedTypes: new Set() })?.decision).toBe('deny');
    // Force and other branches are still denied with their own reason.
    expect(assess('git push --force origin main', ctx)?.decision).toBe('deny');
    expect(assess('git push origin queue/A-1', ctx)?.decision).toBe('deny');
    // No question: let through; and the question is not computed for other commands.
    let calls = 0;
    const counting = { ...ctx, batchQuestion: () => (calls++, null) };
    expect(assess('git push origin main', counting)).toBeNull();
    expect(assess('git status', counting)).toBeNull();
    expect(calls).toBe(1);
  });
});

// ---- Against temporary repos with a bare remote ----------------------------------------------------------------------
describe('counting against a temporary repo', () => {
  it('counts merged tasks (distinct ids) since the remote tip, commits as the secondary figure', () => {
    const r = makeRepo();
    expect(r.read()).toMatchObject({ taskCount: 0, commits: 0, firstParent: 0 });
    r.queueMerge('A-1', 2);
    r.queueMerge('A-2', 3);
    r.commit('note.txt', 'chore: orchestrator note');
    // A task merged again after a fix round counts once.
    r.queueMerge('A-1', 1);
    const b = r.read();
    expect(b).toMatchObject({ tasks: ['A-2', 'A-1'], taskCount: 2, commits: 2 + 1 + 3 + 1 + 1 + 1 + 1, firstParent: 4 });
    expect(b?.tip).toBe(r.g(['rev-parse', 'main']));
    expect(b?.oldestAt).toBe(new Date(r.START + 4 * 60_000).toISOString());
    // After the push the batch is empty again.
    r.g(['push', '-q', 'origin', 'main']);
    expect(r.read()).toMatchObject({ taskCount: 0, commits: 0 });
    r.queueMerge('B-1', 1);
    expect(r.read()).toMatchObject({ tasks: ['B-1'], taskCount: 1, commits: 2 });
  }, 60_000);
  it('null when the remote ref does not exist (no push yet)', () => {
    const r = makeRepo();
    expect(PB.readBatch(G.makeGit(r.dir), { from: 'origin/nothing', to: 'main', prefix: 'queue/' })).toBeNull();
  }, 60_000);
});

/** A queue project on a temporary repo: config, data folder (optionally base-health.json), env for the scripts. */
function project(push: object, { red = false, extra = {} as Record<string, unknown> } = {}) {
  const r = makeRepo();
  const data = path.join(r.root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], projects: {} }));
  const configFile = path.join(r.dir, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', remote: 'origin', branchPrefix: 'queue/', push: { controlsWarning: false, ...push }, ...extra }));
  const env = {
    ...process.env,
    QUEUE_ROOT: r.dir,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: r.dir,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
  };
  const markHealth = () => {
    const tip = r.g(['rev-parse', 'main']);
    fs.writeFileSync(
      path.join(data, 'base-health.json'),
      JSON.stringify({ current: { tip, branch: 'main', status: red ? 'red' : 'green', at: new Date().toISOString() }, history: [] }),
    );
  };
  const hook = (command: string, extra: object = {}) => {
    const out = spawnSync(process.execPath, [path.join(ORCH, 'hook-push-guard.mjs')], {
      input: JSON.stringify({ tool_input: { command }, cwd: r.dir, ...extra }),
      encoding: 'utf8',
      env,
    });
    expect(out.status).toBe(0);
    return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null;
  };
  const pushCheck = (...args: string[]) => {
    const out = spawnSync(process.execPath, [path.join(ORCH, 'push-check.mjs'), ...args], { encoding: 'utf8', env, cwd: r.dir });
    return { code: out.status, out: `${out.stdout}${out.stderr}` };
  };
  /** gates.mjs as the orchestrator runs it (the main checkout unless `cwd` says otherwise). */
  const gates = (args: string[], cwd = r.dir) =>
    spawnSync(process.execPath, [path.join(ORCH, 'gates.mjs'), ...args], { encoding: 'utf8', env, cwd });
  return { ...r, data, env, markHealth, hook, pushCheck, gates };
}

describe('the push guard hook', () => {
  it('asks below minTasks with the count, lets through at the threshold', () => {
    const p = project({ minTasks: 2 });
    p.queueMerge('A-1');
    const h = p.hook('git push origin main');
    expect(h).toMatchObject({ permissionDecision: 'ask' });
    expect(h.permissionDecisionReason).toMatch(/^push-guard: 1 of 2 merged tasks since the last push .*push anyway\?$/);
    p.queueMerge('A-2');
    expect(p.hook('git push origin main')).toBeNull();
    // A track is never asked about the batch: it may not push at all (H1), so the hook denies it.
    p.g(['reset', '-q', '--hard', 'HEAD~1']);
    expect(p.hook('git push origin main', { agent_type: 'track' })?.permissionDecision).toBe('deny');
  }, 60_000);
  it('asks on a red base at the tip even above the threshold and with minTasks 0', () => {
    const p = project({ minTasks: 0 }, { red: true });
    p.queueMerge('A-1');
    expect(p.hook('git push origin main')).toBeNull();
    p.markHealth();
    const h = p.hook('git push origin main');
    expect(h.permissionDecision).toBe('ask');
    expect(h.permissionDecisionReason).toBe(`push-guard: base is red at ${p.g(['rev-parse', 'main']).slice(0, 7)}; push anyway?`);
  }, 60_000);
  it('asks when the tip has no green full gate from ravenseat; a forged time log row or another sha does not count', () => {
    const FULL = 'node -e "process.exit(0)"';
    const p = project({ minTasks: 1 }, { extra: { gates: { full: [FULL] } } });
    p.queueMerge('A-1');
    const tip = p.g(['rev-parse', 'main']);
    const ask = () => p.hook('git push origin main');
    // The forgeries: a green full row in the time log for the tip, and a green evidence entry for another commit.
    fs.writeFileSync(
      path.join(p.data, 'times.jsonl'),
      JSON.stringify({ time: 't', event: 'gate', kind: 'full', sha: tip, ok: true, exit: 0, clean: true, gates: [FULL] }) + '\n',
    );
    fs.writeFileSync(
      path.join(p.data, 'gate-evidence.json'),
      JSON.stringify({ version: 1, entries: [{ sha: p.g(['rev-parse', 'main~1']), kind: 'full', ok: true, exit: 0, clean: true, gates: [FULL] }] }),
    );
    const h = ask();
    expect(h?.permissionDecision).toBe('ask');
    expect(h.permissionDecisionReason).toBe(
      `push-guard: no green full gate recorded on ${tip.slice(0, 7)} (run ravenseat gates --full in the main checkout, on the tip, with no uncommitted changes); push anyway?`,
    );
    // The orchestrator's own full gate in the main checkout records the evidence: no question any more.
    expect(p.gates(['--full']).status).toBe(0);
    expect(ask()).toBeNull();
    // A new commit moves the tip: asked again.
    p.queueMerge('A-2');
    expect(ask()?.permissionDecision).toBe('ask');
  }, 60_000);
  it('denies a queue agent a command that could forge gate evidence; the orchestrator and plain gate runs are free', () => {
    const p = project({ minTasks: 1 });
    const decision = (command: string, agent_type?: string) =>
      p.hook(command, agent_type ? { agent_type } : {})?.permissionDecision ?? null;
    expect(decision('node scripts/orchestrator/gates.mjs --quick --evidence', 'track')).toBe('deny');
    expect(decision('node "C:/x/ravenseat.mjs" gates --full --cwd ../main', 'track')).toBe('deny');
    expect(decision('echo {} > scripts/.queue/gate-evidence.json', 'track-d')).toBe('deny');
    expect(decision('node scripts/orchestrator/gates.mjs --quick --log x', 'track')).toBeNull();
    expect(decision('git commit -m "gates: add --cwd note"', 'track')).toBeNull();
    // The orchestrator (no agent_type) may run the gates with --evidence.
    expect(decision('node scripts/orchestrator/gates.mjs --quick --evidence')).toBeNull();
  }, 60_000);
  it('nothing to push, or no remote ref: no question (fails open)', () => {
    const p = project({ minTasks: 5 });
    expect(p.hook('git push origin main')).toBeNull();
    p.g(['update-ref', '-d', 'refs/remotes/origin/main']);
    p.queueMerge('A-1');
    expect(p.hook('git push origin main')).toBeNull();
  }, 60_000);
});

describe('push-check batch status', () => {
  it('NOT YET and READY lines, and the batch in --json', () => {
    const p = project({ mode: 'threshold', minTasks: 2, warnTasks: 3 });
    p.queueMerge('A-1');
    let c = p.pushCheck();
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/Batch: 1 merged task\(s\) \/ 3 commit\(s\) unpushed, oldest .* old; base not checked at this tip/);
    expect(c.out).toContain('Verdict: NOT YET (1 of 2 merged tasks).');
    expect(c.out).toContain('Push mode threshold: push when the verdict below is READY or LARGE, never BLOCKED.');
    p.queueMerge('A-2');
    expect(p.pushCheck().out).toContain('Verdict: READY (2 of 2 merged tasks).');
    p.queueMerge('A-3');
    expect(p.pushCheck().out).toContain('Verdict: LARGE (3 merged tasks unpushed');
    const j = JSON.parse(p.pushCheck('--json').out);
    expect(j.batch).toMatchObject({ mode: 'threshold', task_count: 3, tasks: ['A-1', 'A-2', 'A-3'], verdict: 'LARGE', base_health: 'unknown' });
  }, 60_000);
  it('BLOCKED without a green full gate from ravenseat on the tip, READY after ravenseat gates --full in the main checkout', () => {
    const p = project({ mode: 'threshold', minTasks: 1 }, { extra: { gates: { full: ['node -e "process.exit(0)"'] } } });
    p.queueMerge('A-1');
    let c = p.pushCheck();
    expect(c.out).toContain('full gate not run on this tip');
    expect(c.out).toContain('Verdict: BLOCKED (no green full gate recorded on');
    // The track's own run in a linked worktree (where agent worktrees live) is not evidence.
    const wt = path.join(p.dir, '.claude', 'worktrees', 'wt');
    p.g(['worktree', 'add', '-q', '--detach', wt, 'main']);
    expect(p.gates(['--full'], wt).status).toBe(0);
    expect(p.pushCheck().out).toContain('Verdict: BLOCKED (no green full gate recorded on');
    expect(p.gates(['--full']).status).toBe(0);
    c = p.pushCheck();
    expect(c.out).toContain('full gate GREEN');
    expect(c.out).toContain('Verdict: READY (1 of 1 merged tasks).');
    expect(JSON.parse(p.pushCheck('--json').out).batch.full_gate).toBe('green');
  }, 60_000);
  it('BLOCKED on a red base and on external commits; owner mode keeps the owner rule', () => {
    const p = project({ minTasks: 1 }, { red: true });
    p.queueMerge('A-1');
    p.markHealth();
    let c = p.pushCheck();
    expect(c.out).toContain('Verdict: BLOCKED (base is red at');
    expect(c.out).toContain('Push only when the owner has said "push".');
    const q = project({ minTasks: 1 });
    q.queueMerge('A-1');
    q.commit('x.txt', 'docs: from another session');
    c = q.pushCheck();
    expect(c.code).toBe(0);
    expect(c.out).toContain('1 commit(s) outside the queue go along with the next push');
    expect(c.out).not.toContain('BLOCKED');
    const t = project({ minTasks: 1, mode: 'threshold' });
    t.queueMerge('A-1');
    t.commit('x.txt', 'docs: from another session');
    c = t.pushCheck();
    expect(c.code).toBe(2);
    expect(c.out).toContain('Verdict: BLOCKED (1 external commit(s): ask the owner first).');
  }, 60_000);
});

describe('the workflow scan (ravenseat doctor ci-cost)', () => {
  it('push trigger, concurrency, path filter', () => {
    const full = [
      'name: ci',
      'on:',
      '  push:',
      '    branches: [main]',
      '    paths-ignore:',
      "      - 'docs/**'",
      'concurrency:',
      '  group: ci-${{ github.ref }}',
      '  cancel-in-progress: true',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    expect(PB.workflowCost(full)).toEqual({ push: true, concurrency: true, pathFilter: true });
    expect(PB.workflowCost('on: [push, pull_request]\njobs: {}\n')).toEqual({ push: true, concurrency: false, pathFilter: false });
    expect(PB.workflowCost('on: push\n')).toMatchObject({ push: true });
    expect(PB.workflowCost('on:\n  - push\n')).toMatchObject({ push: true });
    expect(PB.workflowCost('on:\r\n  push:\r\n    paths:\r\n      - src/**\r\n')).toMatchObject({ push: true, pathFilter: true });
    expect(PB.workflowCost('on:\n  pull_request:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: git push\n')).toMatchObject({ push: false });
    expect(PB.workflowCost('on: pull_request\n')).toMatchObject({ push: false });
    // An expression counts as set; false does not; a paths key under jobs is not a trigger filter.
    expect(PB.workflowCost('on: push\nconcurrency:\n  cancel-in-progress: ${{ github.ref != \'refs/heads/main\' }}\n').concurrency).toBe(true);
    expect(PB.workflowCost('on: push\nconcurrency:\n  cancel-in-progress: false\n').concurrency).toBe(false);
    expect(PB.workflowCost('on: push\njobs:\n  a:\n    paths:\n      - x\n').pathFilter).toBe(false);
  });
});
