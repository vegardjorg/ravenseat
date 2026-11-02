// =============================================================
// conflictPredict.test.ts: predicted merge conflicts (lib/conflictPredict.js, cli/conflicts.mjs, the pulse lines,
// the merge-conflict context in cq merge and the fix round brief, and the doctor's git line).
//
// Why: two tracks that edit the same lines only meet at `cq merge`, after both have spent their time. With
// `git merge-tree --write-tree` the orchestrator sees it while they run, and a real conflict starts its fix round
// knowing which files and which other tasks. Tested against TEMPORARY git repos (never the main repo): two branches
// editing the same lines (predicted), different files (not predicted), a base conflict, the cache, the budget, and
// the old-git fallback through an injected version.
// =============================================================
import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Run = (args: string[]) => { code: number | null; stdout: string };
type Tip = { id: string; branch: string; sha: string; status: string; depends_on: string[] };
type Result = {
  mode: string;
  note: string | null;
  tips: { id: string }[];
  baseConflicts: { id: string; files: string[] }[];
  pairs: { a: string; b: string; files: string[] }[];
  order: string[];
  orderRule: string;
  partial: boolean;
  skipped: number;
  errors: string[];
  unchanged: boolean;
  checks: number;
  cacheHits: number;
  ms: number;
};
type Cache = { version: number; entries: Record<string, unknown>; last: unknown };
type MergeContext = { at: string; files: { file: string; tasks: string[]; commits: string[] }[] };

/* eslint-disable @typescript-eslint/no-require-imports */
const CP = require('../conflictPredict.js') as {
  MIN_GIT_TEXT: string;
  makeRunner: (cwd: string) => Run;
  parseGitVersion: (t: string) => number[] | null;
  supportsMergeTree: (v: string | number[] | null) => boolean;
  gitVersion: (run: Run, env?: Record<string, string | undefined>) => string | null;
  tipsFor: (tasks: object[], refs: Map<string, string>, o?: { prefix?: string }) => Tip[];
  readRefs: (run: Run) => Map<string, string>;
  emptyCache: () => Cache;
  readCache: (file: string) => Cache;
  writeCache: (file: string, c: Cache) => boolean;
  predict: (p: {
    run: Run;
    base: { name: string; sha: string };
    tips: Tip[];
    version: string | null;
    cache?: Cache;
    budgetMs?: number;
    maxChecks?: number;
    clock?: () => number;
  }) => Result;
  orderFor: (
    tips: { id: string; status: string; depends_on?: string[] }[],
    base: { id: string; files: string[] }[],
    pairs: { a: string; b: string; files: string[] }[],
  ) => { ids: string[]; rule: string };
  pulseLines: (r: Result, o?: { cq?: string }) => string[];
  conflictFilesFromOutput: (out: string) => string[];
  mergeConflictContext: (p: {
    out?: string;
    task: { id: string };
    tasks: object[];
    run: Run;
    base: string;
    branch: string;
    prefix?: string;
  }) => MergeContext;
  mergeStopLines: (mc: MergeContext, o: { id: string; cq?: string }) => string[];
  briefLines: (mc: MergeContext | undefined, o: { base?: string; branch: string }) => string[];
};
const L = require('../queueLogic.js') as {
  resumeBlock: (p: { o: object; round: number; reason: string; original?: string }) => string;
};

// Each test makes a repo with about 25 git calls; on a loaded machine (parallel workers) that takes a while.
vi.setConfig({ testTimeout: 240_000 });
// The tests that expect a complete result lift the time budget, so a slow machine never makes them PARTIAL.
const P: typeof CP.predict = (p) => CP.predict({ budgetMs: 600_000, ...p });

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', '-c', 'core.autocrlf=false'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

/**
 * A temporary repo: main with f.txt (5 lines) and g.txt; queue/A and queue/B change line 2 of f.txt differently
 * (a conflict), queue/C adds h.txt (clean with everything), queue/D changes g.txt line 1 while main changes the same
 * line after D forked (a base conflict), queue/E changes line 5 of f.txt (same file as A, different lines: clean).
 */
