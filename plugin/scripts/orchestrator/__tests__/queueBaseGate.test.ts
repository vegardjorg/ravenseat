// =============================================================
// queueBaseGate.test.ts: the base gate (lib/baseHealth.js, cli/baseHealth.mjs) through `queue.mjs merge`.
//
// Locks: (1) a green merge records green for the new base tip (the first merge checks the base first, since nothing is
// recorded); (2) two tracks that are each green but break the base together (a semantic conflict, no textual one): the
// second merge records red, adds the base fix task (value 10, fixes the merged task, the base gate as its done command,
// the tail in a report file), and the next merge of another track is refused (exit 9) while the fix task itself is
// allowed and makes it green again; (3) a commit by hand moves the tip: the next merge checks first, a red check adds a
// fix task without a cause, --force-red-base goes on, is logged and reuses the open fix task; (4) the skip rule: a
// track that already contains the base and whose own gate ran green on its tip is recorded green without the gates
// step; (5) other base gate commands run as their own step, and a red one lets done go on but exits 9; (6) the feature
// off: no state file, no refusal, no fix task; (7) the flaky check: a red base gate reruns only the failed commands once
// on the same sha; green on the rerun records green with `flaky`, a finding and a flakyGate row (no freeze), red twice
// freezes as before, and baseGate.flakyRerun false freezes at once; (8) the base gate runs scrubbed; (9) the skip rule and
// the flaky check read only trusted rows: a later tampered run, a legacy entry and another gate setup never skip; (10) a
// run that changed the git hooks or config is never called flaky, and a base gate that does it is red.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and git repo (QUEUE_GIT), with an injected merge runner
// (QUEUE_MERGE_RUNNING) that merges with plain git (merge-track.mjs refuses a test identity) and runs the other steps
// (the real gates.mjs, the real `set done`) as ravenseat merge would. Never the main repo or the real queue. The gate is a tiny
// `node check.js` that loads every file in lib/ (cmd.exe and POSIX shells read it the same).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[] };

/**
 * One turn of the event loop, inside a test that blocks for a long time with spawnSync: past 60 s without one, vitest's own
 * progress call times out and the run ends with exit 1 (__tests__/yieldBetweenTests.setup.mjs has the why).
 */
