# Commands

All scripts share one entry point, `cq`. With the plugin, `cq` is on the PATH of Claude Code's Bash tool. In a
vendored install, write `node scripts/orchestrator/cq.mjs` instead of `cq` (the installer already does this in the
files it copies). You rarely need to type these: asking Claude in plain words runs the same commands.

```
cq init --full               # once per project (a bare `cq init` starts in lite mode)
cq mode [lite|full]          # show or switch the mode
cq show                      # short queue view
cq add --file task.json      # add tasks
cq fill --scratchpad <dir>   # start what the limits allow
cq receive <ID>              # receive a finished track
cq merge <ID>                # merge it
cq cost                      # USD per merged change, cost per task (all runs), then per class
cq calibrate                 # how far minute and cost estimates are off, per class
cq decide                    # everything waiting on you, most impact first (/cq:decide walks it)
cq conflicts                 # predicted merge conflicts between running tracks and the base
cq ask <ID> "<question>"     # ask about an earlier track without resuming it (/cq:ask)
cq kickstart                 # which checks the project has and one next step, in plain words; changes nothing
cq kickstart gates --apply   # sets the checks your project already has as gates
cq kickstart add             # proposes the next step as a task; it starts only when you approve it
cq gate "<failure class>"    # a known bug becomes a proposed gate task; gates.fromKnownBugs: propose, auto or off
cq doctor                    # read-only health check: node, hooks, config, state, worktrees, safety baseline
cq surface                   # git hooks and config that run code, against what was accepted; changes nothing
cq surface accept --by owner # accept the current state (after installing a hook tool, changing git config)
cq unlock                    # who holds the queue lock; changes nothing (--force --by owner releases it)
cq attempt list <ID>         # the task's attempts; `cq attempt close <ID> --outcome <...>` closes a stuck one
cq guidance [guided|quiet]   # one switch for advice about CI, gates and lockfiles; never a guard
cq helpers                   # helper agents: on/off and what they cost
cq helpers add <file.md>     # a custom helper: copied, scanned, off until approved
cq plan show                 # plan register
cq finding "<title>"         # a track notes something outside its scope (an idea, not a fix)
cq board                     # the board: prints a local link with a key
cq follow                    # follow-up entries
cq handover now              # the "Now" part of the handover note
cq help                      # all commands
```

Skills: `/cq:queue`, `/cq:decide`, `/cq:board`, `/cq:setup`, `/cq:add-to-queue`, `/cq:plans`, `/cq:pick`,
`/cq:review`, `/cq:ask`, `/cq:parallel-wave` and `/cq:start` ([daily use](guide.md#daily-use)).

Every change the board makes to the queue has a command: see [CLI parity](cli-parity.md). The full command and
configuration reference is in the [queue reference](queue.md).