function repo() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-conflicts-'));
  temporary.push(folder);
  const dir = path.join(folder, 'repo');
  fs.mkdirSync(dir);
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
  const commit = (msg: string, ...files: string[]) => {
    g('add', '--', ...files);
    g('commit', '-q', '-m', msg);
  };
  g('init', '-q', '-b', 'main');
  write('f.txt', 'one\ntwo\nthree\nfour\nfive\n');
  write('g.txt', 'alpha\nbeta\n');
  commit('start', 'f.txt', 'g.txt');
  const branch = (name: string, edit: () => string[]) => {
    g('switch', '-q', '-c', name, 'main');
    commit(name, ...edit());
    g('switch', '-q', 'main');
  };
  branch('queue/A', () => (write('f.txt', 'one\nTWO-A\nthree\nfour\nfive\n'), ['f.txt']));
  branch('queue/B', () => (write('f.txt', 'one\nTWO-B\nthree\nfour\nfive\n'), ['f.txt']));
  branch('queue/C', () => (write('h.txt', 'new\n'), ['h.txt']));
  branch('queue/D', () => (write('g.txt', 'ALPHA-D\nbeta\n'), ['g.txt']));
  branch('queue/E', () => (write('f.txt', 'one\ntwo\nthree\nfour\nFIVE-E\n'), ['f.txt']));
  write('g.txt', 'ALPHA-MAIN\nbeta\n');
  commit('main moves', 'g.txt');
  return { folder, dir, g, write, commit };
}

/** A runner that counts the merge-tree calls (and passes everything to the real one). */
function counting(run: Run) {
  const calls: string[][] = [];
  const r: Run = (args) => {
    calls.push(args);
    return run(args);
  };
  return { run: r, mergeTrees: () => calls.filter((a) => a[0] === 'merge-tree').length, calls };
}

const tasks = (ids: string[], extra: Record<string, object> = {}) =>
  ids.map((id) => ({ id, status: 'running', branch: `queue/${id}`, ...(extra[id] ?? {}) }));

function setup(ids = ['A', 'B', 'C', 'D', 'E'], extra: Record<string, object> = {}) {
  const r = repo();
  const run = CP.makeRunner(r.dir);
  const refs = CP.readRefs(run);
  const tips = CP.tipsFor(tasks(ids, extra), refs);
  const base = { name: 'main', sha: refs.get('main')! };
  return { ...r, run, refs, tips, base };
}

describe('git version', () => {
  it('parses versions and knows the merge-tree limit (2.38)', () => {
    expect(CP.parseGitVersion('git version 2.52.0.windows.1')).toEqual([2, 52, 0]);
    expect(CP.parseGitVersion('git version 2.38')).toEqual([2, 38, 0]);
    expect(CP.parseGitVersion('nothing')).toBeNull();
    expect(CP.supportsMergeTree('2.37.9')).toBe(false);
    expect(CP.supportsMergeTree('2.38.0')).toBe(true);
    expect(CP.supportsMergeTree('3.0.0')).toBe(true);
    expect(CP.supportsMergeTree(null)).toBe(false);
    expect(CP.gitVersion(() => ({ code: 0, stdout: 'x' }), { QUEUE_GIT_VERSION: '2.20.1' })).toBe('2.20.1');
    expect(CP.gitVersion(() => ({ code: 0, stdout: 'git version 2.45.1\n' }), {})).toBe('2.45.1');
  });
});

