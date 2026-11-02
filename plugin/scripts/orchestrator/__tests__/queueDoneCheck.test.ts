// =============================================================
// queueDoneCheck.test.ts: the done command (done_when) and the fix-round cap through queue.mjs.
//
// Locks: (1) `receive` runs the done command in the track's worktree before any review: red gives the blocker gate-red,
// only the tail of the output, and a fix round whose brief carries that tail; (2) at the cap (maxFixRounds / max_fix_rounds)
// the next fix round is not started: the task gets a registered owner question in waiting_on and the blocker
// owner-question (exit 8), and a resolved question allows one more round; (3) a green command lets receive go on, and
// `merge` does not run it again on the same tip but does after a new commit; (4) `edit` validates and removes the field.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER), a temporary git repo (QUEUE_GIT) with a worktree for the track
// branch, and an injected merge runner (QUEUE_MERGE_RUNNING), as queueAdopt.test.ts. Never the main repo or the real queue.
// The commands are tiny `node -e` scripts (cmd.exe and POSIX shells read them the same).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Queue = { tasks: Task[]; question?: Record<string, { text: string }>; resolved?: string[] };

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const RES = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-';
// Red: prints a "secret" first (built at run time, so the command text itself does not contain it) and many lines
// after it, so the kept tail (5 lines in this config) cannot hold it.
const RED = `node -e "console.log('SECRET'+'-EARLY');for(let i=0;i<60;i++)console.log('fail line '+i);process.exit(1)"`;
// Green only where lib/A.ts exists: in the track's worktree, not in the main tree (which is on the base branch).
const GREEN = `node -e "process.exit(require('fs').existsSync('lib/A.ts')?0:1)"`;

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('queue.mjs receive, resume and merge with a done command', () => {
  it('red gives a fix round with the tail, the cap gives an owner question, green goes on to merge', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-done-cli-'));
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
    // The track's worktree has the branch checked out (as an agent's worktree does when it delivers).
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
      done_when: RED,
    };
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({ baseBranch: 'develop', doneCheck: { timeoutSec: 60, tailLines: 5 }, maxFixRounds: 1 }),
    );
    fs.mkdirSync(path.join(folder, 'docs'));
    fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
    // The merge runner: every step green, no real merge, migration push or gate.
    const runner = path.join(folder, 'runner.mjs');
    fs.writeFileSync(runner, "export default () => ({ code: 0, out: '' });\n");
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
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')) as Queue;
    const find = () => queue().tasks[0];
    const report = (dir: string, text: string) => {
      fs.mkdirSync(path.join(scratch, dir), { recursive: true });
      const f = path.join(scratch, dir, 'report.md');
      fs.writeFileSync(f, text);
      const later = Date.now() / 1000 + 60 * (dir.length + 1);
      fs.utimesSync(f, later, later);
    };

    // ---- edit validates the field (the same rule as add) ----
    expect(run('edit', 'A', '--json', JSON.stringify({ done_when: '' })).error).toContain('done_when must be a non-empty');
    expect(run('edit', 'A', '--json', JSON.stringify({ max_fix_rounds: 99 })).error).toContain('max_fix_rounds must be');

    // ---- 1. The track says DONE, the done command is red: a fix round, not a review ----
    report('A', `${RES}\n\n# Report A\n`);
    const m1 = run('receive', 'A');
    expect(m1.code).toBe(1);
    expect(m1.out).toContain('DONE COMMAND (receive) for A in ');
    expect(m1.out).toContain('NOT DONE');
    expect(m1.out).toContain('RESUME A-r1 (fix)');
    expect(m1.out).not.toContain('SECRET-EARLY');
    expect(find()).toMatchObject({
      status: 'review',
      done_check: { ok: false, exit: 1, step: 'receive' },
      resumed: [{ round: 1, reason: 'fix' }],
    });
    expect((find().blocks as { code: string; to?: string }[]).find((b) => !b.to)?.code).toBe('gate-red');
    const tailFile = path.join(scratch, 'done-A.md');
    expect(fs.readFileSync(tailFile, 'utf8')).toContain('fail line 59');
    expect(fs.readFileSync(tailFile, 'utf8')).not.toContain('SECRET-EARLY');
    const p1 = fs.readFileSync(path.join(scratch, 'prompt-A-r1.md'), 'utf8');
    expect(p1).toContain('The done command is RED (exit 1)');
    expect(p1).toContain('fail line 59');
    expect(p1).not.toContain('fail line 54');
    expect(p1).not.toContain('SECRET-EARLY');
    // The mission itself states the done command, so the agent runs it before it reports.
    expect(p1).toContain('**Done command (binding):**');

    // ---- 2. The fix round delivers, still red: the cap (1) is reached, an owner question instead of round 2 ----
    report('A-r1', `${RES}\n\n# Fix round 1\n`);
    const m2 = run('receive', 'A');
    expect(m2.code).toBe(8);
    expect(m2.out).toContain('FIX-ROUND CAP: A has had 1 fix round(s) (cap 1)');
    expect(fs.existsSync(path.join(scratch, 'prompt-A-r2.md'))).toBe(false);
    const q = queue();
    expect(q.question?.['A.fixcap1']?.text).toMatch(/1 fix round\(s\).*still not done/);
    expect(find().waiting_on).toEqual(['A.fixcap1']);
    expect((find().blocks as { code: string; to?: string }[]).find((b) => !b.to)?.code).toBe('owner-question');
    // resume by hand is refused the same way while the question is open.
    expect(run('resume', 'A', '--reason', 'fix').code).toBe(8);
    // A context continuation is not a fix round: the cap does not apply.
    expect(run('resume', 'A', '--reason', 'context').code).toBe(0);

    // ---- 3. The owner answers: exactly one more round, with the answer in the brief ----
    expect(run('resolve', 'A.fixcap1', '--answer', 'Use the cache, not a retry.').code).toBe(0);
    const r3 = run('resume', 'A', '--reason', 'fix');
    expect(r3.code).toBe(0);
    expect(r3.out).toContain("allowed by the owner's answer to A.fixcap1");
    const round = (find().resumed as { round: number }[]).at(-1)?.round;
    const p3 = fs.readFileSync(path.join(scratch, `prompt-A-r${round}.md`), 'utf8');
    expect(p3).toContain('Use the cache, not a retry.');
    expect(p3).toContain('fail line 59');
    // The next fix round needs a new answer (A.fixcap2).
    expect(run('resume', 'A', '--reason', 'fix').code).toBe(8);
    expect(queue().question?.['A.fixcap2']).toBeTruthy();

    // ---- 4. Green: receive goes on to the review package, merge does not run it again on the same tip ----
    expect(run('edit', 'A', '--json', JSON.stringify({ done_when: GREEN })).code).toBe(0);
    report(`A-r${round}`, `${RES}\n\n# Fix round ${round}\n`);
    const m4 = run('receive', 'A');
    expect(m4.error).toBe('');
    expect(m4.code).toBe(0);
    expect(m4.out).toContain('Done command GREEN');
    expect(m4.out).toContain('A: review');
    expect(find().done_check).toMatchObject({ ok: true, exit: 0, step: 'receive' });
    const mg1 = run('merge', 'A', '--without-fill');
    expect(mg1.code).toBe(0);
    expect(mg1.out).toMatch(/Done command green at [0-9a-f]{12} \(receive/);
    expect(mg1.out).not.toContain('DONE COMMAND (merge)');
    // A new commit on the branch: merge runs it again.
    fs.writeFileSync(path.join(worktree, 'lib', 'B.ts'), 'export const b = 2;\n');
    g(['add', '--', 'lib/B.ts'], worktree);
    g(['commit', '-q', '-m', 'feat: B'], worktree);
    const mg2 = run('merge', 'A', '--without-fill');
    expect(mg2.code).toBe(0);
    expect(mg2.out).toContain('DONE COMMAND (merge)');
    expect(find().done_check).toMatchObject({ ok: true, step: 'merge' });

    // ---- 5. null removes the field ----
    expect(run('edit', 'A', '--json', JSON.stringify({ done_when: null, max_fix_rounds: null })).code).toBe(0);
    expect('done_when' in find()).toBe(false);
  });
});
