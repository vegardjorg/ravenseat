# Changelog

All notable changes to Ravenseat (called `cq` up to 0.8.23, and claude-code-queue before that). The version is in
`plugin/.claude-plugin/plugin.json` and `package.json`.

## Unreleased

### Added
- The fix-round plateau: before a fix round, the queue asks the owner (exit 8, question `<id>.plateau<N>`, `FIX-ROUND PLATEAU`) when the previous fix round committed nothing or the check fails exactly as before it, instead of paying for more of the same until the cap. Durations, clock times and shas in the output do not count as a change. The owner's answer allows the round; `"fixPlateau": false` turns it off.

## 0.8.32 (2026-11-10)

**Ownership is now enforced: a file another active task owns stops the merge, shared config gets hotspots with a serial lock, the ranking prefers short tasks on contended files, and new tasks get ownership hints from what earlier tasks really changed. Tracks are warned while they write, a refused or failing tool gets its own card, and `setup --update` merges the project's doc copies.**

### Changed
- A track that changes a file another active task owns (running, in review or picked) now stops the merge (exit 4, before the merge), with the file and its owner named. Before, it merged with only `WARNING ownership drift` and stopped only on a text conflict. `--allow-guard` overrides and is logged as `guard-overridden`. `receive` and the pulse say it early, so it is fixed while a fix round is cheap; the pulse caches the changed files per tip sha. Another task's `shared_patch` is not counted as ownership.
- The ranking counts ownership contention: when other open tasks own an overlapping file, only one of them can run at a time, so a short task (60 min or less) gets +10 % per contender and a long one (above 120 min) -10 %, at most five counted. The board's Placement shows the factor.
- `owner_db` is compared without the default schema and the argument list: `users` and `public.users`, and `fn(uuid)` and `fn`, are now a conflict. Another schema (`auth.users`) is still a different object.

### Added
- `merge` keeps the files a task actually changed (`changed_files`, at most 300). `add` prints an OWNERSHIP HINT when earlier tasks that changed the new task's files also changed other files (in at least two of them and at least half), so they can be owned before the track starts.
- Hotspots: `hotspots` in `queue.config.json` lists shared config many tasks touch. A hotspot can never be in `owned_files` (`add` and `edit` refuse it); a task names the hotspots it may change in `hotspot_patch`, and two active tasks holding the same hotspot are a start conflict. An unagreed hotspot change gives a write warning, a note in `receive` and the pulse, and stops the merge (exit 4, `--allow-guard` overrides and is logged). The default is `[]`, so nothing changes until a project lists its hotspots.
- Write warnings for tracks: the write guard now tells a track, once per file and kind and without stopping the write, when the write will be stopped later: a protected path its task does not own, a file another active task owns, a hotspot it has not agreed, a new skip or focus marker in a test file, or a test file that loses all its assertions. The warning says what happens at merge or receive and tells the track to ask the owner, or to fix the code instead of the test. Reviewers, helpers and the main session get none.
- `ravenseat setup --update`: a three-way update of the project's copies (the docs in `docs/queue/` and `CLAUDE.queue.md`). Setup now records the plugin text it wrote as the base. A copy nobody edited follows the plugin, a copy with only your edits stays, edits on both sides in different places are merged, and a conflict leaves the copy as it is and saves the merge with markers in `scripts/.queue/setup-merge/`. `--dry` shows what it would do. A copy from before bases were kept is not touched; `--overwrite` replaces it. `queue.config.json` is never merged. `doctor` and `setup` now point to `--update` for old copies.
- A **TOOL TROUBLE** card in "Waiting on you" when auto mode refuses a track's tool call, or when a track fails the same tool three times within half an hour. PermissionDenied and PostToolUseFailure hooks keep only the agent id, the tool name and the time in `<dataFolder>/tool-trouble.json`, never the reason, the input or the error text. A plugin install gets the hooks with the update; a project set up from settings.queue.json gets them with `ravenseat setup --settings`.

### Fixed
- The NEEDS APPROVAL card from 0.8.31 now shows in a real session. A live run found that the board tied the waiting agent to no task: the time log's start row is written before the agent's transcript exists, so it carries the agent id. The board now reads the mission at the start of the agent's transcript (`prompt-<ID>.md` or "track <ID>", the same rule as the time log) when the time log has no task for it.

### Tests
- An opt-in live test (`RAVENSEAT_LIVE_APPROVAL=1`, Windows, never in CI) starts a real claude in its own window, lets a background agent stop on a Write prompt and checks the card on the real board. A claude started with the CLAUDE_* variables of another Claude Code session wrote no transcripts in the first run, so the test starts it with a clean environment.

## 0.8.31 (2026-11-10)

**A track's own choices are now in front of you before the merge, a track that waits on a permission prompt gets its own card, queue.json keeps copies at a few ages, and `ravenseat explain <ID>` says why one task stands where it stands.**

### Added
- `receive` prints the Assumptions section of a track's report next to its owner questions, and the review package carries it with a note to the reviewer: a choice the owner should have made (what the feature does for its users, a public API or file format, deleting data, a security or legal tradeoff) is a MEDIUM finding. In a round with real agents, a track made a public API choice itself and only wrote it there.
- A **NEEDS APPROVAL** card in "Waiting on you" when a track's agent stands still on a permission prompt, with the tool's name and since when. A Notification hook (matcher `permission_prompt`) finds the waiting agent from the session's subagent transcripts and keeps only its id, the tool and the time in `<dataFolder>/approval-waits.json`, never the prompt text. The card goes once the agent moves on. A plugin install gets the hook with the update; a project set up from settings.queue.json gets it with `ravenseat setup --settings`.
- Rolling copies of queue.json in `<dataFolder>/snapshots/` (default 1h, 5h, 1d, 2d and 7d). A copy moves up a tier once it has reached its own tier's age, so no two tiers hold the same copy, and a broken queue.json never pushes out a good one. The cost is one file check per tier on each write. `ravenseat doctor` names the copies when queue.json is broken. `stateSnapshots.tiers` in queue.config.json sets 2 to 8 ages, and `enabled: false` turns it off.
- `ravenseat explain <ID> [--json]`: why one task stands where it stands, from the rules the queue starts by. For a waiting task: what blocks it, a stop on the whole queue, the full limits and its place among the startable ones. For a running task: when it started, the round, an open block and the last sign of life with its source, SILENT over `silentMin`.

### Fixed
- The gates run in a track worktree outside the project folder (a linked worktree of the same repository), instead of refusing it.
- `prepare-track --continue` after `resume` counts only the track's own commits, so a freed worktree is READY again, and a detached HEAD with a stray commit is still refused.
- `fill --ids A,B` fills both tasks; a comma-separated list was read as one unknown id.

### Docs
- The FAQ and the red team page make narrower claims after a review, the FAQ answers how to use Ravenseat in an existing project, and the red team result names the check it skips.

## 0.8.30 (2026-11-08)

**Every row on the red team map is now tested, not only named: a cold restart of the orchestrator, two agents in the same file, files outside a task, missing tools and runaway cost run as real flows. The round found four more problems, and all four are fixed. A project without git, or without a first commit, gets a clear stop and a card with the text to give Claude.**

### Added
- Red team scenarios:
  - the orchestrator and an agent killed with no handover, picked up by a new process from what is on disk;
  - two real tracks changing the same line, with the second merge stopping and its fix round told both sides;
  - a file outside a task's list (a warning) and a protected path (a stop before `git merge`);
  - git, node, `gh` and `claude` each missing from PATH, a node older than 20, and a gate program that is not installed;
  - a changed helper agent that has not been approved again;
  - lite to full mode and back;
  - a project without git or without a first commit.
- A first-commit card on the Checks tab and in `ravenseat checks`, for a project with no git or no commit. It shows the text to give Claude in your own session (`git init`, a `.gitignore` that keeps secrets out, a first commit after your yes, no push) with a copy button. A queue agent cannot take this step, so it adds no task. Set it aside, or turn the tab off, if you know git. Suggestion files can use the new `action: ask` and the conditions `no-git` and `no-commit`.
- `ravenseat doctor` warns when a gate's program is not found on PATH (for example `pytest` or `cargo`), so a gate that is red on every run is named before the first track. It only looks the program up and never runs the gate.
- The cost guard warns about the first runaway track of a class too: until a class has three finished tasks in seven days, it compares with the task's own estimate. The warning says which it used.

### Fixed
- In a repo with git but no commit yet, `start` marked a task running and the agent then stopped at its first step. `start` and `fill` now refuse before anything is marked and say to make a first commit.
- With git missing from PATH, `doctor` passed and blamed the repo. It now fails first, naming git.
- When an agent died with uncommitted work, `resume` did not mention it, and the new agent started without it. `resume` now names the changes and how to commit them to the branch first.

### Known limits
- Unclear requirements are still not verified: that needs rounds with real agents.
- The gate program check looks at doctor's PATH, which may differ from the agents', and does not judge a program behind `$VAR`, `npx` or an npm script.
- Before a class has history, the cost guard's estimate is the class default, which can be far from the real cost.

## 0.8.29 (2026-11-08)

**Ravenseat now has a red team suite that tests it the way a careless user would use it, with a page and a FAQ that answer "can it break my repo?" with tests. It found ten problems, and all ten are fixed. Cloud tracks also work on a normal subscription.**

