# What it costs in tokens

Every turn in Claude Code sends the whole conversation again (most of it from the prompt cache, which is cheaper but
not free). So a turn costs more the larger the context is, and a session costs roughly **number of turns times
context size**. The system is built around that fact: many short contexts instead of one long one.

**Read these numbers with care.** They come from one project (mine), one developer and a few months of use, about
1,200 measured tasks. They are not a benchmark, and there is no controlled comparison with other ways of working.
- The cost per task is **measured**: the subagent logs record the tokens, and the dollar amounts are what those
  tokens would cost at API prices. On a subscription you pay a flat fee; the amounts only show relative use.
- The comparison with "one long chat" and "many small chats" below is **my estimate from experience**, not a
  measurement.
- Your numbers depend on your codebase, your tasks, your checks and the model, and will differ.

## Measured: median cost per finished task, including its review

| Class | Median USD (API-equivalent) | Average USD | Median tokens (mostly cache reads) | Median turns |
|---|---|---|---|---|
| K (code) | about 2.5 | about 3.1 | about 10M | about 60 |
| D (database) | about 5.1 | about 5.7 | about 25M | about 105 |
| D+ (high-risk) | about 7.5 | about 8.8 | about 36M | about 137 |
| U (investigation) | about 1.8 | about 2.1 | about 6.5M | about 42 |

The orchestrator added about 18 turns and about 0.75 USD per task. Its target is now 10 turns or fewer per task.
The classes are explained in [full mode](full-mode.md#agents-skip-security-and-edge-cases).

## Measured: compacting the orchestrator against starting a new chat

The orchestrator runs in one chat, and Claude Code compacts it automatically (`autoCompactWindow`, set to 300,000).
In 10 orchestrator sessions with about 6,000 turns (measured 2026-11-08):
- **Cost:** compacting cost about the same as starting a new chat by hand and reading the handover note in again. The
  compacted chat then carries a little more context (about 16k tokens) for the rest of the cycle.
- **Back to work:** after a compaction, the first agent started after about 6 turns, against about 17 in a new chat.
- **When:** compaction started at about 268k tokens of context (the median of 294 compactions), not at 300k.
- **Limit:** the compaction call itself is not in the transcript, so its cost is an estimate. It assumes the call reads
  from the prompt cache; if it misses the cache, compacting costs clearly more than a new chat.

## Measured: where tokens were wasted, and what the plugin does about it

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
- Fix rounds sent to an agent that already held 400k to 900k tokens of context were 35 to 38% of track cost. So fix
  rounds always start a new agent with a short mission.
- Fixed overhead per track (setup, reading, checks, report) was about 60% of a small K task and 30 to 40% of a D or
  D+ task. So task sizes are set per class, and small tasks are bundled.

## Estimated, not measured: the alternatives

- *One long chat.* Each new message pays for the whole history again. In my project, a message at over 500k
  context cost close to three times as much as the same message at 100k to 200k, and quality dropped as the context
  filled. I expect this to cost several times more per task than the queue, more the longer the session runs.
- *Many small chats by hand.* The context stays small, but every chat pays the start-up cost again (reading the
  project, finding files, running checks), and you do the coordination yourself: no shared queue, no file ownership,
  no review step, and merge conflicts when chats overlap.

Run `ravenseat cost` in your own project to see where your tokens go.
