#!/usr/bin/env node
// =============================================================
// queue.mjs: work queue for continuous parallel work with Claude Code agents.
//
// The queue lives in <dataFolder>/queue.json (default scripts/.queue/, gitignored), so it survives the orchestrator's conversation
// being compacted or restarted. Anyone with Bash (orchestrator, planners, reviewers, tracks) can add
// work. Writes happen under a file lock (mkdir is atomic) and via a temporary file + rename, so two concurrent writers
// do not corrupt the file. The logic (what can start, priority, limits) is in lib/queueLogic.js; the project's settings
// (baseBranch, branchPrefix, gates, migrations, architecture rules) live in queue.config.json (lib/queueConfig.js).
// The queue and the commands are described in docs/queue.md, the orchestrator loop in docs/orchestration.md, the tracks' protocol in
// docs/mission-template.md and the plan register in docs/plan-register.md.
//
// "Base branch" below is config().baseBranch (the integration branch everything is merged into), and the queue branches are named
// <branchPrefix><id> (default queue/<id>).
//
// Basics:
//   node scripts/orchestrator/queue.mjs init [--next-migr <n>] [--max-concurrent 5] [--max-dplus 2] [--max-per-domain 7]
//        (creates the data folder and an empty queue with defaultLimits and the example project "example"; never touches an
//         existing queue. --next-migr only when the migration flow is enabled)
//   node scripts/orchestrator/queue.mjs init --lite|--full
//        (also writes "mode" into queue.config.json, for an existing queue too. A fresh init without a flag writes
//         "lite" when the config has no mode of its own; lite gets the project "tasks" (prefix T-). lib/liteMode.js)
//   node scripts/orchestrator/queue.mjs mode [lite|full]             (show the mode, or write it into queue.config.json)
//   node scripts/orchestrator/queue.mjs add "<title>" [--mission "<text or path>"] [--priority 1-10] [--files a,b] [--depends a,b]
//        [--id <id>] [--by "<who>"]   (lite mode only: one task from a title; id T-001..., class K, value 5 or
//         --priority, 30 min, the mission = the title. No small-task guard or batch queue in lite)
//   node scripts/orchestrator/queue.mjs add --file task.json        (one object, a list, or { "tasks": [...],
//                                                                  "question": { "<id>": { type, text, ... } } })
//   node scripts/orchestrator/queue.mjs add --json '{"id":"A-1",...}' [--approved]
//        Status: "proposed" when added_by is an agent (a track/task id, reviewer or investigation agent), otherwise
//        "waiting". --approved (only orchestrator/the owner, e.g. a serious finding from review) gives waiting.
//        --accept "<criterion>" (repeatable, one task only): its acceptance criteria (field acceptance), copied into
//        the mission and checked one by one by reviewer-gap.
//   node scripts/orchestrator/queue.mjs approve <id> [...] [--by "<who>"]   (proposed -> waiting; --by is kept as approved_by)
//   node scripts/orchestrator/queue.mjs proposals [auto [on|off] [--classes K,U] [--max-estimate <min|none>]
//        [--max-value <1-10|none>]]   (auto-accept of agent proposals by the owner's rules, default off; applied by add
//         and orchestrator pulse; never D/D+, waiting_on, legal/owner labels, open legal points or protected paths)
//   node scripts/orchestrator/queue.mjs proposals log [--json]       (what was auto-accepted, newest first)
//   node scripts/orchestrator/queue.mjs proposals undo <id>          (back to proposed when it has not been started)
//   node scripts/orchestrator/queue.mjs forecast [--project <pid>] [--days 28] [--json]   (Monte Carlo: when the
//                                                                  remaining tasks (the focus stages, otherwise all open)
//                                                                  are done at 50/85/95 %, from the daily throughput)
//   node scripts/orchestrator/queue.mjs show                           (short: active ones, startable now and counts)
//   node scripts/orchestrator/queue.mjs show <id>                      (one task, the same as info <id>)
//   node scripts/orchestrator/queue.mjs show --full [--all]           (table: status, class, estimate, priority, blocker;
//                                                                  the proposals separately at the bottom; --all/--grouped/
//                                                                  --project also give the full one)
//   node scripts/orchestrator/queue.mjs next                         (what can start now, without changing anything; exit 4 when
//                                                                  the daily budget is used up, exit 5 during the night pause,
//                                                                  exit 7 when the machine is full)
//   node scripts/orchestrator/queue.mjs start <id> [--agent <name>] [--force]   (marks running, assigns branch and, if any,
//                                                                  migration block; --force = the owner wants it first,
//                                                                  also overrides the daily budget, the night pause and
//                                                                  the load guard)
//   node scripts/orchestrator/queue.mjs set <id> <proposed|waiting|running|review|done|cancelled> [--remark "..."]
//   node scripts/orchestrator/queue.mjs edit <id> --json '{"value":8,"priority_bonus":50}' [--by "..."] [--answer-json]
//        (logged in the changelog, so `undo` rolls it back; --answer-json: the answer as JSON with the changelog no.)
//   node scripts/orchestrator/queue.mjs edit <id> --files a,b [--by owner]   (replaces the files the task owns; "" empties the
//        list. Locked after the start, like done_when: only --by owner or the board then. An edit that changes nothing is an error.)
//   node scripts/orchestrator/queue.mjs edit <id> --accept "<criterion>" [--accept "..."]   (replaces the acceptance
//        criteria; null in --json removes them. done_when and acceptance are LOCKED once the task has started: only
//        --by owner (or the board, theBoard) changes them then, and never from inside a track worktree (the cwd on a
//        queue/<id> branch), whatever --by says; undo follows the same rule. lib/doneCheck.js doneLockError)
//   node scripts/orchestrator/queue.mjs cancel <id> [--remark "..."] [--by "..."] [--expect-changed <iso>] [--json]
//        (a waiting (also on hold or batched) or proposed task -> cancelled, the same result as set <id> cancelled
//         --remark, but logged in the changelog so `undo` puts it back. Declining a proposal is cancel with the
//         remark "declined: <reason>". Running, picked and review tasks are refused: use set <id> cancelled.)
//   node scripts/orchestrator/queue.mjs state                      (exit 3 when the queue is empty of work, also when
//                                                                  the daily budget or the night pause stops new tasks;
//                                                                  the field stop says which)
//   node scripts/orchestrator/queue.mjs trackFile <id> [...] --out <file> (track blocks in make-mission.mjs format; running or picked)
//
// Owner questions:
//   node scripts/orchestrator/queue.mjs resolve <question> [...] [--answer "..."] [--by "..."]   (the owner's answer has come: with
//                                                                  a timestamp in `resolutions`, the answer optional; with
//                                                                  --answer every task waiting on the question gets
//                                                                  the addition "OWNER_ANSWER <id> (<date>): <answer>" in
//                                                                  the mission, once)
//   node scripts/orchestrator/queue.mjs resolve <question> --choice <n|text> [--answer "note"] [--by "..."]   (picks one of
//                                                                  the question's choices, by number from 1 or by its text;
//                                                                  the answer stored is the choice's text, plus
//                                                                  " (note: ...)" when --answer is given; one question only)
//   `waiting_on` takes ONLY registered question ids (letters, digits, ".", "_", "-", at most 40 chars, no
//   whitespace) with text and type in `question`. add and edit REJECT (all or nothing) a new id that is not
//   registered, unless the add file registers it in { tasks, question }; free text is stopped. edit-many and the board
//   cannot edit waiting_on. fill, show and state (the field resolveWaits) report loose waits: free text,
//   unregistered, or an answered question that still blocks.
//   node scripts/orchestrator/queue.mjs resolutions [--unlogged]       (the answers with time; --unlogged: not yet entered in
//                                                                  the decision log)
//   node scripts/orchestrator/queue.mjs resolutions --mark-logged <question> [...]   (the orchestrator has entered them)
//   node scripts/orchestrator/queue.mjs question                      (the owner questions: text, type, open or resolved)
//   node scripts/orchestrator/queue.mjs decide [--json] [--max N] [--today]   (the decision overview, read-only: everything
//                                                                  waiting on the owner (questions, QA, proposed, stuck work)
//                                                                  as one list, most impact first (what the answer unlocks,
//                                                                  focus stage 1 first), each option with its exact ravenseat
//                                                                  command (--by owner, the same commands the board runs);
//                                                                  --today: what was decided today. The /ravenseat:decide skill
//                                                                  walks it; lib/queueDecisions.js, cli/decide.mjs)
//   node scripts/orchestrator/queue.mjs board-setting [cloud on|off]   (the board's own switches: without arguments the values;
//                                                                  cloud on|off shows or hides the Cloud tab, queue.json
//                                                                  board.showCloud, default hidden; cli/board.mjs)
//   node scripts/orchestrator/queue.mjs wait [--debounce <s>] [--timeout <h>] [--since <log-nr>] [--check-min <n>]   (blocks until the owner
//                                                                  acts: resolve, approve, qa ok/fail, add, or an edit by owner/
//                                                                  theBoard after the start point; then waits --debounce (30 s)
//                                                                  for more and prints OWNER ACTED: <action> <ids>; ... (ids
//                                                                  only), exit 0. TIMEOUT after --timeout (8 h), exit 10. Every --check-min (5) min it runs the track checks: TRACKS NEED A LOOK, exit 11. One
//                                                                  at a time (ALREADY WAITING, exit 0); started with
//                                                                  run_in_background by the orchestrator loop; cli/wait.mjs)
//   node scripts/orchestrator/queue.mjs question <id> --text "..." [--type question|condition|lawyer|owner-task]
//        [--recommendation "..."] [--source "..."]                          (sets one; fields not given are kept)
//        [--choice "..." --choice "..." (2-4) | --no-choices]           (answer options: each at most 60 characters, no
//                                                                  duplicates; put the recommended one first, or let
//                                                                  --recommendation be its exact text to mark it)
//   node scripts/orchestrator/queue.mjs question --file <json>         ({ "<id>": { type, text, recommendation?, source?, choices? } };
//                                                                  all or nothing)
//
// Limits, capacity and guards:
//   node scripts/orchestrator/queue.mjs limit [<name> <val>]       (show or set limits: maxConcurrent, maxDPlus,
//                                                                  maxPerDomain, maxDb (integer >= 0; maxDPlus at most
//                                                                  maxConcurrent), dailyBudget <usd|off>,
//                                                                  nightRun <on|off>, nightWindow <HH-HH>,
//                                                                  autocompact <on|off>, parallelThreshold <0-1>,
//                                                                  silentMin <minutes, 0 = off>)
//   node scripts/orchestrator/queue.mjs compact [auto|manual]        (show or set the compaction mode for
//                                                                  the orchestrator session, limits.autocompact; prints which
//                                                                  /autocompact line the owner pastes in)
//   node scripts/orchestrator/queue.mjs capacity [--json]            (weeklyQuota: used since the last reset in
//                                                                  USD equivalent and tokens, estimated %, pace per day,
//                                                                  when the quota runs out, and how many concurrent tracks
//                                                                  last until the next reset; reset day,
//                                                                  clockTime and planName live in config().capacity)
//   node scripts/orchestrator/queue.mjs capacity --calibrate <percent> [--time <ISO>]   (the percentage Claude shows now, or
//                                                                  at --time: corrects the constant usd_per_100 in queue.json)
//   node scripts/orchestrator/queue.mjs capacity --mode notice|cap|off   (fill: only a notice (default), a cap on new tracks
//                                                                  that is overridden with fill --over-quota, or off)
//   node scripts/orchestrator/queue.mjs capacity --set <usd_per_100>   (set the constant directly)
//   node scripts/orchestrator/queue.mjs capacity --calibrate auto   (the 7-day percentage the status line saw last,
//                                                                  <dataFolder>/rate-limits.json; refused when it is
//                                                                  older than 1 h or from another quota week)
//   node scripts/orchestrator/queue.mjs capacity --cloud-credit <left_usd> [--total <usd>] [--expires <ISO>]
//                                                                  (a separate pot for cloud sessions, set by hand)
//
// Low parallelism (the logic is in lib/queueDiagnose.js): when the queue runs on fewer agents than limits.parallelThreshold (default
// 0.7) of maxConcurrent, `fill` (after the lines about what is started; the newly started count), `receive` and
// `orchestrator pulse` print a short paragraph "LOW PARALLELISM: ...", and `state` has the field `parallel`. Above the threshold
// nothing is printed. The finding types: depends-on-cancelled, depends-on-unknown, dragged-with-paused, lose-waiting,
// waiting-on-resolved (cleanup, only in diagnose) and bottleneck. The diagnosis never fixes anything itself; each finding is "simple"
// (mechanical and unambiguous: a finished command the orchestrator runs) or "complex" (an option with a recommendation to the owner).
//   node scripts/orchestrator/queue.mjs diagnose [--json]             (the whole diagnosis regardless of parallelism; read-only)
//   node scripts/orchestrator/queue.mjs conflicts [--json] [--budget-ms <n>] [--max-checks <n>]   (read-only: each running,
//        picked or review track tip against baseBranch and against the other tips with git merge-tree --write-tree
//        (git >= 2.38; older git: changed-file overlap, with a note), cached per sha pair in <dataFolder>/conflict-predict.json,
//        and a suggested merge order. `orchestrator pulse` prints the same PREDICTED CONFLICT / CONFLICTS WITH BASE lines.
//        lib/conflictPredict.js)
//   node scripts/orchestrator/queue.mjs doctor [--json]               (read-only health check, OK/WARN/FAIL with a fix hint each:
//                                                                  node and the node the hooks find on PATH, the hooks file and
//                                                                  its scripts, queue.config.json keys and types, the state
//                                                                  files, a stale lock, half-deleted worktree folders and git
//                                                                  worktrees without a folder, branches of finished tasks,
//                                                                  CI cost and the safety baseline (secret files, gates, CI,
//                                                                  lockfiles, productionBranch, large files; offline);
//                                                                  exit 1 on any FAIL; cli/doctor.mjs)
//   node scripts/orchestrator/queue.mjs machine [--measure]           (cores, memory, free memory now and a suggested maxConcurrent,
//                                                                  an estimate that changes nothing. --measure, started by
//                                                                  you, refused while a track runs: gates --full once, then the
//                                                                  time, the lowest free memory and a suggestion for this
//                                                                  project; cli/machine.mjs)
//
// The orchestrator's routine as a script and the cost per task (the pure logic is in lib/queueLogic.js):
//   node scripts/orchestrator/queue.mjs fill --scratchpad <folder> [--max N] [--ids <id …>] [--over-quota] [--over-load]
//        (next -> start -> trackFile -> make-queue-common -> make-mission in one call. Writes <folder>/prompt-<id>.md and
//         <folder>/queue-fill.json { time, head, track: [{ id, class, subagent_type, model, prompt, message, branch,
//         migr_block, new, warning }] } (subagent_type, model and message are the Claude adapter's, lib/clients/claude;
//         model null = the agent file's; new false = was already running; warning = changed outside the queue), and
//         one line + the agent message per track. Saves head_start (HEAD on baseBranch, --wave-base for merge-track) and scratchpad
//         on the task. --ids: only these; one that is already running only gets new prompt files (after an error).
//         QUEUE_SCRATCHPAD can replace --scratchpad. Without --ids, fill prints a quota line when the forecast
//         empties weeklyQuota before the reset; with capacity --mode cap at most that many new ones start, and --over-quota
//         overrides. The load guard (exit 7, the machine is full) stops new starts; --over-load overrides. The usage
//         limit (exit 12, lib/usageLimit.js) stops new starts and resume until the reset; limit usageLimit clear lifts it.
//         Intake triage (lib/queueTriage.js): a task added or last edited triage.minAgeDays (3) ago or more, or added by an
//         agent, is not started without a verdict; other tasks take its slot, and fill writes <folder>/triage-<id>.md and
//         puts the `triage` helper in the same-turn block for the first triage.maxPerFill (3) of them. --ids refuses such
//         a task; start --force on the owner's word overrides.)
//   node scripts/orchestrator/queue.mjs receive <id> [--scratchpad <folder>] [--result "RESULT …"] [--force]
//                                                 [--done-cwd <folder>]
//        (the track has delivered: status review, and the review package as PLAIN FILES in <folder>/rev-<id>/: 00-package.md
//         (resultLine, changed DB objects if any, diff statistics), diff.patch, files/ (changed files in full version
//         from the branch), trackReply.md (the track's last answer from the transcript), trackReport.md and handover.md (from
//         <folder>/<id>/), mission.md (the prompt file), and reviewer-<type>.md (the short prompt) per reviewer: the fixed
//         ones by class (config().reviewers) and the helper agents that are on and hit (lib/queueHelpers.js).
//         Saves the RESULT line. Does NOT merge; prints the merge command. The track's own gate runs (RESULT gates=) are
//         informational: receive runs the quick gates itself on the delivered tip (gates.mjs --evidence) and saves the
//         task field gate_check (red: the blocker gate-red and a fix round). A batch push needs ravenseat gates --full run in the
//         main checkout on the base tip with no uncommitted changes (ravenseat push-check reads that gate evidence).
//         Adoption: the report is the newest in <folder>/<id>/ or a fix round <folder>/<id>-r<N>/, in the orchestrator's
//         and the task's scratchpad; saves report_received.
//         Done command (task field done_when, lib/doneCheck.js): run first in the worktree that has the branch checked
//         out (--done-cwd overrides), with config().doneCheck.timeoutSec. Red: no reviewers, the blocker gate-red, only
//         the output tail in <folder>/done-<id>.md, and resume --reason fix is run (exit 1; exit 8 at the fix-round cap).)
//   node scripts/orchestrator/queue.mjs deliveries [--json]
//        (adoption: active tasks with a track-result.md that has not been received: first line RESULT status=DONE|PARTIAL and
//         newer than the start, the delivery and the last receive. `orchestrator pulse` prints the new ones every round (and
//         remembers them in report_seen), so a new session that has adopted the tracks sees the delivery without
//         <task-notification>.)
//   node scripts/orchestrator/queue.mjs attempt list <id> [--json]   (the task's attempts, lib/logic/attempt.js: reserved, running or
//                                                 ended, derived from the agents' start and stop rows in the time log;
//                                                 a reservation past attempts.reservationTtlMin reads as expired)
//   node scripts/orchestrator/queue.mjs attempt close <id> --outcome <delivered|failed|interrupted|abandoned> [--by "..."]
//        (a running attempt blocks a new one, so close it when its agent is gone. For Claude the guard is best effort; the
//         cases are at the top of lib/logic/attempt.js. Refused inside a track worktree; logged, so ravenseat undo takes it back.)
//   node scripts/orchestrator/queue.mjs resume <id> [--reason fix|context] [--round N] [--findings-file <file>]
//                                                [--from <reviewer,...>] [--answer "<text>"] [--scratchpad <folder>]
//        (--answer: the owner's answer to what the track asked; first in the brief, and kept as an addition to the mission.)
//        (--from: the reviewer types whose findings caused the fix round, saved in `resumed[].from` and the fixRound
//         row; the reviewer hit rate in ravenseat cost and the board's Flow box counts them.)
//        (fix-round cap: at max_fix_rounds (task) or config().maxFixRounds (default 3) fix rounds, --reason fix registers
//         the owner question <id>.fixcap<N>, puts it in waiting_on, opens the blocker owner-question and exits 8; a resolved
//         question allows exactly one more round. A red done command's tail goes into the fix brief.)
//        (adoption: prompt-<id>-r<N>.md for a NEW agent on the same branch, fix round (default) or continuation after the
//         context guard: the same template as fill, with prepare-track --continue, the paths to track-result.md, handover.md,
//         the review package and the findings, and the original mission. N is the next free round. Not `continue`,
//         which takes tasks off hold.)
//   node scripts/orchestrator/queue.mjs set <id> done [--findings "FINDINGS H=0 M=1 L=3 …"] [--result "…"] [--without-cost]
//        (measures the cost: the agents in the time log that belong to the task (the track label, fix rounds, and reviewers without
//         a label when their mission mentions the id), usage from the transcripts; saves cost {usd, tokens, turns,
//         agents} and findings {H, M, L, deferrable, reports} from the reviewers' FINDINGS lines or --findings (repeatable).
//         If the measurement fails, the task is set done anyway.)
//   node scripts/orchestrator/queue.mjs cost [--since 7d|24h|2026-10-01] [--max 10] [--json]   (first USD per merged change:
//                                                                  all measured cost in the time log for the window (default
//                                                                  28 days) / tasks that reached done (a fix task counts with
//                                                                  the task it fixes); then cost per task with all its runs
//                                                                  (track, fix rounds, continuations, reviewers and fix tasks
//                                                                  via fixes/qa_original: USD, tokens, runs), by cost; then
//                                                                  per class: n, median and sum USD, findings H/M/L; the last tasks)
//   node scripts/orchestrator/queue.mjs cost measure <id> [...] [--findings "..."]   (measures and saves again, e.g. older finished ones)
//   node scripts/orchestrator/queue.mjs calibrate [--days 28] [--min 5] [--json]   (per class: n, median actual/estimate
//                                                                  minutes and the suggested weight, median USD, the model's
//                                                                  USD and the cost factor; lib/costEstimate.js. The ~$ cost
//                                                                  estimates in show, next, fill, info and state use it;
//                                                                  the weights and the order are never changed by it)
//   node scripts/orchestrator/queue.mjs guidance [guided|quiet]     (one switch for advice about CI, gates and lockfiles, the
//                                                                  light review, triage and gate proposals; never a guard)
//   node scripts/orchestrator/queue.mjs helpers [--json]            (the helper agents: on/off, when they run, and the
//                                                                  measurement: runs, minutes, tokens, USD, share, findings)
//   node scripts/orchestrator/queue.mjs helpers on|off <agent>      (switches a helper in queue.json; wins over
//                                                                  helpers.<agent>.enabled in queue.config.json; a custom
//                                                                  helper only goes on when approved for its file as it is)
//   node scripts/orchestrator/queue.mjs helpers add <file.md> [--name <name>] [--classes K,U] [--labels a,b] [--paths p,q]
//        (a custom helper: copies the file to .claude/agents/<name>.md, registers it in queue.json as source custom with
//         path, sha256 and added_at, scans it, and leaves it OFF until it is reviewed and approved)
//   node scripts/orchestrator/queue.mjs helpers scan <agent> [--json]   (the machine scan, lib/helperScan.js: red/yellow/green)
//   node scripts/orchestrator/queue.mjs helpers approve <agent> [--by "<who>"] [--sha256 <hash>] [--force]
//        (binds the approval to the file's sha256; a red scan needs --force and the owner's explicit yes; --sha256 refuses
//         when the file is not the one that was read)
//   node scripts/orchestrator/queue.mjs helpers when <agent> [--classes ..] [--labels ..] [--paths ..] [--mostly-paths ..]
//        (the conditions of a custom helper; "none" clears a list)
//   node scripts/orchestrator/queue.mjs helpers remove <agent> [--delete-file]   (drops the registration; the copied
//                                                                  file is only deleted with --delete-file)
//   node scripts/orchestrator/queue.mjs triage                      (the tasks that need an intake triage verdict, and why)
//   node scripts/orchestrator/queue.mjs triage <id> --verdict ready|done|stale|adjust [--note "..."] [--by "..."]
//        (records the triage helper's answer. ready: the task can start. adjust: the note is added to the mission (bonus),
//         then it can start. done and stale (a note is required: the evidence file:line, or why): the owner question
//         triage-<id> with the choices Close as done|stale, Keep and start anyway, Rewrite, in waiting_on; never closed
//         without the owner. `resolve triage-<id> --choice <n>` then cancels, keeps or parks the task (Rewrite: edit the
//         mission, then continue). Off: helpers off triage; off in lite mode unless switched on.)
//   node scripts/orchestrator/queue.mjs triage <id> --prompt [--scratchpad <folder>]   (writes triage-<id>.md again and
//                                                                  prints the agent line)
//   The transcripts: ~/.claude/projects/<repo-slug>/<session>/subagents/agent-<id>.jsonl (QUEUE_TRANSCRIPTS overrides).
//
// Fewer orchestrator turns: `fill` and `receive` end with "Start these in the SAME turn:" and one line per agent
// (subagent_type + message); start them in one turn. `receive` warns when the track's answer exceeds the report cap (about 1,500 chars).
//   node scripts/orchestrator/queue.mjs merge <id> [--without-migr-push] [--without-fill] [--scratchpad <folder>] [--force]
//        [--allow-guard] [--allow-partial] [--done-cwd <folder>] [--force-red-base]
//        [--resume]
//        (one merge at a time per repo: the lock <dataFolder>/merge.lock with pid, host and start time; a held lock
//         refuses with the holder, a stale one (the pid is gone, or older than 6 h) is taken over. A merge, rebase,
//         cherry-pick or revert in progress in the main checkout (MERGE_HEAD and so on) refuses the merge with how to
//         finish or undo it. The track tip must be in baseBranch (git merge-base --is-ancestor) after the merge and before
//         done, otherwise nothing is marked; the merge commit is stored on the task as merge_commit. Every step is
//         recorded in <dataFolder>/merge-state-<id>.json; --resume (after Ctrl-C, a crash, a stop after the merge or a
//         conflict resolved and committed by hand) runs the steps after the merge that have not run: migration push,
//         gates, base gate, done, fill. lib/mergeLock.js.)
//        (with a done command: run again first unless the last green run was on the same branch tip; red = a fix round
//         as in receive, never a merge, exit 1 or 8.)
//        (after an approved review; run from Bash (merge-track calls sh), with a long timeout: the gates can take minutes. In one
//         call: merge-track.mjs <branch> --wave-base <head_start> -> the migration step (only when config().migrations is
//         enabled and the branch has migration files: the environment guard (environmentFile/allowedEnvironment) and the push guard are asked, then
//         migrations.pushCommand) -> gates.mjs --quick -> set <id> done (cost measurement) -> fill (unless
//         --without-fill). Stops at the first error with the step and an error excerpt; full log in <scratchpad>/merge-<id>.log.
//         Exit 0 ok, 1 stop, 4 the merge guard stopped it before the merge: the branch touches protected paths
//         (config().protectedPaths) the task does not own. Read the diff; then add the path to owned_files/shared_patch,
//         or run again with --allow-guard, which is passed on to merge-track.mjs and logged as "guard-overridden".
//         Exit 9: the base branch is red (the base gate, lib/baseHealth.js): before the merge (nothing done; only the
//         base fix task merges, --force-red-base overrides on the owner's word and is logged as "base-red-overridden"),
//         or after it when the base gate commands went red (the merge stays, a fix task <id>-BASE<n> is added).)
//   node scripts/orchestrator/queue.mjs info <id> [--field <name>] [--json]   (short view; one field raw, also cost.usd)
//   node scripts/orchestrator/queue.mjs ask <id> ["<question>"] [--bundle] [--json] [--max-chars <n>] [--out <file>]
//        [--scratchpad <dir>]   (a question about an earlier track without resuming its agent: a size-capped,
//         secret-redacted bundle of the mission, track-result.md, handover.md, the queue's notes and owner answers, the
//         commits and diffstat, and the transcript tail. Prints it with an answer instruction; --bundle writes it to
//         <scratchpad>/ask-<id>/bundle.md and prints the path, for /ravenseat:ask. Read-only. cli/ask.mjs, lib/askBundle.js)
//   node scripts/orchestrator/queue.mjs edit <id> --bonus "<text>"  (to the mission, in the track block from the next
//                                                                  trackFile/fill, and to the remarks, with a timestamp)
//   node scripts/orchestrator/queue.mjs activeOnes                        (running/picked/review: id, class, branch, migr_block,
//                                                                  head_start, age)
//   node scripts/orchestrator/queue.mjs next-migr [<n>]              (only with the migration flow: show or set; refuses
//                                                                  going backward and down into a used number: the highest
//                                                                  migration file or assigned block, and into a taken block)
//   node scripts/orchestrator/queue.mjs migr move <id> <block> [--scratchpad <folder>] [--force]
//         (only with the migration flow: moves the block (3470 or 3470-3479) in the queue and in the prompt files
//         ("Migration block:" line and mentions); refuses a taken block. start, fill and pick skip taken blocks by
//         themselves: a migration file, the block of a task that is not finished, or one named in an active prompt file.)
//   Test: QUEUE_MERGE_RUNNING=<module> injects the runner into merge (no real merge, push or gates).
//
// Silent tracks and blocker reasons (the logic is in lib/queueLogic.js, the activity measurement in lib/trackActivity.js):
//   SILENT: `show`, `state` (the field `silent`) and `orchestrator pulse` warn about a running track whose worktree
//   has the branch but that has shown no sign of life (commit, worktree or track folder mtime, time log or transcript)
//   for limits.silentMin minutes (default 20; `limit silentMin <n>`, 0 = off).
//   node scripts/orchestrator/queue.mjs block <id> <code> [--note "..."]   (opens a blocker reason; code: merge-conflict, merge-guard, merge-stopped,
//                                                                  gate-red, context, quota, owner-question, dependency,
//                                                                  no-agent, silent, other. One open per task; merge opens
//                                                                  merge-conflict/merge-guard/merge-stopped/gate-red when it stops there and closes
//                                                                  the open one after a successful merge)
//   node scripts/orchestrator/queue.mjs unblock <id>                  (closes the open blocker)
//   node scripts/orchestrator/queue.mjs checks [--json]             (what the project has for checking its code, read from its files,
//                                                                  and prioritized suggestions; cli/checks.mjs)
//   node scripts/orchestrator/queue.mjs checks show|plan|dismiss|restore <key>   (a suggestion's template; adds its investigation and
//                                                                  planning to the queue, a proposal without --approved; sets it aside)
//   node scripts/orchestrator/queue.mjs checks on|off               (the opt-out: the Checks tab, the overview, the setup suggestions)
//   node scripts/orchestrator/queue.mjs kickstart [--json]          (which controls the project has and one next step, in plain words;
//                                                                  read-only, works before init and without git)
//   node scripts/orchestrator/queue.mjs kickstart gates [--apply]   (the project's own checks as gates; --apply writes them to
//                                                                  queue.config.json, never over gates already set)
//   node scripts/orchestrator/queue.mjs kickstart add [gates|secrets|ci]   (proposes the next step, or the named one, as a task;
//                                                                  it starts only after approve; cli/kickstart.mjs)
//   node scripts/orchestrator/queue.mjs gate "<failure class>" [--from <task>] [--where <file:line>] [--detail "..."]
//                                                                  (a known bug that can happen again becomes a gate task: proposed,
//                                                                  or by gates.fromKnownBugs auto or off; cli/gate.mjs)
//   node scripts/orchestrator/queue.mjs gate list                   (the gate tasks and their status)
//   node scripts/orchestrator/queue.mjs unlock [--force --by owner]   (the queue lock: prints the holder; with both flags
//                                                                  releases it. Refused from a track worktree; the guard
//                                                                  denies it to queue agents. lib/queueLock.js)
//   node scripts/orchestrator/queue.mjs surface [accept --by owner]   (the git hooks and config that run code against the
//                                                                  accepted baseline: prints each difference; with accept
//                                                                  takes the current state. Refused from a track worktree;
//                                                                  the guard denies it to queue agents. lib/gitSurfaceBaseline.js)
//   node scripts/orchestrator/queue.mjs blockers [--days 7] [--json]   (per code: count and blocked time in the period,
//                                                                  top first)
//
// Project, feature, picking and visual QA:
//   node scripts/orchestrator/queue.mjs projects                    (per project: done/total, min left, active/picked,
//                                                                  QA, pause, the owner questions that block the most)
//   node scripts/orchestrator/queue.mjs project <pid> [--title ..] [--plan ..] [--prefix A- B- …] [--pause | --continue]
//        [--priority N] [--area <oid|none>] [--file-root <path …>] [--phase plan|none]
//        (creates or changes; --prefix replaces the list. --phase plan = exists in the planning work, no queue tasks
//         yet; removed automatically when add gives the project tasks)
//   node scripts/orchestrator/queue.mjs show [--all] [--project <pid>] [--grouped]   (--grouped: project → feature → tasks)
//   node scripts/orchestrator/queue.mjs pickable [--label visual] [--project <pid>] [--max-min N]
//   node scripts/orchestrator/queue.mjs pick <id> --by "<who>" [--force]   (a person/session does the task: own branch and, if any,
//                                                                  migration block; does not count against maxConcurrent/maxDPlus)
//   node scripts/orchestrator/queue.mjs deliver <id>                    (picked -> review; the orchestrator merges)
//   node scripts/orchestrator/queue.mjs release <id>                    (picked -> waiting; warns when the branch has commits)
//   node scripts/orchestrator/queue.mjs qa                            (QA list: finished with the label visual that are waiting)
//   node scripts/orchestrator/queue.mjs qa ok <id> [...] [--by "<who>"]   (owner only; --by is kept as qa_ok_by)
//   node scripts/orchestrator/queue.mjs qa deviation <id> "<text>"       (owner only; creates fixTask <id>-QA<n>)
//   node scripts/orchestrator/queue.mjs qa evidence <id> <type>[=<ref>]  (the types are config().qa.evidenceTypes, default
//                                                                  screenshot|test|manual; receive otherwise reads the
//                                                                  EVIDENCE line in track-result.md)
//   node scripts/orchestrator/queue.mjs qa auto [--run] [<id...>]        (entries with auto evidence, default test: run
//                                                                  config().qa.autoCommand and close the green ones)
//   node scripts/orchestrator/queue.mjs edit-many --file <json> [--dry] [--expect-changed <iso>] [--json] [--by "..."]
//        ([{ id, project?, feature?, labels?, requires?, priority_bonus?, parked?, batched?, plan? }] or
//         { projects: {...}, tasks: [...] }; all or nothing. See bulk edit below.)
// Project for a task: an explicit `project`, otherwise the project with the LONGEST prefix that matches the id (equal
// length: the first in the register), otherwise "without-project". `next`/`start` skip paused projects (start
// --force overrides) and add the project's priority_bonus to the task's priority.
//
// Work outside the queue (the git reading is in lib/queueGit.js, the decisions in lib/queueLogic.js):
//   node scripts/orchestrator/queue.mjs external [--since <24h|3d|2026-09-30|sha>] [--all] [--max N] [--untracked] [--json]
//        (read-only: (a) commits on baseBranch that are not merges of queue branches and lack the trailer
//         "Queue: orchestrator", with files and the task ids they mention; (b) branches/worktrees outside the queue branches with commits
//         that are not in baseBranch; (c) uncommitted changes in the main tree; collisions with the owned files. The default window is what
//         has not been pushed.)
//   node scripts/orchestrator/queue.mjs external --id <id>             (only one task, since it was added)
//   node scripts/orchestrator/queue.mjs external accept <id> <sha>     (a pending task completed outside the queue -> done; never automatic)
//   node scripts/orchestrator/queue.mjs external add --name "<session or person>" --files <path ...> [--db <fn ...>] [--branch <g>]
//        (a row with status external that owns the files like a picked task; the same name again adds files)
//   node scripts/orchestrator/queue.mjs external done "<name>"      (the files are free again)
//   `next` and `start` skip tasks that own an uncommitted file in the main tree (start --force overrides);
//   `start`, `pick` and `trackFile` warn when the owned files have changed outside the queue since the task was added (the track file
//   gets the warning, so the track reads the diff). Push: scripts/orchestrator/push-check.mjs.
// Orchestrator marker (<dataFolder>/orchestrator.json, expires after 2 h without an update):
//   node scripts/orchestrator/queue.mjs orchestrator                    (is an orchestrator active?)
//   node scripts/orchestrator/queue.mjs orchestrator pulse [--session "<name>"]   (orchestrator, every loop round; start and set
//                                                                  do it themselves for the queue's own tasks; a NEW
//                                                                  --session name = new session (emergency rotation), resets
//                                                                  the wind-down; the usual path is compaction; also
//                                                                  prints NEW DELIVERY for track-result.md files that came since
//                                                                  the last pulse, see `deliveries`)
//   node scripts/orchestrator/queue.mjs orchestrator stop            (the loop is stopped or handed over; also removes
//                                                                  the wind-down flag)
//
// Cloud: K/U tasks without migrations and DB can run in a cloud session on claude.ai (the owner pastes the package from the board, or
// a routine does it). The cloud only sees what is pushed; suitability is decided in queueLogic.cloudSuitable.
// Off by default: with features.cloud false in queue.config.json the cloud commands answer "Cloud is off" (exit 0).
//   node scripts/orchestrator/queue.mjs cloud                            (the cloud sessions running, and the pending ones that are suitable)
//   node scripts/orchestrator/queue.mjs cloud-package <id> [<id> ...] [--out <file>] [--force]   (self-contained message; stdout without
//                                                                  --out; refuses with the reasons when a task is not suitable.
//                                                                  More ids = a bundle in one cloud session: at most 4, total estimate
//                                                                  <= 120 min, own branch/commit/push/report line per id)
//   node scripts/orchestrator/queue.mjs cloud-bundles [--max 4] [--max-min 120]   (proposed: cloud-suitable ones grouped by
//                                                                  project/feature, by priority)
//   node scripts/orchestrator/queue.mjs cloud start <id> [<id> ...] [--run <session-id|url>] [--force]   (picked by "cloud";
//                                                                  at most 3 cloud sessions, a bundle counts as one; again with
//                                                                  --run only sets the run)
//   node scripts/orchestrator/queue.mjs cloud done <id> [--branch <branch>] [--sha <sha>]   (git fetch of the branch (default
//                                                                  the queue branch), at least one commit above <remote>/<baseBranch>,
//                                                                  the local queue branch is set to it, then review; the orchestrator
//                                                                  merges)
//   node scripts/orchestrator/queue.mjs cloud cancel <id>                (= release)
//   The time log gets cloud-start, cloud-done and cloud-aborted.
//
// Batch queue: small tasks that do not fit naturally into a track of the right size (K 90-120 min content, D about 40,
// U about 60), and that do not block anything, are added with "batched": true. They are shown, but never started or picked alone
// (not even with --force) and are counted separately in show/state. `add`/`edit` reject batched for D+, for tasks other
// open tasks depend on (depends_on), and for tasks with an open owner question; and a task depending on one in the batch queue.
// `edit <id> --json '{"batched":false}'` takes it out again. The logic: queueLogic.batch*.
// The small-task guard: `add` rejects a task with an explicit content_min below the class's lower target when it is not D+,
// does not block and is not waiting on the owner: <= 10 min must be fixed now or batched (owner option), over 10 min with
// value <= 7 must be batched, and without value the owner is asked. `"own_track": "<reason>"` overrides. The logic:
// queueLogic.smallTaskError.
//   node scripts/orchestrator/queue.mjs batch                          (the groups project -> class, the features in them and
//                                                                  shared files, sum of contentMinutes against the target; "READY
//                                                                  FOR PACKING" from the lower target: K 90, D 30, U 45)
//   node scripts/orchestrator/queue.mjs batch pack <id> <id> ... --id <new-id> [--title "..."] [--expect-changed <iso>]
//        (one new track: same class, never D+, same open owner question; content_min summed, value/migr_tens max,
//         depends_on union minus the parts, ownership/requires/labels union, project/feature shared or the first,
//         merged_from; mission file <dataFolder>/mission/<new-id>.md with the parts' missions in full; the parts
//         cancelled with the remark "merged into <new-id>"; depends_on in other tasks repointed. All or nothing.)
//   node scripts/orchestrator/queue.mjs batch pack --auto [--execute]   (proposals for the ready groups, with id <prefix>S<n>;
//                                                                  --execute packs all of them in one write)
//
// Areas, focus period and parking (the logic is in lib/queueLogic.js). All fields are optional; without focus and without parked
// the queue is ranked by priority alone.
//   node scripts/orchestrator/queue.mjs area <oid> --title "..." [--description "..."] [--projects <pid> ...] [--remove <pid> ...]
//        [--expect-changed <iso>] [--json]
//        (creates/changes an area and sets the projects' `area`; a project belongs to one area. --delete refuses
//         when a project or the focus uses the area.) Also: queue.mjs project <pid> --area <oid|none>.
//   node scripts/orchestrator/queue.mjs areas                        (area -> projects, waiting, ready ones, min left, parked)
//   node scripts/orchestrator/queue.mjs focus                          (current focus, the stages, dragged along, Next up, notice)
//   node scripts/orchestrator/queue.mjs focus set <stage> [<stage> ...] [--rest wait|fill] [--to <date>] [--name "..."]
//        [--without-dependencies] [--continue-when-empty on|off] [--by "..."]
//        (stage = area:<oid>, project:<pid>, feature:<pid>/<name> or a bare area/project name. Everything in stage 1
//         before everything in stage 2, regardless of score; within a stage, score applies. The most specific stage wins.
//         --rest wait (default): tasks outside the focus do not start; fill: they fill slots the focus does not use.
//         Dependencies of focus tasks are dragged along (transitively) unless --without-dependencies. --to YYYY-MM-DD = up to
//         and including that day (UTC). Pause on a project takes precedence.
//         When the focus has ENDED (every stage done, or the period over), the setting continueWhenEmpty decides:
//         off (the default, config focus.continueWhenEmpty) = the queue is paused (fill starts nothing), focus.finished_at
//         is stamped and ONE owner question focus-done-<from> is registered (Waiting on you: "Set a new focus" or
//         "Continue the regular queue"; the second lifts the pause). on = the queue continues as without focus, with
//         one line. --continue-when-empty on|off overrides the config for this focus. No focus set = not affected.)
//   node scripts/orchestrator/queue.mjs focus evaluate [--json] [--all]
//        (each stage with open, ready, minutes left, rests (batch queue, proposals, waiting only on owner questions,
//         QA with the owner) with a suggestion per rest, and status active | done-with-rests | done.)
//   node scripts/orchestrator/queue.mjs focus clean [--dry] [--by "..."]
//        (takes out the stages with status done; done-with-rests stays until the rests are settled. The removal is
//         recorded in focus.history and the changelog (queue.mjs undo). The last stage is never taken out by itself.
//         receive, set <id> done|cancelled and fill do the same automatically, with one line per stage in the output.)
//   node scripts/orchestrator/queue.mjs focus off
//   node scripts/orchestrator/queue.mjs focus save --file <plan.json> [--dry] [--expect-changed <iso>] [--json] [--by "..."]
//        (the plan view on the board: { order, now_count?, rest?, to?, name?, drag_with_dependencies?,
//         pause?: [pid], continue?: [pid] } in ONE change, all or nothing. Empty order = focus off. now_count =
//         how many stages the board shows in "Now".)
//   node scripts/orchestrator/queue.mjs park <id> ... [--reason "..."] [--to <date>] [--by "..."]   (put on hold: status stays
//                                                                  waiting; next, start and pickable skip it; pick
//                                                                  and start require --force. Only waiting and proposed.)
//   node scripts/orchestrator/queue.mjs continue <id> ...                (takes it off hold)
//   Warning when the focus has nothing ready or the period is over: in `next`, `show`, `focus` and `state` (the field focus).
//
// Bulk edit, undo, block moves and project proposals. Everything happens under the lock and is all or nothing.
//   edit-many: the fields `parked` (true | { reason?, to? } | null = take off hold; only waiting and proposed, like park) and
//        `batched` (true | false/null; same rules as add/edit), and the register fields area, fileRoot and features.
//        --dry: preview (what changed, warnings, the queue's version `changed`), writes nothing.
//        --expect-changed <iso>: refuses with exit 6 when the queue has changed after that time (the board previewed an
//        older queue). --json: the answer as JSON (for the board).
//   node scripts/orchestrator/queue.mjs rank <id> ... --top|--bottom|--over <id>|--under <id> [--dry] [--expect-changed <iso>]
//        [--json]   (moves tasks as a block within the focus stage and keeps their mutual order; new
//                    priority_bonus. --json: the answer as JSON for the board)
//   node scripts/orchestrator/queue.mjs undo [--show] [--nr <n>] [--expect-changed <iso>] [--json]
//        (rolls back the last changelog entry that is not undone; refuses when a field has changed since. --nr: only
//         when the last undoable entry is no. n, so the board's "Undo" never rolls back someone else's change.
//         The changelog (`changelog`, the last 50) is kept by edit, edit-many, rank, park, continue, project
//         and classify.)
//   node scripts/orchestrator/queue.mjs classify [--file <in.json>] [--without-project] [--disagree] [--execute] [--json]
//        (project proposals: longest prefix, the plan in source/mission, fileRoot (`project <pid> --file-root <path ...>`).
//         Without --file: tasks in the queue, "move" (confident proposals for tasks without a project; --execute sets them) and
//         "Sort" (uncertain ones, or disagreeing with the project they have; never changed automatically). --file: proposals for an add file.)
//   `add` warns when the project is missing (with the proposal and the signal) or conflicts with strong signals, and about a feature
//   that is not in the project's `features`. `project` warns about one-char prefixes and overlapping prefixes.
//
// The plan register (the logic is in lib/queuePlan.js; see docs/plan-register.md). The register is <dataFolder>/plans.json, its own file
// alongside queue.json (plan work never bumps the queue's version), with the same lock, atomic writes, --expect-changed (against
// plans.json), changelog and undo. The file is created by the first writing plan command. Module = area (`queue.mjs area`),
// project = `queue.mjs project`; a plan entry points to documents, it does not copy them.
//   node scripts/orchestrator/queue.mjs plan show [--module m] [--project p] [--priority now owner …] [--maturity …]
//        [--search "..."] [--all] [--json]          (dropped ones are hidden without --all or --priority drop)
//   node scripts/orchestrator/queue.mjs plan get <id|project|module> [--json]   (entries, sources, queue status, owner questions
//                                                                             and copy line)
//   node scripts/orchestrator/queue.mjs plan new --file <json> (one entry or a list)
//   node scripts/orchestrator/queue.mjs plan edit <id> [--field name=val ...] [--set '{"field":...}']   (null or name=
//        removes the field)
//   node scripts/orchestrator/queue.mjs plan prioritize <id…> <now|owner|later|drop> [--category security for-prod important]
//        [--reason "Rule 3: ..."]   (all or nothing; drop requires --reason)
//   node scripts/orchestrator/queue.mjs plan prioritize-many --file <json>   ([{ id, priority, category?, reason? }], all
//        the moves in one write: one lock and one changelog entry, all or nothing)
//   node scripts/orchestrator/queue.mjs plan combine <to-id> <from-id...>     (the others are moved to the archive)
//   node scripts/orchestrator/queue.mjs plan verify <id> --findings "..." [--commit <sha>]
//   node scripts/orchestrator/queue.mjs plan undo [--show] [--nr <n>]
//   node scripts/orchestrator/queue.mjs plan rules [--json]                     (the priority rules)
//   node scripts/orchestrator/queue.mjs plan active [<id> [--end]] [--by "..."] [--json]   ("Working now" cursor
//        active_session { entry, at, by } in plans.json; without an id the active ones are listed. No changelog, changed is not bumped,
//        and the cursor dies after 2 hours without a new pulse)
//   Writing plan commands take --dry (preview), --expect-changed <iso>, --json (answer as JSON), --by "..." and
//   --set-by agent|owner (default agent). An agent never changes a priority the owner has set, except rule 1
//   (security lifts to now; the field agent_boost shows it), and must always give priority_reason.
//   node scripts/orchestrator/queue.mjs finding "<title>" [--detail "..."] [--task <id>] [--files a,b] [--project <pid>] [--dry] [--json]
//        (a track reports something it noticed outside its scope instead of fixing it: an idea in the plan register,
//         PL-FINDING-<n>, priority later, linked to the task (default: the task of the worktree's queue branch) and
//         deduplicated on the normalized title (the same title again adds the task and files and counts it). New until
//         triaged; `orchestrator pulse`, `show` and `state` (the field findings) show how many. lib/queueFindings.js)
//   node scripts/orchestrator/queue.mjs finding list [--all] [--json]   (the findings nobody has triaged yet; --all: every one)
//   node scripts/orchestrator/queue.mjs add --file <task.json> --plan <PL-id>   (links tasks without their own `plan` to
//        the plan entry; an unknown or merged entry is refused, the project is taken from the entry when missing, and the entry
//        becomes in-queue automatically. The field `plan` can also be in the file, and is set on existing tasks with edit-many.)
//   node scripts/orchestrator/queue.mjs plan check [--json] [--max N]   (unregistered documents, dead paths, stale,
//        statusDeviation, ruleDeviation, gaps, possible duplicates and capacity, and INDEX drift against the register
//        (make-index.mjs --check, the field `index` in --json); read-only)
//   node scripts/orchestrator/queue.mjs plan modules [--link] [--dry] [--json]   (creates modules from
//        config().modules that are missing in areas; --link gives projects without a module the proposal in
//        config().projectModuleSuggestion)
//   node scripts/orchestrator/queue.mjs plan backup [--push] [--dry]   (runs the script in config().planBackup, with
//        QUEUE_ROOT = the project root; QUEUE_PLAN_BACKUP overrides the path. Not set up = explanation and exit 1)
// Documents and agreements: the register `documents` in plans.json (metadata only; the text stays where it is), with
// the same lock, --expect-changed, changelog and `plan undo` as the plan entries.
//   node scripts/orchestrator/queue.mjs plan doc show [--group g ...] [--status s ...] [--audience m ...] [--priority p ...]
//        [--problems] [--search "..."] [--all] [--json]   ("What must be done" at the top, then a table per group)
//   node scripts/orchestrator/queue.mjs plan doc get <DOC-id> [--json]   (versionSkew, next revision, links,
//        copy line)
//   node scripts/orchestrator/queue.mjs plan doc new --file <json>            (one document or a list)
//   node scripts/orchestrator/queue.mjs plan doc edit <DOC-id> [--field name=val ...] [--set '{...}']
//   node scripts/orchestrator/queue.mjs plan doc revise <DOC-id> [--version v] [--date YYYY-MM-DD] [--remark "..."]
//        (last_revised, new version and a line in revisions; gives a new next revision)
//   node scripts/orchestrator/queue.mjs plan doc check [--write] [--dry] [--json]   (the consistency checks in queuePlan.js, e.g.
//        the vendor list against config().documents and overdue revisions; --write enters the findings as problems with
//        source check:<type>; also shown in `plan check`)
//   node scripts/orchestrator/queue.mjs plan doc web [--write] [--dry] [--json]    (manual only: GET on the published
//        web addresses, whether they answer and the version stated there)
//
// Budget guard: with limits.dailyBudget set (USD API equivalent per local day, the owner sets the number) `next`
// proposes nothing and `start` refuses when today's usage has reached the limit. The usage is read from the time log
// (config().timeLog), deduplicated per agent (lib/timeCost.js, the same numbers as `log-time.mjs --cost`). Default: off.
// With a budget, `next`, `show` and `state` (costEstimate.budget) add a budget outlook: the calibrated estimate of what can
// start now (lib/costEstimate.js) against what is left today. Information only; the guard stops on measured usage.
//
// Night pause: with limits.nightRun = false (`queue.mjs limit nightRun off`) `next` proposes nothing (exit 5,
// "Night pause until 06:00 ...") and `start` refuses (exit 5) within the night window (limits.nightWindow, default 23-06, Norwegian
// time). Running tasks finish, and `set`/`deliver`/merge continue; only new starts stop. As with
// the budget guard (exit 4) this is not an empty queue. `start --force` overrides. Default: on (no night pause).
//
// Wind-down guard: when the active orchestrator session passes about 350k context, hook-context.mjs sets `windDown` in
// the orchestrator cursor. Then `next`, `start` and `fill` refuse (exit 6): the session finishes receiving, review, fix rounds and
// merges (`set`, `resolve`, `receive` work as before), updates the running handoverNote and is compacted.
// hook-after-compact.mjs lifts the wind-down after the compaction. Emergency rotation (the session has hung):
// `orchestrator pulse --session "<new name>"` (the new session takes the cursor) or `orchestrator stop` also resets.
// `start --force` (the owner's word) overrides.
//
// Load guard: with a free memory limit set (`queue.mjs limit minFreeMemoryPct 15`, or loadGuard.minFreeMemoryPct in
// queue.config.json; the queue's value wins), `next`, `start` and `fill` refuse new starts (exit 7, "THE MACHINE IS
// FULL: ...") while free memory (os.freemem / os.totalmem) is below the limit. `show` and `state` show the reason.
// Running tracks finish. `start --force` and `fill --over-load` override. Default: 10 (off on macOS).
// Above that hard stop, the slots are load-aware (lib/loadSlots.js): `next`, `start`, `fill`, `show` and `state` open
// fewer than maxConcurrent slots while free memory is below loadGuard.allSlotsFreeMemoryPct (default 40), at least
// loadGuard.minSlots (1), and print why ("LOAD: 2 of 5 slots: free memory 18 % ..."). loadGuard.adaptive false or
// QUEUE_LOAD_ADAPTIVE=off turns it off; `fill --over-load` and `start --force` skip it.
// QUEUE_LOAD="free=<pct>,cpu=<pct>" replaces the measurement (tests).
//
//   node scripts/orchestrator/queue.mjs handover archive [--dry]   (moves dated log entries older than 24 h from
//                                                                  <dataFolder>/handover-ongoing.md to
//                                                                  handover-archive/<year-month>.md and warns when "Now"
//                                                                  has over 40 lines; --dry writes nothing. Run at every
//                                                                  compaction and at takeover; lib/queueHandover.js)
//   node scripts/orchestrator/queue.mjs handover now               (prints only the "Now" part of the note; the archive is
//                                                                  read with grep when needed)
//
// "Follow up" entries (observations with a start, an end, goals, a log and a fixed report template; <dataFolder>/follow.json,
// the same lock as the queue; the rules in lib/queueFollow.js). `show` and `orchestrator pulse` show the active ones and
// TO REPORT (the day is the local calendar day). Off by default: with features.follow false in queue.config.json the
// follow commands answer "Follow is off" (exit 0) and show and pulse print no follow-up lines:
//   node scripts/orchestrator/queue.mjs follow                          (the list: status, period, number of log entries)
//   node scripts/orchestrator/queue.mjs follow add --file <json>        ({ id: "F-...", title, why, start, end, owner,
//                                                                  goals: [{ name, how, expected }], related?,
//                                                                  close_action? }; end after start, unique id)
//   node scripts/orchestrator/queue.mjs follow log <id> [--text "..."] [--value name=x ...] [--source "..."]
//   node scripts/orchestrator/queue.mjs follow show <id>
//   node scripts/orchestrator/queue.mjs follow report <id>              (writes <dataFolder>/follow/<id>-report.md from the
//                                                                  template, status reported; the assessment is the
//                                                                  orchestrator's)
//   node scripts/orchestrator/queue.mjs follow close <id> --decision "..." [--cancelled]   (the owner decision; writes the
//                                                                  report again with the decision and shows the close action)
//   node scripts/orchestrator/queue.mjs follow extend <id> --to <YYYY-MM-DD>
//
// Exit codes: 0 ok, 1 error, 3 empty queue (state), 4 the daily budget is used up (next, start), 5 night pause (next,
// start), 6 the orchestrator is in windDown (next, start, fill) or the queue has changed since the preview
// (--expect-changed), 7 the machine is full (the load guard; next, start, fill), 10 TIMEOUT (wait).
//
// Task fields (see queueLogic.validate): id, title, domain, class (K|D|D+|U), mission (path to a track description
// or the text itself), value (1-10, default 5), content_min (min for a K track, default 30), migr_tens (number of
// blocks of migration numbers, 0 for client/investigation; only used with the migration flow), depends_on [id], waiting_on
// [owner question id], owned_files [path or folder/], owner_db [feature], shared_patch [shared feature], source (plan and
// sub-plan), added_by, project (pid), plan (plan entry id in plans.json), feature (short name), labels (e.g.
// ["visual"]), requires (resources, see queueLogic.REQUIRES), batched (true = batch queue), fixes (id or [id]: the
// task(s) this fix task fixes; the ids must exist, stored as a list, lib/fixLinks.js). Set by the tool: picked_by,
// picked_at, qa_status (waiting|ok|deviation), qa_note, qa_original (on a fix task), evidence ({ type, ref }, from the
// EVIDENCE line or qa evidence; see config().qa), qa_ok_by ("auto" when qa auto --run closed it).
// =============================================================