### Added
- A red team suite (`npm run redteam`). It uses real git, real `ravenseat` processes and the real hooks, and only the agent is fake. After every scenario one shared check makes sure your uncommitted, untracked, staged and stashed work is as it was, history only grew, the remote is untouched, and every task is in the queue exactly once. Scenarios:
  - uncommitted work through a whole task;
  - a merge interrupted and resumed;
  - two sessions on the same task;
  - a task that never passes;
  - a hanging test;
  - a weakened test;
  - a gate that checks nothing;
  - forced pushes in 17 written forms;
  - folders with spaces and æøå;
  - 20 tasks changed at the same moment.
- [Red team page](plugin/docs/redteam.md) with the map of fears, status and level, the findings and the limits, and a [FAQ](plugin/docs/faq.md) ordered by what people worry about, with the tests behind each answer. The result section is generated by `npm run redteam:report`. A test keeps the map, the FAQ and the links in step with the tests.
- `receive` and the review package name a test file left with no assertions. Like deleted tests and skip markers, this is a warning for the reviewers, not a stop.
- `ravenseat doctor` warns when every gate command checks nothing: `exit 0`, `true`, an `echo`, or an npm script that is one of them.
- `ravenseat set <id> done` warns when the task never started or its branch has commits that are not in the base. The warning names the tasks it frees and the way back. It never stops you, since you may have merged the work yourself.
- `ravenseat doctor` names a `queue.json.<pid>.tmp` left by a process that is gone.
- Cloud tracks on a normal subscription:
  - `features.cloud` is the one switch, and the Cloud tab comes with it. `cloud settings`, `cloud set` and a Cloud section in the gear change the rest. `cloud.maxSessions` and a doctor check are new.
  - `cloud collect` brings finished sessions home one at a time (worktree, prepare, receive), so the gates and the evidence stay local. Merge is still its own step, and it removes the session's branch from the remote unless `cloud.deleteBranch` is off.
  - `cloud-go` starts several sessions before you leave. It says first if the base is not pushed, and the offer can be turned off. Cloud starts obey the usage-limit pause.
  - `cloud setup` suggests a setup script from the lockfile, and advises protecting the base branch.
- `ARCHITECTURE.md` with the decisions, trade-offs and failure modes.

### Fixed
- A test that hung could hold a merge for good when the base gate was off. The merge's gates now always get the time budget.
- With a staged change, or uncommitted work in a file the task's branch changes, `git merge` refused. Before it refused, its own save and restore had rewritten your other files with CRLF under `core.autocrlf` (the Git for Windows default). The merge now stops before `git merge`, names the files and touches nothing.
- Two tracks received at the same moment could read each other's gate evidence as tampering, and both stopped for you. Gate runs that record evidence now take turns.
- `add` and `edit` refuse dependencies that wait on each other. Such tasks used to wait forever without a word. `doctor` names a cycle that is already in the file.
- A task edited by hand without a domain or class no longer crashes `next` and `show`.
- Our own tests no longer pick up the queue of the checkout they run in.

### Known limits
- Removing some assertions while one remains is not named. It looks like ordinary tidying.
- Green means your checks passed, not that the change is right. `doctor` says when the gates check nothing, not when a real suite is too thin.

## 0.8.28 (2026-11-07)

**A lock nobody holds no longer stops your commands.**

### Fixed
- On Windows, a queue command could fail with "Could not get the lock" although nobody held the lock. When a command released the lock, Windows could refuse to remove the lock folder, and the empty folder made the others wait until they gave up. An empty lock folder is now taken after 2 seconds.

## 0.8.27 (2026-11-07)

**Ravenseat now pauses at the subscription's usage limit instead of starting work that cannot finish, and each check cleans up its own temp folder.**

### Added
- A pause at the usage limit. When a turn ends on the limit, a hook saves the reset time, and no new tracks or fix rounds start until then (exit code 12). Running tracks are left alone. The pulse and the board say when work resumes. `usageLimit.pause` false turns it off, and `ravenseat limit usageLimit clear` lifts one pause. This has only been tested against recorded signals, not a real limit.
- Each run of `gates.mjs` gives its commands a temp folder of their own and removes it afterwards, so what a project's tests leave goes with it. A folder holding a link is left in place, and the run says so. `gateTemp.enabled` false turns it off. A separate base gate and a task's done command keep the normal temp folder.
- `ravenseat doctor` has a `temp` line with the number of entries and the prefixes with the most. It removes nothing.

### Docs
- The orchestration guide has a section on what each kind of interruption leaves behind and how to resume, backed by new tests that kill merge and receive without warning.
- The queue guide explains the temp folder, and why a plugin's hooks multiply with the number of agents.
- The README mentions the shared queue for checks and `ravenseat machine`.

### Fixed
- Our own tests no longer leave folders in the temp folder.

## 0.8.26 (2026-11-07)

**Heavy checks now take turns across the whole machine, so several projects or tracks no longer choke it, and `ravenseat machine` suggests how many tracks your PC can carry.**

An existing project keeps its own copy of the mission template, so its tracks get the new instructions on proposals only after `ravenseat setup --overwrite` (it replaces your own edits in the copied files; `--dry` lists them first). Commit the result.

### Added
- A shared queue for heavy checks. Gate runs wait for a free slot, across all projects on the machine, and the time budget starts when the check starts. The wait is shown and logged. It lets everything through if the queue itself fails, and `QUEUE_GATE_QUEUE=off` turns it off.
- `ravenseat machine [--measure]` shows cores, memory and free memory, and suggests a `maxConcurrent`. The suggestion is an estimate, and it changes nothing. `--measure` times one full check when no track runs.
- `ravenseat doctor` and setup give the same suggestion. `doctor` gives a WARN when `maxConcurrent` is above it, and the default of 5 does so on machines under about 33 GB.
- Free memory is sampled during a check. The lowest value goes in the time log, and a red check on a machine short of memory says that load is the likely cause.
- Two new cards under Checks: run only the changed tests in the quick check, and cap the number of test workers.
- `ravenseat --version`.

### Changed
- A proposal from a track no longer goes in the batch queue or trips the small-task and project warnings. The owner decides that when approving.
- Proposals in the batch queue are counted and shown in the inbox, the state line, `approve`, `decide` and `info`.
- The mission has one paragraph on new work, and explains why PowerShell 5.1 needs one command per call.
- A track's mission says what it means when no files are listed for the task.
- The board screenshots in the docs are new, and show the Checks, Decisions and Focus tabs.

### Fixed
- A merge of a task without `owned_files` now lists the files it changed.
- The warnings from a green merge step (ownership drift, dependency files) reach the owner. Before, they only went to the merge log.
- A track is no longer told that someone must set its project and feature. It runs without them.
- A time budget that runs out now stops the check's whole process tree, not only its shell. Check commands get no stdin.
- `vitest` could end a run with exit 1 and every test green when one long test blocked its progress calls on a busy machine. The longest test now lets them through. It can still happen on a very busy machine.

### Known limits
- `ravenseat merge` holds the merge lock while it waits for a slot, so other merges in that project are refused for that time.
- Runs waiting for a slot have no fixed order.
- The shared queue has been tested automatically and on Windows, but not yet in a real test round or on macOS and Linux.

## 0.8.25 (2026-11-06)

**A track can now propose work with only an id, a title and a mission, and the owner sees the proposal in `ravenseat show`.**

An existing project keeps its own copy of the mission template, so its tracks get the new instructions only after `ravenseat setup --overwrite` (it replaces your own edits in the copied files; `--dry` lists them first). Commit the result.

### Changed
- The mission now shows a track how to propose work outside its mission, also the `--file` form for Windows. Before, only one line in `CLAUDE.queue.md` mentioned it.
- A proposal from a track needs only `id`, `title` and `mission`. `domain`, `project` and `feature` follow the track and the class is K, unless the task sets them. A track that does database work should set `"class":"D"`, or the proposal counts as K, also for auto-accept when that is on.
- `ravenseat show` names up to 5 proposals with the track they came from, and `ravenseat proposals` lists all of them with their titles.
- The guard's list of allowed commands says `add` must run on its own, from the track's own branch, with no `cd`.

### Fixed
- A track was told to fix a missing project or feature with `edit-many`, a command it may not run. Now it is told there is nothing for it to do.
- The mission gave `gates --log` a folder name and called it a log folder, but `--log` writes a file, so a track failed when it tried to `cd` into it. The mission now says `gates.log`.

## 0.8.24 (2026-11-06)

**The plugin and its command are now called `ravenseat`. `cq` is gone, with no alias.**

### If you have the old `cq` plugin

A plain update does not work: `claude plugin update cq@ravenseat` fails with `Plugin "cq" not found`. The update banner in 0.8.23 suggests that command, so ignore it. As soon as the marketplace updates, `cq` fails to load and its hooks, the push guard among them, are off. Swap it in a terminal (add `--scope project` to the first and last line if you installed it for one project; your queue data stays):

```
claude plugin uninstall cq@ravenseat
claude plugin marketplace update ravenseat
claude plugin install ravenseat@ravenseat
```

Then open Claude Code in the project, ask it to run `ravenseat setup --overwrite --settings` (the command is only on the PATH inside Claude Code), and commit.

The explanatory `_` lines in your own `queue.config.json` keep the old name, which is harmless. Scripts of your own that call `cq` must be changed.

