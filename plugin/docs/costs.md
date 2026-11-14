# What it costs in tokens

Every turn in Claude Code sends the whole conversation again (most of it from the prompt cache, which is cheaper but
not free). So a turn costs more the larger the context is, and a session costs roughly **number of turns times
context size**. The system is built around that fact: many short contexts instead of one long one.

**Read these numbers with care.** They come from one large project (mine), one developer and a few months of use. They
are not a benchmark. There is one comparison with a plain chat (below), in two different projects, and it is not
controlled. Most gains below are before and
after comparisons in that project; several changes went in on the same days, so the effect of each one alone is not
known.
- The cost per task is **measured**: the subagent logs record the tokens, and the dollar amounts are what those
  tokens would cost at API prices. On a subscription you pay a flat fee; the amounts only show relative use.
- **How it is measured:** the usage of each agent is read from its transcript, counted once per message id, and tied
  to a task through the track label (a reviewer counts when its mission names the task id). Tokens are priced at the
  Opus list price per million: input 4 USD, output 20, cache read 0.20, cache write 5 (5-minute cache) or 8 (1-hour
  cache); a row without that split is priced as the 5-minute cache. When the task is set done, the queue stores its
  USD, tokens, turns, agents and the split into build, review and fix round.
- The comparison with one plain chat is **measured** over 19 days, with the last week as the headline; the comparison with
  "many small chats" is **my estimate from experience**.
- Your numbers depend on your codebase, your tasks, your checks and the model, and will differ.

## Measured: the queue against one plain chat

**In short:** a queue turn costs no more than a turn in one chat. The checks come on top, about a third of what the
queue spent, and they are what keeps bugs and security holes from being merged. How much of that you pay is your
choice: lighter gates and fewer reviewers cost less and catch less.

Two repos, same developer, same model and settings (automatic compaction at about 270k, 1-hour subagent cache). One is
a large repo run with the queue, which ran on its own with a heavy test suite and a reviewer on almost every task. The
other is this repo, built from a plain roadmap file in one long main session without a queue, which I followed
closely. That session started many agents of its own, so this compares steering, not parallel work against no parallel
work. Prices are the list prices above (API-equivalent).

### The last week, the fairest comparison

10 to 14 November (4.6 days), both repos busy every day. The earlier weeks are shown below but left out of the
headline: this repo was young and small then, and much of its work was splitting and moving large files, which gives
many cheap commits and lines.

| | One plain chat | With the queue |
|---|---|---|
| Cost (USD) | 362 | 1,360 |
| Commits (no merges) | 76 | 409 |
| Cost per turn | 0.068 | 0.059 |
| Cost per commit | 4.76 | 3.33 |
| Cost per 1,000 inserted lines | 11.9 | 11.7 |
| Reading (Read, Grep, Glob, shell reads) | 46 % | 27 % |
| Tests and other runs | 6 % | 16 % |
| Review | a few assessment agents (share not split out by week) | 14 % |

In that week the queue was cheaper per turn and per commit, its checks included, and equal per line. Leave its checks
out and a commit cost about 2.3 USD (an estimate). The week is short (76 commits in this repo), so treat the size of
the gap with care.

### Week by week, and the whole period

| Week | Per commit, plain chat | Per commit, queue | Per 1,000 lines, plain chat | Per 1,000 lines, queue | Per turn, plain chat | Per turn, queue |
|---|---|---|---|---|---|---|
| 1 (10-27 to 11-02) | 2.43 * | 3.37 | 5.5 * | 9.8 | 0.069 | 0.047 |
| 2 (11-03 to 11-09) | 2.59 | 3.74 | 9.7 | 14.7 | 0.106 | 0.085 |
| 3 (11-10 to 11-14) | 4.76 | 3.33 | 11.9 | 11.7 | 0.068 | 0.059 |
| All 19 days | 2.95 * | 3.50 | 7.9 * | 11.9 | 0.077 | 0.061 |

\* Without the first 11 commits (the import of the code and a full translation, 145k lines together), made before the
measured sessions.

Over all 19 days the plain chat was about 15 % cheaper per commit and about a third cheaper per line, and the gap comes
from weeks 1 and 2. The queue was cheaper per turn in every week. Cost per turn rose in both repos in week 2, so
something in the environment changed (cause not checked). Both repos were nearly idle on 9 November; per-day averages
over the whole period would count such days, so none are given here.

Over all 19 days, tests and review were about 33 % of the queue's spend against about 12 % in the plain chat (counting
its assessment agents as review). Steering was about the same size: 10 % against 15 % (14 % against 20 % with text
turns). In the queue it is a manager chat that builds nothing; in the plain chat it is spread through the chat that
builds, and through the owner following it. The plain chat spent more on reading in every week (39 to 46 % against
25 to 29 %); part of that gap is the queue's share diluted by its checks, so fixed missions that name the files are a
possible reason, not a measured one.

