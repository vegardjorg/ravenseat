# The project catalog (`ravenseat catalog …`)

Parallel tracks tend to write a helper the project already has, add a second library for a job it already has one
for, and take an architecture choice nobody asked about. The [reuse and scope notes](queue.md#reuse-and-scope-notes)
at `receive` see that after the fact. The project catalog is what the tracks should know before they start: the stack
and what to prefer, the building blocks meant for reuse, and the design choices that hold, each with one invariant
that can be checked.

The catalog is hand-written, short, and tracked in git in `docs/queue/catalog/`. Only the owner accepts a design
choice. A project without the folder loses nothing: every command and check is quiet until it exists.

## The folder

```
docs/queue/catalog/
  stack.md                     the stack and the "Prefer" lines
  reuse.md                     building blocks meant for reuse
  decisions/
    README.md                  the format note (written by catalog init, never read as a choice)
    D-0001-service-layer.md    one design choice per file
```

### stack.md

`ravenseat catalog init` writes a generated block between two marker comments: the languages and runtimes, the
frameworks with a review pack, the checks it found and the libraries by job (dates, HTTP, validation, tests and
more, from the manifests). Write your own text below the block. A later `catalog init` refreshes only the block, and
`catalog check` warns when the block is out of step with the manifests.

Under `## Prefer`, one line per job says what to use and, if you like, what not to add:

```markdown
## Prefer

- dates: dayjs, never moment
- http: the fetch wrapper in lib/http.ts
- validation: zod
```

Keep it to at most 10 lines. They go into every mission's [catalog excerpt](#the-excerpt-in-the-mission-and-the-review-package),
so a track reads them before it writes code.

### reuse.md

A table of building blocks a track would not find by itself. Keep it to at most 40 rows; a generated index of the
code comes in a later step and holds the rest.

```markdown
| Purpose | Symbol | File |
|---|---|---|
| Format a date for the UI | formatDate | lib/dates.ts |
```

`catalog check` warns when a file in the table does not exist or does not contain the symbol.

### decisions/D-0001-<slug>.md

One design choice per file. The slug is lower-case letters, digits and hyphens.

```markdown
---
id: D-0001
title: Client code goes through the service layer
status: proposed
paths: ["app/**", "components/**"]
invariant: Files under app/ and components/ never import the database client directly.
supersedes: null
plan: PL-SERVICE-LAYER
---
Context, the choice and what follows from it, in at most 30 lines.
```

- `id`: `D-` and four digits, the same as the file name. An id is never reused.
- `title`: at most 120 characters.
- `status`: `proposed`, `accepted` or `superseded`. Anyone may propose.
- `invariant`: one sentence that can be checked, at most 300 characters. It is the only text of a choice a track
  gets, so it must stand on its own.
- `paths`: the files the choice applies to, as globs from the project root. No `..` and no absolute paths.
  `catalog check` warns when they match no tracked file.
- `supersedes`: the id of the choice this one replaces. To change an accepted choice, write a new one with
  `supersedes: D-0001` and set the old one to `superseded`.
- `plan`: the plan entry with the long version, if there is one.
- `check`: rules a later step will run against a delivery. For now only its shape is checked.
- `accepted_by` and `accepted`: written by `catalog accept`, never by hand.

A body over 30 lines gives a warning: the plan register holds the long text.

## Commands

| Command | What it does |
|---|---|
| `catalog init` | Creates `stack.md` with the generated block, `reuse.md` and `decisions/README.md` where they are missing, in the main tree. Never writes over a file that is there, except the generated block in `stack.md`. Refused from a track worktree |
| `catalog show [<D-id>] [--json]` | The prefer lines, the reuse rows and the design choices with the status that counts. With an id: that choice in full, and the plan entries that link to it |
| `catalog check [--json]` | Shape, ids, status, the owner lock, `supersedes`, the paths, the reuse rows and the generated block. Exit 1 on an error, 0 on warnings only, 0 without a catalog. Read only |
| `catalog accept <D-id> --by owner` | The owner accepts a design choice: `status: accepted`, `accepted_by` and `accepted` in the file, and the owner's record in the data folder. Refused from a track worktree whatever `--by` says |

A queue agent may run `catalog show` and `catalog check` (the push guard allows them), and nothing else. `show` and
`check` read the tree the command runs in, so a track sees its own branch's catalog.

`catalog check` is not a gate by default. A project that wants it can add `ravenseat catalog check` to its `gates`.

## The owner lock

Only the owner decides which design choices hold. `status: accepted` counts only when the owner accepted exactly this
version with `ravenseat catalog accept <id> --by owner` (or from the board) in the main tree.

The accept writes two things: the status lines in the choice's file, and a record in
`<dataFolder>/catalog-accepted.json` with a fingerprint of what binds (the id, the invariant, the paths and the
`check` rules). The record file is gitignored and written by the queue only: the write guard keeps queue agents' file
writes off it, and the push guard denies a queue agent's shell command that names it.

A choice that says `accepted` without a matching record reads as `unconfirmed`. That covers a track that set the line
by hand and an invariant, paths or check changed after the accept. `catalog check` names it as an error, `catalog show`
prints `unconfirmed`, and it counts as proposed until the owner accepts it again. The title and the body text may change
without a new accept.

The lock is not a setting: turning it off would let a track decide an architecture choice.

## The excerpt in the mission and the review package

A track gets only the part of the catalog that meets its task, never the whole folder, and never through the
instructions file (which every session loads, task or not). The queue picks it when it writes the mission, from the
task's `owned_files`, `shared_patch` and `reads`:

- **Design choices** whose `paths` meet those files: a file a glob matches, or a folder a glob can reach into. At
  most five, the binding ones first, by id. Only a choice the owner accepted (with the record, see the owner lock) is
  under "Design choices that hold" and binding. A proposed choice, and one that says accepted without the owner's
  record (unconfirmed, so marked), is under "Proposed design choices" as a suggestion. A superseded choice never comes.
- **Prefer lines** from `stack.md`, at most ten: they hold for the whole project.
- **Reuse rows** from `reuse.md` in the task's folders (the folder of an owned or read file, or inside an owned
  folder), at most 15.
