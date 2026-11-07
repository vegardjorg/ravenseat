# CLI parity: every board write has a Claude Code path

The board is optional. Everything it can change, Claude Code can change too, through the same `ravenseat` command (the board
server runs `queue.mjs` for its writes), so the queue's rules, its log and its record of who acted are the same on
both surfaces. The main loop for a human is `/ravenseat:decide` (or the board's **Decisions** tab), which walks only what
waits on the owner.

This table lists each write the board makes, the endpoint, and the command or skill that does the same from Claude
Code. "Same command" means the board server runs exactly that command. Reads (state, statistics, plans, documents,
the cloud bundles, the plan check) are left out: `ravenseat show`, `ravenseat state`, `ravenseat cost`, `ravenseat plan …` and the other read
commands cover them.

## Waiting on the owner

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Answer an owner question (a choice, or your own words) | `/api/action` `resolve` | `ravenseat resolve <id> --choice <n> --by owner` or `--answer "<text>"` (same command); `/ravenseat:decide` |
| QA ok (one or many) | `/api/action` `qa-ok` | `ravenseat qa ok <id...> --by owner` (same command); `/ravenseat:decide` |
| QA deviation | `/api/action` `qa-deviation` | `ravenseat qa deviation <id> "<what is wrong>"` (same command); `/ravenseat:decide` |
| Approve a proposal (one or many) | `/api/action` `approve` | `ravenseat approve <id...> --by owner` (same command); `/ravenseat:decide` |
| Decline a proposal | `/api/task-edit` `decline` | `ravenseat cancel <id> --remark "declined[: reason]" --by owner`; `/ravenseat:decide` |
| Release an old pick | `/api/action` `release` | `ravenseat release <id>` (same command); `/ravenseat:decide` |
| Flag stuck work for the orchestrator (new) | `/api/action` `flag-stuck` | `ravenseat block <id> other --note "owner: looks stuck, please check"` (same command); `/ravenseat:decide` |
| The list itself | Decisions tab, "Waiting on you" | `ravenseat decide`, `ravenseat decide --json`, `ravenseat decide --today` (new) |

## Tasks and the queue

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Pause, continue a project | `/api/action` `pause`, `continue` | `ravenseat project <pid> --pause` or `--continue` (same command) |
| Pick a task | `/api/action` `pick` | `ravenseat pick <id>` (same command) |
| Drag a card (priority, boost with dependencies) | `/api/move` | `ravenseat edit <id> --json …`, `ravenseat edit-many` (same command) |
| Project lane priority | `/api/lane` | `ravenseat project <pid> --priority <n>`, `ravenseat edit-many` (same command) |
| Multi-select: edit, rank, batch in/out, pack | `/api/bulk`, `/api/action` `batch-*` | `ravenseat edit-many`, `ravenseat rank`, `ravenseat batch pack …` (same command) |
| Undo (bulk and edits) | `/api/undo` | `ravenseat undo [--show] [--nr <n>]` (same command) |
| Cancel, edit a task (detail panel) | `/api/task-edit` | `ravenseat cancel <id> --remark …`, `ravenseat edit <id> --json …` (same command) |
| Focus (the plan view) | `/api/focus` | `ravenseat focus save …` (same command) |
| Areas | `/api/area` | `ravenseat area …` (same command) |
| Limits | `/api/limit` | `ravenseat limit <name> <value>` (same command) |

## Settings, helpers and proposals

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Guidance, guided or quiet | `/api/guidance` | `ravenseat guidance guided|quiet` (same command) |
| Helper agents on or off | `/api/helper` | `ravenseat helpers on|off <agent>` (same command) |
| Add a custom helper | `/api/helper-add` | `ravenseat helpers add <file.md>` (same command) |
| Auto-accept rules | `/api/proposals` | `ravenseat proposals auto …` (same command) |
| Undo an auto-accept | `/api/proposals-undo` | `ravenseat proposals undo <id>` (same command) |
| Show the Cloud tab | `/api/action` `board-switch` | `ravenseat board-setting cloud on|off` (same command; queue.json `board.showCloud`) |
| Cloud on or off | `/api/action` `cloud-switch` | `ravenseat cloud on|off` (same command) |
| A cloud setting | `/api/action` `cloud-setting` | `ravenseat cloud set <setting> <value>` (same command) |
| Theme, mascot bubbles, remembered tab and view | browser storage only | per viewer, nothing in the queue; `board.mascot` in queue.config.json sets the mascot for everyone |

## Cloud sessions (with `features.cloud` on)

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Copy the cloud package | `/api/cloudPackage` | `ravenseat cloud-package <id>` (same command) |
| Started, completed, cancelled in cloud | `/api/action` `cloud-start`, `cloud-done`, `cloud-cancel` | `ravenseat cloud start|done|cancel <id>` (same command) |
| What it needs, on and off (new) | none | `ravenseat cloud setup`, `ravenseat cloud on|off` |
| Start a session, has it finished (new) | the command to copy in the Cloud tab | `ravenseat cloud-start <id>`, `ravenseat cloud send <id>`, `ravenseat cloud check` |
| Start several sessions before leaving (new) | none, CLI only | `ravenseat cloud-go [<sessions>] [--single] [--dry-run]` |

## Plans room

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Prioritize, new entry, source, bulk edit, undo | `/api/plan-prioritize`, `/api/plan-new`, `/api/plan-source`, `/api/plan-bulk`, `/api/plan-undo` | `ravenseat plan …` (same command); `/ravenseat:plans` |
| Write the lawyer package draft | `/api/lawyerPackage` | **Gap:** no command. The board server writes the draft file itself (nothing in the queue or the plan register changes). |

## Gaps

- **Lawyer package draft** (`/api/lawyerPackage`, Plans, Legal surface): the board writes the file directly; there is
  no `ravenseat plan lawyer-package` yet. It writes only a draft file in the project and changes no queue state, so it was
  left for its own task: a `ravenseat` command that wraps `queuePlan.lawyerPackage` with the same dry run and `replace`
  rule, which the board would then call.

Closed with this change: the board's QA ok and approve now pass `--by owner` (before, the record did not say who
acted), and the two new writes (`flag-stuck`, `board-switch`) went into the CLI and the board together.