Limits: two different repos and kinds of work (this repo is a tool with a light test suite), one developer, not a
controlled benchmark. Commits come from `git log --no-merges --shortstat` and include generated files and tests; about
38 commits in this repo were made outside the sessions (README edits on the web), which makes its cost per commit look
lower. Separate test folders for this repo (121 USD over 19 days) are left out.

## Measured: median cost per finished task, subagents only

Tasks by done date 2026-10-06 to 2026-10-27, about 1,200 in all. A task's cost is its own subagents: the track and its
reviewers. The orchestrator is not in it (see below). K tasks were almost never reviewed (about 35 of 639 in the
project, against about 800 of 873 D tasks), so the K median is close to build cost alone.

| Class | n | Median USD (API-equivalent) | Average USD | Median tokens (mostly cache reads) | Median turns |
|---|---|---|---|---|---|
| K (code) | 420 | about 2.5 | about 3.1 | about 10M | about 60 |
| D (database) | 602 | about 5.2 | about 5.7 | about 25M | about 105 |
| D+ (high-risk) | 120 | about 7.4 | about 8.8 | about 36M | about 137 |
| U (investigation) | 67 | about 1.7 | about 2.1 | about 6.5M | about 42 |

**Orchestrator on top:** in the 14 days from 2026-10-28 the orchestrator cost about 840 USD over 12,168 turns for
about 530 finished tasks: about 1.6 USD and 23 turns per finished task, night pulses and dialogue with the developer
included.

Cost per task drifts. By the same done date, the D median went from about 5.2 USD to 6.9 (2026-10-28 to 11-03, n 139)
and 11.9 (2026-11-04 to 11-11, n 131); in that last window K was about 3.8 (n 57), D+ 11.7 (n 24) and U 1.7 (n 7),
with the same estimates. A later look by start date found two causes, and the build agent itself cost about the same
(about 6.6 USD per D task). From 2026-11-02 to 11-07 thinking per turn was two to five times higher for every agent type,
the orchestrator included, with the same model, effort and prompts, and it fell back mid version: most likely a change on
the model side, now over. From 2026-11-08 more agents ran per task: a reviewer picked for nearly every D task instead of
one in six, reviews of fixes, and fix rounds on about a third of D tasks. So a rise in cost per task can come from outside
the project or from how many reviewers run, not only from the work. Read a class median as a snapshot, and run `ravenseat cost` for your own numbers and trend. `ravenseat cost` leads with USD per merged
change: all measured cost in a window divided by the tasks merged in it, fix tasks counted with the change they fix.
That figure came later and has no number from these windows. The classes are explained in
[full mode](full-mode.md#agents-skip-security-and-edge-cases).

## Reading a change in cost

The drift above was found only afterwards. `ravenseat cost` and `set <id> done` now show the numbers that tell the
causes apart while it happens. They are measurements only: none of them stops the queue or a track.

- **Per turn.** Each agent's measurement stores its turns, output per turn, thinking per turn (from
  `output_tokens_details.thinking_tokens` in the transcript) and the Claude Code version it ran on. A transcript without
  the thinking field gives "unknown", never 0, so older measurements do not pull a median down.
- **The 2x warning.** `set <id> done` prints a `WARN` line when an agent's output or thinking per turn is over twice the
  median of its agent type over the last 14 days, once at least 5 agents of that type are in that baseline. `ravenseat
  cost` has a "Per turn" block: per agent type the last 24 hours against the 14 days before, with n, the same warning
  and the Claude Code versions seen. The same jump for several agent types at once points outside the work: the model
  or the client.
- **Build, review and fix round.** The measurement splits the task's cost (`cost.phases`, and `phase` per agent):
  - a reviewer is review;
  - an agent labelled `<id>-r<N>` is a fix round. `ravenseat resume` makes every round, and the track itself is always
    the bare `<id>`, so `-r1` is the first fix round. The exception is a round the task records as a `context`
    continuation (a full context, an adopted track): that is still build;
  - the bare track agent is build, except what it used after the task's first receive when it had already stopped
    before it: that is the same agent sent back with SendMessage to fix the review's findings, and it counts as fix.
    The number of fix rounds counts each round the task records with `mode: "continue"` (`ravenseat resume` continued
    the agent), so two continued rounds count as two; with no such record the growth counts as one round.

  Why this rule: a fix round is work the review caused. Counted inside build, a week with more fix rounds looked like
  harder work. The receive is the line because nothing before it can be a fix of a review finding.
- **By start date.** The per-class figures group tasks by when they started, not when they finished. A week that
  drained a backlog no longer looks expensive, and a change from outside (on given days) lands on the days it happened.
