# What it costs in tokens

Every turn in Claude Code sends the whole conversation again (most of it from the prompt cache, which is cheaper but
not free). So a turn costs more the larger the context is, and a session costs roughly **number of turns times
context size**. The system is built around that fact: many short contexts instead of one long one.

**Read these numbers with care.** They come from one large project (mine), one developer and a few months of use. They
are not a benchmark, and there is no controlled comparison with other ways of working. Most gains below are before and
after comparisons in that project; several changes went in on the same days, so the effect of each one alone is not
known.
- The cost per task is **measured**: the subagent logs record the tokens, and the dollar amounts are what those
  tokens would cost at API prices. On a subscription you pay a flat fee; the amounts only show relative use.
- **How it is measured:** the usage of each agent is read from its transcript, counted once per message id, and tied
  to a task through the track label (a reviewer counts when its mission names the task id). Tokens are priced at the
  Opus list price per million: input 4 USD, output 20, cache read 0.20, cache write 5 (5-minute cache) or 8 (1-hour
  cache); a row without that split is priced as the 5-minute cache. When the task is set done, the queue stores its
  USD, tokens, turns, agents and the split into build, review and fix round.
- The comparison with "one long chat" and "many small chats" below is **my estimate from experience**, not a
  measurement.
- Your numbers depend on your codebase, your tasks, your checks and the model, and will differ.

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
    before it: that is the same agent sent back with SendMessage to fix the review's findings, and it counts as one fix
    round.

  Why this rule: a fix round is work the review caused. Counted inside build, a week with more fix rounds looked like
  harder work. The receive is the line because nothing before it can be a fix of a review finding.
- **By start date.** The per-class figures group tasks by when they started, not when they finished. A week that
  drained a backlog no longer looks expensive, and a change from outside (on given days) lands on the days it happened.
- **Where the cost went.** Merged, cancelled and open tasks, the orchestrator session as its own line, and the
  "unknown" share split by why: no task id in the mission (a helper, Explore or general-purpose agent), a label that is
  no queue task, or no agent type. Then week over week: subagent spend by usage time, the orchestrator, and the tasks
  started each week with n and their median cost.

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
- Fix rounds start a new agent with a short mission, so a fix does not pay for the whole build context again. This is
  a design choice; what it saves is not measured.
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
  and needs none of your rules. Tracks, reviewers and triage always load them.

`instructionSize.mode` (`warn` or `off`), `instructionSize.maxLines` and `instructionSize.maxChars` are under Advanced in
`ravenseat settings`. Off removes both doctor rows, the chat message and the suggestion. It is no weakening: this is advice about cost, not a
guard, and nothing else depends on it.

## Estimated, not measured: the alternatives

- *One long chat.* Each new message pays for the whole history again. The per-turn price above is measured; the cost
  per finished task against the queue is not. I expect it to cost several times more per task, more the longer the
  session runs, and quality dropped as the context filled.
- *Many small chats by hand.* The context stays small, but every chat pays the start-up cost again (reading the
  project, finding files, running checks), and you do the coordination yourself: no shared queue, no file ownership,
  no review step, and merge conflicts when chats overlap.

Run `ravenseat cost` in your own project to see where your tokens go.
