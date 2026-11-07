// =============================================================
// redteam/lab.ts: the shared final check for the red team scenarios (plans/redteam-plan.md, bolk R0).
//
// Why: the question a user asks is not "did the command exit 0" but "did it leave my things alone". Every scenario
// takes a snapshot of the user's things before it runs, and the same check after it. One check, so a new scenario
// cannot forget a part of it.
//
// The check is an allowed-change model, not "everything is identical": a task that succeeds is supposed to change the
// repo. What the scenario allows is said out loud (`allow`); everything else must be as it was:
//   - the user's uncommitted work: every dirty and untracked file has the same content, staged changes are the same;
//   - the branch the user is on, and every other local branch, unless allowed to move;
//   - history: the new HEAD continues the old one (never rewritten), and only allowed files changed in between;
//   - the stash, the remote refs, and no merge, rebase or cherry-pick left half done;
//   - the queue: queue.json parses, every task is there exactly once (none lost, none doubled), a task is done only
//     when it was before or the scenario allows it, and a task is merged at most once;
//   - locks: a lock may be held (a scenario can leave a live process), but never by a process that is gone.
//
// Read only: snapshot and check run git commands that never write (no write-tree, no stash create).
// Tested in redteam/lab.test.ts, which proves that each part goes red when its rule is broken.
// =============================================================
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

const require = createRequire(import.meta.url);
const QL = require('../../lib/queueLock.js') as {
  readState: (dir: string) => { tokens: { name: string; owner: { pid?: number; hostname?: string } | null }[] } | null;
  pidAlive: (pid: number) => boolean;
};

/** What a scenario is allowed to change. Everything left out must be as it was. */
export type Allow = {
  /** Paths (a trailing "/" means a folder) that may change between the old and the new HEAD. */
  files?: string[];
  /** Task ids that may become done. */
  done?: string[];
  /** Local branches that may move, appear or disappear (the current branch may always move forward). */
  branches?: string[];
  /** Remote refs (refs/heads/x) that may change or go away. */
  remoteRefs?: string[];
  /** Task ids that may be added to the queue. */
  added?: string[];
  /** Untracked paths (a trailing "/" means a folder) that are the queue's own, such as its worktrees: they may appear and go. */
  untracked?: string[];
};

export type Snapshot = {
  repo: string;
  folder: string;
  head: string;
  branch: string | null;
  dirty: Map<string, string>; // path -> content hash ("<gone>" for a deleted file)
  staged: string;
  stash: string[];
  branches: Map<string, string>;
  remote: Map<string, string> | null;
  inProgress: string[];
  tasks: Map<string, string>; // id -> status
};

const git = (repo: string, args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (repo: string, args: string[]) => {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
};
const hash = (file: string) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '<gone>';
  }
};

/** The paths git reports as changed or untracked (porcelain -z, renames give the new path). */
function dirtyPaths(repo: string): string[] {
  const out = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    paths.push(parts[i].slice(3));
    if (code.startsWith('R') || code.startsWith('C')) i++; // the old path of a rename follows
  }
  return paths;
}

const refs = (out: string | null) =>
  out == null
    ? null
    : new Map(
        out
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [sha, ref] = l.split(/\s+/);
            return [ref, sha] as [string, string];
          }),
      );

function inProgress(repo: string): string[] {
  const gitDir = path.resolve(repo, git(repo, ['rev-parse', '--git-dir']).trim());
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].filter((n) =>
    fs.existsSync(path.join(gitDir, n)),
  );
}

type QueueRead = { error: string } | { tasks: { id: string; status: string }[] };
function readQueue(folder: string): QueueRead {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
    if (!Array.isArray(q?.tasks)) return { error: 'queue.json has no tasks list' };
    return { tasks: q.tasks };
  } catch (e) {
    return { error: `queue.json does not parse: ${(e as Error).message}` };
  }
}