const step = () => new Promise((resolve) => setImmediate(resolve));
const loopTurn = () => step().then(step);

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const GATES = path.join(ROOT, 'scripts', 'orchestrator', 'gates.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
// Loads every module in lib/: red when one throws on load (a call to a function another track renamed).
const CHECK_JS =
  "const fs = require('fs'); const path = require('path');\n" +
  "for (const f of fs.readdirSync('lib').sort()) require(path.resolve('lib', f));\n" +
  "console.log('check ok');\n";
const CHECK = 'node check.js';
// Red and green in turn (a marker file outside the repo, FLAKY_FILE): a flaky gate command.
const FLAKY_JS =
  "const fs = require('fs'); const f = process.env.FLAKY_FILE;\n" +
  'if (!f) process.exit(0);\n' +
  "if (fs.existsSync(f)) { fs.rmSync(f); console.log('flaky green'); process.exit(0); }\n" +
  "fs.writeFileSync(f, '1'); console.log('flaky red'); process.exit(1);\n";
const FLAKY = 'node flaky.js';

const temporary: string[] = [];
afterAll(() => {
  // On Windows the timed-out gate can leave its node grandchild alive a few seconds,
  // holding the temp folder; a left-over temp folder is not a test failure.
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

/** A temporary project: repo on develop with lib/a.js and check.js, a queue, a config and the merge runner. */
function project(config: Record<string, unknown>, queueExtra: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-basegate-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const scratch = path.join(folder, 'scratch');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.mkdirSync(scratch);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'check.js'), CHECK_JS);
  fs.writeFileSync(path.join(repo, 'lib', 'a.js'), "exports.name = () => 'a';\n");
  g(['add', '--', 'check.js', 'lib/a.js']);
  g(['commit', '-q', '-m', 'start']);
  const tasks: Task[] = [];
  const writeQueue = () =>
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], ...queueExtra, tasks }),
    );
  writeQueue();
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', ...config }));
  // The merge runner: a real merge with plain git, every other step as ravenseat merge would run it; the steps are logged.
  const runner = path.join(folder, 'runner.mjs');
  const steps = path.join(folder, 'steps.log');
  fs.writeFileSync(
    runner,
    [
      "import { spawnSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      `const ID = ${JSON.stringify(ID)};`,
      'export default ({ step, cmd, args }) => {',
      `  fs.appendFileSync(${JSON.stringify(steps)}, step + '\\n');`,
      "  const repo = process.env.QUEUE_GIT;",
      "  const r = step === 'merge'",
      "    ? spawnSync('git', ['-C', repo, ...ID, 'merge', '--no-ff', '--no-edit', args[1]], { encoding: 'utf8' })",
      "    : spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: process.env });",
      "  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') + (step === 'merge' && r.status === 0 ? '\\nMerged by the test runner' : '') };",
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
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue;
  const find = (id: string) => queue().tasks.find((t) => t.id === id);
  const health = () => JSON.parse(fs.readFileSync(path.join(folder, 'base-health.json'), 'utf8'));
  const tip = () => g(['rev-parse', 'develop']);
  /** A track: branch queue/<id> from `from` (default: the base tip) with the files, and a task in review. */
  const track = (id: string, files: Record<string, string>, from = 'develop') => {
    g(['branch', `queue/${id}`, from]);
    const wt = path.join(folder, `wt-${id}`);
    g(['worktree', 'add', '-q', wt, `queue/${id}`]);
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.writeFileSync(path.join(wt, f), text);
    }
    g(['add', '--', ...Object.keys(files)], wt);
    g(['commit', '-q', '-m', `feat: ${id}`], wt);
    const q = queue();
    const own = q.tasks.find((t) => t.id === id);
    const fields = {
      title: `Task ${id}`,
      domain: 'dom',
      class: 'K',
      status: 'review',
      mission: `The mission for ${id}.`,
      value: 5,
      content_min: 30,
      depends_on: [],
      waiting_on: [],
      owned_files: Object.keys(files),
      started: '2026-01-01T00:00:00.000Z',
      branch: `queue/${id}`,
      scratchpad: scratch,
    };
    if (own) Object.assign(own, fields);
    else q.tasks.push({ id, ...fields } as Task);
    tasks.splice(0, tasks.length, ...q.tasks);
    writeQueue();
    return wt;
  };
  const stepsRun = () => (fs.existsSync(steps) ? fs.readFileSync(steps, 'utf8').split('\n').filter(Boolean) : []);
  const clearSteps = () => fs.rmSync(steps, { force: true });
  return { folder, repo, scratch, g, run, queue, find, health, tip, track, stepsRun, clearSteps, env };
}

