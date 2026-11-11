# FAQ: what people worry about before they let agents merge

Ordered by what people fear most. Each answer names the tests that back it, so you can read them or run them
(`npm run redteam`). How the tests are built, their status and the full map are on the [red team page](redteam.md).

### Can Ravenseat break my repo or lose my uncommitted work?

Not in the ways the tests try. Your uncommitted, untracked, staged and stashed work is checked after every red team
scenario, and history may only grow. If you have your own uncommitted version of a file a task changes, or a staged
change, the merge stops before `git merge` runs, names the files and touches nothing. This came out of two real
findings: `git merge` itself had rewritten the user's files with CRLF on Windows before refusing.

A queue agent cannot reinstall or delete your dependencies either (`npm ci`, `npm install`, the pnpm, yarn and bun forms,
or removing `node_modules`, which in a worktree is a link into your own tree), and every common lockfile is protected.

**Verified by:** [`rt01-uncommitted-work`](../scripts/orchestrator/__tests__/redteam/rt01-uncommitted-work.test.ts),
[`flows`](../scripts/orchestrator/__tests__/redteam/flows.test.ts) (flow 3),
[`lab`](../scripts/orchestrator/__tests__/redteam/lab.test.ts) (the final check, one red case per rule),
[`agentGuardGaps`](../scripts/orchestrator/__tests__/redteam/agentGuardGaps.test.ts).

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

### Does it keep working overnight, or while I am away?