### Changed
- Renamed to `ravenseat`: the plugin, the CLI, the skills (`/ravenseat:queue`), the agents (`ravenseat:track`), the entry script and every text. A new CI workflow is written as `.github/workflows/ravenseat-gates.yml`. An existing `cq-gates.yml` is not recognised, so delete it if you run `setup --ci` again, or you get two workflows.
- All guards read the product's name from one file (`lib/productNames.js`), and a test fails when a command in `plugin/bin/` is not listed there.
- A track may now add proposals with `ravenseat add` from its own branch. Never with `--approved`, it always becomes a proposal, and at most 3 can be open per track. Elsewhere, or moved with `cd` or a `QUEUE_` variable, it stays denied.
- `requirements*.txt`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle(.kts)` and `composer.json` now count as dependency files: they stop in full and warn in lite.

### Fixed
- `ravenseat init` in a repo without `main` (a repo on `master`) left the base branch at `main`: `show` said a task could start, and `fill` failed. Init now writes the current branch. A base branch in the config, or an existing `main`, is left alone.
- `ravenseat init` now also adds `.claude/worktrees/` to `.gitignore`, so an open track no longer shows as untracked in `git status`.

## 0.8.23 (2026-11-06)

### Added
- `cq checks` and a Checks tab on the board: what the project has for checking its code (CI files, triggers and jobs, each
  kind of check and where it runs) and prioritized suggestions as cards. Files are only read, nothing is run. A button
  adds one investigation task that ends in a plan, never in code. Each suggestion is a template file, and a project can
  add, replace or remove them in `docs/queue/checks`. Turn it off with `cq checks off`, on the tab or in Settings.
- `dependencyFiles` in the merge guard. It warns in lite and stops in full.
- `identity.allow` accepts a listed address.

### Changed
- `gitSurface` warns in lite and stops in full, so a first try does not stop where it should not.
- A forced push of a branch in `push.allowBranches` asks first. The base, other branches and agents stay denied.
- Commits outside the queue are one neutral line and exit 0 in push mode owner. They still stop in threshold.
- The `ci-cost` lines show only with `cq doctor --all`, and doctor says when the secret check is off.
- `cq setup --overwrite --dry` lists only files that would change, and says how many are already up to date.
- The cleanup after a track says `Shared folders in the main tree, unchanged` instead of a raw fingerprint.
- `cq decide` headings name the problem, and `cq show` says when setup is behind.

### Fixed
- The push guard now also reads the Monitor tool, quotes or a backslash inside a word (`g"i"t`, `g\it`) and brace lists
  outside quotes. It is still no security boundary, and the docs name what it cannot read.
- `cq finding` stopped with `Which project?` in a project with no projects registered, and an agent could not fix that.
  The first finding now creates a project called `general`.
- A task in review with an open round is no longer aged or called `DELIVERED` by `cq takeover`. A hung agent in such a
  round gets `SILENT`, and an earlier round's report does not turn that off.
- The fix round line says to free the branch when a note says it is held.
- `cq show` refuses `--json`, and `edit` on an unknown id says so.
- `--over-load` is only offered when it helps.
- The Waiting on you panel follows Seen on the Decisions tab.
- Tasks in review or proposed are not an empty queue for the mascot.

## 0.8.22 (2026-11-05)

### Added
- `cq wait` checks the tracks every 5 minutes (`--check-min`, 0 = off). A track no agent took, or a silent one, gives
  `TRACKS NEED A LOOK` and exit 11, once per finding. The check costs no tokens.
- `ROUND WITHOUT AGENT` in `cq show` and the pulse: a round from `cq resume` that no agent started after 15 minutes, with
  the command to run. `cq decide` and the board get a card, and `cq takeover` says `NO AGENT`. It needs a client with
  hooks and a start row in the time log, so a project without the hook gets no false warning.
- A track silent for 60 minutes gets a card in `cq decide` and on the board.
- `cq guidance quiet`, also on the board and asked in setup: stops advice about CI, gates and lockfiles, the light
  review, intake triage and gate proposals. Guard stops still apply.
- `push.allowBranches` for pull request flows. Agents still never push, force and delete stay denied, and the secret
  scan runs.
- `cq show` and `cq decide` list tasks waiting on a cancelled task.

### Changed
- The merge guard has a floor that `protectedPaths` cannot remove: the queue config, `.claude/`, git hooks, `CLAUDE*.md`
  and the queue scripts.
- `git push --tags` is denied like a named tag.
- `cq fill --ids` says why a task cannot start.
- `cq takeover` says when `DELIVERED` rests on commits without a report.
- `ci-cost` in `cq doctor` is INFO.

### Fixed
- An owner's answer on the board wakes `cq wait`. Before, the orchestrator slept on while the round stood ready.
- A report from before the start no longer turns off `STARTED WITHOUT AGENT` and `SILENT`.
- `baseGate.enabled: false` gave a FAIL in `cq doctor`.
- `cq push-check` ignored `controlsWarning`.
- A declined check counted as missing on the board.
- The guide contradicted the secret scan.

## 0.8.21 (2026-11-05)

### Changed
- `cq resume` frees the branch itself when it continues a PARTIAL delivery and the old worktree is clean. A fix round
  still gets the advice, since it may be fixed in that worktree.
- The `cq takeover` warning about another orchestrator says what it saw, so you can tell when it was your own command.
- `cq receive` mentions an approved review in its merge line only when a review starts.
- `cq add` names the usual wrong field names (`minutes` is `content_min`), and `cq edit` names a flag it did not
  understand when nothing changed.

### Fixed
- A base fix task nobody has started is cancelled when the base goes green, so the next fill does not start an agent on
  nothing. A started task, or one the CI watch added, stays and is pointed out.
- The owner's answer stays first in the brief when the same round is written again with `cq resume`.
- With an open track question, `cq receive` and `cq merge` name `--answer` in their next step.
- An answer to a track counts in `cq decide --today` and under Decided today on the board.
- A continuation without a handover no longer tells the agent to work from one.

## 0.8.20 (2026-11-05)

### Added
- `cq show <id>` shows that task, the same as `cq info <id>`.

### Changed
- The board's push line gives the same verdict and reason as `cq push-check`, also for external commits, a remote ahead of
  the base and a missing full gate.
- The guards no longer read text as commands when a quoted heredoc only writes it to a file or a commit message
  (`cat > file <<'EOF'`, `git commit -F - <<'EOF'`). Anything that could run the text is still read.

### Fixed
- `cq set` no longer makes an orchestrator whose time ran out look alive, and `cq takeover` does not warn about one.
- The board's answer buttons are named for what they do, and its two counters agree. An answer in its undo window or a card
  marked Seen leaves both, and the Decisions tab says when `cq decide` still lists something.

## 0.8.19 (2026-11-05)

### Added
- A track's question can be answered: `cq resume <id> --reason context --answer "<text>"`. It is the recommended option in
  `cq decide` and on the board. The answer leads the new agent's brief and stays for later rounds.
- `cq edit <id> --files a,b` sets the files a task owns.

### Changed
- `cq merge` stops on a PARTIAL delivery unless you pass `--allow-partial`, and `cq receive` no longer shows the way to merge one.
  The next round delivering DONE clears the stop.
- `cq edit` with nothing to write is an error instead of printing `changed:`.
- A `GATE` line or `cq gate` with a long failure class keeps the whole class in the mission. Only the title is cut.

### Fixed
- A worktree the agent detached when it delivered is found: cancelling names it, `cq cleanup-worktree --abandon` removes it,
  `cq merge --resume` tidies it and `cq doctor` lists it.
- When nothing can start, `cq fill` says which tasks hold the slots. It shows held-back tasks also when the machine is full,
  and names the file the task owns rather than git's folder.
- `cq setup` leaves `settings.json` alone when nothing in it changes, and names what is uncommitted.
- A block left open on a cancelled task no longer counts as open or grows.
- A continuation made twice with no agent between counts as one round, and a brief after a red gate no longer points at
  a review package that was never written.
- `cq <command> --help` shows the help for queue commands instead of running them.
- Clearer texts for merge conflicts, a red base, the git identity warning and changed files.

## 0.8.18 (2026-11-04)

### Added
- The first push is scanned for secrets, since no earlier push has checked what is in the history.
- `cq cleanup-worktree <branch> --abandon --execute` removes the worktree of a cancelled task. The branch and its commits stay.
- A `GATE` line can name its place: `GATE <failure class> @ <file:line>`.

### Changed
- A migration from a task that does not own it stops the merge.
- `cq decide` recommends declining a gate task with no file and line behind it, since the gate needs a failing example.
  `GATE` lines from an older mission template have no place, so they get this advice too.
- Nothing counts as running long before 30 minutes, and a task in review does not count as stuck while the base is red.
- After a merge, merged `worktree-agent-*` branches with no worktree are deleted.

### Fixed
- Output that is not a terminal is no longer cut, and `cq decide` keeps its whole lines in a terminal too.
- A track's owner question no longer stays in a file nobody opens: `cq receive` shows it, also with no commits, and opens a card in
  `cq decide` and on the board. `cq receive` also says when a delivery is PARTIAL, and when its commit count is wrong.
- `cq add` warns when a mission names a protected path it does not own, and the track delivers PARTIAL with a question
  instead of stopping late.
- A fix task from the base gate or CI watch starts even when tasks in review fill the slots. Hard stops still apply.
- `cq doctor` and `cq setup` say when the project's mission template, docs or status line differ from the plugin. The
  fix is `cq setup --overwrite`, which replaces your own edits in those files.
- `cq takeover` without a queue says to run `cq init` instead of crashing.
- `cq fill`, `cq show` and `cq decide` name a task held back by an uncommitted file, and `cq setup` says what to commit
  and that `cq init` comes next.
- The fix round after red quick gates names the gates and shows their output. A `cq resume` right after `cq receive` is the
  same round and counts once. `cq resume` warns about an unfinished merge in the main tree.
- `cq decide` advises putting a task started without an agent back in the queue, on the board too.
- `cq merge <id> --resume` on a done task removes what an earlier cleanup left. `cq set <id> cancelled` says what stays and
  how to drop it. `cq doctor` lists every leftover branch, and gives its own advice for one that still has a worktree.

## 0.8.17 (2026-11-04)

### Fixed
- `cq merge --resume` left the worktree and the branch when the project path had another spelling than the one git prints,
  such as a link or a short Windows path. The cleanup now compares real paths.

## 0.8.16 (2026-11-04)

### Fixed
- `cq setup` wrote `main` and `npm run lint` from its template. It now reads the branch and the checks from the project,
  and `cq doctor` names a branch or a gate script that does not exist.
- Merge stops and a red base reach the owner: each stop has its own code and its own text in `cq decide` and on the board,
  and only real conflicts count as conflicts. A green `cq receive` closes `gate-red`.
- A whole `cq merge` removes the worktree and the merged queue branch, also at `--resume`. `cq doctor` names merged agent
  branches that are left behind.
- `cq cost` counts an undone merge as a defect, and only fix rounds that really ran.
- `cq setup` writes the plugin's absolute status line path to `.claude/settings.local.json`, and moves an old one there.
- `cq doctor` and `cq fill` warn about a git identity `cq merge` will refuse, before the agents spend tokens.
- `cq push-check` no longer fails before the first push. It says that is normal and what comes next.
- `cq setup` adds `.env`, `.env.*` and `!.env.example` to `.gitignore`.
- `cq receive` on a branch without commits no longer guesses that the work was merged. It says the task stays as it was,
  and names the next steps.
- A cancelled task closes its open block.
- `cq mode` changes one word. `push.mode` no longer made it rewrite the whole config. It also says to commit the file.
- `cq takeover` warns about another orchestrator only with a cursor or a running task, not after setup or `cq add`.
- `cq kickstart` says only what it knows about CI: the config exists, not what it runs.

### Added
- `cq add --depends a,b` in lite mode. An unknown id is refused.
- `cq add` warns when a task owns a protected path, since that lets its changes past the merge guard.
- `cq receive` names `--scratchpad` in its merge line when `cq merge` would not find the folder itself.
- The guide says what `--scope project` limits.

## 0.8.15 (2026-11-04)

### Fixed
- Track agents could not write their report. Claude Code refuses subagents a file named `report.md`, so reports, the
  `GATE` line and the sections read from them were lost. The file is now `track-result.md`, and a `report.md` is still
  read. `cq receive` also reads the `GATE` line from the agent's answer, and warns when the file is missing.
- `cq merge` merged what `cq receive` had just stopped. It now refuses while the quick gates are red from the last
  receive: a fix round on the same commit, a new `cq receive` after new commits. `--force-red-gate` overrides, on the
  owner's word, and is logged as `gate-red-overridden`.

### Changed
- Track missions name `track-result.md`, and say what to put in the answer if the file is refused.

## 0.8.14 (2026-11-04)

### Added: checks you can add one step at a time
- `cq kickstart` shows what the project has and one next step in plain words: git, gates, secret files, then CI. It reads
  only, and works before `cq init` and without git. `/cq:kickstart` explains it for someone new to all of this.
- `cq kickstart gates --apply` sets the checks your project already has as gates, never over gates already set. It reads
  Node/TypeScript and Python. The skill reads other stacks itself.
- `cq kickstart add` proposes a step as a task. It starts only when you approve it, and it uses tokens like any other task.
  A step you cancel stays declined.
- The board shows the same steps under Settings, with a short line in the status bar while something is missing.

### Added: known bugs can become gates
- A bug that can happen again becomes a gate task, from a line `GATE <failure class>` in `report.md` or from
  `cq gate "<failure class>"`. `gates.fromKnownBugs` chooses `propose` (default), `auto` or `off`. `auto` uses tokens
  without asking.
- At most three gate tasks are open at a time. A bug stopped by that limit is not saved: the message names it and asks you
  to approve or cancel an open task first. The same class again adds the new place to the open task, and a class you
  cancelled is not proposed again.

### Changed
- The hints about missing checks now point to `/cq:kickstart` instead of `/cq:setup`.
- Track missions have a new paragraph about the `GATE` line.

### Fixed
- `cq init` and `cq setup` stop outside git in a plugin install and say to run `git init` first. They used to write into
  the plugin's own folder.

## 0.8.13 (2026-11-04)

### Changed: a project with no checks now hears about it
- The push guard asks before a plain push of the base branch when the project has no CI config or no gates, also on a
  first push. It says what is missing and how many commits go out, and points to `/cq:setup`. It never blocks.
  `"push": { "controlsWarning": false }` turns the question off. CI is detected by its config file, which does not prove
  that it runs on this push.
- A K task in such a project gets a short agent review (`reviewer-light`): plain misses against the mission, secrets,
  access and injection. This uses tokens. `cq helpers` shows what it has cost, and `cq helpers off reviewer-light` turns it
  off.

### Added
- `cq receive` says `NO CHECKS RAN` when there are no quick gates and no done command.
- `cq merge` records a verification status on the task: verified (your gates or done command passed), audited (only an
  agent review ran) or unverified (nothing ran). A review alone never makes a task verified.
- Cards on the board show **Merged, not verified** or **Audited**, and the detail panel shows the status. Tasks merged
  before this version have no status.
- `cq push-check` names the missing controls.

### Fixed
- Mission text is the same on every platform. A Windows checkout of the mission template left one extra blank line in
  track prompts, and the Ubuntu CI jobs for 0.8.12 failed on it. The difference was whitespace only.

## 0.8.12 (2026-11-04)

### Changed: check this if a check needs a token
- Gates, `done_when`, the base gate and `qa auto` now run without tokens, cloud keys and variables that point to the
  queue's data folder. Variables are dropped by name (such as `GITHUB_TOKEN`, `*_API_KEY`, `AWS_*`, `SUPABASE_*`), the
  rest are kept, and no setting lets a dropped one through. A check that reads one from the environment fails until it
  gets the value another way. This guards against accidents and simple cheating. It is not a sandbox.
- `cq receive`, `cq merge` and the push check compare git hooks and git config that run code against an accepted
  baseline, and stop if they differ. The first run accepts what is there. After installing husky or lefthook, or
  changing a git alias, run `cq surface accept --by owner`.

### Added
- `gitSurface` in `queue.config.json`: `stop` (default), `warn` or `off` for the baseline check above, for repositories
  where it gives too much friction.
- `cq surface` shows each difference against the baseline, with the full path of a hook and the file a setting comes
  from.
- `cq unlock` shows who holds the queue lock, and `cq unlock --force --by owner` releases it.
- `cq attempt list <id>` and `cq attempt close <id> --outcome <...>`: each start of a task is now a recorded attempt, and
  a running attempt blocks a new one until it is closed.
- Gate evidence entries say what they covered (runner, shared links, untracked and ignored files).

### Fixed
- A hook planted during a gate run made that run red, but a rerun could go green. A hook written outside a gate run was
  never seen. Both now stop against the baseline.
- Only the orchestrator writes gate evidence, per commit and gate setup, and a run that changes the evidence store is
  recorded red. Base health reads only this trusted evidence.
- The queue lock has an owner: a live holder on the same machine is never taken over, and a holder that lost the lock
  can neither publish nor remove it. `cq doctor` uses the same rule, so it no longer calls a live holder stale.
- The command notes in `queue.mjs` describe the actual fields in `queue-fill.json`.
- The test run ended with exit 1 although every test passed ("Timeout calling onTaskUpdate"). The 0.8.10 explanation was
  wrong: the cause is `spawnSync` blocking the test worker past vitest's 60 s limit, not the number of workers. The event
  loop now turns after each test and inside the two longest tests. This reduces the error but does not remove it: on a
  heavily loaded machine a run can still end with one such error.

### Internal
- Fill, start and resume build a client-neutral mission description, and the Claude Code format comes from an adapter.
  Compatibility snapshots check that the Claude output is unchanged. This is groundwork for other clients: no other
  client is supported yet.

## 0.8.11 (2026-11-03)

### Fixed (found by the first CI run)
- `cq init` now adds the data folder to `.gitignore` also when the project path is a Windows short name
  (`C:\Users\RUNNER~1\...`) or goes through a symlink; real paths are compared. Before, nothing was added.
- The bench path check uses the path rules of the platform it is asked about, so it gives the same answer on Linux.
- A test of file times allows the sub-millisecond rounding Linux file systems give.

## 0.8.10 (2026-11-03)

### Added
- CI for Ravenseat itself: the full test suite on Linux and Windows with Node 20 and 22, on every push to `main` and
  every pull request. Actions are pinned by commit SHA, the workflow has read-only access. Badge in the README.

### Fixed
- The test run could end with exit 1 although every test passed ("Timeout calling onTaskUpdate" on a busy machine):
  vitest now uses half the cores.

## 0.8.9 (2026-11-03)

### Fixed
- Docs now match the code on security: deleted tests and skip markers give a warning at receive, not a merge stop;
  the secret scan covers each commit in a base-branch push from Claude Code, with its known gaps listed (first push,
  over 2 MB, timeout, fail open); the quarantine rule is described as a recommended pattern, not a control.
- Stale code comments in `shellCommands.js`, `configGuard.js` and `secretScan.js`.

## 0.8.8 (2026-11-03)

### Changed
- README reorganized and cut to about half: the product promise, Quick start before the diagrams, two infographics
  (task flow, and Claude Code plus the optional board), decisions in one place, "Agents don't grade their own
  homework", a lite vs full table, one cost number with its caveats, and who it is for.
- New docs pages for what left the front page: `full-mode.md` (classes, helper agents, focus, guards, load guard,
  recovery), `costs.md` (the token measurements), `commands.md` and `why-i-built-it.md`. The board tour moved to
  `board.md`, the architecture infographic to `orchestration.md`, and the sandbox caveat to "Guarantees and limits".

## 0.8.7 (2026-11-02)

### Changed
- README: chat-first hero and Quick start in plain words ("set up the queue", "start the queue", "what is waiting on
  me?"), a note that phone access uses Claude Code's Remote Control, and red checks described as "your configured
  checks fail before a merge".
- README: a contents line, a "Who it's for" section, "What it gives me now" folded into `<details>`, the class letters
  K, U, D and D+ explained, and K's review listed as "your gates (no reviewer agent)" with what that means when no
  gates are set up.
- README: "every board action has a command" narrowed to every change the board makes to the queue (CLI parity lists
  the one remaining gap).

## 0.8.6 (2026-11-02)

### Changed
- New board screenshots from the demo project, showing the 0.8 board with the Decisions tab.

## 0.8.5 (2026-11-02)

### Changed
- README: four main points instead of six ("parallel work that stays out of each other's way", with `cq conflicts`),
  the guarantees table moved to the guide (`#guarantees-and-limits`), and the "Ken sent me." line removed.