- **Where the cost went.** Merged, cancelled and open tasks, the orchestrator session as its own line, and the
  "unknown" share split by why: no task id in the mission (a helper, Explore or general-purpose agent), a label that is
  no queue task, or no agent type. Then week over week: subagent spend by usage time, the orchestrator, and the tasks
  started each week with n and their median cost.

### Turns and tools

`ravenseat cost` (and `--json`, field `turnsAndTools`) has a "Turns and tools" block that says how the turns were
spent, so a change to how agents wait, read or hand over can be measured before and after. It reads the transcripts
of the cost window itself (the main session files and `subagents/agent-<id>.jsonl` under the project's Claude Code
transcripts folder), with the same transcript reader as the time log hook (`lib/timeCost.js`, `lib/turnTools.js`). The
groups are the orchestrator session (a main session the status line marks as the orchestrator), other main sessions,
and each subagent type (from the time log, or the transcript's `.meta.json`). A turn is one model response (one
message id); only turns with a timestamp in the window count.

- **Calls per turn.** The tool calls in each turn: median and p90 over all turns (a closing text turn counts as 0),
  and "parallel" = the share of turns with a call that make more than one.
- **Serial single reads.** A read turn makes only read calls: Read, Grep, Glob, LS, NotebookRead, or a Bash command
  whose every part only reads (cat, head, tail, grep, rg, ls, wc, `sed -n` without `-i`, `find` without `-delete` or
  `-exec`, `git log/show/diff/status`, ...; no output redirection). A run is consecutive turns that each make exactly
  one read call; runs of 3 or more are counted, with their turns as a share of all read turns. A high share means
  reads that could have gone in one turn.
- **Output per tool.** The characters of each tool result's text, per tool: count, total and median, top 5 by total.
  Characters, not tokens: about 4 characters make a token, which is only an approximation. Images add nothing.
- **Above and below the context threshold.** Each turn's context (input plus cache read plus cache write) against
  `cost.contextThresholdK` thousand tokens (default 200, Advanced). The share of cost from turns above it. The cost of
  a turn is its own usage at its model's list price.
- **After notifications.** Turns whose last real prompt was a background task notification (Claude Code marks it as
  `task-notification`; older transcripts are matched on `<task-notification>` or "Background command ... completed"),
  the number of notifications and the turns' share of cost: what waking up after a background wait cost. A system
  reminder is no prompt.