// The layout: this file is the usage above and the dispatch on the command word below. The code of the commands is in
// cli/, one module per area (tasks, taskEdit, view, owner, decide, run, merge, cost, doctor, finding, helpers, orchestrator, projects, batch,
// cloud, wait, plans with planShared, planCheck and planDoc), with the shared state in cli/context.mjs and the shared track
// helpers in cli/tracks.mjs. The usage comment stays here: lib/cliHelp.js reads it for `ravenseat help`.
import fs from 'node:fs';
import { a, command, CONFIG, CLI, die, HERE, KK, require } from './cli/context.mjs';
import * as ask from './cli/ask.mjs';
import * as attempt from './cli/attempt.mjs';
import * as batch from './cli/batch.mjs';
import * as cloud from './cli/cloud.mjs';
import * as conflicts from './cli/conflicts.mjs';
import * as cost from './cli/cost.mjs';
import * as decide from './cli/decide.mjs';
import * as board from './cli/board.mjs';
import * as doctor from './cli/doctor.mjs';
import * as finding from './cli/finding.mjs';
import * as helpers from './cli/helpers.mjs';
import * as checks from './cli/checks.mjs';
import * as kickstart from './cli/kickstart.mjs';
import * as machine from './cli/machine.mjs';
import * as gate from './cli/gate.mjs';
import * as merge from './cli/merge.mjs';
import * as orchestrator from './cli/orchestrator.mjs';
import * as owner from './cli/owner.mjs';
import * as plans from './cli/plans.mjs';
import * as projects from './cli/projects.mjs';
import * as run from './cli/run.mjs';
import * as taskEdit from './cli/taskEdit.mjs';
import * as tasks from './cli/tasks.mjs';
import * as triage from './cli/triage.mjs';
import * as unlock from './cli/unlock.mjs';
import * as surface from './cli/surface.mjs';
import * as view from './cli/view.mjs';
import * as wait from './cli/wait.mjs';

