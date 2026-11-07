// =============================================================
// redteam/rt01-uncommitted-work.test.ts: RT-01 "my uncommitted work survives a whole task" (plans/redteam-plan.md, R1).
//
// Why: the first thing a user asks is whether the queue touches what they have not committed. A local track runs the
// whole way (agent worktree, commit, receive, merge) while the user has a changed file, an untracked file, a stash and a
// side branch in the main checkout, and keeps editing during the track. The final check (redteam/lab.ts) then says
// whether anything of theirs changed. The second case is the hard one: the user has their own, uncommitted version of
// the very file the track delivers. The merge must stop and keep the user's version, never overwrite it.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project } from './project';

const LOCAL = { untracked: ['.claude/'], branches: ['queue/A'] };

describe('RT-01: my uncommitted work survives a whole task', () => {
  it('a local track is received and merged; only its file lands, and the user\'s changes are as they were', () => {
    const p = project();
    userMess(p.repo);
    const scratch = p.localDelivers('A');
    // The user goes on working while the track runs: one more edit, in a file the track does not own.
    fs.appendFileSync(path.join(p.repo, 'README.md'), 'written while the track ran\n');
    const before = snapshot(p.repo, p.folder);

    const r = p.run('receive', 'A', '--scratchpad', scratch);
    expect(r.code, r.out).toBe(0);
    const m = p.run('merge', 'A', '--scratchpad', scratch);
    expect(m.code, m.out).toBe(0);
    expect(p.g(['show', 'main:lib/A.ts'])).toBe('from the track');
    expect(p.taskOf('A')?.status).toBe('done');

    expectUserThingsIntact(before, { ...LOCAL, files: ['lib/A.ts'], done: ['A'] });
  }, 240_000);

  it('the user has their own uncommitted version of the track\'s file: the merge stops and keeps it', () => {
    const p = project();
    userMess(p.repo);
    const scratch = p.localDelivers('A');
    fs.mkdirSync(path.join(p.repo, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, 'lib', 'A.ts'), 'the user\'s own draft\n');
    const before = snapshot(p.repo, p.folder);

    expect(p.run('receive', 'A', '--scratchpad', scratch).code).toBe(0);
    const m = p.run('merge', 'A', '--scratchpad', scratch);
    expect(m.code).not.toBe(0);
    // Stopped before git merge: its own save and restore rewrote the user's other files (core.autocrlf).
    expect(m.out).toMatch(/uncommitted work in this checkout: lib\/A\.ts \(untracked\).*\n.*Nothing was touched/);
    expect(fs.readFileSync(path.join(p.repo, 'lib', 'A.ts'), 'utf8')).toBe('the user\'s own draft\n');
    expect(p.taskOf('A')?.status).not.toBe('done');

    expectUserThingsIntact(before, LOCAL);
  }, 240_000);
});
