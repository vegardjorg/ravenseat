// =============================================================
// undoMerge.test.ts: the rules of lib/undoMerge.js (GS-3, `ravenseat undo <id>`) without a repo: reading base's
// first-parent log, finding the task's merge commit (merge_commit first, then the merge log), the later tasks that touch
// the same files or depend on it, the refusals, the plan text, the commit message and the task set back to waiting.
// The flow against temporary repos is in __tests__/queueUndoMerge.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UM = require('../undoMerge.js');

const S = (n: number) => String(n).repeat(40).slice(0, 40);
// Newest first, as `git log --first-parent` prints it.
const LOG = [
  `${S(5)}\x1f${S(4)} ${S(9)}\x1fMerge branch 'queue/C-1' into develop`,
  `${S(4)}\x1f${S(3)}\x1fa commit by hand`,
  `${S(3)}\x1f${S(2)} ${S(8)}\x1fMerge branch 'queue/B-1' into develop`,
  `${S(2)}\x1f${S(1)} ${S(7)}\x1fMerge branch 'queue/A-1' into develop`,
  `${S(1)}\x1f\x1fstart`,
].join('\n');

describe('parseLog', () => {
  it('reads sha, parents and subject per line, newest first', () => {
    const rows = UM.parseLog(LOG);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ sha: S(5), parents: [S(4), S(9)], subject: "Merge branch 'queue/C-1' into develop" });
    expect(rows[4].parents).toEqual([]);
  });
  it('an empty or missing log is no rows', () => {
    expect(UM.parseLog('')).toEqual([]);
    expect(UM.parseLog(null)).toEqual([]);
  });
});

describe('findMerge', () => {
  const rows = UM.parseLog(LOG);
  it('the merge_commit on the task wins', () => {
    expect(UM.findMerge({ id: 'A-1', recorded: S(2), rows, prefix: 'queue/' })).toEqual({ sha: S(2), source: 'merge_commit', index: 3 });
  });
  it('without merge_commit: the newest merge of the task in the merge log', () => {
    expect(UM.findMerge({ id: 'B-1', recorded: null, rows, prefix: 'queue/' })).toEqual({ sha: S(3), source: 'merge log', index: 2 });
  });
  it('a recorded commit that is not on the line keeps index -1 (the caller refuses)', () => {
    expect(UM.findMerge({ id: 'A-1', recorded: S(6), rows, prefix: 'queue/' })).toEqual({ sha: S(6), source: 'merge_commit', index: -1 });
  });
  it('nothing found: null', () => {
    expect(UM.findMerge({ id: 'Z-9', recorded: null, rows, prefix: 'queue/' })).toBeNull();
  });
  it('a task id is not matched as a prefix of another one', () => {
    expect(UM.findMerge({ id: 'A', recorded: null, rows, prefix: 'queue/' })).toBeNull();
  });
});

describe('laterWork', () => {
  const rows = UM.parseLog(LOG);
  const files: Record<string, string[]> = { [S(3)]: ['lib/b.js'], [S(4)]: ['lib/a.js', 'x.md'], [S(5)]: ['lib/c.js'] };
  const filesOf = (row: { sha: string }) => files[row.sha] ?? [];
  it('lists later tasks that share a file or depend on it, and hand commits that share a file, oldest first', () => {
    const tasks = [{ id: 'A-1' }, { id: 'B-1' }, { id: 'C-1', depends_on: ['A-1'] }];
    const w = UM.laterWork({ rows, index: 3, id: 'A-1', prefix: 'queue/', filesOf, ownFiles: ['lib/a.js', 'lib/b.js'], tasks });
    expect(w.tasks).toEqual([
      { id: 'B-1', sha: S(3), shared: ['lib/b.js'], dependsOn: false },
      { id: 'C-1', sha: S(5), shared: [], dependsOn: true },
    ]);
    expect(w.commits).toEqual([{ sha: S(4), subject: 'a commit by hand', shared: ['lib/a.js'] }]);
  });
  it('later work that shares nothing is left out', () => {
    const w = UM.laterWork({ rows, index: 3, id: 'A-1', prefix: 'queue/', filesOf, ownFiles: ['other.js'], tasks: [] });
    expect(w).toEqual({ tasks: [], commits: [] });
  });
});

describe('waitingOn', () => {
  it('the tasks not done or cancelled that depend on it', () => {
    const tasks = [
      { id: 'X', status: 'waiting', depends_on: ['A-1'] },
      { id: 'Y', status: 'done', depends_on: ['A-1'] },
      { id: 'Z', status: 'cancelled', depends_on: ['A-1'] },
      { id: 'W', status: 'waiting' },
    ];
    expect(UM.waitingOn(tasks, 'A-1').map((t: { id: string }) => t.id)).toEqual(['X']);
  });
});

