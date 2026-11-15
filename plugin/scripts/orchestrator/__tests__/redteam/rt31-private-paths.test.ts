// =============================================================
// redteam/rt31-private-paths.test.ts: RT-31 "my private folder ends up in git, pushed or merged by a track".
//
// Why: privatePaths names the project's own folders and files that must never reach git (internal notes, a business
// folder). The .gitignore keeps them out of `git add .`, but a forced add, or a track that writes there and commits,
// still tracks them. The push guard and merge read the same list and refuse a range that tracks such a file. An empty
// list (the default) refuses nothing.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task } from './project';
import { push } from './hooks';

function guarded(privatePaths: unknown[] = ['docs/notes/', 'ops/keys.txt']) {
  const p = project({ config: { privatePaths }, tasks: [task('A'), task('B')] });
  const commit = (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(p.repo, f)), { recursive: true });
      fs.writeFileSync(path.join(p.repo, f), text);
    }
    p.g(['add', '-f', '--', ...Object.keys(files)]);
    p.g(['commit', '-q', '-m', 'files']);
  };
  return { p, commit };
}

describe('RT-31: my private folder ends up in git, pushed or merged by a track', () => {
  it('a push of a commit that tracks a file in a private folder, or a private file, is denied', () => {
    const { p, commit } = guarded();
    commit({ 'docs/notes/plan.md': 'x\n' });
    let d = push(p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('docs/notes/plan.md');
    expect(d.reason).toMatch(/privatePaths/);
    const other = guarded();
    other.commit({ 'ops/keys.txt': 'x\n' });
    d = push(other.p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('ops/keys.txt');
  }, 60_000);

  it('a sibling with the same prefix is not private, and an empty list refuses nothing', () => {
    const { p, commit } = guarded();
    commit({ 'docs/notesbook.md': 'x\n' });
    expect(push(p).decision).not.toBe('deny');
    const free = guarded([]);
    free.commit({ 'docs/notes/plan.md': 'x\n' });
    expect(push(free.p).decision).not.toBe('deny');
  }, 60_000);

  it('merge refuses a track that commits into a private folder; ordinary work merges', () => {
    const { p } = guarded();
    p.cloudDelivers('A', 'docs/notes/from-track.md');
    p.run('cloud', 'collect');
    const m = p.merge('A');
    expect(m.code).not.toBe(0);
    expect(m.out).toContain('docs/notes/from-track.md');
    expect(p.g(['ls-tree', '-r', '--name-only', 'main'])).not.toContain('docs/notes/from-track.md');
    p.cloudDelivers('B', 'lib/B.ts');
    p.run('cloud', 'collect');
    const ok = p.merge('B');
    expect(ok.out).not.toContain('privatePaths');
    expect(p.g(['ls-tree', '-r', '--name-only', 'main'])).toContain('lib/B.ts');
  }, 300_000);
});
