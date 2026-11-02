# The plan register (`cq plan …`)

The queue holds work that is ready to run. The plan register holds everything before that: ideas, plans,
investigations and decisions, with priority and maturity, and links to the documents where the details live. It is
stored in `scripts/.queue/plans.json` (gitignored) and only written through `cq plan …`, with a change log and
undo.

## A plan entry

```json
{
  "id": "PL-OFFLINE",
  "title": "Offline sync for the mobile app",
  "project": "offline",
  "priority": "owner",
  "priority_reason": "No owner decision yet",
  "priority_set_by": "agent",
  "maturity": "idea",
  "sources": [{ "path": "docs/offline-plan.md", "anchor": "## Sync" }]
}
```

- `project` (required): must exist (`cq projects`; create with `cq project <pid> --title "…"`). It links
  the entry to queue tasks in the same project. The area comes from the project: `cq project <pid>
  --area <oid>`, with the areas from `modules` in `queue.config.json` (`cq plan modules` creates them).
- `priority`: `now`, `owner` (the owner must decide), `later` or `drop` (dropped). Categories such as
  `security`, `for-prod` (before production) and `important` explain why.
- `maturity`: from `idea` to a plan that is ready to become queue tasks.
- `sources`: list of `{ path, anchor?, role? }` pointing to the documents. The entry points to them, it never copies
  them.
- `priority_reason`: one sentence (which priority rule, and why). Required when an agent sets the priority.

## Commands

| Command | What it does |
|---|---|
| `plan show [--module m] [--project p] [--priority …] [--search "…"]` | List entries |
| `plan get <id\|project\|module>` | Entries with sources, queue status and owner questions |
| `plan new --file entry.json` | New entry or list of entries |
| `plan edit <id> --field name=value` / `--set '{…}'` | Change fields (`sources` is replaced as a whole list) |
| `plan prioritize <id…> <now\|owner\|later\|drop>` | Set priority |
| `plan combine <to-id> <from-id…>` | Merge entries (the others go to the archive) |
| `plan verify <id> --findings "…"` | Record that a plan was checked against the code |
| `plan rules` | The priority rules |
| `plan active <id>` | "Working now" marker shown on the board |
| `plan check` | Unregistered documents, dead paths, stale entries |
| `plan undo` | Undo |
| `plan backup` | Runs the script in `planBackup` (optional; for example a private backup repo) |
| `plan doc …` | Optional register of controlled documents (versions, revisions, links) |
| `finding "<title>" [--detail "…"] [--task <id>] [--cause <id>] [--files a,b]` | A track reports something outside its scope as an idea (see Findings); `--cause` names the merged task it is a defect of |
| `finding list [--all]` | The findings nobody has triaged yet (`--all`: every one) |

## Findings

A track that notices a bug or a smell outside its own files runs `cq finding "<title>"` instead of fixing it. The
finding lands here, not in the batch queue: the batch queue holds small tasks someone has decided to do (class,
estimate, owned files), while a finding is an observation nobody has looked at yet, which is what an idea is.

- The entry is `PL-FINDING-<n>` with `maturity: idea` and `priority: later` set by the agent. It is not `owner`
  (rule 2 below), so a busy track does not open an owner question for every observation; the orchestrator triages.
- `--task` defaults to the task whose queue branch the worktree is on, and the project to that task's project.
  The tool-owned field `finding` keeps the reporting tasks, the files, the time and a count.
- The same title again (case, punctuation and spacing ignored) adds the task and the files to the existing entry.
  A title that matches an entry that is not a finding changes nothing.
- A finding is new until it is triaged: a new priority or maturity, a drop, or a queue task with `--plan <id>`.
  `orchestrator pulse` and `cq show` print a `FINDINGS:` line with the count, and `cq state` has `findings`.

## Rules that keep it useful

1. A new plan or investigation document is registered in the SAME session it is written, either as a new entry or as
   a source on an existing one (`plan show --search "…"` first).
2. An entry created by an agent without the owner's decision gets `"priority": "owner"`, `"maturity": "idea"`,
   `"priority_set_by": "agent"` and a reason, and an owner question (`cq question`).
3. Plan work and building are separate: the skill `/plans` works on plans only and turns a mature plan into queue
   proposals; the queue builds.