/** The user's things as they are now. `folder` is the queue's data folder (QUEUE_FOLDER). */
export function snapshot(repo: string, folder: string): Snapshot {
  const q = readQueue(folder);
  if ('error' in q) throw new Error(`snapshot: ${q.error}`);
  return {
    repo,
    folder,
    head: git(repo, ['rev-parse', 'HEAD']).trim(),
    branch: tryGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])?.trim() || null,
    dirty: new Map(dirtyPaths(repo).map((p) => [p, hash(path.join(repo, p))])),
    staged: git(repo, ['diff', '--cached', '--binary']),
    stash: git(repo, ['stash', 'list', '--format=%H']).split('\n').filter(Boolean),
    branches: refs(git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads']))!,
    remote: tryGit(repo, ['remote', 'get-url', 'origin']) ? refs(tryGit(repo, ['ls-remote', 'origin'])) : null,
    inProgress: inProgress(repo),
    tasks: new Map(q.tasks.map((o) => [o.id, o.status])),
  };
}

const allowed = (list: string[] | undefined, p: string) =>
  (list ?? []).some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));

/**
 * Everything that is not as it should be after a scenario, as readable lines (empty = the user's things are intact).
 * Kept apart from the expect, so the self-test can show that each rule goes red.
 */
export function userThingsProblems(before: Snapshot, allow: Allow = {}): string[] {
  const { repo, folder } = before;
  const out: string[] = [];

  // The user's uncommitted work: the same files dirty, each with the same content, and the same staged changes.
  const dirtyNow = new Set(dirtyPaths(repo));
  for (const [p, h] of before.dirty) {
    // The queue's own space (its worktrees) may come and go; it is never the user's work.
    if (allowed(allow.untracked, p)) continue;
    if (!dirtyNow.has(p)) out.push(`uncommitted file ${p} is no longer uncommitted (committed, reverted or removed)`);
    else if (hash(path.join(repo, p)) !== h) out.push(`uncommitted file ${p} has changed content`);
  }
  for (const p of dirtyNow) if (!before.dirty.has(p) && !allowed(allow.untracked, p)) out.push(`a file the user did not touch is now uncommitted: ${p}`);
  if (git(repo, ['diff', '--cached', '--binary']) !== before.staged) out.push('the staged changes are not the same');

  // The branch, and history as a continuation of the old one, with only allowed files changed.
  const branch = tryGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])?.trim() || null;
  if (branch !== before.branch) out.push(`the user is on ${branch ?? 'a detached HEAD'}, was on ${before.branch ?? 'a detached HEAD'}`);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  if (head !== before.head) {
    if (tryGit(repo, ['merge-base', '--is-ancestor', before.head, head]) == null)
      out.push(`history was rewritten: ${before.head.slice(0, 8)} is no longer in the history of HEAD`);
    else {
      const changed = git(repo, ['diff', '--name-only', '-z', before.head, head]).split('\0').filter(Boolean);
      const extra = changed.filter((p) => !allowed(allow.files, p));
      if (extra.length) out.push(`files changed in history that the scenario does not allow: ${extra.join(', ')}`);
    }
  }
  const branchesNow = refs(git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads']))!;
  const own = new Set(allow.branches ?? []);
  if (before.branch) own.add(before.branch);
  for (const [ref, sha] of before.branches) {
    const name = ref.replace(/^refs\/heads\//, '');
    if (own.has(name)) continue;
    if (!branchesNow.has(ref)) out.push(`branch ${name} is gone`);
    else if (branchesNow.get(ref) !== sha) out.push(`branch ${name} has moved`);
  }
  for (const ref of branchesNow.keys()) {
    const name = ref.replace(/^refs\/heads\//, '');
    if (!before.branches.has(ref) && !own.has(name)) out.push(`a branch the scenario does not allow appeared: ${name}`);
  }

  // The stash, the remote, and nothing left half done.
  const stash = git(repo, ['stash', 'list', '--format=%H']).split('\n').filter(Boolean);
  if (stash.join() !== before.stash.join()) out.push(`the stash changed (${before.stash.length} entries before, ${stash.length} now)`);
  if (before.remote) {
    const remote = refs(tryGit(repo, ['ls-remote', 'origin']));
    if (!remote) out.push('the remote can no longer be read');
    else
      for (const ref of new Set([...before.remote.keys(), ...remote.keys()])) {
        if ((allow.remoteRefs ?? []).includes(ref)) continue;
        if (before.remote.get(ref) !== remote.get(ref))
          out.push(`remote ${ref} ${!remote.has(ref) ? 'is gone' : !before.remote.has(ref) ? 'appeared' : 'moved'}`);
      }
  }
  for (const n of inProgress(repo)) if (!before.inProgress.includes(n)) out.push(`a git operation is left half done: ${n}`);

  // The queue: parses, every task exactly once, done only when allowed, merged at most once.
  const q = readQueue(folder);
  if ('error' in q) out.push(q.error);
  else {
    const seen = new Map<string, number>();
    for (const o of q.tasks) seen.set(o?.id, (seen.get(o?.id) ?? 0) + 1);
    for (const [id, n] of seen) if (n > 1) out.push(`task ${id} is in the queue ${n} times`);
    for (const id of before.tasks.keys()) if (!seen.has(id)) out.push(`task ${id} has disappeared from the queue`);
    for (const id of seen.keys())
      if (!before.tasks.has(id) && !(allow.added ?? []).includes(id)) out.push(`task ${id} appeared in the queue`);
    for (const o of q.tasks)
      if (o?.status === 'done' && before.tasks.get(o.id) !== 'done' && !(allow.done ?? []).includes(o.id))
        out.push(`task ${o.id} became done, which the scenario does not allow`);
    if (head !== before.head) {
      const merges = git(repo, ['log', '--merges', '--format=%B%x00', `${before.head}..${head}`]).split('\0');
      for (const id of seen.keys()) {
        const n = merges.filter((b) => new RegExp(`(^|[^A-Za-z0-9._-])${id.replace(/[.]/g, '\\.')}([^A-Za-z0-9_-]|$)`).test(b)).length;
        if (n > 1) out.push(`task ${id} was merged ${n} times`);
      }
    }
  }

  // Locks: may be held, never by a process that is gone (an orphan blocks every later command until it goes stale).
  const lock = QL.readState(path.join(folder, '.lockState'));
  for (const t of lock?.tokens ?? []) {
    const o = t.owner;
    if (!o || typeof o.pid !== 'number') out.push(`a lock token without an owner is left: ${t.name}`);
    else if (o.hostname === os.hostname() && !QL.pidAlive(o.pid)) out.push(`an orphan lock is left by process ${o.pid}, which is gone`);
  }
  return out;
}

/** The final check: fails the test with every problem listed, so one run shows all of them. */
export function expectUserThingsIntact(before: Snapshot, allow: Allow = {}) {
  expect(userThingsProblems(before, allow), 'the user\'s things after the scenario').toEqual([]);
}

/**
 * Gives a repo the kind of mess a real user has while the queue runs: a changed tracked file, an untracked file, a
 * stash entry and a side branch. `staged` adds a staged change too (git merge refuses a merge on top of one).
 */
export function userMess(repo: string, { staged = false }: { staged?: boolean } = {}) {
  const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'stashed.txt'), 'stash me\n');
  g(['add', '--', 'stashed.txt']);
  g(['stash', 'push', '-q', '-m', 'user stash', '--', 'stashed.txt']);
  g(['branch', 'user-side']);
  fs.appendFileSync(path.join(repo, 'README.md'), 'my own unfinished line\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'my notes, never committed\n');
  if (staged) {
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged by the user\n');
    g(['add', '--', 'staged.txt']);
  }
}
