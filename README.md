<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/ravenseat-dark.svg">
    <img src="assets/logo/ravenseat-light.svg" alt="Ravenseat: two ravens on a high seat" width="110">
  </picture>
</p>

<h1 align="center">Ravenseat</h1>
<p align="center"><a href="https://github.com/vegardjorg/ravenseat/actions/workflows/ci.yml"><img src="https://github.com/vegardjorg/ravenseat/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI: tests on Linux and Windows"></a></p>
<p align="center"><b>A work queue for Claude Code. Each task runs in a fresh agent in its own copy of the project, the plan lives in plain files, and only your checks decide what is merged.</b></p>
<p align="center"><sub>Open source · Runs on your machine · Built for Claude Code · Board optional</sub></p>

<p align="center"><img src="assets/media/explanation.gif" alt="A 44 second loop: a project spread over many chats and a long chat where a turn deep in its 1M window costs about 2.9 times a turn at 100k to 200k, then the queue where each agent starts fresh, builds, checks and merges while you step away and come back to the decisions, cheaper per turn with less reading, checks that cost what your tests cost, and the board optional" width="800"></p>

When a Claude Code project outgrows one chat:

- the one long chat grows toward its 1M-token window, and every turn pays for all of it;
- findings, plans and half-built work are spread over many chats, and two chats undo each other's work;
- rules written in `CLAUDE.md` are followed most of the time, which is not the same as always.

Ravenseat is a Claude Code plugin for that stage. You tell one chat (the orchestrator) what to build. It writes the
work down as tasks in plain files, hands each task to a fresh agent in its own git worktree, runs your tests on exactly
the commit the agent delivered, merges what passes on your machine, and asks you only what a person has to decide.
Each agent starts small and reads its task from a file instead of a long conversation, so a turn costs less than in a
chat that has grown large. The rules that matter run as code on every action, so an agent cannot push, cannot change
the project's control files and cannot mark its own work as tested. You can queue the work, step away, follow along
from your phone with Claude Code's Remote Control, and come back to merged changes and a list of decisions.

> **You:** Add dark mode in settings, a weekly streak on the habit card, and a CSV export once the streak is done.
>
> **Claude:** Added T-001, T-002 and T-003. T-003 waits for T-002.

> **You:** How did dark mode go?
>
> **Claude:** Merged into main. Your check passed on main before and on the result; branch and worktree are gone.

> **You:** Push.
>
> **Claude:** 2 merged tasks, 5 commits, nothing from outside the queue. Pushed: main went from e2a029d to 3dc10b6.

**What it will not do on its own.** It asks before it starts, merges only on your machine, and pushes nothing until
you say "push". **Your part.** Each delivery lists what the agent assumed (its Assumptions); read them before the
merge, because passing tests do not show that the agent understood you.

## Why it holds up

### Fewer tokens per turn

**A turn costs about 0.02 USD, plus about 0.02 USD for every 100k tokens of context it carries** (Opus 5.5, 8,031
orchestrator turns in November 2026, in a larger private project). Every turn in Claude Code sends the whole
conversation again, so a chat that grows large pays for its size on every turn.

Without a setting of your own, Claude Code runs Opus 4.7 and later, the Fable models, Sonnet 5 and later and Haiku 5.5
with a 1M window and compacts at about 967k
([Claude Code docs](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds)), so a chat grows to
almost 1M before it compacts. `ravenseat setup --settings` sets compaction at 300k instead. In the same project, on the
same model, before and after that setup:

| | 25 to 30 September 2026, compacting near 1M | 8 October to 15 November 2026, compacting at 300k |
|---|---|---|
| Main chat: median context per turn | 464k | 183k |
| Main chat: cost per turn | 0.157 USD (n 5,689) | 0.065 USD (n 27,771) |
| Subagents: largest context | 907k | 293k (under 275k from 16 October) |
| Subagents: cost per turn | 0.109 USD (n 41,498) | 0.056 USD (n 225,907) |

