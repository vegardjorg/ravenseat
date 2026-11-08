# FAQ: what people worry about before they let agents merge

Ordered by what people fear most. Each answer names the tests that back it, so you can read them or run them
(`npm run redteam`). How the tests are built, their status and the full map are on the [red team page](redteam.md).

### Can Ravenseat break my repo or lose my uncommitted work?

Not in the ways the tests try. Your uncommitted, untracked, staged and stashed work is checked after every red team
scenario, and history may only grow. If you have your own uncommitted version of a file a task changes, or a staged
change, the merge stops before `git merge` runs, names the files and touches nothing. This came out of two real
findings: `git merge` itself had rewritten the user's files with CRLF on Windows before refusing.

**Verified by:** [`rt01-uncommitted-work`](../scripts/orchestrator/__tests__/redteam/rt01-uncommitted-work.test.ts),
[`flows`](../scripts/orchestrator/__tests__/redteam/flows.test.ts) (flow 3),
[`lab`](../scripts/orchestrator/__tests__/redteam/lab.test.ts) (the final check, one red case per rule).

### What happens if it crashes, or I close the laptop, in the middle of a merge?

A merge killed at each step (right after `git merge`, in the gates after it, right after the task is marked done) is
finished by `ravenseat merge <id> --resume`: nothing is merged twice and the task is marked done once. A merge left
in place by git (`MERGE_HEAD`) is refused until you finish it. Commits you make in between are kept. If the
orchestrator session itself dies with no handover, a new one picks up from what is on disk: a dead agent's task is
continued with `resume` (which names any work it left uncommitted), and locks of dead processes are taken over.
Ravenseat does not restart itself, and nothing runs while the machine is off or asleep: the work continues when you
start a Claude Code session again and it picks up the queue.

**Verified by:** [`rt24-cold-restart`](../scripts/orchestrator/__tests__/redteam/rt24-cold-restart.test.ts),
[`queueFaultInjection`](../scripts/orchestrator/__tests__/queueFaultInjection.test.ts),
[`queueMergeResume`](../scripts/orchestrator/__tests__/queueMergeResume.test.ts),
[`rt07-interrupted`](../scripts/orchestrator/__tests__/redteam/rt07-interrupted.test.ts).

### Can an agent fake a green result?

An agent's own "gates=OK" is not believed. The orchestrator runs the gates itself on the delivered commit and records
the result bound to that commit; a gate that writes to the evidence store is red as tampered. Two gate runs at the same
moment once read each other's evidence as tampering; they now take turns.

**Verified by:** [`queueGateEvidence`](../scripts/orchestrator/__tests__/queueGateEvidence.test.ts),
[`flows`](../scripts/orchestrator/__tests__/redteam/flows.test.ts) (flow 2, red gates),
[`rt03-two-sessions`](../scripts/orchestrator/__tests__/redteam/rt03-two-sessions.test.ts).

### Can an agent cheat by weakening the tests?

Partly guarded. Receive warns, and the review package names the file, when a test file is deleted, gets a skip or focus
marker, or loses all its assertions. Changes to test config and other protected paths stop the merge. None of the
warnings stops a merge on its own: a skip can be intended, and the reviewers decide. Removing some assertions while one
remains is not named, because it looks like ordinary tidying.

**Verified by:** [`rt08-weakened-test`](../scripts/orchestrator/__tests__/redteam/rt08-weakened-test.test.ts),
[`testWeakening`](../scripts/orchestrator/lib/__tests__/testWeakening.test.ts),
[`mergeGuard`](../scripts/orchestrator/lib/__tests__/mergeGuard.test.ts).

### Can it push something to my remote that I did not want?

A queue agent is refused every push, not even `main`, through the hooks on Claude Code's Bash and PowerShell tools. That
is a hook-level guard, not a limit set by the operating system (see the last question). From your own session, a forced push and a push of any other branch
than the base are refused, in 17 written forms of a forced push, for both the Bash and the PowerShell tool, through the
hooks as Claude Code runs them.

**Verified by:** [`rt18-push-hook`](../scripts/orchestrator/__tests__/redteam/rt18-push-hook.test.ts),
[`pushGuard`](../scripts/orchestrator/lib/__tests__/pushGuard.test.ts).

### Can two sessions, or two agents, trip over each other?

Two sessions that start, fill, receive or merge the same task at the same moment start it once, merge it once and mark
it done once. One merge runs at a time. Two agents in the same file are allowed; `ravenseat conflicts` predicts the
conflict from the running worktrees, and a real conflict goes to a fix round with its context.

**Verified by:** [`rt03-two-sessions`](../scripts/orchestrator/__tests__/redteam/rt03-two-sessions.test.ts),
[`mergeLock`](../scripts/orchestrator/lib/__tests__/mergeLock.test.ts),
[`queueLock`](../scripts/orchestrator/lib/__tests__/queueLock.test.ts),
[`conflictPredict`](../scripts/orchestrator/lib/__tests__/conflictPredict.test.ts).

### Will one stuck task block everything, or retry forever and burn tokens?

A task that is red in every round gets the fix rounds it is allowed (`maxFixRounds`, three by default), then one question to you. Tasks
that wait on it wait; independent tasks start. A test that hangs is stopped at the time budget, in receive and in the
merge. A track that costs far more than its class usually does, or than its own estimate while the class has no history
yet, is reported to the orchestrator. These limits stop endless retries; they do not cap your token bill. The daily
budget (`ravenseat limit dailyBudget <usd>`) is off by default.