describe('refusal', () => {
  const ok = {
    id: 'A-1', base: 'develop', root: '/repo', ravenseat: 'ravenseat',
    inTrack: null, inWorktree: false, head: 'develop', dirty: [], inProgress: [], cutOff: false,
    status: 'done', found: { sha: S(2), source: 'merge_commit', index: 3 }, inBase: true, parents: 2, alreadyUndone: null,
  };
  it('null when everything is in order', () => {
    expect(UM.refusal(ok)).toBeNull();
  });
  it.each([
    [{ inTrack: 'B-2' }, /track/],
    [{ inWorktree: true }, /main checkout/],
    [{ head: 'feature' }, /on feature, not develop/],
    [{ dirty: ['lib/a.js'] }, /uncommitted.*lib\/a\.js/],
    [{ inProgress: [{ kind: 'merge', undo: 'git merge --abort' }] }, /merge is in progress.*git merge --abort/],
    [{ cutOff: true }, /merge A-1 --resume/],
    [{ status: 'waiting' }, /status waiting/],
    [{ found: null }, /no merge commit/],
    [{ inBase: false }, /not in develop/],
    [{ found: { sha: S(2), source: 'merge_commit', index: -1 } }, /first-parent/],
    [{ parents: 1 }, /not a merge commit/],
    [{ alreadyUndone: S(9) }, /already undone/],
  ])('refuses: %o', (change, text) => {
    const r = UM.refusal({ ...ok, ...change });
    expect(r).toMatch(text);
    expect(r).toMatch(/Nothing was done/);
  });
  it('a task in review can be undone (a partial merge)', () => {
    expect(UM.refusal({ ...ok, status: 'review' })).toBeNull();
  });
});

describe('the texts', () => {
  const later = { tasks: [{ id: 'B-1', sha: S(3), shared: ['lib/b.js'], dependsOn: false }], commits: [{ sha: S(4), subject: 'by hand', shared: ['lib/a.js'] }] };
  it('the plan names the merge, the later work, the waiting tasks and what happens', () => {
    const text = UM.planLines({
      id: 'A-1', sha: S(2), subject: "Merge branch 'queue/A-1' into develop", source: 'merge log', base: 'develop', files: ['lib/a.js'],
      later, waiting: [{ id: 'X' }], baseGate: true,
    }).join('\n');
    expect(text).toMatch(/A-1/);
    expect(text).toMatch(/22222222/);
    expect(text).toMatch(/merge log/);
    expect(text).toMatch(/B-1.*lib\/b\.js/);
    expect(text).toMatch(/by hand.*lib\/a\.js/);
    expect(text).toMatch(/X/);
    expect(text).toMatch(/git revert -m 1/);
    expect(text).toMatch(/waiting/);
    expect(text).toMatch(/base gate/);
    expect(text).toMatch(/never pushed/i);
  });
  it('the plan says when nothing later touches it', () => {
    const text = UM.planLines({ id: 'A-1', sha: S(2), subject: 's', source: 'merge_commit', base: 'develop', files: [], later: { tasks: [], commits: [] }, waiting: [], baseGate: false }).join('\n');
    expect(text).toMatch(/nothing merged after it touches the same files/i);
  });
  it('the commit message names the task and the merge and carries the queue trailer', () => {
    const m = UM.commitMessage({ id: 'A-1', sha: S(2), subject: "Merge branch 'queue/A-1' into develop" });
    expect(m.split('\n')[0]).toBe(`Undo A-1: revert merge ${S(2).slice(0, 12)}`);
    expect(m).toMatch(/git revert -m 1/);
    expect(m).toMatch(/\nQueue: orchestrator$/);
  });
  it('the conflict text says the revert was aborted and how to do it by hand', () => {
    const text = UM.conflictLines({ id: 'A-1', sha: S(2), files: ['lib/a.js'], root: '/repo', aborted: true }).join('\n');
    expect(text).toMatch(/conflict/i);
    expect(text).toMatch(/lib\/a\.js/);
    expect(text).toMatch(/git revert --abort/);
    expect(text).toMatch(new RegExp(`git revert -m 1 ${S(2)}`));
    expect(text).toMatch(/Nothing was changed/);
  });
});

describe('reopen', () => {
  it('sets the task back to waiting, drops the merge fields and keeps a note and the undo record', () => {
    const t: Record<string, unknown> = {
      id: 'A-1', status: 'done', merge_commit: S(2), done: '2026-11-01T00:00:00Z', delivered: '2026-11-01T00:00:00Z',
      verification: { sha: S(2) }, qa_status: 'waiting', remarks: ['old'],
    };
    UM.reopen(t, { at: '2026-11-22T00:00:00.000Z', merge: S(2), revert: S(9), by: 'ravenseat' });
    expect(t.status).toBe('waiting');
    expect(t.merge_commit).toBeUndefined();
    expect(t.done).toBeUndefined();
    expect(t.delivered).toBeUndefined();
    expect(t.verification).toBeUndefined();
    expect(t.qa_status).toBeUndefined();
    expect(t.undone).toEqual([{ merge_commit: S(2), revert_commit: S(9), at: '2026-11-22T00:00:00.000Z', by: 'ravenseat' }]);
    const remarks = t.remarks as string[];
    expect(remarks[0]).toBe('old');
    expect(remarks[1]).toMatch(/undone/);
    expect(remarks[1]).toMatch(new RegExp(`git revert ${S(9).slice(0, 12)}`));
  });
  it('alreadyUndone finds an earlier undo of the same merge', () => {
    expect(UM.alreadyUndone({ undone: [{ merge_commit: S(2), revert_commit: S(9) }] }, S(2))).toBe(S(9));
    expect(UM.alreadyUndone({}, S(2))).toBeNull();
  });
});