A main-chat turn cost about 2.4 times less, and a subagent turn about 1.9 times less. Context size alone predicts most
of the main-chat gain (about 2.0 times), but only about 1.45 times of the subagent gain; the rest fits the 1-hour
subagent cache and the lower effort per agent type, which landed a week earlier. Task sizes and a track context guard
also changed in those days, so this is the combined effect of the setup, not of the setting alone.

**Why size matters.** In the main chats of late September, when they still ran long, a turn at 500k or more cost about
2.9 times a turn at 100k to 200k, in the same model and the same days. The cost line above, extended that far, gives
about 3.1 times at 500k to 800k and about 4.1 times at 800k to 1M.

**Subagents are covered too.** Subagents compact automatically as their own window fills, and they inherit the
session's window ([Claude Code docs](https://code.claude.com/docs/en/sub-agents)). The data shows it: the largest
subagent context fell from 907k to under 275k. On top of that, a Ravenseat track delivers PARTIAL at its second
compaction or at 280k. Setup writes `autoCompactWindow: 300000` to the project's `.claude/settings.json`, so it applies
to every session in the project: your own chats, the orchestrator and all subagents. The guided setup asks first, and
an existing value of your own is kept.

**Many small fresh chats are a real alternative.** At the same size, compacting cost about the same as starting a new
chat and reading a handover note in again, and after a compaction the orchestrator started its first agent after
about 6 turns, against about 17 turns in a new chat. In tokens, what matters is how large a chat gets before it is
reset, not how it is reset, so small chats do not cost more in tokens. What they cost is the handover by hand each time,
the overview spread over many chats, and no safe way to run them in parallel.

**The queue against one chat compacted at 300k.** Both count their subagents (in the one chat, 61 % of its spend was
its own subagents). The queue was cheaper per turn in every week: 0.059 against 0.068 USD in the last week measured,
0.061 against 0.077 over all 19 days. Per commit it was mixed: cheaper in the last week (3.33 against 4.76 USD), about
15 % more expensive over all 19 days (3.50 against 2.95). Checks and review were about a third of the queue's spend.
Without them, over the 19 days, the queue cost 2.36 against 2.60 USD per commit (about 9 % cheaper) and 8.0 against
7.0 per 1,000 lines (about 14 % more expensive).

**What this means if you come from a 1M chat.** Most of the saving comes from compaction at 300k, which setup turns on
for you (you could also set it by hand). The queue itself is about cost-neutral for building and steering, and the
checks come on top, as much as you choose to run. Its value is the structure, the parallel work and the safety, not a
second token saving.

All amounts are API-equivalent at list price. On a subscription they are quota, not dollars.