- One line on how to look for a helper before writing one, and `catalog show <D-id>` for a choice in full.

A task that names no files gets every choice that holds and no proposed one (nothing says which proposals concern it),
the prefer lines and the first reuse rows. Nothing that meets the task, or no catalog, gives no block at all.

**The cap and the measurement.** The excerpt stays within `catalog.excerptTokens` (default 1500, a token counted as four
characters). Items go in in the order binding choices, prefer lines, proposed choices, reuse rows while the whole text
still fits, so the reuse rows are cut first. The heading says what it used and what was cut:

```
**From the project catalog** (`docs/queue/catalog/`, chosen for this task's files; about 209 of at most 1500 tokens; nothing cut):
- **Design choices that hold** (accepted by the owner, binding: a change that would break one is an owner question, never your call):
  - D-0001 (plugin/scripts/orchestrator/lib/**): A lib module never starts a process or writes a file; the I/O lives in cli/ and the scripts.
- **Prefer** (stack.md: a second library for one of these jobs is an owner question):
  - tests: vitest
- **Building blocks for reuse in these folders** (reuse.md: use them before you write a new helper):
  - Match a path against a glob: `globMatch` in `plugin/scripts/orchestrator/lib/mergeGuard.js`
- Before you write a new helper, look for one (`git grep -n -w <name>`); `ravenseat catalog show <D-id>` prints a choice in full.
```

`fill` prints the size per track (`Catalog excerpt in the mission (tokens, cap 1500): K-7 209`), and `ravenseat cost` shows
what the tracks cost, so the price of the excerpt can be measured on the first tracks. A fix round's short mission
leaves the excerpt out; the whole mission it points to has it.

