// =============================================================
// redteam/rt06-rt22-permanent-failure.test.ts: RT-06 "a task that never passes stops at the cap with one owner question"
// and RT-22 "one blocked task does not stop the rest" (plans/redteam-plan.md, R2).
//
// Why: the promise is progress. A task whose gate is red every round must not loop, must not ask the owner twice for the
// same thing, and must not hold back work that does not depend on it. A runs as a real local track: its quick gate is red
// whenever its file is there, so every fix round is red too. B waits on A; C, D and E are independent. The fix-round cap
// is 2 here (the default is 3), so the scenario stays short.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot } from './lab';
import { project, task, tmp } from './project';

/** A quick gate that is red wherever lib/A.ts exists (A's worktree), green elsewhere. */
function redForA() {
  const file = path.join(tmp('rt06-gate-'), 'gate.cjs');
  fs.writeFileSync(file, "process.exit(require('fs').existsSync('lib/A.ts') ? 1 : 0);\n");
  return `node "${file}"`;
}

type Task = { id: string; status: string; waiting_on?: string[]; resumed?: unknown[]; blocks?: { code: string; to?: string }[]; attempts?: unknown[] };

describe('RT-06 and RT-22: a task that never passes stops at the cap, and the independent work goes on', () => {
  it('A is red in every round: two fix rounds, then one owner question; B waits; C, D and E start', () => {
    const p = project({
      gates: [redForA()],
      // The plateau check would stop A after its first fix round (same red gate every round); this test is about the cap.
      config: { maxFixRounds: 2, fixPlateau: false },
      tasks: [task('A'), task('B', { depends_on: ['A'] }), task('C'), task('D'), task('E')],
    });
    const queue = () => JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8'));
    const A = () => p.taskOf('A') as Task;
    const scratch = p.localDelivers('A');
    const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
    /** The agent's fix round: one more commit in its worktree, and its RESULT line in the round's folder. */
    const fixRound = (round: number) => {
      fs.appendFileSync(path.join(wt, 'lib', 'A.ts'), `fix round ${round}\n`);
      p.g(['commit', '-q', '-am', `fix: A round ${round}`], wt);
      const dir = path.join(scratch, `A-r${round}`);
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'track-result.md');
      fs.writeFileSync(f, 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-\n');
      const later = Date.now() / 1000 + 60 * (round + 1);
      fs.utimesSync(f, later, later);
    };
    const before = snapshot(p.repo, p.folder);

    // Delivery and two fix rounds: each red receive starts the next round.
    for (let round = 1; round <= 2; round++) {
      const r = p.run('receive', 'A');
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain(`RESUME A-r${round} (fix)`);
      fixRound(round);
    }
    // The third red receive is the cap: no round 3, one owner question, exit 8.
    const capped = p.run('receive', 'A');
    expect(capped.code, capped.out).toBe(8);
    expect(capped.out).toContain('FIX-ROUND CAP: A has had 2 fix round(s) (cap 2)');
    expect(fs.existsSync(path.join(scratch, 'prompt-A-r3.md'))).toBe(false);
    const questions = () => Object.keys(queue().question ?? {}).filter((k) => k.startsWith('A.'));
    expect(questions()).toEqual(['A.fixcap2']);
    expect(A().waiting_on).toEqual(['A.fixcap2']);
    expect(A().blocks?.find((b) => !b.to)?.code).toBe('owner-question');

    // Not tried again after the cap, and not asked twice: neither by resume nor by a new receive.
    const rounds = A().resumed?.length;
    expect(p.run('resume', 'A', '--reason', 'fix').code).toBe(8);
    expect(p.run('receive', 'A').code).toBe(8);
    expect(A().resumed?.length).toBe(rounds);
    expect(questions()).toEqual(['A.fixcap2']);
    expect(A().status).not.toBe('done');

    // The rest: B waits on A, C, D and E are offered and start.
    const next = p.run('next');
    expect(next.code).toBe(0);
    expect(next.out).not.toMatch(/^[AB]\s/m);
    for (const id of ['C', 'D', 'E']) expect(next.out).toMatch(new RegExp(`^${id}\\s`, 'm'));
    const blockedB = p.run('start', 'B');
    expect(blockedB.code).not.toBe(0);
    expect(blockedB.out).toMatch(/B cannot be started: waiting on A/);
    const fill = p.run('fill');
    expect(fill.code, fill.out).toBe(0);
    for (const id of ['C', 'D', 'E']) expect(fill.out).toMatch(new RegExp(`^${id}\\s+subagent_type`, 'm'));
    expect(fill.out).not.toMatch(/^[AB]\s+subagent_type/m);
    for (const id of ['C', 'D', 'E']) expect(p.taskOf(id)?.status).toBe('running');
    expect(p.taskOf('B')?.status).toBe('waiting');

    // Nothing of the user's changed, nothing merged, and A's work is still on its branch.
    expect(p.g(['log', '-1', '--format=%s', 'queue/A'])).toBe('fix: A round 2');
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A'] });
  }, 240_000);
});