describe('predict with git merge-tree (temporary repo)', () => {
  it('predicts the same-line pair and the base conflict, not different files or different lines', () => {
    const s = setup();
    const r = P({ run: s.run, base: s.base, tips: s.tips, version: '2.52.0' });
    expect(r.mode).toBe('merge-tree');
    expect(r.note).toBeNull();
    expect(r.pairs).toEqual([{ a: 'A', b: 'B', files: ['f.txt'] }]);
    expect(r.baseConflicts).toEqual([{ id: 'D', files: ['g.txt'] }]);
    // C (another file) and E (same file, other lines) are clean with everything.
    expect(r.pairs.some((p) => [p.a, p.b].includes('C') || [p.a, p.b].includes('E'))).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.checks).toBe(5 + 10);
    const lines = CP.pulseLines(r);
    expect(lines).toContain('PREDICTED CONFLICT A x B: f.txt');
    expect(lines).toContain('CONFLICTS WITH BASE: D: g.txt');
    expect(lines.find((l) => l.startsWith('Suggested merge order:'))).toBe(
      `Suggested merge order: C, E, A, B, D (rule: ${r.orderRule}).`,
    );
    // The checkout is untouched: merge-tree writes no index, no worktree file and no ref.
    expect(s.g('status', '--porcelain')).toBe('');
    expect(CP.readRefs(s.run)).toEqual(s.refs);
  });

  it('nothing to say when the tips touch different files: no lines at all', () => {
    const s = setup(['A', 'C']);
    const r = P({ run: s.run, base: s.base, tips: s.tips, version: '2.52.0' });
    expect(r.pairs).toEqual([]);
    expect(r.baseConflicts).toEqual([]);
    expect(CP.pulseLines(r)).toEqual([]);
  });

  it('the cache: unchanged shas cost no merge-tree; a moved tip re-checks only its own pairs', () => {
    const s = setup();
    const cache = CP.emptyCache();
    const c1 = counting(s.run);
    P({ run: c1.run, base: s.base, tips: s.tips, version: '2.52.0', cache });
    expect(c1.mergeTrees()).toBe(15);
    // Same shas: the last result, no git call at all.
    const c2 = counting(s.run);
    const again = P({ run: c2.run, base: s.base, tips: s.tips, version: '2.52.0', cache });
    expect(again.unchanged).toBe(true);
    expect(c2.calls).toEqual([]);
    expect(again.pairs).toEqual([{ a: 'A', b: 'B', files: ['f.txt'] }]);
    // The cache survives a write and a read (a new pulse process).
    const file = path.join(s.folder, 'data', 'conflict-predict.json');
    expect(CP.writeCache(file, cache)).toBe(true);
    const back = CP.readCache(file);
    // C moves: its base check and its 4 pairs run again, the other 10 come from the cache.
    s.g('switch', '-q', 'queue/C');
    s.write('h.txt', 'newer\n');
    s.commit('C2', 'h.txt');
    s.g('switch', '-q', 'main');
    const tips = CP.tipsFor(tasks(['A', 'B', 'C', 'D', 'E']), CP.readRefs(s.run));
    const c3 = counting(s.run);
    const moved = P({ run: c3.run, base: s.base, tips, version: '2.52.0', cache: back });
    expect(c3.mergeTrees()).toBe(5);
    expect(moved.checks).toBe(5);
    expect(moved.cacheHits).toBe(10);
    expect(moved.unchanged).toBe(false);
    // A broken cache file is an empty cache, never an error.
    fs.writeFileSync(file, '{ broken');
    expect(CP.readCache(file)).toEqual(CP.emptyCache());
  });

  it('the budget: a capped run is PARTIAL and the next run continues from the cache', () => {
    const s = setup();
    const cache = CP.emptyCache();
    const first = P({ run: s.run, base: s.base, tips: s.tips, version: '2.52.0', cache, maxChecks: 6 });
    expect(first.partial).toBe(true);
    expect(first.checks).toBe(6);
    expect(first.skipped).toBe(9);
    expect(CP.pulseLines(first).some((l) => l.startsWith('CONFLICT PREDICTION PARTIAL: 9 check(s)'))).toBe(true);
    // A partial result is never reused as "unchanged".
    const second = P({ run: s.run, base: s.base, tips: s.tips, version: '2.52.0', cache, maxChecks: 6 });
    expect(second.unchanged).toBe(false);
    expect(second.cacheHits).toBe(6);
    expect(second.checks).toBe(6);
    const third = P({ run: s.run, base: s.base, tips: s.tips, version: '2.52.0', cache, maxChecks: 6 });
    expect(third.partial).toBe(false);
    expect(third.pairs).toEqual([{ a: 'A', b: 'B', files: ['f.txt'] }]);
    // The time budget: a clock that jumps past it stops after the first check.
    let t = 0;
    const timed = P({
      run: s.run, base: s.base, tips: s.tips, version: '2.52.0', budgetMs: 100, clock: () => (t += 1000),
    });
    expect(timed.checks).toBe(0);
    expect(timed.partial).toBe(true);
  });
});