describe('queue.mjs merge with the base gate', () => {
  it('green, red after a semantic conflict, refusal, the fix task, a hand commit and --force-red-base', async () => {
    const p = project({ gates: { quick: [CHECK] } });
    // A renames name() to newName(); B adds a module that calls name(). Each is green on its own branch.
    p.track('A', { 'lib/a.js': "exports.newName = () => 'a';\n" });
    p.track('B', { 'lib/b.js': "require('./a.js').name();\n" });
    p.track('C', { 'README.md': 'docs\n' });

    // ---- 1. The first merge: nothing recorded, so the base is checked first; the merge is green ----
    const m1 = p.run('merge', 'A', '--without-fill');
    expect(m1.error).toBe('');
    expect(m1.code).toBe(0);
    expect(m1.out).toContain('is unknown (never checked): checking it before the merge');
    expect(m1.out).toContain('BASE GREEN: develop at');
    expect(p.health().current).toMatchObject({ tip: p.tip(), status: 'green', commands: [CHECK] });
    expect(p.find('A')?.status).toBe('done');
    expect(p.run('show').out).toMatch(/BASE develop: GREEN at [0-9a-f]{12}/);

    await loopTurn();
    // ---- 2. B is green alone but red on the base with A: red, a fix task, the merge stays ----
    const m2 = p.run('merge', 'B', '--without-fill');
    expect(m2.code).toBe(1);
    expect(m2.out).not.toContain('checking it before the merge');
    expect(m2.out).toContain('BASE RED: develop is red at');
    // The flaky check reran the red command once on the same sha; red twice freezes as before.
    expect(m2.out).toContain('red again on a rerun');
    expect(m2.out).not.toContain('FLAKY');
    expect(m2.out).toContain('after the merge of B');
    expect(m2.out).toContain('Fix task: B-BASE1');
    expect(m2.out).toContain('revert -m 1');
    const mergeCommit = p.tip();
    const h2 = p.health().current;
    expect(h2).toMatchObject({
      tip: mergeCommit,
      status: 'red',
      made_red_by: { task: 'B', merge_commit: mergeCommit },
      fix_task: 'B-BASE1',
    });
    expect(fs.readFileSync(h2.tail_file, 'utf8')).toContain('name is not a function');
    // On screen: the error line of the stack trace, not only its last lines.
    expect(m2.out).toMatch(/\| .*name is not a function/);
    const fix = p.find('B-BASE1');
    expect(fix).toMatchObject({ status: 'waiting', value: 10, fixes: ['B'], done_when: CHECK, added_by: 'base gate' });
    expect(String(fix?.mission)).toContain(mergeCommit);
    expect(String(fix?.mission)).toContain(h2.tail_file);
    // The output itself never goes into the queue (only the report file holds the tail).
    expect(String(fix?.mission)).not.toContain('is not a function');
    // B stays in review with the gate-red blocker, as before the base gate.
    expect(p.find('B')?.status).toBe('review');
    expect(p.run('show').out).toContain('BASE develop: RED at');
    expect(p.run('orchestrator', 'pulse').out).toContain('ravenseat merge refuses other tracks');
    expect(p.run('decide').out).toMatch(/^BASE develop: RED at/);

    await loopTurn();
    // ---- 3. Another track is refused while the base is red ----
    const m3 = p.run('merge', 'C', '--without-fill');
    expect(m3.code).toBe(9);
    expect(m3.out).toContain('STOP: develop is red at');
    expect(m3.out).toContain('merge B-BASE1');
    expect(p.tip()).toBe(mergeCommit);
    expect(p.find('C')?.status).toBe('review');

    await loopTurn();
    // ---- 4. The fix task is allowed, and its green merge clears the red ----
    p.track('B-BASE1', { 'lib/b.js': "require('./a.js').newName();\n" });
    const m4 = p.run('merge', 'B-BASE1', '--without-fill');
    expect(m4.code).toBe(0);
    expect(m4.out).toContain('merging the base fix task B-BASE1');
    expect(m4.out).toContain('BASE GREEN');
    expect(p.health().current).toMatchObject({ tip: p.tip(), status: 'green' });
    expect(p.find('B-BASE1')?.status).toBe('done');
    expect(p.run('merge', 'C', '--without-fill').code).toBe(0);

    await loopTurn();
    // ---- 5. A commit by hand breaks the base: the tip moved, so the next merge checks first ----
    fs.writeFileSync(path.join(p.repo, 'lib', 'z.js'), "throw new Error('broken by hand');\n");
    p.g(['add', '--', 'lib/z.js']);
    p.g(['commit', '-q', '-m', 'by hand']);
    const handTip = p.tip();
    p.track('E', { 'docs/e.md': 'e\n' });
    const m5 = p.run('merge', 'E', '--without-fill');
    expect(m5.code).toBe(9);
    expect(m5.out).toContain('is unknown (the last check was at');
    expect(m5.out).toContain('BASE RED: develop is red at');
    const handFix = `BASE-${handTip.slice(0, 7)}`;
    expect(p.health().current).toMatchObject({ tip: handTip, status: 'red', fix_task: handFix });
    expect(p.health().current.made_red_by).toBeUndefined();
    expect(p.find(handFix)).toMatchObject({ status: 'waiting', value: 10 });
    expect(p.find(handFix)?.fixes).toBeUndefined();

    await loopTurn();
    // ---- 6. --force-red-base: merged anyway, logged, and the still-red base reuses the open fix task ----
    const before = p.queue().tasks.length;
    const m6 = p.run('merge', 'E', '--without-fill', '--force-red-base');
    expect(m6.out).toContain('--force-red-base: merging E on a red develop');
    expect(m6.out).not.toContain('checking it before the merge');
    expect(m6.code).toBe(1); // the quick gates are still red on the new tip
    expect(m6.out).toContain(`Fix task: ${handFix} is still open`);
    expect(p.queue().tasks.length).toBe(before);
    expect(p.health().current).toMatchObject({ status: 'red', fix_task: handFix, tip: p.tip() });
    // E only went on despite red: it is not recorded as the merge that made the base red.
    expect(p.health().current.made_red_by).toBeUndefined();
    expect(m6.out).not.toContain('after the merge of E');
    const log = fs.readFileSync(path.join(p.folder, 'times.jsonl'), 'utf8');
    expect(log).toContain('"event":"base-red-overridden"');
    expect(log).toContain('"track":"E"');
  }, 240_000);

  // Test round 4 (P10): a hand commit made the base green, and the next fill started an agent on the fix task.
  const redThenFixedByHand = () => {
    const p = project({ gates: { quick: [CHECK] } });
    p.track('A', { 'README.md': 'a\n' });
    fs.writeFileSync(path.join(p.repo, 'lib', 'z.js'), "throw new Error('broken by hand');\n");
    p.g(['add', '--', 'lib/z.js']);
    p.g(['commit', '-q', '-m', 'by hand']);
    const fix = `BASE-${p.tip().slice(0, 7)}`;
    expect(p.run('merge', 'A', '--without-fill').code).toBe(9);
    expect(p.find(fix)?.status).toBe('waiting');
    const heal = () => {
      p.g(['rm', '-q', '--', 'lib/z.js']);
      p.g(['commit', '-q', '-m', 'fixed by hand']);
    };
    const change = (fields: Record<string, unknown>) => {
      const q = p.queue();
      Object.assign(q.tasks.find((t) => t.id === fix) as Task, fields);
      fs.writeFileSync(path.join(p.folder, 'queue.json'), JSON.stringify(q));
    };
    return { p, fix, heal, change };
  };

  it('a green base cancels the fix task nobody started, and fill leaves it alone', async () => {
    const { p, fix, heal } = redThenFixedByHand();
    await loopTurn();
    heal();
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code, m.error).toBe(0);
    expect(m.out).toContain(`${fix}: cancelled, develop is green again`);
    expect(m.out).not.toContain('is still open');
    expect(p.find(fix)?.status).toBe('cancelled');
    expect(JSON.stringify(p.find(fix)?.remarks)).toContain('nothing left to fix');
    await loopTurn();
    expect(p.run('fill', '--scratchpad', p.scratch).out).not.toContain(fix);
    expect(p.find(fix)?.status).toBe('cancelled');
  }, 240_000);

  it.each([
    ['one an agent has started', { status: 'running', started: '2026-01-01T00:00:00.000Z' }, 'running'],
    ['one the CI watch added', { added_by: 'ci watch' }, 'waiting'],
  ])('a green base only points at %s', async (_name, fields, status) => {
    const { p, fix, heal, change } = redThenFixedByHand();
    change(fields);
    await loopTurn();
    heal();
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code, m.error).toBe(0);
    expect(m.out).toContain(`the base fix task ${fix} is still open`);
    expect(p.find(fix)?.status).toBe(status);
  }, 240_000);

  it('the skip rule trusts only ravenseat receive\'s gate run, never the track\'s own run or a time log row', async () => {
    const p = project({ gates: { quick: [CHECK] } });
    p.track('A', { 'lib/b.js': "exports.b = 1;\n" });
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    await loopTurn();
    // H branches from the new base tip, so the merge commit gets exactly H's tree. H's own gate runs green in its
    // worktree and writes a green time log row for its tip: that is the track's claim, not evidence.
    const wtH = p.track('H', { 'lib/h.js': "exports.h = 1;\n" });
    const own = spawnSync(process.execPath, [GATES, '--quick'], { cwd: wtH, encoding: 'utf8', env: p.env });
    expect(own.status).toBe(0);
    await loopTurn();
    const row = fs
      .readFileSync(path.join(p.folder, 'times.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"gate"'))
      .map((l) => JSON.parse(l))
      .at(-1);
    expect(row).toMatchObject({ kind: 'quick', ok: true, clean: true, sha: p.g(['rev-parse', 'queue/H']) });
    p.clearSteps();
    const mh = p.run('merge', 'H', '--without-fill');
    expect(mh.code).toBe(0);
    expect(mh.out).not.toContain('not run again');
    expect(p.stepsRun()).toEqual(['merge', 'gates', 'done']);
    await loopTurn();

    // F branches from the new base tip too; ravenseat receive runs the quick gate on F's tip itself, and that run is what the
    // skip rule trusts.
    const wt = p.track('F', { 'lib/f.js': "exports.f = 1;\n" });
    const rec = p.run('receive', 'F');
    expect(rec.code).toBe(0);
    expect(rec.out).toContain('Gates GREEN');
    expect(fs.existsSync(wt)).toBe(true);
    await loopTurn();
    p.clearSteps();
    const m = p.run('merge', 'F', '--without-fill');
    expect(m.code).toBe(0);
    expect(m.out).toContain('not run again: same tree as the track tip');
    expect(m.out).toContain("ravenseat's own quick gate run was green");
    expect(p.stepsRun()).toEqual(['merge', 'done']);
    expect(p.health().current).toMatchObject({ tip: p.tip(), status: 'green' });
    expect(p.health().current.skipped).toContain('same tree');
    await loopTurn();

    // A track that does not contain the base (G branched before F's merge) is checked as usual.
    p.track('G', { 'lib/g.js': "exports.g = 1;\n" }, 'develop~1');
    expect(p.run('receive', 'G').code).toBe(0);
    await loopTurn();
    p.clearSteps();
    expect(p.run('merge', 'G', '--without-fill').code).toBe(0);
    expect(p.stepsRun()).toEqual(['merge', 'gates', 'done']);
  }, 240_000);

  it('gates.mjs records evidence only for the orchestrator\'s side: the main checkout or --evidence', () => {
    const p = project({ gates: { quick: [CHECK] } });
    const wt = p.track('A', { 'lib/b.js': "exports.b = 1;\n" });
    const store = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(p.folder, 'gate-evidence.json'), 'utf8')).entries as Record<string, unknown>[];
      } catch {
        return [];
      }
    };
    // The track's own run in its worktree: no evidence.
    expect(spawnSync(process.execPath, [GATES, '--quick'], { cwd: wt, encoding: 'utf8', env: p.env }).status).toBe(0);
    expect(store()).toHaveLength(0);
    // The main checkout: evidence by default (the full gate before a batch push runs there).
    expect(spawnSync(process.execPath, [GATES, '--quick'], { cwd: p.repo, encoding: 'utf8', env: p.env }).status).toBe(0);
    expect(store().at(-1)).toMatchObject({ sha: p.tip(), kind: 'quick', ok: true, clean: true, main_tree: true });
    // --evidence with --cwd (what ravenseat receive passes): evidence for the worktree's tip.
    const r = spawnSync(process.execPath, [GATES, '--quick', '--evidence', '--cwd', wt], { cwd: p.folder, encoding: 'utf8', env: p.env });
    expect(r.status).toBe(0);
    expect(store().at(-1)).toMatchObject({ sha: p.g(['rev-parse', 'queue/A']), ok: true, clean: true, main_tree: false });
    // A dirty run is recorded with clean: false, which is never evidence.
    fs.writeFileSync(path.join(p.repo, 'check.js'), `${fs.readFileSync(path.join(p.repo, 'check.js'), 'utf8')}// x\n`);
    expect(spawnSync(process.execPath, [GATES, '--quick'], { cwd: p.repo, encoding: 'utf8', env: p.env }).status).toBe(0);
    expect(store().at(-1)).toMatchObject({ sha: p.tip(), clean: false });
  });

  it('other base gate commands run as their own step; red lets done go on and exits 9', () => {
    // The quick gates are green everywhere; the base gate is the stricter check.
    const p = project({ gates: { quick: ['node -e "process.exit(0)"'] }, baseGate: { commands: [CHECK], tailLines: 5 } });
    p.track('A', { 'lib/a.js': "exports.newName = () => 'a';\n" });
    p.track('B', { 'lib/b.js': "require('./a.js').name();\n" });
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    p.clearSteps();
    const m = p.run('merge', 'B', '--without-fill');
    expect(m.code).toBe(9);
    expect(p.stepsRun()).toEqual(['merge', 'gates', 'done']);
    expect(m.out).toContain('base gate: RED, the base fix task is added');
    expect(m.out).toContain('Fix task: B-BASE1');
    // The task itself is done: its own gates were green and the merge stands.
    expect(p.find('B')?.status).toBe('done');
    expect(p.find('B-BASE1')).toMatchObject({ status: 'waiting', value: 10, fixes: ['B'], done_when: CHECK });
    const tail = fs.readFileSync(p.health().current.tail_file, 'utf8');
    expect(tail).toContain('The red command: `node check.js`');
    expect(p.health().current).toMatchObject({ status: 'red', failed: CHECK, exit: 1 });
  });

  it('gates.mjs --timeout-sec makes a hanging gate red and writes sha and clean in the gate row', () => {
    const p = project({ gates: { quick: ['node -e "setTimeout(() => {}, 8000)"'] } });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [GATES, '--quick', '--timeout-sec', '2'], { cwd: p.repo, encoding: 'utf8', env: p.env });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED');
    expect(Date.now() - t0).toBeLessThan(15000);
    const row = JSON.parse(fs.readFileSync(path.join(p.folder, 'times.jsonl'), 'utf8').trim().split(/\r?\n/).at(-1) as string);
    expect(row).toMatchObject({ event: 'gate', ok: false, timed_out: true, sha: p.tip(), clean: true });
  });

  it('feature off: no state, no refusal, no fix task', () => {
    const p = project({ gates: { quick: [CHECK] }, baseGate: { enabled: false } });
    p.track('A', { 'lib/a.js': "exports.newName = () => 'a';\n" });
    p.track('B', { 'lib/b.js': "require('./a.js').name();\n" });
    p.track('C', { 'README.md': 'docs\n' });
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    const m2 = p.run('merge', 'B', '--without-fill');
    expect(m2.code).toBe(1); // the quick gates are red after the merge, as before
    expect(m2.out).not.toContain('BASE');
    const m3 = p.run('merge', 'C', '--without-fill');
    expect(m3.code).toBe(1); // still red, but not refused: the merge ran (exit 9 would be the base gate)
    expect(p.find('C')?.status).toBe('review');
    expect(fs.existsSync(path.join(p.folder, 'base-health.json'))).toBe(false);
    expect(p.queue().tasks.map((t) => t.id).sort()).toEqual(['A', 'B', 'C']);
    expect(p.run('show').out).not.toContain('BASE develop');
  });

  it('a flaky base gate: red, then green on a rerun of the failed command on the same sha; not frozen, a finding', () => {
    const p = project({ gates: { quick: [FLAKY] } }, { projects: { app: { title: 'App', prefixes: ['A'] } } });
    fs.writeFileSync(path.join(p.repo, 'flaky.js'), FLAKY_JS);
    p.g(['add', '--', 'flaky.js']);
    p.g(['commit', '-q', '-m', 'flaky gate']);
    p.env.FLAKY_FILE = path.join(p.folder, 'flaky.marker');
    p.track('A', { 'lib/b.js': 'exports.b = 1;\n' });
    // The check before the merge (unknown base) and the quick gates after it are each red once, then green on the rerun.
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).toContain(`FLAKY: \`${FLAKY}\``);
    expect(m.out).toContain('BASE GREEN');
    expect(p.find('A')?.status).toBe('done');
    expect(p.health().current).toMatchObject({ tip: p.tip(), status: 'green', flaky: [FLAKY] });
    expect(p.queue().tasks.map((t) => t.id)).toEqual(['A']);
    // One finding (the second report counts on the same entry), and a flakyGate row per rerun in the time log.
    const plans = JSON.parse(fs.readFileSync(path.join(p.folder, 'plans.json'), 'utf8'));
    const findings = plans.entries.filter((e: { finding?: unknown }) => e.finding);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain(FLAKY);
    expect(findings[0].finding.count).toBe(2);
    const rows = fs
      .readFileSync(path.join(p.folder, 'times.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"flakyGate"'))
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ event: 'flakyGate', commands: [FLAKY] });
    expect(p.run('cost').out).toMatch(/flaky gate command\(s\): 2/);
  });

  it('baseGate.flakyRerun false: a red base gate freezes at once, without a rerun', () => {
    const p = project({ gates: { quick: [FLAKY] }, baseGate: { flakyRerun: false } });
    fs.writeFileSync(path.join(p.repo, 'flaky.js'), FLAKY_JS);
    p.g(['add', '--', 'flaky.js']);
    p.g(['commit', '-q', '-m', 'flaky gate']);
    p.env.FLAKY_FILE = path.join(p.folder, 'flaky.marker');
    p.track('A', { 'lib/b.js': 'exports.b = 1;\n' });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(9);
    expect(m.out).not.toContain('FLAKY');
    expect(m.out).not.toContain('rerun');
    expect(p.health().current).toMatchObject({ status: 'red' });
  });
});