## 0.8.4 (2026-11-02)

### Changed
- `cq init` adds the queue data folder to `.gitignore` (only in a git repo, only when not already ignored).
- README: a shorter quick start (decisions through `/cq:decide`, details moved to the guide) and a "when something
  fails" line above the loop.

## 0.8.3 (2026-11-02)

### Changed
- README: opens with autonomy ("Your agents keep building. You make the decisions."), shows the self-correcting
  loop, a simpler quick start without internal commands, and a local-first line (no hosted service, no new CI).

## 0.8.2 (2026-11-02)

### Changed
- README: quality you can check up front, `cq setup --ci` explained, merge recovery, and a table of what Ravenseat
  checks versus what needs a boundary outside it, with the known gaps in the command guard.

## 0.8.1 (2026-11-02)

### Added
- **`cq merge` survives interruptions:** one merge at a time (`merge.lock`, stale-lock takeover), a refusal while git
  has a merge, rebase or cherry-pick in progress, a check that the track tip is in base before `done`
  (`merge_commit` stored on the task), and `cq merge <id> --resume` to finish the remaining steps after Ctrl-C, a
  crash or a stop.
- **queue.json.prev** keeps the previous good queue state on every write, and the rename is retried on Windows
  EPERM/EBUSY/EACCES. A broken queue.json stops the CLI with the way back, and `cq doctor` names it too.