describe('old git: the file-overlap fallback (injected version)', () => {
  it('flags shared files (also different lines), the base overlap, and says so in one note', () => {
    const s = setup();
    const r = P({ run: s.run, base: s.base, tips: s.tips, version: '2.30.0' });
    expect(r.mode).toBe('file-overlap');
    expect(r.note).toMatch(/^NOTE: git 2\.30\.0 is older than 2\.38 .*file overlap/);
    expect(r.pairs).toEqual([
      { a: 'A', b: 'B', files: ['f.txt'] },
      { a: 'A', b: 'E', files: ['f.txt'] },
      { a: 'B', b: 'E', files: ['f.txt'] },
    ]);
    expect(r.baseConflicts).toEqual([{ id: 'D', files: ['g.txt'] }]);
    const lines = CP.pulseLines(r);
    expect(lines[0]).toBe(r.note);
    expect(lines.filter((l) => l.startsWith('NOTE:'))).toHaveLength(1);
    // No merge-tree call is made on an old git.
    const c = counting(s.run);
    P({ run: c.run, base: s.base, tips: s.tips, version: '2.30.0' });
    expect(c.mergeTrees()).toBe(0);
  });
});

describe('merge order (pure)', () => {
  it('dependencies first, then fewest conflicted files, then review before running, then queue order', () => {
    const tips = [
      { id: 'A', status: 'running' },
      { id: 'B', status: 'running', depends_on: ['C'] },
      { id: 'C', status: 'running' },
      { id: 'D', status: 'review' },
    ];
    const pairs = [{ a: 'A', b: 'C', files: ['x', 'y'] }];
    const base = [{ id: 'B', files: ['z'] }];
    // Scores: A 2, B 1, C 2, D 0. B waits on C.
    expect(CP.orderFor(tips, base, pairs).ids).toEqual(['D', 'A', 'C', 'B']);
    // Review before running at the same score.
    expect(CP.orderFor([{ id: 'X', status: 'running' }, { id: 'Y', status: 'review' }], [], []).ids).toEqual(['Y', 'X']);
    // A cycle does not hang.
    expect(
      CP.orderFor([{ id: 'P', status: 'running', depends_on: ['Q'] }, { id: 'Q', status: 'running', depends_on: ['P'] }], [], [])
        .ids,
    ).toEqual(['P', 'Q']);
  });
});