- **Worked in another repo.** A main session whose tool calls mostly point outside the project is listed on its own
  line with its cost (from the status line, otherwise from the transcript) and left out of the groups and of the
  orchestration figures above it. The rule is conservative on purpose: only calls with a path count (a tool's
  `file_path` or `path`, and absolute paths in a shell command; a relative path in a file tool counts as inside, a shell
  command without an absolute path not at all); paths under the main tree or a git worktree are inside, temp folders
  and the Claude config folder are neutral; and it takes at least 10 such calls, at least 60 % of them outside, and one
  other folder (at the project root's depth) holding at least half of those. The session's subagents stay where the
  time log put them.

Limits: reading the transcripts takes time on a large project (about 1 GB took several minutes), so at most 256 MB is
read per run (the newest first);
the block says how many files were read and how many were skipped. A transcript larger than 300 MB is skipped, as the
time log hook does. Transcripts that Claude Code has already deleted (its cleanup period) are not there to read. The
read classification and the other-repo rule are heuristics: a script that writes, run through `cat`, is not seen, and
a session that changed directory with `cd` and then used relative paths does not count as elsewhere. Measurement
only: nothing in the block stops the queue.

## Measured: compacting the orchestrator against starting a new chat

The orchestrator runs in one chat, and Claude Code compacts it automatically (`autoCompactWindow`, set to 300,000).
In 10 orchestrator sessions with about 6,000 turns (late September to early October):
- **Cost:** compacting cost about the same as starting a new chat by hand and reading the handover note in again. The
  compacted chat then carries a little more context (about 16k tokens) for the rest of the cycle.
- **Back to work:** after a compaction, the first agent started after about 6 turns, against about 17 in a new chat.
- **When:** compaction started at about 268k tokens of context (the median of 122 compactions in the 14 days from
  2026-10-28), not at 300k.
- **Limit:** the compaction call itself is not in the transcript, so its cost is an estimate. It assumes the call reads
  from the prompt cache; if it misses the cache, compacting costs clearly more than a new chat.

## Measured: where tokens were wasted, and what the plugin does about it

These shares are from the first measured days (late September), before the changes below, with ten tracks in
parallel and a 5-minute subagent cache. The changes went in together, so how much each one saved is not measured.

- Turns taken while a track's context was above about 300k tokens were about 61% of track cost. So a track stops at
  about 300k: it commits, writes a handover note, and a fresh agent continues. A track may compact once; at the second
  compaction it delivers PARTIAL. A SubagentStop gate (`hook-track-end.mjs`) sends a track back once if it stops with
  neither a commit nor a RESULT line.
- The orchestrator's handover note grew to thousands of lines that every takeover read in full. So it has a short
  "Now" part and a dated log; `ravenseat handover archive` moves old log entries to a monthly archive, and only "Now" is read
  after compaction and at takeover. A status line (`ravenseat setup --settings`) shows context, cost, quota and running
  tracks while you work.
- Prompt cache expiry while waiting was about 23% of all usage. So there are no sleep or polling loops, and
  subagents use a 1-hour cache.
- A fix round continues the agent that delivered while its prompt cache is warm (within an hour), so it reads the fix
  list on a cached context. Otherwise a new agent gets a short mission (the fix list and a pointer to the original
  mission), so a fix does not pay for the whole build context again. The review after it reads only the new commits.
  These are design choices; what they save is not measured yet.
- Fixed overhead per track (setup, reading, checks, report) was about 60% of a small K task and 30 to 40% of a D or
  D+ task. So task sizes are set per class, and small tasks are bundled.

## Measured: your own long sessions

In one large project, from August to early October, the long main sessions (the developer's own and the
orchestrator's) were about 66% of all usage, about twice as much as all the agents together. A turn at over 500k
context cost about 2.7 times a turn at 100k to 200k. Resuming a long session after more than an hour away wrote the
whole context to the cache again, about 15% of those sessions' cost; in the orchestrator from 2026-10-28 to 11-11 it
was 2.9%. Start a new session with a short handover note well before the context is full, and do not pick up a long
session after a long break.

## Claude's instructions

Claude Code loads `CLAUDE.md`, `CLAUDE.local.md`, the files they import with `@`, the `.claude/rules/` files without
`paths:` and your own `~/.claude/CLAUDE.md` at the start of every session, and every track and subagent loads them again.
So each character there is paid on every turn of every agent, and a long file is followed less well than a short one.
An `@` import saves nothing: the imported file loads with the one that names it.

- `ravenseat doctor` has an `instructions` row: the size in tokens and characters, with the share of the project, your
  `~/.claude`, Ravenseat (`CLAUDE.queue.md`) and the organization. It warns when a file is over 200 lines (the target in
  the Claude Code docs) or the total is over 40,000 characters, where Claude Code itself warns. Quiet guidance hides it.
- An `instructions-cut` row says when a file that loads on demand (a rule with `paths:`, a `CLAUDE.md` in a subfolder) is
  over 40,000 characters: Claude sees only the start of it. That is a fact, so quiet does not hide it.
- The first time the total passes the limit you get one message in the chat, and again only when it has grown by more
  than a tenth. It goes to you, not into Claude's context.
- The Checks tab has a suggestion in "Claude's instructions" with a text to give Claude in your own session.
- `ravenseat instructions` shows what loads, where each section could go (a `.claude/rules/<topic>.md` with `paths:` for
  one area, a skill for a procedure, nothing for what Claude reads from the code) and the lines that stand in two files.
  `--plan` writes that as a plan in the queue's data folder. It changes none of your files: the split is yours to make.
- A rule with `paths:` loads when Claude reads, edits or writes a matching file, a new file too, in the main session and
  in tracks (tested on Claude Code 2.1.319), so an area rule is not missed when a track creates the first file there.
- The `ask` helper starts without `CLAUDE.md` (`omitClaudeMd: true`): it answers from the bundle about an earlier track
  and needs none of your rules. Tracks, reviewers, triage and `researcher` always load them.

`instructionSize.mode` (`warn` or `off`), `instructionSize.maxLines` and `instructionSize.maxChars` are under Advanced in
`ravenseat settings`. Off removes both doctor rows, the chat message and the suggestion. It is no weakening: this is advice about cost, not a
guard, and nothing else depends on it.

## Estimated, not measured: the alternatives

- *One long chat.* With Claude Code's default it grows toward its full window before it compacts, and each turn pays
  for the whole history: a turn at over 500k cost about 2.7 times a turn at 100k to 200k, and quality dropped as the
  context filled (not measured). With compaction at about 300k a turn costs no more than a queue turn (measured
  above); what it still costs is your presence, since the work moves only while you are in the chat.
- *Many small chats by hand.* The context stays small, but every chat pays the start-up cost again (reading the
  project, finding files, running checks), and you do the coordination yourself: no shared queue, no file ownership,
  no review step, and merge conflicts when chats overlap.

Run `ravenseat cost` in your own project to see where your tokens go.
