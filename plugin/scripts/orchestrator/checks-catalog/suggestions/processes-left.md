---
title: A process Ravenseat started is left over
category: machine
priority: medium
when: processes-left
content_min: 5
action: ask
why: Ravenseat registers every gate command, done command, base gate and wait run it starts, and removes the entry when the run ends. This one still runs although the process that started it is gone, or it has run past its time budget. It holds memory, CPU and maybe files in a worktree, and nothing will end it. The card names the pid, who it belongs to, how long it has run and the command that ends it and everything it started. Nothing is stopped by itself unless processGuard.autoKill is on.
---

## Ask Claude

Ravenseat's process guard says a process it started is left over (the card names the pid, the track or command it belongs to, its age and the stop command). Run `ravenseat doctor` and show me its `processes` row. For each pid, tell me what it is (the command line, read only) and whether the track it belongs to is still running (`ravenseat show <id>`). If it is a leftover, ask me before you run the stop command from the card; never stop a process the row does not name.