describe('a real merge conflict: the context for the fix round', () => {
  it('reads the files from merge-track output', () => {
    const out = [
      'Conflicts in 2 files.',
      'Resolved automatically: locales/en.json',
      '',
      'MUST BE RESOLVED BY HAND (the merge is left in place; git merge --abort undoes it):',
      '  lib/k.ts: conflict at lines 3-9',
      '  db/x.sql:12: list value without a comma before a new value on line 13',
      '  lib/k.ts: conflict markers',
    ].join('\n');
    expect(CP.conflictFilesFromOutput(out)).toEqual(['lib/k.ts', 'db/x.sql']);
    expect(CP.conflictFilesFromOutput('No conflicts.')).toEqual([]);
  });

  it('names the queue merges on the base since the fork and the active owners', () => {
    const s = setup();
    // B is merged into main the queue way; A then conflicts on f.txt.
    s.g('merge', '--no-ff', '--no-edit', 'queue/B');
    const out = 'MUST BE RESOLVED BY HAND (x):\n  f.txt: conflict\n';
    const all = [
      { id: 'A', status: 'review', owned_files: ['f.txt'] },
      { id: 'B', status: 'done', owned_files: ['f.txt'] },
      { id: 'E', status: 'running', owned_files: ['./f.txt'] },
      { id: 'Z', status: 'done', owned_files: ['f.txt'] }, // done long ago, never merged after the fork: not named
      { id: 'W', status: 'waiting', owned_files: ['f.txt'] },
    ];
    const mc = CP.mergeConflictContext({ out, task: { id: 'A' }, tasks: all, run: s.run, base: 'main', branch: 'queue/A' });
    expect(mc.files).toEqual([{ file: 'f.txt', tasks: ['B', 'E'], commits: [] }]);
    const stop = CP.mergeStopLines(mc, { id: 'A' });
    expect(stop[0]).toBe('CONFLICTING FILES for A:');
    expect(stop[1]).toBe('  f.txt (also touched by B, E)');
    expect(stop[2]).toContain('cq resume A --reason fix');
    // The fix round brief carries the same lines (logic/resume.js through queueLogic).
    const o = { id: 'A', title: 'Task A', class: 'K', branch: 'queue/A', merge_conflict: mc };
    const brief = L.resumeBlock({ o, round: 1, reason: 'fix', original: 'mission' });
    expect(brief).toContain('The merge into main CONFLICTED');
    expect(brief).toContain('- f.txt (also touched by B, E)');
    // A continuation (context) or a task without a recorded conflict gets nothing extra.
    expect(L.resumeBlock({ o, round: 1, reason: 'context' })).not.toContain('CONFLICTED');
    expect(L.resumeBlock({ o: { ...o, merge_conflict: undefined }, round: 1, reason: 'fix' })).not.toContain('CONFLICTED');
    expect(CP.briefLines(undefined, { branch: 'queue/A' })).toEqual([]);
  });

  it('falls back to the unmerged paths when the output has no list, and names other commits', () => {
    const s = setup();
    s.g('switch', '-q', 'main');
    // main changes line 2 directly (not a queue merge), then the merge of A is left in place with a conflict.
    s.write('f.txt', 'one\nTWO-MAIN\nthree\nfour\nfive\n');
    s.commit('hotfix line two', 'f.txt');
    spawnSync('git', ['-C', s.dir, ...ID, 'merge', '--no-ff', '--no-edit', 'queue/A'], { encoding: 'utf8' });
    const mc = CP.mergeConflictContext({ out: 'Conflicts in 1 files.', task: { id: 'A' }, tasks: [], run: s.run, base: 'main', branch: 'queue/A' });
    expect(mc.files.map((f) => f.file)).toEqual(['f.txt']);
    expect(mc.files[0].tasks).toEqual([]);
    expect(mc.files[0].commits[0]).toMatch(/^[0-9a-f]+ hotfix line two$/);
    s.g('merge', '--abort');
  });
});