While a Claude Code session is open and the machine is awake, yes: the loop starts tracks, receives and merges until the
queue is empty, the daily budget is used, or everything left waits on you. Then it waits in the background at no token
cost, and an answer from the board or from your phone (Claude Code's Remote Control) starts the next round. After 8 hours
without an answer it waits once more, then the loop stops. When the plan's usage limit is reached, new tracks and fix
rounds pause until the reset and running tracks are left alone. Claude Code continues an interactive session after the
reset in most setups, but not in Remote Control or background sessions; then start the queue again yourself. Nothing
runs while the machine is off or asleep. Cloud sessions (off by default) run ordinary code tasks with the machine closed,
and their work is checked on your machine when you collect it.

**Verified by:** [`queueUsageLimit`](../scripts/orchestrator/__tests__/queueUsageLimit.test.ts),
[`rt24-cold-restart`](../scripts/orchestrator/__tests__/redteam/rt24-cold-restart.test.ts) (pickup after a cold death),
[`queueCloudTracks`](../scripts/orchestrator/lib/__tests__/queueCloudTracks.test.ts).

### What happens when the orchestrator itself misses a step?

The orchestrator is a model following a protocol, and it can drop a step. The queue looks for what that leaves behind. A
task marked running that no agent took is named `STARTED WITHOUT AGENT` (or `ROUND WITHOUT AGENT` for a fix round) after
15 minutes, and a track whose agent shows no sign of life is named `SILENT` after 20 minutes (`silentMin`). Each line
comes with the command that fixes it. A task with no agent is a card under "Waiting on you" at once; a silent track
becomes one after 60 minutes, since a short stop is the orchestrator's to handle. `ravenseat explain <id>` says why one
task stands where it stands, from the same rules the queue starts by. Asking Claude "what is stuck?" runs the same checks.

**Verified by:** [`queueNoAgent`](../scripts/orchestrator/lib/__tests__/queueNoAgent.test.ts),
[`queueSilent`](../scripts/orchestrator/lib/__tests__/queueSilent.test.ts),
[`queueBoardSilent`](../scripts/orchestrator/lib/__tests__/queueBoardSilent.test.ts),
[`explain`](../scripts/orchestrator/lib/__tests__/explain.test.ts).

### Can an agent fake a green result?

An agent's own "gates=OK" is not believed. The orchestrator runs the gates itself on the delivered commit and records
the result bound to that commit; a gate that writes to the evidence store is red as tampered. Two gate runs at the same
moment once read each other's evidence as tampering; they now take turns.

**Verified by:** [`queueGateEvidence`](../scripts/orchestrator/__tests__/queueGateEvidence.test.ts),
[`flows`](../scripts/orchestrator/__tests__/redteam/flows.test.ts) (flow 2, red gates),
[`rt03-two-sessions`](../scripts/orchestrator/__tests__/redteam/rt03-two-sessions.test.ts).

### Can an agent cheat by weakening the tests?

Partly guarded. A focus marker (`.only(`, `fit(`, `fdescribe(`) added to a test file stops the merge, since the gates
would go green while the other tests never ran (`--allow-focus` overrides, and it is logged). Receive warns, and the
review package names the file, when a test file is deleted, gets a skip marker, or loses all its assertions; a skip can
be intended, so the reviewers decide. Changes to test config and other protected paths stop the merge. With
`gates.redOnBase` set, `receive` also checks that the track's new tests fail without its change, and warns when they do
not. Removing some assertions while one remains is not named, because it looks like ordinary tidying.

**Verified by:** [`rt08-weakened-test`](../scripts/orchestrator/__tests__/redteam/rt08-weakened-test.test.ts),
[`testWeakening`](../scripts/orchestrator/lib/__tests__/testWeakening.test.ts),
[`focusStop-cli`](../scripts/orchestrator/__tests__/redteam/focusStop-cli.test.ts),
[`redOnBase-cli`](../scripts/orchestrator/__tests__/redteam/redOnBase-cli.test.ts),
[`mergeGuard`](../scripts/orchestrator/lib/__tests__/mergeGuard.test.ts).

### Does it merge or push without asking me?

It merges locally by itself, and that is the point: a track is merged when the gates the orchestrator ran itself are
green, the review the class needs is clean and the base branch is green. It asks before it starts the queue. Tasks that
agents propose wait for your approval, and database and high-risk tasks (D, D+) are never approved automatically,
whatever the rules say. Nothing is pushed until you say "push" (`push.mode` is `owner` by default), and then in one batch.
A merge that turns out wrong is undone with `git revert -m 1 <merge>`.

A queue agent is refused every push, not even `main`, through the hooks on Claude Code's Bash and PowerShell tools. That
is a hook-level guard, not a limit set by the operating system (see the last question). From your own session, a forced
push and a push of any other branch than the base are refused, in 17 written forms of a forced push, for both the Bash
and the PowerShell tool, through the hooks as Claude Code runs them.

**Verified by:** [`rt18-push-hook`](../scripts/orchestrator/__tests__/redteam/rt18-push-hook.test.ts),
[`pushGuard`](../scripts/orchestrator/lib/__tests__/pushGuard.test.ts),
[`pushBatch`](../scripts/orchestrator/lib/__tests__/pushBatch.test.ts),
[`queueProposals`](../scripts/orchestrator/lib/__tests__/queueProposals.test.ts),
[`queueBaseGate`](../scripts/orchestrator/__tests__/queueBaseGate.test.ts).

### Can two sessions, or two agents, trip over each other?

Two sessions that start, fill, receive or merge the same task at the same moment start it once, merge it once and mark
it done once. One merge runs at a time. Two agents in the same file are allowed; `ravenseat conflicts` predicts the
conflict from the running worktrees, and a real conflict goes to a fix round with its context.

**Verified by:** [`rt03-two-sessions`](../scripts/orchestrator/__tests__/redteam/rt03-two-sessions.test.ts),
[`mergeLock`](../scripts/orchestrator/lib/__tests__/mergeLock.test.ts),
[`queueLock`](../scripts/orchestrator/lib/__tests__/queueLock.test.ts),
[`conflictPredict`](../scripts/orchestrator/lib/__tests__/conflictPredict.test.ts).

### Will one stuck task block everything, or retry forever and burn tokens?

A task that is red in every round gets the fix rounds it is allowed (`maxFixRounds`, three by default), then one question to you, or sooner when a round commits nothing or fails exactly as before. Tasks
that wait on it wait; independent tasks start. A test that hangs is stopped at the time budget, in receive and in the
merge. A track that costs far more than its class usually does, or than its own estimate while the class has no history
yet, is reported to the orchestrator. These limits stop endless retries; they do not cap your token bill. The daily
budget (`ravenseat limit dailyBudget <usd>`) is off by default.

**Verified by:** [`rt06-rt22-permanent-failure`](../scripts/orchestrator/__tests__/redteam/rt06-rt22-permanent-failure.test.ts),
[`rt13-hanging-gate`](../scripts/orchestrator/__tests__/redteam/rt13-hanging-gate.test.ts),
[`doneCheck`](../scripts/orchestrator/lib/__tests__/doneCheck.test.ts),
[`costGuard`](../scripts/orchestrator/lib/__tests__/costGuard.test.ts).

### What does a task cost, and can I cap it?

In the author's project, about 1,200 measured tasks gave a median of about 2.5 USD for an ordinary code task including
its review, 5.1 for a database task, 7.5 for a high-risk one and 1.8 for an investigation, plus about 0.75 USD per task
for the orchestrator. These are API-equivalent amounts, mostly cache reads; on a subscription you pay a flat fee. They
come from one project and one developer, not a benchmark, and there is no controlled comparison with plain Claude Code
or other tools. `ravenseat cost` shows your own.

There is no spending cap by default. The fix-round cap, the plateau check and the cost guard stop endless retries and
name a runaway track; the daily budget (`ravenseat limit dailyBudget <usd>`) is off until you set it. On API billing,
set it before the first long run. Agents use Opus unless you set `models` per agent. When the plan's usage limit is
reached, new tracks and fix rounds pause until the reset. The minute estimates on the cards are rough (read them as
relative size); the `~$x` estimates come from measured cost, and `ravenseat calibrate` shows how far both are off in
your project.

**Verified by:** [`costGuard`](../scripts/orchestrator/lib/__tests__/costGuard.test.ts),
[`fixPlateau-cli`](../scripts/orchestrator/__tests__/redteam/fixPlateau-cli.test.ts),
[`queueSaverMode`](../scripts/orchestrator/lib/__tests__/queueSaverMode.test.ts) (the daily budget),
[`costEstimate`](../scripts/orchestrator/lib/__tests__/costEstimate.test.ts). The cost figures are measurements from one
project ([costs](costs.md)), not tests.

### Will several agents at once choke my machine?

The queue opens fewer slots than `maxConcurrent` while free memory is low: all slots from 40 % free, one at the hard limit
of 10 %, linear in between. Below the hard limit it starts nothing new (`THE MACHINE IS FULL`), and running tracks finish.
The slots are counted when tracks start; long test runs that land later take turns through one shared queue for heavy
gate runs, across all your projects on the machine. A red run while memory was below the limit says it was probably
load. CPU is left out unless you turn it on, and on macOS the memory parts are off by default, since macOS counts the
page cache as used. `ravenseat machine` suggests a `maxConcurrent` from your memory and cores (about 1 on 16 GB, about 4
on 32 GB with 8 cores); these are estimates from one large project.

**Verified by:** [`loadSlots`](../scripts/orchestrator/lib/__tests__/loadSlots.test.ts),
[`queueLoadLimit`](../scripts/orchestrator/lib/__tests__/queueLoadLimit.test.ts),
[`gateQueue`](../scripts/orchestrator/lib/__tests__/gateQueue.test.ts),
[`machineAdvice`](../scripts/orchestrator/lib/__tests__/machineAdvice.test.ts).

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

### Does it work on macOS and Linux?

It is built and used day to day on Windows. The full test suite runs in CI on Ubuntu and Windows (Node 20 and 22) on
every push to `main` and every pull request; macOS is not in CI. One known difference: on macOS the load guard and the
load-aware slots are off by default, since macOS counts the page cache as used. Set `loadGuard.minFreeMemoryPct` to turn
them on there. The gate queue for heavy gates is developed and run on Windows, CI runs its tests on Linux and Windows,
and it has not been tried on macOS.

**Verified by:** nothing beyond the suite itself; the CI workflow (`.github/workflows/ci.yml` in the repository) covers Ubuntu and
Windows only.

### Does the plugin slow Claude Code down, or affect my other projects?

Each hook starts node and exits at once in a project without `queue.config.json`, so outside the queue the cost is a
process start per hook and nothing else. In a project with the queue, one hook runs after every tool call and returns at
once unless the agent is a track; the push, read and write guards run before Bash, Read and Write calls. The hooks run
node directly, without a shell, so Windows does not start Git Bash for each one. Other plugins weigh more than before: a
plugin's start hook runs once per agent session, so four tracks and an orchestrator run it five times.

**Verified by:** [`projectRoot`](../scripts/orchestrator/lib/__tests__/projectRoot.test.ts),
[`writeGuard`](../scripts/orchestrator/lib/__tests__/writeGuard.test.ts) (inert outside a queue project).

### Can my gates be green without checking anything?

`ravenseat doctor` warns when every gate command checks nothing (`exit 0`, `true`, an `echo`, or an npm script that is
one of them). It cannot tell whether a real test suite is good enough; that is yours to judge.

**Verified by:** [`rt17-empty-gate`](../scripts/orchestrator/__tests__/redteam/rt17-empty-gate.test.ts).

### My project has few or no tests. Is it still worth it?

It runs, and it tells you. With no quick gates and no done command, `receive` says `NO CHECKS RAN`; in a project with no
gates or no CI config, an ordinary code task also gets a short agent review, and the merged task is marked audited
(reviewed, no check ran) or unverified, never verified. Verified only means that your gates passed: if your gates are
lint alone, that is all it says. Without tests, nothing automatic stands between an agent's change and the merge except
the review, so the value grows with your checks. `ravenseat kickstart` and the Checks tab show what you have and one
next step, and only read your files.

**Verified by:** [`controlsFlow`](../scripts/orchestrator/__tests__/controlsFlow.test.ts),
[`kickstart`](../scripts/orchestrator/lib/__tests__/kickstart.test.ts),
[`checksCatalog`](../scripts/orchestrator/lib/__tests__/checksCatalog.test.ts),
[`rt17-empty-gate`](../scripts/orchestrator/__tests__/redteam/rt17-empty-gate.test.ts).

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

### How mature is it?

Young. It has been public since late October 2026, with frequent releases, and it has been renamed twice (from
claude-code-queue to `cq` to Ravenseat). It was built over several months inside the author's own project, where it
has run for long stretches; the cost figures and that experience come from there, not from the plugin's public life. The
red team suite and the round with real agents are the author's own tests. So start as the previous answer says: lite
mode, one agent at a time, a project with tests you trust, and read the [CHANGELOG](../../CHANGELOG.md) before you update.

**Verified by:** nothing; this is a statement about age, not a test.

### Do I have to learn the commands, and how much of my time does it need?

No commands to learn. Plain words in Claude Code work ("add to the queue", "start the queue", "what is waiting on
me?"), and the board is optional. Underneath there are many commands, and Claude runs them for you. A few steps need
your own terminal: starting cloud sessions, keeping the board running on its own, and cleanup commands that Claude Code's
auto mode can refuse. Your own work moves from coding to deciding: answering agents' questions, approving the tasks
they propose, visual checks, and the Assumptions section of each delivery before it merges. `/ravenseat:decide` gives
all of it as one list, most impact first. Tasks that wait on you wait; independent tasks go on.

**Verified by:** [`queueDecide`](../scripts/orchestrator/lib/__tests__/queueDecide.test.ts) (the list and the commands
`/ravenseat:decide` runs).

### Do I need git, and what if my project is not under git yet?

Yes: each agent works in its own copy of the project, made from your latest commit, and the merge is a git merge.
Without git, `init` and `setup` stop and say so. In a repo with no commit yet, `start` and `fill` refuse before
anything is marked. `ravenseat checks` and the Checks tab show a card with the text to give Claude: `git init`, a
`.gitignore` that keeps secrets out, and a first commit after you say yes. If you know git, set the card aside.

**Verified by:** [`rt25-no-first-commit`](../scripts/orchestrator/__tests__/redteam/rt25-no-first-commit.test.ts),
[`checksCatalog`](../scripts/orchestrator/lib/__tests__/checksCatalog.test.ts).

### Will an update break my setup?

The board shows a banner when a new version is out, with the steps: update the plugin, reload, then
`ravenseat setup --settings`. The docs and the mission template in your project are your own copies, so
`ravenseat setup --update` merges them three ways and keeps your edits; a conflict leaves the copy as it is and saves the
merge for you. `queue.config.json` and your queue data are not touched. The exception so far was the rename from `cq`,
which needed an uninstall and a new install, and the hooks were off until that was done; the [CHANGELOG](../../CHANGELOG.md)
says so at the top of that release.

**Verified by:** [`setupMerge`](../scripts/orchestrator/lib/__tests__/setupMerge.test.ts),
[`queueUpdate`](../scripts/orchestrator/lib/__tests__/queueUpdate.test.ts),
[`queueBoardUpdate`](../scripts/orchestrator/lib/__tests__/queueBoardUpdate.test.ts).

### Are cloud sessions safe to turn on?

They are off by default, and two things are yours to arrange first. Install the Claude GitHub App on the repo: without
it a copy of your local repo is uploaded, and on Windows that copy includes uncommitted changes in tracked files. And
protect your base branch on GitHub: a session is told never to push to it, but nothing on GitHub's side stops it. Only
ordinary code tasks without database changes go to the cloud. What comes home is checked by the gates on your machine
before any merge, whatever the session says it ran. A session's use is on your plan and not in `ravenseat cost`.

**Verified by:** [`flows`](../scripts/orchestrator/__tests__/redteam/flows.test.ts) (flows 1 and 2),
[`queueCloud`](../scripts/orchestrator/lib/__tests__/queueCloud.test.ts),
[`queueCloudTracks`](../scripts/orchestrator/lib/__tests__/queueCloudTracks.test.ts).

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