For experts: a turn is one message id from the transcript, counted once, context = input + cache write + cache read,
priced at the Opus list price; the tables, the dates of each change and the method are in
[costs](plugin/docs/costs.md#measured-the-same-project-before-and-after-compaction-at-300k), and `ravenseat cost` shows
your own split, including the share of cost from turns above 200k. `ravenseat doctor` warns when the instructions
Claude loads at start pass 200 lines in a file or 40,000 characters in total.

### State lives in files, not in the chat

**The orchestrator's cost per finished task halved, with the same number of steps, because its context shrank: from
1.36 to 1.57 USD to 0.64 to 0.80** (late September against mid-October 2026, at 9 to 14 turns per task). It later rose
again to about 1.4 USD as the turns per task about doubled. After a compaction it was back to starting agents after
about 6 turns, against about 17 turns in a new chat that read a handover note.

The queue, each task's mission, the project catalog and the plan register are plain files in your repo. An agent
reads a short mission that lists the files to read first, not the conversation that led to it. When the orchestrator
is compacted, a hook adds back the queue, the open questions and the short "Now" part of the handover note (at most
40 lines), read from the files and not from the summary. Older handover entries move to a monthly archive that is read
only when needed. A crash, a compaction or a second chat loses nothing that matters.

For experts: a `SessionStart` hook on `compact` and a `PreCompact` hook do the re-injection
([orchestration](plugin/docs/orchestration.md), [costs](plugin/docs/costs.md#measured-compacting-the-orchestrator-against-starting-a-new-chat)).

### Long projects, kept in order

**About 1,200 tasks were finished and costed in three weeks of October 2026** (in the larger private project;
[costs](plugin/docs/costs.md#measured-median-cost-per-finished-task-subagents-only)).

- **Plans** go in a plan register, and tasks link back to the plan entry they came from (`--plan <id>`). A track that
  finds something outside its task files it there as a finding instead of building it.
- **Focus** says which areas to finish now; the queue finishes those tasks, fixes included, before new feature work,
  and other tasks fill only the slots left free.
- **Decisions** wait in one list, each with a recommendation and the work it blocks; accepted design choices go in the
  catalog and into the missions that touch them.
- **History** stays: each task keeps its changes, owner answers and cost, and a task's finish line is locked when it
  starts.

For experts: focus, value-based order and helper reviewers are full mode; lite mode keeps the core loop only
([full mode](plugin/docs/full-mode.md), [plan register](plugin/docs/plan-register.md)).

### Security that does not depend on the model remembering

**244 red team tests on real git and real processes: 243 passed and 1 was skipped in the last run (2026-11-18). For
32 guarantees the guard was switched off and the test shown to fail.**

Instructions in `CLAUDE.md` and in skills are advice. They compete with everything else in the context, a long file is
followed less well than a short one, and text an agent reads can argue against them. So Ravenseat runs the rules that
matter as code, on every action:

- the result of your checks comes from Ravenseat's own run on the delivered commit, never from the agent's report;
- agents cannot push, and cannot write `CLAUDE.md`, `.claude/`, git hooks, git config or the queue config;
- a change to protected paths (CI config, lockfiles, Ravenseat's own scripts) stops the merge unless the task owns it;
- an override from the orchestrator opens Claude Code's permission dialog, so a line in a report cannot approve it.

It works with any stack whose checks run from a command line: your gates are your own commands. The Checks tab reads
your CI config and manifests, runs nothing, and suggests the checks you lack; about 30 stack packs add the risky calls
of frameworks such as Django, Rails, Next.js or Spring to review. A failure that comes back becomes a proposal for a
new check, built only on your yes. The full list is under [Guarantees enforced by code](#guarantees-enforced-by-code).

For experts: the guards are `PreToolUse` hooks on shell, Read and Write/Edit; the evidence is keyed to the commit sha,
a clean tree and a hash of the check commands. Guard rails, not a sandbox: agents run as your OS user, and a script an
agent writes and then runs is not read ([red team](plugin/docs/redteam.md), [Checks tab](plugin/docs/checks.md)).
Run `npm run redteam` to check it yourself.

### Parallel work, merged safely

**Several agents build at once, and merges still happen one at a time, each only on a green check run for that exact
commit.**

1. Each task runs in its own git worktree, so agents never share files on disk. In full mode, two tasks that own the
   same file never run at the same time.
2. While tracks run, the queue predicts conflicts between their branches and the base and suggests a merge order.
3. `receive` runs your quick checks in the agent's worktree and records the result for that commit, then builds a
   review package for the reviewers the task calls for.
4. `merge` takes one branch at a time and first runs a trial merge in memory. Conflicts git's text merge resolves are
   merged; a file that needs a hand fix stops the merge before the checkout is touched, and the task records the files
   and the other tasks that touched them, so the fix round starts with that list.
5. The base branch is checked after every merge. A red base stops further merges and gets a fix task. Work an agent
   called unfinished is merged only on your word.

A load guard starts fewer agents as free memory drops: in the larger private project, with up to 14 agents allowed at
once, the median quick check took 1,244 s against 110 s ten days earlier, as free memory ran out
([machine load](plugin/docs/full-mode.md#my-pc-chokes-on-parallel-builds)).

For experts: conflict prediction and the trial merge use `git merge-tree --write-tree` (git 2.38 or newer, objects
only, never the index or a ref); merges hold a lock; a push is blocked when the base is red or commits from outside the
queue are in it ([how a task flows](#how-a-task-flows), [orchestration](plugin/docs/orchestration.md)).

## What Ravenseat does

**In two sentences.** Ravenseat is a Claude Code plugin and a local command-line tool (`ravenseat`) that keeps a
project's plan and tasks in plain files and lets one Claude Code chat act as the orchestrator. The orchestrator hands
each task to a fresh subagent (a track) in its own git worktree, runs your checks on the delivered commit itself,
merges what passes on your machine, and collects what needs a person into one list of decisions.

**Who it is for.** One person or a small team on Windows or Linux, with work that spans days or weeks and a project
that has automated tests. **Who it is not for:** a single small change in one chat, or a project without meaningful
checks, where there is little for it to verify and the extra steps do not pay off.

### How a task flows

1. You describe the work. The orchestrator adds tasks with their dependencies and, in full mode, the files each task
   owns.
2. The queue picks the next task that can start (dependencies done, no ownership conflict, enough free memory) and
   starts a track in a new worktree with a short mission file.
3. The track builds, commits on its branch and answers with one line; its long report goes to a file.
4. `receive` runs your quick checks in the track's worktree, records the result for that exact commit, and builds a
   review package (the diff, the changed files, test-weakening and scope notes) for the reviewers the task calls for.
5. `merge` merges only when the recorded checks for that commit are green, one merge at a time, and checks the base
   branch again after the merge. A red result gets a fix round; if it is still blocked, it becomes a question to you
   while independent tasks continue. A delivery the track itself called unfinished (PARTIAL) is merged only on your
   word, and the task then stays in review until the rest is done.
6. By default nothing is pushed until you say "push". The push check reports what is in the push and blocks it when
   the base branch is red, when commits from outside the queue are in it, or, when full checks are set up, without a
   green full-check run on that exact commit.

More in [how it works](plugin/docs/guide.md#how-it-works) and [the loop](plugin/docs/orchestration.md#the-loop).

### Guarantees enforced by code

- **Check results come from Ravenseat, not from the agent.** A track's own "checks passed" line is never used as
  evidence. Each run Ravenseat makes is recorded with the commit sha, whether the tree was clean, and a hash of the
  configured check commands, and merge and push read only that record. It guards against false claims, not against a
  hostile process: the record is a local file under your user account.
  ([Gate evidence](plugin/docs/orchestration.md#the-gate-evidence-what-a-push-and-a-merge-trust))
- **A focused test stops the merge.** A new `.only`, `fit` or `fdescribe` in a test file stops the merge until it is
  removed or you override it.
- **Other test weakening is flagged.** Deleted test files, new skip markers (`.skip`, `xit`, `@pytest.mark.skip`,
  `#[ignore]` and others) and a test file that lost all its assertions are listed in the review package and logged.
  They do not stop the merge by themselves.
- **Protected paths stop the merge.** A change to `.claude/`, `CLAUDE.md`, git hook folders, CI config, package
  manifests and lockfiles, the queue config or Ravenseat's own scripts stops the merge unless the task owns the file
  or you allow it (in lite mode, dependency files only warn). A minimum set always applies, whatever the config says.
- **Agents cannot write the main tree's control files.** A track's Write or Edit, and a shell line that writes there
  (a redirection, `cp`, `sed -i`, also inside `bash -c` or `eval`), is denied for `queue.config.json`, `.claude/`,
  `CLAUDE*.md`, `.git/hooks/`, `.git/config` and Ravenseat's scripts. Git hooks and git config values that run a
  program are compared before and after each check run.
- **Agents cannot push.** A command guard and a pre-push hook in each track's worktree stop it.
- **Overrides ask you.** When the orchestrator itself runs `merge` with an `--allow-*` or `--force*` flag, confirms a
  weakened setting or acts "as the owner", Claude Code's permission dialog asks you first, so a line in an agent's
  report cannot approve it.
- **The finish line is fixed.** A task's completion criteria are locked when it starts.

These are guard rails against a misled agent, not a sandbox: agents run as your OS user, and a script an agent writes
and then runs is not read by the guards. See [guarantees and limits](plugin/docs/guide.md#guarantees-and-limits) and
the [red team page](plugin/docs/redteam.md).

### Parallel work without collisions

- In full mode, each task lists the files it owns (`owned_files`) and may list files it only reads (`reads`). Two
  tasks that own the same file never run at the same time, and by default a task that reads a file another running
  task changes waits.
- Shared blocks that many tasks need to touch (routes, registries, translations) can be listed as `hotspots`. No task
  owns one. One task at a time can have a change agreed; otherwise the track writes `WIRE` lines in its report, and the
  task cannot be set done until each one is closed with a commit or a reason. Off until you list hotspots.
- Merges run one at a time, and a red base branch stops further merges until a fix task makes it green.

More in [a task](plugin/docs/queue.md#a-task) and [the wiring spec](plugin/docs/orchestration.md#the-wiring-spec-stops-done).

### Machine load

- **Load guard.** Fewer new tracks start as free memory drops below 40 %, and none below 10 %; running tracks are not
  stopped. `ravenseat machine` suggests how many your machine can take.
- **Heavy checks take turns.** A check run that took two minutes or more last time waits for a slot shared by all
  projects of your user on the machine. Runs in the main checkout go first, then the orchestrator's runs on a track,
  then a track's own.
- **No processes left behind.** A command over its time budget is ended with its whole process tree (`taskkill /T` on
  Windows, the process group elsewhere), also when the process that started it dies.

Token use is under [Fewer tokens per turn](#fewer-tokens-per-turn), and spend and the daily budget under
[What does it cost in tokens?](#what-does-it-cost-in-tokens) More in [machine load](plugin/docs/full-mode.md#my-pc-chokes-on-parallel-builds),
[the queue for heavy gates](plugin/docs/queue.md#the-queue-for-heavy-gates) and [costs](plugin/docs/costs.md).

### Learning from repeated failures

- Findings from reviews, check runs, CI, the secret scan and the test-weakening check go into one append-only finding
  log, each with a class (such as `access-control`, `contract-drift` or `null-undefined`) and the area of the code. A
  red check run or CI job also gets a normalized signature, so the same failure is counted as one thing.
- The same signature in two incidents within 30 days becomes one proposal to add a guard. A class that keeps coming
  back in one area shows on the Checks tab, with a button to build a check for it; proposals made from the finding log
  by themselves are opt-in. At most three proposals wait at a time, and nothing is built without your yes.
- A check recipe you keep declining (under 30 % accepted after five decisions) is no longer offered; you can bring it
  back.
- The project catalog (`docs/queue/catalog/`) holds the libraries you prefer, building blocks meant for reuse and the
  design choices you accepted. The parts that touch a task's files go into its mission and its review package.

More in [the Checks tab](plugin/docs/checks.md),
[repeated failures](plugin/docs/orchestration.md#repeated-failures-and-the-guard-registry) and
[the catalog](plugin/docs/catalog.md).

### Modes, board and client

- **Lite mode** is what `ravenseat init` sets up: a task needs only a title, and several stops are warnings while you
  try it. **Full mode** adds risk classes (K, D, D+, U) and task sizing, a value per task, focus steps and helper
  reviewers. By default tasks outside a new focus still fill free slots (`focus.restDefault`, `fill` or `wait`).
  Settings come in the same sixteen groups in both.
  ([Lite and full](plugin/docs/full-mode.md#lite-and-full-side-by-side))
- **The board** is an optional local web page with the same state: the queue as columns, decisions, dependencies,
  focus, the Checks tab, plans and statistics with cost. ([A tour](plugin/docs/board.md#a-tour))
- **One client adapter.** Claude Code's transcript rows, hook payloads and agent calls are read in one place. A format
  check on your latest transcript reports in `ravenseat doctor` and on the Checks tab when rows read differently than
  expected, so a change in Claude Code shows up instead of miscounting quietly. Claude Code is the only client today.

### Known limits

- It is only as strong as your checks. Without meaningful tests, a green merge shows little; `ravenseat doctor` warns
  when your project has no checks, and a push then asks you first.
- Guard rails, not a sandbox: keep production credentials off the machine, and use Claude Code's permissions or
  sandbox when you need a real boundary.
- Developed on Windows; the tests run on Linux and Windows; macOS is not tested yet.
- Young: public since late October 2026 and released often. The [FAQ](plugin/docs/faq.md) names the tests behind each
  answer.

<p align="center"><img src="assets/screenshots/light-01-queue.jpg" alt="The queue board: in queue, in progress, review and built" width="800"></p>

## Quick start

Start in lite mode, the core loop only; [full mode](plugin/docs/full-mode.md) adds structure for larger projects.

**1. Install the plugin.** In Claude Code:

```
/plugin marketplace add vegardjorg/ravenseat
/plugin install ravenseat@ravenseat
```

You need Node.js 20 or newer and git.

**2. Set up your project.** Ask Claude: *"Set up the queue."* (`/ravenseat:setup`, the guided setup that also finds your
checks). It asks before it adds the recommended settings to `.claude/settings.json`. One of them sets automatic
compaction at 300k (`autoCompactWindow: 300000`) for every Claude Code session in the project, your own chats and
all subagents included; an existing value of your own is kept. Not sure yet? Ask Claude to run `ravenseat kickstart` or `ravenseat doctor` first: they show what they find
and change nothing. For a minimal setup without the guide, see [lite mode in more detail](plugin/docs/guide.md#lite-mode-in-more-detail)
(`ravenseat init`).

**3. Add some work.** Tell Claude what needs doing: *"Add to the queue: fix the login bug and add a regression
test."*

**4. Start the queue.** *"Start the queue."* (`/ravenseat:queue`). Ravenseat asks before it starts, then picks tasks, hands
them to agents, runs the checks and merges what passes. It never pushes unless you tell it to.

**5. Answer what waits on you.** *"What's waiting on me?"* (`/ravenseat:decide`). Each decision comes with a recommendation
and the work it blocks.

That is the basic workflow. Plain words work, and the commands are there when you want explicit control
([all commands](plugin/docs/commands.md)). More in the [guide](plugin/docs/guide.md).

## From task to verified change

<p align="center"><img src="assets/infographics/task-flow.webp" alt="Pick the next task, a fresh agent builds it in an isolated worktree, checks run. Passing work is merged and the next task starts. Failing work gets a fix attempt by a fresh agent; if it is still blocked, it becomes your decision while independent tasks continue" width="800"></p>

The steps are in [How a task flows](#how-a-task-flows). Ravenseat does not replace your tests, review standards or
judgment (`/ravenseat:setup` helps you set up checks).

## Your decisions, in one place

The goal is not to remove you from development. It is to stop interrupting you for what the system can handle itself.

<p align="center"><img src="assets/screenshots/light-06-waiting-on-you.jpg" alt="Owner questions with recommendations and an Answer button" width="800"></p>

Each decision has context, a recommendation and the work it blocks. Answer in Claude Code with `/ravenseat:decide`, or with
one click on the board. Typical decisions: unclear requirements, security tradeoffs, hard-to-reverse changes, visual
approval, and tasks still blocked after a fix attempt. The board is optional: a local page with the same project state,
opened with `/ravenseat:board` ([a tour of the board](plugin/docs/board.md#a-tour)).

## What does it cost in tokens?

The cost per turn and per commit against one chat compacted at 300k is under
[Fewer tokens per turn](#fewer-tokens-per-turn). The checks come on top of a turn, and they cost what your checks cost:
your tests, plus a reviewer on the tasks that need one. In the measured repo they were about a third of the queue's
spend, because it has a very heavy test suite (over a thousand database security probes and many check scripts) and
a reviewer on almost every task. A lighter suite costs less. The same suite run by hand in one chat would cost about
the same; the queue adds the reviewers, and makes sure every task runs the checks before it is merged. Leaving the
checks out is cheaper, and it is how insecure code gets merged.

The fairest week to compare is the last one measured (10 to 14 November, 4.6 days, both projects busy every day). The
weeks before it are left out of the headline: this repo was young and small then, and much of the work was splitting
and moving large files, which gives many cheap commits and lines.

| | By hand in one chat | With the queue |
|---|---|---|
| Cost per 1,000 inserted lines | about 12 USD | about 12 USD |
| Spent on checks (tests and review) | about 6 % in tests, plus a few assessment agents | about 30 %, from a very heavy test suite and a reviewer on almost every task |
| While you are away | the chat waits for your next message | agents keep building, checking and merging |
| What you come back to | the chat where you left it | merged work that passed your checks, and the questions only you can answer |

The chat column is this repo, built in one long chat that I followed closely. The queue column is a large repo where
the queue ran on its own, with a heavy test suite and a reviewer on almost every task. Over about 1,200 measured
tasks in October, an ordinary code task cost a median of about 2.5 USD (API-equivalent); code tasks were rarely
reviewed then, and the latest window and the other classes are on the [costs](plugin/docs/costs.md) page.

One week, two different repos, one developer, same model and settings: not a controlled benchmark. Over all 19 days the
chat came out cheaper per commit, from those early weeks. Run `ravenseat cost` to see the numbers in your own project.
There is no spending limit by default: `/ravenseat:setup` asks for one, and `ravenseat limit dailyBudget <usd>` stops new
tasks when the day's spend is used.
[The measurements in detail](plugin/docs/costs.md).

## Why I built it

Ravenseat is the reusable part of a queue I built inside a real Claude Code project that had outgrown its chats.
[The longer story, and how I use it day to day](plugin/docs/why-i-built-it.md).

## Documentation

- [Guide](plugin/docs/guide.md): install, lite mode, daily use, how the loop works, safety baseline, guarantees
  and limits.
- [Full mode](plugin/docs/full-mode.md): lite and full side by side, risk classes, helper agents, focus, guards, load
  guard and recovery.
- [The board](plugin/docs/board.md) and [commands](plugin/docs/commands.md), with [CLI parity](plugin/docs/cli-parity.md).
- [The Checks tab](plugin/docs/checks.md): what the project has for checking its code, every suggestion card, the red
  dot, the thresholds for repeats and how to write your own cards.
- [Orchestration and agent safeguards](plugin/docs/orchestration.md), [queue configuration and reference](plugin/docs/queue.md),
  [plan register](plugin/docs/plan-register.md), [mission template](plugin/docs/mission-template.md).
- [Red team](plugin/docs/redteam.md) and the [FAQ](plugin/docs/faq.md): what can go wrong, the tests that check it, and the
  limits.
- [What it costs in tokens](plugin/docs/costs.md) and [why I built it](plugin/docs/why-i-built-it.md).
- [INSTALL.md](INSTALL.md) for a vendored install, and the [CHANGELOG](CHANGELOG.md) for changes per version.

## Development

```
npm install
npm test        # vitest; runs the unit tests under plugin/scripts/orchestrator
```

Before each commit (also on a track branch), run only the tests your change can reach:

```
npm run test:changed            # against origin/main; or: npm run test:changed -- <ref>
npm run test:changed -- --list  # show the pick and why, run nothing
```

It follows imports, the scripts the tests start as processes (queue.mjs commands, hooks, gates.mjs) and the files the
tests read, and runs the whole suite instead whenever it cannot tell (it prints the reason). Run the whole suite
(`npm test`) before every push. This is a working rule, not a git hook.

## License

MIT. See [LICENSE](LICENSE). The helper agents `reviewer-design`, `reviewer-tests`, `reviewer-gap` and
`reviewer-docs` are adapted from [testdouble/han](https://github.com/testdouble/han) (MIT, Copyright 2026 Test
Double, Inc.); the license text is in [NOTICE](NOTICE).

## The idea behind the name

Ravenseat is named after Odin's high seat, Hliðskjálf, from which he could see every world while his ravens brought
him the news. You sit in the seat. Your agents fly out, do the work and come back with the results.

Created by Vegard Cowie Jørgensen.