describe('the CLI: cq conflicts, the pulse, cq merge and cq doctor (temporary repo)', () => {
  function cli(extraEnv: Record<string, string> = {}) {
    const s = setup();
    const data = path.join(s.folder, 'data');
    fs.mkdirSync(data, { recursive: true });
    const created = new Date(Date.now() - 86_400_000).toISOString();
    const head = s.g('rev-parse', 'main');
    const task = (id: string, extra: Record<string, unknown>) => ({
      id, title: `Task ${id}`, domain: `dom-${id}`, class: 'K', value: 5, content_min: 60, migr_tens: 0,
      depends_on: [], waiting_on: [], owned_files: ['f.txt'], added_at: created, branch: `queue/${id}`,
      head_start: head, started: created, scratchpad: path.join(s.folder, 'scratch'), ...extra,
    });
    fs.writeFileSync(
      path.join(data, 'queue.json'),
      JSON.stringify({
        created, limits: {}, next_migr: 3600, resolved: [],
        tasks: [task('A', { status: 'review' }), task('B', { status: 'running' }), task('C', { status: 'waiting' })],
      }),
    );
    const configFile = path.join(s.folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({}));
    const env = {
      ...process.env,
      QUEUE_FOLDER: data, QUEUE_CONFIG: configFile, QUEUE_ROOT: s.dir, QUEUE_GIT: s.dir,
      QUEUE_TIME_LOG: path.join(data, 'times.jsonl'), QUEUE_TRANSCRIPTS: path.join(s.folder, 'transcripts'),
      QUEUE_GIT_VERSION: '', ...extraEnv,
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: s.dir });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const queue = () => JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8'));
    return { ...s, data, env, run, queue };
  }

  it('cq conflicts --json and the pulse print the prediction and keep the cache', () => {
    const c = cli();
    const j = c.run('conflicts', '--json');
    expect(j.code).toBe(0);
    const r = JSON.parse(j.out) as Result;
    // Only A (review) and B (running) are tips; C is waiting.
    expect(r.tips.map((t) => t.id)).toEqual(['A', 'B']);
    expect(r.pairs).toEqual([{ a: 'A', b: 'B', files: ['f.txt'] }]);
    expect(fs.existsSync(path.join(c.data, 'conflict-predict.json'))).toBe(true);
    const p = c.run('orchestrator', 'pulse', '--session', 'test');
    expect(p.code).toBe(0);
    expect(p.out).toContain('PREDICTED CONFLICT A x B: f.txt');
    expect(p.out).toMatch(/Suggested merge order: A, B \(rule: /);
    const again = JSON.parse(c.run('conflicts', '--json').out) as Result;
    expect(again.unchanged).toBe(true);
    expect(c.run('conflicts', '--budget-ms', '0').code).toBe(1);
  });

  it('an old git: the pulse has the note, and doctor an INFO line', () => {
    const c = cli({ QUEUE_GIT_VERSION: '2.30.0' });
    const p = c.run('orchestrator', 'pulse', '--session', 'test');
    expect(p.out).toMatch(/NOTE: git 2\.30\.0 is older than 2\.38/);
    expect(p.out).toContain('PREDICTED CONFLICT A x B: f.txt');
    const d = JSON.parse(c.run('doctor', '--json').out) as { checks: { status: string; name: string; message: string }[] };
    expect(d.checks.find((x) => x.name === 'git')).toMatchObject({ status: 'INFO' });
    const fresh = cli();
    const d2 = JSON.parse(fresh.run('doctor', '--json').out) as { checks: { name: string }[] };
    expect(d2.checks.find((x) => x.name === 'git')).toBeUndefined();
  });

  it('cq merge on a conflict records merge_conflict and prints the files; a later merge clears it', () => {
    const scenarioFile = path.join(os.tmpdir(), `cq-conflict-scenario-${process.pid}-${Date.now()}.json`);
    temporary.push(scenarioFile);
    const runner = path.join(os.tmpdir(), `cq-conflict-runner-${process.pid}-${Date.now()}.mjs`);
    temporary.push(runner);
    fs.writeFileSync(
      runner,
      [
        "import fs from 'node:fs';",
        'export default function run(x) {',
        "  const sc = JSON.parse(fs.readFileSync(process.env.MERGE_TEST_SCENARIO, 'utf8'));",
        "  return sc[x.step] ?? { code: 0, out: 'ok' };",
        '}',
      ].join('\n'),
    );
    const c = cli({ QUEUE_MERGE_RUNNING: runner, MERGE_TEST_SCENARIO: scenarioFile });
    // B is already merged the queue way, so A's conflict on f.txt names B.
    c.g('merge', '--no-ff', '--no-edit', 'queue/B');
    fs.writeFileSync(
      scenarioFile,
      JSON.stringify({ merge: { code: 1, out: 'Conflicts in 1 files.\n\nMUST BE RESOLVED BY HAND (x):\n  f.txt: conflict\n' } }),
    );
    const m = c.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.out).toContain('CONFLICTING FILES for A:');
    expect(m.out).toContain('  f.txt (also touched by B)');
    const a = c.queue().tasks.find((x: { id: string }) => x.id === 'A');
    expect(a.merge_conflict.files).toEqual([{ file: 'f.txt', tasks: ['B'], commits: [] }]);
    fs.writeFileSync(
      scenarioFile,
      JSON.stringify({ merge: { code: 0, out: 'Merged' }, gates: { code: 0, out: 'gates: OK' }, done: { code: 0, out: 'done' } }),
    );
    expect(c.run('merge', 'A', '--without-fill').code).toBe(0);
    expect(c.queue().tasks.find((x: { id: string }) => x.id === 'A').merge_conflict).toBeUndefined();
  });
});
