// =============================================================
// redteam/fixPlateau-cli.test.ts: the fix-round plateau end to end (receive and resume, lib/fixPlateau.js).
//
// Why: a fix round costs a whole track session. When the previous round committed nothing, or the check fails exactly
// as before, the queue asks the owner (exit 8, one question) instead of starting more of the same until the cap. The
// owner's answer allows the round; "fixPlateau": false turns the check off.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task, tmp } from './project';

/** A quick gate that is red wherever lib/A.ts exists (A's worktree), green elsewhere. Same output every run. */
function redForA() {
  const file = path.join(tmp('plateau-gate-'), 'gate.cjs');
  fs.writeFileSync(file, "process.exit(require('fs').existsSync('lib/A.ts') ? 1 : 0);\n");
  return `node "${file}"`;
}

type Task = { id: string; status: string; waiting_on?: string[]; resumed?: { round: number; tip?: string; signature?: string }[]; blocks?: { code: string; to?: string }[] };

function setup(config: Record<string, unknown> = {}) {
  const p = project({ gates: [redForA()], config, tasks: [task('A')] });
  const queue = () => JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8'));
  const A = () => p.taskOf('A') as Task;
  const scratch = p.localDelivers('A');
  const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
  /** The agent's fix round: optionally one more commit, and its RESULT line in the round's folder. */
  const fixRound = (round: number, { commit = true } = {}) => {
    if (commit) {
      fs.appendFileSync(path.join(wt, 'lib', 'A.ts'), `fix round ${round}\n`);
      p.g(['commit', '-q', '-am', `fix: A round ${round}`], wt);
    }
    const dir = path.join(scratch, `A-r${round}`);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'track-result.md');
    fs.writeFileSync(f, `RESULT status=DONE branch=queue/A commits=${commit ? 1 : 0} migr=- gates=OK probe=- ownerQuestions=0 edge=-\n`);
    const later = Date.now() / 1000 + 60 * (round + 1);
    fs.utimesSync(f, later, later);
  };
  const questions = () => Object.keys(queue().question ?? {}).filter((k) => k.startsWith('A.'));
  return { p, A, scratch, fixRound, questions };
}

describe('the fix-round plateau', () => {
  it('the same red gate after a fix round: one owner question, and the answer allows the round', () => {
    const { p, A, scratch, fixRound, questions } = setup();
    const first = p.run('receive', 'A');
    expect(first.out).toContain('RESUME A-r1 (fix)');
    expect(A().resumed?.[0]?.tip).toMatch(/^[0-9a-f]{40}$/);
    expect(A().resumed?.[0]?.signature).toMatch(/^gate:1:/);
    fixRound(1);

    const stuck = p.run('receive', 'A');
    expect(stuck.code, stuck.out).toBe(8);
    expect(stuck.out).toContain('FIX-ROUND PLATEAU: A looks stuck (the same failure as before fix round 1)');
    expect(fs.existsSync(path.join(scratch, 'prompt-A-r2.md'))).toBe(false);
    expect(questions()).toEqual(['A.plateau1']);
    expect(A().waiting_on).toEqual(['A.plateau1']);
    expect(A().blocks?.find((b) => !b.to)?.code).toBe('owner-question');
    // Not asked twice.
    expect(p.run('resume', 'A', '--reason', 'fix').code).toBe(8);
    expect(questions()).toEqual(['A.plateau1']);
    expect(A().resumed).toHaveLength(1);

    const answered = p.run('resolve', 'A.plateau1', '--answer', 'read the gate output first');
    expect(answered.code, answered.out).toBe(0);
    const again = p.run('resume', 'A', '--reason', 'fix');
    expect(again.code, again.out).toBe(0);
    expect(fs.existsSync(path.join(scratch, 'prompt-A-r2.md'))).toBe(true);
    expect(A().resumed).toHaveLength(2);
  }, 240_000);

  it('a fix round with no new commits is a plateau too', () => {
    const { p, fixRound } = setup();
    expect(p.run('receive', 'A').out).toContain('RESUME A-r1 (fix)');
    fixRound(1, { commit: false });
    const stuck = p.run('receive', 'A');
    expect(stuck.code, stuck.out).toBe(8);
    expect(stuck.out).toContain('fix round 1 committed nothing');
  }, 240_000);

  it('"fixPlateau": false: the rounds go on until the cap', () => {
    const { p, fixRound, questions } = setup({ fixPlateau: false });
    expect(p.run('receive', 'A').out).toContain('RESUME A-r1 (fix)');
    fixRound(1);
    const next = p.run('receive', 'A');
    expect(next.out).toContain('RESUME A-r2 (fix)');
    expect(questions()).toEqual([]);
  }, 240_000);
});
