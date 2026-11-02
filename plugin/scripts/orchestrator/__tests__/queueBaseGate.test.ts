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
// off: no state file, no refusal, no fix task.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and git repo (QUEUE_GIT), with an injected merge runner
// (QUEUE_MERGE_RUNNING) that merges with plain git (merge-track.mjs refuses a test identity) and runs the other steps
// (the real gates.mjs, the real `set done`) as cq merge would. Never the main repo or the real queue. The gate is a tiny
// `node check.js` that loads every file in lib/ (cmd.exe and POSIX shells read it the same).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[] };

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

const temporary: string[] = [];
afterAll(() => {
  // On Windows the timed-out gate can leave its node grandchild alive a few seconds,
  // holding the temp folder; a left-over temp folder is not a test failure.
  for (const m of temporary) {
    try { fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the OS */ }
  }
});

/** A temporary project: repo on develop with lib/a.js and check.js, a queue, a config and the merge runner. */
function project(config: Record<string, unknown>) {
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
      JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks }),
    );
  writeQueue();
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', ...config }));
  // The merge runner: a real merge with plain git, every other step as cq merge would run it; the steps are logged.
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
  it('green, red after a semantic conflict, refusal, the fix task, a hand commit and --force-red-base', () => {
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

    // ---- 2. B is green alone but red on the base with A: red, a fix task, the merge stays ----
    const m2 = p.run('merge', 'B', '--without-fill');
    expect(m2.code).toBe(1);
    expect(m2.out).not.toContain('checking it before the merge');
    expect(m2.out).toContain('BASE RED: develop is red at');
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
    expect(p.run('orchestrator', 'pulse').out).toContain('cq merge refuses other tracks');

    // ---- 3. Another track is refused while the base is red ----
    const m3 = p.run('merge', 'C', '--without-fill');
    expect(m3.code).toBe(9);
    expect(m3.out).toContain('STOP: develop is red at');
    expect(m3.out).toContain('merge B-BASE1');
    expect(p.tip()).toBe(mergeCommit);
    expect(p.find('C')?.status).toBe('review');

    // ---- 4. The fix task is allowed, and its green merge clears the red ----
    p.track('B-BASE1', { 'lib/b.js': "require('./a.js').newName();\n" });
    const m4 = p.run('merge', 'B-BASE1', '--without-fill');
    expect(m4.code).toBe(0);
    expect(m4.out).toContain('merging the base fix task B-BASE1');
    expect(m4.out).toContain('BASE GREEN');
    expect(p.health().current).toMatchObject({ tip: p.tip(), status: 'green' });
    expect(p.find('B-BASE1')?.status).toBe('done');
    expect(p.run('merge', 'C', '--without-fill').code).toBe(0);

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
  });

  it('the skip rule trusts only cq receive\'s gate run, never the track\'s own run or a time log row', () => {
    const p = project({ gates: { quick: [CHECK] } });
    p.track('A', { 'lib/b.js': "exports.b = 1;\n" });
    expect(p.run('merge', 'A', '--without-fill').code).toBe(0);
    // H branches from the new base tip, so the merge commit gets exactly H's tree. H's own gate runs green in its
    // worktree and writes a green time log row for its tip: that is the track's claim, not evidence.
    const wtH = p.track('H', { 'lib/h.js': "exports.h = 1;\n" });
    const own = spawnSync(process.execPath, [GATES, '--quick'], { cwd: wtH, encoding: 'utf8', env: p.env });
    expect(own.status).toBe(0);
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

    // F branches from the new base tip too; cq receive runs the quick gate on F's tip itself, and that run is what the
    // skip rule trusts.
    const wt = p.track('F', { 'lib/f.js': "exports.f = 1;\n" });
    const rec = p.run('receive', 'F');
    expect(rec.code).toBe(0);
    expect(rec.out).toContain('Gates GREEN');
    expect(fs.existsSync(wt)).toBe(true);
    p.clearSteps();
    const m = p.run('merge', 'F', '--without-fill');
    expect(m.code).toBe(0);
    expect(m.out).toContain('not run again: same tree as the track tip');
    expect(m.out).toContain("cq's own quick gate run was green");
    expect(p.stepsRun()).toEqual(['merge', 'done']);
    expect(p.health().current).toMatchObject({ tip: p.tip(), status: 'green' });
    expect(p.health().current.skipped).toContain('same tree');

    // A track that does not contain the base (G branched before F's merge) is checked as usual.
    p.track('G', { 'lib/g.js': "exports.g = 1;\n" }, 'develop~1');
    expect(p.run('receive', 'G').code).toBe(0);
    p.clearSteps();
    expect(p.run('merge', 'G', '--without-fill').code).toBe(0);
    expect(p.stepsRun()).toEqual(['merge', 'gates', 'done']);
  });

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
    // --evidence with --cwd (what cq receive passes): evidence for the worktree's tip.
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
});
