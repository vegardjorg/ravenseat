# The work queue (`ravenseat`)

The queue is a JSON file (`scripts/.queue/queue.json`, gitignored) with tasks, owner questions, projects, limits and cost
data. It survives when the orchestrator's chat is compacted or restarted, because nothing important lives only in
the chat. Every command is `ravenseat <command>`. `ravenseat help` prints the key commands in four groups (Get started, Daily,
Owner, Orchestrator), `ravenseat help all` the full usage list (the comment at the top of `queue.mjs`, with the internal
scripts under their own heading), and `ravenseat help <command>` one command in full (or a script's header). A mistyped
command gets one line with the closest match: `Unknown command "shwo". Did you mean "show"? See ravenseat help.` (exit 1).
The texts and the suggestion live in `lib/cliHelp.js`. The table below lists the important ones. In the code,
`scripts/orchestrator/queue.mjs` holds the usage comment and the dispatch on the command word, and each command's
code is in `scripts/orchestrator/cli/` (one module per area, the shared state in `cli/context.mjs`).

Writes happen under a file lock (atomic `mkdir`) and via temp file plus rename, so two writers (the orchestrator and
a track adding a proposal) cannot corrupt the file. `ravenseat undo` undoes the last change.

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
| `owned_files`, `owner_db` | Files and DB objects the task owns exclusively while it runs. A file another active task (running, in review or picked) owns stops the merge (exit 4, `--allow-guard` overrides and is logged); `receive` and the pulse say it early. A hotspot can never be in `owned_files`. In `owner_db`, `users` and `public.users` are the same object, and `fn(uuid)` the same as `fn` (another schema, like `auth.users`, is not). `merge` keeps the files a task actually changed in `changed_files`; `add` names files that earlier tasks changed together with the new task's files (OWNERSHIP HINT), so they can be owned from the start |
| `hotspot_patch` | Optional: the hotspots (`hotspots` in `queue.config.json`) this task may change, agreed by the owner. Only one active task can hold the same hotspot (a start conflict). Without it a hotspot change stops the merge, and the track writes a wiring spec instead |
| `shared_patch` | Shared functions the task changes in patch form |
| `reads` | Optional: files, or folders ending in `/`, the task builds on but does not change. A task that reads a file an active task (running, in review or picked) changes waits until that task is done, and so does a task that would change a file an active task reads; two readers never block each other. With `"reads": { "mode": "warn" }` in `queue.config.json` it starts anyway, and `start`, `fill` (`READS WARNING`), `explain` and the mission name the overlap. The mission lists the read files and tells the agent not to change them. Never ownership for the merge guard |
| `project`, `feature`, `source` | Project id (must exist), feature name, and the plan section the task comes from |
| `batched` | `true` for small low-value tasks: they go to the batch queue (`ravenseat batch`) instead of their own track. Approving such a proposal does not start it: it starts when packed, or alone after `edit <id> --json '{"batched":false}'` |
| `done_when` | Optional: a shell command (one line, at most 500 characters) that must exit 0 in the track's worktree for the track to count as done, e.g. `npm test -- src/x.test.ts`. The mission tells the track to run it before it reports; `receive` and `merge` run it again (see [the done command](#the-done-command-and-the-fix-round-cap)). `null` in `edit` removes it. A proposal with it is never auto-accepted |
| `acceptance` | Optional: a list of 1 to 10 short criteria (one line each, at most 300 characters), set with `ravenseat add ... --accept "..." --accept "..."` (one task) or `ravenseat edit <id> --accept "..."` (replaces the list). The mission copies them under "Acceptance criteria (fixed, do not change)", `ravenseat info` and the board's detail panel show them, and `reviewer-gap` answers MET / NOT MET / UNCLEAR per criterion. Locked after the start, like `done_when` (see [the lock](#the-finish-line-is-locked-after-the-start)). `null` in `edit` removes it |
| `max_fix_rounds` | Optional: this task's fix-round cap, a whole number 0 to 20 (0 = no fix round without the owner); overrides `maxFixRounds` in `queue.config.json` (default 3). `null` in `edit` removes it |
| `fixes` | Optional: the task id (or a list of ids) this task fixes. `add` and `edit` refuse an id that is not in the queue (or in the same add) and a task naming itself; stored as a list, and `[]` or `null` in `edit` removes it. `ravenseat info <id>` shows `fixes` and `fixed by`, and `ravenseat state` lists the open fix tasks as `fixLinks`. `qa deviation` sets it on the fix task it creates. The benchmark (`bench/`) counts it as a defect after merge |
| `gate_check` | Written by `receive`, never by hand: ravenseat's own quick gate run on the delivered tip (`ok`, `kind`, `tip`, `at`, `ran`, and `evidence_at` when a green gate evidence entry for that exact tip was reused). The track's own `RESULT gates=` is informational only; a red `gate_check` opens the blocker `gate-red` and a fix round (see orchestration.md, The gate evidence) |

Status flow: `proposed` → `waiting` (approved, ready to run) → `running` → `review` → `done`, or `cancelled`. Tasks
added by an agent start as `proposed` and need `approve`; tasks the owner or the orchestrator adds start as `waiting`.
A track adds from its own worktree: the queue sets `added_by` from the branch, refuses `--approved` and allows 3 open
proposals per track. The small-task guard does not apply to it and `batched` is dropped, since the owner decides the size when approving. In full mode too, its proposal needs only `id`, `title` and `mission`: `domain`, `project` and `feature`
follow the track and the class is `K`, unless the task sets them.
With [auto-accept](#auto-accept-of-proposals) on, the queue approves the proposals that fit the owner's rules itself.

## The done command and the fix-round cap

`done_when` is a command the owner or the orchestrator picks, so "done" means more than the track's own RESULT line.

- **The mission** states it (`**Done command (binding):**` in the track block): the track runs it from its worktree
  root before it reports DONE.
- **`ravenseat receive <id>`** runs it first, through the shell, in the worktree that has the track branch checked out
  (`--done-cwd <folder>` overrides; with no such worktree receive stops and changes nothing). A PARTIAL delivery is
  not checked. Green: receive goes on as before and saves `done_check` (`ok`, `exit`, `tip`, `step`, `at`).
  Red, or over the time budget: no review package for reviewers, the blocker `gate-red`, and a fix round
  (`ravenseat resume <id> --reason fix`, run by receive) whose brief carries the command and its last output lines. Exit 1.
- **`ravenseat merge <id>`** runs it again unless the last green run was on the same branch tip with the same command. Red
  is handled as in receive, and nothing is merged.
- **Only the tail is kept** (`doneCheck.tailLines`, default 40 lines, each cut to 400 characters) in
  `<scratchpad>/done-<id>.md` and the fix brief; the full output is never stored, so a secret printed early in a
  long run is not copied around. `doneCheck.timeoutSec` (default 600) is the time budget per run. On Windows a
  timeout stops cmd.exe; a process it started can live on until it ends by itself.

**The fix-round cap.** Every `ravenseat resume <id> --reason fix` counts (the task's `resumed` list; a `context`
continuation does not). At `max_fix_rounds` (the task) or `maxFixRounds` (the config, default 3) the queue stops
retrying by itself and asks the owner the usual way: it registers the owner question `<id>.fixcap<N>`, puts it in
the task's `waiting_on` and opens the blocker `owner-question`, prints `FIX-ROUND CAP` and exits 8 (`receive` and
`merge` pass the 8 on). `ravenseat resolve <id>.fixcap<N> --answer "…"` allows exactly one more round, and the answer is in
its brief; the next one asks again. A higher cap: `ravenseat edit <id> --json '{"max_fix_rounds": 5}'`; giving up:
`ravenseat set <id> cancelled`.

**The fix-round plateau.** Before a fix round the queue also asks the owner, the same way, when the previous fix round
committed nothing (the branch tip did not move) or the check fails exactly as before it (same kind, exit and output
tail; durations, clock times and shas do not count). The question is `<id>.plateau<N>` and the output says
`FIX-ROUND PLATEAU` (exit 8). The cap is checked first, and a round the owner allowed past the cap is not asked again.
Each fix round saves `tip` and `signature` in `resumed`, so the next one can compare. `"fixPlateau": false` in
`queue.config.json` turns it off.

### The finish line is locked after the start

`done_when` and `acceptance` are fixed before a task starts and checked by someone else than the track, so a track
cannot move its own finish line ("implementation complete" is the track's claim, "verified complete" is the gap
reviewer's verdict against criteria the track could not change).

- **Before the start** (status `proposed` or `waiting`, no `started` time) anyone may change them, as any field.
- **After the start** (`running`, `picked`, `review`, `done`, `cancelled`, or a `started` time kept after a release)
  `ravenseat edit` and `ravenseat undo` refuse a change unless `--by owner` (or the board, which passes `--by theBoard`). Anyone
  else gets `done_when is locked after start; ask the owner (ravenseat question)`, and nothing is written.
- **From inside a track worktree** (the cwd is on a `<branchPrefix><id>` branch, `queue/<id>` by default) the change
  is refused whatever `--by` says, before or after the start: `--by` is only a name, and a track can type it too.
- An edit that sets the same value again is not a change, and other fields in the same edit are not affected by the
  lock (an edit that touches a locked field stops as a whole).

The lock is a guard against a track editing its own criteria, not an access control: a session in the main tree can
still pass `--by owner`, and the changelog (`ravenseat undo --show`) records who did.

## Everyday commands

| Command | What it does |
|---|---|
| `init` | Creates an empty queue (run once per project) |
| `add --file task.json` / `add --json '{…}'` | Adds one task or a list |
| `decide [--json] [--max N]` / `decide --today` | Everything waiting on the owner (questions, QA, proposals, stuck work) as one list, most impact first, each answer with its exact `ravenseat` command; read only. `/ravenseat:decide` walks it one decision at a time / what was decided today |
| `approve <id> [--by owner]` | Approves a proposal (`--by` records who) |
| `proposals [auto [on\|off] …]` / `proposals log` / `proposals undo <id>` | Lists the proposals waiting, and auto-accept of proposals by the owner's rules (default off) / what was auto-accepted / back to proposed (see below) |
| `forecast [--project <pid>] [--days 28] [--json]` | When the remaining tasks are done at 50, 85 and 95 % (Monte Carlo, see below) |
| `show` / `show --full` | Short view (under about 3,000 characters; names up to 5 proposals with the track they came from) / full table |
| `next` | What can start now, without changing anything |
| `triage` / `triage <id> --verdict ready\|done\|stale\|adjust [--note "…"]` / `triage <id> --prompt --scratchpad <dir>` | The tasks that need an intake verdict before they start / record the triage helper's verdict (done and stale become an owner question, adjust adds the note to the mission) / write the triage prompt again (see orchestration.md, Intake triage) |
| `fill --scratchpad <dir>` | Starts as many tasks as the limits allow and writes the mission prompts |
| `receive <id>` | Receives a finished track: reads the RESULT line, builds the review package |
| `deliveries` | Tracks with a `track-result.md` (RESULT line on top) that is not received yet; the pulse prints new ones as `NEW DELIVERY` |
| `resume <id> --reason fix\|context` | Writes `prompt-<id>-r<N>.md` for a new agent on the same branch (fix round or continuation of an adopted track) |
| `merge <id>` | Merges the track branch into the base branch (after review). A migration file from a task without a migration block stops at the merge guard (exit 4), also with no migration flow configured, and is never pushed by itself. Exit 9: the base branch is red (the base gate, see orchestration.md; only its fix task merges, `--force-red-base` overrides and is logged). Exit 4: the merge guard stopped it (protected paths the task does not own); `--allow-guard` overrides. Exit 1: the quick gates were red at the last receive (`gate_check`): a fix round, or `ravenseat receive` again when commits came after it; `--force-red-gate` overrides and is logged. A PARTIAL delivery stops the merge unless you pass `--allow-partial` (on the owner's word, logged); a later round that delivers DONE clears the stop |
| `set <id> <status>` | Sets status by hand. `done` warns (never stops) when the task never started or its branch has commits that are not in the base, names the tasks it frees and gives the way back (`set <id> review`, then `merge <id>`) |
| `cancel <id> [--remark "…"]` | Cancels a waiting or proposed task (decline a proposal with `--remark "declined: …"`); logged, so `undo` puts it back. Running and review tasks: `set <id> cancelled` |
| `edit <id> --json '{…}'` | Changes fields (logged; `undo` rolls it back) |
| `info <id>` | Short view of one task (with `fixes` and `fixed by` when it has fix links) |
| `explain <id> [--json]` | Why one task stands where it stands, from the rules the queue starts by: what blocks a waiting task (dependency, owner question, file or DB conflict, parking, focus, an uncommitted file), a stop on the whole queue, the full limits and its place among the startable ones; for a running task when it started, the round, an open block and the last sign of life with its source, SILENT over `silentMin`. Read-only |
| `question` / `resolve <q> --answer "…"` | Owner questions / answer one (waiting tasks get the answer in their mission) |
| `question <q> --text "…" --choice "…" --choice "…"` / `resolve <q> --choice <n\|text> [--answer "note"]` | Answer options on a question: 2-4 choices, each at most 60 characters, no duplicates (`--no-choices` removes them; in an add file: `"choices": [...]` under `question`). Put the recommended one first, or give `--recommendation` its exact text to mark it. The stored answer is the choice's text, plus ` (note: …)` with `--answer`. `ravenseat question` and the after-compact summary list the choices numbered, and the board shows them as buttons |
| `wait [--debounce <s>] [--timeout <h>] [--since <log-nr>] [--check-min <n>]` | Every `--check-min` minutes (5, 0 = off) it also checks the tracks: a track no agent took or a silent one gives `TRACKS NEED A LOOK: ...` and exit 11, once per finding. Blocks until the owner acts (resolve, approve, `qa ok`/deviation, add, an answer through `resume --by owner`, or a logged edit by `owner`/`theBoard`) after the end of the changelog when it started, waits `--debounce` (30 s) for more, prints `OWNER ACTED: resolve Q12, Q14; approve T-40` (ids only) and `run: ravenseat resolutions --unlogged`, exit 0. `TIMEOUT` after `--timeout` (8 h), exit 10. One at a time: a second one prints `ALREADY WAITING (pid n)`, exit 0. The orchestrator starts it with `run_in_background` when only owner items are left (see orchestration.md, The loop). `ravenseat set` and a `resolve` without `--by owner` are not detected |
| `limit [<name> <value>]` | Limits: `maxConcurrent`, `maxDPlus`, `maxPerDomain`, `dailyBudget`, night window, `minFreeMemoryPct`, `silentMin` (minutes before a running track is SILENT; default 20, 0 = off) |
| `block <id> <code> [--note "…"]` / `unblock <id>` | Opens / closes a blocker reason on the task (`blocks`; one open at a time). Codes: `merge-conflict`, `merge-guard`, `merge-stopped`, `gate-red`, `context`, `quota`, `owner-question`, `dependency`, `no-agent`, `silent`, `other`. `merge` opens `merge-conflict` or `gate-red` when it stops in that step and closes the open one after a successful merge |
| `blockers [--days 7] [--json]` | Per blocker code: count and blocked time in the period, top first |
| `next-migr [<n>]` / `migr move <id> <block>` | Migration flow only: show or set the next number / move a task's block in the queue and its prompt files |
| `cost [--since 7d] [--max 10] [--json]` | USD per merged change for the window first (see [Cost estimates and calibration](#cost-estimates-and-calibration)), then cost per task with all its runs (track, fix rounds, continuations, reviewers, fix tasks) by cost, then cost per class (n, median, sum) from the measured track sessions |
| `calibrate [--days 28] [--min 5] [--json]` | Per class: how far the minute estimates and the cost model are off, and the suggested correction (read-only) |
| `projects`, `project <pid> …` | Projects: progress, pause, prefixes |
| `focus set <steps> [--continue-when-empty on\|off]` | Focus period: only these steps are started. When the focus has ended (every stage done, or `--to` passed), `focus.continueWhenEmpty` in queue.config.json decides (default off): off pauses the queue (fill starts nothing, `focus.finished_at` is stamped, and one owner question "set a new focus or continue the regular queue?" appears in Waiting on you; answering "Continue the regular queue" lifts the pause), on continues as without focus with one line. `--continue-when-empty` overrides it for this focus; `ravenseat focus` shows the setting. A project that never set a focus is not affected |
| `focus evaluate [--json]` / `focus clean [--dry]` | Each stage as active, done-with-rests (batch queue, proposals, owner questions, QA, with a suggestion per rest) or done / takes out the done stages (history and changelog, so `undo` works; the last stage stays). `receive`, `set <id> done\|cancelled` and `fill` clean automatically, and the board hides done stages |
| `park <id>` / `continue <id>` | Park / unpark |
| `pick <id> --by "<who>"` / `deliver <id>` | A person or a separate chat takes a task by hand / delivers it |
| `diagnose` | Why the queue runs fewer tracks than it could (with suggested fixes) |
| `finding "<title>" [--detail] [--task] [--cause <id>] [--files a,b]` / `finding list [--all]` | A track reports something outside its scope: an idea in the plan register, linked to the task and deduplicated on the title ([plan-register.md](plan-register.md#findings)). `--cause` names the merged task it is a defect of. Pulse and `show` count the new ones |
| `doctor [--json]` | Read-only health check, one OK/WARN/FAIL line each with a fix hint: Node and the `node` the hooks find on PATH, the hooks file and its scripts, `queue.config.json` keys and types, the state files, a stale lock, half-deleted worktree folders under `.claude/worktrees/` and git worktrees whose folder is gone, branches of finished tasks, CI cost, and the safety baseline (secret files in git or not ignored, empty gates or gates that check nothing (`exit 0`, `true`, an `echo`, also behind an npm script), a gate whose program is not found on PATH (`pytest -q` without pytest; a warning, the gate is never run), no CI config, a manifest without its lockfile, `productionBranch` equal to `baseBranch`, tracked files over `largeFileMb`; offline), and the temp folder's entries per prefix. Exit 1 on any FAIL |
| `machine [--measure]` | Cores, memory, free memory now and a suggested `maxConcurrent`, an estimate that changes nothing. `--measure`, started by you and refused while a track runs: `gates --full` once, then the time, the lowest free memory and a suggestion for this project |
| `state` | Machine-readable state (exit 3 when there is nothing to do) |
| `undo` | Undo the last write |
| `qa` / `qa ok <id…>` / `qa deviation <id> "…"` | The QA list (split into what to look at, a manual round and auto entries) / the owner approves / the owner finds a deviation (fix task `<id>-QA<n>`) |
| `qa evidence <id> <type>[=<ref>]` / `qa auto [--run]` | Sets the QA evidence by hand (`receive` reads the `EVIDENCE` line in `track-result.md`) / runs `qa.autoCommand` for auto evidence and closes the green entries |
| `follow [add\|log\|show\|report\|close\|extend]` | Follow-up entries: observations with a start, an end, goals, a log and a fixed report template (see below) |

### Forecast

`ravenseat forecast` answers "when will the remaining tasks be done?" in one paragraph, for example: `Focus "X": 14 tasks
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
predicts cost well (median ratio about 0.97). So ravenseat estimates cost from measured cost, not from minutes:

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

`ravenseat calibrate` shows the calibration per class: n, the median actual/estimate ratio for minutes (cycle time started to
done) with the suggested weight, the median measured USD, the model's median for the same tasks, the cost correction
factor, and whether new tasks of the class are estimated from measured data or the model. The suggested weight is advice
only; ravenseat never changes the weights itself. The logic is `lib/costEstimate.js`.

**USD per merged change** is the main cost figure (`ravenseat cost`, and the first key figure in the board's Statistics):

> all measured cost in the window / the queue tasks that reached done in the window

"All measured cost" is every usage event in the time log in the window: the tracks, fix rounds, reviewers and helper
agents of the merged tasks, the work on cancelled tasks, work on tasks still open, and agents that belong to no task.
The orchestrator session is not in this figure (the agent rows cover subagents only); it is the overhead line below. Without
any usage in the time log for the window, the total is the measured task cost of the merged tasks, and the output says
so. `ravenseat cost` uses `--since` as the window, otherwise the last 28 days; the board uses its 14-day window. "USD per
content minute" is shown only as a secondary, estimate-based figure: raising the estimates (the denominator) makes work
look cheaper without anything changing, so it is not a headline.

A fix task (one with `fixes`, or a QA fix task with `qa_original`) is part of the change it fixes: its cost is
attributed to that task, and a done fix task is not counted as a merged change of its own. Without a time log, the
fallback total is the task total of the merged tasks, fix tasks included.

**Orchestration overhead** (`ravenseat cost`, `orchestration` in `--json`) is the main session's own cost, shown apart so it
never hides the track cost. The status line (`statusline.mjs`, set up by `ravenseat setup --settings`) saves the session's
`cost.total_cost_usd` per session id in `<dataFolder>/session-cost.json` and appends a `session` row to the time log
when it grew by $0.50 or more, or 10 minutes after the last row; the compaction hook and the SessionEnd hook
(`hook-session-end.mjs`) add one more row with the last reading. The rows are cumulative per session: each reading adds
its growth since the previous one (a lower reading means the counter started over), and the growth inside the window
is the session's cost there. The session total counts the subagents the session started too (as far as we know), so
their usage in the window (their transcripts are under the session's `subagents/` folder) is subtracted. The rest,
for the sessions bound as the orchestrator, is divided by the same merged changes as the headline and shown as a share
of track cost + overhead; other main sessions are listed apart. Without the status line no session row is written and
the line says so. The payload has no cumulative token counts (only the tokens in the context now), so the rows hold the
cost, the durations, the context size and the model.

**Flow** (`ravenseat cost`, `flow` in `--json`, the "Flow" box in the board's Statistics) counts rows that the commands append
to the time log (`lib/eventRows.js`, one JSON line each, never failing the command): `fixRound` (ravenseat resume, also when
receive or merge resumes), `mergeConflict` (ravenseat merge stopped in the merge step, with the conflicted file count),
`baseGate` (every recorded base verdict, with the skip rule and the run time), `flakyGate` (a base gate command red, then green on a rerun on the same sha), `ciWatch` (each CI watch verdict), `triage` (ravenseat triage --verdict), `push`
and `load`. The figures: first-pass rate (the tasks done in the window, not fix tasks, with 0 fix rounds in `resumed`),
fix rounds per merged task, merge conflicts per week, base red verdicts, flaky gate commands, pushes per week with merged tasks and commits
per push, and the triage verdicts.

**Quality** (in the same Flow view, `lib/eventStatistics.js`) measures how often work was right, from data the queue
already keeps; a task without a field counts as "nothing recorded", never as an error:

- **Right first time:** a merged task (as for first pass) with 0 fix rounds, no QA deviation, not reopened (a logged
  status change away from done) and no post-merge defect. A **post-merge defect** is a fix task that names the task
  (`fixes`, the QA fix chain `qa_original`, the base gate fix task) or a finding with `ravenseat finding --cause <id>`.
  Shown as a rate and as defects per 10 merged.
- **Owner interventions per 10 merged:** changelog entries by owner or theBoard that change the task between its start
  and done (edit, park, continue, cancel and the like; `ravenseat set` writes no `by`). The changelog keeps its last 50
  entries, so a task started before the oldest kept one is counted as unknown.
- **Autonomy:** *verified tasks per owner intervention* = the merged tasks that were right first time or have every
  defect fixed (each fix task done, no QA deviation open, not reopened), divided by the owner interventions ("no
  interventions" at 0). *Longest stretch without the owner* = the longest time in the window when work ran (some task
  between its start and its done, or delivered; an open one up to now) with no owner action: owner or theBoard
  changelog entries and undos, owner answers, hand approvals, `qa ok` by hand, a QA deviation and tasks the owner
  added. A time when nothing ran (all work waiting, for example on an owner question) ends a stretch. *Corrected
  without the owner* = the fix rounds, red done commands (`receive` and `merge` start that round with
  `--from done_when`) and base red fix tasks on the tasks done in the window that ended green with no owner action on
  that task (an owner edit, a QA deviation, or an answer to its fix-round cap).
- **Reviewer hit rate:** per reviewer type over the tasks done in the window with a cost measurement: runs, runs whose
  FINDINGS line had findings, fix rounds the orchestrator attributed to the type (`ravenseat resume --from <reviewer,...>`,
  saved in `resumed[].from` and the fixRound row) and the dismissed rest. A type with 10 or more runs and no fix gets a
  hint ("reviewer-docs: 0 fixes in 14 runs"), once fix rounds carry `--from` at all.
- **Inflow:** the tasks added in the window by source (owner, agent proposals, fix tasks, triage = tasks made from a
  finding's plan entry, other), added versus done for the last 3 whole weeks, and a hint when more came in than went
  out in each of them.

Pushes are found after the fact: `ravenseat fill` reads the reflog of `refs/remotes/<remote>/<baseBranch>`, where git writes
"update by push" with the time after every successful push (a fetch writes "fetch: ..."), and logs each new push once
(`<dataFolder>/push-seen.json`) with the batch between the ref before it and the pushed tip and the base health of the
tip. This also covers pushes the owner makes by hand. It needs reflogs for remote refs (on by default in a normal repo).

**Load history** (`ravenseat limit`): one `load` row per `ravenseat fill` and `ravenseat start`, written before the load guard can stop the
command: free memory and CPU (when measured), the slots the adaptive rule allows against maxConcurrent, the running
tracks, and the guard's reason when it limited or stopped (exit 7). `ravenseat limit` shows the last 7 days: how many times
the slots were limited and by what, how many stops, and the latest ones.

**Cost per task, all runs** (`ravenseat cost`, `perTask` in `--json`) is one row per task, most expensive first: the first
track, the fix rounds and continuations (`ravenseat resume`, logged as `<id>-r<N>`), the reviewers, and the fix tasks that
point to it, with USD, tokens and the number of agent runs. A task measured at `set <id> done` uses that measurement
(it already holds its rounds and reviewers); a task without one (open, cancelled) uses its usage in the time log, and
the row says so. `--since` keeps the tasks with activity in the window, `--max` the number of rows.

### Auto-accept of proposals

Default off. With it on, a proposal that fits the owner's rules is approved by the queue itself, through the same path
as `ravenseat approve`: when it is added (`ravenseat add`) and, for older ones, at every `ravenseat orchestrator pulse`. Each one gets a
remark and a row in the log (`auto_accepted` in queue.json, the last 200), and `ravenseat proposals undo <id>` puts it back to
proposed as long as it has not been started; an undone task is never auto-accepted again.

- `ravenseat proposals` shows the rules and which proposals fit them now.
- `ravenseat proposals auto on|off [--classes K,U] [--max-estimate <min|none>] [--max-value <1-10|none>]` sets the rules in
  queue.json (`proposals.autoAccept`), which win over the config default (`proposals.autoAccept` in
  queue.config.json: `{ enabled: false, classes: ["K"], maxEstimateMin: 60, maxValue: null }`). The estimate is
  content_min times the class weight.
- `ravenseat proposals log [--json]` lists what was auto-accepted, newest first.

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
  "close_action": "ravenseat compact manual" }
```

- `follow add --file <json>` adds it (status `active`), `follow log <id> --text "…" --value name=x` logs along the
  way, `follow extend <id> --to <date>` moves the end, `follow` lists and `follow show <id>` shows one.
- From the end date (the machine's local calendar day) the entry is `to-report`: `show` and `orchestrator pulse`
  print TO REPORT until `follow report <id>` writes `<dataFolder>/follow/<id>-report.md` from the fixed template
  (Question, Setup, Measurements, Findings, Deviations and losses, Recommendation, Owner decision).
- `follow close <id> --decision "…"` (or `--cancelled`) records the owner decision, writes the report again with it
  and prints the close action. The command never runs the close action itself.
- The board shows the entries read only at `/follow`.

## When a project has no checks

A project with no gates or no CI config still runs. You are told, and you decide:

- **Before a push:** the push guard asks, with what is missing and how many commits go out. It never blocks.
  CI is detected by its config file (GitHub, GitLab, Bitbucket, Azure, CircleCI, Jenkins), which does not prove that it
  runs on this push. `push.controlsWarning: false` turns the question off.
- **At `ravenseat receive`:** with no quick gates and no done command it says `NO CHECKS RAN`. On a K task it also prepares the
  light review (`reviewer-light`). `ravenseat helpers off reviewer-light` turns the review off, the warning stays.
- **At `ravenseat merge`:** the task gets a verification status, shown in the output, on the card and in the detail panel.

| Status | Means | On the card |
|---|---|---|
| verified | Your gates or done command passed. The code can still be wrong | no badge |
| audited | An agent reviewed the change, but no check ran | **Audited** |
| unverified | No gates, no done command and no agent review ran | **Merged, not verified** |

Tasks merged before this came have no status and no badge. `/ravenseat:setup` sets up gates and offers a CI template.

### Adding checks one step at a time

### The Checks tab and `ravenseat checks`

The board's Checks tab and `ravenseat checks` show two things, as cards: what the project has (CI files with triggers and jobs, and
each kind of check with where it runs: CI, gate, script or git hook), and prioritized suggestions for what to add. It only reads
the project's files. Nothing is run, so it shows what is set up, not that it works. The picture is saved as
`checks-report.json` in the queue folder.

Each suggestion has a button, "Add investigation to queue" (`ravenseat checks plan <key>`). That adds one class U task from the
suggestion's template. It ends in a plan in the track result, with the build steps it recommends for you to pick from, never in code. "Set aside" removes the
card until you bring it back.

**Opting out:** `ravenseat checks off`, or the switch on the tab and in Settings. It removes the tab, the overview and the setup
suggestions, and changes no gates or guards. Without its own setting it follows `ravenseat guidance`, so quiet turns it off too.

**Changing the suggestions:** every suggestion is a template file with an "Investigate" and a "Plan and build" section, and the
categories are one list. Nothing is written in code. To add, change or remove them for a project, use the same layout in
`docs/queue/checks/`. A file with the same name replaces the plugin's, and `off: true` removes it. The format and the
conditions are in `scripts/orchestrator/checks-catalog/README.md` in the plugin.

### Kickstart

`ravenseat kickstart` (or `/ravenseat:kickstart`, which explains it in plain words) shows what the project has and one next step: git,
gates, secret files, then CI. It works before `ravenseat init` and in a folder without git, and it changes nothing. You can
stop at any step, and no step is required.

- `ravenseat kickstart gates --apply` writes the checks it found to `gates.quick` and `gates.full`, never over gates already
  set. It reads Node/TypeScript (`package.json` scripts, `tsconfig.json`) and Python (`pyproject.toml`, `tests/`). The
  skill reads other stacks itself.
- `ravenseat kickstart add [gates|secrets|ci]` proposes the step as a task (`KS-CHECK`, `KS-SECRETS`, `KS-CI`). It starts only
  when you approve it, and it uses tokens like any other task. Cancel it and the step stays declined.

The board shows the same steps under Settings, and a short line in the status bar while something is missing.

### Known bugs become gates

A bug that can happen again should be caught next time. A track says so with one line `GATE <failure class> @ <file:line>` in
`track-result.md`, and `ravenseat gate "<failure class>" [--from <task>] [--where <file:line>]` does the same by hand. It becomes a
gate task (`GATE-<n>`, label `gate`), and `gates.fromKnownBugs` decides how:

- `propose` (default): the task waits for your yes.
- `auto`: it is approved at once and runs when the queue gets to it. It uses tokens without asking.
- `off`: nothing happens.

At most three gate tasks are open at a time. The same class again adds the new place to the open task. A class you
cancelled is not proposed again.

### Red on base

The mission asks a track for red first: a test that fails before the change and passes after it. Without a check that is
only what the track says. Set `gates.redOnBase` to your test command, and `receive` checks it:

1. The track's new or changed test files run on the delivered tip. They must pass.
2. In the track's worktree, the rest of its change is taken away (changed and deleted files get their merge-base version,
   added files go), and each test file runs on its own. At least one must fail.
3. The worktree is put back (`git reset --hard` to the tip, which `receive` checked was clean).

`Red on base A: 1 of 2 ...` means it held. `RED ON BASE A: ...` names the tests that pass without the change too, or says
they fail on the tip or could not be checked. It is a warning in the receive output and a `Red on base` section in
`00-package.md`, never a stop: a pure refactor under existing tests is right to have no failing test on the base. Only
the verdict and the file names are kept (task field `red_on_base`), never the test output.

The files go where `{files}` is in the command, quoted, else at the end: `"npx vitest run {files}"`,
`"npx jest {files}"`, `"python -m pytest {files}"`. A test file is what the test-weakening check counts as one, plus
`testWeakening.testPaths`.

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
- The usage limit: when a turn ends because the subscription's limit is reached, new tracks and fix rounds stop with
  exit 12 ("USAGE LIMIT") until the reset, since they would only fail and use up fix rounds. Running tracks are left
  alone, and delivered tracks can still be received and merged. The StopFailure hook (Claude Code 2.1.78 or newer) reads
  the reset time from the session's transcript. A plain 429 does not pause anything, and a limit with no reset time
  pauses for one hour. After the reset the pulse names the tracks that were running once;
  `resume <id> --reason context` gives a stopped one a new agent without counting a fix round. `limit usageLimit clear`
  lifts the pause, `start --force` starts one task anyway, and `usageLimit.pause: false` turns it off. Ravenseat does not
  wake a stopped session. Claude Code continues an interactive session after the reset in most setups, but not in
  Remote Control or background sessions, not for a reset more than 24 hours away, and only three times in a row;
  otherwise start the queue again yourself.
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
  `state` has `loadSlots`, and `ravenseat limit` shows the load and the slots now. The floor of 1 means this rule alone
  never stops the queue; only the hard guard does. Turn it off with `loadGuard.adaptive: false` in the config or
  `QUEUE_LOAD_ADAPTIVE=off`; `fill --over-load` and `start --force` skip it for one call.
- Heavy gate runs take turns on the whole machine: [the queue for heavy gates](#the-queue-for-heavy-gates).
- With a migration flow, `start`, `fill` and `pick` skip taken blocks: a migration file, the block of a task that is
  not finished, or a block named on a "migration block" line in an active prompt file (a move by hand).
  `next-migr` refuses a number inside a taken block.
- Times are the machine's local time: the night window, the day the daily budget counts, the weekly quota reset
  and the statistics per day. To use another time zone, set the `TZ` environment variable (for example
  `TZ=America/New_York`) for Claude Code.
- Agents may only ADD proposals. Approval, merging and pushing belong to the orchestrator and the owner.

### The queue for heavy gates

The load guard looks when a track starts; it cannot stop several long test runs from landing at the same moment later. So
`gates.mjs --quick` and `--full` wait for a free slot when the last run of the same kind in this project's time log took at
least `gateQueue.heavyAfterSec` (default 120 s). No history counts as light, so a small project never notices it.

- One slot by default (`gateQueue.slots`), shared by all worktrees and projects of your user on the machine: folders under
  the system's temp folder, `ravenseat-gate-queue-<user>`. No service runs.
- The run prints one line saying who it waits for, and looks again every 3 seconds. There is no order among waiters.
- `--timeout-sec` starts when the check starts, not during the wait. The wait goes into the `gate` row as `wait_sec`;
  `duration_s` does not include it.
- A slot is free again when the run ends, also on a red run or a signal. A slot whose process is gone, or that is older than
  3 hours, is taken over. A queue that cannot be used (no write access) runs the gate without it.
- `--precheck` and the commands of a separate base gate (`baseGate.command`) do not queue. A gate command never queues:
  gates.mjs gives it `QUEUE_GATE_QUEUE=off`.

Apart from that queue, a run that records gate evidence (receive, merge, and runs in the main checkout) holds the evidence
lock of this project for as long as it runs: `<data folder>/gate-evidence.json.lock`. The tamper check compares the whole
evidence store before and after the run, so two such runs at the same time (two tracks received at once, or a second
session) used to read each other as tampering. Now the second one waits, looks again every quarter second, and its
`--timeout-sec` starts after the wait. A holder whose process is gone is taken over; a lock folder that cannot be used
means no lock, never a stuck gate. A gate command never waits for it: gates.mjs gives it `QUEUE_EVIDENCE_LOCK=held`.

### The temp folder

Tests leave things in the temp folder, and over thousands of runs it fills up. So every run of `gates.mjs` gives its gate
commands a folder of their own through `TEMP`, `TMP` and `TMPDIR` and removes it when the run ends, also after a red run.
Ravenseat does not need to know what your tests leave.

- A folder holding a link or junction is left in place, and the run says so: removing through a link can delete what it
  points at. A killed run also leaves its folder; a later run removes it when the process is gone and an hour has passed.
- The commands of a separate base gate and a task's done command keep the normal temp folder.
- If your tests need the shared temp folder, set `gateTemp.enabled` to `false`.
- `ravenseat doctor` has a `temp` line with the number of entries and the prefixes with the most. It counts and removes
  nothing else: only you can tell what another program's folders are for.

Plugins multiply with the number of agents. A plugin's start hook runs once per agent session, so four tracks and an
orchestrator run it five times, and a hook on a timer runs that much more often. A hook that installs packages can be the
largest source of both temp folders and load. When the machine struggles, look through your installed plugins
(`claude plugin list`) and turn off the ones this project does not use.
- `gateQueue.enabled: false` turns it off, `QUEUE_GATE_QUEUE=off|on` overrides that for one call, and
  `QUEUE_GATE_QUEUE_DIR` moves the folder.

It cannot deadlock with the other locks: the merge lock never waits (a second merge is refused at once), the queue's lock is
held only for short edits and never around a gate run, and a process in a slot takes neither. `ravenseat merge` does hold the
merge lock while its gate step waits for a slot, so other merges in that project are refused during the wait.

### Git hooks and config

A git hook, and git settings such as an alias or `core.sshCommand`, run code at the next git command, with your
credentials. Automated work in the repository runs as the same user, so it can write them. The queue therefore keeps
what was last accepted (`git-surface.json` in the data folder: hook hashes and setting names with hashed values, never
the values), recorded the first time `ravenseat fill`, `start`, `resume`, `receive` or `merge` runs.

`ravenseat receive`, `ravenseat merge` and the push check compare against it before they run anything. If something differs they stop
and change nothing. **This usually means nothing is wrong**: you installed husky or lefthook, updated one, or changed a
global alias. What to do:

```
ravenseat surface                     # each difference: the full path of a hook, the file a setting comes from
ravenseat surface accept --by owner   # you made the change: one command, then run again
```

If you did not make the change, remove it (the hook file, or the setting with `git config --unset`) and run again. A
hook tool's name in the output (`looks like a hook manager`) is a hint and accepts nothing. `ravenseat doctor` warns about the
same difference. A global setting stops the queue like a local one, because a program can write that file too.

If this is more friction than it is worth in your repository, change `gitSurface` in `queue.config.json`: `"warn"` says
the same things as a warning and stops nothing, `"off"` compares nothing. The cost is that a hook planted by automated
work then runs at the next git command, with your credentials. `ravenseat doctor` says when the check is off.

`TAMPERED` means something else: a check that ran the code under review changed these things *during* its run. That is
also your decision and never goes back to an agent as a fix round. The same two ways out apply. The limits: this detects,
it does not prevent. A change undone before the next check is not seen, a process that outlives its run can act later,
and git commands you or a script run by hand are not stopped.

### Your own Claude setup

A track runs as you, so it can write outside its worktree, also in your own Claude folder (`~/.claude`, or
`CLAUDE_CONFIG_DIR`). git never sees that folder, so no merge guard can catch a change there. `start` and `fill`
record a hash of each entry on a short list: `settings.json`, `settings.local.json`, `CLAUDE.md`,
`keybindings.json`, the plugin manifests (`plugins/installed_plugins.json`, `plugins/known_marketplaces.json`) and
the folders `agents/`, `commands/`, `skills/` and `hooks/`. `receive` compares and prints
`CLAUDE SETUP CHANGED <id>: <entries>` when one changed while the track ran, with the other tracks that ran at the same
time. It only warns, since you may have changed the setup yourself. Only hashes are stored on the task (`claude_fp`),
never content. Transcripts and the plugin cache are left out: they change all the time. `"claudeFingerprint": false`
turns it off.

## Configuration

Project-specific values live in `queue.config.json` at the project root (see `queue.config.example.json`): base branch,
branch prefix, gate commands, migration folder (optional), areas (`modules`) for the plan register, board port and title,
reviewer agents per class. Missing values fall back to safe defaults.

| Key | Default | Used for |
|---|---|---|
| `baseBranch`, `remote`, `branchPrefix` | `main`, `origin`, `queue/` | Integration branch, push remote, track branch names |
| `gates.quick`, `gates.full` | `[]` | Commands `gates.mjs` runs (empty = green) |
| `gates.redOnBase` | `null` | Red on base (see "Red on base"): a test command with `{files}`, or `{ command, timeoutSec, maxFiles }` (300 s, 10 files). `null` = off |
| `gates.fromKnownBugs` | `propose` | What a known bug becomes: `propose` (a task you approve), `auto` (approved at once, uses tokens without asking) or `off` |
| `gates.precheck`, `gates.precheckBudgetSec` | `null` (the standard checks), `120` | The fail-fast precheck `ravenseat gates --precheck` runs before the full gate, stopping at the first red check: commands or `{ name, command, files, budgetSec }`, with `{changed}` (the changed files against `baseBranch`) or `{file}` (once per file); `null` = `node --check`, `tsc --noEmit`, eslint and related tests when the project has them, `[]` = off (see orchestration.md) |
| `migrations.folder` | `null` | Optional numbered migrations; `null` turns block numbering and migration push off |
| `migrations.pushCommand`, `environmentFile`, `allowedEnvironment` | `null`, `null`, `[]` | `merge` runs the push command after merging (skip with `--without-migr-push`), but only when the environment file names an allowed environment |
| `reviewers` | D: `reviewer`, D+: `reviewer` + `reviewer-security` | Fixed reviewer agents per class after `receive` |
| `helpers` | challenger (U, `bug`) and design (`visual`) on; tests, gap, docs off | Optional helper agents with conditions; switch with `ravenseat helpers on\|off <agent>` (see orchestration.md) |
| `triage.minAgeDays`, `agentAdded`, `maxPerFill`, `askAgainMin` | `3`, `true`, `3`, `60` | Intake triage before a task starts: tasks added or last edited this many days ago (`null` = off) and agent-added tasks get a `triage` verdict first (`ravenseat triage`); at most this many steps per fill, not asked again within this many minutes. Off with `ravenseat helpers off triage` and in lite mode (see orchestration.md) |
| `push.mode`, `push.minTasks`, `push.warnTasks`, `push.maxAgeHours` | `"owner"`, `10`, `50`, `null` | Batch push threshold, counted in merged tasks since the last push (`ravenseat push-check` prints READY, NOT YET, BLOCKED or LARGE). `owner` = push only on the owner's word; `threshold` = the orchestrator may push on READY or LARGE, never BLOCKED. Below `minTasks` (0 = off) or on a red base the push guard asks before a plain push of the base branch; never denies. `maxAgeHours` makes old work ready below `minTasks`. Owner mode for new users; `threshold` with 10 and 50 for projects with expensive CI (see orchestration.md, Batch push) |
| `push.allowBranches` | `[]` | Branches the main session may push besides the base, for pull request flows: `["feat/*"]`, where `*` is any text. A forced push of such a branch asks first. Queue agents never push, a forced push of the base or a delete stays denied, and the secret scan runs on these too. Without it, you can also point `baseBranch` at an integration branch and open the pull request from that. |
| `push.controlsWarning` | `true` | The push guard asks before a plain push of the base branch when the project has no CI config or no gates, with what is missing and how many commits go out. It never blocks. `false` turns the question off |
| `push.ciWatch`, `push.ciWatchIntervalSec`, `push.ciWatchTimeoutMin` | `"off"`, `60`, `90` | The optional CI watch after a batch push: `"github"` (needs `gh`) makes push-check print `ravenseat push-check --watch-ci <sha>` for the orchestrator to start in the background. A failed check gives one fix task `CI-<sha7>` and a red base (exit 9), an infrastructure failure an owner question `ci-<sha7>-infra` and no freeze, a timeout exit 10. Local gates stay the rule (see orchestration.md, Batch push) |
| `baseGate.flakyRerun` | `true` | Before a red base check freezes the base, only the failed commands run once more on the same sha; green then is recorded as flaky (a `flakyGate` time log row, a finding, no freeze), red twice freezes. `false` = freeze at once |
| `productionBranch` | `null` (unknown) | The branch that goes live; `ravenseat doctor` warns when it equals `baseBranch` (every batch push would go to production) |
| `deployCommands` | `[]` | Commands that deploy, e.g. `["vercel --prod", "fly deploy"]`: the push guard asks before any command that starts with one of them, from an agent or the main session (a prefix match after env prefixes, so `npx vercel --prod` needs its own entry; a command inside `bash -c "..."`, `( )` or `cmd /c` is seen too). Empty = off |
| `secretScan.enabled`, `maxBytes`, `timeoutMs` | `true`, `2000000`, `3000` | Secret check before a plain push of the base branch from the main session: the added lines of every commit in `<remote>/<baseBranch>..<baseBranch>` are scanned (gitleaks when on PATH, else built-in patterns, JWTs, URI passwords and `.env` files included) and a hit asks with file:line, never the value. A first push (no remote ref) scans the branch, minus what the remote has on other branches. A scan that does not finish (over `maxBytes`, over `timeoutMs` per git or gitleaks call, any error) asks too, and says why; it never stops the push by itself |
| `largeFileMb` | `5` | `ravenseat doctor` warns about tracked files larger than this |
| `gitSurface` | `"stop"`, in lite `"warn"` | Git hooks and executing git config against the accepted baseline: `"stop"` stops receive, merge and the push check on a difference, `"warn"` only warns, `"off"` compares nothing (see "Git hooks and config") |
| `architectureRules` | `[]` | Short rules copied into every mission |
| `sharedLinks` | `["node_modules"]` | Folders linked into each worktree instead of reinstalled |
| `readGuard` | built-in lists | Extra agent types, auto-loaded files and large-file globs for the reading guard |
| `protectedPaths` | hooks, settings, agents, skills, the orchestrator scripts, the queue config, `package.json`, and the test, lint and type configs | Merge guard (replacing or emptying the list never frees the queue config, `.claude/`, git hooks, `CLAUDE*.md` and the queue scripts): paths a track may only change when its task owns them (`owned_files`/`shared_patch`), else `merge` stops with exit 4. `"folder/"`, `"dir/file"`, a bare file name (any folder) or a glob with `*` or `?` (without a slash: the file name in any folder; with one: the path from the root, `**/` = any folders). The config defaults: `vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `cypress.config.*`, `karma.conf.*`, `.mocharc*`, `tsconfig*.json`, `.eslintrc*`, `eslint.config.*`, `biome.json*`, `pytest.ini`, `tox.ini`, `setup.cfg`, `conftest.py`, `pyproject.toml`, `mypy.ini`, `.coveragerc`, `.flake8`, `.golangci.*`, `Cargo.toml`, `Makefile`, `Justfile`/`justfile`, `.pre-commit-config.yaml`, `phpunit.xml*`, `.rspec`. Also `.husky/`, lefthook, `.npmrc`, `.yarnrc(.yml)`, `.pnpmfile.cjs`, `.vscode/`, `.gitattributes`, and `CLAUDE.md` and `.claude/` at any level. The match ignores case (`.CLAUDE/` is `.claude/` on Windows and macOS). A list in the config REPLACES the defaults (copy the entries you keep); `[]` turns the guard off |
| `reads` | `{ "mode": "wait" }` | Read ownership (the task field `reads`): `wait` = a task waits while one reads a file the other changes; `warn` = it starts with the overlap named (`READS WARNING`, `explain`, the mission). `doctor` names any other mode |
| `claudeFingerprint` | `true` | The fingerprint of your own Claude setup (see "Your own Claude setup"): `start` records hashes, `receive` warns with `CLAUDE SETUP CHANGED`. `false` = off |
| `hotspots` | `[]` | Shared config many tasks need to touch (a route table, a registry, a central index), in the same pattern forms as `protectedPaths`. A hotspot can never be in a task's `owned_files`; a task that may change one names it in `hotspot_patch`, and only one active task can hold it at a time. A track that changes a hotspot it has not agreed gets a write warning, the pulse and `receive` say it, and `merge` stops with exit 4 (`--allow-guard` overrides and is logged). The track writes a wiring spec instead, and the owner or the hotspot holder applies it |
| `dependencyFiles` | `"stop"`, in lite `"warn"` | A task that changes `package.json`, a lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock` …), `pyproject.toml`, `Cargo.toml`, `requirements*.txt`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle(.kts)` or `composer.json` without owning it: `"stop"` stops the merge like any protected path, `"warn"` warns and merges. Nothing else softens with it |
| `identity.allow` | `[]` | Addresses the identity guard accepts although they look like a test identity (`ci@example.com`). Exact, not case sensitive |
| `testWeakening.enabled`, `focusStop`, `testPaths`, `markers` | `true`, `true`, `[]`, `[]` | `receive` warns, never stops, about deleted test files, test files moved out of the test paths and skip or focus markers on added lines in test files (`.skip(`, `.only(`, `xit(`, `it.todo(`, `@pytest.mark.skip`, `pytest.skip(`, `@unittest.skip`, `#[ignore]`, `t.Skip(`, `@Disabled`, `@Ignore`, `pending(`, `markTestSkipped` ...): one `WARN test weakening:` line and a `Test weakening` section in `00-package.md`. `testPaths` adds test file globs (the `protectedPaths` rules), `markers` adds regular expressions; `ravenseat doctor` names an invalid one. `focusStop`: a focus marker (`.only(`, `fit(`, `fdescribe(`) on an added line stops `merge`, since the other tests never ran; `--allow-focus` overrides (logged as `focus-overridden`), `false` = only the warning |
| `cloudHidden` | `[]` | Paths a cloud session cannot see (missions pointing there are stopped) |
| `cloud.maxSessions` | `3` | At most this many cloud sessions at once (a bundle counts as one), with no upper limit of its own. They share your plan's usage limits. `ravenseat cloud set` or the gear changes this and the settings below |
| `cloud.collect` | `ask` | When a session has finished: `off` you run the steps, `ask` the orchestrator asks and then runs `cloud collect`, `auto` it runs it without asking. Merge follows the usual rules in all three |
| `cloud.deleteBranch` | `true` | Remove the session's branch from the remote after the merge |
| `cloud.bundleMax` | `4` | Tasks in one session, one after another |
| `cloud.offerOnLeave` | `true` | The orchestrator offers `ravenseat cloud-go` once when you say you are leaving. `false` keeps it silent; the command still works. |
| `cloud.start` | `terminal` | `terminal`: you run `ravenseat cloud-start <id>`. `routine`: `ravenseat cloud send <id>` fires a scheduled task, without a terminal |
| `cloud.fireUrl` | `null` | With `routine`: the API trigger's URL on api.anthropic.com. The token goes in the environment variable `RAVENSEAT_CLOUD_TOKEN`, never in a file |
| `capacity` | Tuesday 19:00 local time | Weekly quota reset for `ravenseat capacity` |
| `models` | `{}` (each agent file's model, opus) | Model per agent, e.g. `{ "reviewer-docs": "sonnet" }`: printed as `model=<m>` on the start lines and passed to the Agent tool (opus, sonnet, haiku, fable; an unknown value is ignored) |
| `loadGuard.minFreeMemoryPct` | `10` (off on macOS) | Load guard: no new starts while free memory (percent) is below it; `ravenseat limit minFreeMemoryPct` overrides per queue |
| `loadGuard.adaptive`, `minSlots`, `allSlotsFreeMemoryPct` | `true`, `1`, `40` (off on macOS) | Load-aware slots: fewer than `maxConcurrent` slots while free memory is below `allSlotsFreeMemoryPct`, at least `minSlots`; `QUEUE_LOAD_ADAPTIVE=off` turns it off |
| `loadGuard.allSlotsCpuPct`, `minSlotsCpuPct` | `null`, `null` | Optional CPU part of the load-aware slots (both set, e.g. `60` and `95`) |
| `gateQueue.enabled`, `slots`, `heavyAfterSec` | `true`, `1`, `120` | [The queue for heavy gates](#the-queue-for-heavy-gates): how many heavy `--quick`/`--full` runs may run at once on the machine, and from how many seconds (the last run of the same kind) a run counts as heavy |
| `gateTemp.enabled` | `true` | [The temp folder](#the-temp-folder): each gate run gets a temp folder of its own, removed afterwards |
| `proposals.autoAccept` | `{ enabled: false, classes: ["K"], maxEstimateMin: 60, maxValue: null }` | Auto-accept of agent proposals by the owner's rules (`ravenseat proposals`); the queue's own rules win; never D/D+, `waiting_on`, legal/owner labels, open legal points or protected paths |
| `qa.evidenceTypes`, `qa.autoTypes`, `qa.manualTypes` | `screenshot`, `test`, `manual`; auto `test`; manual `manual` | QA evidence types a track writes as `EVIDENCE <type>[=<ref>]`; auto types are closed by `qa auto --run`, manual ones gathered in one round |
| `qa.autoCommand` | `null` | Shell command for auto evidence, e.g. `npx vitest run {refs}` (`{refs}`, `{id}`; or `{ "<type>": "<command>" }`); `null` = `qa auto` only lists |
| `qa.evidenceLabels` | `["visual"]` | Labels for which `receive` warns when the `EVIDENCE` line is missing |
| `excludeBranches` | `["main","master"]` | Branches never treated as external work |
| `protectedPaths` | `.claude/`, `scripts/orchestrator/`, plugin hooks/agents/skills, `queue.config.json`, `CLAUDE.queue.md`, `package.json` … | Merge guard: a track may only change these when its task owns them; `[]` turns it off |
| `modules`, `projectModuleSuggestion`, `priorityRules`, `documentFolders`, `indexFile`, `documents`, `planBackup` | see `queue.config.example.json` | Plan register (see `plan-register.md`) |
| `board.port`, `board.title` | `2000`, `Queue board` | Board |
| `board.updateCheck` | `true` | Board: look for a newer ravenseat on GitHub at most once per 24 hours (see board.md, Update banner) |
| `board.showCloud` | `true` | Board: show the Cloud tab while `features.cloud` is on. `false` keeps the tab away with the module on. `ravenseat board-setting cloud on\|off` sets it in queue.json, which wins |
| `features` | `plans`, `focus`, `statistics` on; `cloud`, `follow`, `plans.legal`, `plans.launch`, `plans.documents` off | Modules that can be switched off. Off hides them on the board (tabs, buttons, routes; see board.md, Modules); `cloud*` and `follow*` commands answer "Cloud is off (features.cloud in queue.config.json)." with exit 0, and `show` and the pulse skip follow-up lines. `plans` only hides the board's Plans room: `ravenseat plan` always works. A part (`plans.legal`) is off when its parent is off; unknown keys are ignored. Restart the board after a change |