// ---- Switched-off modules (features in queue.config.json, lib/queueConfig.js) ------------------------------------
// The commands of a module that is off answer that with exit 0 (not an error: the project chose it). The plan register
// is never switched off here: skills use it, only the board hides Plans.
const MODULE_COMMANDS = { cloud: 'cloud', 'cloud-package': 'cloud', 'cloud-bundles': 'cloud', follow: 'follow' };
if (MODULE_COMMANDS[command] && !KK.featureOn(MODULE_COMMANDS[command], CONFIG)) {
  console.log(KK.featureOffText(MODULE_COMMANDS[command]));
  process.exit(0);
}

// ---- Commands ----------------------------------------------------------------------------------------------
if (command === 'init') {
  tasks.cmdInit();
} else if (command === 'mode') {
  tasks.cmdMode();
} else if (command === 'add') {
  tasks.cmdAdd();
} else if (command === 'show' && a[1] && !a[1].startsWith('-')) {
  view.cmdInfo(); // ravenseat show <id>: the same as ravenseat info <id>, rather than a summary that ignores the id
} else if (
  command === 'show' &&
  !['--full', '--all', '--grouped', '--project'].some((f) => a.includes(f))
) {
  view.cmdShowSummary();
} else if (command === 'show') {
  view.cmdShow();
} else if (command === 'next') {
  run.cmdNext();
} else if (command === 'start') {
  run.cmdStart();
} else if (command === 'set') {
  taskEdit.cmdSet();
} else if (command === 'cancel') {
  taskEdit.cmdCancel();
} else if (command === 'edit') {
  taskEdit.cmdEdit();
} else if (command === 'resolve') {
  owner.cmdResolve();
} else if (command === 'resolutions') {
  owner.cmdResolutions();
} else if (command === 'question') {
  owner.cmdQuestion();
} else if (command === 'wait') {
  wait.cmdWait();
} else if (command === 'decide') {
  decide.cmdDecide();
} else if (command === 'approve') {
  owner.cmdApprove();
} else if (command === 'forecast') {
  cost.cmdForecast();
} else if (command === 'proposals') {
  owner.cmdProposals();
} else if (command === 'limit') {
  cost.cmdLimit();
} else if (command === 'helpers') {
  helpers.cmdHelpers();
} else if (command === 'guidance') {
  helpers.cmdGuidance();
} else if (command === 'checks') {
  checks.cmdChecks();
} else if (command === 'kickstart') {
  kickstart.cmdKickstart();
} else if (command === 'gate') {
  gate.cmdGate();
} else if (command === 'board-setting') {
  board.cmdBoard();
} else if (command === 'triage') {
  triage.cmdTriage();
} else if (command === 'compact') {
  orchestrator.cmdCompact();
} else if (command === 'state') {
  view.cmdState();
} else if (command === 'diagnose') {
  view.cmdDiagnose();
} else if (command === 'doctor') {
  doctor.cmdDoctor();
} else if (command === 'machine') {
  machine.cmdMachine();
} else if (command === 'conflicts') {
  conflicts.cmdConflicts();
} else if (command === 'finding') {
  finding.cmdFinding();
} else if (command === 'trackFile') {
  run.cmdTrackFile();
} else if (command === 'fill') {
  run.cmdFill();
} else if (command === 'receive') {
  merge.cmdReceive();
} else if (command === 'merge') {
  await merge.cmdMerge();
} else if (command === 'block') {
  merge.cmdBlock();
} else if (command === 'unlock') {
  unlock.cmdUnlock();
} else if (command === 'surface') {
  surface.cmdSurface();
} else if (command === 'unblock') {
  merge.cmdUnblock();
} else if (command === 'blockers') {
  merge.cmdBlockers();
} else if (command === 'info') {
  view.cmdInfo();
} else if (command === 'ask') {
  ask.cmdAsk();
} else if (command === 'activeOnes') {
  view.cmdActiveOnes();
} else if (command === 'next-migr') {
  merge.cmdNextMigr();
} else if (command === 'migr') {
  merge.cmdMigr();
} else if (command === 'capacity') {
  cost.cmdCapacity();
} else if (command === 'cost') {
  cost.cmdCost();
} else if (command === 'calibrate') {
  cost.cmdCalibrate();
} else if (command === 'projects') {
  projects.cmdProjects();
} else if (command === 'project') {
  projects.cmdProject();
} else if (command === 'edit-many') {
  taskEdit.cmdEditMany();
} else if (command === 'pickable') {
  run.cmdPickable();
} else if (command === 'pick') {
  run.cmdPick();
} else if (command === 'deliver') {
  merge.cmdDeliver();
} else if (command === 'release') {
  merge.cmdRelease();
} else if (command === 'qa') {
  owner.cmdQa();
} else if (command === 'external') {
  cloud.cmdExternal();
} else if (command === 'orchestrator') {
  orchestrator.cmdOrchestrator();
} else if (command === 'deliveries') {
  merge.cmdDeliveries();
} else if (command === 'resume') {
  run.cmdResume();
} else if (command === 'attempt') {
  attempt.cmdAttempt();
} else if (command === 'cloud-package') {
  cloud.cmdCloudPackage();
} else if (command === 'cloud-bundles') {
  cloud.cmdCloudBundles();
} else if (command === 'cloud') {
  cloud.cmdCloud();
} else if (command === 'batch') {
  batch.cmdBatch();
} else if (command === 'area') {
  projects.cmdArea();
} else if (command === 'areas') {
  projects.cmdAreas();
} else if (command === 'focus') {
  projects.cmdFocus();
} else if (command === 'park') {
  projects.cmdPark();
} else if (command === 'continue') {
  projects.cmdContinue();
} else if (command === 'rank') {
  projects.cmdRank();
} else if (command === 'undo') {
  taskEdit.cmdUndo();
} else if (command === 'plan') {
  // ---- The plan register (see the top of the file and lib/queuePlan.js) ----
  plans.planCommand();
} else if (command === 'classify') {
  tasks.cmdClassify();
} else if (command === 'handover') {
  // ---- The ongoing handover note in two parts (rules: lib/queueHandover.js) ----
  orchestrator.handoverCommand();
} else if (command === 'follow') {
  // ---- The "Follow up" entries (see the top of the file and lib/queueFollow.js) ----
  orchestrator.followCommand();
} else if (command && command !== 'help') {
  // A mistyped command: one line with the closest known command (lib/cliHelp.js), same exit code as before.
  const scripts = fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('hook-') && f !== 'ravenseat.mjs')
    .map((f) => f.slice(0, -'.mjs'.length));
  die(require('./lib/cliHelp.js').unknownCommandMessage(command, require('./lib/cliHelp.js').knownCommands(scripts), CLI), 1);
} else {
  die(
    'Use: ravenseat <init|add|approve|ask|show|next|start|set|edit|resolve|resolutions|question|limit|state|trackFile|' +
      'projects|project|edit-many|pickable|pick|deliver|release|qa|external|orchestrator|cloud|cloud-package|batch|' +
      'area|areas|focus|park|continue|rank|undo|classify|plan|fill|receive|merge|info|activeOnes|next-migr|migr|' +
      'capacity|compact|diagnose|doctor|machine|finding|cost|handover|deliveries|resume|attempt|follow|triage|wait|decide|unlock|surface> ...  (see the top of the file)',
    command ? 1 : 0,
  );
}
