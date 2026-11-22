# Commands

All scripts share one entry point, `ravenseat`. With the plugin, `ravenseat` is on the PATH of Claude Code's Bash tool. In a
vendored install, write `node scripts/orchestrator/ravenseat.mjs` instead of `ravenseat` (the installer already does this in the
files it copies). You rarely need to type these: asking Claude in plain words runs the same commands.

```
ravenseat init --full               # once per project (a bare `ravenseat init` starts in lite mode)
ravenseat mode [lite|full]          # show or switch the mode
ravenseat settings [--advanced] [--all] [--changed] [--json]  # every setting by category, its value and where it is saved
ravenseat settings set <key> <value> # change one; a value that weakens a guard needs --i-understand --by owner
ravenseat show                      # short queue view (with one "ravenseat X is out" line at most once a day when a newer version is known)
ravenseat update [dismiss [<ver>]]  # what is known about new versions; dismiss hides the notice for that version in show, doctor and on the board
ravenseat add --file task.json      # add tasks
ravenseat fill --scratchpad <dir>   # start what the limits allow
ravenseat receive <ID>              # receive a finished track (with secretScan.atReceive on, also scans its commits for secrets: a hit blocks the merge)
ravenseat merge <ID>                # merge it (--allow-secret: past a secret found at receive, owner only, logged)
ravenseat merge <ID> --allow-no-test  # past the strict stop on a fix without a proven red test (gates.redOnBaseStrict), owner only, logged
ravenseat wiring <ID>               # a task's wiring items; each is carried out (--commit) or rejected before done
ravenseat review-item <ID>          # a task's review findings as items; each is fixed, placed or rejected before done
ravenseat review-item <ID> --defer-all-L   # every open LOW that may wait into one review-rest batch task
ravenseat explain <ID>              # why one task stands where it stands, from the rules the queue starts by
ravenseat pulse-check               # the pulse in one read-only call: SILENT, or the actions with their next commands
ravenseat wait                      # waits in the background at no token cost until something needs the orchestrator
ravenseat cost                      # USD per merged change, cost per task (all runs), then per class
ravenseat cost --reads              # the files tracks most often read whole: candidates for a catalog excerpt or a split
ravenseat calibrate                 # how far minute and cost estimates are off, per class
ravenseat schedule [--json]         # the queue played forward: per focus step the expected end, the next tasks (rough); read only
ravenseat decide                    # everything waiting on you, most impact first (/ravenseat:decide walks it; the board's Decisions room is the same list)
ravenseat since [--window last-seen|24h|7d] [--json] [--mark]   # what happened while you were away: Done, Stuck, Waiting on you, Spend and the latest events (the board's "Since you left"); --mark moves the seen mark to now
ravenseat proposals                 # the proposals waiting, and the auto-accept rules
ravenseat approve <ID>              # lets a proposal start (`ravenseat set <ID> cancelled` declines it)
ravenseat conflicts                 # predicted merge conflicts between running tracks and the base
ravenseat ask <ID> "<question>"     # ask about an earlier track without resuming it (/ravenseat:ask)
ravenseat checks [--json]           # what the project has for checking its code (read from files, nothing runs) and suggestions (docs/checks.md)
ravenseat checks show <key>         # what a suggestion's investigation and plan cover
ravenseat checks plan <key>         # proposes its investigation and planning as a task (--approved: ready to run)
ravenseat checks dismiss <key>      # sets a suggestion aside (restore brings it back)
ravenseat checks packs [--apply]    # review signal packs for your stack, from the manifests; --apply writes review.packs
ravenseat checks turn-on <key>      # a card for an opt-in check that is off: writes its setting on in queue.config.json
ravenseat checks build-gate <class>@<area>  # Build as gate: one proposed gate task for a class the finding log keeps seeing
ravenseat checks quick-add <G-n>             # Add to gates.quick: that gate guard's command at the end of gates.quick (never removes one, never runs it)
ravenseat checks recipe <id> show|damp|auto  # your choice for one recipe: offered, kept off the card, or by its precision
ravenseat checks marker on|off      # the red dot on the Checks tab while an important suggestion is open
ravenseat checks off                # no Checks tab, overview or setup suggestions (on turns them back); guards are not touched
ravenseat checks restore <key>      # brings a card that was set aside back
ravenseat inspection                # failures that repeat in the gates or CI; one proposal each to build a guard
ravenseat inspection snooze <ID>    # holds an inspection entry (default 14 days) and cancels its proposal
ravenseat guards                    # the guard registry (a tracked file) with "caught N times since built"
ravenseat guards add --from-task <ID> --kind gate --explain "..."   # records a guard (kinds: gate, instruction, review, none)
ravenseat guards add --kind gate --title "..." --explain "..." --class <failure class> --area <path>   # a guard against a failure class in one area (--area '*': the whole project)
ravenseat guards retire <G-ID>      # marks a guard retired; the entry stays
ravenseat kickstart                 # which checks the project has and one next step, in plain words; changes nothing
ravenseat kickstart gates --apply   # sets the checks your project already has as gates
ravenseat kickstart add             # proposes the next step as a task; it starts only when you approve it
ravenseat gate "<failure class>"    # a known bug becomes a proposed gate task; gates.fromKnownBugs: propose, auto or off
ravenseat doctor [--all] [--fix]    # health check: node, hooks, config, state, worktrees, budget, safety baseline, keys in approved commands and .mcp.json, broad shared permissions and the project .gitignore when turned on, a .dockerignore that lets .claude/ or the data folder into a container build (WARN, only with a Dockerfile or Containerfile) (--all adds CI cost tips), an INFO row `links` with counts of open tasks' broken links (only with a finding, links.doctor), and an INFO row when a newer ravenseat is out; --fix writes the project's .gitignore from the settings first
ravenseat share status             # whether the queue's own files are in git, the repo's visibility and what git tracks in the data folder
ravenseat share on [--include <file> ...] --yes   # off by default: queue.json and plans.json in git as a backup; explains first, a public or unknown repo also needs --public-ok
ravenseat share off                # the whole data folder is private again
ravenseat private add <path> [--no-read]   # a folder or file of yours that stays out of git (and, with --no-read, out of the agents' reads)
ravenseat private list|remove <path>       # the private paths, or take one out
ravenseat secrets clean [--dry-run] --yes  # removes approved commands that hold a key, after a copy in the data folder; never shows the rule
ravenseat instructions [--plan]     # what Claude loads at start, and where each section could go; changes none of your files (--json)
ravenseat machine [--measure]       # cores, memory, free memory and a suggested maxConcurrent (an estimate); --measure times one quick and one full check when no track runs
ravenseat surface                   # git hooks and config that run code, against what was accepted; changes nothing
ravenseat surface accept --by owner # accept the current state (after installing a hook tool, changing git config)
ravenseat unlock                    # who holds the queue lock; changes nothing (--force --by owner releases it)
ravenseat tidy                      # merged worktrees (anywhere on disk) and branches left behind, with sizes; changes nothing
ravenseat tidy --execute            # removes only the merged, clean, unlocked ones no active task uses, after y/N (--yes skips it)
ravenseat issues list [--label x]   # GitHub's open issues (your gh login, read only) and where an import would put each
ravenseat issues import 12 14       # proposes each: a plan in the Inbox, or with --as task a proposed task; nothing starts (--with-body keeps the body as a reference file)
ravenseat issues report [--post]    # after a push: preview, then comment on or close the linked issues (issues.onPush, off); asks first
ravenseat pr [--post]               # one draft pull request per batch from ravenseat/batch-<date> (push.pr, off); preview, then asks
ravenseat release-notes [<tag>]     # local notes since a tag, Added/Changed/Fixed/Hardened; --github --tag <t> --post creates a draft release
ravenseat attempt list <ID>         # the task's attempts; `ravenseat attempt close <ID> --outcome <...>` closes a stuck one
ravenseat guidance [guided|quiet]   # one switch for advice about CI, gates, lockfiles and the budget; never a guard
ravenseat controls [dismiss|restore] # no CI config or no gates: dismiss stops the push question for this project until something else goes missing
ravenseat helpers                   # helper agents: on/off and what they cost
ravenseat helpers add <file.md>     # a custom helper: copied, scanned, off until approved
ravenseat plan show                 # plan register
ravenseat finding "<title>"         # a track notes something outside its scope (an idea, not a fix)
ravenseat board                     # the board: opens itself in your browser (the printed link has no key)
ravenseat board open                # opens the running board again, in a tab with its key
ravenseat board open --task <id>    # the same, on that card (--no-open prints the link without the key)
ravenseat board-setting             # the board's own switches; `cloud on|off` (the Cloud tab), `blocked on|off` (the Blocked column, off by default)
ravenseat follow                    # follow-up entries
ravenseat handover now              # the "Now" part of the handover note
ravenseat help                      # all commands
ravenseat --version                 # the plugin's version
```

Skills: `/ravenseat:queue`, `/ravenseat:decide`, `/ravenseat:board`, `/ravenseat:setup`, `/ravenseat:add-to-queue`, `/ravenseat:plans`, `/ravenseat:pick`,
`/ravenseat:review`, `/ravenseat:ask`, `/ravenseat:parallel-wave`, `/ravenseat:kickstart`, `/ravenseat:add-helper` and `/ravenseat:start` ([daily use](guide.md#daily-use)).

Every change the board makes to the queue has a command: see [CLI parity](cli-parity.md). The full command and
configuration reference is in the [queue reference](queue.md).
