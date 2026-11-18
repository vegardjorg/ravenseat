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

A table of building blocks a track would not find by itself. Keep it to at most 40 rows; the
[code index](#the-code-index-and-catalog-find) holds the rest, and a `@shared` tag in the code is often the better
place for a helper's row.

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
- `check`: an optional rule that receive runs against the delivery's added lines, with examples that prove it:
  see [Check rules](#check-rules).
- `accepted_by` and `accepted`: written by `catalog accept`, never by hand.

A body over 30 lines gives a warning: the plan register holds the long text.

## Commands

| Command | What it does |
|---|---|
| `catalog init` | Creates `stack.md` with the generated block, `reuse.md` and `decisions/README.md` where they are missing, in the main tree. Never writes over a file that is there, except the generated block in `stack.md`. Refused from a track worktree |
| `catalog show [<D-id>] [--json]` | The prefer lines, the reuse rows and the design choices with the status that counts. With an id: that choice in full, and the plan entries that link to it |
| `catalog check [--json]` | Shape, ids, status, the owner lock, `supersedes`, the paths, the reuse rows and the generated block. Exit 1 on an error, 0 on warnings only, 0 without a catalog. Read only |
| `catalog accept <D-id> --by owner` | The owner accepts a design choice: `status: accepted`, `accepted_by` and `accepted` in the file, and the owner's record in the data folder. Refused from a track worktree whatever `--by` says |
| `catalog find <word...> [--json]` | Searches the code index, the reuse rows, the design choices and the prefer lines. Every word must match; at most ten short lines. Builds the code index first (from the cache) |
| `catalog index [--json]` | Builds or refreshes the code index and says how many files it read and how many came from the cache. Names a `@shared` tag that is not on an export |

A queue agent may run `catalog show`, `catalog check` and `catalog find` (the push guard allows them), and nothing
else. All four read commands read the tree the command runs in, so a track sees its own branch's catalog and code.

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
- Before you write a new helper, look for one: `ravenseat catalog find <word>` searches the catalog and the code's exports (or `git grep -n -w <name>`); `ravenseat catalog show <D-id>` prints a choice in full.
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

## The code index and catalog find

Most helpers are only in the code. Tag the ones meant for reuse where they are, in the JSDoc right above the
definition, and the queue collects them:

```js
/**
 * Match a repo path against a glob.
 * @shared match a path against a glob pattern
 */
function globMatch(pattern, file) { ... }
module.exports = { globMatch };
```

The text after `@shared` is the purpose; with none, the first line of the doc is used. The tag travels with the
function when the file moves and goes when the function goes, which a hand-written row cannot do.

**What is indexed.** JS and TS files (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx` and the like) the tree tracks or has
as new files, never node_modules, tests, declaration files or minified files, nor a file over 512 KB. The scan is a
light tokenizer, no parser: it follows strings, template literals, comments and regex literals and reads only the top
level of a file: `export function`, `export const`, `export class`, `export { a as b }`, `exports.x =`, and the
entries of a `module.exports = { ... }` block. A re-export (`export { x } from`) is left out (the helper lives in the
other file), and so is a form it does not know. It would rather miss an export than invent one. A `@shared` tag on a
name that is not exported, or not right above a definition, is named by `catalog index`, never indexed.

**The cache.** The index is in `<dataFolder>/catalog-index.json` (gitignored). Per file it holds git's blob sha and what
the scan found, so a file whose sha did not change is not read again, also after a move. The file list always comes
from git, so the index follows the tree it was built for, and a track's tree and the main tree share the cache without
mixing. The queue writes the file; the write guard and the push guard keep queue agents off it, since a forged entry
would reach other missions.

**`catalog find`.** `ravenseat catalog find date` searches the index (exports and tagged blocks), the reuse rows, the
design choices and the prefer lines. A hit in a name ranks above a hit in a text; a tagged block or a reuse row ranks
above a plain export. At most ten lines:

```
catalog find date: 3 hits (index: 212 code files, 9 tagged @shared):
  shared   parseDate       lib/dates.js:5  parse a date from user input
  prefer   dates: dayjs, never moment
  decision D-0001 (accepted)  Dates through one library: Code under lib/ handles dates with dayjs only.
```

**With `catalog.index` on** (off by default), the index is built at `receive` and when the missions are made, from the
cache, and:

- the excerpt in the mission and the review package gets the blocks tagged `@shared` in the task's folders (the same
  folder rule as the reuse rows; a reuse row for the same symbol wins), at most 15, under "Tagged for reuse in these
  folders". They are cut first under the cap.
- the review package's excerpt gets the **near names** (V1b): a name the delivery defines that is close to one the
  code exports in another file. Close means the same words in another order or style (`normPath`, `pathNorm`), or one
  small edit in one word with the same first word (`readFile`, `readFiles`). A different first word never counts, so
  `getUser` and `setUser` are no hit. The same name is the reuse note's job at receive, so it is not repeated. At most
  five, and only for the reviewer: a near name is context to weigh, never a finding by itself.

A project without `catalog.index`, or without any `@shared` tag, gets the excerpt byte for byte as before.

## Check rules

A design choice can carry one plain rule that the queue checks mechanically, so a broken invariant is seen at
receive and not only when a reviewer happens to notice it:

```markdown
check:
  forbid: "from ['\"]@db/client['\"]"
  hit: ["import { db } from '@db/client'"]
  miss: ["import { db } from '@services/factory'"]
  mode: warn
```

- `forbid`: a regular expression (JSON string) that an added line must not match. It is matched case-sensitively,
  one line at a time, against at most the first 2000 characters of a line. The same lookahead check as the review
  packs applies.
- `hit` and `miss`: at least one line each that the rule must and must not match. `catalog check` runs them, so a
  rule that is broken (a typo, too wide, too narrow) is an error before it ever reaches a delivery. They can also be
  written as `examples: { "hit": [...], "miss": [...] }`.
- `mode`: `warn` (the default) or `stop`.

What the rule looks at: the lines a delivery adds, in files that match the choice's `paths`, test files and comment
lines left out (the same engine as the review signals). `catalog check` also warns when the rule already matches
lines in the tree: receive only looks at added lines, so old hits are not counted against a track.

Who can enforce: only a choice the owner accepted (the owner lock, so `check` is part of the fingerprint and a changed
rule needs a new `catalog accept`). A proposed or unconfirmed choice gives one `NOTE` line and a package line marked
"binds nothing", never more.

| Level | When | What happens |
|---|---|---|
| info | The choice is proposed or unconfirmed | `NOTE catalog` line at receive (two or more such choices share one line with their ids; `receive <id> --all` prints one each), a package line; nothing is counted |
| warn | The choice is accepted (and `mode: warn`, or `mode: stop` with `catalog.checkStop` off) | `CATALOG` line at receive with the places, the invariant and the way forward (a fix round, or the owner changes the choice); a line in the review package; the hit is recorded on the task (`catalog_checks`) |
| stop | The choice is accepted, `mode: stop` and `catalog.checkStop` on | As warn, and `merge` stops (exit 1). Only on the owner's word: `merge <id> --allow-catalog`, logged as `catalog-overridden` |

### Where the rules run (receive, merge or both)

At receive, always while `catalog.checks` is on: that is where the delivery's diff is read anyway, where a fix round
is cheap, and where the reviewer gets the package line. At merge only the stop is checked again, and only when
`catalog.checkStop` is on, on the merge's own diff (base to the track's tip), so a commit after receive cannot slip
past a stop. A warn rule is not run twice: the second run would add only noise. The catalog is always read from the
main tree, never from the track's branch, so a track cannot turn its own rule off.

### A rule broken again and again

Each task keeps the ids of the accepted rules it ever broke (`catalog_checks.ever`). When the same rule has been broken
in `catalog.gateAfter` separate tasks (3 by default) and `learning.proposals` is on, receive proposes a GATE task:
make the rule a real lint or check in the project's own tooling (for an import ban, for example, ESLint
`no-restricted-imports`). It goes through the shared proposal cap of the known-bug gates, so it never adds a fourth
open proposal and never a second one for the same rule (a later hit extends the open one). The task is `proposed`:
the owner approves or cancels it. With `learning.proposals` off nothing is proposed.

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

Two more cards offer the opt-in scope drift guards (see [Reuse and scope notes](queue.md#reuse-and-scope-notes)): "Add
the gap review when a change drifts far" (`scopeNotes.driftGap`, V6) and "Warn a track when it writes outside its
files" (`scopeNotes.driftWarn`, V7). Both are low while off and turn important by the same rule: scope drift three
times in one area within 30 days in the finding log, with the count on the card. In lite mode none of these cards turns
important, and the two guard cards are not shown, since a lite task names no files. Every card, and the rule
behind "three times in one area within 30 days": [The Checks tab](checks.md#three-thresholds-for-repeats).

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
| Agent access | `catalog show`, `catalog check` and `catalog find` allowed for queue agents | No setting |
| Code index at receive and in the missions | One git listing per tree and a read of each changed file (the first build of about 300 files took under half a second here); a file in the data folder; more lines in the excerpt, inside the same cap. It stops nothing | `catalog.index`, off: the plan puts it on the opt-in list, since it builds and stores a file and its worth grows with the project |
| `catalog find` | Only when someone runs it; it builds the index from the cache first | No setting: it is a read on request, and works with `catalog.index` off |
| Near names (V1b) | Up to five lines for the reviewer, which may lead to a `duplication` finding after the reviewer weighs the code. Never to the owner alone, never a stop | Follows `catalog.index` and `catalog.reviewExcerpt` |
| `@shared` problems | Printed by `catalog index` only; no gate, no doctor row | No setting |
| Index cache guard | A queue agent cannot write `catalog-index.json` (write guard) or name it in a shell command (push guard) | No setting, on purpose: a forged entry would reach other missions |
| Excerpt in the mission | Text only: up to `catalog.excerptTokens` more context in every turn of the track (1500 tokens over about 100 turns is about 150,000 cached input tokens). It stops nothing, and a project without a catalog pays nothing | `catalog.missionExcerpt`, on by owner decision: the track needs it to reuse, and the heading measures its cost |
| Excerpt in the review package | Text only, read once per reviewer; it can lead to a `duplication` or `scope-drift` finding, which is the point | `catalog.reviewExcerpt`, on: the reviewer judges against what the track was given |
| Excerpt cap | None; it only narrows. Too low cuts the reuse rows first, and the heading says so | `catalog.excerptTokens`, 1500 (200 to 6000) |
| Check rules at receive | One line per broken rule (accepted: `CATALOG`, proposed: `NOTE`), a package line and a small record on the task. Stops nothing. A project without `check` fields pays nothing: the output is byte for byte the same | `catalog.checks`, on: it only shows what an accepted choice already says, and off weakens the protection |
| Rule at merge (`mode: stop`) | Stops `merge` (exit 1) when an accepted choice's stop rule matches the merge's diff; `--allow-catalog` on the owner's word, logged | `catalog.checkStop`, off: it can stop work, so the owner turns it on |
| Rule examples | `catalog check` exits 1 when a `hit` example does not match or a `miss` example does, or when examples are missing. Only when someone runs it or a project makes it a gate | No setting: a rule without proven examples is never run |
| Tree hit warning | One warning in `catalog check` when a rule already matches lines in the tree (it reads at most 3000 tracked files, skipping large and binary ones) | No setting: a warning only |
| Gate proposal from repeats | At most one proposed task per rule, inside the shared proposal cap; the owner approves or cancels | `catalog.gateAfter`, 3 (2 to 20); only with `learning.proposals` on (off by default) |
| Reviewer point (V9) | No new reviewer and no new turn: one point in `reviewer.md` and `reviewer-gap.md` that acts only on the package section | Follows `catalog.reviewExcerpt`: without the section the point has nothing to check |
| Gap review on large drift (V6) | One more reviewer run when at least 4 changed files, and over 40 % of them, lie outside the task's files and reads | `scopeNotes.driftGap`, off: it costs a reviewer run; the thresholds are `scopeNotes.driftGapFiles` and `driftGapShare` |
| Write warning for drift (V7) | One note per file while a track writes outside its files and reads, never a denial; a track may still stop and ask | `scopeNotes.driftWarn`, off: it can slow a track down when the task's files were a rough guess |
| Red marker from the finding log | The scope drift cards turn important at three incidents of a class in one area within 30 days; never in lite; a card set aside stays aside | No setting: follows `learning.repeats` (no counting, no marker) |

Turning any of the catalog settings off weakens no guard, so `ravenseat settings` does not flag it.