describe('the base gate and the trust rules', () => {
  const store = (p: ReturnType<typeof project>) => path.join(p.folder, 'gate-evidence.json');
  const readEntries = (p: ReturnType<typeof project>) => JSON.parse(fs.readFileSync(store(p), 'utf8')).entries as Record<string, unknown>[];
  const writeEntries = (p: ReturnType<typeof project>, entries: Record<string, unknown>[]) =>
    fs.writeFileSync(store(p), JSON.stringify({ version: 1, entries }));

  it('the base gate commands get neither QUEUE_FOLDER nor GITHUB_TOKEN', () => {
    const p = project({ gates: { quick: [CHECK] } });
    const seen = path.join(p.folder, 'base-saw.jsonl');
    const script = path.join(p.folder, 'base.cjs');
    fs.writeFileSync(
      script,
      `require('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ queue: process.env.QUEUE_FOLDER || null, token: process.env.GITHUB_TOKEN || null }) + '\\n');\n`,
    );
    const command = `node "${script.split(path.sep).join('/')}"`;
    fs.writeFileSync(path.join(p.folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'develop', gates: { quick: [CHECK] }, baseGate: { commands: [command] } }));
    p.env.GITHUB_TOKEN = 'test-token-not-for-the-base-gate';
    p.track('A', { 'lib/b.js': 'exports.b = 1;\n' });
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    const runs = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // Once before the merge (the base was unknown) and once as the base-gate step after it.
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const r of runs) expect(r).toEqual({ queue: null, token: null });
  });

  it('the skip rule: a later tampered run, a legacy entry or another gate setup makes the check run', async () => {
    const p = project({ gates: { quick: [CHECK] } });
    p.track('A', { 'lib/b.js': 'exports.b = 1;\n' });
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    /** One track on the base tip, received (green evidence on its tip), the store changed, and merged: which steps ran? */
    const mergedAfter = (id: string, change: (entries: Record<string, unknown>[], sha: string) => Record<string, unknown>[]) => {
      p.track(id, { [`lib/${id}.js`]: `exports.x = 1;\n` });
      const received = p.run('receive', id);
      expect(received.out).toContain('Gates GREEN');
      writeEntries(p, change(readEntries(p), p.g(['rev-parse', `queue/${id}`])));
      p.clearSteps();
      const m = p.run('merge', id, '--without-fill');
      expect(m.code).toBe(0);
      return p.stepsRun();
    };
    // Unchanged: the rule skips, so the three cases below differ only by what they change.
    expect(mergedAfter('S', (entries) => entries)).toEqual(['merge', 'done']);
    await loopTurn();
    expect(
      mergedAfter('T', (entries, sha) => {
        const own = entries.filter((e) => e.sha === sha).at(-1) as Record<string, unknown>;
        return [...entries, { ...own, ok: false, tampered: true, tamper_reason: 'hook added: x' }];
      }),
    ).toEqual(['merge', 'gates', 'done']);
    await loopTurn();
    expect(
      mergedAfter('L', (entries, sha) =>
        entries.map((e) => {
          if (e.sha !== sha) return e;
          const { writer: _w, setup_hash: _s, id: _i, ...legacy } = e;
          return legacy;
        }),
      ),
    ).toEqual(['merge', 'gates', 'done']);
    await loopTurn();
    expect(mergedAfter('O', (entries, sha) => entries.map((e) => (e.sha === sha ? { ...e, setup_hash: 'another setup' } : e)))).toEqual(['merge', 'gates', 'done']);
  }, 240_000);

  it('a gate run that plants a hook after the merge is not flaky and no fix task: the owner stops it, and --resume goes on', () => {
    // Plants the hook once, and only where the track's file is: red the first time (tampered), every command green.
    const script =
      "const cp = require('child_process'), fs = require('fs'), path = require('path');\n" +
      "if (fs.existsSync('lib/plant.js')) {\n" +
      "  const hooks = path.resolve(cp.execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim());\n" +
      "  fs.mkdirSync(hooks, { recursive: true });\n" +
      "  fs.writeFileSync(path.join(hooks, 'post-rewrite'), '#!/bin/sh\\nexit 0\\n');\n" +
      '}\n';
    const p = project({ gates: { quick: ['node plant-gate.js'] } });
    fs.writeFileSync(path.join(p.repo, 'plant-gate.js'), script);
    p.g(['add', '--', 'plant-gate.js']);
    p.g(['commit', '-q', '-m', 'the gate']);
    p.track('A', { 'lib/plant.js': 'exports.p = 1;\n' });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.code).toBe(1);
    expect(m.error).toContain('the owner decides');
    expect(m.error).toContain('hook added: post-rewrite');
    expect(m.error).toContain('merge A --resume');
    expect(m.out).not.toContain('FLAKY');
    expect(m.out).not.toContain('BASE RED');
    // No verdict and no base fix task for an agent; the task stays in review with no blocker.
    expect(p.queue().tasks.map((t) => t.id)).toEqual(['A']);
    expect(p.find('A')?.status).toBe('review');
    expect(JSON.stringify(p.find('A'))).not.toContain('gate-red');
    expect(readEntries(p).at(-1)).toMatchObject({ sha: p.tip(), ok: false, exit: 0, tampered: true });
    // The drift stop holds the resume until the owner has decided; accepted, the resume finishes.
    const held = p.run('merge', 'A', '--resume', '--without-fill');
    expect(held.code).toBe(1);
    expect(held.error).toContain('surface accept --by owner');
    expect(p.run('surface', 'accept', '--by', 'owner').code).toBe(0);
    const on = p.run('merge', 'A', '--resume', '--without-fill');
    expect(on.code).toBe(0);
    expect(p.find('A')?.status).toBe('done');
  });

  it('a base gate that changes the executing git config is an owner stop, with no flaky rerun and no fix task', () => {
    const p = project({ gates: { quick: [CHECK] }, baseGate: { commands: ['git config core.pager cat'] } });
    p.track('A', { 'lib/b.js': 'exports.b = 1;\n' });
    const m = p.run('merge', 'A', '--without-fill');
    expect(m.out).toContain('TAMPERED: git hooks or config changed during the run (git config changed: core.pager)');
    expect(m.out).toContain('Base gate RED');
    expect(m.out).not.toContain('once more on the same sha');
    expect(m.error).toContain('the owner decides');
    expect(p.queue().tasks.map((t) => t.id)).toEqual(['A']);
  });
});
