---
name: parallel-wave
description: Default way of working for ALL parallel work in this project (several agents at once, tracks in worktrees, orchestration through the work queue). Use it every time work is to be split across several agents or tracks, also when the user just says "next wave", "run in parallel" or "split across agents".
---

# Parallel work through the queue (default for all parallel work)

You are the **orchestrator**: you plan the tracks, start the agents, review, merge, run the gates and report. The
agents only do their own track. The binding protocol for tracks is `docs/queue/mission-template.md` (copied into the
project by the installer). Project settings (base branch, gates, optional migration flow, modules) are in
`queue.config.json` in the project root.

## Lite mode (`ravenseat mode` says lite)

The owner chose the core loop only. Every task is class K (one `track` agent, no fixed reviewer), and the order is
the order added (`--priority` moves a task). The loop is: `ravenseat fill --scratchpad <scratch>` and start every agent it
lists in the same turn; on a delivery `ravenseat receive <id>`, then `ravenseat merge <id>`; owner questions as usual (present them
with a recommendation; `ravenseat resolve`). Skip the batch queue check, reprioritising, plan entries, focus, follow-up
entries, `external` and cost reports. The fixed rules below (push in batches, pathspec commits, no dev servers) and
the fix-round rules still apply. Keep only the "Now" part of the handover note. New work from tracks goes in with
`ravenseat add "<title>" --mission "<text>"`. When a round ends with only owner items left and no agent running, start
`ravenseat wait` in the background (step 7 of the loop below) so a board answer starts the next round.

## Fixed rules

- **Agent model:** `subagent_type: track` (class K and U, `effort: medium`) or `track-d` (class D and D+,
  `effort: high`), both `isolation: worktree`, `run_in_background: true`. The worktree starts from the orchestrator's
  HEAD (`worktree.baseRef: head` in `.claude/settings.json`, which `/ravenseat:setup` offers to add), so stand on the base
  branch when you start tracks. `ravenseat fill`/`start` print the exact `subagent_type` a task needs: installed as a plugin
  the agents are `ravenseat:track`, `ravenseat:track-d`, `ravenseat:reviewer` and `ravenseat:reviewer-security`; in a vendored install the bare names.
  A line with `model=<m>` (config `models`) means: pass `model: "<m>"` to the Agent call as well.
- **The orchestrator itself runs at medium effort.** `queue-takeover.mjs` shows the level (written by `hook-effort.mjs`).
  If it is not medium, ask the owner before the loop starts.
- **Push in batches only:** commit locally for every step; `git push` happens only when the owner says "push"
  (push mode `owner`, the default) or, in push mode `threshold`, when `ravenseat push-check` says READY or LARGE (never
  BLOCKED), and always after `ravenseat push-check`. Never push per commit (every push triggers CI and costs). The batch is
  counted in merged tasks, not commits (`push.minTasks`, default 10).
- **Shared working tree:** always commit with `git commit -- <files>` (pathspec), never `git add -A`. Never touch files
  another session has uncommitted. The orchestrator's own commits on the base branch (not the merges) get the trailer
  `--trailer "Queue: orchestrator"` so `push-check` can tell them from other sessions' commits.
- **No dev servers or previews from tracks.** Visual QA is the owner's; deliver a QA list.
- **Owner questions** are collected and presented with context, pros and cons, and a clear recommendation.

## The queue

Tool: `ravenseat …` (pure logic in `scripts/orchestrator/lib/`). The queue lives in
`scripts/.queue/queue.json` in the MAIN tree (gitignored) and survives compaction and new sessions. Read it with
`ravenseat show` (short by default). Main commands: `init`, `add --file|--json`, `show`, `next`, `start <id>`,
`set <id> <status>`, `edit <id>`, `resolve <question> [--answer "…"]`, `resolutions`, `question`, `wait`, `state`
(exit 3 = empty), `fill`, `receive`, `merge`, `cost`, `batch`, `projects`, `pick`, `deliver`, `release`, `qa`, `external`,
`orchestrator`, `plan …`. Full reference: `docs/queue/queue.md`.

**A task** has id, title, domain, class (K 1.0, D 1.3, D+ 1.8, U 0.6), `mission` (path to a self-contained track
description or the text itself), `value` 1-10, `content_min`, `depends_on` (other tasks), `waiting_on` (registered
owner questions), `owned_files` (paths, or folders ending in "/"), `owner_db`, `project`, `feature`, `labels`,
`plan` (plan entry). Priority = value per estimated minute, with a bonus for tasks that unlock others and a small age
bonus; `priority_bonus` overrides.

