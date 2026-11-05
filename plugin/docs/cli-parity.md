# CLI parity: every board write has a Claude Code path

The board is optional. Everything it can change, Claude Code can change too, through the same `cq` command (the board
server runs `queue.mjs` for its writes), so the queue's rules, its log and its record of who acted are the same on
both surfaces. The main loop for a human is `/cq:decide` (or the board's **Decisions** tab), which walks only what
waits on the owner.

This table lists each write the board makes, the endpoint, and the command or skill that does the same from Claude
Code. "Same command" means the board server runs exactly that command. Reads (state, statistics, plans, documents,
the cloud bundles, the plan check) are left out: `cq show`, `cq state`, `cq cost`, `cq plan …` and the other read
commands cover them.

## Waiting on the owner

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Answer an owner question (a choice, or your own words) | `/api/action` `resolve` | `cq resolve <id> --choice <n> --by owner` or `--answer "<text>"` (same command); `/cq:decide` |
| QA ok (one or many) | `/api/action` `qa-ok` | `cq qa ok <id...> --by owner` (same command); `/cq:decide` |
| QA deviation | `/api/action` `qa-deviation` | `cq qa deviation <id> "<what is wrong>"` (same command); `/cq:decide` |
| Approve a proposal (one or many) | `/api/action` `approve` | `cq approve <id...> --by owner` (same command); `/cq:decide` |
| Decline a proposal | `/api/task-edit` `decline` | `cq cancel <id> --remark "declined[: reason]" --by owner`; `/cq:decide` |
| Release an old pick | `/api/action` `release` | `cq release <id>` (same command); `/cq:decide` |
| Flag stuck work for the orchestrator (new) | `/api/action` `flag-stuck` | `cq block <id> other --note "owner: looks stuck, please check"` (same command); `/cq:decide` |
| The list itself | Decisions tab, "Waiting on you" | `cq decide`, `cq decide --json`, `cq decide --today` (new) |

## Tasks and the queue

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Pause, continue a project | `/api/action` `pause`, `continue` | `cq project <pid> --pause` or `--continue` (same command) |
| Pick a task | `/api/action` `pick` | `cq pick <id>` (same command) |
| Drag a card (priority, boost with dependencies) | `/api/move` | `cq edit <id> --json …`, `cq edit-many` (same command) |
| Project lane priority | `/api/lane` | `cq project <pid> --priority <n>`, `cq edit-many` (same command) |
| Multi-select: edit, rank, batch in/out, pack | `/api/bulk`, `/api/action` `batch-*` | `cq edit-many`, `cq rank`, `cq batch pack …` (same command) |
| Undo (bulk and edits) | `/api/undo` | `cq undo [--show] [--nr <n>]` (same command) |
| Cancel, edit a task (detail panel) | `/api/task-edit` | `cq cancel <id> --remark …`, `cq edit <id> --json …` (same command) |
| Focus (the plan view) | `/api/focus` | `cq focus save …` (same command) |
| Areas | `/api/area` | `cq area …` (same command) |
| Limits | `/api/limit` | `cq limit <name> <value>` (same command) |

## Settings, helpers and proposals

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Guidance, guided or quiet | `/api/guidance` | `cq guidance guided|quiet` (same command) |
| Helper agents on or off | `/api/helper` | `cq helpers on|off <agent>` (same command) |
| Add a custom helper | `/api/helper-add` | `cq helpers add <file.md>` (same command) |
| Auto-accept rules | `/api/proposals` | `cq proposals auto …` (same command) |
| Undo an auto-accept | `/api/proposals-undo` | `cq proposals undo <id>` (same command) |
| Show the Cloud tab (new, hidden by default) | `/api/action` `board-switch` | `cq board-setting cloud on|off` (same command; queue.json `board.showCloud`) |
| Theme, mascot bubbles, remembered tab and view | browser storage only | per viewer, nothing in the queue; `board.mascot` in queue.config.json sets the mascot for everyone |

## Cloud sessions (with `features.cloud` on)

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Copy the cloud package | `/api/cloudPackage` | `cq cloud-package <id>` (same command) |
| Started, completed, cancelled in cloud | `/api/action` `cloud-start`, `cloud-done`, `cloud-cancel` | `cq cloud start|done|cancel <id>` (same command) |

## Plans room

| Board action | Endpoint | Claude Code |
| --- | --- | --- |
| Prioritize, new entry, source, bulk edit, undo | `/api/plan-prioritize`, `/api/plan-new`, `/api/plan-source`, `/api/plan-bulk`, `/api/plan-undo` | `cq plan …` (same command); `/cq:plans` |
| Write the lawyer package draft | `/api/lawyerPackage` | **Gap:** no command. The board server writes the draft file itself (nothing in the queue or the plan register changes). |

## Gaps

- **Lawyer package draft** (`/api/lawyerPackage`, Plans, Legal surface): the board writes the file directly; there is
  no `cq plan lawyer-package` yet. It writes only a draft file in the project and changes no queue state, so it was
  left for its own task: a `cq` command that wraps `queuePlan.lawyerPackage` with the same dry run and `replace`
  rule, which the board would then call.

Closed with this change: the board's QA ok and approve now pass `--by owner` (before, the record did not say who
acted), and the two new writes (`flag-stuck`, `board-switch`) went into the CLI and the board together.
