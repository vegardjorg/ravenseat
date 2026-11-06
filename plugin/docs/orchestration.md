# Orchestration: how the pieces work together

One Claude Code chat is the **orchestrator**. It does not write product code. It fills the queue, starts track
agents, receives their results, sends them to review, merges, and asks the owner the questions only the owner can
answer. Each **track** is a subagent (`track` for K and U, `track-d` for D and D+) in its own git worktree, on its own
branch (`queue/<ID>`), with a self-contained mission file.

<p align="center"><img src="../../assets/infographics/architecture.webp" alt="One Claude Code conversation drives the orchestrator, which keeps persistent state, starts agents in isolated worktrees and sends their work through checks and integration" width="800"></p>

## The loop

1. `ravenseat orchestrator pulse`: mark the orchestrator as alive.
2. `ravenseat fill --scratchpad <dir>`: start what the limits allow. For each task it writes `prompt-<ID>.md` (shared
   protocol from `docs/queue/mission-template.md`, filtered for the task's class, plus the task block). The orchestrator
   launches one agent per prompt in the background, with worktree isolation. A task that waited a while or that an
   agent proposed gets an [intake triage](#intake-triage) first: `fill` skips it, prints the triage step and starts
   the others.
3. A track finishes and answers with one `RESULT …` line plus at most a few lines; the long report is in
   `track-result.md` in its scratch folder.
4. `ravenseat receive <ID>`: reads the result line and builds a review package (diff, changed files in full, the track's
   report). The orchestrator starts the reviewers `receive` prints: the fixed ones for the class (`reviewers` in
   `queue.config.json`; by default none for K and U, `reviewer` for D, `reviewer` and `reviewer-security` for D+)
   plus the [helper agents](#helper-agents) that are on and hit (by default `reviewer-challenger` for U and the
   `bug` label, `reviewer-design` for the `visual` label).
5. Findings: HIGH and non-mechanical MEDIUM give a fix round with a NEW track agent on the same branch
   (`prepare-track --continue`). LOW findings become follow-up proposals. A task with a done command (`done_when`)
   is checked before the review: `receive` runs it in the track's worktree, and a red one gives the fix round by
   itself. At the fix-round cap (`maxFixRounds`, default 3) the task becomes an owner question instead (exit 8;
   [the done command and the cap](queue.md#the-done-command-and-the-fix-round-cap)).
6. `ravenseat merge <ID>`: merge into the base branch with `merge-track.mjs`, run the quick gates, start the next tasks.
7. Repeat until `ravenseat state` exits 3 (nothing to do). Owner questions are collected and asked at the end of a
   round, in plain language with a recommendation.
8. When the round ends with only owner items left (questions, proposals, QA) and no agent running, the orchestrator
   starts `ravenseat wait` with `run_in_background`. Claude Code starts a new turn when a background command exits, so an
   answer on the board (`OWNER ACTED: ...`) starts the next round, beginning with `ravenseat resolutions --unlogged`. On
   `TIMEOUT` (8 h, exit 10) it is started once more, then the loop stops. Every `--check-min` minutes (default 5, 0 = off) it also runs the track checks: `TRACKS NEED A LOOK: ...`, exit 11, once per finding. This only works while the Claude Code session
   is open (also via Remote Control); it costs no tokens while it waits. The board's **Waiting on you** says
   "Orchestrator listening" while the waiter's heartbeat (`<dataFolder>/wait-heartbeat.json`) is fresh.

Push happens in **batches**: `ravenseat push-check` first, then `git push`. Every push can trigger CI in your own setup,
so many small pushes cost money quietly. By default (`push.mode` `"owner"`) only the owner's word starts a push; see
[Batch push](#batch-push-the-push-threshold) for the threshold mode and the push guard's reminder.

## Helper agents

Helper agents are optional reviewers on top of the fixed ones. The class is the floor: D and D+ always get their fixed
reviewers, and the helpers only add to that. The reviewers for a task are worked out in one place,
`lib/queueHelpers.js` (`reviewersForTask`); `receive`, the cost per task, the cost guard and the read guard all use it.

| Helper | What it does | Runs when (default) | On by default |
|---|---|---|---|
| `reviewer-challenger` | Tries to prove the delivery wrong | class U, or label `bug` | yes |
| `reviewer-design` | UI/UX: states, errors, WCAG 2.2 AA, keyboard, light and dark mode | label `visual`, or a changed file under `paths` (empty by default) | yes |
| `reviewer-tests` | Do the tests prove the behavior; missing edge cases | class D or D+, or label `bug` | no |
| `reviewer-gap` | The delivery against the mission, point by point | the task has a `plan`, or the mission has 8+ numbered points | no |
| `reviewer-docs` | Docs rewrites: lost facts, findability, docs against code | more than half of the changed files are under `docs/` or `*.md` | no |
| `reviewer-light` | A short review of a K task: mission miss, secrets, access, injection. The task becomes AUDITED, never VERIFIED | class K, and the project has no gates or no CI config | yes |
| `triage` | Intake check BEFORE a track starts: ready, done, stale or adjust (see [Intake triage](#intake-triage)) | the task was added or last edited `triage.minAgeDays` (3) days ago or more, or an agent added it | yes (off in lite mode) |

The setup lives under `helpers` in `queue.config.json`:

```json
"helpers": {
  "reviewer-design": { "enabled": true, "labels": ["visual"], "paths": ["app/", "components/**/*.tsx"] },
  "reviewer-tests": { "enabled": true }
}
```

A helper runs when it is `enabled` and at least one condition hits: `classes`, `labels`, `paths` (a changed file
matches), `mostlyPaths` (more than half of the changed files match), `plan` (true: the task has a plan entry) and
`minMissionItems` (numbered points in `prompt-<ID>.md`). Path patterns: `dir/` is the folder from the root, `*.md`
is that file name anywhere, `**` is any number of folders. A helper with no condition never runs.

- **Switching:** `ravenseat helpers on|off <agent>` (or the board's Helper agents tab) saves the switch in `queue.json`
  (`helpers.<agent>.enabled`), which wins over `queue.config.json`, like `ravenseat limit`. `ravenseat helpers` lists them.
- **Backward compatible:** `reviewers` per class works as before. A helper also listed in `reviewers` for a class is
  fixed there (the switch does not stop it for that class); it is never started twice.
- **The review package** (`00-package.md`) lists the reviewers with one `why:` line each (`why: label visual`,
  `why: changes app/x.tsx`), and carries the mission as `mission.md`. `receive` prints the same.
- **Measurement:** at `set done` (and `cost measure`) the cost per agent keeps its tokens, minutes and, for reviewers,
  the H/M/L numbers from its FINDINGS line. `ravenseat helpers`, `ravenseat cost` and the board show per helper: runs, median and
  sum of minutes, tokens and USD, the share of the task cost it added, and findings per run. "No runs yet" until then.
- **Your own helper:** see [Custom helper agents](#custom-helper-agents) below. It is added, scanned, reviewed and
  approved before it can be switched on.

### Intake triage

A task can wait in the queue for days while the code moves on: the owned files are renamed, another track already did
it, or a later decision made it pointless. A full track finds that out only after a whole agent run. The `triage`
helper (`agents/triage.md`) checks first: read-only, a cheap model with low effort, about 15 turns. It reads the
mission and the owned files against the base branch and answers one line, `TRIAGE ready|done|stale|adjust`, with
`file:line` evidence.

**When it runs** (`lib/queueTriage.js`, `needsTriage`): a waiting task that was added or last edited (title,
mission, owned files, `done_when` or an addition to the mission; the mission file's mtime counts too) at least
`triage.minAgeDays` days ago, and a task an agent added (an approved proposal, or `added_by` a track) that has never
been triaged. A verdict at least as new as the last edit holds until it is itself `minAgeDays` old. Never for fix
tasks (`fixes`) or continuations (a task that has a branch or was started before).

**In the loop:** `fill` does not start such a task. It writes `triage-<ID>.md` in the scratchpad and puts the
`triage` agent in the same "Start these in the SAME turn" block as the tracks (at most `triage.maxPerFill`, default
3, per fill), and keeps starting the other tasks. The step is not printed again for `triage.askAgainMin` minutes
(default 60) while the agent may still run. `next` lists the task as needing a verdict, and `start <id>` refuses it
(`--force` overrides). When the agent answers, the orchestrator records the verdict:

```
ravenseat triage <id> --verdict ready|done|stale|adjust [--note "<the agent's note>"]
```

- **ready:** the task can start (the next `fill`).
- **adjust:** the note is added to the mission (`TRIAGE adjust (<date>): ...` in the track block's additions), then
  the task can start.
- **done / stale** (the note is required): never closed by itself. An owner question `triage-<id>` is registered
  with the choices "Close as done" (or stale), "Keep and start anyway" and "Rewrite"; the task waits on it.
  `ravenseat resolve triage-<id> --choice 1` cancels the task (`ravenseat set <id> waiting` puts it back), 2 makes it startable, 3
  parks it so the owner can `ravenseat edit` the mission and `ravenseat continue` it.

`ravenseat triage` lists the tasks that need a verdict. The config (top level in `queue.config.json`):

```json
"triage": { "minAgeDays": 3, "agentAdded": true, "maxPerFill": 3, "askAgainMin": 60 }
```

`minAgeDays: null` turns the age rule off, `agentAdded: false` the agent rule. `ravenseat helpers off triage` (or the board's
Helper agents tab) turns triage off entirely; in lite mode it is off unless switched on there. The board and
`ravenseat helpers` show its runs and cost (the agent message names the task, so the time log ties it to it) and its
verdicts: how many were ready, done, stale and adjust, and how many tracks it saved (done plus stale).

### Custom helper agents

A custom helper is an agent file of the project's own (or one you found) used as a helper. It runs as a subagent in
the orchestrator session with the tools its frontmatter gives it, so it is reviewed before it is ever on.

1. **Add:** `ravenseat helpers add <file.md> [--name <name>] [--classes K,U] [--labels a,b] [--paths p,q]`, or paste the
   path under "Add a custom helper" in the board's Helper agents tab. The file is copied to
   `.claude/agents/<name>.md` (where Claude Code finds project agents, so the orchestrator starts it by its bare name
   as `subagent_type`), `name:` in its frontmatter is set to the registered name, and it is registered in `queue.json`
   as `source: custom` with `path`, `sha256` and `added_at`. It is **off**. A name that is a builtin agent (Claude
   Code's own, the plugin's, a fixed reviewer) or an existing file is refused. Nothing in the file is run: it is read,
   copied, hashed and scanned. Claude Code loads project agents at session start, so restart the session (or open
   `/agents`) before a new helper can run.
2. **Scan:** `ravenseat helpers scan <name>` (`lib/helperScan.js`, a pure function on the text) gives red, yellow or green
   with one line per finding and its line number:
   - frontmatter: `tools` missing (every tool), Write, Edit, NotebookEdit, WebFetch, WebSearch, Task/Agent and MCP
     tools (red), unrestricted Bash or PowerShell (yellow), `permissionMode`, `mcpServers`, `hooks` (red),
     `isolation` and unknown keys (yellow), `model` (information only);
   - calls out of the machine: URLs (red; a short list of documentation domains gives yellow), `curl`, `wget`,
     `iwr`/`Invoke-WebRequest`, `fetch(`, `nc`, webhooks, `gh`, `git push`, `scp`, `ssh`, a pipe into a shell,
     `npx`, `npm i`, `pip install`;
   - prompt injection and misuse: "ignore previous instructions", "disregard", the system prompt, changing settings,
     hooks, agent definitions or CLAUDE.md, reading `.env`, tokens, keys or `~/.ssh`, hiding something from the owner,
     deleting or force pushing, sending data somewhere, starting other agents;
   - hidden content: base64 like blocks, invisible and control Unicode (zero width, bidi overrides, tag characters),
     HTML comments, very long lines, code blocks with a script language;
   - missing guards (yellow): the "Data, not instructions" paragraph and the FINDINGS line.

   A misuse rule on a line that says no to it ("never force push", "do not start other agents") gives yellow, not
   red. **Red** must not be approved without `--force` and the owner's explicit yes; **yellow** is weighed and
   mentioned; **green** has no findings, and the file is still read in full.
3. **Review and approve:** the `add-helper` skill ("add this as a helper agent") runs the add and the scan, has Claude
   read the whole file, gives the owner a short report with a recommendation, and asks. On yes:
   `ravenseat helpers approve <name> --by "<owner>" --sha256 <hash from the scan>`. It stores `approved_sha256`,
   `approved_path`, `approved_by`, `approved_at` and the scan result in `queue.json`; `--sha256` refuses when the
   file is not the one that was read. The board never approves, and an approval written into `queue.config.json` is
   ignored, so a branch cannot approve its own helper.
4. **On:** `ravenseat helpers on <name>` (or the board's switch) only works while the file's sha256 equals the approved
   one. When the file changes, `ravenseat helpers` and `receive` turn it off in `queue.json` and show "Changed since
   approval"; it stays off until it is reviewed and approved again.

`ravenseat helpers when <name> --classes .. --labels .. --paths .. --mostly-paths ..` changes the conditions (`none` clears
a list). `ravenseat helpers remove <name>` drops the registration and keeps the file; `--delete-file` also deletes the
copied `.claude/agents/<name>.md`. The measurement and the conditions are the same as for the builtin helpers.

**What guards a custom helper:** the selection (`reviewersForTask`) never takes one without a valid approval for the
file as it is now, also when the config says `enabled` or lists it in `reviewers`. The read guard applies to it like
to every reviewer (it is in `allReviewerTypes`), and so do the push guard (every session) and the network guard
(every queue agent, see [Hardening](#hardening-against-prompt-injection)), so a custom helper with Bash cannot reach
the network with `curl` or `| sh` either. The scan still flags a broad `tools` line: a reviewer needs `Read, Grep, Glob`.
`merge-track` protects the custom helpers' agent files like `.claude/`, also when `protectedPaths` was changed: a
track cannot rewrite an approved helper without owning its file.

Every reviewer disproves a HIGH or MEDIUM finding before writing it (reread the code, look for counter-evidence,
check that the change introduced it, lower it one level when there is no ground). A security finding is lowered only
on counter-evidence at file:line and carries an `EXPLOIT:` part. A reviewer never starts other agents.

## Why it is cheap (context discipline)

Every turn re-reads the whole conversation, mostly from the prompt cache. Cost therefore grows with turns times
context size. The system keeps both small:

- **Small, self-contained missions.** A track starts with only its mission and reads excerpts (`grep -n`, then
  `offset`/`limit`), never whole files twice.
- **Context cap.** A track may compact once (`autoCompactWindow` applies to tracks too). After the first compaction
  it gets one reminder to check the mission, the branch and its commits. At the second compaction, or at the hard
  limit 280k (`TRACK_CONTEXT_WARNING`), it is told to commit, write `handover.md` (handover) and deliver PARTIAL; a
  new agent continues. The hook `hook-track-context.mjs` enforces this on tool calls.
- **End gate.** `hook-track-end.mjs` (SubagentStop) stops a track ONCE when it ends with no own commits on its branch
  (counted against `head_start` and the base branch) and no end line (`RESULT`, `PARTIAL` or `REFUSE`). It fails
  open: an unknown task, branch or git error lets the track stop.
- **Pause advice.** When the owner writes that they are leaving ("have to go", "good night", "pause") and the
  orchestrator is over 150k (`CONTEXT_PAUSE`), `hook-context.mjs` suggests `/compact` before the break, because a
  pause of over an hour writes the whole context to the cache again.
- **Orchestrator compaction.** `hook-context.mjs` warns, then winds down, then stops the orchestrator chat as it
  grows; `/compact` with a focus is the normal path, and `hook-after-compact.mjs` re-injects the queue state after
  compaction, so the summary does not have to carry it. `autoCompactWindow` is set to 300000. Automatic compaction is
  the default (`ravenseat compact auto`) and uses Claude Code's own compaction (`autoCompactEnabled`, on by default). For
  `ravenseat compact manual`, turn that off too, or Claude Code still compacts at 300k.
- **Handover note in two parts.** `<dataFolder>/handover-ongoing.md` has a `## Now` section at the top (the current
  state, at most 40 lines, rewritten in place) and a dated log below it. `ravenseat handover archive [--dry]` moves log
  entries older than 24 h to `handover-archive/<year-month>.md` (an active trial or follow-up section stays) and warns
  when "Now" is too long or missing; run it at every compaction. `ravenseat handover now` prints only the "Now" part. After
  compaction `hook-after-compact.mjs` injects only that part, and `/ravenseat:queue` reads only that part at takeover; the
  rest is read with grep when needed.
- **Status line.** `statusline.mjs` shows `ctx 142k 71% | $3.21 | 5h 23% 7d 41% | tracks 2 (+1 review)`: context,
  session cost, the 5-hour and 7-day quota, and running tracks (the count is cached on the queue file's mtime, so
  it is cheap). A plugin cannot set `statusLine` itself, so `ravenseat setup --settings` writes it to
  `.claude/settings.local.json` (personal, gitignored) with the plugin's absolute path; run it again after a plugin update. A status line of your
  own is kept. The line also saves the last quota reading in `<dataFolder>/rate-limits.json`, and
  `ravenseat capacity --calibrate auto` uses its 7-day percentage as a calibration point (refused when it is over 1 h old).
- **Context limits in every chat.** The same hook also watches every other chat in a project with the queue, not only
  the orchestrator: a notice from 250k. With `"contextGuard": { "blockOtherChats": true }` in `queue.config.json`
  (default off), the message is also stopped at 400k so a long chat does not keep paying for its whole history; then
  compact the chat (`/compact`), or start the message with `continue:` to send it anyway. Messages
  Claude Code sends by itself (an agent is done) are never stopped. The limits can be changed with the environment
  variables `CONTEXT_WARNING`, `CONTEXT_STOP`, `CONTEXT_WIND_DOWN`, `CONTEXT_STOP_ORCHESTRATOR` and `CONTEXT_COMPACT`
  (tokens).
- **Cache-friendly waiting.** No sleep or poll loops. Subagent prompt cache TTL is set to 1 hour
  (`subagentPromptCacheTtl`), so a reviewer started a while later still hits the cache.
- **Reading guard.** `hook-read-guard.mjs` stops tracks and reviewers from re-reading files that are already loaded
  automatically, or reading huge files in full.
- **Push guard.** `hook-push-guard.mjs` asks before force pushes, pushes of other branches than the base, and
  migration pushes to environments not listed as allowed, and denies deleting the base on the remote (`--delete`,
  `:<base>`). It reads the whole command line (`lib/shellCommands.js`): `bash -c`, `sh -c`, `powershell -Command`,
  `pwsh -c`, `cmd /c`, `eval`/`iex`, the `&` call operator, `( )`, `$( )`, backticks, `;`/`&&`/`||`/pipes, env
  prefixes, `git -C` and inline aliases (`git -c alias.p=push p`). A part it cannot see into (inline `node -e` code, a
  variable as the command, a brace list, `xargs`, `Start-Process` …) in a line that looks like a push gives a question
  in the main session and a deny for a queue agent. It also covers the Monitor tool, and reads `g"i"t` and `g\it` as git.
  **Known limits:** the guard catches the usual ways of writing a command, not every way. It does not see inside a script
  file (`bash x.sh`) or code that builds the command at run time (`node -e`), and the agents run as the same OS user, so
  it is no security boundary. A queue agent's `ravenseat add` is judged by the branch the hook sees: a track that reached the main
  checkout by such a route could add a task that is ready to run.
- **Time and cost log.** `hook-time.mjs` logs subagent start and stop; `ravenseat cost` turns the measured sessions into
  per-class statistics, so estimates get better over time. The same file (`timeLog`, overridden by `QUEUE_TIME_LOG`)
  also gets rows for the benchmark in `bench/` (formats in `lib/timeLogRows.js`): one `gate` row per gate run (see
  Gates below) and one `compact` row per compaction. `hook-after-compact.mjs` writes `{ time, event: "compact", scope:
  "session", session_id, orchestrator }` for every main session (`orchestrator` is true for the bound orchestrator),
  and `hook-track-context.mjs` writes `{ time, event: "compact", scope: "track", agent_id, agent_type, track,
  compactions }` once per new track compaction (`compactions` is the count after it; once a track has had its PARTIAL
  message its transcript is no longer counted). Writing a row never changes what the hook does.
- **Transcript metrics.** In the same single pass over the transcript, each `done` row also gets `byModel`
  (`{<model>: {turns, tokens, cost_usd}}`; `cost_usd` of the row is the sum, `model` is kept for old readers), `tools`
  (`{<name>: {calls, errors}}`, errors are tool results with `is_error`), `api_errors` (`{rate_limit, overloaded,
  other}`), and `active_s` with `idle_gaps`: the wall time minus gaps longer than `metrics.idleGapMin` minutes (default
  5). Time spent (calibration minutes) uses `active_s` when the row has it; `duration_s` stays. Prices are per model
  family in `lib/timeCost.js` (`PRICE_TABLE`, with its source and date); the config key `prices` overrides them per
  model id or family (`{"opus": {"input": 5, "output": 25, "cache_read": 0.5}}`), and a model with no price is priced
  as Opus 5.5 and marked as assumed. An agent with a `start` row and no `done` row (killed, so no SubagentStop) is
  measured from its transcript at `ravenseat receive`, `set <id> done` and `ravenseat cost measure`: one `done` row with `killed:
  true`, cumulative like the others, so a later real stop never counts twice. A transcript written in the last 2
  minutes is left for the next measurement. `ravenseat cost` and `log-time.mjs --cost` show the per model split, top tools,
  API errors, active time and killed agents; old rows without the fields still work.
- **Hook cost.** `hook-track-context.mjs` runs on every tool call in every session (PostToolUse, matcher `*`); it
  exits before any require unless the agent is a track, so the cost is the process start. All hooks are in exec form
  (`"command": "node", "args": [...]`): Claude Code spawns node directly, with no shell, and substitutes
  `${CLAUDE_PLUGIN_ROOT}` (plugin) or `${CLAUDE_PROJECT_DIR}` (vendored install) in `args`. In shell form Windows starts
  Git Bash first, which made the hook start about 1.6 times slower on a loaded machine. The hooks stay synchronous: an
  `async: true` PostToolUse hook that fires in a subagent delivers its additionalContext to the main session, so the
  track would never see the PARTIAL message. `setup --hooks` rewrites older shell-form queue hooks in
  `.claude/settings.json` to exec form. Exec form needs `node` to resolve to a real executable (`node.exe`), not a
  `.cmd` shim.

## Adopting running tracks (cheap rotation)

Tracks keep running when the orchestrator session changes; only the `<task-notification>` goes to the session that
started them. A new session adopts them without that notification:
- **The signal:** `track-result.md` in the track folder (`<scratch>/<ID>/`, or `<scratch>/<ID>-r<N>/` for a fix round) with
  the `RESULT status=DONE|PARTIAL …` line as its first line. `queue-takeover.mjs` classifies the task DELIVERED on it;
  the old heuristic (commits, clean worktree, 20 min) is the fallback.
- **`ravenseat orchestrator pulse`** also applies [auto-accept](queue.md#auto-accept-of-proposals) to older proposals when
  the owner has turned it on (default off), with one `Auto-accepted <ID>` line each.
- **`ravenseat orchestrator pulse`** prints `NEW DELIVERY (track-result.md): <ID> …` once per report (the task remembers it in
  `report_seen`), and **`ravenseat deliveries [--json]`** lists every report that is not received yet. `ravenseat receive <ID>`
  reads the newest report, also from a fix round folder, and saves `report_received`.
- **`ravenseat resume <ID> --reason fix|context`** writes `prompt-<ID>-r<N>.md` for a NEW agent on the same branch
  (`prepare-track --continue`, the paths to the report, handover, review package and `--findings-file`).

- **Started without agent:** `fill` and `start` only MARK a track as running; the agent starts when the orchestrator
  acts on the "Start these in the SAME turn" lines. If fill ran where nobody read the output (`ravenseat merge` in the
  background, or a script that chains several merges), the track stays "running" with no agent and the queue stalls
  without an error. So `ravenseat show` (first in the output, so it survives the after-compact trimming), `ravenseat state`
  (`withoutAgent`) and `ravenseat orchestrator pulse` print `STARTED WITHOUT AGENT` for a running track older than 15 minutes
  whose branch no worktree has checked out and that has no track-result.md from this start (an older one no longer turns the warning off). Picked tasks and cloud sessions are left out.
  Fix: `ravenseat set <ID> waiting`, then `ravenseat fill --ids <ID>` and start what it lists in the same turn (fill checks the
  migration block again). Run `ravenseat merge` where you read the output; in a chain or a background job use `--without-fill`
  and run fill yourself afterwards.
- **A round under way:** a task in review whose last attempt is still open (`ravenseat resume` or a fix round) is not aged as
  "in review", and `ravenseat takeover` says `WORKING` instead of `DELIVERED (review)`. If its agent hangs, the track gets
  `SILENT`, counted from when the round was prepared. A report from an earlier round does not turn that off.
- **Round without an agent:** `ravenseat resume` and `ravenseat fill` reserve an attempt, and the start row in the time log turns it into running. A reservation older than 15 minutes with no start row, commit or report since gives `ROUND WITHOUT AGENT` (a prepared round; `STARTED WITHOUT AGENT` for a first start held by an old worktree), a card in `ravenseat decide`, and `NO AGENT` in `ravenseat takeover`. It needs a client with hooks and at least one start row in the log, so a project without the hook is not warned falsely. Fix: `ravenseat resume <ID> --reason <reason>` gives the same round and the agent line. Answers on the board use `ravenseat resume --by owner`, which wakes `ravenseat wait`.
- **Silent:** a running track whose branch a worktree HAS checked out (so the agent started), but that has shown no
  sign of life for `limits.silentMin` minutes (default 20, `ravenseat limit silentMin <n>`, 0 = off). The sign of life is the
  newest of: the last commit on the branch, the newest mtime in the worktree (node_modules and .git skipped, a capped
  walk), the track folder in the scratchpad, and the agent transcript and time log rows tied to the task. `ravenseat show`
  (right after STARTED WITHOUT AGENT), `ravenseat state` (`silent`) and `ravenseat orchestrator pulse` print `SILENT`, and the board
  marks the card "silent". After 60 minutes it also gets a card in `ravenseat decide`. Check the track, then `ravenseat resume <ID> --reason context` and start the new agent, or stop it.
- **Blocker reasons:** `ravenseat block <ID> <code> [--note "…"]` / `ravenseat unblock <ID>` record why a task is stuck, with codes
  from one fixed table (`merge-conflict`, `merge-guard`, `merge-stopped`, `gate-red`, `context`, `quota`, `owner-question`, `track-question`, `dependency`, `no-agent`,
  `silent`, `other`). `ravenseat merge` opens `merge-conflict` (a real conflict), `merge-guard` (protected paths), `merge-stopped` (any other stop
  in the merge step, such as the identity guard) or `gate-red` (a stop in the gates) by itself and closes the open one
  after the next successful merge; a green `ravenseat receive` closes `gate-red` too. A task in review with one of these open
  shows in `ravenseat decide` and on the board's Decisions view, with the next step. A red base stands above that list. `ravenseat blockers [--days 7]` clusters them: count and
  blocked time per code, top first (also in the board's Statistics).
- **Predicted conflicts:** `ravenseat orchestrator pulse` checks each running, picked or review track tip against the base
  and against the other tips with `git merge-tree --write-tree` (writes no index, checkout or ref) and prints
  `PREDICTED CONFLICT <A> x <B>: <files>`, `CONFLICTS WITH BASE: <A>: <files>` and a suggested merge order (a track's
  dependencies first, then the one with the fewest predicted conflicted files, delivered before running). Results are
  cached per sha pair in `<dataFolder>/conflict-predict.json`, so a round where no tip moved runs no merge check; a
  round over the time budget says PARTIAL and the next one continues. `ravenseat conflicts [--json]` gives the full picture.
  On git older than 2.38 it falls back to changed-file overlap (one NOTE line; `ravenseat doctor` shows an INFO line). When
  `ravenseat merge` stops on a real conflict, it saves the conflicting files and the other tasks that touched them (owners and
  queue merges since the fork) on the task (`merge_conflict`) and prints them; `ravenseat resume <ID> --reason fix` puts them
  in the fix round brief. The next successful merge clears it.

An emergency rotation therefore needs no quiet window. Stop the old session first, so two orchestrators do not
receive and merge the same track. Compaction is still the usual path for a long session.

## Track classes and effort

| Class | Agent | Effort | Typical size |
|---|---|---|---|
| K (code) | `track` | medium | 90 to 120 min |
| U (investigation) | `track` | medium | about 60 min |
| D (database) | `track-d` | high | about 40 min |
| D+ (high-risk DB or security) | `track-d` | high | 25 to 30 min, at most 3 migrations |

## Rules that matter

- Tracks commit only on their own branch, with `git commit -- <files>` (pathspec), and never push or merge.
- Tracks never kill processes by pattern; other tracks run the same scripts.
- Ownership is exclusive while a task runs. Hotspot files (navigation, central registries) are changed by the
  orchestrator while merging, from the wiring specification in the track report.
- New work discovered by a track becomes a proposal (`ravenseat add` from its worktree), never scope creep. The queue sets
  `added_by` from the branch, `--approved` is refused, and a track may have 3 open proposals. The mission shows the command, and
  the proposal needs only `id`, `title` and `mission`: the rest follows the track, and the class is K unless the task sets it.
- The worktree rule: never `npm install` inside a worktree (shared folders are links to the main tree), and clean up
  worktrees only with `cleanup-worktree.mjs`. A whole `ravenseat merge` (also `--resume`) removes the worktree and deletes the
  merged queue branch with `git branch -d`; `ravenseat doctor` names merged `worktree-agent-*` branches with no worktree left.

## Gates and the precheck

`ravenseat gates` (`gates.mjs`) runs the project's checks from `gates` in `queue.config.json`, in the track's own worktree:
`--quick` (tracks of class K and U, and `ravenseat merge` after merging) and `--full` (D and D+, and the orchestrator before a
batch push). One line per gate with GREEN/RED and the time; `--log <file>` keeps the full output.

**Gate rows in the time log.** Every `--quick`, `--full` and `--precheck` run appends one row to the time log:
`{ time, event: "gate", track, branch, kind, gates, failed, duration_s, ok, exit, attempt, timed_out?, sha?, clean? }`
(`sha` = HEAD when the run started, `clean` = no uncommitted tracked changes then; the base gate's skip rule reads them). `track` is
`--track <id>` (`ravenseat merge` passes it, since HEAD is the base branch after a merge) or the id in a `<branchPrefix><id>`
branch, otherwise null. `gates` are the commands (or precheck checks) that ran and `failed` the red ones. `attempt`
counts the runs of the same kind for the same task (or the same branch without one), so `attempt > 1` is a rerun.
`timed_out: true` marks a precheck check that went over its budget. The row is fail open: it never changes the output
or the exit code. A setup error (precheck exit 2) writes no row.

**Precheck (fail fast).** Before the class's full gate a track runs `ravenseat gates --precheck`. It runs the cheapest checks
first, in a fixed order, only on the files changed against `baseBranch` (committed since the fork point, staged,
unstaged and untracked; deleted files are left out), and stops at the first red one, so a red error shows up in a few
minutes instead of after a long full run. Only a green precheck goes on to the full gate, which is unchanged.

- The checks are `gates.precheck`: a list of shell commands, or objects `{ name, command, files, budgetSec }`. In a
  command `{changed}` is replaced by the relevant changed files (quoted), and `{file}` runs the command once per file.
  `files` are path patterns (as for the helpers: `*.ts`, `src/`, `**`); without them every changed file is relevant.
- A check is skipped (SKIP) when no changed file is relevant, for example only `.md` changed: no tests run. When
  nothing changed against the base branch, everything is skipped.
- `gates.precheck: null` (the default) gives the standard checks the project has, in this order: `node --check` on
  each changed `.js`/`.mjs`/`.cjs` file; `npx tsc --noEmit` when `tsconfig.json` and a local `tsc` exist; `npx eslint`
  on the changed code files when an eslint config and a local `eslint` exist; and the tests related to the changed
  code files (`vitest related --run`, or `jest --findRelatedTests`) when a local vitest or jest exists. Only local
  tools in `node_modules/.bin`, so `npx` never fetches from the network. `[]` turns the precheck off.
- Each check has a time budget (`budgetSec`, default `gates.precheckBudgetSec`, 120 s; the standard checks have 60 to
  180 s). Over the budget the check and its child processes are ended, the line says TIMEOUT with the reason, and the
  precheck stops with exit 3. That is a slow check, not a code error: the track goes on to the full gate.
- Output: one line per check (GREEN, RED, SKIP, TIMEOUT or NOT RUN, with the time); under a red one the command and its
  first error lines; then a final line. Exit 0 green, 1 red, 3 timeout, 2 setup error (for example the base branch was
  not found; `--base <ref>` picks another ref). `--json` gives the same as one JSON object (`ok`, `status`,
  `stoppedAt`, `base`, `changed`, `totalSec`, `checks`). The logic lives in `lib/gatePrecheck.js`.

## The base gate (a red base stops the merges)

Each track's gates run on its own branch, so two tracks can each be green and still break the base branch together (a
semantic conflict: one renames a function, the other adds a call to the old name; git merges both without a conflict).
The base gate (`baseGate` in `queue.config.json`, `lib/baseHealth.js`) records the base branch's health per tip in
`<dataFolder>/base-health.json` and makes `ravenseat merge` refuse other tracks while it is red.

- **Where it runs.** In the main checkout, on the base branch, where `ravenseat merge` already merges and runs `gates --quick`.
  No extra worktree (the shared links make creating and removing worktrees the hazard `cleanup-worktree.mjs`
  handles). The check never writes to the checkout; `ravenseat merge` warns when the checkout had or got tracked changes.
- **Which commands.** `baseGate.commands`, default `null` = the quick gates. Then the merge step's own quick gates run
  on the new tip IS the base check (nothing runs twice; it gets the budget `baseGate.timeoutSec`, default 900 s, as
  `gates.mjs --timeout-sec`). Other commands (for example the full gate) run as a `base-gate` step after the quick
  gates, with one budget for the whole list. Only the output tail (`baseGate.tailLines`, default `doneCheck.tailLines`)
  is kept, in `base-health-<sha>.md` next to the merge log, never the full output (it can hold secrets).
- **Before a merge.** Green for the current base tip: merge. Unknown (never checked, or the tip moved since the last
  check, for example a commit by hand): the check runs first. Red: `STOP`, exit 9, nothing done. Allowed while red:
  the open base fix task itself, and `ravenseat merge <id> --force-red-base` on the owner's word (logged in the time log as
  `base-red-overridden`).
- **Git hooks or config changed.** A check that changes what runs at the next git command gets no red verdict and no
  fix task: `ravenseat merge` stops for the owner, and `--resume` goes on once it is settled. The same goes for `ravenseat receive`.
  As orchestrator, pass the message to the owner and wait: `ravenseat surface accept --by owner` is theirs to run or to
  say (see [queue.md](queue.md), Git hooks and config). Never accept a difference on your own judgement.
- **Red after a merge.** The merge stays (never reverted automatically; the message gives the `git revert -m 1 <sha>`
  line to do it by hand). A fix task `<id>-BASE<n>` is added: value 10, `fixes` the merged task, the base gate as its
  `done_when`, and a mission that names the merge commit and the tail file. An open fix task is reused instead of a
  second one; a red tip no merge is known to have caused gets `BASE-<sha7>`. When the quick gates are red the merge
  flow stops as before (the task stays in review with `gate-red`; set it done after the fix task); when only other
  base gate commands are red, the task is set done, `fill` runs (and starts the fix task), and `ravenseat merge` exits 9.
- **Green again.** The next green check (normally the fix task's merge) clears the red.
- **The flaky check.** Before a red check freezes the base, only the failed commands run once more on the same sha
  (in the merge step for the quick gates, in the base-gate step and before a merge for the rest). Green on the rerun:
  `FLAKY: <command> was red, then green on a rerun`, the verdict is green with `flaky` in `base-health.json`, a
  `flakyGate` row goes to the time log (`flaky gate command(s)` in the Flow box of `ravenseat cost`), and a finding
  `Flaky gate command: <command>` is filed (`ravenseat finding list`; a second flake counts on the same finding). Nothing is
  frozen. Red twice: frozen as before. `baseGate.flakyRerun: false` turns the rerun off.
- **The skip rule.** When the merge commit has exactly the tree of the track tip (the branch already contained the
  base, or a fast-forward) and the track's own gate ran green on exactly that tip in a clean worktree with every base
  gate command (the gate row's `sha` and `clean`), green is recorded without running the gates again.
- **Where it shows.** One `BASE <branch>: GREEN|RED|unknown ...` line in `ravenseat show` and the orchestrator pulse, and the
  board's status line under the title.
- **On and off.** `baseGate.enabled`: `"auto"` (default) is on when there are commands, `false` turns it off. Lite
  mode has no rule of its own: it is off until the project has a quick gate.

## The gate evidence (what a push and a merge trust)

A track's own gate runs are informational: its `RESULT gates=OK` is a claim. What the queue trusts is the gate
evidence store, `<dataFolder>/gate-evidence.json` (`lib/gateEvidence.js`), which only `gates.mjs` writes, in the main
checkout or with ravenseat's own `--evidence` run:

- `ravenseat receive` runs the quick gates itself on the delivered tip (in the worktree that has the branch checked out, with
  no uncommitted tracked changes) and saves the result as the task field `gate_check` (`ok`, `kind`, `tip`, `at`,
  `ran`, and `evidence_at` when an earlier green entry for that exact tip was reused). Red: the blocker `gate-red` and
  a fix round, as for a red done command. `ravenseat merge` refuses while that result stands (`--force-red-gate` on the
  owner's word, logged as `gate-red-overridden`); commits after a red result need a new `ravenseat receive`.
- A batch push needs `ravenseat gates --full` run in the main checkout, on exactly the base tip, with no uncommitted tracked
  changes: `ravenseat push-check` says `BLOCKED` while `gates.full` is set up and that entry is missing or red.
- Out of the agents' reach: the push guard denies a queue agent's shell command that names the store or passes
  `--evidence` or `--cwd` to the gate runner, and the write guard (`hook-write-guard.mjs`, PreToolUse on
  `Write|Edit|NotebookEdit`, `lib/writeGuard.js`) denies a queue agent (track, track-d, the reviewers and helpers) a
  direct write to `gate-evidence.json` anywhere, and to the data folder's `queue.json` and `base-health.json`. The
  main session is never stopped, and the hook is inert without `queue.config.json`. Both are guards against mistakes
  and casual forgery, not a security boundary: the agents run as the same OS user.

## A merge that survives interruptions

`ravenseat merge` runs several steps in a row, so it guards against being cut off or run twice (`lib/mergeLock.js`):

- **One at a time.** A lock file `<dataFolder>/merge.lock` (pid, host, start time) lets one `ravenseat merge` run per repo. A
  second one stops at once and names the holder. A lock whose process is gone (same host) or that is older than 6 h
  is stale and taken over; the message names the merge that was cut off.
- **No merge on top of an unfinished one.** A merge, rebase, cherry-pick or revert in progress in the main checkout
  (`MERGE_HEAD` and the like) refuses `ravenseat merge` and `merge-track.mjs` (exit 5), with how to finish or undo it.
- **Done only when merged.** After the merge step and again before `done`, the track tip must be in the base
  (`git merge-base --is-ancestor`). Otherwise the task is not marked done and stays in review. The merge commit is
  stored on the task as `merge_commit`.
- **Resume.** Every step is recorded in `<dataFolder>/merge-state-<id>.json` as it starts. After Ctrl-C, a crash, a
  stop after the merge (the migration push, a red gate) or a conflict resolved and committed by hand,
  `ravenseat merge <id> --resume` runs only the steps after the merge that have not run (migration push, gates, base gate,
  done, fill). A plain `ravenseat merge <id>` on a branch that is already in the base says so and gives that command.

## Gate from incident (a failure becomes a check)

The base gate catches a red base; it does not stop the same kind of mistake from coming back. So when a post-merge
defect shows up (a bug found in merged code), the base goes red (a `<id>-BASE<n>` or `BASE-<sha7>` fix task), or the
owner reports a bug, the orchestrator asks whether the failure class is repeatable: could another track make the
same mistake? Only then does it propose a regression gate next to the fix: a task with `"labels": ["gate"]` and the
title `Gate: <failure class>`, proposed for the owner to approve. A one-off (a typo, a single wrong value) gets the fix
only, and an open gate task for the same class is extended instead of duplicated.

The gate mission uses the same criteria as [`/ravenseat:review`](#review-to-gate-ravenseatreview) ("The gate criteria" in
`skills/review/SKILL.md`): clear purpose, a reproducible failing example, low maintenance cost, red first, and the
check lives in the project's own gates. Red first is part of the task: its `acceptance` includes the red-first
criterion, `done_when` runs the new check when the project has a command for it, and the track's `track-result.md` shows
both runs (failing without the fix, passing with it). A separate fix task `depends_on` the gate task so the check is
seen red on the real bug. The loop step is in `skills/parallel-wave/SKILL.md` ("Gate from incident").

## Batch push (the push threshold)

Every push of the base branch runs the whole CI. Pushing per small change burns CI minutes quietly, so pushes come in
batches, and the batch is measured in **merged tasks**, not commits: one track gives several commits plus a merge
commit. Projects with gates and the harness as their safety net push 20 to 500+ commits per batch.

- **How the batch is counted.** The first-parent line of `<remote>/<baseBranch>..<baseBranch>`: a merge commit with
  the subject `Merge branch '<branchPrefix><id>' ...` (what `ravenseat merge` writes) is one merged task, distinct ids, so a
  task merged again after a fix counts once. Commits (`git rev-list --count`) are the secondary figure. The remote ref
  is the local one as of the last fetch; nothing here fetches. The age is when the oldest unpushed commit landed on
  the base branch (`lib/pushBatch.js`).
- **The verdict.** `ravenseat push-check` prints `Batch: N merged task(s) / M commit(s) unpushed, oldest <age> old; base
  GREEN|RED|not checked at <sha>` and one verdict line (`--json` has it under `batch`):
  - `READY`: at least `push.minTasks` merged tasks, or the oldest work is older than `push.maxAgeHours`;
  - `NOT YET (n of minTasks)`: below the threshold;
  - `BLOCKED`: the base is red at the tip (the [base gate](#the-base-gate-a-red-base-stops-the-merges)), the remote has
    commits the base branch does not, or (mode `threshold`) there are commits outside the queue;
  - `LARGE`: at least `push.warnTasks` merged tasks: push recommended (a large batch makes a red CI harder to bisect).
    A warning, never a block;
  - `NOTHING`: nothing to push.
  The verdict does not change push-check's exit code: 0, or in mode `threshold` 2 for commits outside the queue. In mode
  `owner` such commits are one neutral line, with the command that leaves them out when there is a safe cut point, and
  `ravenseat external` lists them: nothing goes out before the owner's word anyway.
- **The modes.** `push.mode` `"owner"` (the default): the orchestrator never pushes on its own, only when the owner
  says "push", as before. `"threshold"`: the orchestrator may push by itself when push-check says `READY` or `LARGE`,
  never when it says `BLOCKED` (and never with external commits the owner has not answered for).
- **The push guard's reminder.** A plain `git push` of the base branch by the orchestrator below `push.minTasks`, or
  with the base red at the tip, gets Claude Code's confirmation dialog: `4 of 10 merged tasks since the last push ...;
  push anyway?` or `base is red at <sha7>; push anyway?`. This applies in both modes (in owner mode the owner is the
  one pushing, and a reminder is cheap). It never denies: the owner can always push. `minTasks: 0` turns the count
  question off; the red-base question stays. Tracks never push, and nothing changes for them. The guard costs one
  `git log` and only for a push of the base branch; any error lets the push through.
- **Where it shows.** push-check, and the board's status line next to the base health (`Push: 4 of 10 tasks, NOT YET`).

| Key | Default | Meaning |
|---|---|---|
| `push.mode` | `"owner"` | `"owner"`: push only on the owner's word. `"threshold"`: the orchestrator may push on `READY` or `LARGE` |
| `push.minTasks` | `10` | Merged tasks for `READY`; below it the guard asks. `0` = no lower limit |
| `push.warnTasks` | `50` | From this many merged tasks the verdict is `LARGE` (push recommended). `0` = off |
| `push.maxAgeHours` | `null` | When set, unpushed work older than this makes the batch `READY` below `minTasks` |
| `push.ciWatch` | `"off"` | `"github"`: the optional CI watch after a batch push (`ravenseat push-check --watch-ci <sha>`, needs `gh`) |
| `push.ciWatchIntervalSec`, `push.ciWatchTimeoutMin` | `60`, `90` | The CI watch's poll interval and its cap (exit 10 after it) |

**The CI watch (optional).** The local gates are the rule (a push needs a green `ravenseat gates --full` on the tip), but CI
can still go red on what a batch push sent. `push.ciWatch: "github"` (default `"off"`, needs the `gh` CLI) turns on
a safety net: right after a batch push the orchestrator starts `ravenseat push-check --watch-ci <sha>` in the background
(`run_in_background`; push-check prints the command when the watch is on). It polls `gh run list --commit <sha>`
every `push.ciWatchIntervalSec` (60) and exits when the runs are done, like `ravenseat wait`:

- exit 0 `CI GREEN`: every run is green;
- exit 9 `CI RED`: a check failed. One fix task `CI-<sha7>` (value 10, class K, waiting, as the base fix task) and
  the base is marked red at the tip with that task as its fix task, so `ravenseat merge` lets only it through;
- exit 0 `CI INFRA`: every red run failed outside the code (cancelled, timed out, a runner that never started or went
  away, billing). An owner question `ci-<sha7>-infra` (rerun the failed jobs or ignore). Nothing is frozen;
- exit 10 `TIMEOUT`: not done after `push.ciWatchTimeoutMin` (90) minutes. Exit 0 also when no run shows up for the
  commit within 10 minutes (no CI for this push).

Only the failed jobs' log is fetched (`gh run view --log-failed`), and only its tail is kept (about 8 KB, 60 lines),
redacted with the secret patterns of `lib/secretScan.js`, in `<dataFolder>/ci-<sha7>.md`. The task and the question
name that file and never hold the log. A second watch of the same sha (a rerun) finds the task or the question and
adds nothing. `ravenseat doctor` checks the keys.

**Recommendation.** New users: keep `"owner"`. Projects with expensive CI: `"threshold"` with `minTasks` 10 and
`warnTasks` 50, then tune; the numbers are yours to choose. A `maxAgeHours` (for example 24) keeps a slow week from
holding work back.

**Cheaper CI per push.** `ravenseat doctor` scans `.github/workflows/*.yml` that run on push (a text scan, no YAML parser):

- WARN without `concurrency` and `cancel-in-progress: true`: a newer push does not stop the older run. Add
  `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` at the top level.
- INFO without a `paths` or `paths-ignore` filter: a docs-only push runs the whole CI. Add for example
  `paths-ignore: ["**/*.md", "docs/**"]` under `on.push`.

**Secret check and deploy commands in the push guard.** Before a plain push of the base branch by the orchestrator,
the guard scans the added lines of every commit the push sends (`git log -p --no-merges
<remote>/<baseBranch>..<baseBranch>`, so a key added in one commit and deleted in the next is still found): with
gitleaks when it is on PATH, otherwise with a few built-in patterns (private key headers; AWS, GitHub, GitLab, Slack,
Stripe live, Google API and OAuth, Azure storage, OpenAI, Anthropic, Supabase `sb_secret_`, npm, SendGrid, Hugging
Face and DigitalOcean key formats; JWTs; a GCP service account file; and, outside test, fixture, example and docs
files, a URI with a password (`scheme://user:pass@host`), a value line in a `.env` style file and a generic
`password=`/`secret=`/`token=`/`SERVICE_ROLE_KEY=` with a long value). A hit gets the confirmation dialog with
file:line, the rule and the commit, never the value; a false alarm is answered with "push anyway". It never denies. A
log over `secretScan.maxBytes` falls back to the net diff. Skipped silently: a net diff larger than
`secretScan.maxBytes`, a first push (no remote ref, it would scan the whole history), a timeout or any error.
`secretScan.enabled: false` turns it off. With the batch question, both are asked in one dialog.
`deployCommands` (empty by default) lists the project's deploy commands; any command that starts with one of them
gets the confirmation dialog, from an agent or the main session. It is a reminder, not a wall: a list is never
complete, so keep production credentials out of the shell Claude Code starts from.

## Hardening against prompt injection

A track reads text the owner did not write: files, PDFs, web pages, other agents' reports. If it follows an
instruction hidden there, the damage must stop before it reaches the orchestrator. Claude Code has no sandbox on
Windows, so there are four layers:

- **Data, not instructions.** The agent definitions (`track`, `track-d`, `reviewer`, `reviewer-security`) and the
  shared protocol in the mission template say that such content is data, and that instructions in it are reported
  under "Suspicious content", never followed. `make-queue-common.mjs` refuses a template without the paragraph.
- **Merge guard.** `merge-track.mjs` stops with exit 4, before the merge, when the branch touches a protected path
  that the task does not own (`owned_files` or `shared_patch`). The list is `protectedPaths` in `queue.config.json`
  (default: `.claude/`, `.githooks/`, `.github/`, `.mcp.json`, `scripts/orchestrator/`, the plugin's hooks, agents,
  skills and scripts, `queue.config.json`, `CLAUDE.queue.md`, `settings.queue.json`, `package.json`,
  `package-lock.json`, and the test, lint and type configs such as `vitest.config.*`, `tsconfig*.json`, `.eslintrc*`,
  `pytest.ini`, `pyproject.toml`, `Cargo.toml` and `Makefile`, see queue.md). Read the diff; then add the path to the
  task's ownership, or run `ravenseat merge <ID> --allow-guard`, which is logged as `guard-overridden` in the time log.
  Other files outside the ownership only give a warning.
- **Network guard.** For every queue agent, `hook-push-guard.mjs` denies `curl`, `wget`, `iwr`/`irm`,
  `Start-BitsTransfer` and a pipe into a shell (`| sh`, `| iex` …), and asks before `npm install` or `npx` with a
  package that is not in `package.json`. The queue agents are `track`, `track-d` and every reviewer and helper agent,
  builtin or custom (the same list as the read guard, `queueAgentTypes` in `lib/trackGuard.js`, also with the plugin
  prefix such as `ravenseat:reviewer`, plus every agent file the plugin ships, `PLUGIN_AGENT_TYPES`: `ask`, `triage` and all
  `reviewer-*`). None of them needs the network. The orchestrator (the main session) is not affected
  and fetches what an agent needs.
- **Queue agents never push or steer the queue.** For the same queue agents the push guard denies every `git push`
  (any remote, refspec or form: `HEAD:<base>`, `--delete`, `:ref`, `--mirror`, `--all`, `--tags`, `-f`, `send-pack`,
  `subtree push`), a git subcommand that is not a builtin (an alias from the git config) and defining an alias
  (`git config alias.*`). Of the queue's own CLI (`ravenseat …`, `node …/queue.mjs …`, `node …/ravenseat.mjs …`, the orchestrator's
  scripts) they run only an allow-list: `prepare-track`, `gates`, `show`, `info`, `help`, `blockers`, `finding`,
  `question`, `block`, `deliver`, `plan show|get` and, from a track's own branch without `--approved`, `add`; never `merge`, `set`, `edit`, `approve`, `resolve`, `undo` and
  the rest, and never `--allow-guard`, `--force*` or `--by owner`/`--by theBoard`. The ownership the merge guard
  checks (`owned_files`, `shared_patch`, `owner_db`, `migr_block`) is locked after the start like `done_when` and
  `acceptance`: only `--by owner` or the board changes it, and never from a track worktree.
- **Limits.** `maxTurns` is 400 for `track` and 600 for `track-d`, and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`
  (`env` in `settings.queue.json`, set by `setup --settings`) stops a track from starting agents of its own. A plugin's
  `hooks.json` cannot set environment variables, so this one lives in the project settings.

Test weakening: a track must not get green by weakening the checks either. The configs that can switch a check off
are protected paths (above); for the tests themselves, `receive` reads the branch diff against the merge base and
warns about deleted test files, test files moved out of the test paths and skip or focus markers (`.skip(`, `.only(`,
`xit(`, `@pytest.mark.skip`, `#[ignore]`, `t.Skip(`, `@Disabled` ...) on added lines in test files: one
`WARN test weakening:` line and a `Test weakening` section in `00-package.md`, never a stop. The reviewers decide
whether a skip is intended. `testWeakening.enabled: false` turns it off (`lib/testWeakening.js`).

A custom helper agent is itself text the owner may not have written. It is scanned, read in full and approved
against its sha256 before it can be on, and a changed file turns it off (see
[Custom helper agents](#custom-helper-agents)).

For a task that has to read content from outside, split reading and writing between two agents (the quarantine rule
in the mission template): the reader returns a fixed schema, and the writer never sees the raw text. This is a
recommended pattern for the mission author, not a control: nothing in the code enforces the split.

### Review to gate (`/ravenseat:review`)

`/ravenseat:review <area> [<lens>]` reviews a path, feature or project through a lens (security, logic, ux, architecture or
free text) with read-only `reviewer-area` agents, one per part of a large area. Each finding carries file:line, a
severity and a class: a one-off bug becomes a fix task, a repeatable mistake becomes a task labelled `gate` that adds a
check to the project's own CI (red first: shown failing on the original bug and passing on the fix), and a design
question becomes an owner question or a plan entry. Nothing is added before the owner answers one question, and the
review is recorded as a `PL-REVIEW-…` entry in the plan register with its counts and task ids.
