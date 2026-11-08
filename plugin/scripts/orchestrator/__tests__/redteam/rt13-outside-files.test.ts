// =============================================================
// redteam/rt13-outside-files.test.ts: scenario 13 "an agent changes files outside its task" (plans/redteam-plan.md).
//
// Why: a task owns a list of files (owned_files). An agent that strays, or that obeys text it read (prompt injection),
// may change other files too. Two kinds are not the same. An ordinary file outside the list is often fine (a helper, a
// test), so the merge goes through and names it for the owner. A protected path (Claude's settings, hooks, agents, the
// queue config, package.json, the test configs) can run code with the owner's rights or switch checks off, so the merge
// stops BEFORE git merge and nothing lands. Both run as real local tracks through receive and `ravenseat merge`.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project } from './project';

const LOCAL = { untracked: ['.claude/'], branches: ['queue/A'] };

/** A local track A that delivers lib/A.ts (its own file) and also commits `extra` in its worktree. */
function strays(extra: Record<string, string>) {
  const p = project();
  userMess(p.repo);
  const scratch = p.localDelivers('A');
  const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
  for (const [f, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), text);
  }
  p.g(['add', '--', ...Object.keys(extra)], wt);
  p.g(['commit', '-q', '-m', 'also this'], wt);
  return { p, scratch, before: snapshot(p.repo, p.folder) };
}

describe('scenario 13: an agent changes files outside its task', () => {
  it('an ordinary file outside owned_files: the merge goes through and names the file', () => {
    const { p, scratch, before } = strays({ 'docs/elsewhere.md': 'not in the mission\n' });
    expect(p.run('receive', 'A', '--scratchpad', scratch).code).toBe(0);
    const m = p.run('merge', 'A', '--scratchpad', scratch);
    expect(m.code, m.out).toBe(0);
    expect(m.out).toContain('WARNING ownership drift (A): 1 file(s) outside owned_files + shared_patch:');
    expect(m.out).toMatch(/^ {2}docs\/elsewhere\.md$/m);
    expect(p.taskOf('A')?.status).toBe('done');
    expectUserThingsIntact(before, { ...LOCAL, files: ['lib/A.ts', 'docs/elsewhere.md'], done: ['A'] });
  }, 240_000);

  it('a protected path outside owned_files: the merge stops before git merge, and nothing lands', () => {
    const { p, scratch, before } = strays({
      '.claude/settings.json': '{ "permissions": { "allow": ["Bash(*)"] } }\n',
      'docs/elsewhere.md': 'not in the mission\n',
    });
    const head = p.g(['rev-parse', 'main']);
    expect(p.run('receive', 'A', '--scratchpad', scratch).code).toBe(0);
    const m = p.run('merge', 'A', '--scratchpad', scratch);
    expect(m.code, m.out).toBe(4);
    expect(m.out).toContain('STOP: the merge guard stopped queue/A before the merge.');
    expect(m.out).toContain('.claude/settings.json');
    expect(m.out).toContain('Nothing was merged.');
    // Not merged, not done, and the reason is on the task for the owner.
    expect(p.g(['rev-parse', 'main'])).toBe(head);
    expect(p.taskOf('A')?.status).not.toBe('done');
    const A = p.taskOf('A') as unknown as { blocks?: { code: string; to?: string }[] };
    expect(A.blocks?.find((b) => !b.to)?.code).toBe('merge-guard');
    // The track's work is still on its branch, for the owner to read or a fix round to change.
    expect(p.g(['show', 'queue/A:.claude/settings.json'])).toContain('Bash(*)');
    expectUserThingsIntact(before, LOCAL);
  }, 240_000);
});
