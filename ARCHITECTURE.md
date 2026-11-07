# Architecture

This document explains why Ravenseat is built the way it is, what each choice costs, and where its guarantees stop. The
README says what it does. This is for a reader who wants to judge the engineering.

Every claim about behaviour names the file that backs it. Paths are relative to `plugin/scripts/orchestrator/` unless they
start with `plugin/` or are at the repo root.

## 1. A file-based queue

**What was chosen.** The queue is one JSON file, `queue.json`, in a data folder inside the project
(`lib/queueConfig.js`, `dataFolder`; `QUEUE_FOLDER` overrides it). Next to it sit other small files: the plan register,
the gate evidence store (`gate-evidence.json`), the base health (`base-health.json`), the merge lock and one merge state
file per running merge. The CLI is synchronous Node with no server process (`cli/context.mjs`).

**Why.** The users are one owner and the agents that work on that owner's machine. A file needs no install, no running
service and no credentials. It can be read with any editor, diffed, and copied as a backup. Claude Code agents already
work with files and git, so the queue uses the same tools.

**What it costs.** Everything a database gives for free has to be built by hand: mutual exclusion (section 2), atomic
writes, a previous good copy, and recovery from a broken file. Each of these has had real bugs (section 7). Every command
reads and parses the whole file, so cost grows with the size of the queue.

**When it stops being right.** When more than one machine writes the same data folder. The lock can only ask whether a
holder is alive on its own host; for another host it falls back to an age rule (section 2), and `cli/context.mjs`
(`stopIfLockLost`) says directly that a data folder shared across machines would need a lease or a real database. It also
stops being right with many writers at once, since all writers take turns on one lock.

## 2. Locking and atomic writes

**The lock.** `lib/queueLock.js` owns the queue lock, a folder `<dataFolder>/.lockState`. `mkdir` is exclusive, and inside
it the holder writes a token file `owner-<generation>.json` with pid, host name, start time and a random nonce, created
with the `wx` flag so only one process can create a given name. A process holds the lock when the file with its
generation holds its nonce (`isHeld`). Every write and every release checks that first.

**Takeover.** The rule is a pure function, `assessLock`:

- same host, pid gone: take over at once;
- same host, pid alive: never take over, whatever the age;
- other host, or no readable owner: take over when older than 60 s (`STALE_AGE_MS`);
- an empty folder: take over after 2 s (`EMPTY_AGE_MS`).

Taking over means creating the next generation's token with `wx`, then listing the folder and checking that nothing
changed since the decision (`placeToken`). The file's own header explains why a rename is not used to decide a winner:
on Windows, two processes renaming the same file to different names can both succeed. Waiting is bounded at 15 s
(`WAIT_MS`), and the error names the holder and points to `ravenseat unlock`.

**Atomic writes and `.prev`.** `lib/stateFile.js` (`writeState`) writes `queue.json` to a temporary file and renames it
over the old one. Before that, `keepPrevious` copies the current file to `queue.json.prev`, but only when it parses, so a
broken file never overwrites the last good copy. On Windows a rename over a file someone has open can fail for a moment
with `EPERM`, `EBUSY` or `EACCES`; `renameWithRetry` retries those with a growing wait and throws anything else.

**Corrupt state.** When `queue.json` does not parse, `read()` in `cli/context.mjs` stops the command with the parse error
and, when `queue.json.prev` parses, the way to restore it (`recoveryHint`). The queue never restores the copy by itself:
the copy is one write older, and the owner should look first. Tested in `lib/__tests__/queueStateSafety.test.ts` and
`__tests__/queueFaultInjection.test.ts` ("queue.json cut off in the middle of a write").

**Where it stops.** The header of `lib/queueLock.js` lists what no lock file can settle:

- A reused pid reads as alive. That errs on the safe side: the lock is not taken, and the owner runs `ravenseat unlock`.
- One host name with separate pid spaces (WSL next to Windows on one folder, containers with the same host name): a live
  holder reads as dead and the lock is taken. Do not share a data folder across those.