- **More secret rules:** JWTs, Supabase `sb_secret_`, npm, SendGrid, Hugging Face, DigitalOcean, Google OAuth, GCP
  service accounts, URIs with passwords and `.env` value lines, and cloud key names in the generic rule.

### Fixed
- A `queue.config.json` that exists but does not parse no longer runs on the defaults: the CLI stops with
  file:line:column and a hint (`cq doctor` and `cq help` still run), and a BOM is accepted.
- The secret precheck scans every pushed commit (`git log -p`), not only the net diff.

### Changed
- `protectedPaths` also covers `.husky/`, lefthook, `.npmrc`, `.yarnrc(.yml)`, `.pnpmfile.cjs`, `.vscode/`,
  `.gitattributes`, and `CLAUDE.md` / `.claude/` at any level, and the match ignores case.
- **Queue agents are locked down:** tracks, reviewers, helpers, `ask` and `reviewer-area` can no longer push in any
  form, and may run only an allow-list of queue commands (no merge/set/edit/approve/resolve/undo, no `--allow-guard`,
  `--force` or `--by owner`). `owned_files`, `shared_patch`, `owner_db` and `migr_block` are locked after start like
  `done_when`. The push guard reads nested commands (`bash -c`, `pwsh -Command`, `cmd /c`, `&`, `( )`, `$( )`,
  backticks, `eval`, `git -c alias.*`) and asks or denies when it cannot. Deleting the base on the remote is denied
  for everyone. A broken config makes the hook ask before push, migrate and deploy.

## 0.8.0 (2026-11-02)

### Added
- **Transcript metrics:** per-model cost with a price table per family (Opus, Sonnet, Haiku, Fable; `prices`
  override), tool calls and errors, API errors, active time (`metrics.idleGapMin`), and killed agents measured from
  their transcripts; shown in `cq cost`, `log-time --cost` and the Statistics tab.
- **Safety baseline:** `cq doctor` checks secret files, empty gates, missing CI, lockfiles, `productionBranch` and
  large files; the push guard scans what a base-branch push sends for secrets (gitleaks or built-in patterns) and
  asks before `deployCommands`; `cq setup --ci` offers a GitHub Actions template that runs your `gates.quick`.
- **`cq wait`:** a background waiter the orchestrator starts when only owner items are left. It exits with
  `OWNER ACTED: <action> <ids>` when the owner answers, approves, does QA, adds or edits on the board (exit 10 on
  `TIMEOUT` after 8 h), so a board answer starts the next round. "Waiting on you" on the board says "Orchestrator
  listening" while it runs.
- **Event rows in the time log:** the orchestrator session's cost (status line, compaction and SessionEnd hooks)
  shown as orchestration overhead in `cq cost`; fix rounds, merge conflicts, base gate verdicts, triage verdicts and
  pushes as a Flow view in `cq cost` and the board's Statistics tab (first-pass rate, fix rounds per task, conflicts
  and pushes per week); a load row per fill/start with a Load history in `cq limit`.
- **Done lock and acceptance criteria:** `done_when` and the new optional `acceptance` criteria
  (`cq add/edit --accept`) are locked once a task starts: only `--by owner` or the board may change them, never from
  inside a track worktree, undo included. The mission lists them as "Acceptance criteria (fixed, do not change)",
  `cq info` and the board's detail panel show them, and reviewer-gap answers MET / NOT MET / UNCLEAR per criterion
  (NOT MET is a HIGH finding).
- **Guard tests:** the merge guard protects the test, lint and type configs by default (glob entries in
  `protectedPaths`: vitest/jest/playwright/cypress/karma/mocha configs, tsconfig*.json, eslint/biome, pytest.ini,
  tox.ini, setup.cfg, conftest.py, pyproject.toml, mypy.ini, .coveragerc, .flake8, .golangci.*, Cargo.toml,
  Makefile/Justfile, .pre-commit-config.yaml, phpunit.xml*, .rspec). `cq receive` warns about test weakening
  (deleted test files, test files moved out of the test paths, added skip/focus markers) with one WARN line and a
  Test weakening section in 00-package.md (`testWeakening.enabled`, `testPaths`, `markers`).
- **Quality figures:** right first time, post-merge defects and owner interventions per 10 merged, autonomy
  (verified tasks per owner intervention, longest stretch without the owner, failures corrected without the owner),
  reviewer hit rate per type with a "0 fixes in N runs" hint, and inflow by source with a 3-week growth hint, in
  `cq cost`, `--json` and the board's Flow box. `cq finding --cause <id>` and `cq resume --from <reviewer,...>`
  record the links.
- **`/cq:review <area> [<lens>]`:** review a path, feature or project through a lens (security, logic, ux,
  architecture or free text) with read-only Opus `reviewer-area` agents. Every finding gets file:line, severity and a
  class; after one owner question, one-off bugs become fix tasks, repeatable mistakes become `gate` tasks that add a
  red-first check to the project's own CI, and design questions become owner questions or plan entries. The review
  is recorded as a `PL-REVIEW-…` plan entry.
- **Decide or ask:** tracks fix technical failures themselves and ask the owner only on unclear requirements,
  hard-to-reverse choices (data model, public API, new dependency, deletion) and security or legal tradeoffs; other
  assumptions go in a new "Assumptions" section of report.md.
- **Gate evidence bound to the sha:** `cq receive` no longer trusts the track's `RESULT gates=` line or its gate rows
  in the time log. It needs a green, clean quick-gate run on exactly the delivered tip, recorded by `gates.mjs` for
  the orchestrator in `gate-evidence.json`, and otherwise runs the quick gate itself in the track's worktree (red:
  fix round, exit 1/8; dirty or missing worktree: refused, exit 1). The base gate's skip rule reads the same store.
  `push-check` is BLOCKED and the push guard asks when the tip has no green `cq gates --full` run from the main
  checkout. Queue agents may not pass `--evidence`/`--cwd` to the gate runner or touch the store.
- **Focus end:** when every focus stage is done or the focus period is over, the queue no longer continues silently.
  With `focus.continueWhenEmpty` off (the default) fill starts nothing, `focus.finished_at` is recorded, and one
  owner question "Focus X is done: set a new focus or continue the regular queue?" appears in Waiting on you;
  answering "Continue the regular queue" lifts the pause. On keeps the old behavior with one notice line. Per focus:
  `cq focus set ... --continue-when-empty on|off`; `cq focus` and `cq doctor` know the setting.
