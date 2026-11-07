// =============================================================
// redteam/flows.test.ts: the final check applied to real flows (plans/redteam-plan.md, bolk R0).
//
// Why: the lab is only worth something when it runs after the commands a user actually runs. Three flows, all on a repo
// with the user's mess (a changed file, an untracked file, a stash, a side branch):
//   1. a cloud track comes home and is merged: only its file may land, its branches may go, it may become done;
//   2. a cloud track comes home with red gates: nothing may land at all;
//   3. the user has a staged change when the merge runs: the merge stops and the staging is left alone.
// The cloud session is simulated with a pushed branch (redteam/project.ts). No real claude.
// =============================================================
import { describe, it, expect } from 'vitest';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, queueSpace } from './project';

describe('flow 1: a cloud track comes home and is merged, on a repo with the user\'s mess', () => {
  it('only the track\'s file lands, A becomes done, and everything of the user\'s is as it was', () => {
    const p = project();
    p.cloudDelivers('A');
    userMess(p.repo);
    const before = snapshot(p.repo, p.folder);

    expect(p.run('cloud', 'collect').out).toMatch(/Gates GREEN/);
    const m = p.merge('A');
    expect(m.code, m.out).toBe(0);
    // The flow did something: the track's file is on main (a green check on a flow that did nothing proves nothing).
    expect(p.g(['show', 'main:lib/A.ts'])).toBe('from the cloud');

    expectUserThingsIntact(before, {
      ...queueSpace(),
      files: ['lib/A.ts'],
      done: ['A'],
      // The merge removes the cloud branch from the remote (cloud.deleteBranch, on by default).
      remoteRefs: ['refs/heads/claude/A'],
    });
  }, 240_000);
});

describe('flow 2: a cloud track comes home with red gates', () => {
  it('nothing lands, nothing becomes done, and everything of the user\'s is as it was', () => {
    const p = project({ gates: ['node -e "process.exit(1)"'] });
    p.cloudDelivers('A');
    userMess(p.repo);
    const before = snapshot(p.repo, p.folder);

    expect(p.run('cloud', 'collect').code).toBe(1);
    expectUserThingsIntact(before, queueSpace());
  }, 180_000);
});

describe('flow 3: the user has a staged change when the merge runs', () => {
  // git merge refuses to merge on top of staged changes. The merge must stop there and leave the staging as it was:
  // nothing lands, A is not done, and the user's index is never reset to make room.
  it('the merge stops, and the staging and everything else of the user\'s is as it was', () => {
    const p = project();
    p.cloudDelivers('A');
    userMess(p.repo, { staged: true });
    const before = snapshot(p.repo, p.folder);

    expect(p.run('cloud', 'collect').out).toMatch(/Gates GREEN/);
    const m = p.merge('A');
    expect(m.code).not.toBe(0);
    expect(m.out).toMatch(/STOP in the step merge/);
    // Stopped before git merge ran: with core.autocrlf, git's own save and restore rewrote the user's files.
    expect(m.out).toMatch(/staged changes that are not committed: staged\.txt.*\n.*Nothing was touched/);
    expectUserThingsIntact(before, queueSpace());
  }, 240_000);
});
