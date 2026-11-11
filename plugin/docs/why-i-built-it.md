# Why I built it

The [README](../../README.md) has the short version. This is the longer one, with how I use it day to day.

## The problem

In a small project, working with Claude Code was easy. Most of the work showed up on a screen I could look at, and I
could keep the whole picture in my head. As the project grew, that stopped working:

- **Progress became invisible.** Days of backend work could pass without a single screen changing, so there was
  nothing to look at that told me where the project stood.
- **The work was scattered across chats.** Size and complexity meant 50 to 100 chat windows, each holding part of
  the picture. Half the findings of a security review could be forgotten in one of them.
- **Parallel chats collided.** With several chats open on different parts of the project, they edited the same files
  and pushed on top of each other. The result was push conflicts, merge conflicts and work overwritten by a chat that
  did not know another one had the file open.
- **Features were left half-built.** I lost track of features halfway through the implementation, because nothing
  held on to what was started and what was left.
- **The workaround burned tokens.** Running everything in one long chat kept the overview, but every turn carried the
  whole history, and the token use grew far faster than the work did.

## The answer

To get an overview back and work systematically, I built the queue step by step inside that project: a plan register
for what is not ready yet, a work queue with dependencies and a focus, a board that shows it all, and an orchestrator
that hands each task to a fresh agent with a small context. Each agent works in its own git worktree and branch, a
task owns its files exclusively while it runs, and one orchestrator merges, one merge at a time, so parallel work no
longer collides. Nothing is pushed until I say "push". The parts that are not tied to one project were then extracted into this plugin. What stayed behind is what
has to be project specific: the CI/CD pipeline and the domain-specific checks ([not included](guide.md#not-included)).

## What it gives me now

I wanted a project that keeps moving without me sitting at it. With the queue, Claude Code runs a large project on
its own for long stretches, often overnight or for days. It picks the next task, starts agents, reviews and merges
what they deliver, and starts the next tasks. When a task needs my decision, the queue does not stop: it parks that
task and carries on with everything else that can be done. The decisions wait for me on the board, or the
orchestrator lists them in the chat, each with context and a recommendation.

Most of the time I work from my phone. Remote Control connects me to the orchestrator chat in Claude Code, so I only
deal with a single chat. The work itself happens in fresh, small contexts for each task. The orchestrator keeps its
state in the queue and in a handover note, and the chat is compacted automatically at 300k tokens of context, so it
can keep going for days. From the phone I ask what is next, what is blocked or what a plan contains, and I answer the
open questions. The tasks that waited on them then move on.

On the desktop I use the board to keep track of the project. I go through the open questions, manage the
dependencies between tasks, and choose the focus. With focus, I pick which areas of the project to work on now. The
queue finishes those before it moves on to the next feature or step I want. The queue also helps Claude Code keep
order: it keeps track of the plans, the tasks, what depends on what and what is running right now, so nothing gets
lost between sessions.

Splitting the work into right-sized tasks, each in a fresh small context, cut my usage a lot compared with the long
chat. On a Claude Max (20x) plan, the queue now keeps running for about five days of a week before the weekly limit
runs out. That is one project and one developer; see [what it costs in tokens](costs.md) for what was measured and
what was not.