- **`/cq:decide` and `cq decide`:** one list of everything waiting on you, most impact first, with the board's new
  Decisions tab (the landing view when anything waits; one-click answers with undo; keys j/k/Enter/1-4/u).
  `approve` and `qa ok` record `--by owner`. The Cloud tab is hidden by default (`board.showCloud`,
  `cq board-setting cloud on`). The Focus view sets what happens when the focus is done and shows FINISHED /
  QUEUE PAUSED. `docs/cli-parity.md` maps every board action to its command.
- **CI watch after a batch push:** `push-check --watch-ci <sha>` (`push.ciWatch: "github"`, default off, needs gh).
  A failed check gives one fix task `CI-<sha7>` and a red base (exit 9); an infrastructure failure gives an owner
  question and no freeze; a timeout exits 10. Only a redacted tail of the failed log is kept.
- **Flaky check before freezing the base** (`baseGate.flakyRerun`, default on): a red base gate reruns only the
  failed commands once on the same sha. Green is recorded as flaky (a finding, a `flakyGate` row in `cq cost` Flow)
  and does not freeze; red twice freezes.
- **Write guard hook** (`hook-write-guard.mjs`, Write|Edit|NotebookEdit): queue agents can no longer write the gate
  evidence store or the queue's `queue.json` and `base-health.json` with the file tools.
- **Review fixes (package E):** the context hook counts compactions incrementally (only the new transcript tail is
  read, cached in `compact-count.json`); worktree cleanup deletes without a shell (paths with `&` are safe);
  `cq doctor` warns about a leftover MERGE_HEAD, `disableAllHooks` in Claude settings, and done tasks whose merge is
  missing from the base branch.
- **Conflict prediction:** `cq orchestrator pulse` and the new `cq conflicts [--json]` check running and delivered
  track tips against the base and each other with `git merge-tree --write-tree` (cached per sha pair,
  time-budgeted, with a suggested merge order; git older than 2.38 falls back to file overlap and `cq doctor` says
  so). A real conflict in `cq merge` names the files and the other tasks that touched them in the fix round brief.
- **`cq ask <id> ["<question>"]`:** answer a question about an earlier track without resuming its agent. It builds a
  size-capped, secret-redacted bundle (mission, report.md, handover.md, queue notes and owner answers, commits and
  diffstat, transcript tail); `--bundle` writes it for the new `/cq:ask` skill and read-only `ask` agent, `--json`
  describes it.
- **Gate from incident:** after a post-merge defect, a red base or an owner-found bug, the orchestrator proposes a
  `Gate: <failure class>` task when the class is repeatable. Gate tasks are red first: the check is shown failing on
  the original bug and passing on the fix, both runs in the report.

### Changed
- README: parallel chats colliding (push and file conflicts) added to the pain points; "What the guards are not"
  (guard rails, not a sandbox) in the safety baseline; the board as the interface, orchestration as the product.

## 0.7.0 (2026-11-02)

### Changed
- **New name: Ravenseat.** The repo is now `vegardjorg/ravenseat` and the marketplace is `ravenseat`; the plugin is
  still `cq`, so `/cq:queue` and every `cq` command stay the same. The update banner, the docs and the install lines
  use the new name. **Moving an existing install:** `/plugin marketplace remove claude-code-queue`, then
  `/plugin marketplace add vegardjorg/ravenseat` and `/plugin install cq@ravenseat`. Your queue data is not touched.
- **The Ravenseat logo** (two ravens on the high seat) is the board's default picture; the raven on the right does the
  talking. The mascot is a switch under **Logo and mascot** in the gear. The README opens with the logo.

## 0.6.0 (2026-11-02)

### Added
- **Intake triage:** a cheap read-only `triage` helper checks tasks that waited `triage.minAgeDays` (3) days or were
  added by an agent before a track starts. `cq fill` skips them, prints the triage step in the same turn and keeps
  starting the others. `cq triage <id> --verdict ready|done|stale|adjust` records the answer: adjust adds the note to
  the mission, and done and stale become an owner question with choices, never an auto-close. Off with
  `cq helpers off triage` and in lite mode; the board shows its cost and verdicts.
- **Base gate:** `cq merge` records the base branch's health per tip after each merge (the quick gates by default,
  or `baseGate.commands`). A red base refuses further merges (exit 9, `--force-red-base` is logged), adds a value-10
  fix task `<id>-BASE<n>`, and shows in `cq show`, the pulse and the board status line. Gate rows now carry the sha
  and whether the tree was clean, and `gates.mjs` takes `--timeout-sec`.
- **Push threshold:** config `push` (`mode` owner or threshold, `minTasks` 10, `warnTasks` 50, `maxAgeHours`) counts
  merged tasks since the last push. `cq push-check` prints the batch and READY, NOT YET, BLOCKED, LARGE or NOTHING;
  the push guard asks before a plain base push below `minTasks` or on a red base (it never denies); `cq doctor`
  checks the push keys and warns about push workflows without `concurrency` `cancel-in-progress` or path filters;
  the board's status line shows the batch.

## 0.5.0 (2026-11-02)

### Added
- **Choices on owner questions:** a question can carry 2-4 answer options (`choices`):
  `cq question <id> --choice "..." --choice "..."`, answer with `cq resolve <id> --choice <n|text> [--answer "note"]`
  or one click on the board's "Waiting on you". The choices are listed numbered in `cq question`, `cq resolutions` and
  the after-compact summary.
- **Done command and fix-round cap:** a task can name a done command (`done_when`). The mission states it, `cq receive`
  and `cq merge` run it in the track's worktree (budget `doneCheck.timeoutSec`, only the last `doneCheck.tailLines`
  lines are kept), and a red run gives a fix round instead of a review or merge. Fix rounds are capped per task
  (`maxFixRounds`, default 3, task field `max_fix_rounds`); at the cap the task becomes an owner question
  (`<id>.fixcap<N>`, blocker `owner-question`, exit 8).
- **Cost per task:** `cq cost` shows the cost per task including all its runs: fix rounds, continuations (`<id>-rN`)
  and the fix tasks that point to it. "USD per merged change" uses these totals, so a done fix task is counted with
  the change it fixes, not as a merged change of its own. `--json` has `perTask`.
- **`cq doctor [--json]`:** a read-only health check of Node and the `node` the hooks find, the hooks and their
  scripts, `queue.config.json`, the state files, a stale lock, half-deleted worktree folders, missing git worktrees and
  branches of finished tasks. Each line is OK, WARN or FAIL with a fix hint; exit 1 on any FAIL.
- **`cq finding "<title>" [--detail] [--task] [--files a,b]`** and `cq finding list [--all]`: a track reports
  something outside its scope as an idea in the plan register (`PL-FINDING-<n>`), linked to the task and
  deduplicated on the title. `orchestrator pulse` and `cq show` print the number of untriaged findings, and the track
  prompt tells tracks to use it instead of fixing.
- **Lite mode** (`"mode": "lite"` in `queue.config.json`, `lib/liteMode.js`): a zero-config mode with the core loop
  only. `cq add "<title>"` adds a task with just a title (optional `--mission`, `--priority 1-10`, `--files`, `--id`);
  the id (`T-001` ...), class K, value 5, size 30 min and the mission (the title) are filled in. Lite skips the
  small-task guard and the batch queue rules on `add` (a `batched` flag is dropped with a note), tasks run in the
  order added unless `--priority` is set, and `cq help` lists only init, add, show, fill, receive, merge and the owner
  questions. Owner questions work as before. Every other command still works when typed. The queue, parallel-wave,
  add-to-queue and setup skills have a short lite branch (`cq mode`). README: "Quick start (lite)".
- **`cq mode [lite|full]`** shows or switches the mode (writes only the `mode` key and keeps the rest of the file),
  and **`cq init --lite|--full`** does the same at init. A fresh `cq init` (no queue yet) without a flag writes
  lite when the config has no `mode` of its own; lite gets the project `tasks` (prefix `T-`). A config without `mode`
  is full, so existing installs do not change.
