# Changelog

All notable changes to Ravenseat (the `cq` plugin, formerly claude-code-queue). The version is in
`plugin/.claude-plugin/plugin.json` and `package.json`.

## Unreleased

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