- A holder on another host that pauses longer than 60 s can lose the lock by age and then publish anyway, in the gap
  between its last check and the rename. `stopIfLockLost` makes the gap small; it cannot close it.

`docs/orchestration.md` ("What happens when it is cut off") also says two cases are not covered: a kill while a lock file
is being written, and a disk that fails in the middle of a rename.

## 3. One merger

**What was chosen.** Only the orchestrator merges, one merge at a time per data folder. Tracks never merge or push. A
merge is several steps in a row: the git merge with automatic resolution of common conflicts (`merge-track.mjs`), the
migration push when configured, the quick gates on the new tip, the base gate, `done`, and `fill` (`cli/merge.mjs`).

**Why serial.** Each track's gates ran on its own branch. Two tracks can each be green and still break the base together,
for example when one renames a function and the other adds a call to the old name (`docs/orchestration.md`, "The base
gate"). Merging one at a time and running the gates on each new tip finds which merge broke it. A red base refuses
further merges (`lib/baseHealth.js`, `cli/baseHealth.mjs`).

**The merge lock and merge state.** `lib/mergeLock.js` has a separate lock file, `merge.lock`, created with `wx`, held for
the whole merge. A lock is stale when its pid is gone on the same host, or after 6 hours on any host (`MAX_AGE_MS`), since
gates and migrations can run long. Each step is written to `merge-state-<id>.json` as it starts and ends.
`ravenseat merge <id> --resume` reads it and runs only the steps that are left. The file header names the three failures
this fixed: a merge left in place from an earlier conflict that made the next merge commit the wrong work and mark the
wrong task done; a crash after the merge but before `done` with nothing to continue from; and two merges on top of each
other. Since then a merge refuses to start while git has a merge, rebase, cherry-pick or revert in progress
(`gitInProgress`), and a task is only marked done when its tip is in the base (`cli/merge.mjs`).

**What it costs.** Throughput. Merges wait for each other and for the gates. The 0.8.26 changelog names one more cost:
`ravenseat merge` holds the merge lock while it waits for a slot in the machine-wide gate queue, so other merges in the
project are refused for that time.

Tested in `__tests__/queueMergeResume.test.ts` and `__tests__/queueFaultInjection.test.ts` ("ravenseat merge killed
without warning", "two merges at the same time (real processes)", "a real conflict in the middle of a merge").

## 4. Evidence bound to a sha

**The problem.** A track writes its own `RESULT` line, including `gates=OK`. The time log is a plain file every agent can
append to. Both come from the agent whose work is being judged. `lib/gateEvidence.js` explains that `ravenseat receive`
used to trust them, and that a track could then claim a green gate it never ran.

**What was chosen.** Decisions read only the gate evidence store, `gate-evidence.json`. An entry counts as evidence for a
commit only when all of these hold (`lib/gateEvidence.js`, header and `latest`):

- it was written by `gates.mjs` run from the orchestrator's side (`receive` and `merge` pass `--evidence`; a run in the
  main checkout records by default; a run in a track's worktree never records);
- `writer` is `"orchestrator"`, written by `gates.mjs` itself after the gate commands have exited;
- `sha` is HEAD at the start, and HEAD did not move during the run;
- `clean` is true: no uncommitted tracked changes at the start;
- it ran every command the caller needs;
- its `setup_hash` matches the current gate setup when the caller asks, so a changed gate setup needs a new run.

The newest entry for a sha and kind decides, so a later red run beats an earlier green one. The store is append-only and
capped at 200 entries. `gates.mjs` compares the store's text before and after the run; if it changed, the store is put back
and the run is recorded as red with `tampered: true` (`recordRun`). `receive` reuses a green entry for the exact tip, or
runs the quick gates itself on the tip and refuses when the checkout is not at that tip (`cli/merge.mjs`).

**Where it stops.** The agents run as the same OS user as the orchestrator. `lib/gateEvidence.js` says so in plain
words: the store is a guard against claims and casual forgery, not a security boundary against a hostile process. A
process that writes after `gates.mjs` has exited is not caught. The `runner` field is only `"local-worktree"` today, so the
commands can read more than the commit (shared links, untracked and ignored files); those are recorded, and they do not
decide anything yet. The same sha can give a different result.

## 5. What Claude Code hooks can and cannot enforce

The hooks are in `plugin/hooks/hooks.json`. They decide only on what Claude Code shows them: the tool name and its input.

**Where a hook really stops something.** A `PreToolUse` deny blocks the tool call before it runs.

- `hook-write-guard.mjs` (`lib/writeGuard.js`) denies a queue agent a Write, Edit or NotebookEdit on the evidence store,
  and on `queue.json`, `base-health.json` and `git-surface.json` in the data folder. For those tools on those paths the
  block is real.
- `hook-push-guard.mjs` (`lib/pushGuard.js`) denies forced pushes and pushes of other branches, denies queue agents a
  command that names the evidence store or passes `--evidence` or `--cwd` to the gate runner, and asks before a base push
  with no green full-gate evidence, a secret hit, or a `deployCommands` match.
- `hook-track-end.mjs` blocks a track from stopping with no own commits and no end line, once per agent.

**Where it only helps.** The command guard reads a command string. `plugin/docs/guide.md` ("Guarantees and limits")
lists what it cannot read: the contents of a script an agent runs (`bash x.sh`, an `npm run` script), and commands built
from string pieces inside an interpreter. A blocked command can often be written another way. The write guard covers the
file tools, not a Bash redirect. Every hook fails open on an internal error (the headers of `hook-push-guard.mjs` and
`hook-write-guard.mjs`), because a bug in a guard must not stop normal work. And a hook only runs while the plugin loads:
the 0.8.24 changelog warns that after the rename an old `cq` install failed to load, and its hooks, the push guard among
them, were off.

So the hooks are guard rails against mistakes and against an agent that follows a bad instruction. A real boundary needs
Claude Code's permission rules or sandbox, a separate OS user, or branch protection on the remote. The guide says this
too, and keeps a table of what Ravenseat checks next to what needs a boundary outside it.

## 6. Cloud tracks

Cloud sessions are off by default (`features.cloud`). Only the work of a track moves: writing code and running tests on a
branch. `lib/logic/cloud.js` (`cloudSuitable`) lets a task go only when it is class K or U, has no migrations, owns no DB
functions or shared patch, needs nothing marked local (database, network, local files, a device), points to no files the
cloud cannot see, and its owned files have no local changes that are not pushed. At most 3 cloud sessions run at once
(`CLOUD_MAX`).

Receive and merge stay at home. The cloud session only pushes a queue branch. `ravenseat cloud done <id>`
(`cli/cloud.mjs`) fetches that branch, and `cloudDone` moves the task to review like any other delivery. The gates then
run again at home, so the evidence of section 4 is still made by the orchestrator, on the home machine, bound to the
fetched sha. The cloud's own test runs count for no more than a local track's own report. The cost: the cloud only sees
what is pushed (`plugin/docs/guide.md`, "Cloud sessions"), and a task that needs a database or local files cannot go.

## 7. Failure modes and trust boundaries

**Concurrent changes.** Every change to `queue.json` runs under the lock (`edit` and `withLock` in `cli/context.mjs`).
Callers that previewed the queue can pass `--expect-changed`; under the lock the command refuses with exit 6 when the
queue changed since (`checkExpect`). `read()` does not take the lock; the rename means they see the old file or the new one,
never half of one.

**Corrupt state.** See section 2. A temporary file left by a write cut off in the middle changes nothing, and a broken
`queue.json` stops every command, including a merge, before anything happens (`__tests__/queueFaultInjection.test.ts`).

**An interrupted merge.** See section 3. The orchestration guide has a table of each kind of cut-off, what it leaves and
what to do, backed by tests that kill the real process (`docs/orchestration.md`, "What happens when it is cut off").

**What agents can reach.** An agent runs with the owner's account. It can read the files and environment variables the
owner's shell can, and reach the network, unless Claude Code's permissions or sandbox say otherwise
(`plugin/docs/guide.md`). Queue agents cannot push, and may run only allow-listed queue commands (`lib/pushGuard.js`,
`lib/trackGuard.js`). The secret scan finds known patterns, not every secret. Deleted tests and skip markers only warn at
receive (`lib/testWeakening.js`), because a skip can be intended; for a class K task with no reviewer agent, the owner
reads that line.

**Real findings, their fixes and their tests.**

| What went wrong | Fix | What keeps it from coming back |
| --- | --- | --- |
| 0.8.28: on Windows a release could fail to remove the lock folder. The empty folder made other commands wait and give up although nobody held the lock. | An empty lock folder is taken after 2 s, by creating `owner-1.json` with `wx`, so a holder paused between `mkdir` and its token finds its name taken (`lib/queueLock.js`). | `lib/__tests__/queueLock.test.ts`, "an empty lock folder" |
| The lock used to be a bare folder deleted after 60 s. A slow holder lost the lock without knowing, published, and then removed the new holder's lock. | Token with nonce, `isHeld` before every write and release, and a live holder on the same host is never taken over (`lib/queueLock.js`, `cli/context.mjs`). | `lib/__tests__/queueLock.test.ts` |
| A merge left in place made the next merge commit the wrong work; a crash before `done` left nothing to resume; two merges ran on top of each other. | `gitInProgress`, tip-in-base check before `done`, `merge.lock`, merge state and `--resume` (`lib/mergeLock.js`, `cli/merge.mjs`). | `__tests__/queueMergeResume.test.ts`, `__tests__/queueFaultInjection.test.ts` |
| `receive` trusted the track's own `gates=OK`. | The evidence store and its rules (`lib/gateEvidence.js`). | `lib/__tests__/gateEvidence.test.ts`, `__tests__/queueGateEvidence.test.ts` |
| A rename of `queue.json` on Windows failed when another process had it open, after the change was made in memory. | `renameWithRetry` (`lib/stateFile.js`). | `lib/__tests__/queueStateSafety.test.ts` |
| 0.8.9: the docs promised more than the code did. They described deleted tests and skip markers as a merge stop, the secret scan without its gaps, and a quarantine rule as a control. | The docs were changed to match the code: a warning at receive, the scan's gaps listed (first push, size, timeout, fail open), the quarantine rule called a recommended pattern. | The behaviour the docs now describe is tested in `lib/__tests__/testWeakening.test.ts` and `lib/__tests__/secretScan.test.ts`. No test checks the docs against the code; a reviewer has to. |
| 0.8.23: the push guard could be bypassed with quotes or a backslash inside a word (`g"i"t`) and brace lists. | The guard reads them now. The changelog adds that it is still no security boundary. | `lib/__tests__/shellCommands.test.ts` |

The 0.8.9 row is the one to take seriously. The code was fine; the promise was wrong. A reader who trusted the docs would
have believed in a merge stop that did not exist. Section 5 and `plugin/docs/guide.md` now state the limits next to the
guarantees for that reason.

## 8. How this was built

Claude, through Claude Code, wrote much of the code. The owner chose the problems and the
architecture, set the requirements, reviewed the changes, measured cost and behaviour, and debugged what broke.

That has a consequence a reader should know. Code written by an agent tends to look complete, and the claims around it can
run ahead of what it does. Release 0.8.9 shows what that looks like: docs that promised more than the code did. That is part of why the design does not take an agent's word for
anything that decides a merge (section 4), and why this document names a file for every claim.