- **Model per agent**: `models` in `queue.config.json` (agent name to `opus`, `sonnet`, `haiku` or `fable`, e.g.
  `{ "reviewer-docs": "sonnet" }`). The start lines from `fill`, `start`, `resume` and `receive` then say `model=<m>`
  (also `model` in `queue-fill.json`), and the orchestrator passes it to the Agent tool. Empty by default (each agent
  file's model); an unknown value is ignored. Measure the effect with `cq cost`.
- **Gate rows in the time log**: every `cq gates` run (`--quick`, `--full`, `--precheck`) appends one `gate` row
  (track, branch, kind, gates, failed, duration, ok, exit, attempt, timed_out). `cq merge` passes `--track`; `attempt`
  above 1 is a rerun. Fail open.
- **Compaction rows in the time log**: `hook-after-compact.mjs` logs each main session compaction (scope `session`,
  with an `orchestrator` flag), and `hook-track-context.mjs` logs each new track compaction (scope `track`, with the
  running count).
- **`fixes` task field**: a fix task names the task id(s) it fixes. `add` and `edit` check that the ids exist,
  `cq info` shows `fixes` and `fixed by`, `cq state` lists open fix tasks as `fixLinks`, and `qa deviation` sets it.
- **The benchmark reads these rows**: gate runs and reruns per task, compactions per task and in orchestrator sessions
  (when the transcript shows none), and `fixes` links as defects after merge, whatever the defect window. It also reads
  cq's `added_at`.
- **Calibrated cost estimates** (`lib/costEstimate.js`): per class and class + size bucket, the median measured USD of
  done tasks in the last 28 days (at least 5), otherwise the static model corrected by the class's measured/model
  ratio, otherwise the static model. Shown as `~$x` next to the minute estimate in `show`, `show --full`, `next`, the
  `fill` lines and `info`, and as `costEstimate` in `state`. With `dailyBudget` set, `next` and `show` print a budget
  outlook line (information only; the guard still stops on measured usage).
- **`cq calibrate [--days 28] [--min 5] [--json]`**: per class n, the median actual/estimate ratio for minutes and the
  suggested weight, the median measured USD, the model's USD and the cost correction factor. Read-only.
- **USD per merged change**: all measured cost in the window (time log: tracks, reviewers, helpers, fix rounds,
  cancelled and open work, agents without a task) divided by the tasks that reached done. The first line of
  `cq cost` (window `--since`, default 28 days; `--json` too) and the first key figure in the board's Statistics
  (14 days). Per content minute is only a secondary, estimate-based figure.
- **Load-aware parallelism** (`lib/loadSlots.js`): `fill`, `next`, `start`, `show` and `state` open fewer than
  `maxConcurrent` slots while the machine is loaded, instead of all or nothing. All slots at or above
  `loadGuard.allSlotsFreeMemoryPct` free memory (default 40, off on macOS), `loadGuard.minSlots` (default 1) at the
  hard limit `minFreeMemoryPct`, linear in between, rounded down. CPU is optional (`allSlotsCpuPct` and
  `minSlotsCpuPct`, off by default). The commands print why (`LOAD: 2 of 5 slots: free memory 18 % (all slots from
  40 %)`), `state` has `loadSlots` and `cq limit` shows the slots now. `loadGuard.adaptive: false` or
  `QUEUE_LOAD_ADAPTIVE=off` turns it off; `fill --over-load` and `start --force` skip it. The hard load guard (exit 7)
  is unchanged. Why: a heavy user's data showed that with many parallel tracks the machine, not tokens, was the limit:
  the median gate time more than tripled from 1-2 to 3-4 running tracks, and most gate runs were reruns.
  `QUEUE_LOAD` also takes `cpu=<pct>`.

### Changed
- **The board client is split into modules**: the 7,300-line `queue-board/board.js` is now 17 classic scripts in
  `queue-board/board/` (core, api, cards, draw, views, menus, statistics, settings, inbox, panel, edit, select, bulk,
  interact, top, cloud, start), loaded in order with `defer` and sharing one scope. Pure move: the code is the same
  statement for statement, and the board looks and works as before. The server allow-lists each file by name; the
  Content-Security-Policy is unchanged. A new test (`queueBoardServe.test.ts`) checks that every file is served with
  the right type and the same CSP.
- **`queue.mjs` is split into modules**: the file of about 6,300 lines is now the usage comment and the dispatch on
  the command word, and the commands' code is in `scripts/orchestrator/cli/` (one module per area of 140 to 600 lines,
  the shared state in `cli/context.mjs`). The code was moved as it was: every command gives the same output, exit
  codes and files. A new test (`__tests__/queueDispatch.test.ts`) checks that every command word reaches an exported
  function.
- **`lib/queueLogic.js` is split into modules under `lib/logic/`** (about 7,350 lines into 22 modules of 100 to 670
  lines: base, projects, evidence, validate, conflicts, ranking, questions, commits, guards, batch, edit, focus,
  select, pick, external, cloud, agents, results, classify, merge, monitor, resume). Pure move, no behaviour change:
  `queueLogic.js` stays as a facade that re-exports exactly the same names, so every `require('./queueLogic.js')`
  keeps working. A module requires only the modules below it (no require cycles); the layout is in the header of
  `queueLogic.js`. `lib/__tests__/queueLogicFacade.test.ts` locks the export names and checks that each module loads
  on its own. The installer and the plugin copy whole folders, so the new folder ships without list changes.
- **The bench load sampler counts processes on Windows**: `tasklist` did not finish within the timeout on a loaded
  machine, so `processes` and `node_processes` came out null. It now uses PowerShell `Get-Process` (45 s timeout),
  with `tasklist` only as the fallback when PowerShell is missing.
