// =============================================================
// redteam/rt26-worktree-outside.test.ts: RT-26 "a track's worktree is not where Ravenseat expects it, or was freed by
// resume" (map row 12, found by the R5 round with real agents on 2026-11-08).
//
// Why: in R5 the agents' worktrees were git worktrees of the project outside its folder. Two things went wrong that the
// lab had never shown, because its worktrees were always under <root>/.claude/worktrees:
//   1. `ravenseat gates` run from such a worktree fell back to the project root. The precheck saw "0 changed file(s)" and
//      the quick gate ran on the main checkout's commit, so a track's own run said green about code it never checked.
//      (receive runs the gate with --cwd in the track's worktree, so the merge was never at risk; the track's own answer was.)
//   2. `ravenseat resume` frees the old worktree with `git switch --detach`. When the new agent then ran
//      `prepare-track --continue` in that same worktree, it was refused: "detached HEAD has 1 commit(s) that are not on
//      main", though that commit was exactly the tip of the branch it was told to take over.
// Real git, prepare-track and gates; only the agent is fake (plain commits).
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, SCRIPTS, tmp } from './project';

type P = ReturnType<typeof project>;

/** A worktree of the project OUTSIDE its folder, as a user or another tool may make it, then the mission's first step. */
function outsideWorktree(p: P, trackId: string, extra: string[] = []) {
  const wt = path.join(tmp('rt26-wt-'), trackId);
  p.g(['worktree', 'add', '-q', '--detach', wt, 'main']);
  return { wt, prep: prepare(p, wt, trackId, extra) };
}
function prepare(p: P, wt: string, trackId: string, extra: string[] = []) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'prepare-track.mjs'), trackId, '--scratchpad', path.join(p.folder, 'scratch'), ...extra], {
    cwd: wt,
    env: p.env,
    encoding: 'utf8',
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
function gates(p: P, wt: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'gates.mjs'), ...args], { cwd: wt, env: p.env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const commit = (p: P, wt: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), text);
  p.g(['add', '--', file], wt);
  p.g(['commit', '-q', '-m', `edit ${file}`], wt);
};

describe('RT-26: a track worktree outside the project folder, and one freed by resume', () => {
  it('the gates run in the track worktree, not in the main checkout: a branch the gate refuses is red', () => {
    // The gate refuses lib/A.ts. On main the file does not exist, so a run in the main checkout is green.
    const p = project({ gates: [`node -e "process.exit(require('fs').existsSync('lib/A.ts') ? 1 : 0)"`] });
    userMess(p.repo);
    const before = snapshot(p.repo, p.folder);
    expect(p.run('fill', '--ids', 'A', '--scratchpad', path.join(p.folder, 'scratch')).code).toBe(0);
    const { wt, prep } = outsideWorktree(p, 'A');
    expect(prep).toMatch(/^READY A:/m);
    commit(p, wt, 'lib/A.ts', 'the gate refuses this\n');

    // SAFETY: before the fix both ran in the main checkout: 0 changed files and a green gate about main's commit.
    const pre = gates(p, wt, '--precheck');
    expect(pre.out).toMatch(/precheck: 1 changed file\(s\) against main/);
    const quick = gates(p, wt, '--quick');
    expect(quick.code, quick.out).not.toBe(0);
    expect(quick.out).not.toMatch(/ALL GREEN/);
    expect(quick.out).not.toMatch(/in the main checkout/);

    // A folder that is not a worktree of this project still runs in the project root, as before.
    const elsewhere = tmp('rt26-elsewhere-');
    const outside = gates(p, elsewhere, '--quick');
    expect(outside.code, outside.out).toBe(0);
    expect(outside.out).toMatch(/ALL GREEN/);
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A', 'queue/B'] });
  }, 120_000);

  it('fill --ids A,B takes the comma form as two ids, the same as --ids A B', () => {
    const p = project();
    const r = p.run('fill', '--ids', 'A,B', '--scratchpad', path.join(p.folder, 'scratch'));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/FILLED 2 track/);
    expect([p.taskOf('A')?.status, p.taskOf('B')?.status]).toEqual(['running', 'running']);
  }, 60_000);

  it('resume frees the worktree; prepare-track --continue in it takes the branch over, and dangling work is still refused', () => {
    const p = project();
    userMess(p.repo);
    const before = snapshot(p.repo, p.folder);
    const scratch = path.join(p.folder, 'scratch');
    expect(p.run('fill', '--ids', 'A', '--scratchpad', scratch).code).toBe(0);
    const { wt, prep } = outsideWorktree(p, 'A');
    expect(prep).toMatch(/^READY A:/m);
    commit(p, wt, 'lib/A.ts', 'part 1\n');
    const tip = p.g(['rev-parse', 'HEAD'], wt);
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'A', 'track-result.md'),
      'RESULT status=PARTIAL branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=1 edge=-\n',
    );

    // What the orchestrator does: the owner's answer, a continuation. resume frees the branch in the old worktree.
    const resume = p.run('resume', 'A', '--reason', 'context', '--answer', 'hide them', '--scratchpad', scratch);
    expect(resume.code, resume.out).toBe(0);
    if (p.g(['branch', '--show-current'], wt)) p.g(['switch', '-q', '--detach'], wt);

    // SAFETY: a detached HEAD with a commit on neither main nor the branch would be left dangling: still refused.
    commit(p, wt, 'lib/stray.ts', 'on no branch\n');
    expect(prepare(p, wt, 'A-r1', ['--branch', 'queue/A', '--continue'])).toMatch(/DENIES A-r1: .*detached HEAD has 1 commit/);
    p.g(['reset', '-q', '--hard', tip], wt);

    // The detached HEAD is the branch tip: before the fix this was refused with the same message.
    const again = prepare(p, wt, 'A-r1', ['--branch', 'queue/A', '--continue']);
    expect(again).toMatch(/^READY A-r1: branch queue\/A @ \w+ \(continues, 1 own commit/m);
    expect(p.g(['branch', '--show-current'], wt)).toBe('queue/A');
    expect(p.g(['rev-parse', 'HEAD'], wt)).toBe(tip);
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A', 'queue/B'] });
  }, 120_000);
});
