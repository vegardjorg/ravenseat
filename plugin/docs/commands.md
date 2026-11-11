# Commands

All scripts share one entry point, `ravenseat`. With the plugin, `ravenseat` is on the PATH of Claude Code's Bash tool. In a
vendored install, write `node scripts/orchestrator/ravenseat.mjs` instead of `ravenseat` (the installer already does this in the
files it copies). You rarely need to type these: asking Claude in plain words runs the same commands.

```
ravenseat init --full               # once per project (a bare `ravenseat init` starts in lite mode)
ravenseat mode [lite|full]          # show or switch the mode
ravenseat show                      # short queue view
ravenseat add --file task.json      # add tasks
ravenseat fill --scratchpad <dir>   # start what the limits allow
ravenseat receive <ID>              # receive a finished track
ravenseat merge <ID>                # merge it
ravenseat cost                      # USD per merged change, cost per task (all runs), then per class
ravenseat calibrate                 # how far minute and cost estimates are off, per class
ravenseat decide                    # everything waiting on you, most impact first (/ravenseat:decide walks it)
ravenseat proposals                 # the proposals waiting, and the auto-accept rules
ravenseat approve <ID>              # lets a proposal start (`ravenseat set <ID> cancelled` declines it)
ravenseat conflicts                 # predicted merge conflicts between running tracks and the base
ravenseat ask <ID> "<question>"     # ask about an earlier track without resuming it (/ravenseat:ask)
ravenseat checks                    # what the project has for checking its code (read from files, nothing runs) and suggestions
ravenseat checks show <key>         # what a suggestion's investigation and plan cover
ravenseat checks plan <key>         # proposes its investigation and planning as a task (--approved: ready to run)
ravenseat checks dismiss <key>      # sets a suggestion aside (restore brings it back)
ravenseat checks off                # no Checks tab, overview or setup suggestions (on turns them back); guards are not touched
ravenseat kickstart                 # which checks the project has and one next step, in plain words; changes nothing
ravenseat kickstart gates --apply   # sets the checks your project already has as gates
ravenseat kickstart add             # proposes the next step as a task; it starts only when you approve it
ravenseat gate "<failure class>"    # a known bug becomes a proposed gate task; gates.fromKnownBugs: propose, auto or off
ravenseat doctor [--all]            # read-only health check: node, hooks, config, state, worktrees, safety baseline (--all adds CI cost tips)
ravenseat machine [--measure]       # cores, memory, free memory and a suggested maxConcurrent (an estimate); --measure times one full check when no track runs
ravenseat surface                   # git hooks and config that run code, against what was accepted; changes nothing
ravenseat surface accept --by owner # accept the current state (after installing a hook tool, changing git config)
ravenseat unlock                    # who holds the queue lock; changes nothing (--force --by owner releases it)
ravenseat attempt list <ID>         # the task's attempts; `ravenseat attempt close <ID> --outcome <...>` closes a stuck one
ravenseat guidance [guided|quiet]   # one switch for advice about CI, gates and lockfiles; never a guard
ravenseat helpers                   # helper agents: on/off and what they cost
ravenseat helpers add <file.md>     # a custom helper: copied, scanned, off until approved
ravenseat plan show                 # plan register
ravenseat finding "<title>"         # a track notes something outside its scope (an idea, not a fix)
ravenseat board                     # the board: prints a local link with a key
ravenseat board-setting             # the board's own switches; `cloud on|off` (the Cloud tab), `blocked on|off` (the Blocked column, off by default)
ravenseat follow                    # follow-up entries
ravenseat handover now              # the "Now" part of the handover note
ravenseat help                      # all commands
ravenseat --version                 # the plugin's version
```

Skills: `/ravenseat:queue`, `/ravenseat:decide`, `/ravenseat:board`, `/ravenseat:setup`, `/ravenseat:add-to-queue`, `/ravenseat:plans`, `/ravenseat:pick`,
`/ravenseat:review`, `/ravenseat:ask`, `/ravenseat:parallel-wave` and `/ravenseat:start` ([daily use](guide.md#daily-use)).

Every change the board makes to the queue has a command: see [CLI parity](cli-parity.md). The full command and
configuration reference is in the [queue reference](queue.md).
