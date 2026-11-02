# The work queue (`cq`)

The queue is a JSON file (`scripts/.queue/queue.json`, gitignored) with tasks, owner questions, projects, limits and cost
data. It survives when the orchestrator's chat is compacted or restarted, because nothing important lives only in
the chat. Every command is `cq <command>`. `cq help` prints the key commands in four groups (Get started, Daily,
Owner, Orchestrator), `cq help all` the full usage list (the comment at the top of `queue.mjs`, with the internal
scripts under their own heading), and `cq help <command>` one command in full (or a script's header). A mistyped
command gets one line with the closest match: `Unknown command "shwo". Did you mean "show"? See cq help.` (exit 1).
The texts and the suggestion live in `lib/cliHelp.js`. The table below lists the important ones. In the code,
`scripts/orchestrator/queue.mjs` holds the usage comment and the dispatch on the command word, and each command's
code is in `scripts/orchestrator/cli/` (one module per area, the shared state in `cli/context.mjs`).

Writes happen under a file lock (atomic `mkdir`) and via temp file plus rename, so two writers (the orchestrator and
a track adding a proposal) cannot corrupt the file. `cq undo` undoes the last change.

## A task

```json
{
  "id": "AUTH-3",
  "title": "Rate limit on the login endpoint",
  "domain": "auth",
  "class": "K",
  "mission": "Self-contained description of what to do and how to verify it.",
  "value": 7,
  "content_min": 60,
  "depends_on": ["AUTH-2"],
  "waiting_on": [],
  "owned_files": ["src/auth/rateLimit.ts", "src/auth/__tests__/rateLimit.test.ts"],
  "owner_db": [],
  "shared_patch": [],
  "project": "auth",
  "feature": "Login",
  "source": "docs/auth-plan.md § 2"
}
```

| Field | Meaning |
|---|---|
| `id`, `title` | Unique id and title |
| `domain` | Domain; limits how many tracks run in the same domain (`maxPerDomain`) |
| `class` | `K` code, `D` database, `D+` high-risk database or security, `U` investigation (no production code) |
| `mission` | The mission text. Must be self-contained: the track agent knows nothing else |
| `value` | Value 1 to 10, used for ranking |
| `content_min` | Estimated minutes |
| `depends_on` | Task ids that must be done first |
| `waiting_on` | Registered owner question ids that block the task until answered |
| `owned_files`, `owner_db` | Files and DB objects the task owns exclusively while it runs |
| `shared_patch` | Shared functions the task changes in patch form |
| `project`, `feature`, `source` | Project id (must exist), feature name, and the plan section the task comes from |
| `batched` | `true` for small low-value tasks: they go to the batch queue (`cq batch`) instead of their own track |
| `done_when` | Optional: a shell command (one line, at most 500 characters) that must exit 0 in the track's worktree for the track to count as done, e.g. `npm test -- src/x.test.ts`. The mission tells the track to run it before it reports; `receive` and `merge` run it again (see [the done command](#the-done-command-and-the-fix-round-cap)). `null` in `edit` removes it. A proposal with it is never auto-accepted |
| `max_fix_rounds` | Optional: this task's fix-round cap, a whole number 0 to 20 (0 = no fix round without the owner); overrides `maxFixRounds` in `queue.config.json` (default 3). `null` in `edit` removes it |
| `fixes` | Optional: the task id (or a list of ids) this task fixes. `add` and `edit` refuse an id that is not in the queue (or in the same add) and a task naming itself; stored as a list, and `[]` or `null` in `edit` removes it. `cq info <id>` shows `fixes` and `fixed by`, and `cq state` lists the open fix tasks as `fixLinks`. `qa deviation` sets it on the fix task it creates. The benchmark (`bench/`) counts it as a defect after merge |

Status flow: `proposed` → `waiting` (approved, ready to run) → `running` → `review` → `done`, or `cancelled`. Tasks
added by an agent start as `proposed` and need `approve`; tasks the owner or the orchestrator adds start as `waiting`.
With [auto-accept](#auto-accept-of-proposals) on, the queue approves the proposals that fit the owner's rules itself.

## The done command and the fix-round cap

`done_when` is a command the owner or the orchestrator picks, so "done" means more than the track's own RESULT line.

- **The mission** states it (`**Done command (binding):**` in the track block): the track runs it from its worktree
  root before it reports DONE.
- **`cq receive <id>`** runs it first, through the shell, in the worktree that has the track branch checked out
  (`--done-cwd <folder>` overrides; with no such worktree receive stops and changes nothing). A PARTIAL delivery is
  not checked. Green: receive goes on as before and saves `done_check` (`ok`, `exit`, `tip`, `step`, `at`).
  Red, or over the time budget: no review package for reviewers, the blocker `gate-red`, and a fix round
  (`cq resume <id> --reason fix`, run by receive) whose brief carries the command and its last output lines. Exit 1.
- **`cq merge <id>`** runs it again unless the last green run was on the same branch tip with the same command. Red
  is handled as in receive, and nothing is merged.
- **Only the tail is kept** (`doneCheck.tailLines`, default 40 lines, each cut to 400 characters) in
  `<scratchpad>/done-<id>.md` and the fix brief; the full output is never stored, so a secret printed early in a
  long run is not copied around. `doneCheck.timeoutSec` (default 600) is the time budget per run. On Windows a
  timeout stops cmd.exe; a process it started can live on until it ends by itself.

**The fix-round cap.** Every `cq resume <id> --reason fix` counts (the task's `resumed` list; a `context`
continuation does not). At `max_fix_rounds` (the task) or `maxFixRounds` (the config, default 3) the queue stops
retrying by itself and asks the owner the usual way: it registers the owner question `<id>.fixcap<N>`, puts it in
the task's `waiting_on` and opens the blocker `owner-question`, prints `FIX-ROUND CAP` and exits 8 (`receive` and
`merge` pass the 8 on). `cq resolve <id>.fixcap<N> --answer "…"` allows exactly one more round, and the answer is in
its brief; the next one asks again. A higher cap: `cq edit <id> --json '{"max_fix_rounds": 5}'`; giving up:
`cq set <id> cancelled`.

## Everyday commands

| Command | What it does |
|---|---|
| `init` | Creates an empty queue (run once per project) |
| `add --file task.json` / `add --json '{…}'` | Adds one task or a list |
| `approve <id>` | Approves a proposal |
| `proposals [auto [on\|off] …]` / `proposals log` / `proposals undo <id>` | Auto-accept of proposals by the owner's rules (default off) / what was auto-accepted / back to proposed (see below) |
| `forecast [--project <pid>] [--days 28] [--json]` | When the remaining tasks are done at 50, 85 and 95 % (Monte Carlo, see below) |
| `show` / `show --full` | Short view (under about 3,000 characters) / full table |
| `next` | What can start now, without changing anything |
| `triage` / `triage <id> --verdict ready\|done\|stale\|adjust [--note "…"]` / `triage <id> --prompt --scratchpad <dir>` | The tasks that need an intake verdict before they start / record the triage helper's verdict (done and stale become an owner question, adjust adds the note to the mission) / write the triage prompt again (see orchestration.md, Intake triage) |
| `fill --scratchpad <dir>` | Starts as many tasks as the limits allow and writes the mission prompts |
| `receive <id>` | Receives a finished track: reads the RESULT line, builds the review package |
| `deliveries` | Tracks with a `report.md` (RESULT line on top) that is not received yet; the pulse prints new ones as `NEW DELIVERY` |
| `resume <id> --reason fix\|context` | Writes `prompt-<id>-r<N>.md` for a new agent on the same branch (fix round or continuation of an adopted track) |
| `merge <id>` | Merges the track branch into the base branch (after review). Exit 9: the base branch is red (the base gate, see orchestration.md; only its fix task merges, `--force-red-base` overrides and is logged). Exit 4: the merge guard stopped it (protected paths the task does not own); `--allow-guard` overrides |
| `set <id> <status>` | Sets status by hand |
| `cancel <id> [--remark "…"]` | Cancels a waiting or proposed task (decline a proposal with `--remark "declined: …"`); logged, so `undo` puts it back. Running and review tasks: `set <id> cancelled` |
| `edit <id> --json '{…}'` | Changes fields (logged; `undo` rolls it back) |
| `info <id>` | Short view of one task (with `fixes` and `fixed by` when it has fix links) |
| `question` / `resolve <q> --answer "…"` | Owner questions / answer one (waiting tasks get the answer in their mission) |
| `question <q> --text "…" --choice "…" --choice "…"` / `resolve <q> --choice <n\|text> [--answer "note"]` | Answer options on a question: 2-4 choices, each at most 60 characters, no duplicates (`--no-choices` removes them; in an add file: `"choices": [...]` under `question`). Put the recommended one first, or give `--recommendation` its exact text to mark it. The stored answer is the choice's text, plus ` (note: …)` with `--answer`. `cq question` and the after-compact summary list the choices numbered, and the board shows them as buttons |
| `limit [<name> <value>]` | Limits: `maxConcurrent`, `maxDPlus`, `maxPerDomain`, `dailyBudget`, night window, `minFreeMemoryPct`, `silentMin` (minutes before a running track is SILENT; default 20, 0 = off) |
| `block <id> <code> [--note "…"]` / `unblock <id>` | Opens / closes a blocker reason on the task (`blocks`; one open at a time). Codes: `merge-conflict`, `gate-red`, `context`, `quota`, `owner-question`, `dependency`, `no-agent`, `silent`, `other`. `merge` opens `merge-conflict` or `gate-red` when it stops in that step and closes the open one after a successful merge |
| `blockers [--days 7] [--json]` | Per blocker code: count and blocked time in the period, top first |
| `next-migr [<n>]` / `migr move <id> <block>` | Migration flow only: show or set the next number / move a task's block in the queue and its prompt files |
| `cost [--since 7d] [--max 10] [--json]` | USD per merged change for the window first (see [Cost estimates and calibration](#cost-estimates-and-calibration)), then cost per task with all its runs (track, fix rounds, continuations, reviewers, fix tasks) by cost, then cost per class (n, median, sum) from the measured track sessions |
| `calibrate [--days 28] [--min 5] [--json]` | Per class: how far the minute estimates and the cost model are off, and the suggested correction (read-only) |
| `projects`, `project <pid> …` | Projects: progress, pause, prefixes |
| `focus set <steps>` | Focus period: only these steps are started |
| `focus evaluate [--json]` / `focus clean [--dry]` | Each stage as active, done-with-rests (batch queue, proposals, owner questions, QA, with a suggestion per rest) or done / takes out the done stages (history and changelog, so `undo` works; the last stage stays). `receive`, `set <id> done\|cancelled` and `fill` clean automatically, and the board hides done stages |
| `park <id>` / `continue <id>` | Park / unpark |
| `pick <id> --by "<who>"` / `deliver <id>` | A person or a separate chat takes a task by hand / delivers it |
| `diagnose` | Why the queue runs fewer tracks than it could (with suggested fixes) |
| `finding "<title>" [--detail] [--task] [--files a,b]` / `finding list [--all]` | A track reports something outside its scope: an idea in the plan register, linked to the task and deduplicated on the title ([plan-register.md](plan-register.md#findings)). Pulse and `show` count the new ones |
| `doctor [--json]` | Read-only health check, one OK/WARN/FAIL line each with a fix hint: Node and the `node` the hooks find on PATH, the hooks file and its scripts, `queue.config.json` keys and types, the state files, a stale lock, half-deleted worktree folders under `.claude/worktrees/` and git worktrees whose folder is gone, branches of finished tasks. Exit 1 on any FAIL |
| `state` | Machine-readable state (exit 3 when there is nothing to do) |
| `undo` | Undo the last write |
| `qa` / `qa ok <id…>` / `qa deviation <id> "…"` | The QA list (split into what to look at, a manual round and auto entries) / the owner approves / the owner finds a deviation (fix task `<id>-QA<n>`) |
| `qa evidence <id> <type>[=<ref>]` / `qa auto [--run]` | Sets the QA evidence by hand (`receive` reads the `EVIDENCE` line in `report.md`) / runs `qa.autoCommand` for auto evidence and closes the green entries |
| `follow [add\|log\|show\|report\|close\|extend]` | Follow-up entries: observations with a start, an end, goals, a log and a fixed report template (see below) |

### Forecast

`cq forecast` answers "when will the remaining tasks be done?" in one paragraph, for example: `Focus "X": 14 tasks
left. 50 %: by Tue 4 Nov (4 days), 85 %: Thu 6 Nov, 95 %: Fri 7 Nov. Based on 31 done in the last 28 days. Expected
cost about 42 USD.` The remaining tasks are the open ones in the current focus stages (with the dependencies they pull
along) when a focus applies, otherwise every waiting, running, picked and review task; proposals, the done and the
cancelled never count. `--project <pid>` narrows it to one project. The method is Monte Carlo: each of 2000 runs draws
a day's throughput (done per calendar day in the last `--days` days, zero days included) with replacement until the
remaining count is reached, and the 50/85/95 % answers are the day counts that share of runs finished within (day 1 is
today). The expected cost is the sum of the calibrated cost estimate of each remaining task (see below), left out when
nothing in the window has a measured cost. With fewer than 5 done in the window it says "not enough data".
The throughput is the whole queue's, also with `--project`. The board shows the same paragraph in the Focus view and
in Statistics. The logic is `lib/queueForecast.js`.

### Cost estimates and calibration

Minute estimates (`content_min` x the class weight) are poor predictors: in a project with about 2,800 tasks the
median actual/estimate ratio was 0.33 for K, 1.62 for D, 2.33 for D+ and 0.40 for U. The median measured cost per class
predicts cost well (median ratio about 0.97). So cq estimates cost from measured cost, not from minutes:

1. **Class + size**: when the class and size bucket (S up to 30 content minutes, M up to 60, L above) has at least 5
   done tasks with a measured cost (`cost.usd`) in the last 28 days, the estimate is that bucket's median.
2. **Class**: otherwise, with at least 5 in the class, the static model for the task (fixed + content minutes x factor,
   `CALIBRATED` in `lib/logic/base.js`, re-exported by `lib/queueLogic.js`) times the class's median measured/model ratio.
3. **Model**: otherwise the static model alone.

The estimate is shown as `~$x` next to the minute estimate in `show`, `show --full`, `next`, the `fill` lines and
`info` (with where it came from, e.g. `measured, class+size, n=7`). `state` has a `costEstimate` field: the model per
class, what can start now with the estimate each, the sum, and the daily budget outlook. With `dailyBudget` set,
`next` and `show` print a **Budget outlook** line (what can start now against what is left today); the budget guard
itself still stops on measured usage only. The weekly quota forecast (`capacity`, the queue cost) and the forecast's
expected cost use the same estimate. The order of the queue is not changed: the priority still uses the minute
estimate.

`cq calibrate` shows the calibration per class: n, the median actual/estimate ratio for minutes (cycle time started to
done) with the suggested weight, the median measured USD, the model's median for the same tasks, the cost correction
factor, and whether new tasks of the class are estimated from measured data or the model. The suggested weight is advice
only; cq never changes the weights itself. The logic is `lib/costEstimate.js`.

**USD per merged change** is the main cost figure (`cq cost`, and the first key figure in the board's Statistics):

> all measured cost in the window / the queue tasks that reached done in the window

"All measured cost" is every usage event in the time log in the window: the tracks, fix rounds, reviewers and helper
agents of the merged tasks, the work on cancelled tasks, work on tasks still open, and agents that belong to no task.
The orchestrator session itself is not in the time log (the hooks cover subagents only), so it is not included. Without
any usage in the time log for the window, the total is the measured task cost of the merged tasks, and the output says
so. `cq cost` uses `--since` as the window, otherwise the last 28 days; the board uses its 14-day window. "USD per
content minute" is shown only as a secondary, estimate-based figure: raising the estimates (the denominator) makes work
look cheaper without anything changing, so it is not a headline.

A fix task (one with `fixes`, or a QA fix task with `qa_original`) is part of the change it fixes: its cost is
attributed to that task, and a done fix task is not counted as a merged change of its own. Without a time log, the
fallback total is the task total of the merged tasks, fix tasks included.

**Cost per task, all runs** (`cq cost`, `perTask` in `--json`) is one row per task, most expensive first: the first
track, the fix rounds and continuations (`cq resume`, logged as `<id>-r<N>`), the reviewers, and the fix tasks that
point to it, with USD, tokens and the number of agent runs. A task measured at `set <id> done` uses that measurement
(it already holds its rounds and reviewers); a task without one (open, cancelled) uses its usage in the time log, and
the row says so. `--since` keeps the tasks with activity in the window, `--max` the number of rows.

### Auto-accept of proposals

Default off. With it on, a proposal that fits the owner's rules is approved by the queue itself, through the same path
as `cq approve`: when it is added (`cq add`) and, for older ones, at every `cq orchestrator pulse`. Each one gets a
remark and a row in the log (`auto_accepted` in queue.json, the last 200), and `cq proposals undo <id>` puts it back to
proposed as long as it has not been started; an undone task is never auto-accepted again.

- `cq proposals` shows the rules and which proposals fit them now.
- `cq proposals auto on|off [--classes K,U] [--max-estimate <min|none>] [--max-value <1-10|none>]` sets the rules in
  queue.json (`proposals.autoAccept`), which win over the config default (`proposals.autoAccept` in
  queue.config.json: `{ enabled: false, classes: ["K"], maxEstimateMin: 60, maxValue: null }`). The estimate is
  content_min times the class weight.
- `cq proposals log [--json]` lists what was auto-accepted, newest first.

The hard rules no setting overrides: never class D or D+, never a task with `waiting_on`, never one with a legal or
owner label (`legal`, `lawyer`, `owner`, `owner-task`, `privacy`, `dpia`, or any label starting with `legal` or
`owner`) or linked to a plan entry with open legal points, never one that owns a protected path (`protectedPaths`,
the merge guard's list, also through a folder it owns as a whole), and never one whose auto-accept was undone. The
board's gear has the switch, the rules and the log with an Undo button per row. The logic is `lib/queueProposals.js`.

### Follow-up entries

A follow-up entry (`F-…`) is something to watch over a period: an internal test, a trial after an owner decision, a
variable to measure. It lives in `<dataFolder>/follow.json` (under the queue's lock), not in the memory or the
handover note.

Follow-up entries are off by default: turn them on with `"features": { "follow": true }` in `queue.config.json`.
While off, every `follow` command answers "Follow is off (features.follow in queue.config.json)." with exit 0.

```json
{ "id": "F-AUTOCOMPACT", "title": "Trial of automatic compaction", "why": "Is anything lost?",
  "start": "2026-10-08", "end": "2026-10-15", "owner": "orchestrator",
  "goals": [{ "name": "losses", "how": "read the handover note after each compaction", "expected": "0" }],
  "close_action": "cq compact manual" }
```

- `follow add --file <json>` adds it (status `active`), `follow log <id> --text "…" --value name=x` logs along the
  way, `follow extend <id> --to <date>` moves the end, `follow` lists and `follow show <id>` shows one.
- From the end date (the machine's local calendar day) the entry is `to-report`: `show` and `orchestrator pulse`
  print TO REPORT until `follow report <id>` writes `<dataFolder>/follow/<id>-report.md` from the fixed template
  (Question, Setup, Measurements, Findings, Deviations and losses, Recommendation, Owner decision).
- `follow close <id> --decision "…"` (or `--cancelled`) records the owner decision, writes the report again with it
  and prints the close action. The command never runs the close action itself.
- The board shows the entries read only at `/follow`.

## Limits and safety

- `maxConcurrent` (parallel tracks), `maxDPlus`, `maxPerDomain` and `maxDb` stop the queue from starting more than
  the codebase and your plan can take.
- Two tasks that own the same file or DB object never run at the same time.
- `dailyBudget <usd>` stops new starts when the day's measured spend (API-equivalent) is used up. The night window
  (`nightRun`, `nightWindow`) can pause starts at night.
- The load guard (`limit minFreeMemoryPct 15`, or `loadGuard.minFreeMemoryPct` in the config) stops new starts with
  exit 7 ("THE MACHINE IS FULL") while free memory is below the limit. Default 10 % (off on macOS, which counts the page cache as used; set a number
  there to turn it on). Running tracks finish;
  `start --force` and `fill --over-load` override.
- Load-aware slots: above that hard stop, the number of parallel slots follows the load instead of always being
  `maxConcurrent`. With many parallel tracks the machine, not the token quota, is often the limit: gates slow down
  and go red from memory and timeouts, and the reruns cost more than the extra tracks gain. The rule:
  - all slots at or above `loadGuard.allSlotsFreeMemoryPct` free memory (default 40 %, off on macOS);
  - `loadGuard.minSlots` (default 1) at the hard limit `minFreeMemoryPct`;
  - linear in between, rounded down. With `maxConcurrent` 5 and the defaults: 40 % free gives 5 slots, 25 % gives 3,
    18 % gives 2, 10 % gives 1;
  - CPU is optional: set both `allSlotsCpuPct` (all slots at or below, e.g. 60) and `minSlotsCpuPct` (`minSlots` at
    or above, e.g. 95). It costs a ~200 ms CPU sample per command. The lower of memory and CPU wins;
  - new starts = the slots minus the tracks already running. An unknown measurement never limits.

  `fill`, `next`, `start` and `show` print the reason (`LOAD: 2 of 5 slots: free memory 18 % (all slots from 40 %)`),
  `state` has `loadSlots`, and `cq limit` shows the load and the slots now. The floor of 1 means this rule alone
  never stops the queue; only the hard guard does. Turn it off with `loadGuard.adaptive: false` in the config or
  `QUEUE_LOAD_ADAPTIVE=off`; `fill --over-load` and `start --force` skip it for one call.
- With a migration flow, `start`, `fill` and `pick` skip taken blocks: a migration file, the block of a task that is
  not finished, or a block named on a "migration block" line in an active prompt file (a move by hand).
  `next-migr` refuses a number inside a taken block.
- Times are the machine's local time: the night window, the day the daily budget counts, the weekly quota reset
  and the statistics per day. To use another time zone, set the `TZ` environment variable (for example
  `TZ=America/New_York`) for Claude Code.
- Agents may only ADD proposals. Approval, merging and pushing belong to the orchestrator and the owner.

## Configuration

Project-specific values live in `queue.config.json` at the project root (see `queue.config.example.json`): base branch,
branch prefix, gate commands, migration folder (optional), areas (`modules`) for the plan register, board port and title,
reviewer agents per class. Missing values fall back to safe defaults.

| Key | Default | Used for |
|---|---|---|
| `baseBranch`, `remote`, `branchPrefix` | `main`, `origin`, `queue/` | Integration branch, push remote, track branch names |
| `gates.quick`, `gates.full` | `[]` | Commands `gates.mjs` runs (empty = green) |
| `gates.precheck`, `gates.precheckBudgetSec` | `null` (the standard checks), `120` | The fail-fast precheck `cq gates --precheck` runs before the full gate, stopping at the first red check: commands or `{ name, command, files, budgetSec }`, with `{changed}` (the changed files against `baseBranch`) or `{file}` (once per file); `null` = `node --check`, `tsc --noEmit`, eslint and related tests when the project has them, `[]` = off (see orchestration.md) |
| `migrations.folder` | `null` | Optional numbered migrations; `null` turns block numbering and migration push off |
| `migrations.pushCommand`, `environmentFile`, `allowedEnvironment` | `null`, `null`, `[]` | `merge` runs the push command after merging (skip with `--without-migr-push`), but only when the environment file names an allowed environment |
| `reviewers` | D: `reviewer`, D+: `reviewer` + `reviewer-security` | Fixed reviewer agents per class after `receive` |
| `helpers` | challenger (U, `bug`) and design (`visual`) on; tests, gap, docs off | Optional helper agents with conditions; switch with `cq helpers on\|off <agent>` (see orchestration.md) |
| `triage.minAgeDays`, `agentAdded`, `maxPerFill`, `askAgainMin` | `3`, `true`, `3`, `60` | Intake triage before a task starts: tasks added or last edited this many days ago (`null` = off) and agent-added tasks get a `triage` verdict first (`cq triage`); at most this many steps per fill, not asked again within this many minutes. Off with `cq helpers off triage` and in lite mode (see orchestration.md) |
| `architectureRules` | `[]` | Short rules copied into every mission |
| `sharedLinks` | `["node_modules"]` | Folders linked into each worktree instead of reinstalled |
| `readGuard` | built-in lists | Extra agent types, auto-loaded files and large-file globs for the reading guard |
| `cloudHidden` | `[]` | Paths a cloud session cannot see (missions pointing there are stopped) |
| `capacity` | Tuesday 19:00 local time | Weekly quota reset for `cq capacity` |
| `models` | `{}` (each agent file's model, opus) | Model per agent, e.g. `{ "reviewer-docs": "sonnet" }`: printed as `model=<m>` on the start lines and passed to the Agent tool (opus, sonnet, haiku, fable; an unknown value is ignored) |
| `loadGuard.minFreeMemoryPct` | `10` (off on macOS) | Load guard: no new starts while free memory (percent) is below it; `cq limit minFreeMemoryPct` overrides per queue |
| `loadGuard.adaptive`, `minSlots`, `allSlotsFreeMemoryPct` | `true`, `1`, `40` (off on macOS) | Load-aware slots: fewer than `maxConcurrent` slots while free memory is below `allSlotsFreeMemoryPct`, at least `minSlots`; `QUEUE_LOAD_ADAPTIVE=off` turns it off |
| `loadGuard.allSlotsCpuPct`, `minSlotsCpuPct` | `null`, `null` | Optional CPU part of the load-aware slots (both set, e.g. `60` and `95`) |
| `proposals.autoAccept` | `{ enabled: false, classes: ["K"], maxEstimateMin: 60, maxValue: null }` | Auto-accept of agent proposals by the owner's rules (`cq proposals`); the queue's own rules win; never D/D+, `waiting_on`, legal/owner labels, open legal points or protected paths |
| `qa.evidenceTypes`, `qa.autoTypes`, `qa.manualTypes` | `screenshot`, `test`, `manual`; auto `test`; manual `manual` | QA evidence types a track writes as `EVIDENCE <type>[=<ref>]`; auto types are closed by `qa auto --run`, manual ones gathered in one round |
| `qa.autoCommand` | `null` | Shell command for auto evidence, e.g. `npx vitest run {refs}` (`{refs}`, `{id}`; or `{ "<type>": "<command>" }`); `null` = `qa auto` only lists |
| `qa.evidenceLabels` | `["visual"]` | Labels for which `receive` warns when the `EVIDENCE` line is missing |
| `excludeBranches` | `["main","master"]` | Branches never treated as external work |
| `protectedPaths` | `.claude/`, `scripts/orchestrator/`, plugin hooks/agents/skills, `queue.config.json`, `CLAUDE.queue.md`, `package.json` … | Merge guard: a track may only change these when its task owns them; `[]` turns it off |
| `modules`, `projectModuleSuggestion`, `priorityRules`, `documentFolders`, `indexFile`, `documents`, `planBackup` | see `queue.config.example.json` | Plan register (see `plan-register.md`) |
| `board.port`, `board.title` | `2000`, `Queue board` | Board |
| `board.updateCheck` | `true` | Board: look for a newer cq on GitHub at most once per 24 hours (see board.md, Update banner) |
| `features` | `plans`, `focus`, `statistics` on; `cloud`, `follow`, `plans.legal`, `plans.launch`, `plans.documents` off | Modules that can be switched off. Off hides them on the board (tabs, buttons, routes; see board.md, Modules); `cloud*` and `follow*` commands answer "Cloud is off (features.cloud in queue.config.json)." with exit 0, and `show` and the pulse skip follow-up lines. `plans` only hides the board's Plans room: `cq plan` always works. A part (`plans.legal`) is off when its parent is off; unknown keys are ignored. Restart the board after a change |
