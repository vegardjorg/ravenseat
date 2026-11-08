// =============================================================
// redteam/rt05-same-file.test.ts: scenario 5 "two agents change the same file" (plans/redteam-plan.md).
//
// Why: two tracks that edit the same lines of one file only meet at the merge. The fear is that the second merge quietly
// overwrites the first (work lost), half merges, or stops with nothing to go on. Two real local tracks change the same
// line of lib/shared.ts in different ways. While they run, `ravenseat conflicts` predicts the pair with git merge-tree.
// A merges. B's merge then conflicts for real (merge-track, real git): it stops, A's line stays on main, nothing of B is
// committed, and the files and the other task (A) are saved on B. After the documented `git merge --abort`, the fix
// round's brief names the file and A. The final check then says the user's things are intact.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, task } from './project';

const FILE = 'lib/shared.ts';

describe('scenario 5: two agents change the same file', () => {
  it('predicted while they run; the second merge stops on the conflict, keeps the first, and its fix round knows why', () => {
    const p = project({ tasks: [task('A', { owned_files: [FILE] }), task('B', { owned_files: [FILE] })] });
    fs.mkdirSync(path.join(p.repo, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, FILE), 'export const value = 1;\n');
    p.g(['add', '--', FILE]);
    p.g(['commit', '-q', '-m', 'the shared file', '--', FILE]);
    p.g(['push', '-q', 'origin', 'main']);
    userMess(p.repo);

    // Two tracks from the same base, each with its own version of the same line.
    const scratchA = p.localDelivers('A', FILE);
    const scratchB = p.localDelivers('B', FILE);
    const wtB = path.join(p.repo, '.claude', 'worktrees', 'agent-B');
    fs.writeFileSync(path.join(wtB, FILE), 'export const value = 2; // from B\n');
    p.g(['commit', '-q', '-am', 'feat: B wants 2'], wtB);
    const before = snapshot(p.repo, p.folder);

    // While both run, the prediction sees the pair (real git merge-tree, no writes to the checkout).
    const predicted = p.run('conflicts', '--json');
    expect(predicted.code, predicted.out).toBe(0);
    expect(JSON.parse(predicted.out.slice(predicted.out.indexOf('{'))).pairs).toEqual([{ a: 'A', b: 'B', files: [FILE] }]);

    // A merges first.
    expect(p.run('receive', 'A', '--scratchpad', scratchA).code).toBe(0);
    const mA = p.run('merge', 'A', '--scratchpad', scratchA);
    expect(mA.code, mA.out).toBe(0);
    const tipA = p.g(['rev-parse', 'main']);

    // B: a real conflict in merge-track. It stops, names the file and A, and B is not done.
    expect(p.run('receive', 'B', '--scratchpad', scratchB).code).toBe(0);
    const mB = p.run('merge', 'B', '--scratchpad', scratchB);
    expect(mB.code, mB.out).toBe(1);
    expect(mB.out).toContain('MUST BE RESOLVED BY HAND');
    expect(mB.out).toContain('CONFLICTING FILES for B:');
    expect(mB.out).toContain(`  ${FILE} (also touched by A)`);
    expect(mB.out).toContain('git merge --abort');
    expect(p.taskOf('B')?.status).not.toBe('done');
    const B = p.taskOf('B') as unknown as { merge_conflict?: { files: { file: string; tasks: string[] }[] } };
    expect(B.merge_conflict?.files).toEqual([{ file: FILE, tasks: ['A'], commits: [] }]);
    // Nothing of B is committed: main is still A's merge, and A's line is what main holds.
    expect(p.g(['rev-parse', 'main'])).toBe(tipA);
    expect(p.g(['show', `main:${FILE}`])).toBe('from the track');

    // The documented way out, then the fix round: its brief carries the conflicting file and the other task.
    p.g(['merge', '--abort']);
    const r = p.run('resume', 'B', '--reason', 'fix', '--scratchpad', scratchB);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('RESUME B-r1 (fix)');
    const brief = fs.readFileSync(path.join(scratchB, 'prompt-B-r1.md'), 'utf8');
    expect(brief).toContain('The merge into main CONFLICTED');
    expect(brief).toContain(`- ${FILE} (also touched by A)`);
    // B's own work is still on its branch, for the fix round to build on.
    expect(p.g(['show', `queue/B:${FILE}`])).toBe('export const value = 2; // from B');

    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A', 'queue/B'], files: [FILE], done: ['A'] });
  }, 240_000);
});