- **Hooks run in exec form**: every hook in `hooks/hooks.json` and `settings.queue.json` is `"command": "node",
  "args": ["<root>/scripts/orchestrator/hook-x.mjs"]`, so Claude Code spawns node directly instead of through a shell.
  On Windows the shell is Git Bash, started on every call: with the PostToolUse hook on every tool call, this cuts the
  hook start by about 40 % (measured on a loaded Windows machine, 20 calls each, two runs: median about 1.9 to 2.1 s
  exec form against 3.3 to 3.4 s shell form). Tested live on Claude Code 2.1.316: the hook runs as a direct child of
  Claude Code (no bash.exe), `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are substituted in `args`, and the
  additionalContext of a synchronous exec-form PostToolUse hook reaches the subagent. `setup --hooks` / `install.mjs`
  rewrite the older shell-form queue hooks in `.claude/settings.json` to exec form (other hooks are left alone), and
  the board's setup check accepts both forms. Needs `node` on PATH as a real executable (`node.exe` on Windows).
- **The 400k block in other chats is opt-in**: chats that are not the orchestrator get the notice from 250k, but the
  message is only stopped at 400k with `contextGuard.blockOtherChats: true` in `queue.config.json`
  (`CONTEXT_BLOCK_OTHERS=1` overrides). The orchestrator's compact, wind-down and hard stop are unchanged.
- **The load guard is on by default**: `loadGuard.minFreeMemoryPct` is 10 (no new starts while free memory is below
  10 %), off on macOS, which counts the page cache as used. In one heavily used project, 14 parallel tracks made DB
  tasks take 165 instead of 34 minutes and gates go red from memory, not code. `cq limit minFreeMemoryPct off` turns it off for a queue.
- **The quota forecast and `cq forecast` price the queue with the calibrated estimate**: `capacity`'s queue cost and
  the forecast's expected cost sum the calibrated estimate per task (by class and size) instead of the static model or
  remaining count x one median. The order of the queue is unchanged (the priority still uses the minute estimate).

## 0.4.1 (2026-10-31)

### Added
- **`cq help` in groups, and "Did you mean"**: `cq help` prints 14 key commands in four groups (Get started, Daily,
  Owner, Orchestrator) instead of about 200 lines; `cq help all` prints every command with its full description (the
  old filter cut many off mid-sentence) and puts the internal scripts (make-queue-common, make-mission,
  cost-guard-statistics, context-measure, statusline) under "Internal"; `cq help <command>` prints one command in full,
  or a script's header. An unknown command prints `Unknown command "shwo". Did you mean "show"? See cq help.` (edit
  distance up to 2, or a prefix; nothing when nothing is close; exit code unchanged). The logic is in `lib/cliHelp.js`.
- **Forecast**: `cq forecast [--project <pid>] [--days 28] [--json]` says when the remaining tasks (the focus stages,
  otherwise all open work) are done at 50, 85 and 95 %, from a Monte Carlo over the daily throughput in the window
  (zero days included), with the sample size and the expected cost (remaining x median measured cost). "Not enough
  data" under 5 done. The board shows it as a box in the Focus view and a line in Statistics (`lib/queueForecast.js`).
- **Auto-accept of proposals** (default off): `cq proposals auto on|off [--classes K,U] [--max-estimate <min|none>]
  [--max-value <1-10|none>]`, `cq proposals log` and `cq proposals undo <id>`. A proposal that fits the rules is
  approved by `cq add` and `cq orchestrator pulse` through the approve path, with a remark and a log entry
  (`auto_accepted`). Never D or D+, `waiting_on`, legal/owner labels, a plan entry with open legal points or a
  protected path. Config default `proposals.autoAccept`; the board's gear has the switch, the rules and the log with
  Undo (`lib/queueProposals.js`).
- **Cancel, decline and edit from the board**: the detail panel has **Edit** (value 1-10, content minutes, class;
  checked like `cq add` / `cq edit`) and **Cancel task** for waiting tasks, and **Edit** and **Decline** for
  proposals (also in **Waiting on you**). Cancel and decline ask first, take an optional reason (saved as a remark)
  and show **Undo**. Running and review tasks are not cancelled from the board; the panel shows the CLI command
  instead of "No actions for this status". New `cq cancel <id> [--remark "…"] [--json]`: the same result as
  `cq set <id> cancelled --remark`, but logged in the changelog so `cq undo` puts the task back; `cq edit` takes
  `--answer-json`. The board posts to `/api/task-edit`; the rules are in `lib/queueTaskEdit.js`.
- **Started without agent**: `cq show`, `cq state` (`withoutAgent`) and `cq orchestrator pulse` warn about tracks
  marked running for more than 15 minutes whose branch no worktree has checked out and that have no report, with the
  fix (`cq set <id> waiting`, then `cq fill --ids <id>`). `fill` only marks tracks; when it ran where nobody read the
  output (a background `merge`, a chained merge script), tracks could stand for hours without an agent. The
  after-compact resume text names the check, and `merge` ends its fill excerpt with a note to use `--without-fill`
  when the output is not read.
- **Module switches**: `features` in `queue.config.json` (`plans`, `plans.legal`, `plans.launch`,
  `plans.documents`, `focus`, `statistics`, `cloud`, `follow`; one table in `lib/queueConfig.js`, helpers
  `features()` and `featureOn()`). The board hides the tabs, buttons, filter, detail row and routes of modules that
  are off, and the gear shows a read-only **Modules** section. `cloud*` and `follow*` commands answer "Cloud is off
  (features.cloud in queue.config.json)." (or Follow) with exit 0, and `show` and the pulse skip follow-up lines
  when follow is off. The plan register is never gated in the CLI.
- **First-run card**: a queue with nothing open shows three steps (add work, `/cq:queue`, "Waiting on you") and a
  link to the help instead of empty columns. README: "First run in 5 minutes".

### Changed
- **Off by default**: cloud sessions, follow-up entries and the Legal, Launch and Documents surfaces in Plans. Set
  `features.<name>` to `true` in `queue.config.json` to turn them on.
- `cq diagnose` and the parallelism paragraph (fill, receive, pulse) no longer say LOW PARALLELISM when nothing can
  start (the waiting tasks only wait on running work, a limit or a pause, and no finding would release one).
- **Silent tracks**: `cq show`, `cq state` (`silent`) and `cq orchestrator pulse` print `SILENT` for a running track
  whose agent has a worktree but has shown no sign of life (commit, worktree or track folder mtime, transcript or time
  log) for `limits.silentMin` minutes (default 20, `cq limit silentMin <n>`, 0 = off), with the advice to check it and
  `cq resume <id> --reason context` or stop it. The board marks the card "silent" (measured at most once a minute).
- **Blocker reasons**: `cq block <id> <code> [--note]` and `cq unblock <id>` record `blocks` on a task from one fixed
  code table; `cq merge` opens `merge-conflict` or `gate-red` when it stops there and closes it after the next
  successful merge. `cq blockers [--days 7] [--json]` gives count and blocked time per code, and the board's
  Statistics has the table "Blockers last 7 days".
- **Hiding the mascot needs no password**: **Hide the mascot completely** in the gear is a plain button now (still
  per browser; **Show the mascot again** undoes it).

## 0.4.0 (2026-10-31)

### Changed
- **The network guard covers reviewers and helper agents**: `curl`, `wget`, `iwr`, a pipe into a shell and an
  unknown `npx` package are now blocked (or asked about) for every reviewer and helper agent, builtin or custom, not
  only for `track` and `track-d`. The list is the read guard's (`queueAgentTypes`), also with the `cq:` prefix. The
  orchestrator is still not affected.
- `reviewers.U` is empty by default; the challenger for U now comes from `helpers` (same result, but it can be
  switched off). A config that lists `reviewer-challenger` under `reviewers.U` keeps it as a fixed reviewer.
- The read guard also covers `reviewer-challenger` and every helper agent in the setup.

### Added
- **Fail-fast precheck**: `cq gates --precheck` runs the cheapest checks first, in a fixed order, only on the files
  changed against `baseBranch`, and stops at the first red one. The checks are `gates.precheck` (commands or
  `{ name, command, files, budgetSec }`, with `{changed}` or `{file}`); the default `null` gives `node --check` on the
  changed JS files, `tsc --noEmit`, eslint on the changed files and the related tests (vitest or jest) when the project
  has them locally. A check with no relevant changed file is skipped, each check has a time budget
  (`gates.precheckBudgetSec`, 120 s; exit 3 over it), and `--json` gives a machine-readable summary. The mission
  template and the `track`/`track-d` agents run it before the class's full gate, which is unchanged.
- **Custom helper agents**: `cq helpers add <file.md> [--name] [--classes/--labels/--paths]` (or **Add a custom
  helper** in the board's Helper agents tab) copies an agent file to `.claude/agents/<name>.md` and registers it in
  `queue.json` as `source: custom` with its sha256, off. Nothing in the file is run, and a builtin name is refused.
  `cq helpers scan` (`lib/helperScan.js`) gives red, yellow or green with line numbers for the frontmatter tools and
  keys, calls out of the machine, prompt injection and misuse, hidden content and missing guards. The new `add-helper`
  skill has Claude read the whole file and ask the owner; `cq helpers approve <name> --by .. --sha256 ..` binds the
  approval to the hash (a red scan needs `--force`). A custom helper can only be switched on, and is only picked by
  `reviewersForTask`, while its file matches the approved hash; a changed file is turned off and shown as "Changed
  since approval". The board shows the custom badge, the scan, the review state and who approved it, and can never
  approve. `cq helpers when` changes the conditions and `cq helpers remove [--delete-file]` drops one. The read guard
  and the push guard cover custom helpers, and `merge-track` protects their agent files.
- **Helper agents**: optional reviewers on top of the fixed ones per class, switched with `cq helpers on|off <agent>`
  or the new **Helper agents** tab in the board's settings (saved in `queue.json`, which wins over the new `helpers`
  block in `queue.config.json`). Each runs when it is on and one condition hits: class, label, changed paths, most
  of the diff, a plan entry or the number of mission points. New agents `reviewer-design` (on for `visual`),
  `reviewer-tests`, `reviewer-gap` and `reviewer-docs` (off), adapted from testdouble/han (MIT, see NOTICE);
  `reviewer-challenger` moves into the same system (on for U and `bug`). The reviewers for a task are worked out in
  one place (`lib/queueHelpers.js`) and used by `receive`, the cost per task, the cost guard and the read guard.
  The review package lists each reviewer with a `why:` line and carries the mission as `mission.md`.
- **Helper measurement**: the cost per agent now keeps its tokens, minutes and FINDINGS numbers, so `cq helpers`,
  `cq cost` and the board show per helper the runs, median and total minutes, tokens and USD, its share of the task
  cost and findings per run.
- **Counter-evidence step in every reviewer**: a HIGH or MEDIUM finding is disproved first (reread, look for an
  existing guard or test, check that the change introduced it, lower it one level without ground). Security findings
  are lowered only on counter-evidence at file:line and carry an `EXPLOIT:` part; `Unverified:` lines and a
  self-consistency rule for all.
- **Update banner on the board**: the board server checks GitHub for a newer `cq` at most once per 24 hours (a plain
  GET with a short timeout that sends nothing about you; errors are silent) and shows "cq X is out (you have Y)" with
  a CHANGELOG link and copyable update steps. Close it per version. Off with `board.updateCheck: false` or
  `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- **Setup notice after an update**: `cq setup --settings` records the plugin version in `<dataFolder>/setup.json`,
  and the board says when the installed plugin differs from it (local, works with the check off). The vendored
  installer writes `scripts/orchestrator/cq-version.json` so the board knows that version too.

### Upgrading
Update the plugin, then run `cq setup --settings` once, and restart the session (or run `/agents`) so the new
reviewer agents are picked up.

## 0.3.0 (2026-10-30)

Fixes and features ported back from the queue in the project cq was split out of.

### Added
- **Status line** (`statusline.mjs`): context size, session cost, the 5-hour and 7-day quota and running tracks.
  A plugin cannot set a status line itself, so `cq setup --settings` writes it with an absolute path. Run it again
  after each plugin update.
- **Handover note in two parts** (`cq handover archive|now`): after compaction the orchestrator reads only the "Now"
  part; dated log entries older than 24 hours move to `handover-archive/<year-month>.md`.
- **Quota calibration from the status line**: `cq capacity --calibrate auto` uses the 7-day percentage the status
  line saw last.
- **Adopting running tracks**: a track's `report.md` carries the RESULT signal, so a new orchestrator chat can take
  over tracks that are still running. New commands `cq deliveries` and `cq resume <id> --reason fix|context`; the
  pulse prints NEW DELIVERY, and `cq receive` finds fix-round reports.
- **Migration blocks**: start, fill and pick skip blocks that are already taken; `cq migr move <id> <block>` moves a
  task to another block.
- **Load guard**: no new starts (exit 7) while free memory is below `loadGuard.minFreeMemoryPct` or
  `cq limit minFreeMemoryPct`. Off by default.
- **Focus clean-up**: `cq focus evaluate` and `cq focus clean` take done focus stages out (also automatic, and it can
  be undone).
- **Follow-up entries**: `cq follow add|log|show|report|close|extend` for something to watch over a period, with its
  own board page at `/follow`.
- **QA evidence**: tracks write an `EVIDENCE` line in the report; `cq qa evidence <id> <type>` sets it by hand, and
  `cq qa auto --run` closes entries whose automatic evidence is green. The types are in `config().qa`.
- **`plan check`** also shows index drift against the plan register (field `index` in `--json`).

### Security
- **Merge guard**: `merge-track` stops (exit 4) when a branch changes hooks, settings, agents, the orchestrator
  scripts or the queue config without owning them (`protectedPaths` in `queue.config.json`; `--allow-guard`
  overrides).
- **Network guard for tracks**: tracks cannot run `curl`, `wget`, `iwr` or a pipe into a shell.
- **Data, not instructions** in every agent file and the mission template, checked by `make-queue-common`.
- **Agent limits**: `maxTurns` 400/600 and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` in `settings.queue.json`.
- **Context guards after compaction**: a track that compacts twice or passes 280k stops as PARTIAL; a SubagentStop
  end gate (`hook-track-end.mjs`) stops a track once if it ends without a commit and without a RESULT line; pause
  advice above 150k.

### Fixed
- The plan room no longer shows a raw "null" text when optional parts are missing.
- The board builds the queue lookups once per board instead of once per card: with 3,000 tasks it went from about
  59 s to about 0.15 s.
- The fallback migration pattern in `queue.mjs` had lost its backslashes (the same bug as in `setup.mjs` in 0.2.1).

### Upgrading
Update the plugin, then run `cq setup --settings` once to get the new hooks and the status line.

## 0.2.1 (2026-10-29)
- Fixed the broken hook-path regex in `setup.mjs`, and every shipped script is syntax-checked in the tests.