**Classes and sizes:** K (client/UI/ordinary code) 90-120 min of content; D (database/RPC/contract changes) about 40;
D+ (new tables, retention, unauthenticated endpoints, shared-function patches) 25-30, never merged with other work;
U (investigation) about 60. Fixed overhead per track is large (see `docs/queue/orchestration.md`), so small tasks go in
the batch queue (`"batched": true`) and are packed into right-sized tracks with `ravenseat batch pack`.

**Limits:** `ravenseat limit` shows and sets `maxConcurrent`, `maxDPlus`, `maxPerDomain`, `dailyBudget`,
`nightRun`, `nightWindow`, `parallelThreshold`. One owner per file and DB function. Change limits only on the owner's
word.

## The loop (event driven, never polling)

1. **Fill the slots**, ONE call: `ravenseat fill --scratchpad <scratch>` (next → start → track file → shared part →
   mission prompt; exit 4/5/6 = budget/night pause/wind-down). It ends with "Start these in the SAME turn:" and one line per
   agent with `subagent_type` and the finished agent message (also in `<scratch>/queue-fill.json`). Start ALL of them in
   the same turn with exactly that message. At loop start and each round without start/set:
   `ravenseat orchestrator pulse --session "<session>"`. Check `ravenseat batch` when filling: a group marked
   "READY FOR PACKING" is packed with `ravenseat batch pack --auto` (proposal) and `--auto --execute`.
   **Intake triage:** when `fill` prints `TRIAGE <n> task(s) first`, the block also has a `triage` agent per task
   (read-only, cheap); start it like the others. It answers `TRIAGE ready|done|stale|adjust`; record that with
   `ravenseat triage <id> --verdict <v> --note "<its note>"`. ready and adjust start on the next fill; done and stale become
   the owner question `triage-<id>` with choices, asked at the end of the round. Never close or cancel such a task
   yourself.
2. **When a track delivers:** `ravenseat receive <id>` BEFORE merging (status review, the review package as plain files in
   `<scratch>/rev-<id>/`, the track's RESULT line from the transcript, one reviewer prompt per reviewer for the
   class, and the merge command). Read the long report only when RESULT says PARTIAL, RED or ownerQuestions>0. Start the
   reviewers `receive` prints (fixed per class plus the helper agents that hit) in the SAME turn. Fix round in a new agent on findings,
   with `ravenseat resume <id> --from <reviewer,...>` naming the reviewer types whose findings caused it (the reviewer hit rate). When review is green:
   **`ravenseat merge <id>`** from Bash with a long timeout (merge with `--wave-base`, optional migration push if
   configured, `gates --quick`, `set <id> done` with cost and findings, `fill`). It stops at the first error with
   the step and an excerpt; full log in `<scratch>/merge-<id>.log`. PARTIAL = continuation in a new agent, not a merge.
3. **New work** from reviewers, planners or tracks goes in with `ravenseat add` (agents' tasks get status `proposed` and
   start only after `ravenseat approve <id…>`). Investigations and ideas that are not concrete tasks become plan entries
   (`ravenseat plan new`, priority `owner`, maturity `idea`). A post-merge defect, a red base or an owner-found bug also
   gets a gate proposal when its class is repeatable ("Gate from incident" below).
4. **Answers from the board:** `ravenseat resolutions --unlogged`; log them where the project keeps decisions, then
   `ravenseat resolutions --mark-logged <id…>`.
5. **Low parallelism:** when fewer agents run than `parallelThreshold` of `maxConcurrent`, `fill`/`receive`/`pulse` print a
   short diagnosis. "simple" findings come with a ready command; "complex" ones go to the owner with a recommendation.
6. **Reprioritise** after every 5 finished tasks and when the owner answers: split tasks that are too large, adjust
   value.
7. **Wait on the owner:** when a round ends, something waits on the owner (owner questions, proposed tasks, QA) and
   no agent is running, start `ravenseat wait` with `run_in_background: true` (a no-op when one already runs). It exits with
   `OWNER ACTED: ...` when the owner answers on the board: run a normal round, starting with
   `ravenseat resolutions --unlogged`. `answer <id>` in that line means the round is ready and needs its agent: `ravenseat resume <id> --reason context`,
   then start the agent line. `TRACKS NEED A LOOK: ...` (exit 11) means a track never started or has gone silent: `ravenseat show` says what to do
   for each; do it, then start `ravenseat wait` again (each finding wakes it once). On `TIMEOUT` (exit 10, after 8 h) start it once more, then stop. It only works while
   this session is open (also via Remote Control) and costs no tokens while it waits.
8. **Stop** when `ravenseat state` gives exit 3 or the day budget is used: present the owner questions that unlock the
   rest (sorted by how many tasks each unlocks). `ravenseat orchestrator stop` when the loop stops.

