---
name: kickstart
description: Help the user get a small set of automatic checks for their project, one step at a time, in plain words. Shows what is there and what is missing, and proposes the next step as a task they approve. Use when the user asks about CI, tests, gates or "what checks do I have", or follows a hint about missing checks.
---

# Kickstart: a small set of checks, one step at a time

The user may never have used git, CI or Docker. The goal is that they understand what is missing and why, and add it when
it suits them. Never make them finish a setup. Explain each word the first time you use it.

1. Run `cq kickstart --json`. It works before `cq init` and without git. It reads files and changes nothing.
2. Tell the user, in at most eight lines:
   - what you found (the stack and the check commands, in one line);
   - what is in place and what is missing, in plain words;
   - the one next step, with its `why`.
3. Ask ONE question about that step, with "not now" as a choice. "Not now" is a fine answer: stop there. Do not bring up
   the later steps unless they ask.
4. Do only what the user said yes to:
   - **git:** run `git init`, add a `.gitignore` that fits the project, and make a first commit, showing what goes in first.
   - **gates with checks found:** run `cq kickstart gates` and show the lists. On yes, run `cq kickstart gates --apply`,
     then `cq gates --full` so they see whether the checks pass today. A red check is useful news, not a failure of theirs:
     offer to propose a fix task.
   - **a step with `task`:** run `cq kickstart add <key>`. Say that it is only a proposal, about how long it takes, that it
     uses tokens, and that they approve it with `cq approve <id>` or on the board.
5. If `facts.stacks` is empty, read the project yourself, and propose the check commands you find. Write them to
   `gates.quick` and `gates.full` in `queue.config.json` only after a yes.

Never push, never change settings on the git host, and never approve a task for the user unless they say so.