**The review package.** `receive` puts the same excerpt in `00-package.md` under "From the project catalog", read from
the main tree, right after "Reuse and scope". The reviewer and the gap reviewer check the delivery against it: a helper
or rule written again where a reuse row, a prefer line or a reuse note shows one is a `duplication` finding, and a
change that breaks the invariant of a choice that holds is a `scope-drift` finding, MEDIUM at least, since it was an
owner question. A proposed choice binds nothing, so not following it is no finding.

The text names no client and no client's tools, so a cloud session and any other client get the same excerpt.

## Protected path

`docs/queue/catalog/` is in the default `protectedPaths`. A track may change it only when its task owns the files
(`owned_files` or `shared_patch`); otherwise `merge` stops with exit 4. That keeps a track from rewriting the rules it
is measured against. A task that is meant to update the catalog names the files it owns. To drop the protection, put
the folder in `protectedPaths.remove` (doctor then gives an INFO line, as for any removed default).

## Plan entries link to design choices

A plan entry in the [plan register](plan-register.md) can name the choices it builds on or changes:

```json
{ "id": "PL-SERVICE-LAYER", "decisions": ["D-0001"] }
```

`ravenseat plan new` and `plan edit` take the field like any other. The shape (a list of `D-0001` ids) is always
checked. While `catalog.planLinks` is on, an id the catalog does not have gives a warning, never a stop. `plan get`
prints the links, and `catalog show D-0001` lists the plan entries that link to that choice. The other way round, a
choice's `plan` field names its plan entry, and `catalog check` warns when that entry is not in the register.

## The Checks tab

For a project with a known stack and no `docs/queue/catalog/`, the Checks tab offers the card "Write down the stack and
the design choices" (low priority). Its "Ask Claude" text has Claude run `catalog init`, read the code and propose the
prefer lines, a few reuse rows and at most five design choices as `proposed`, and show you the diff. Claude never sets a
choice to accepted. The card turns important only when the finding log shows duplication or scope drift three times in
one area within 30 days, and it goes away once the folder exists.

## Friction

Anything that can stop work is off by default, with one deliberate exception: the protected path, by owner decision.

| Part | Friction | Default and setting |
|---|---|---|
| Catalog files | None without the folder | No setting: nothing reads a folder that is not there |
| Protected path | Stops `merge` (exit 4) for a track that changes the catalog without owning the files | On by owner decision; `protectedPaths: { "remove": ["docs/queue/catalog/"] }` |
| Owner lock | Never stops work; it only decides what counts as accepted | No setting, on purpose |
| `catalog check` | Exit 1 only when someone runs it or a project makes it a gate | Not a gate by default |
| Doctor row | One WARN row, only when `catalog check` finds an error | `catalog.doctor`, on |
| Plan link warning | A warning at `plan new` and `plan edit` only | `catalog.planLinks`, on |
| Checks card | Low priority, can be set aside | No setting: it only proposes |
| Agent access | `catalog show` and `catalog check` allowed for queue agents | No setting |
| Excerpt in the mission | Text only: up to `catalog.excerptTokens` more context in every turn of the track (1500 tokens over about 100 turns is about 150,000 cached input tokens). It stops nothing, and a project without a catalog pays nothing | `catalog.missionExcerpt`, on by owner decision: the track needs it to reuse, and the heading measures its cost |
| Excerpt in the review package | Text only, read once per reviewer; it can lead to a `duplication` or `scope-drift` finding, which is the point | `catalog.reviewExcerpt`, on: the reviewer judges against what the track was given |
| Excerpt cap | None; it only narrows. Too low cuts the reuse rows first, and the heading says so | `catalog.excerptTokens`, 1500 (200 to 6000) |
| Reviewer point (V9) | No new reviewer and no new turn: one point in `reviewer.md` and `reviewer-gap.md` that acts only on the package section | Follows `catalog.reviewExcerpt`: without the section the point has nothing to check |

Turning any of the catalog settings off weakens no guard, so `ravenseat settings` does not flag it.