**Verified by:** [`rt06-rt22-permanent-failure`](../scripts/orchestrator/__tests__/redteam/rt06-rt22-permanent-failure.test.ts),
[`rt13-hanging-gate`](../scripts/orchestrator/__tests__/redteam/rt13-hanging-gate.test.ts),
[`doneCheck`](../scripts/orchestrator/lib/__tests__/doneCheck.test.ts),
[`costGuard`](../scripts/orchestrator/lib/__tests__/costGuard.test.ts).

### Can a task disappear, or be marked done without being done?

In a test where 20 tasks are changed by competing processes at the same moment, with a merge among them and a crash
injected in the middle of a write, every task stays in the queue exactly once, and only the merged one is done. Two tasks waiting on each other are refused when added. You can
still set a task done by hand (you may have merged it yourself), but if its branch has unmerged commits or it never
started, you get a warning with the tasks it frees and the way back.

**Verified by:** [`rt21-no-task-lost`](../scripts/orchestrator/__tests__/redteam/rt21-no-task-lost.test.ts),
[`queueCycles`](../scripts/orchestrator/lib/__tests__/queueCycles.test.ts),
[`queueStateSafety`](../scripts/orchestrator/lib/__tests__/queueStateSafety.test.ts).

### Does it work in a folder with spaces or non-English letters?

Yes, as far as the tests go: a local and a cloud track go all the way to done with spaces and æøå in the repo, its
origin, the queue folder and the gate script's folder.

**Verified by:** [`rt20-odd-paths`](../scripts/orchestrator/__tests__/redteam/rt20-odd-paths.test.ts),
[`shellCommands`](../scripts/orchestrator/lib/__tests__/shellCommands.test.ts).

### Can my gates be green without checking anything?

`ravenseat doctor` warns when every gate command checks nothing (`exit 0`, `true`, an `echo`, or an npm script that is
one of them). It cannot tell whether a real test suite is good enough; that is yours to judge.

**Verified by:** [`rt17-empty-gate`](../scripts/orchestrator/__tests__/redteam/rt17-empty-gate.test.ts).

### Can a web page I visit control my board?

Not in the ways the tests try. The board listens only on 127.0.0.1, and every API call needs the key from the link it
printed, which a web page does not have. A request with another site's name as Host is refused, which also stops a
page that points its own domain at 127.0.0.1 (DNS rebinding). A write must come from the board's own page and be JSON,
so a form or script on another site cannot send one. What it does not stop: a program running under your own account
can read the key in your terminal, or the queue files directly.

**Verified by:** [`rt23-board-guard`](../scripts/orchestrator/__tests__/redteam/rt23-board-guard.test.ts),
[`queueBoardServe`](../scripts/orchestrator/lib/__tests__/queueBoardServe.test.ts).

### Can I try it on an existing, large project?

Yes, and you can start small. `ravenseat kickstart`, `ravenseat checks` and `ravenseat doctor` only read: they say
what they found (your stack, your test and lint commands, your CI) and change nothing in your project. Setup starts in lite mode, and
`ravenseat limit maxConcurrent 1` runs one agent at a time. Add one small task and let it go through to the merge
before you allow more. Agents work in worktrees of their own, so your checkout changes only when a task is merged,
and the merge stops if it would touch your uncommitted work. What the tests do not show is how well an agent
understands a large codebase: the gates you set decide what a green result is worth.

**Verified by:** [`liteMode`](../scripts/orchestrator/lib/__tests__/liteMode.test.ts),
[`kickstart`](../scripts/orchestrator/lib/__tests__/kickstart.test.ts),
[`queueDoctor`](../scripts/orchestrator/lib/__tests__/queueDoctor.test.ts),
[`rt01-uncommitted-work`](../scripts/orchestrator/__tests__/redteam/rt01-uncommitted-work.test.ts).

### Do I need git, and what if my project is not under git yet?

Yes: each agent works in its own copy of the project, made from your latest commit, and the merge is a git merge.
Without git, `init` and `setup` stop and say so. In a repo with no commit yet, `start` and `fill` refuse before
anything is marked. `ravenseat checks` and the Checks tab show a card with the text to give Claude: `git init`, a
`.gitignore` that keeps secrets out, and a first commit after you say yes. If you know git, set the card aside.

**Verified by:** [`rt25-no-first-commit`](../scripts/orchestrator/__tests__/redteam/rt25-no-first-commit.test.ts),
[`checksCatalog`](../scripts/orchestrator/lib/__tests__/checksCatalog.test.ts).

### What can Ravenseat not protect me against?

- **Weak tests.** Green means your checks passed, not that the change is right.
- **Unclear tasks.** No test shows that an agent understood what you meant. In one round with real agents they asked
  before deleting data, but one made a public API choice itself and only wrote it under Assumptions. `receive` now
  prints that section and the review package carries it: read it before you merge.
- **An agent with your account.** The guards are hooks that read commands, not a sandbox: an agent can read what your
  shell can, and a script it runs is not read. Keep production credentials off the machine, and use Claude Code's
  permissions or sandbox when you need a real boundary.
- **Ordinary files outside a task.** They give a warning for the reviewers; only protected paths stop the merge.
- **Your remote's own rules.** Branch protection and required checks on GitHub are what keep `main` safe from
  everyone, including you.

**Verified by:** nothing; these are the limits. The [red team page](redteam.md#limitations) has the reproductions.