## Gate from incident

A failure that got past the gates once can get past them again, so a repeatable failure becomes a check.
- **When:** a post-merge defect (a reviewer, a later track or a user finds a bug in merged code), a red base (the
  `<id>-BASE<n>` or `BASE-<sha7>` fix task after `ravenseat merge` exits 9), or a bug the owner reports.
- **Only when repeatable:** propose a gate only when the failure class can happen again (another track could make
  the same mistake: a missing error check, a renamed symbol with callers left, an unescaped value). A one-off (a
  typo, a single wrong value) gets the fix and nothing more. An open gate task for the same class is extended with the
  new place, never duplicated.
- **The proposal:** `ravenseat gate "<failure class>" --from <id> --where <file:line>` makes it, or `ravenseat add` with `"labels": ["gate"]` and the title `Gate: <failure class>`, as a proposed task (the
  owner approves it; list it with the round's owner items). The mission names the failure class and the incident
  (merge commit, task id or the owner's report, with file:line), and carries the gate criteria from `/ravenseat:review`
  ("The gate criteria" in its SKILL.md) word for word: clear purpose, reproducible failing example, low maintenance
  cost, red first, in the project's own gates.
- **Red first:** `acceptance` includes `The new check fails on the original bug or a minimal reproduction, and passes
  on the fixed code (both runs shown in the report).`, and `done_when` is the command that runs the new check when the
  project has one. When the fix is a separate task it `depends_on` the gate task, so the check is shown red on the real
  bug first; when the fix has already merged, the red run is on the commit before the fix or on a reproduction kept as
  a fixture. On delivery, read the "Red first" section of `track-result.md`: a gate task without both runs gets a fix round.

## Review

- Fixed reviewers per class: K none, U none, D one, D+ two (`reviewers` in `queue.config.json`, default `reviewer`
  and `reviewer-security`). The class is the floor. Helper agents add to it when they are on and hit (`helpers`;
  `ravenseat helpers` lists them; by default the challenger for U and `bug`, design for `visual`). Start exactly the
  reviewers `receive` prints; the package says why each helper was chosen.
- The review package is made by `ravenseat receive` BEFORE merging (afterwards the diff is empty): `00-package.md`,
  `diff.patch`, `files/` (changed files in full), `trackReply.md`, `trackReport.md`, `handover.md`, `mission.md`.
- Fixed lines: a track's last answer starts with `RESULT status=… branch=… commits=… gates=… ownerQuestions=…`, a reviewer's
  with `FINDINGS H=… M=… L=… deferrable=…`. `receive` and `set done` read them.
- Fix rounds by severity: HIGH always gives a fix round. MEDIUM you fix yourself at merge when small and mechanical,
  otherwise a fix round. LOW never triggers a round alone; "safe to defer" becomes one follow-up task.

## Fix round and continuation (new agent, not SendMessage)

- `SendMessage` only to a track under about 150k context that has been idle under 5 min. Otherwise, and always on
  PARTIAL: a NEW `track` agent with a narrow mission: track block `=====<ID>-r<N>=====` with `BRANCH: queue/<ID>`, the
  findings with file:line, the paths to `track-result.md`/`handover.md` and the review files.
- The branch must be free (`git worktree list`; `git -C <old worktree> switch --detach`).
- The new agent starts with `ravenseat prepare-track <ID>-r<N> --branch queue/<ID> --continue …`: takes the branch over with
  `git switch`, no reset. Never `prepare-track` without `--continue` for a fix round.
- In the queue, `ravenseat resume <id> --reason fix|context [--findings-file <file>] [--from <reviewer,...>]` writes that mission
  (`prompt-<id>-r<N>.md`, N = the next free round) and prints the agent message. The fix round writes its track-result.md
  in `<scratch>/<id>-r<N>/`, where `ravenseat deliveries`, the pulse and `ravenseat receive` find it.

## Compact, do not rotate

The orchestrator session is compacted instead of rotated: the token cost is about the same, while rotation costs the
owner work, and running agents belong to the session that started them. At about 300k context `hook-context.mjs`
offers a ready `/compact keep: …` line. Finish the current step first. After compaction `hook-after-compact.mjs`
injects a resume instruction and the queue state; resume without waiting. Keep `scripts/.queue/handover-ongoing.md`
updated after every merge and decision: decisions go to a file at once, that is the quality guard for compaction. At
about 350k the hook sets wind-down (no new starts, exit 6) until the owner compacts.

**Emergency rotation** (the session has hung or is broken) needs no quiet window. The new session adopts the tracks
that run: track-result.md with the RESULT line on top is the delivery signal, `ravenseat orchestrator pulse` prints
`NEW DELIVERY (track-result.md)` for it without a `<task-notification>`, and `ravenseat resume` starts fix rounds with a new agent
on the same branch. Stop the old session first, so two orchestrators do not receive and merge the same track.

## Projects, picking and visual QA

- **Projects:** the register `projects` in `queue.json` (`title`, `plan`, `prefixes`, `pause`, `priority_bonus`,
  `area`). A task belongs to its explicit `project`, otherwise to the project with the longest matching id prefix.
  `ravenseat projects` reports per project. Pause and priority only on the owner's word.
- **Picked tasks** (skill `pick`): a person or session does the task. It owns its files, is never started, merged or
  released by the orchestrator, and arrives as `review` after `ravenseat deliver <id>`.
- **Visual QA:** tasks with the label `visual` get `qa_status: waiting` when finished. `ravenseat qa` lists them; only the
  owner decides (`qa ok`, `qa deviation <id> "<text>"`, which creates `<id>-QA<n>`). Each entry carries evidence
  (`EVIDENCE <type>[=<ref>]` in the track's `track-result.md`, stored by `receive`, or `ravenseat qa evidence <id> <type>[=<ref>]`);
  `ravenseat qa auto --run` closes the entries whose evidence type is automatic (default `test`) when `qa.autoCommand` is
  green.
- **The board:** `ravenseat board` (local, 127.0.0.1, link with a key) shows the queue as
  kanban, statistics, dependencies, plans and "Waiting on you". It writes only through `ravenseat`. See
  `docs/queue/board.md`.

## Work outside the queue and push check

- `ravenseat external` (read only): commits on the base branch that are not queue merges and lack the trailer, branches
  and worktrees outside `queue/*`, uncommitted files in the main tree, and collisions with owned files. Run it when
  reprioritising and before push. A match (an external commit mentions a waiting task) is a proposal:
  `ravenseat external accept <id> <sha>`, never automatic. Register outside work with
  `ravenseat external add --name "<session>" --files <…>`.
- `next`/`start` skip tasks that own an uncommitted file in the main tree.
- **Push check** before every push: `ravenseat push-check`. Exit 0: push (when the owner has said
  "push", or in push mode `threshold` when the verdict line says READY or LARGE; BLOCKED = never push, NOT YET =
  keep collecting). Exit 2 (mode threshold): external commits: ask the owner (take everything / push only the queue's part when a safe cut point
  is printed / wait). History is never rewritten.
  A push needs a green `ravenseat gates --full` run in the main checkout on the tip with no uncommitted changes (BLOCKED
  otherwise). With `push.ciWatch` on (push-check prints the line), start `ravenseat push-check --watch-ci <sha>` with
  `run_in_background` right after the push and go on with the loop: exit 9 = a check failed (the fix task
  `CI-<sha7>` is in the queue and the base is red), 0 = green or an owner question (`ci-<sha7>-infra`, nothing
  frozen), 10 = timeout (start it again later). Local gates stay the rule; the watch is a safety net.

## Cloud sessions (optional)

Tasks of class K/U without migrations, DB ownership, open dependencies or owner questions can run in a cloud session
(`ravenseat cloud`, `cloud setup`, `cloud-package`, `cloud start|done|cancel`, `cloud-start.mjs`). The cloud only sees what is pushed, so the
base branch must be pushed first. At most `cloud.maxSessions` at once, and none during a usage limit pause: a session counts against the
plan's usage limits. Never run `cloud send` unless the owner has asked for that start: it starts a session on their plan. `cloud check` (also
in the pulse) reads the finish marker on the branch. After `cloud done`, run `receive` and `merge` as for a local track, so the gates and the
evidence are local.

**When the owner says they are leaving** (logging off, moving, done for the day): run `ravenseat cloud-go --offer`. No output means say nothing
about the cloud (it is off, the owner turned the offer off with `cloud.offerOnLeave`, or nothing fits). Otherwise offer once: show what would start,
that it counts against the plan's limits, and whether the base branch is pushed. Only on their yes: `ravenseat cloud-go [<sessions>]`, which needs a real terminal, so run it in one or give them the command. When they
are back, `cloud check` and then receive and merge. Never start it because they went quiet.

## Known pitfalls

- `String.replace` with `$'` in the replacement duplicates text; build with `split`/`join`.
- Bash heredocs can halve backslashes, and backticks inside `node -e "..."` run as commands: write scripts with Write.
- Tests and scripts that need a git identity use a temporary repo (`git -C <tmp> …`), never the main repo.
