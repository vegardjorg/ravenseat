# The work queue (`ravenseat`)

The queue is a JSON file (`scripts/.queue/queue.json`, gitignored) with tasks, owner questions, projects, limits and cost
data. It survives when the orchestrator's chat is compacted or restarted, because nothing important lives only in
the chat. Every command is `ravenseat <command>`. `ravenseat help` prints the key commands in four groups (Get started, Daily,
Owner, Orchestrator), `ravenseat help all` the full usage list (the comment at the top of `queue.mjs`, with the internal
scripts under their own heading), and `ravenseat help <command>` one command in full (or a script's header). A mistyped
command gets one line with the closest match: `Unknown command "shwo". Did you mean "show"? See ravenseat help.` (exit 1).
The texts and the suggestion live in `lib/cliHelp.js`. The table below lists the important ones. In the code,
`scripts/orchestrator/queue.mjs` holds the usage comment and the dispatch on the command word, and each command's
code is in `scripts/orchestrator/cli/` (one module per area, the shared state in `cli/context.mjs`).

Writes happen under a file lock (atomic `mkdir`) and via temp file plus rename, so two writers (the orchestrator and
a track adding a proposal) cannot corrupt the file. `ravenseat undo` undoes the last change.

## A task

```json
{
  "id": "AUTH-3",
  "title": "Rate limit on the login endpoint",
  "domain": "auth",
  "class": "K",
  "mission": "Self-contained description of what to do and how to verify it.",
  "value": 7,
  "content_min": 60,
  "depends_on": ["AUTH-2"],
  "waiting_on": [],
  "owned_files": ["src/auth/rateLimit.ts", "src/auth/__tests__/rateLimit.test.ts"],
  "owner_db": [],
  "shared_patch": [],
  "project": "auth",
  "feature": "Login",
  "plan": "PL-AUTH-1",
  "sources": [{ "path": "docs/auth-plan.md", "anchor": "§ 2", "role": "plan" }],
  "source": "review of AUTH-2, finding M1"
}
```

| Field | Meaning |
|---|---|
| `id`, `title` | Unique id and title |
| `description` | Optional: a short summary of the task, written by a person for people (one or two sentences, about 320 characters). The board's detail panel shows it at the top, in place of the summary it otherwise derives from the mission, and `ravenseat info` shows it under the title. The agent never sees it: the track block and the mission are the same with or without it. Set it with `add ... --description "…"` (one task) or `"description"` in the task file, and change it with `edit <id> --description "…"` or the board's Edit form; `--description ""` (or `null` in `--json`) removes it. Text only, trimmed; a line break is allowed, as in the title. A longer one is saved with one `WARNING` line (see [The description](#the-description)) |
| `domain` | Domain; limits how many tracks run in the same domain (`maxPerDomain`) |
| `class` | `K` code, `D` database, `D+` high-risk database or security, `U` investigation (no production code) |
| `mission` | The mission text, or the path to a mission file (one line, for example `scripts/.queue/mission/<id>.md`, the form the board and `batch pack` write). Must be self-contained: the track agent knows nothing else. A task with no documents keeps its whole text here. When `add` or `edit` gets an inline text longer than `queue.missionInlineMax` characters (default 16000), the text moves to `mission/<id>.md` in the data folder and the field stores that path, with one `NOTE: <id>: the mission (<n> KB) was moved to <path> ...` line (`missionMoved` in `--answer-json`). The agent reads the file exactly as it read the text. A file that already holds other text is never overwritten: the mission then goes to the next free `<id>+2.md`, `<id>+3.md`, and the line names both. A file that already holds the same text is reused |
| `value` | Value 1 to 10, used for ranking |
| `content_min` | Estimated minutes |
| `depends_on` | Task ids that must be done first |
| `waiting_on` | Registered owner question ids that block the task until answered |
| `owned_files`, `owner_db` | Files and DB objects the task owns exclusively while it runs. A file another active task (running, in review or picked) owns stops the merge (exit 4, `--allow-guard` overrides and is logged); `receive` and the pulse say it early. A hotspot can never be in `owned_files`. In `owner_db`, `users` and `public.users` are the same object, and `fn(uuid)` the same as `fn` (another schema, like `auth.users`, is not). `merge` keeps the files a task actually changed in `changed_files`; `add` names files that earlier tasks changed together with the new task's files (OWNERSHIP HINT), so they can be owned from the start |
| `hotspot_patch` | Optional: the hotspots (`hotspots` in `queue.config.json`) this task may change, agreed by the owner. Only one active task can hold the same hotspot (a start conflict). Without it a hotspot change stops the merge, and the track writes a wiring spec instead |
| `shared_patch` | Shared functions the task changes in patch form |
| `reads` | Optional: files, or folders ending in `/`, the task builds on but does not change. A task that reads a file an active task (running, in review or picked) changes waits until that task is done, and so does a task that would change a file an active task reads; two readers never block each other. With `"reads": { "mode": "warn" }` in `queue.config.json` it starts anyway, and `start`, `fill` (`READS WARNING`), `explain` and the mission name the overlap. The mission lists the read files and tells the agent not to change them. Never ownership for the merge guard |
| `project`, `feature` | Project id (must exist) and feature name |
| `plan` | Optional: the plan entry the task belongs to (`PL-NAME-1`, must exist in the [plan register](plan-register.md); `add --plan <id>` sets it). The entry's sources are the task's reading material, looked up when the mission is made (see [Task links](#task-links)) |
| `sources` | Optional: the task's own reading material, a list of `{ "path", "anchor"?, "role"? }` with the same shape as a plan entry's sources. It narrows the plan entry to the part this task needs and replaces the entry's sources in the mission. `path` is relative to the project root, with `/`, without `.` or `..` and without a line break; `anchor` is one line (`§ 2` or heading text); `role` is `plan` (the default), `investigation`, `spec`, `decision` (a large plan's decision section), `history` or `reference` (the last two are checked but not read). `add` and `edit` refuse a bad shape (`Nothing added: T1: sources /etc/a.md: must be relative to the project root (e.g. docs/…)`); a file that is missing is a link warning, not a refusal. `edit` replaces the whole list, and `[]` or `null` removes it. Set it in the task file, or with `edit <id> --json '{"sources":[...]}'` |
| `source` | Optional: the task's origin, where it came from (`"review of AUTH-2, finding M1"`, `"owner 18.11"`, `"docs/auth-plan.md § 2"`). Free text, never checked as a path and read by nobody: the mission prints it in the track heading only. Reading material goes in `plan` and `sources` |
| `batched` | `true` for small low-value tasks: they go to the batch queue (`ravenseat batch`) instead of their own track. Approving such a proposal does not start it: it starts when packed, or alone after `edit <id> --json '{"batched":false}'` |
| `done_when` | Optional: a shell command (one line, at most 500 characters) that must exit 0 in the track's worktree for the track to count as done, e.g. `npm test -- src/x.test.ts`. The mission tells the track to run it before it reports; `receive` and `merge` run it again (see [the done command](#the-done-command-and-the-fix-round-cap)). `null` in `edit` removes it. A proposal with it is never auto-accepted |
| `acceptance` | Optional: a list of 1 to 10 short criteria (one line each, at most 300 characters), set with `ravenseat add ... --accept "..." --accept "..."` (one task) or `ravenseat edit <id> --accept "..."` (replaces the list). The mission copies them under "Acceptance criteria (fixed, do not change)", `ravenseat info` and the board's detail panel show them, and `reviewer-gap` answers MET / NOT MET / UNCLEAR per criterion (a task with criteria gets it even while the helper is off, `helpers.reviewer-gap.acceptance`). Locked after the start, like `done_when` (see [the lock](#the-finish-line-is-locked-after-the-start)). `null` in `edit` removes it |
| `risk_first` | Optional: the riskiest assumption in one line (at most 300 characters), set with `ravenseat add ... --risk-first "..."` (one task) or `ravenseat edit <id> --risk-first "..."` (`""` removes it). The mission tells the track to test it first and to stop with PARTIAL and one owner question if it fails; the board's detail panel shows it. Locked after the start, like `acceptance` (see [riskiest assumption first](#riskiest-assumption-first)) |
| `shaped` | Optional: the answer to the shape-first question when a large request was not shaped first: `skipped` ("build it all now") or `smallest` ("the smallest version first"). Set by `/add-to-queue`; it only records the choice (see `shape.nudge`) |
| `max_fix_rounds` | Optional: this task's fix-round cap, a whole number 0 to 20 (0 = no fix round without the owner); overrides `maxFixRounds` in `queue.config.json` (default 3). `null` in `edit` removes it |
| `fixes` | Optional: the task id (or a list of ids) this task fixes. `add` and `edit` refuse an id that is not in the queue (or in the same add) and a task naming itself; stored as a list, and `[]` or `null` in `edit` removes it. `ravenseat info <id>` shows `fixes` and `fixed by`, and `ravenseat state` lists the open fix tasks as `fixLinks`. `qa deviation` sets it on the fix task it creates. The benchmark (`bench/`) counts it as a defect after merge |
| `gate_check` | Written by `receive`, never by hand: ravenseat's own quick gate run on the delivered tip (`ok`, `kind`, `tip`, `at`, `ran`, and `evidence_at` when a green gate evidence entry for that exact tip was reused; `flaky` and `flaky_times` when a command was green only on the rerun, see [Flaky gate commands](#flaky-gate-commands); `zeroTests` when a green command ran no test, see [Green, but no tests ran](#green-but-no-tests-ran)). The track's own `RESULT gates=` is informational only; a red `gate_check` opens the blocker `gate-red` and a fix round (see orchestration.md, The gate evidence) |
| `wiring` | Written by `receive`, never by hand: the wiring spec's items, one per `WIRE <file> \| <what>` line in `track-result.md` (`id` W1, W2 ..., `file`, `text`, `status` open, done or rejected, `added`, and when closed `commit` or `reason`, `closed`, `by`). `set <id> done` and the done step of `merge` refuse while one is open; `wiring` closes them (see orchestration.md, "The wiring spec stops done") |

`add` warns about a field that is neither in this table nor one the queue writes itself, and names the nearest known
field (`WARNING: T1: unknown field "owns"; the queue does not read it (did you mean owned_files?).`). The task is added
as given, so fix it with `ravenseat edit`.

### Task links

A task's reading material is its plan entry's sources (`plan`, roles `plan`, `investigation`, `spec` and `decision`) and its own
`sources` (`[{ "path", "anchor"?, "role"? }]`, which narrows the plan to the part this task needs). A repo path in
`source` is origin only. The three fields relate like this:

- `plan` links to an id. The plan entry owns the paths, anchors and roles, so a moved document is fixed once, in the
  register, for every task that links to it.
- `sources` is for the task that needs another part than the rest of the plan ("of PL-AUTH-1, read only § 2"). When
  it is set, it replaces the entry's sources in the mission; without it, the task reads the entry's sources.
- `source` says where the task came from. It is never read, so it can name a review, a chat or a decision.

```json
{ "id": "AUTH-3", "plan": "PL-AUTH-1", "sources": [{ "path": "docs/auth-plan.md", "anchor": "§ 2" }],
  "source": "review of AUTH-2, finding M1" }
```

Here the mission reads `docs/auth-plan.md` § 2 (as a line range), not the rest of PL-AUTH-1's documents, and prints
the review only in the track heading. `add` and `edit` refuse a `sources` entry with a bad shape (see the field table)
the same way they refuse any other field shape. They also check these links and print ONE line when one is dead, its anchor finds no
heading, or the file is gitignored (so an agent's worktree does not have it), for example:

```
WARNING: task links: T1: PL-AUTH source docs/auth.md § 9 finds no heading; T2: sources docs/old.md is missing. The task was added anyway; fix a plan source with ravenseat plan edit, a task link with ravenseat edit <id>.
```

The task is added (or changed) anyway, with the same exit code. `edit` checks only when the edit writes `plan`,
`sources` or `source`, so an unrelated edit says nothing about an older link. With `--answer-json`, `add` and `edit`
print one JSON line instead of the text, and the problems are in its `linkProblems`
(`[{ "id", "problems": [{ "kind": "dead"|"anchor"|"ignored"|"plan", "path", "anchor", "from" }] }]`). An anchor is a
section number (`§ 3.2`, the most stable) or heading text (`#sync`), found the same way as in the mission.
`links.addWarn: false` turns the check off. Links that broke later are counted by the `links` row in
`ravenseat doctor` (`links.doctor`), and `ravenseat plan check` names a plan source whose anchor finds no heading.

**In the mission.** When the mission is made (`fill`, `trackFile` and `make-mission.mjs`), the task's reading
material comes first in its "Read these in your first turn" list, with an anchor as a line range
(`docs/auth.md:41-80`). The mission's own paths fill what is left under the same cap of 12. A task's own `sources`
replace the plan entry's sources; a source without a role counts as `plan`, and `history` and `reference` are left
out. A file the agent's worktree will not have (gitignored, or not committed at the mission's head) gets its
absolute path in the main tree, also when the mission text names it. A file under `privatePaths` with
`"read": false` never gets a path: the mission has a line saying it is private and that the agent asks the
orchestrator for an excerpt. A task without `plan` or `sources` reads nothing extra, and neither does a path in
`source`, so its mission stays as it was. The orchestrator looks the links up when it writes the track block (as
`READ:` and `PRIVATE:` lines above the `## TRACK` heading); the track agent never reads the register or private
files for this.

**In the board's panel.** The detail panel lists the task's own `sources` under Details, each path with its anchor
and role, between the plan entry and the origin `source`. The plan entry's own sources are in the Plans view, one
click away from the plan entry chip.

Status flow: `proposed` → `waiting` (approved, ready to run) → `running` → `review` → `done`, or `cancelled`. Tasks
added by an agent start as `proposed` and need `approve`; tasks the owner or the orchestrator adds start as `waiting`.
A track adds from its own worktree: the queue sets `added_by` from the branch, refuses `--approved` and allows 3 open
proposals per track. The small-task guard does not apply to it and `batched` is dropped, since the owner decides the size when approving. In full mode too, its proposal needs only `id`, `title` and `mission`: `domain`, `project` and `feature`
follow the track and the class is `K`, unless the task sets them.
With [auto-accept](#auto-accept-of-proposals) on, the queue approves the proposals that fit the owner's rules itself.

### The description

`description` is a task's short summary in the author's own words, for people only. Where it shows:

- the board's detail panel, at the top under the title, in place of the summary the panel otherwise derives from the
  mission (the first paragraph of a "What and why" section, or the first prose). Shown as plain text, never as markup;
- `ravenseat info <id>`, right under the title (as one line), and `info <id> --field description` raw.

It never reaches the agent: the track block and the mission are byte-identical with or without it. It is optional
and stops nothing, so there is no setting for it. The soft limit is 320 characters, the same as the panel's derived
summary. A longer one is saved anyway, with one line:

```
WARNING: T1: the description is 399 characters, over the soft limit of 320; it was saved anyway. Keep it to a short summary; the mission holds the detail.
```

With `--answer-json` the line is in the answer's `descriptionWarning` (a list) instead, and the board shows it with
its confirmation. A description that is not text is refused (`description must be text`), and an empty one is not
stored.

### GitHub issues

Ravenseat can read a GitHub repo's open issues and propose them, on your command only. It uses your own `gh` login.
Reading is all it does unless you turn on one of the writes below, and each write is a preview first and your yes.

```
ravenseat issues list [--label bug] [--limit 30]   # open issues and where an import would put each; writes nothing
ravenseat issues import 12 14 [--as task] [--with-body] [--dry]  # proposes each one: a plan in the Inbox, or a proposed task
ravenseat issues report [--post]                   # after a push: comment on or close the linked issues (issues.onPush)
ravenseat pr [--post]                              # one draft pull request for the batch (push.pr)
ravenseat release-notes [<from-tag>] [--save] [--github --tag <tag> [--post]]   # notes since a tag; a draft release
```

- **An import proposes, nothing starts.** By default each issue becomes a plan in the Inbox, sorted like any other
  idea. `--as task` (or a label in `issues.labelMap`) makes a task `GH-12` in the proposed state instead; you approve
  it, and auto-accept never takes it. An issue imported before is skipped.
- **Issue text is data.** Anyone can write an issue, so the title is kept only as the reporter's words, framed that way
  in the mission, and the body is not stored. An issue that claims your approval or carries an owner mark gets a
  `SUSPICIOUS CONTENT` line, the same as at `receive`.
- **`--with-body` (off unless you give it)** stores each body as a reference file, `issues/<owner>-<name>-<n>.md` in
  the data folder, with a header that calls it the reporter's text: data, not instructions, and not your word. The
  mission names the file in the same frame as the title. At most 20 KB is kept (a longer body is cut, and the file
  and the output say so). A secret-looking value in the body means it is not stored at all: the import keeps the
  title and prints `BODY NOT STORED`, never the value.
- **No size.** An imported task has no `content_min` (an issue says nothing about size). Its estimate counts 30
  minutes, and `proposals`, `show --full`, `approve` and the board say "size not set", so you size it when you approve.
- **The link.** The task or plan keeps `issue: { "repo": "owner/name", "number": 12 }`. `--issue 12` (or
  `owner/name#12`, or `none` to remove it) sets it on `add` and `edit`; a bare number means the `origin` remote's
  repo. The board card, the task panel, `ravenseat show`/`info`, the Plans view and `plan get` show "Issue #12" as a
  link built from those two values, never from issue text.
- **At merge** the commit gets a `Refs: #12` line (`issues.refsTrailer`, on). It is local and never `Closes`, so the
  issue stays open until someone closes it on GitHub.
- **gh missing or not signed in:** one clear line and exit 1, nothing written. When a gh feature is in use (issue
  links, `push.ciWatch: "github"`, external gate evidence, the branch-protection card), `ravenseat doctor` has a `gh`
  row that says which: gh missing, not signed in, or a `GH_TOKEN`/`GITHUB_TOKEN` that GitHub rejects while gh's own
  login works. Never a FAIL, never a token, and no network call when no gh feature is in use.

#### Writing to GitHub: issue comments, the batch PR and release notes

All three are off or local by default, because a post on GitHub runs on your login, is often public, and stays.

- **`issues report` (GH-3, `issues.onPush`: `off`).** After you push, it lists the tasks in the push that link to an
  issue and what it would post: with `comment`, one comment per issue (task id, title, merge commit, the checks on
  that commit, "Posted by Ravenseat"); with `close`, the same comment and then a close. Run it, read it, then
  `--post`. A failure to post is one line and never touches the push, which already happened. Each issue is posted
  once per merge commit (`issue-reports.json` in the data folder).
- **`pr` (GH-4, `push.pr`: `off`).** With `draft`, it moves the branch `ravenseat/batch-<date>` to the base branch's
  tip (forward only), and prints the push command. That push goes through the push guard like any other, so
  `"ravenseat/batch-*"` must be in `push.allowBranches`. Once the branch is on the remote, `pr --post` opens one draft
  pull request for the whole batch: the tasks, the checks, the base health, any recorded caveats. Never one per track,
  and an open one is not opened twice.
- **`release-notes` (GH-5, no setting).** Writes a local draft of what was merged since a tag (the latest by default),
  grouped Added, Changed, Fixed and Hardened by the task's labels and kind, with Changed when nothing says otherwise.
  Investigations and unfinished tasks are left out. `--save` writes it to `release-notes/` in the data folder. `--github --tag v2.0.0` previews a draft release, and `--post` creates it as a draft: never published, never
  marked latest. You publish it on GitHub.

**The outbound guard** (lib/ghOutbound.js) is the same for all three:

- The text is a fixed template. Titles go in code spans, so no `@mention`, link or image renders, and a title is cut
  at 120 characters.
- A secret-looking value, a private path or a home folder path in the text BLOCKS that post (the output says which
  rule, never the value). So does an empty text. A scan that fails blocks too.
- The preview lists exactly what will be posted and says so when the repo is public. `--post` posts only what the
  last preview listed, within an hour of it; anything else and it refuses and asks for a new preview.
- In a terminal, `--post` asks y/N. In a Claude Code session the push guard asks with the approval dialog (rule
  `outbound-github`, `approvals.ask`), which names the targets and the repo's visibility; in `dontAsk` and
  `bypassPermissions` it is denied, so run it in your own terminal. With `approvals.ask` off and no terminal, it refuses.
- A queue agent cannot run any of the three (the push guard denies it), and on a queue branch or a worktree the
  command refuses by itself.

Two-way sync, issues as the source of truth, webhooks and other trackers are not built (catalog D-0004).

## The done command and the fix-round cap

`done_when` is a command the owner or the orchestrator picks, so "done" means more than the track's own RESULT line.

- **The mission** states it (`**Done command (binding):**` in the track block): the track runs it from its worktree
  root before it reports DONE.
- **`ravenseat receive <id>`** runs it first, through the shell, in the worktree that has the track branch checked out
  (`--done-cwd <folder>` overrides; with no such worktree receive stops and changes nothing). A PARTIAL delivery is
  not checked. Green: receive goes on as before and saves `done_check` (`ok`, `exit`, `tip`, `step`, `at`, and `zeroTests` when its output says no test ran).
  Red, or over the time budget: no review package for reviewers, the blocker `gate-red`, and a fix round
  (`ravenseat resume <id> --reason fix`, run by receive) whose brief carries the command and its last output lines. Exit 1.
- **`ravenseat merge <id>`** runs it again unless the last green run was on the same branch tip with the same command. Red
  is handled as in receive, and nothing is merged.
- **Only the tail is kept** (`doneCheck.tailLines`, default 40 lines, each cut to 400 characters) in
  `<scratchpad>/done-<id>.md` and the fix brief; the full output is never stored, so a secret printed early in a
  long run is not copied around. The tail is redacted before it is cut (`lib/storeText.js`, the shared route for agent
  text on disk; a redaction that fails stores `[withheld: ...]`, never the raw text). Every module that stores agent
  text is listed in `lib/sinkRegister.js`, and a guard test fails when a new one is not. `doneCheck.timeoutSec` (default 600) is the time budget per run. On Windows a
  timeout stops cmd.exe; a process it started can live on until it ends by itself.

**The fix-round cap.** Every `ravenseat resume <id> --reason fix` counts (the task's `resumed` list; a `context`
continuation does not). At `max_fix_rounds` (the task) or `maxFixRounds` (the config, default 3) the queue stops
retrying by itself and asks the owner the usual way: it registers the owner question `<id>.fixcap<N>`, puts it in
the task's `waiting_on` and opens the blocker `owner-question`, prints `FIX-ROUND CAP` and exits 8 (`receive` and
`merge` pass the 8 on). `ravenseat resolve <id>.fixcap<N> --answer "…"` allows exactly one more round, and the answer is in
its brief; the next one asks again. A higher cap: `ravenseat edit <id> --json '{"max_fix_rounds": 5}'`; giving up:
`ravenseat set <id> cancelled`.

**The fix-round plateau.** Before a fix round the queue also asks the owner, the same way, when the previous fix round
committed nothing (the branch tip did not move) or the check fails exactly as before it (same kind, exit and output
tail; durations, clock times and shas do not count). The question is `<id>.plateau<N>` and the output says
`FIX-ROUND PLATEAU` (exit 8). The cap is checked first, and a round the owner allowed past the cap is not asked again.
Each fix round saves `tip` and `signature` in `resumed`, so the next one can compare. `"fixPlateau": false` in
`queue.config.json` turns it off.

**The gate cannot run.** A red quick gate at `receive` whose own first program is not found (sh exit 127 "not found",
cmd.exe "is not recognized" or 9009, PowerShell "The term ... is not recognized", spawn ENOENT) is run once more on the
base (the main checkout, at most 30 s). When the program is missing there too, no agent can fix it: `receive` prints
`GATE CANNOT RUN`, registers the owner question `<id>.nogate<hash8>` (the first 8 hex of the gates setup hash), keeps
`gate_broken` on the task and exits 8. The same setup asks once; a changed `gates` setup forgets the verdict. A program
missing only inside a script (`npm run lint` without eslint), "Cannot find module" from the track's code, or a base that
runs the command gives the fix round as before. Answering the question allows a fix round. `gates.brokenVerdict: false`
turns it off.

### The finish line is locked after the start

`done_when` and `acceptance` are fixed before a task starts and checked by someone else than the track, so a track
cannot move its own finish line ("implementation complete" is the track's claim, "verified complete" is the gap
reviewer's verdict against criteria the track could not change).

- **Before the start** (status `proposed` or `waiting`, no `started` time) anyone may change them, as any field.
- **After the start** (`running`, `picked`, `review`, `done`, `cancelled`, or a `started` time kept after a release)
  `ravenseat edit` and `ravenseat undo` refuse a change unless `--by owner` (or the board, which passes `--by theBoard`). Anyone
  else gets `done_when is locked after start; ask the owner (ravenseat question)`, and nothing is written.
- **From inside a track worktree** (the cwd is on a `<branchPrefix><id>` branch, `queue/<id>` by default) the change
  is refused whatever `--by` says, before or after the start: `--by` is only a name, and a track can type it too.
- An edit that sets the same value again is not a change, and other fields in the same edit are not affected by the
  lock (an edit that touches a locked field stops as a whole).

The lock is a guard against a track editing its own criteria, not an access control: a session in the main tree can
still pass `--by owner`, and the changelog (`ravenseat undo --show`) records who did.

## Plan quality before and during a track

### Plan review before a risky task

A wrong data model or file boundary is cheapest to find before a 40 to 120 minute track starts on it. Before `fill`
starts a risky task, the intake triage's step (see [orchestration.md](orchestration.md#intake-triage)) also checks the
plan against the code with a fixed checklist, in one pass: data model and migrations, public interfaces and file
formats, irreversible steps, file boundaries (a file the change needs that the task does not own), and assumptions the
mission makes that the code contradicts. Only notes with `file:line` count.

- **Risky:** the class is in `planReview.classes` (default `["D+"]`), or the task meets an accepted sensitive zone
  ([catalog.md](catalog.md#sensitive-zones); none by default). Never a fix task or a continuation.
- **The answer:** `PLANREVIEW ok|notes|ask`, recorded with `ravenseat triage <id> --plan <ok|notes|ask> --plan-note "..."`
  (with or without `--verdict`). `notes` go into the mission as an addition; the task then starts.
- **`planReview.mode`:** `advisory` (the default; an `ask` is a note too), `block` (an `ask` becomes the owner question
  `planreview-<id>` before the start; off by default because it stops work) or `off`.
- `ravenseat info` and the board's detail panel show the result (**Plan review**). Friction: one short read-only agent run
  per risky task, and no other wait.

### Riskiest assumption first

`risk_first` (optional, one sentence) names the assumption that would sink the plan and how to check it. The mission
then tells the track to check it first, in at most about 20 minutes, and to write `RISK held` or `RISK failed` in its
report; if it failed, the track stops and delivers PARTIAL with one owner question instead of building on a guess. A
task in an accepted sensitive zone without `risk_first` gets the default "prove the choice can be reversed before
building on it". Set it with `ravenseat add ... --risk-first "..."` or `ravenseat edit <id> --risk-first "..."` (`""`
removes it); it is locked after the start like `acceptance`. Setting `mission.riskFirst` (on by default) to false turns the block off. Without the
field (and outside a zone) the mission is unchanged.

### Checks before a task starts

`add` and again `start` / `fill` print one WARNING line per task when something is cheap to fix now and expensive
after a track: a repo path the mission names that the task does not own, share or read (at most five named, plus "and
N more"; only real paths with an extension or in the tree, never links or prose), a K, D or D+ task with no
`owned_files`, and a D or D+ task without `content_min`. Such a task is stored with `content_min: null`: the estimate
still counts 30 minutes for planning, and `show`, `info`, `start`, `fill` and the board say "size not set". At
`receive`, an `ownerQuestions=<n>` on the RESULT line that does not match the items under the report's owner question
heading gives one NOTE. None of these ever stops a task; each has its own `planChecks.*` setting (all on). Lite mode
skips the two ownership checks.

### Decided for you

Agents are told to ask before a choice that is hard to undo. At `receive`, Ravenseat reads the delivery's diff for the
ones it can see (no tokens, never a stop): a new package, a migration or schema file, several deleted files, and a big
change with no Assumptions. Each is marked **not asked** when no owner question in the report names it, and one
`SIGNALS:` line says so. The existing stops (the merge guard on dependency files and migrations) stay as they are.

**Decided for you**, next to **Decided today** in Decisions and under `ravenseat decide --today`, lists these and the
proposals your rules approved (`ravenseat proposals`), each with what, the category, who decided ("Approved by your
rules" or "The agent decided"), when, and the cheapest way to undo it from where the task is now: `ravenseat proposals
undo <id>` before the start, a cancel after it, a fix round before the merge, a revert after it. It is never counted as
waiting on you. Settings: `decisionSignals.*`.

### Door and blast radius

Every track report has two lines: `Door: one-way` or `Door: two-way` (one-way: hard to undo once merged or used) and
`Blast radius: <one word>` (what breaks if it is wrong). `receive` reads them from the report (else the answer), prints
one `DOOR:` line, puts them in the review package and stores them on the task (`merge_danger`); a missing or malformed
line is **not stated**, never a refusal. The main reviewer writes its own two lines, and merge records them. A Check or
review card in Decisions, `ravenseat decide`, Decided for you and the `ravenseat pr` body show them; a one-way door gets
the badge **One-way door: hard to undo** and comes first within its group, and a reviewer who disagrees is shown next to
the track's call, not resolved. The agents write these lines, so they are **never a guard**: nothing is blocked,
approved or merged because of them. Always on, no setting (two lines per report).

## Everyday commands

| Command | What it does |
|---|---|
| `init` | Creates an empty queue (run once per project) |
| `add --file task.json` / `add --json '{…}'` [`--description "…"`] [`--answer-json`] | Adds one task or a list. One `WARNING: task links` line names a dead link, an anchor without a heading or a gitignored source (the task is added anyway; see [Task links](#task-links)). `--description` sets the [description](#the-description) of the one task added, `--risk-first "…"` its [riskiest assumption](#riskiest-assumption-first). `--answer-json`: one JSON line instead of the text, with `linkProblems` (and `descriptionWarning` when a description is over the soft limit) |
| `decide [--json] [--max N]` / `decide --today` | Everything waiting on the owner (questions, QA, proposals, stuck work) as one list, most impact first, each answer with its exact `ravenseat` command; read only. `/ravenseat:decide` walks it one decision at a time / what was decided today, and [Decided for you](#decided-for-you) |
| `approve <id> [--by owner]` | Approves a proposal (`--by` records who) |
| `proposals [auto [on\|off] …]` / `proposals log` / `proposals undo <id>` | Lists the proposals waiting, and auto-accept of proposals by the owner's rules (default off) / what was auto-accepted / back to proposed (see below) |
| `forecast [--project <pid>] [--days 28] [--json]` | When the remaining tasks are done at 50, 85 and 95 % (Monte Carlo, see below) |
| `schedule [--json] [--next <n>]` | The queue played forward: per focus step the expected end and the task count, the next tasks with a rough start and length; read only (see [Schedule](#schedule)) |
| `show` / `show --full` | Short view (under about 3,000 characters; names up to 5 proposals with the track they came from) / full table |
| `next` | What can start now, without changing anything |
| `triage` / `triage <id> --verdict ready\|done\|stale\|adjust [--note "…"] [--plan ok\|notes\|ask --plan-note "…"]` / `triage <id> --prompt --scratchpad <dir>` | The tasks that need an intake verdict or a plan review before they start / record the triage helper's verdict (done and stale become an owner question, adjust adds the note to the mission) and its PLANREVIEW line (`--plan` alone works too; see [plan review](#plan-review-before-a-risky-task)) / write the triage prompt again (see orchestration.md, Intake triage) |
| `fill --scratchpad <dir>` | Starts as many tasks as the limits allow and writes the mission prompts |
| `receive <id> [--full-review] [--all]` | Receives a finished track: reads the RESULT line, builds the review package. After a fix round the package holds only the commits since the last review, with the previous findings; the same reviewers. `--full-review` gives the whole package. The scope facts and the proposed catalog choices are one summary line each, with the details in `00-package.md`; `--all` prints a line per fact |
| `deliveries` | Tracks with a `track-result.md` (RESULT line on top) that is not received yet; the pulse prints new ones as `NEW DELIVERY` |
| `resume <id> --reason fix\|context [--new-agent]` | Writes `prompt-<id>-r<N>.md` for a new agent on the same branch (fix round or continuation of an adopted track). A fix round first tries to continue the agent that delivered: `CONTINUE`, the brief `fix-<id>-r<N>.md` and a SendMessage line, when it was active within `fixRound.continueWithinMin`. `--new-agent` skips that. A new fix agent gets a short mission with a pointer to `mission-<id>.md` |
| `merge <id>` | Merges the track branch into the base branch (after review). A migration file from a task without a migration block stops at the merge guard (exit 4), also with no migration flow configured, and is never pushed by itself. Exit 9: the base branch is red (the base gate, see orchestration.md; only its fix task merges, `--force-red-base` overrides and is logged). Exit 4: the merge guard stopped it (protected paths the task does not own); `--allow-guard` overrides. Exit 1: the quick gates were red at the last receive (`gate_check`): a fix round, or `ravenseat receive` again when commits came after it; `--force-red-gate` overrides and is logged. A PARTIAL delivery stops the merge unless you pass `--allow-partial` (on the owner's word, logged); a later round that delivers DONE clears the stop. With `--allow-partial` the merge, the migration push, the gates and fill run as usual, but there is no done step: the task stays in review with a remark that the rest remains, `delivered_partial` stays set, the track branch and worktree are kept, and tasks that depend on it stay waiting (no cost measurement, no focus cleanup either). Continue the rest with `ravenseat resume <id> --reason context`, then `receive` and `merge` again; a second `merge` or `merge --resume` before that says so and changes nothing |
| `undo <id> [--dry] [--yes]` | Takes a merged task back out of the base branch. Finds its merge commit (`merge_commit`, else the merge log), shows the files and the later tasks or commits that share a file or depend on it, asks y/N (`--yes` for scripts, `--dry` only shows the plan), then `git revert -m 1` as one new local commit: never force, never a rewrite, never a push. The task goes back to `waiting` with a note, and the base gate runs on the new tip as after a merge (red: exit 9 and a fix task). Refused with nothing changed in a track worktree, on another branch, with uncommitted changes, while a merge runs or git has an operation in progress; a revert that conflicts is aborted with the steps by hand. Bare `undo` is still the changelog undo, and its text form starts with one line saying so and pointing here. It is in the lite help too |
| `wiring <id>` / `wiring <id> <item> --commit <sha>` / `wiring <id> <item> --reject "<reason>"` | The task's wiring items from the track's `WIRE` lines, and closing one: done in a commit that is in the base branch and changes the item's file, or rejected with a reason (required). `done` waits until none is open (`wiring.stop`); logged, so `undo` takes it back |
| `review-item <id>` / `review-item <id> <item> --commit <sha> \| --task <id> \| --batch \| --reject <code> --note "<sentence>"` / `review-item <id> --defer-all-L` | The task's review items from the reviewers' `FINDING` lines (`<reviewer>#<round>:<code>`), and closing one: fixed in a commit in the base branch that changes the item's file, placed in an unfinished task or the `review-rest` batch task, or rejected with a code and one sentence. `--defer-all-L` moves every open LOW that may wait into one batch task. Each close writes a finding log row. `done` waits until none is open (`reviewItems.stop`); logged, so `undo` takes it back |
| `set <id> <status>` | Sets status by hand. `done` warns (never stops) when the task never started or its branch has commits that are not in the base, names the tasks it frees and gives the way back (`set <id> review`, then `merge <id>`) |
| `cancel <id> [--remark "…"]` | Cancels a waiting or proposed task (decline a proposal with `--remark "declined: …"`); logged, so `undo` puts it back. Running and review tasks: `set <id> cancelled` |
| `edit <id> --json '{…}'` [`--answer-json`] | Changes fields (logged; `undo` rolls it back). An edit that writes `plan`, `sources` or `source` gets the same task links line as `add`; `--answer-json` carries it as `linkProblems` |
| `edit <id> --description "…"` | Sets or replaces the [description](#the-description); `--description ""` removes it. Logged like any edit |
| `edit <id> --risk-first "…"` | Sets or replaces the [riskiest assumption](#riskiest-assumption-first); `--risk-first ""` removes it. Locked after the start (`--by owner` on the owner's word) |
| `info <id> [--history]` | Short view of one task: the description under the title, `fixes` and `fixed by` when it has fix links, and its links (`plan`, `sources` with anchors and roles, and the origin `source`). `--history` (`--json` for data) lists what happened with it, oldest first, the same list as the board panel's History |
| `explain <id> [--json]` | Why one task stands where it stands, from the rules the queue starts by: what blocks a waiting task (dependency, owner question, file or DB conflict, parking, focus, an uncommitted file), a stop on the whole queue, the full limits and its place among the startable ones; for a running task when it started, the round, an open block and the last sign of life with its source, SILENT over `silentMin`. Read-only |
| `question` / `resolve <q> --answer "…" [--early]` | Owner questions / answer one (waiting tasks get the answer in their mission). A question with `after` (a [checkpoint](plan-register.md#staged-queueing)) stays hidden until those tasks are done; `--early` answers it before that |
| `question <q> --text "…" --choice "…" --choice "…"` / `resolve <q> --choice <n\|text> [--answer "note"]` | Answer options on a question: 2-4 choices, each at most 60 characters, no duplicates (`--no-choices` removes them; in an add file: `"choices": [...]` under `question`). The order is kept as written everywhere, so the number is the `--choice` number; give `--recommendation` the exact text of one choice to mark it. The stored answer is the choice's text, plus ` (note: …)` with `--answer`. `ravenseat question` and the after-compact summary list the choices numbered, and the board shows them as buttons (the recommended one as "As recommended: <choice>"). `--context "…"` (optional, `"context"` in an add file) is the background, why it is asked, kept apart from the question text; the board shows it under the recommendation, and `null` removes it |
| `question <q> --text "…" --category <key> --context "…" --if-yes "…" --if-no "…" --recommendation "…"` | The card fields. A NEW plain question (type `question`) from `ravenseat question` or `add` needs all of them: the category (one of the keys in `ask-catalog/categories.json`: legal, security, architecture, database, dependency, delete, product, followups, ui, technical), the context (at most 600 characters), the recommendation (one of the choices when there are choices), and what follows if the owner takes the recommendation (`--if-yes`) or not (`--if-no`), each at most 300 characters and not the same. A missing field is refused with the list of what is missing. Old posts, system questions (CI, merge, focus, plan review) and the types condition, lawyer and owner-task are exempt and show as uncategorized. The question records the track that registered it; receive compares that with `ownerQuestions=<n>` and marks the rest "Not filled in by the agent" (a NOTE, never a refusal). Each answer (resolve, approve, decline, qa) writes an `event: "decision"` row to the time log (category, recommended, chosen, followed, by, surface, bulk; free text is never stored), and `resolutions[<q>]` gets `category` and `followed` |
| `wait [--debounce <s>] [--timeout <h>] [--since <log-nr>] [--check-min <n>]` | Every `--check-min` minutes (5, 0 = off) it also checks the tracks: a track no agent took or a silent one gives `TRACKS NEED A LOOK: ...` and exit 11, once per finding. Blocks until the owner acts (resolve, approve, `qa ok`/deviation, add, an answer through `resume --by owner`, or a logged edit by `owner`/`theBoard`) after the end of the changelog when it started, waits `--debounce` (30 s) for more, prints `OWNER ACTED: resolve Q12, Q14; approve T-40` (ids only) and `run: ravenseat resolutions --unlogged`, exit 0. `TIMEOUT` after `--timeout` (8 h), exit 10. One at a time: a second one prints `ALREADY WAITING (pid n)`, exit 0. The orchestrator starts it with `run_in_background` when only owner items are left (see orchestration.md, The loop). `ravenseat set` and a `resolve` without `--by owner` are not detected |
| `settings [<category>] [--advanced] [--all] [--changed] [--json]` | Every setting from the settings registry, by category: the value, the default and where it is saved (`(you)` = queue.json, only for you; `(project)` = queue.config.json, commit it). The first line names the guards weaker than the default. Basic rows only; `--advanced` adds the advanced ones, marked `[advanced]`. In lite, the full-only rows are counted on one line per category, and `--all` shows them with the reason. `--changed` lists only what differs from the default. Read-only |
| `settings <key>` / `settings <prefix>` | One setting in full: title, group, level, the value now and where it comes from (queue.config.json, queue.json or the default of the mode), the defaults in lite and full, the values it takes, the explanation, what it protects against, what it needs (and "No effect now" while that is off), whether a value weakens a guard (with why not and what changes) and the command that changes it. A name space such as `learning.` or `readGuard` lists its rows. An unknown name names the nearest keys and exits 1. Read-only |
| `settings set <key> <value> [--i-understand --by owner]` | Changes one setting with edit `set` in the file its row names: queue.config.json keeps its form (key order, indentation, the rest of the text), queue.json is written under the lock. A value that weakens a guard (for example `secretScan.enabled off` or `gitSurface warn`) prints what the guard protects against, why not, and what changes, writes nothing and exits 1, unless you add `--i-understand --by owner`; then a `setting-weakened` row (key, old and new value, who) goes to the time log. A stronger value needs no flag. Refused from a track worktree, and the push guard denies it to queue agents. The older commands that write a setting follow the same rule through the same code: `proposals auto on` needs `--i-understand --by owner` too (also logged as `setting-weakened`), and so would `limit` or `cloud set` for a value whose row weakens a guard (none does today). `ravenseat doctor` names every guard that is weaker than its default on its `settings` row |
| `limit [<name> <value>]` | Limits: `maxConcurrent`, `maxDPlus`, `maxPerDomain`, `dailyBudget`, night window, `minFreeMemoryPct`, `silentMin` (minutes before a running track is SILENT; default 20, 0 = off), `noAgentMin` (minutes before a track marked running with no agent is NO AGENT; default 15, 0 = off) |
| `block <id> <code> [--note "…"]` / `unblock <id>` | Opens / closes a blocker reason on the task (`blocks`; one open at a time). Codes: `merge-conflict`, `merge-guard`, `merge-stopped`, `gate-red`, `context`, `quota`, `owner-question`, `track-question`, `dependency`, `no-agent`, `silent`, `other`. `merge` opens `merge-conflict` or `gate-red` when it stops in that step and closes the open one after a successful merge |
| `blockers [--days 7] [--json]` | Per blocker code: count and blocked time in the period, top first |
| `next-migr [<n>]` / `migr move <id> <block>` | Migration flow only: show or set the next number / move a task's block in the queue and its prompt files |
| `cost [--since 7d] [--max 10] [--json]` | USD per merged change for the window first (see [Cost estimates and calibration](#cost-estimates-and-calibration)), then cost per task with all its runs (track, fix rounds, continuations, reviewers, fix tasks) by cost, then where the cost went (the orchestrator session as its own line, the unknown share by its source), week over week with n, per turn against the 14-day median per agent type (the 2x warning), and cost per class (n, median, sum, build/review/fix) by start date from the measured track sessions |
| `cost --reads [--since 7d] [--limit 15] [--json]` | Only the files tracks most often read whole (a Read with no offset, limit or pages), across tracks: per file the tracks, the whole and excerpt reads and the size now, by tracks then reads. Candidates for a catalog excerpt or a split; see [Whole-file reads](costs.md#whole-file-reads). Display only |
| `calibrate [--days 28] [--min 5] [--json]` | Per class: how far the minute estimates and the cost model are off, and the suggested correction (read-only) |
| `projects`, `project <pid> …` | Projects: progress, pause, prefixes |
| `focus set <steps> [--rest fill\|wait] [--continue-when-empty on\|off]` | Focus period: only these steps are started. `--rest` says what happens to the tasks outside the steps: `fill` starts them when the focus leaves a slot free, `wait` does not start them until the focus changes, so slots can stay empty. Without `--rest` a new focus takes `focus.restDefault` in queue.config.json (default `fill`); an explicit `--rest` wins, and a focus already set keeps its own value (also when the board saves it without a rest). When the focus has ended (every step done, or `--to` passed), `focus.continueWhenEmpty` in queue.config.json decides (default off): off pauses the queue (fill starts nothing, `focus.finished_at` is stamped, and one owner question "set a new focus or continue the regular queue?" appears in Waiting on you; answering "Continue the regular queue" lifts the pause), on continues as without focus with one line. `--continue-when-empty` overrides it for this focus; `ravenseat focus` shows the setting. A project that never set a focus is not affected. A step is `area:<oid>`, `project:<pid>`, `feature:<pid>/<name>` or `task:<id>` (one task); when a task matches more than one step, the most specific wins (task, feature, project, area) |
| `focus add <step\|id> [--at <n>]` / `focus remove <step\|id>` | Adds one step to the focus or takes one out, in place: the rest of the list and the focus settings stay as they are. A bare task id means `task:<id>`. `--at` is the 1-based place (default: last). Adding a step that is already in the list changes nothing and says so. An unknown step or task id, `--at` out of range, a step that is not in the list, no focus set (use `focus set`) and the last step (use `focus off`) are refused with exit 1 and nothing changed. One changelog entry, so `undo` takes it back. A task step whose task is done leaves the focus by `focus clean`, as any done step. `focus add` takes several steps too: they go in together at `--at`, in the given order, as one changelog entry, and a step already in the list is skipped and named. `--json` answers with one JSON line and `--expect-changed <iso>` refuses with exit 6 when the queue has changed since (the board's card actions use both). The step limit: a focus has at most 500 steps, the same sanity cap for `focus set`, `focus add` and the board's Save focus (`focus save`), each refusing with the same message ("a focus can have at most 500 steps; put a large group in one broader step ..."); it is not a setting. One board save takes at most 50 pause changes |
| `focus evaluate [--json]` / `focus clean [--dry]` | Each step as active, done-with-rests (batch queue, proposals, owner questions, QA, with a suggestion per rest) or done / takes out the done steps (history and changelog, so `undo` works; the last step stays). `receive`, `set <id> done\|cancelled`, `qa ok` and `fill` clean automatically (so the owner question about a finished focus comes right after the last QA), and the board hides done steps |
| `park <id>` / `continue <id>` | Park / unpark |
| `pick <id> --by "<who>"` / `deliver <id>` | A person or a separate chat takes a task by hand / delivers it |
| `diagnose` | Why the queue runs fewer tracks than it could (with suggested fixes) |
| `finding "<title>" [--detail] [--task] [--cause <id>] [--files a,b]` / `finding list [--all]` | A track reports something outside its scope: an idea in the plan register, linked to the task and deduplicated on the title ([plan-register.md](plan-register.md#findings)). `--cause` names the merged task it is a defect of. Pulse and `show` count the new ones |
| `doctor [--json]` | Read-only health check, one OK/WARN/FAIL line each with a fix hint: Node and the `node` the hooks find on PATH, the hooks file and its scripts, `queue.config.json` keys and types, the state files, a stale lock, half-deleted worktree folders under `.claude/worktrees/` and git worktrees whose folder is gone, branches of finished tasks, CI cost, and the safety baseline (secret files in git or not ignored, empty gates or gates that check nothing (`exit 0`, `true`, an `echo`, also behind an npm script), a gate whose program is not found on PATH (`pytest -q` without pytest; a warning, the gate is never run), no CI config, a manifest without its lockfile, `productionBranch` equal to `baseBranch`, tracked files over `largeFileMb`; offline), no daily budget set (a WARN that only recommends `limit dailyBudget <usd>`; quiet guidance hides it), and the temp folder's entries per prefix. The `settings` row names in one WARN line every guard weaker than its default (the registry's weakening rule, the same list as the banner of `ravenseat settings`), with an INFO line for what lite softens (`gitSurface`, `dependencyFiles`) and one per `protectedPaths.remove` entry; quiet guidance never hides it. The row about `disableAllHooks` in a Claude Code settings file is called `hooks-off`. Exit 1 on any FAIL |
| `tidy [--execute [--yes]] [--demo] [--json]` | Merged worktrees and branches left behind. Read only by default: every worktree `git worktree list` knows, wherever it lives (not only `.claude/worktrees/`), with merged or not, clean or not, locked, and the active task that uses it; the merged `<branchPrefix>` branches with no worktree; the demo folders (`*-demo`, `*-shots` next to the worktrees); counts and size per group. `--execute` removes only worktrees that are merged, clean, not locked, used by no active task and older than `tidy.minAgeHours`, plus the merged branches with no worktree, after a y/N question (`--yes` skips it; no terminal and no `--yes` deletes nothing). Per worktree: the shared links (`sharedLinks`) are removed as links, a folder with any other link inside is skipped and named, then the folder, `git worktree prune` and `git branch -d` (never `-D`, never `git worktree remove`). Never the main checkout or the worktree it runs in. `--demo --execute` removes the demo folders by the same rules. Clean-gate copies (GOS-1) are not built yet, so they are only counted |
| `issues list [--label <name>] [--limit <n>]` / `issues import <n...> [--as task\|plan] [--project <pid>] [--dry]` | GitHub issues through your `gh` login, read only and on command only: list shows open issues and where an import would put each; import proposes each as a plan in the Inbox or a proposed task, with the issue link ([GitHub issues](#github-issues)). Main session only |
| `machine [--measure]` | Cores, memory, free memory now and a suggested `maxConcurrent`, an estimate that changes nothing. `--measure`, started by you and refused while a track runs: `gates --full` once, then the time, the lowest free memory and a suggestion for this project |
| `state` | Machine-readable state (exit 3 when there is nothing to do) |
| `pulse-check [--session "<name>"] [--scratchpad <dir>] [--include-owner]` | The pulse in one read-only call, for a repeated or scheduled pulse: exactly `SILENT` (exit 0) when nothing needs the orchestrator, otherwise `ACTION: <n>` (exit 13) and one line per item with the exact next command (`RECEIVE`, `NO AGENT`, `SILENT`, `START`, `RUN`, `WIRING`, and what only `orchestrator pulse` acts on: `CLOUD`, `CONFLICTS`, `AUTO-ACCEPT`, `INSPECTION`). `--include-owner` adds `FOR THE OWNER:` (open questions, finished cloud tracks waiting on a yes), never ACTION. Writes only the orchestrator marker; exit 2 on a usage error (see orchestration.md, A repeated pulse) |
| `undo` | Undo the last write |
| `qa` / `qa ok <id…>` / `qa deviation <id> "…"` | The QA list (split into what to look at, a manual round and auto entries) / the owner approves (and the focus is cleaned in the same write, as `focus clean`: a step with only that QA left leaves the focus, and a focus with nothing left registers its owner question now) / the owner finds a deviation (fix task `<id>-QA<n>`) |
| `qa evidence <id> <type>[=<ref>]` / `qa auto [--run]` | Sets the QA evidence by hand (`receive` reads the `EVIDENCE` line in `track-result.md`) / runs `qa.autoCommand` for auto evidence and closes the green entries |
| `follow [add\|log\|show\|report\|close\|extend]` | Follow-up entries: observations with a start, an end, goals, a log and a fixed report template (see below) |

### Forecast

`ravenseat forecast` answers "when will the remaining tasks be done?" in one paragraph, for example: `Focus "X": 14 tasks
left. 50 %: by Tue 4 Nov (4 days), 85 %: Thu 6 Nov, 95 %: Fri 7 Nov. Based on 31 done in the last 28 days. Expected
cost about 42 USD.` The remaining tasks are the open ones in the current focus steps (with the dependencies they pull
along) when a focus applies, otherwise every waiting, running, picked and review task; proposals, the done and the
cancelled never count. `--project <pid>` narrows it to one project. The method is Monte Carlo: each of 2000 runs draws
a day's throughput (done per calendar day in the last `--days` days, zero days included) with replacement until the
remaining count is reached, and the 50/85/95 % answers are the day counts that share of runs finished within (day 1 is
today). The expected cost is the sum of the calibrated cost estimate of each remaining task (see below), left out when
nothing in the window has a measured cost. With fewer than 5 done in the window it says "not enough data".
The throughput is the whole queue's, also with `--project`. The board shows the same paragraph in the Focus view and
in Statistics. The logic is `lib/queueForecast.js`.

### Schedule

`ravenseat schedule` plays the queue forward with the same ranking and limits `next` and `fill` use (focus steps, score,
maxDPlus, maxDb, owned-file conflicts, `depends_on`, the pause when a focus ends) on slots = the lowest of
`maxConcurrent`, the quota cap `fill` would apply and the load-aware slots. A task takes its calibrated wall time
(`estimateWall`) times the median measured actual/calibrated ratio for its class and size (class + size from 5 done
tasks in 28 days, else the class, else the model alone), never the raw minute estimate. A running task gets the time
left (never below zero; past it, "over its estimate"); an open owner question gets the median answer time (4 hours
until 5 answers are measured) and the task is marked "waits on you"; with `nightRun` off nothing starts in the night
window. What the numbers mean: a focus step's expected end is the last expected end in it, and with many tasks it is
roughly right to 25 to 40 %. What they do not mean: one task's start and end are rough (the middle half of measured
outcomes spans a factor 2.5 to 3), so they are shown relative to now and never as a promised time, and the plan holds only for the queue as
it is now (new tasks that rank in ahead, fix rounds and changes in quota or load are not in it). For when the work is
done with a spread, use `forecast`. `--json` gives every task with `rough: true` and a band. The logic is
`lib/queueSchedule.js`.

### Cost estimates and calibration

Minute estimates (`content_min` x the class weight) are poor predictors: in one large project, over about 830 tracks
finished in two weeks of October, the median actual/estimate ratio of cycle time was 0.33 for K, 1.39 for D, 2.00 for
D+ and 0.70 for U. In the same sample the median measured cost per class predicted cost well (median ratio about
0.97). So ravenseat estimates cost from measured cost, not from minutes:

1. **Class + size**: when the class and size bucket (S up to 30 content minutes, M up to 60, L above) has at least 5
   done tasks with a measured cost (`cost.usd`) in the last 28 days, the estimate is that bucket's median.
2. **Class**: otherwise, with at least 5 in the class, the static model for the task (fixed + content minutes x factor,
   `CALIBRATED` in `lib/logic/base.js`, re-exported by `lib/queueLogic.js`) times the class's median measured/model ratio.
3. **Model**: otherwise the static model alone.

The estimate is shown as `~$x` next to the minute estimate in `show`, `show --full`, `next`, the `fill` lines and
`info` (with where it came from, e.g. `measured, class+size, n=7`). `state` has a `costEstimate` field: the model per
class, what can start now with the estimate each, the sum, and the daily budget outlook. With `dailyBudget` set,
`next` and `show` print a **Budget outlook** line (what can start now against what is left today); the budget guard
itself still stops on measured usage only. The weekly quota forecast (`capacity`, the queue cost) and the forecast's
expected cost use the same estimate. The order of the queue is not changed: the priority still uses the minute
estimate.

`ravenseat calibrate` shows the calibration per class: n, the median actual/estimate ratio for minutes (cycle time started to
done) with the suggested weight, the median measured USD, the model's median for the same tasks, the cost correction
factor, and whether new tasks of the class are estimated from measured data or the model. The suggested weight is advice
only; ravenseat never changes the weights itself. The logic is `lib/costEstimate.js`.

**USD per merged change** is the main cost figure (`ravenseat cost`, and the first key figure in the board's Statistics):

> all measured cost in the window / the queue tasks that reached done in the window

"All measured cost" is every usage event in the time log in the window: the tracks, fix rounds, reviewers and helper
agents of the merged tasks, the work on cancelled tasks, work on tasks still open, and agents that belong to no task.
The orchestrator session is not in this figure (the agent rows cover subagents only); it is the overhead line below. Without
any usage in the time log for the window, the total is the measured task cost of the merged tasks, and the output says
so. `ravenseat cost` uses `--since` as the window, otherwise the last 28 days; the board uses its 14-day window. "USD per
content minute" is shown only as a secondary, estimate-based figure: raising the estimates (the denominator) makes work
look cheaper without anything changing, so it is not a headline.

A fix task (one with `fixes`, or a QA fix task with `qa_original`) is part of the change it fixes: its cost is
attributed to that task, and a done fix task is not counted as a merged change of its own. Without a time log, the
fallback total is the task total of the merged tasks, fix tasks included.

**Orchestration overhead** (`ravenseat cost`, `orchestration` in `--json`) is the main session's own cost, shown apart so it
never hides the track cost. The status line (`statusline.mjs`, set up by `ravenseat setup --settings`) saves the session's
`cost.total_cost_usd` per session id in `<dataFolder>/session-cost.json` and appends a `session` row to the time log
when it grew by $0.50 or more, or 10 minutes after the last row; the compaction hook and the SessionEnd hook
(`hook-session-end.mjs`) add one more row with the last reading. The rows are cumulative per session: each reading adds
its growth since the previous one (a lower reading means the counter started over), and the growth inside the window
is the session's cost there. The session total counts the subagents the session started too (as far as we know), so
their usage in the window (their transcripts are under the session's `subagents/` folder) is subtracted. The rest,
for the sessions bound as the orchestrator, is divided by the same merged changes as the headline and shown as a share
of track cost + overhead; other main sessions are listed apart. Without the status line no session row is written and
the line says so. The payload has no cumulative token counts (only the tokens in the context now), so the rows hold the
cost, the durations, the context size, the model and the quota used at that moment (`five_hour_pct`, `seven_day_pct`,
null without a subscription), so the time log keeps a history of when the quota burns.

**Flow** (`ravenseat cost`, `flow` in `--json`, the cards "Is it right the first time?" and "How much runs without you?" in the board's Statistics) counts rows that the commands append
to the time log (`lib/eventRows.js`, one JSON line each, never failing the command): `fixRound` (ravenseat resume, also when
receive or merge resumes), `mergeConflict` (ravenseat merge stopped in the merge step, with the conflicted file count),
`baseGate` (every recorded base verdict, with the skip rule and the run time), `flakyGate` (a base gate or track gate command red, then green on a rerun on the same sha; a track's has its id as `task`), `ciWatch` (each CI watch verdict), `triage` (ravenseat triage --verdict), `push`
and `load`. The figures: first-pass rate (the tasks done in the window, not fix tasks, with 0 fix rounds in `resumed`),
fix rounds per merged task, merge conflicts per week, base red verdicts, flaky gate commands, pushes per week with merged tasks and commits
per push, and the triage verdicts. **Gates run twice** (`gatesTwice` in `--json`) counts the merges after which the
base gate ran the gates again on the merge commit, with their time, against the ones the skip rule reused the track's
green run for, plus the gate queue wait (`wait_sec` on the gate rows). It reads only rows that exist, so a decision on
batching or rebasing before delivery can rest on numbers (the merge lock never waits: a second merge is refused).

**Quality** (in the same Flow view, `lib/eventStatistics.js`) measures how often work was right, from data the queue
already keeps; a task without a field counts as "nothing recorded", never as an error:

- **Right first time:** a merged task (as for first pass) with 0 fix rounds, no QA deviation, not reopened (a logged
  status change away from done) and no post-merge defect. A **post-merge defect** is a fix task that names the task
  (`fixes`, the QA fix chain `qa_original`, the base gate fix task) or a finding with `ravenseat finding --cause <id>`.
  Shown as a rate and as defects per 10 merged.
- **Owner interventions per 10 merged:** changelog entries by owner or theBoard that change the task between its start
  and done (edit, park, continue, cancel and the like; `ravenseat set` writes no `by`). The changelog keeps its last 50
  entries, so a task started before the oldest kept one is counted as unknown.
- **Autonomy:** *verified tasks per owner intervention* = the merged tasks that were right first time or have every
  defect fixed (each fix task done, no QA deviation open, not reopened), divided by the owner interventions ("no
  interventions" at 0). *Longest stretch without the owner* = the longest time in the window when work ran (some task
  between its start and its done, or delivered; an open one up to now) with no owner action: owner or theBoard
  changelog entries and undos, owner answers, hand approvals, `qa ok` by hand, a QA deviation and tasks the owner
  added. A time when nothing ran (all work waiting, for example on an owner question) ends a stretch. *Corrected
  without the owner* = the fix rounds, red done commands (`receive` and `merge` start that round with
  `--from done_when`) and base red fix tasks on the tasks done in the window that ended green with no owner action on
  that task (an owner edit, a QA deviation, or an answer to its fix-round cap).
- **Reviewer hit rate:** per reviewer type over the tasks done in the window with a cost measurement: runs, runs whose
  FINDINGS line had findings, fix rounds the orchestrator attributed to the type (`ravenseat resume --from <reviewer,...>`,
  saved in `resumed[].from` and the fixRound row) and the dismissed rest. A type with 10 or more runs and no fix gets a
  hint ("reviewer-docs: 0 fixes in 14 runs"), once fix rounds carry `--from` at all.
- **Inflow:** the tasks added in the window by source (owner, agent proposals, fix tasks, triage = tasks made from a
  finding's plan entry, other), added versus done for the last 3 whole weeks, and a hint when more came in than went
  out in each of them.

Pushes are found after the fact: `ravenseat fill` reads the reflog of `refs/remotes/<remote>/<baseBranch>`, where git writes
"update by push" with the time after every successful push (a fetch writes "fetch: ..."), and logs each new push once
(`<dataFolder>/push-seen.json`) with the batch between the ref before it and the pushed tip and the base health of the
tip. This also covers pushes the owner makes by hand. It needs reflogs for remote refs (on by default in a normal repo).

**Load history** (`ravenseat limit`): one `load` row per `ravenseat fill` and `ravenseat start`, written before the load guard can stop the
command: free memory and CPU (when measured), the slots the adaptive rule allows against maxConcurrent, the running
tracks, and the guard's reason when it limited or stopped (exit 7). `ravenseat limit` shows the last 7 days: how many times
the slots were limited and by what, how many stops, and the latest ones.

**Cost per task, all runs** (`ravenseat cost`, `perTask` in `--json`) is one row per task, most expensive first: the first
track, the fix rounds and continuations (`ravenseat resume`, logged as `<id>-r<N>`), the reviewers, and the fix tasks that
point to it, with USD, tokens and the number of agent runs. A task measured at `set <id> done` uses that measurement
(it already holds its rounds and reviewers); a task without one (open, cancelled) uses its usage in the time log, and
the row says so. `--since` keeps the tasks with activity in the window, `--max` the number of rows.

**Build, review and fix round.** `set <id> done` (and `cost measure`) stores `cost.phases` `{ build, review, fix,
fix_rounds }` and a `phase` per agent, and the measurement line ends with the split. A reviewer is review; a
`<id>-r<N>` agent is a fix round unless `resumed` records round N as a `context` continuation; the bare track agent is
build, except its growth after the first receive (`t_receive`) when it had stopped before it: the same agent continued
with SendMessage, one fix round. Per agent the measurement also keeps `turns`, `output_per_turn`, `thinking_tokens` and
`thinking_per_turn` (left out when the transcript does not report thinking) and `cc_version`. A `WARN` line follows
when an agent's output or thinking per turn is over 2x its agent type's 14-day median (n at least 5); it never stops
anything. The per-class lines and `--since` count tasks by their start date (`by: "started"` in `--json`). See
[costs.md](costs.md#reading-a-change-in-cost).

### Auto-accept of proposals

Default off. With it on, a proposal that fits the owner's rules is approved by the queue itself, through the same path
as `ravenseat approve`: when it is added (`ravenseat add`) and, for older ones, at every `ravenseat orchestrator pulse`. Each one gets a
remark and a row in the log (`auto_accepted` in queue.json, the last 200), and `ravenseat proposals undo <id>` puts it back to
proposed as long as it has not been started; an undone task is never auto-accepted again.

- `ravenseat proposals` shows the rules and which proposals fit them now.
- `ravenseat proposals auto on|off [--classes K,U] [--max-estimate <min|none>] [--max-value <1-10|none>] [--i-understand --by owner]` sets the rules in
  queue.json (`proposals.autoAccept`), which win over the config default (`proposals.autoAccept` in
  queue.config.json: `{ enabled: false, classes: ["K"], maxEstimateMin: 60, maxValue: null }`). The estimate is
  content_min times the class weight. Switching it on from off weakens a guard (agent proposals start without you
  seeing them first): without `--i-understand --by owner` the command prints what the guard protects against, writes
  nothing and exits 1, and from a track worktree it is refused. With the flags it is written and logged as
  `setting-weakened`. Off, and the other rules while it is on, need no flag. The board's switch asks in its own dialog.
- `ravenseat proposals log [--json]` lists what was auto-accepted, newest first.

The hard rules no setting overrides: never class D or D+, never a task with `waiting_on`, never one with a legal or
owner label (`legal`, `lawyer`, `owner`, `owner-task`, `privacy`, `dpia`, or any label starting with `legal` or
`owner`) or linked to a plan entry with open legal points, never one that owns a protected path (`protectedPaths`,
the merge guard's list, also through a folder it owns as a whole), and never one whose auto-accept was undone. The
board's gear has the switch, the rules and the log with an Undo button per row. The logic is `lib/queueProposals.js`.

### Follow-up entries

A follow-up entry (`F-…`) is something to watch over a period: an internal test, a trial after an owner decision, a
variable to measure. It lives in `<dataFolder>/follow.json` (under the queue's lock), not in the memory or the
handover note.

Follow-up entries are off by default: turn them on with `"features": { "follow": true }` in `queue.config.json`.
While off, every `follow` command answers "Follow is off (features.follow in queue.config.json)." with exit 0.

```json
{ "id": "F-AUTOCOMPACT", "title": "Trial of automatic compaction", "why": "Is anything lost?",
  "start": "2026-10-08", "end": "2026-10-15", "owner": "orchestrator",
  "goals": [{ "name": "losses", "how": "read the handover note after each compaction", "expected": "0" }],
  "close_action": "ravenseat compact manual" }
```

- `follow add --file <json>` adds it (status `active`), `follow log <id> --text "…" --value name=x` logs along the
  way, `follow extend <id> --to <date>` moves the end, `follow` lists and `follow show <id>` shows one.
- From the end date (the machine's local calendar day) the entry is `to-report`: `show` and `orchestrator pulse`
  print TO REPORT until `follow report <id>` writes `<dataFolder>/follow/<id>-report.md` from the fixed template
  (Question, Setup, Measurements, Findings, Deviations and losses, Recommendation, Owner decision).
- `follow close <id> --decision "…"` (or `--cancelled`) records the owner decision, writes the report again with it
  and prints the close action. The command never runs the close action itself.
- The board shows the entries read only at `/follow`.

## When a project has no checks

A project with no gates or no CI config still runs. You are told, and you decide:

- **Before a push:** the push guard asks, with what is missing and how many commits go out. It never blocks.
  CI is detected by its config file (GitHub, GitLab, Bitbucket, Azure, CircleCI, Jenkins), which does not prove that it
  runs on this push. `ravenseat controls dismiss` stops the question for this project: it remembers what was missing
  and asks again if something else goes missing. `ravenseat controls restore` brings it back, and `ravenseat controls`
  shows where it stands. The dismissal is yours (queue.json in the data folder, not in git), and push-check and doctor
  still show the fact on one quiet line. `push.controlsWarning: false` turns the question off for everyone.
- **At `ravenseat receive`:** with no quick gates and no done command it says `NO CHECKS RAN`. On a K task it also prepares the
  light review (`reviewer-light`). `ravenseat helpers off reviewer-light` turns the review off, the warning stays.
- **At `ravenseat merge`:** the task gets a verification status, shown in the output, on the card and in the detail panel.

| Status | Means | On the card |
|---|---|---|
| verified | Your gates or done command passed. The code can still be wrong | no badge |
| audited | An agent reviewed the change, but no check ran | **Audited** |
| unverified | No gates, no done command and no agent review ran | **Merged, not verified** |

Tasks merged before this came have no status and no badge. `/ravenseat:setup` sets up gates and offers a CI template,
and the [Checks tab](checks.md) shows what the project has and what to add.

### The Checks tab and `ravenseat checks`

The board's Checks tab and `ravenseat checks` show, as cards, what the project has for checking its code (CI files, and
each kind of check with where it runs) and prioritized suggestions for what to add. It only reads the project's files and
runs nothing, so it shows what is set up, not that it works. A suggestion's button adds an investigation that ends in a
plan, never code (`ravenseat checks plan <key>`), or does a step that needs no agent: turn on an opt-in check
(`checks turn-on <key>`), turn on the stack packs (`checks packs --apply`), use the checks found as gates, or copy a
text to give Claude. Nothing changes your gates or guards without you. "Set aside" keeps a card away until you bring it
back, and a small red dot on the tab shows while a high suggestion is open. The tab also shows the guard registry and
the failures that went red the same way more than once.

Everything about it is on its own page, [The Checks tab](checks.md): how to read it, exactly when the red dot lights,
[every card](checks.md#every-card) with when it shows and what makes it important, the
[three thresholds for repeats](checks.md#three-thresholds-for-repeats), the
[guard registry and repeated failures](checks.md#the-guard-registry-and-repeated-failures), lite mode, turning it off,
[your own cards](checks.md#your-own-cards) and [the commands](checks.md#commands).

### Kickstart

`ravenseat kickstart` (or `/ravenseat:kickstart`, which explains it in plain words) shows what the project has and one next step: git,
gates, secret files, then CI. It works before `ravenseat init` and in a folder without git, and it changes nothing. You can
stop at any step, and no step is required.

- `ravenseat kickstart gates --apply` writes the checks it found to `gates.quick` and `gates.full`, never over gates already
  set. It reads Node/TypeScript (`package.json` scripts, `tsconfig.json`) and Python (`pyproject.toml`, `tests/`). The
  skill reads other stacks itself.
- `ravenseat kickstart add [gates|secrets|ci]` proposes the step as a task (`KS-CHECK`, `KS-SECRETS`, `KS-CI`). It starts only
  when you approve it, and it uses tokens like any other task. Cancel it and the step stays declined.

The board shows the same steps under Settings, and a short line in the status bar while something is missing.

### Known bugs become gates

A bug that can happen again should be caught next time. A track says so with one line `GATE <failure class> @ <file:line>` in
`track-result.md`, and `ravenseat gate "<failure class>" [--from <task>] [--where <file:line>]` does the same by hand. It becomes a
gate task (`GATE-<n>`, label `gate`), and `gates.fromKnownBugs` decides how:

- `propose` (default): the task waits for your yes.
- `auto`: it is approved at once and runs when the queue gets to it. It uses tokens without asking.
- `off`: nothing happens.

At most three gate tasks are open at a time. The same class again adds the new place to the open task. A class you
cancelled is not proposed again.

### Red on base

The mission asks a track for red first: a test that fails before the change and passes after it. Without a check that is
only what the track says. Set `gates.redOnBase` to your test command, and `receive` checks it:

1. The track's new or changed test files run on the delivered tip. They must pass.
2. In the track's worktree, the rest of its change is taken away (changed and deleted files get their merge-base version,
   added files go), and each test file runs on its own. At least one must fail.
3. The worktree is put back (`git reset --hard` to the tip, which `receive` checked was clean).

`Red on base A: 1 of 2 ...` means it held. `RED ON BASE A: ...` names the tests that pass without the change too, or says
they fail on the tip or could not be checked. It is a warning in the receive output and a `Red on base` section in
`00-package.md`, never a stop: a pure refactor under existing tests is right to have no failing test on the base. Only
the verdict and the file names are kept (task field `red_on_base`), never the test output.

The files go where `{files}` is in the command, quoted, else at the end: `"npx vitest run {files}"`,
`"npx jest {files}"`, `"python -m pytest {files}"`. `{dirs}` is the folders of the files instead (once each, as
`./<folder>`), for a runner that runs packages rather than files: `"go test {dirs}"`. A test file is what the
test-weakening check counts as one, plus `testWeakening.testPaths`. While the setting is off, the Checks tab has a card
(`red-on-base`) with the command read from the project's own files (vitest, jest, mocha, `node --test`, pytest with
uv or poetry, Go); it is a suggestion for Claude in your own session, never a change to the config.

#### A fix needs a red test first

A fix whose test passes without the fix too, or a fix with no test at all, shows nothing about the bug it fixed, and
the same bug can come back unseen. `receive` treats these tasks as fixes, from the fields they already have: a task
with `fixes`, a QA fix (`qa_original`), a base or CI fix task (`added_by` "base gate" or "ci watch"), a task made from
a finding (`plan` `PL-FINDING-<n>`), and a task whose report has a GATE line. When red on base says `no-tests` or
`unproven` for a fix, `receive` prints one line in place of the red on base warning:

```
FIX WITHOUT TEST F: a fix task (it fixes A), and red on base says unproven: nothing shows the fix works. ...
```

The finding log gets the verdict as `test_added` (`{ verdict, files }`) and the row the status `fixed-without-test`,
which the repeat count reads. That is all by default: a warning, never a stop. `gates.redOnBaseStrict` (off by default)
is the strict mode: `merge` also stops on a fix without a proven red test (only `proven` passes, and with
`gates.redOnBase` off nothing is proven, which `ravenseat doctor` points out), and `merge <id> --allow-no-test` goes
past it on the owner's word, logged as `no-test-overridden`. The queue's agents cannot pass the flag.
`gates.fixWithoutTestWarning` (on by default, since it costs one line and stops nothing) can turn the fix line off:
`receive` then prints only the plain red on base line, and the row keeps its mark. The strict mode prints the line
anyway, since it explains the stop.

### Repeats on class and area

The finding log is counted per failure class and area (`lib/findingRepeats.js`, plain JS, no tokens, no output of its
own). A class is due when it came back in 2 separate tasks in one area within 90 days, or in 3 across the project when
no single area is. Only rows with `counts: true` count; `confidence: low` and the class `other` never do. An incident
whose row is `fixed-without-test` weighs twice (the verdict is read from `test_added` again; an old row whose
`test_added` is a path or a list reads as verdict null and counts once), but a repeat always needs two incidents.

**Guard failed** is the one important gap: the class back in an area where a guard for it was already in place (an
active registry entry with `against.class`, a done gate task proposed from the log, a row that names its guard), after a
fix there with a proven red test, or after an untested fix when either one is H. It gives the card "A guard did not
hold" on the Checks tab and the red marker, until a newer guard or a fix with a proven red test is in place there.
`learning.guardFailedMarker` off keeps the card without the marker.

**Proposals** (`learning.proposals`, off by default, one setup tip and one Checks card) turn a due class and area into
one gate task, `Gate: <class> in <area>`, always proposed, never approved here (also with `gates.fromKnownBugs` auto).
The inspection scan makes them (`ravenseat inspection` and the pulse, hourly; they ride on `inspection.mode on`). They
share one cap with the inspection queue and the GATE lines: at most 3 proposals of the three kinds wait for the owner at
a time. The same class and area again extends the open task, a done one is a guard from then on, and a cancelled one is
not proposed again.

### Flaky gate commands

One flaky red on a track's quick gate used to cost a whole fix round, with a new agent, while the code was fine. Now a
red `ravenseat gates --quick` (or `--full`) in a track's worktree runs only its red commands once more, on the same commit:

- Green on the rerun: the run is green, with `FLAKY: <command> was red, then green ...` on screen, `flaky` in the gate row
  and the gate evidence, and a `flakyGate` row with the track's id in the time log (`ravenseat cost` counts them under Flow).
- Red again: red as before, and `receive` gives the fix round.
- No rerun on a tree with uncommitted tracked changes, and a rerun that moves HEAD or leaves tracked changes is red: a
  green result must be bound to exactly the commit it checked. The tamper checks (the evidence store, git hooks and
  config) run after the rerun, so a rerun never turns a tampered run green.
- At most one rerun per gate run, never a loop. A run in the main checkout is not rerun here: the base gate has its own
  flaky check (`baseGate.flakyRerun`).

When `receive` runs the gate and it was flaky, it says `FLAKY <id>: <command> ...` with how often the command has been
flaky on this track, keeps `flaky` and `flaky_times` in `gate_check`, files a finding per command (the same title as
the base gate's, so a command that is flaky again counts on the same finding) and adds a `Flaky gate commands` section
to `00-package.md`. A command that was flaky on the same track before still counts as green; the count says so.
`gates.flakyRerun: false` turns the rerun off.

### Green, but no tests ran

A green gate that ran nothing is the quietest false green: a test filter that matches no test, or a runner that exits 0
when it finds no files. `ravenseat gates` reads the tail of each green quick or full gate command, and `receive` the tail
of a green done command, for the zero-test line of the common runners (vitest and jest "No test files found" or a
`Tests 0` summary, mocha "0 passing", pytest "no tests ran" or "collected 0 items", go "no test files", cargo "running 0
tests", rspec "0 examples", unittest "Ran 0 tests"). A positive count in the same tail ("12 passed", a go `ok` line)
cancels it, so a run where only some files or packages have no tests says nothing.

A hit is a caveat, never a stop: a `NOTE: green, but no tests ran` line from the gate run and one `NOTE <id>:` line at
receive, `zero_tests` in the gate evidence entry, `zeroTests` (which gate, which runner, which signal) in `gate_check`
or `done_check`, a `Green, but no tests ran` section in `00-package.md`, and a small neutral "no tests ran" badge on
the card in Review and Built with a `Tests` fact in the panel. There is no setting: it only adds text (a docs-only
task can be green with no tests, and the owner decides what it means), and nothing here can stop work.

### Reuse and scope notes

Parallel tracks tend to write the same helper again, open a folder nobody asked for, add a second library for a job
the project already has one for, or wander outside the files the task named. None of that is wrong for sure, so
`receive` only states the facts: one `NOTE scope` line with a count per kind, and a `Reuse and scope` section in
`00-package.md` with every fact, which the reviewer weighs (`duplication` and `scope-drift` are the finding classes for it). Nothing stops, nothing gets a red
marker, and no agent or token is used: it is `git grep`, `git ls-tree` and `git show` on the merge base.

```
NOTE scope (A): 2 names the base already defines (reuse), 1 new folder, 1 dependency for a job the project already covers, 7 of 9 changed files outside the task's files (drift). Facts for the reviewer, never a stop: each is in 00-package.md (Reuse and scope), or ravenseat receive A --all prints them.
```

A single fact keeps its own line, and `ravenseat receive <id> --all` prints the line of each fact (the lines that stop
or ask for something, such as `CATALOG`, `OWNERSHIP` or `HOTSPOT`, are always whole and come before the notes):

```
NOTE reuse (A): isObject (new in lib/b.js) is already defined in lib/a.js:3, lib/c.js:12. Reuse it, or say in the report why it differs.
NOTE new folder (A): newmod/ (2 files) is not on the base. A new module boundary is an architecture choice: was it an owner question?
NOTE dependency (A): dayjs in package.json, and the project already has moment for dates and times.
NOTE drift (A): 7 of 9 changed files are outside owned_files, shared_patch and reads, in 3 folders the task does not name (cli, docs, lib/x).
```

- **Reuse** (`scopeNotes.reuse`): a name the delivery defines on an added line in a JS or TS file (a top-level
  function, a `const` holding a function, a class, `exports.x =`, an entry of `module.exports = { ... }`) that the base
  already defines in another file. A use of the name does not count, nor a test file, a name the same change removes
  (a move), a name under three letters, or `main`, `run`, `setup` and a few other names every script has;
  `scopeNotes.ignoreNames` adds your own. At most 30 names are looked up per receive.
- **New folder** (`scopeNotes.newFolders`): a file added in a folder the base does not have, at depth 1 or 2
  (`scopeNotes.folderDepth`, 1 to 3). Only the shallowest new folder of a path is named.
- **Dependency** (`scopeNotes.dependencies`): a new package in `package.json`, `requirements*.txt`, `pyproject.toml`,
  `Cargo.toml` or `go.mod` whose job the same manifest already has a package for. The groups (dates, HTTP,
  validation, helpers, test runner, logging, ids, Rust HTTP, dates and arguments, Go routers and logging) are data in `dependency-purposes.json`, each with examples a test runs. It also sees a manifest the task owns,
  which the dependency file guard does not.
- **Drift** (`scopeNotes.drift`): how many changed files lie outside `owned_files`, `shared_patch` and `reads`, and the
  folders among them the task does not name. A task that names no files gets the number of folders it touches
  instead, from two folders. Off in lite, where no task names files (set `scopeNotes.drift` to `true` to turn it on).

Each part has its own setting, and all are on by default in both modes, since each is only a fact:

| Part | Friction | Default and why |
|---|---|---|
| Reuse | One line per name, only when the base defines the same name in another file; a common name can be a false match | On: the most common duplication, caught with no index and no agent. A name that keeps matching goes in `ignoreNames` |
| New folder | Rare; one line | On: an architecture choice nobody asked about shows before the merge |
| Dependency | Only when a manifest changes | On: two libraries for one job are cheap to stop now and costly later |
| Drift | One line per receive when files lie outside the task's own | On: the merge's drift warning, but with numbers and earlier. It is a number, not a stop, since `owned_files` is often a rough guess |
| Ignore names, folder depth | None; they only narrow | Empty list and depth 2 |
| Gap review on large drift (V6) | One more reviewer run, only for a delivery where at least `driftGapFiles` changed files and over `driftGapShare` % of them lie outside the task's files and reads; the reviewer list gives the reason line | `scopeNotes.driftGap`, off: it costs a reviewer run, and `owned_files` is often a rough guess. Full mode only |
| Write warning for drift (V7) | One note per file while a track writes outside its files and reads, never a denial; a track may still stop and ask, which costs time when the files were a guess | `scopeNotes.driftWarn`, off: it can slow a track down. Full mode only |

Two guards build on the drift fact, and both are opt-in. With `scopeNotes.driftGap` on, receive adds the gap reviewer
(`reviewer-gap`, which compares the delivery with the mission point by point) when a change drifts far: at least
`scopeNotes.driftGapFiles` (4) changed files outside the task's files and reads, and over `scopeNotes.driftGapShare`
(40) percent of them. With `scopeNotes.driftWarn` on, the write guard gives a track one note per file while it writes
outside its files and reads; the note says not to stop for it alone and to name the file in the report. Neither fires
for a task that names no files (usual in lite). The Checks tab offers each as a card, and a card turns important (the
red marker) when the finding log shows scope drift three times in one area within 30 days, never in lite. How often the
gap reviewer pays off shows in `ravenseat helpers` (its runs and findings per run).

The notes say what a delivery did. What the project already has, which helpers to reuse and which design choices
hold is written down once, in the project catalog `docs/queue/catalog/` (`ravenseat catalog init|show|check`, and
only the owner accepts a choice): see [The project catalog](catalog.md). The part of it that meets a task's files goes
into the task's mission and its review package, next to these notes, so the track knows before it writes and the
reviewer checks against the same text ([the excerpt](catalog.md#the-excerpt-in-the-mission-and-the-review-package)).

## Limits and safety

- `maxConcurrent` (parallel tracks), `maxDPlus`, `maxPerDomain` and `maxDb` stop the queue from starting more than
  the codebase and your plan can take.
- Two tasks that own the same file or DB object never run at the same time.
- `dailyBudget <usd>` stops new starts when the day's measured spend (API-equivalent) is used up. The night window
  (`nightRun`, `nightWindow`) can pause starts at night.
- The load guard (`limit minFreeMemoryPct 15`, or `loadGuard.minFreeMemoryPct` in the config) stops new starts with
  exit 7 ("THE MACHINE IS FULL") while free memory is below the limit. Default 10 % (off on macOS, which counts the page cache as used; set a number
  there to turn it on). Running tracks finish;
  `start --force` and `fill --over-load` override.
- The usage limit: when a turn ends because the subscription's limit is reached, new tracks and fix rounds stop with
  exit 12 ("USAGE LIMIT") until the reset, since they would only fail and use up fix rounds. Running tracks are left
  alone, and delivered tracks can still be received and merged. The StopFailure hook (Claude Code 2.1.78 or newer) reads
  the reset time from the session's transcript. A plain 429 does not pause anything, and a limit with no reset time
  pauses for one hour. After the reset the pulse names the tracks that were running once;
  `resume <id> --reason context` gives a stopped one a new agent without counting a fix round. `limit usageLimit clear`
  lifts the pause, `start --force` starts one task anyway, and `usageLimit.pause: false` turns it off. Ravenseat does not
  wake a stopped session. Claude Code continues an interactive session after the reset in most setups, but not in
  Remote Control or background sessions, not for a reset more than 24 hours away, and only three times in a row;
  otherwise start the queue again yourself.
- Load-aware slots: above that hard stop, the number of parallel slots follows the load instead of always being
  `maxConcurrent`. With many parallel tracks the machine, not the token quota, is often the limit: gates slow down
  and go red from memory and timeouts, and the reruns cost more than the extra tracks gain. The rule:
  - all slots at or above `loadGuard.allSlotsFreeMemoryPct` free memory (default 40 %, off on macOS);
  - `loadGuard.minSlots` (default 1) at the hard limit `minFreeMemoryPct`;
  - linear in between, rounded down. With `maxConcurrent` 5 and the defaults: 40 % free gives 5 slots, 25 % gives 3,
    18 % gives 2, 10 % gives 1;
  - CPU is optional: set both `allSlotsCpuPct` (all slots at or below, e.g. 60) and `minSlotsCpuPct` (`minSlots` at
    or above, e.g. 95). It costs a ~200 ms CPU sample per command. The lower of memory and CPU wins;
  - new starts = the slots minus the tracks already running. An unknown measurement never limits.

  `fill`, `next`, `start` and `show` print the reason (`LOAD: 2 of 5 slots: free memory 18 % (all slots from 40 %)`),
  `state` has `loadSlots`, and `ravenseat limit` shows the load and the slots now. The floor of 1 means this rule alone
  never stops the queue; only the hard guard does. Turn it off with `loadGuard.adaptive: false` in the config or
  `QUEUE_LOAD_ADAPTIVE=off`; `fill --over-load` and `start --force` skip it for one call.
- Heavy gate runs take turns on the whole machine: [the queue for heavy gates](#the-queue-for-heavy-gates).
- With a migration flow, `start`, `fill` and `pick` skip taken blocks: a migration file, the block of a task that is
  not finished, or a block named on a "migration block" line in an active prompt file (a move by hand).
  `next-migr` refuses a number inside a taken block.
- Times are the machine's local time: the night window, the day the daily budget counts, the weekly quota reset
  and the statistics per day. To use another time zone, set the `TZ` environment variable (for example
  `TZ=America/New_York`) for Claude Code.
- Agents may only ADD proposals. Approval, merging and pushing belong to the orchestrator and the owner.

### The queue for heavy gates

The load guard looks when a track starts; it cannot stop several long test runs from landing at the same moment later. So
`gates.mjs --quick` and `--full` wait for a free slot when the last run of the same kind in this project's time log took at
least `gateQueue.heavyAfterSec` (default 120 s). No history counts as light, so a small project never notices it.
The gate queue is developed and run on Windows, CI runs its tests on Linux and Windows, and it has not been tried on
macOS.

- One slot by default (`gateQueue.slots`), shared by all worktrees and projects of your user on the machine: folders under
  the system's temp folder, `ravenseat-gate-queue-<user>`. No service runs.
- The run prints one line saying who it waits for and its place in line, and looks again every 3 seconds.
- Waiters are served in order. Base runs go first: a run in the main checkout (the gate after a merge, the full gate
  before a push, `ravenseat machine --measure`). Then receive runs (the orchestrator's gate on a track's worktree),
  then a track's own runs. Within a class it is first come, first served. A waiter that has waited
  `gateQueue.agingMin` minutes (default 10) counts as a base run, so a track run is never starved. Each waiter keeps a
  ticket in `waiting/` under the queue folder and touches it every poll; a ticket whose process is gone, or that has
  not been touched for 2 minutes, is ignored, so a crashed waiter never blocks the line.
- `--timeout-sec` starts when the check starts, not during the wait. The wait goes into the `gate` row as `wait_sec`;
  `duration_s` does not include it.
- A slot is free again when the run ends, also on a red run or a signal. A slot whose process is gone, or that is older than
  3 hours, is taken over. A queue that cannot be used (no write access) runs the gate without it.
- `--precheck` and the commands of a separate base gate (`baseGate.commands`) do not queue. A gate command never queues:
  gates.mjs gives it `QUEUE_GATE_QUEUE=off`.

Apart from that queue, a run that records gate evidence (receive, merge, and runs in the main checkout) holds the evidence
lock of this project for as long as it runs: `<data folder>/gate-evidence.json.lock`. The tamper check compares the whole
evidence store before and after the run, so two such runs at the same time (two tracks received at once, or a second
session) used to read each other as tampering. Now the second one waits, looks again every quarter second, and its
`--timeout-sec` starts after the wait. A holder whose process is gone is taken over; a lock folder that cannot be used
means no lock, never a stuck gate. A gate command never waits for it: gates.mjs gives it `QUEUE_EVIDENCE_LOCK=held`.

### Long calls: the wait mode

Claude Code's Bash tool stops a call after 120 s unless it is given a timeout (600 s at most), and a wait over 300 s misses
the 5 minute prompt cache. A gate run can take longer, so `ravenseat gates`, `ravenseat receive` and `ravenseat merge` block
for at most `wait.blockSec` (default 280 s). A run that is done by then prints exactly what it printed before and keeps its
exit code. A run that is not done goes on in a detached process, and the call ends (exit 75) with one line:

```
RUNNING: ravenseat gates --quick (run gates-mbx1k2a3f9c1), started 2026-11-13 10:00:00 UTC. Next: ravenseat gates --wait gates-mbx1k2a3f9c1 (Bash timeout 300000)
```

The next command waits for the same run, shows only the output the earlier call did not show, and blocks again for at
most `wait.blockSec`. Run it in the foreground with the Bash timeout the line names; never `run_in_background`, never a
poll loop. The first call goes in the foreground with Bash timeout 600000 (the tool's maximum): it ends by itself after
`wait.blockSec`, so the larger timeout costs nothing and also covers a raised budget. A `--wait <id>` on a finished run
whose output was already shown in full prints the whole output again, with the run's exit code, since the caller has
evidently lost it.

- The same command with the same arguments in the same folder on the same commit is never started twice while one runs:
  a second call prints `ALREADY RUNNING` with the run's id and waits for that run.
- A hard cap ends a run that hangs: at least 2 hours, and four times the largest of `gates.timeoutSec`,
  `baseGate.timeoutSec` and `doneCheck.timeoutSec`. The run is then red with `stopped after the time budget of <n> s`, as a
  gate over its own budget is. The gate budgets themselves are unchanged.
- The output and the result are kept in `<data folder>/runs/` for 3 days. They only relay what the command printed: the
  queue state and the gate evidence store stay what receive, merge and the push check rely on.
- Off: `wait.blockSec: 0`, `QUEUE_WAIT=off` for one call, and a terminal (a person at a terminal waits as before).
  `--wait <id>` always works. Developed on Windows; its tests run in CI on Linux and Windows, not tried on macOS.

### The temp folder

Tests leave things in the temp folder, and over thousands of runs it fills up. So every run of `gates.mjs` gives its gate
commands a folder of their own through `TEMP`, `TMP` and `TMPDIR` and removes it when the run ends, also after a red run.
Ravenseat does not need to know what your tests leave.

- A folder holding a link or junction is left in place, and the run says so: removing through a link can delete what it
  points at. A killed run also leaves its folder; a later run removes it when the process is gone and an hour has passed.
- The commands of a separate base gate and a task's done command keep the normal temp folder.
- If your tests need the shared temp folder, set `gateTemp.enabled` to `false`.
- `ravenseat doctor` has a `temp` line with the number of entries and the prefixes with the most. It counts and removes
  nothing else: only you can tell what another program's folders are for.

Plugins multiply with the number of agents. A plugin's start hook runs once per agent session, so four tracks and an
orchestrator run it five times, and a hook on a timer runs that much more often. A hook that installs packages can be the
largest source of both temp folders and load. When the machine struggles, look through your installed plugins
(`claude plugin list`) and turn off the ones this project does not use.
- `gateQueue.enabled: false` turns it off, `QUEUE_GATE_QUEUE=off|on` overrides that for one call, and
  `QUEUE_GATE_QUEUE_DIR` moves the folder.

It cannot deadlock with the other locks: the merge lock never waits (a second merge is refused at once), the queue's lock is
held only for short edits and never around a gate run, and a process in a slot takes neither. `ravenseat merge` does hold the
merge lock while its gate step waits for a slot, so other merges in that project are refused during the wait.

### The clean copy

By default the full gate before merge (`receive`'s run on the delivered tip) runs in the track's worktree. Untracked and
ignored files there, and the shared `node_modules`, can make it green when the commit alone would be red. With
`gates.runner: "clean"` that run happens in a fresh copy of the exact commit under `<dataFolder>/clean-gate`, and the
evidence line says `ran in a clean copy of <sha>, dependencies linked|installed`. `ravenseat gates --full --clean` tries it
once without changing the config.

- Dependencies: `link` (the default) links the `sharedLinks` folders into the copy, about 2 s more; `install` runs a frozen
  install from the commit's lockfile; `auto` installs only when the lockfile differs from the linked one.
- An ignored file the tests need (for example `.env.test`) goes in `gates.clean.include`. Keys, tokens and other env files
  are refused.
- When the copy cannot be set up (no lockfile for `install`, a failed install, a broken worktree add), no gate command runs.
  `receive` turns that into one owner question, as for a missing program (`gates.brokenVerdict`), not a fix round.
- The copy is removed when the run ends, links first and never through a link. A link that points out of the copy keeps the
  folder. A left copy (a killed run, `gates.clean.keepOnRed`) is swept by the next clean run and by `ravenseat doctor`
  after `gates.clean.sweepAfterHours`.
- In worktree mode a green run that saw ignored files or a differing lockfile prints a hint line about `gates.runner clean`.
- Tools that walk the main checkout should skip the data folder: it can hold a full copy of the repository for a while.

### Git hooks and config

A git hook, and git settings such as an alias or `core.sshCommand`, run code at the next git command, with your
credentials. The settings counted (`lib/gitExecSurface.js`): aliases, filters, `core.hooksPath`, `core.fsmonitor`,
`core.sshCommand`, `core.pager`, `pager.*`, `core.editor`, `sequence.editor`, `core.askPass`, `core.gitProxy`,
`core.alternateRefsCommand`, `gpg.program` and `gpg.*.program`, `gpg.ssh.defaultKeyCommand`, credential helpers,
`diff.external`, `diff.*.command`, `diff.*.textconv`, `merge.*.driver`, `interactive.diffFilter`,
`remote.*.uploadpack`, `remote.*.receivepack`, `uploadpack.packObjectsHook`, `mergetool.*` and `difftool.*` `cmd` and
`path`, send-email's programs, `trailer.*.command`, `submodule.*.update`, `include.path` and `includeIf.*.path`, and the
browser, man viewer and git gui tool commands. A queue agent may not set any of them with `git config` (reading is
fine), and one given with `git -c` makes a line with a push in it unreadable, so it is denied.

Automated work in the repository runs as the same user, so it can write them. The queue therefore keeps
what was last accepted (`git-surface.json` in the data folder: hook hashes and setting names with hashed values, never
the values), recorded the first time `ravenseat fill`, `start`, `resume`, `receive` or `merge` runs.

`ravenseat receive`, `ravenseat merge` and the push check compare against it before they run anything. If something differs they stop
and change nothing. **This usually means nothing is wrong**: you installed husky or lefthook, updated one, or changed a
global alias. What to do:

```
ravenseat surface                     # each difference: the full path of a hook, the file a setting comes from
ravenseat surface accept --by owner   # you made the change: one command, then run again
```

If you did not make the change, remove it (the hook file, or the setting with `git config --unset`) and run again. A
hook tool's name in the output (`looks like a hook manager`) is a hint and accepts nothing. `ravenseat doctor` warns about the
same difference. A global setting stops the queue like a local one, because a program can write that file too.

If this is more friction than it is worth in your repository, change `gitSurface` in `queue.config.json`: `"warn"` says
the same things as a warning and stops nothing, `"off"` compares nothing. The cost is that a hook planted by automated
work then runs at the next git command, with your credentials. `ravenseat doctor` says when the check is off.

`TAMPERED` means something else: a check that ran the code under review changed these things *during* its run. That is
also your decision and never goes back to an agent as a fix round. The same two ways out apply. The limits: this detects,
it does not prevent. A change undone before the next check is not seen, a process that outlives its run can act later,
and git commands you or a script run by hand are not stopped.

### The main tree's control files

A few files in the main tree steer the orchestrator, the guards or every later session: `queue.config.json`, `.claude/`
(the settings, hooks, agents, skills and rules Claude Code loads; `.claude/worktrees/` is left out), `CLAUDE*.md`,
`.git/hooks/`, `.git/config` and the plugin's own scripts. Every override flag is denied to the queue's agents, but a
direct write to these files would get around all of them. So a queue agent may not write them in the main tree: a
Write, Edit or NotebookEdit there is denied (the write guard), and so is a shell line that names one and writes (a
redirection, `cp`, `mv`, `sed -i`, `Set-Content`, `node -e` with `writeFileSync`, `cd <main> && ...`, `git -C <main>
checkout ...`), and a `git config` or `git remote` write, which lands in the shared `.git/config`. Reading stays free.
The agent's own worktree copies are its own branch: free here, and the protected paths stop them at `merge`. The main
session is not affected. `"controlFiles": { "guard": false }` turns it off.

`fill` and `start` also record a short hash of each of those files on the task (`control_fp`), and `receive` prints
`CONTROL FILES CHANGED <id>: <files>` for a change that no commit explains (a file that is tracked and clean came in
through a merge, which git log shows), with the other tracks that ran at the same time. It warns and never stops:
you or `ravenseat settings set` may have changed a file while the track ran, and the fingerprint cannot tell who did.
A weakened setting with no `setting-weakened` row (the config was edited outside the CLI) is logged once as
`config-changed-outside-cli`, at `receive` and in `doctor`. `"controlFiles": { "fingerprint": false }` turns it off.

The limits: a script file the agent wrote and then runs, a path built from pieces at run time and an unknown variable
as the folder are not read, and a process that outlives its run can act later. This guards against a misled agent,
not against a hostile process running as you: only another OS user for the agents or protection on the remote is a
real boundary (guide.md, "Guarantees and limits").

### The main session's overrides ask you

The queue's agents are denied every override flag, but the orchestrator, the main session, can pass them, and the CLI
cannot tell it from you: it only sees the flag. A track report or a document that says "the owner approved
`--allow-guard`" is data, and a compacted session may have lost what you said. So with `approvals.ask` (on) the push
guard answers with Claude Code's own permission dialog before the main session:

- runs `merge` with an `--allow-*` or `--force*` flag (`--allow-guard`, `--allow-secret`, `--allow-unreviewed`,
  `--force-red-base`, `--force-red-gate`, `--force` on a running task and the others);
- passes `--i-understand` (a confirmed weakening with `settings set`), `--by owner` or `--by theBoard` (`resolve`,
  `approve`, `qa ok`, `resume --answer`, `edit` of a locked field, `cancel`, `unlock`), or `--set-by owner`;
- runs `surface accept`, `owner-log accept` or `helpers approve`, whose `--by` is free text;
- calls the board's API (an `X-Queue-Key` header, or the board's port on a loopback address with `/api/`).

The write guard asks before the main session writes one of the main tree's control files directly with Write or Edit
(the same set as above; the plugin's scripts only when they are installed outside the project). The dialog names the
command, the task, the flags and, for a merge, the track branch's tip, never a flag's value. You answer in Claude Code
or through Remote Control. Each question is one `guard-ask` row in the time log.

With `push.ownerAsk` (on) and `push.mode` `owner`, every push of the base branch by the main session asks too, with the
tip and the merged tasks: "push only on my word" becomes a rule instead of an instruction. In `threshold` mode nothing
changes.

The ordinary commands never ask: `merge` without an override, `receive`, `settings set` without `--i-understand`,
`resolve` without `--by owner`, and a push in `threshold` mode. If you told the orchestrator in chat to use the flag,
you still get the dialog: that second step is the proof that it was you. The board is not affected, it runs the CLI
itself.

The permission mode matters. In `default`, `acceptEdits`, `plan` and `auto` the dialog reaches you (in `auto` a hook's
question goes to you, not the classifier). In `dontAsk` and `bypassPermissions` nobody would see it, so the guard
denies instead and says you can run the command yourself in your own terminal. A run with `claude -p` and no prompt
handler denies a question by itself. `ravenseat doctor` gives an INFO line (`permission-hook`) when the project's
settings have a PermissionRequest hook whose matcher takes Bash, PowerShell, Write or Edit, since such a hook can answer
for you; it changes nothing. The limits: a script file the model writes and runs, or a hostile process running as you,
is not stopped by a dialog (guide.md, "Guarantees and limits").

### Your own Claude setup

A track runs as you, so it can write outside its worktree, also in your own Claude folder (`~/.claude`, or
`CLAUDE_CONFIG_DIR`). git never sees that folder, so no merge guard can catch a change there. `start` and `fill`
record a hash of each entry on a short list: `settings.json`, `settings.local.json`, `CLAUDE.md`,
`keybindings.json`, the plugin manifests (`plugins/installed_plugins.json`, `plugins/known_marketplaces.json`) and
the folders `agents/`, `commands/`, `skills/` and `hooks/`. `receive` compares and prints
`CLAUDE SETUP CHANGED <id>: <entries>` when one changed while the track ran, with the other tracks that ran at the same
time. It only warns, since you may have changed the setup yourself. Only hashes are stored on the task (`claude_fp`),
never content. Transcripts and the plugin cache are left out: they change all the time. `"claudeFingerprint": false`
turns it off.

## Configuration

Project-specific values live in `queue.config.json` at the project root (see `queue.config.example.json`): base branch,
branch prefix, gate commands, migration folder (optional), areas (`modules`) for the plan register, board port and title,
reviewer agents per class. Missing values fall back to safe defaults. `ravenseat settings` lists every setting by
category with its value and default, and `ravenseat settings set <key> <value>` changes one (see Everyday commands).

The tables below follow the same sixteen categories as `ravenseat settings` and the board's gear (one row per setting in
`lib/settingsRegistry.js`; a test keeps them in step). The last column marks a row **Advanced** (shown by `ravenseat
settings --advanced`), **Full mode only** (not used in lite; `ravenseat settings --all` says why) and **queue.json**
(saved only for you in the queue data, not in the project's `queue.config.json`; set it with `ravenseat settings set`,
`limit` or the board). A row without a mark is a basic setting in `queue.config.json` that both modes use. A value that
weakens a guard needs `--i-understand --by owner` (see `settings set` under Everyday commands), and `ravenseat doctor`
names every guard weaker than its default on its `settings` row.

Some settings have an effect only while another one is on: the CI watch numbers need `push.ciWatch` `github`, the gap
review numbers need `scopeNotes.driftGap`, the recipe damping needs the inspection queue and `learning.repeats`, a fix
without a test is only warned about with `gates.redOnBase` set. The registry names that parent on the row (`requires`),
and `ravenseat settings` marks it `[needs <key>]`, with `[no effect now: <key> is off]` while the parent is off. The
board says "Has effect only when ..." and dims the row. Nothing is hidden, and the value can be set before the parent.

`ravenseat settings <key>` shows one setting in full, with its explanation and the defaults in lite and full. A row
that guards against something (`protects` in the registry: every row that can weaken a guard, and guards such as the
gates, the read stop, the deploy commands and the allowed migration environments) says what in one sentence, on the
board ("Protects against: ...") and in that view.

### Project and git

| Key | Default | Used for | Marks |
|---|---|---|---|
| `mode` | `full` (`ravenseat init` writes `lite` for a new project) | Lite runs the core loop with one task type; full adds classes, focus, the batch queue and the plan structure (see full-mode.md). `ravenseat mode lite\|full` switches. Switching an existing full project to lite (`mode lite`, `settings set mode lite`, `init --lite` or the board) softens `gitSurface` and `dependencyFiles`, so it is a weakened guard and needs `--i-understand --by owner`; a new project's first `init` gets lite without it | Basic |
| `projectName`, `baseBranch` | the folder name, `main` | The name in missions, agent messages and on the board; the integration branch every track is merged into and that is pushed in batches | Basic |
| `remote`, `branchPrefix` | `origin`, `queue/` | The push remote (also for cloud sessions); track branches are named `<prefix><task id>` | Advanced |
| `productionBranch` | `null` (unknown) | The branch that goes live; `ravenseat doctor` warns when it equals `baseBranch` (every batch push would go to production) | Advanced |
| `sharedLinks` | `["node_modules"]` | Folders linked into each worktree instead of reinstalled | Advanced |
| `excludeBranches` | `["main","master"]` | Branches never treated as external work | Advanced |
| `identity.allow` | `[]` | Addresses the identity guard accepts although they look like a test identity (`ci@example.com`). Exact, not case sensitive | Advanced |
| `dataFolder`, `timeLog` | `scripts/.queue`, `scripts/.queue/times.jsonl` | Where the queue, the plan register and the logs live (gitignored), and the file the time hook writes usage per agent to | Advanced |
| `largeFileMb` | `5` | `ravenseat doctor` warns about tracked files larger than this | Advanced |
| `tidy.doctor` | `true` | `ravenseat doctor` shows one INFO row `tidy` with how many merged, clean worktrees and merged branches `ravenseat tidy --execute` would remove, and their size. Only when there is something; display only, never WARN or FAIL | Advanced |
| `tidy.afterMerge` | `false` | After a merge, the task's worktrees anywhere on disk go too, by the tidy rules. Off because a delete cannot be undone, even when the branch is merged | Advanced |
| `tidy.minAgeHours` | `3` | `ravenseat tidy` keeps a worktree changed more recently than this (a new worktree with no commits looks merged). `0` = no minimum | Advanced |
| `issues.refsTrailer` | `true` | A task linked to a GitHub issue gets `Refs: #12` in its merge commit. Local, no network call, and never `Closes`, so it is on | Advanced |
| `issues.labelMap` | `{}` | Routes `ravenseat issues import` by label (`task`, `plan`, `K`, `U`, `D`, `D+`). Empty = off: every import is a plan in the Inbox; an imported task is still proposed. A wrong shape is a `doctor` WARN with the fix | Advanced |
| `issues.onPush` | `"off"` | What `ravenseat issues report --post` does to linked issues after a push: `off`, `comment` or `close`, with a fixed template, after a preview and your yes. Off by default: it posts on GitHub, often in public | Advanced |

### Limits and cost

| Key | Default | Used for | Marks |
|---|---|---|---|
| `limits.maxConcurrent`, `limits.dailyBudget`, `limits.nightRun`, `limits.nightWindow` | `5`, off, on, `23-06` | How many agents run at once; the daily quota (no new tasks once today's usage reaches it); the night pause and its hours (`ravenseat limit <name> <value>`) | queue.json |
| `limits.maxDPlus`, `limits.maxPerDomain` | `2`, `7` | The heaviest tracks (D+) at once, and tracks at once in one domain | Advanced, Full mode only, queue.json |
| `limits.maxDb` | `6` | Tracks with migrations at once (only with `migrations.folder`) | Advanced, queue.json |
| `usageLimit.pause` | `true` | At the subscription's usage limit no new tracks or fix rounds start until the reset time (`ravenseat limit usageLimit clear` lifts it early) | Advanced |
| `capacity.resetDay`, `capacity.resetClock`, `capacity.timeZone`, `capacity.planName` | Tuesday, `19:00`, the machine's zone, none | The weekly quota reset for `ravenseat capacity`, and the plan name in its text | Advanced |
| `models` | `{}` (each agent file's model, opus) | Model per agent, e.g. `{ "reviewer-docs": "sonnet" }`: printed as `model=<m>` on the start lines and passed to the Agent tool (opus, sonnet, haiku, fable; an unknown value is ignored) | Advanced |
| `prices` | `null` (the built-in list prices) | List prices per model in USD per million tokens, for the cost measurement | Advanced |
| `cost.contextThresholdK` | `200` | In `ravenseat cost` ("Turns and tools"), the share of cost from turns whose context is above this many thousand tokens; a measurement only | Advanced |

### Machine load

| Key | Default | Used for | Marks |
|---|---|---|---|
| `limits.minFreeMemoryPct` | `10` | The queue's own load limit: no new starts while free memory (percent) is below it; overrides `loadGuard.minFreeMemoryPct` | Advanced, queue.json |
| `loadGuard.minFreeMemoryPct` | `10` (off on macOS) | The project default for the load limit above | Advanced |
| `loadGuard.adaptive`, `loadGuard.minSlots`, `loadGuard.allSlotsFreeMemoryPct` | `true`, `1`, `40` (off on macOS) | Load-aware slots: fewer than `maxConcurrent` slots while free memory is below `allSlotsFreeMemoryPct`, at least `minSlots`; `QUEUE_LOAD_ADAPTIVE=off` turns it off | Advanced |
| `loadGuard.allSlotsCpuPct`, `loadGuard.minSlotsCpuPct` | `null`, `null` | Optional CPU part of the load-aware slots (both set, e.g. `60` and `95`) | Advanced |
| `gateQueue.enabled`, `gateQueue.slots`, `gateQueue.heavyAfterSec`, `gateQueue.agingMin` | `true`, `1`, `120`, `10` | [The queue for heavy gates](#the-queue-for-heavy-gates): how many heavy `--quick`/`--full` runs may run at once on the machine, from how many seconds (the last run of the same kind) a run counts as heavy, and after how many minutes of waiting a run counts as a base run | Advanced |
| `gateTemp.enabled` | `true` | [The temp folder](#the-temp-folder): each gate run gets a temp folder of its own, removed afterwards | Advanced |
| `limits.parallelThreshold`, `limits.silentMin`, `limits.noAgentMin` | `0.7`, `20`, `15` | The share of concurrent tracks below which fill, receive and pulse write a short diagnosis; minutes without a sign of life before a running track counts as silent; minutes before a track marked running that no agent took counts as NO AGENT (`0` = off for both) | Advanced, queue.json |
| `limits.spinMin` | `15` | Minutes a busy track may go without real work before it is `SPINNING`: its newest calls are only bookkeeping (to-do lists, tool loading), sleeps or the same reads again, with no write, command or commit. A line in `show`, the pulse and the pulse check; after 60 min also a Decisions card, as SILENT. Never a stop. `0` = off | Advanced, queue.json |
| `silentSnapshot.enabled`, `silentSnapshot.keep`, `silentSnapshot.maxKB` | `true`, `20`, `64` | When a track turns SILENT, one local evidence file in `<data folder>/silent-snapshots/` (transcript tail, background jobs that never reported back, processes naming the worktree), redacted before writing; the SILENT line names it. Friction: none, it never stops work (a few seconds once per silence for the process list) | Advanced |

### Gates

| Key | Default | Used for | Marks |
|---|---|---|---|
| `gates.quick`, `gates.full` | `[]` | Commands `gates.mjs` runs (empty = green); set them up with `ravenseat kickstart gates`. Each command gets `QUEUE_GATE_BASE`, the commit to diff against: the fork point in a track's worktree, the merged track's fork point after `ravenseat merge`, unset with no own commits (a gate that needs it should then check everything) | Basic |
| `maxFixRounds`, `fixPlateau` | `3`, `true` | At this many fix rounds a task becomes an owner question; a fix round that committed nothing or fails the same way asks first (see "The done command and the fix-round cap") | Advanced |
| `fixRound.continueWithinMin`, `fixRound.continueMaxContextK` | `60`, `200` | A fix round continues the agent that delivered (SendMessage, only the fix list) when it was active within this many minutes and its context is under this many thousand tokens; else a new agent with a short mission. `0` minutes = always a new agent | Advanced |
| `doneCheck.timeoutSec`, `doneCheck.tailLines` | `600`, `40` | The time budget of one run of the task's done command, and the last output lines kept for the fix brief | Advanced |
| `gates.precheck`, `gates.precheckBudgetSec` | `null` (the standard checks), `120` | The fail-fast precheck `ravenseat gates --precheck` runs before the full gate, stopping at the first red check: commands or `{ name, command, files, budgetSec }`, with `{changed}` (the changed files against `baseBranch`) or `{file}` (once per file); `null` = `node --check`, `tsc --noEmit`, eslint and related tests when the project has them, `[]` = off (see orchestration.md) | Advanced |
| `gates.timeoutSec` | `null` (= `baseGate.timeoutSec`, 900 s) | The time budget for the whole list when a track runs its own gates (`ravenseat gates --quick` or `--full` in its worktree, without `--timeout-sec`): a gate over it is red, so a hanging test cannot hold a track. `0` = no budget. `receive` and `merge` pass `baseGate.timeoutSec` themselves; the main checkout has no budget unless one is passed | Advanced |
| `gates.flakyRerun` | `true` | A red quick or full gate run in a track's worktree runs only its red commands once more on the same commit (never on a dirty tree, never in the main checkout); green then is green with `flaky` (a `flakyGate` row, and at `receive` a finding and a package section), red twice is red (see "Flaky gate commands"). `false` = no rerun | Advanced |
| `gates.brokenVerdict` | `true` | "The gate cannot run": a red quick gate at `receive` whose own first program is not found here (exit 127, "not recognized", 9009, spawn ENOENT), and the same command fails the same way on the base, starts no fix round. `receive` exits 8 with one owner question whose id carries the gates setup hash (`gate_broken` on the task), so the same setup asks once and a changed setup forgets it. "Cannot find module" from the track's code stays a code failure. `false` = a fix round as before | Advanced |
| `gateEvidence.mode` | `own` | Whose gate evidence `receive` and `merge` rely on. `own`: they run the quick gates themselves on the track tip (their own green run already recorded on the same tip and gate setup is reused, so `merge` after `receive` runs nothing twice; a track's own `gates` run in its worktree records no evidence and is never reused), never believing `gate_check` in queue.json, and they confirm the owner rows a task relies on (your answers, edits and approvals) against the owner log, `owner-log.json` (a row no ravenseat write recorded stops them; `ravenseat owner-log accept <id> --by owner` confirms it). `external`: as `own`, and a green run of the checks in `gateEvidence.external` on exactly the same commit counts as the full gate (`ravenseat gates --full` in the main checkout asks GitHub with `gh`). `off`: they take the track's `gates=OK` as given and do not check owner rows. With empty `gates.quick` and `gates.full`, `own` runs nothing anyway, so `off` saves no time; it only removes the owner row check. `ravenseat doctor` gives INFO for `external` and warns `GATE EVIDENCE OFF` for `off`; both are a weakened guard | Advanced |
| `gateEvidence.external` | `[]` | The GitHub check names (workflow or job) whose newest run must be green on exactly the same commit in mode `external`. `[]` = none counts, and the full gate runs here (doctor warns) | Advanced |
| `baseGate.enabled`, `baseGate.commands`, `baseGate.timeoutSec`, `baseGate.tailLines` | `auto`, `null` (the quick gates), `900`, `null` | After a merge the base branch's new tip is checked; a red base stops further merges until it is green. The commands run after the quick gates, within the time budget; the tail lines go into the fix task | Advanced |
| `wait.blockSec` | `280` | [Long calls: the wait mode](#long-calls-the-wait-mode): `ravenseat gates`, `receive` and `merge` block for at most this many seconds (at most 590), then print one `RUNNING` line with the next command (`<command> --wait <id>`) and the Bash timeout for it. `0` = block until done, as before | Advanced |
| `windows.hideConsoles` | `true` | On Windows, detached runs (the wait mode, gates, the tree guard, the update check) start everything below them with hidden windows (`lib/hideWindows.cjs`, a preload passed on through `NODE_OPTIONS`), so a test run opens no console window per git call. Output, exit codes and stdio are unchanged; an explicit `windowsHide: false` in a call is kept. `RAVENSEAT_HIDE_WINDOWS=off` turns it off for one shell. No effect on other platforms. `false` = the windows show as before | Advanced |
| `baseGate.flakyRerun` | `true` | Before a red base check freezes the base, only the failed commands run once more on the same sha; green then is recorded as flaky (a `flakyGate` time log row, a finding, no freeze), red twice freezes. `false` = freeze at once | Advanced |

### Tests and evidence

| Key | Default | Used for | Marks |
|---|---|---|---|
| `gates.redOnBase` | `null` | Red on base (see "Red on base"): a test command with `{files}` (or `{dirs}`, the folders of the files), or `{ command, timeoutSec, maxFiles }` (300 s, 10 files). `null` = off | Advanced |
| `gates.fixWithoutTestWarning` | `true` | The one `FIX WITHOUT TEST` line at `receive` for a fix task whose red on base verdict is `no-tests` or `unproven` (see "Red on base"). It stops nothing. `false` = only the plain red on base line; the finding log row is still marked `fixed-without-test`, and the strict mode prints the line anyway | Advanced |
| `gates.redOnBaseStrict` | `false` | A fix needs a red test first (see "Red on base"): a fix task whose red on base verdict is `no-tests` or `unproven` always gets one warning at `receive` and the finding log status `fixed-without-test`. `true` = `merge` also stops on a fix without a proven red test; `merge --allow-no-test` goes past it (owner only, logged as `no-test-overridden`) | Advanced |
| `testWeakening.findingLog` | `true` | What the test weakening check finds at `receive` is also a finding log row (source `test-weakening`, class `test-weakening` from the rule register), so it counts when the same failure comes back. Nothing is printed and nothing stops. `false` = no row; the warning and the focus stop stay, so it weakens no guard | Advanced |
| `testWeakening.enabled`, `testWeakening.focusStop` | `true`, `true` | `receive` warns, never stops, about deleted test files, test files moved out of the test paths and skip or focus markers on added lines in test files (`.skip(`, `.only(`, `xit(`, `it.todo(`, `@pytest.mark.skip`, `pytest.skip(`, `@unittest.skip`, `#[ignore]`, `t.Skip(`, `@Disabled`, `@Ignore`, `pending(`, `markTestSkipped` ...): one `WARN test weakening:` line and a `Test weakening` section in `00-package.md`. `focusStop`: a focus marker (`.only(`, `fit(`, `fdescribe(`) on an added line stops `merge`, since the other tests never ran; `--allow-focus` overrides (logged as `focus-overridden`), `false` = only the warning | Basic |
| `testRuns.log` | `true` | Each `npm run test:changed` and plain `npm test` run in this repo is one JSON row in `<dataFolder>/test-runs.jsonl` (time in UTC, ref, mode, reason, picked and total test files, changed files, pick and run seconds, exit code, test and failed counts; a `--list` pick is marked `list`). The file stays on the machine and is cut to its newest 1000 rows past 512 KB; a failed write is ignored, so no run fails because of it. `node scripts/test-changed.mjs --stats [--days N]` shows the split, the median picked share and the run times. `RAVENSEAT_TEST_RUNS=off` turns it off for one shell. `false` = no rows | Advanced |
| `testWeakening.testPaths`, `testWeakening.markers` | `[]`, `[]` | More test file globs for the test weakening warning (`testPaths`, the `protectedPaths` rules) and more regular expressions for a skip marker on an added line (`markers`); `ravenseat doctor` names an invalid one | Advanced |
| `qa.evidenceTypes`, `qa.autoTypes`, `qa.manualTypes` | `screenshot`, `test`, `manual`; auto `test`; manual `manual` | QA evidence types a track writes as `EVIDENCE <type>[=<ref>]`; auto types are closed by `qa auto --run`, manual ones gathered in one round | Advanced |
| `qa.autoCommand` | `null` | Shell command for auto evidence, e.g. `npx vitest run {refs}` (`{refs}`, `{id}`; or `{ "<type>": "<command>" }`); `null` = `qa auto` only lists | Advanced |
| `qa.evidenceLabels` | `["visual"]` | Labels for which `receive` warns when the `EVIDENCE` line is missing | Advanced |
| `gates.runner` | `worktree` | [The clean copy](#the-clean-copy): `worktree` = the full gate before merge runs in the track's worktree, where untracked and ignored files and the shared node_modules can change the result; `clean` = it runs in a fresh copy of the exact commit, about 2 s more with linked dependencies, and can turn red when tests need an ignored local file. Off by default since it can stop work | Advanced |
| `gates.clean.dependencies` | `link` | `link` = the `sharedLinks` folders linked into the copy (about 2 s); `install` = a frozen install from the commit's lockfile (npm ci, pnpm, yarn or bun; 25 to 60 s, runs install scripts); `auto` = install only when the commit's lockfile differs from the linked folder's | Advanced |
| `gates.clean.copy` | `worktree` | `worktree` = `git worktree add --detach` (keeps `.git`, Git LFS works); `archive` = `git archive`, no `.git` | Advanced |
| `gates.clean.include` | `[]` | Ignored files or folders copied from the worktree into the copy (for example `.env.test`). Never an absolute path, `..`, `.git`, a key or token file, or an env file other than `.env.test`, `.env.testing` and `.env.ci` | Advanced |
| `gates.clean.kinds` | `["full"]` | Which runs use the copy: `full` (`receive`'s run on the delivered tip), `base` (the merge commit), `push` (`ravenseat gates --full` in the main checkout). A track's own run never | Advanced |
| `gates.clean.keepOnRed` | `false` | Keep the copy of a red clean run for inspection; the sweep removes it later | Advanced |
| `gates.clean.sweepAfterHours` | `1` | A copy whose run has ended is removed after this many hours by the next clean run or `ravenseat doctor`, links first | Advanced |

### Checks tab and learning

Three sources can propose a task that builds a new guard: a failure that keeps repeating (`inspection.mode`, on), a known bug (`gates.fromKnownBugs`, `propose`) and the finding log (`learning.proposals`, off). Together they keep at most three proposals open, and each one waits for your approval, so none of them starts work by itself. The finding log source is an opt-in check, off until you turn it on, since its proposals ask for your time.

| Key | Default | Used for | Marks |
|---|---|---|---|
| `checksPanel.mode` | follows `guidance` | The Checks tab with suggested checks (`ravenseat checks on\|off`) | queue.json |
| `checksPanel.marker` | `true` | A small red dot on the Checks tab while an important (high) suggestion is open (`ravenseat checks marker on\|off`). Off hides only the dot | queue.json |
| `gates.fromKnownBugs` | `propose` | What a known bug becomes: `propose` (a task you approve), `auto` (approved at once, uses tokens without asking) or `off` | Advanced |
| `inspection.mode` | `on` | The inspection queue (see orchestration.md, "Repeated failures and the guard registry"): the same failure signature in the gates or CI, in at least `inspection.minRepeats` incidents within `inspection.windowDays` days, becomes one proposal to build a guard. `off` = no scan and no proposals | Basic |
| `inspection.minRepeats`, `inspection.windowDays` | `2`, `30` | The threshold: incidents (separate tasks, a branch and a day without a task, or CI commits), not runs, so one track's reruns count once | Advanced |
| `inspection.registryFile` | `.ravenseat/guards.json` | The guard registry, a tracked file in the project (`ravenseat guards`) | Advanced |
| `learning.repeats` | `true` | [Repeats on class and area](#repeats-on-class-and-area): the finding log is counted per class and area. It prints nothing and stops nothing; the Checks tab and the proposals read it. `false` = no count, no guard failed card and no proposals from the log (doctor reports it as a weakened guard) | Advanced |
| `learning.windowDays`, `learning.areaRepeats`, `learning.projectRepeats` | `90`, `2`, `3` | The threshold: incidents (separate tasks) of a class within the window, in one area or across the project. A fix without a proven red test weighs twice | Advanced |
| `learning.guardFailedMarker` | `true` | A class back where a guard for it was in place lights the red marker on the Checks tab. `false` = the card stays at medium, without the marker | Advanced |
| `learning.proposals` | `false` | A due class and area becomes one proposed gate task, under the cap of 3 shared with the inspection queue and the GATE lines. Off by default, with one setup tip and one Checks card | Advanced |
| `learning.dbProbes` | `false` | The [database probe recipes](checks.md#database-probe-recipes) for access control and migration failures that keep coming back (pgTAP, `supabase test db`, testcontainers), shown only when a local or throwaway database is found. A gate built from one checks that its database host is local before it writes, and rolls back. Off by default: a probe gate is heavy and needs a running database | Advanced |
| `learning.recipeDamping` | `true` | [Recipe precision](checks.md#recipe-precision): a recipe whose gate proposals are seldom accepted is listed on the Checks tab with its numbers, but no longer offered on the card. It stops nothing; `ravenseat checks recipe <id> show` offers one again. `false` = every recipe whose `when` holds is offered | Advanced |
| `learning.recipeMinProposals`, `learning.recipeMinProposalsDb`, `learning.recipeMinAccepted` | `5`, `10`, `30` | The damping threshold: a recipe below this percent accepted after this many decided proposals (accepted or declined; waiting ones do not count) is damped. A database probe recipe has its own, higher minimum, since it gets few proposals and is often declined for its cost | Advanced |
| `learning.quickGateCard` | `true` | [CI parity](checks.md#ci-parity-for-a-built-gate): a gate guard in the registry whose command is not in `gates.quick` gets a card on the Checks tab, and one click (or `ravenseat checks quick-add <G-n>`) adds that command at the end of `gates.quick`. Nothing runs from the card, the write can only add a command (never remove or replace one) and is refused from a track worktree. `false` = no card; it weakens no guard | Advanced |
| `learning.ciParityLift` | `true` | When a gate guard's kind of check (tests, types, lint) is not run in CI, `tests-in-ci` and `quality-in-ci` are put first in their priority and name the guard. Never the red marker. `false` = the usual order; it weakens no guard | Advanced |
| `learning.idleGuardDays` | `7` | `ravenseat guards` and `ravenseat doctor` give one INFO line for a gate guard with 0 runs this many days after it was built. INFO only, it stops nothing; `0` = off, which weakens no guard. The old `learning.idleGuardInfo` is no setting any more, but `false` in the file still turns the line off; `ravenseat settings set learning.idleGuardDays <n>` turns it on with it | Advanced |

### File and read guards

What a track may write, read and change: protected paths, dependency files, git hooks, control files and the read
limits. The main switch is `controlFiles.guard`.

| Key | Default | Used for | Marks |
|---|---|---|---|
| `protectedPaths` | hooks, settings, agents, skills, the orchestrator scripts, the queue config, `package.json`, and the test, lint and type configs | Merge guard: paths a track may only change when its task owns them (`owned_files`/`shared_patch`), else `merge` stops with exit 4. `"folder/"`, `"dir/file"`, a bare file name (any folder) or a glob with `*` or `?` (without a slash: the file name in any folder; with one: the path from the root, `**/` = any folders). The config defaults: `vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `cypress.config.*`, `karma.conf.*`, `.mocharc*`, `tsconfig*.json`, `.eslintrc*`, `eslint.config.*`, `biome.json*`, `pytest.ini`, `tox.ini`, `setup.cfg`, `conftest.py`, `pyproject.toml`, `mypy.ini`, `.coveragerc`, `.flake8`, `.golangci.*`, `Cargo.toml`, `Makefile`, `Justfile`/`justfile`, `.pre-commit-config.yaml`, `phpunit.xml*`, `.rspec`. Also `.husky/`, lefthook, `.npmrc`, `.yarnrc(.yml)`, `.pnpmfile.cjs`, `.vscode/`, `.gitattributes`, the project catalog `docs/queue/catalog/` ([the project catalog](catalog.md): a track changes it only when its task owns it), and `CLAUDE.md` and `.claude/` at any level. The match ignores case (`.CLAUDE/` is `.claude/` on Windows and macOS). Two forms: a list REPLACES the defaults (copy the entries you keep; `[]` drops them all), and `{ "add": [...], "remove": [...] }` changes them without copying: `add` extends the defaults, `remove` takes paths out of them. Neither form frees the floor (the queue config, `.claude/`, git hooks, `CLAUDE*.md`, `settings.queue.json` and the queue scripts): a floor path in `remove` stays protected. `ravenseat doctor` gives an INFO line per `remove` entry, and leaving out or removing a default path is a weakened guard | Advanced |
| `dependencyFiles` | `"stop"`, in lite `"warn"` | A task that changes `package.json`, a lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock` ...), `pyproject.toml`, `Cargo.toml`, `requirements*.txt`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle(.kts)` or `composer.json` without owning it: `"stop"` stops the merge like any protected path, `"warn"` warns and merges. Nothing else softens with it | Advanced |
| `gitSurface` | `"stop"`, in lite `"warn"` | Git hooks and executing git config against the accepted baseline: `"stop"` stops receive, merge and the push check on a difference, `"warn"` only warns, `"off"` compares nothing (see "Git hooks and config") | Advanced |
| `claudeFingerprint` | `true` | The fingerprint of your own Claude setup (see "Your own Claude setup"): `start` records hashes, `receive` warns with `CLAUDE SETUP CHANGED`. `false` = off | Advanced |
| `controlFiles.guard` | `true` | The write guard for the main tree's control files (see "The main tree's control files"): a queue agent's Write, Edit or shell write to `queue.config.json`, `.claude/` (not `.claude/worktrees/`), `CLAUDE*.md`, `.git/hooks/`, `.git/config` or the plugin's own scripts is denied, and so is a `git config` or `git remote` write. Its own worktree copies stay free, and the main session is not affected. `false` = off, a weakened guard | Basic |
| `controlFiles.fingerprint` | `true` | `fill` and `start` record a short hash of each of those files on the task (`control_fp`); `receive` warns with `CONTROL FILES CHANGED` about a change no commit explains. `false` = off, a weakened guard | Advanced |
| `ownership.sharedPatchCollides` | `true` | A path in a task's `shared_patch` that another active task has in `owned_files` counts as a shared file, both ways: the second task waits at `next` and `start` ("file x is owned by A", "file x is in the shared_patch of P"), and `merge` stops with exit 4 on such a path ("owned by B, in this task's shared_patch"; `--allow-guard` overrides and is logged). A function name in `shared_patch` matches no path, and two patches of one name stay a shared patch conflict. `false` = owned_files and shared_patch are not compared, as before; turning it off is a weakened guard | Advanced, Full mode only |
| `readGuard.agentTypes`, `readGuard.autoLoaded`, `readGuard.largeFiles`, `readGuard.maxLines`, `readGuard.blockLines` | `[]`, `[]`, `[]`, `300`, `2000` | The reading guard: more agent types it applies to, files Claude Code loads itself (never read again), files always read in excerpts, and the line counts that warn and that stop a read | Advanced |
| `readGuard.outline` | `true` | A denied whole-file Read of a large or long file also lists the file's outline with line numbers, at most 60 entries and a `… N more` line: Markdown `#` headings (not in code fences), JS/TS top-level `function` and `class` lines and `export` lines, SQL `create` statements. It stops nothing and fails open: another file type, a binary file, an unreadable file, a file over 1 MiB, a scan over 200 ms or nothing found gives the denial text as before. `false` = the denial text without it | Advanced |
| `reads.mode` | `wait` | Read ownership (the task field `reads`): `wait` = a task waits while one reads a file the other changes; `warn` = it starts with the overlap named (`READS WARNING`, `explain`, the mission). `doctor` names any other mode | Advanced, Full mode only |
| `hotspots` | `[]` | Shared config many tasks need to touch (a route table, a registry, a central index), in the same pattern forms as `protectedPaths`. A hotspot can never be in a task's `owned_files`; a task that may change one names it in `hotspot_patch`, and only one active task can hold it at a time. A track that changes a hotspot it has not agreed gets a write warning, the pulse and `receive` say it, and `merge` stops with exit 4 (`--allow-guard` overrides and is logged). The track writes a wiring spec instead (`WIRE` lines), and the owner or the hotspot holder applies it; `done` waits until each item is closed (`wiring.stop`) | Advanced, Full mode only |
| `contextGuard.blockOtherChats` | `false` | Chats that are not the orchestrator are stopped at 400k context instead of only getting the warning | Advanced |

### Command and secret guards

What an agent may run or send out: push, network, deploy, the main session's overrides, the secret scans and the
opt-in checks. The main switch is `agentGuard.enabled`.

| Key | Default | Used for | Marks |
|---|---|---|---|
| `injection.ownerMark` | `true` | The owner mark: each mission (task and round) gets a mark of its own (an HMAC with a local key in the data folder, `owner-mark.key`, never pushed) in its frame and on the owner answer and bonus headings. `receive` prints `SUSPICIOUS CONTENT` and the review package gets a "Suspicious content" section when the report claims owner approval without that mark, or carries another mark. A warning, never a stop; cloud missions are not checked. `false` = no mark and no check | Advanced |
| `secretScan.atReceive` | `false` | Off by default (a new check is opt-in: `setup` tips about it once, and the Checks tab has a card with "Turn on"). On: `receive` scans the track's own commits (`<baseBranch>..<branch>`, every commit) with the same patterns, test and fixture exceptions and time limit as the push check. A hit opens the blocker `secret-found` with file:line and the rule, never the value, and `merge` refuses until a clean receive (the fix round takes the key out of the branch history), `unblock`, or `merge --allow-secret` (owner and orchestrator only, logged as `secret-overridden`). A scan that does not finish only warns | Advanced |
| `secretScan.allowlist` | `false` | Off by default. On: `doctor` (row `allowlist`) reads the commands Claude Code has approved (`permissions.allow`, `ask`, `deny` in `.claude/settings.json` and `.claude/settings.local.json`, also in the agents' worktrees) and names one with a key as `<file>: permissions.allow[3]`, never the key: FAIL in a tracked file, WARN on disk. The same setting covers `.mcp.json` (row `mcp`): a key in a server's `env`, `headers`, `args` or `url` is named as `<file>: mcpServers.<name>.env.<KEY>`, FAIL when tracked, WARN on disk, with `${ENV_VAR}` as the fix. Off: one INFO line in `doctor`, only while a key sits in a tracked file (never which), also when the Checks card is set aside; `doctor --all` shows it always | Advanced |
| `permissionsCheck.enabled` | `false` | Off by default. On: `doctor` (row `permissions`) names the broad rules in the tracked `.claude/settings.json`: any shell command (`Bash(*)`, a bare `Bash`), network tools, `rm`, `git push`, `WebFetch` without a domain, and `defaultMode` `bypassPermissions` or `acceptEdits`. WARN for any shell command and the two modes, INFO for the rest; a narrow rule such as `Bash(npm test:*)` is fine. Only `bypassPermissions` in the tracked file raises the Checks card to important | Advanced |
| `dbGuard.localOnly` | `false` | Off by default. On: a database probe gate (`pg_prove`, pgTAP, `supabase test db`, `sqlx test`, also through an npm script) whose database is not local (`localhost`, `127.0.0.1`, `::1`, a socket or a Docker service name) is refused before it runs: red, one `REFUSED (dbGuard.localOnly)` line with the host, never the URL. It reads a URL or `-h`/`--host` in the command, a `PGHOST=` prefix and `supabase ... --linked`, else `DATABASE_URL`, `TEST_DATABASE_URL` and `PGHOST`. Applies to the gates and the base gate, and a refused run is never rerun as flaky. Known limits: a short single-word host is taken for a Docker service name, so counts as local, and a URL inside a file (a config or an .env the probe reads) is not read | Advanced |
| `gitignoreCheck.enabled` | `false` | Off by default. On: `doctor` (row `gitignore`) checks with your global gitignore switched off that the project's own `.gitignore` ignores what Ravenseat keeps local (the lines `setup` writes, the configured `dataFolder` and `timeLog`, `.claude/worktrees/`), and FAILs a tracked file in it. Off: one INFO line in `doctor`, only while an important gap is there, also when the Checks card is set aside; `doctor --all` shows it always | Advanced |
| `secretScan.enabled`, `secretScan.maxBytes`, `secretScan.timeoutMs` | `true`, `2000000`, `3000` | Secret check before a plain push of the base branch from the main session: the added lines of every commit in `<remote>/<baseBranch>..<baseBranch>` are scanned (gitleaks when on PATH, else built-in patterns, JWTs, URI passwords and `.env` files included) and a hit asks with file:line, never the value. A first push (no remote ref) scans the branch, minus what the remote has on other branches. A scan that does not finish (over `maxBytes`, over `timeoutMs` per git or gitleaks call, over the 6 s the whole scan has, any error) asks too, and says why; it never stops the push by itself. The 6 s stay below the hook's own 10 s, so a larger `timeoutMs` cannot let the hook be killed | Advanced |
| `deployCommands` | `[]` | Commands that deploy, e.g. `["vercel --prod", "fly deploy"]`: the push guard asks before any command that starts with one of them, from an agent or the main session (a prefix match after env prefixes, so `npx vercel --prod` needs its own entry; a command inside `bash -c "..."`, `( )` or `cmd /c` is seen too). Empty = off | Advanced |
| `guardLog.enabled` | `true` | Every deny and ask from the push, write and read guard is one row in the time log (`guard-deny`, `guard-ask`: guard, rule, agent type, task, time, never the command); `doctor` (row `guards`) and the board's Statistics tab count them per track. `false` = no such rows, a weakened guard | Advanced |
| `guards.secretReads` | `"log"` | A guarded agent that prints secrets in a shell command: `cat`, `type`, `Get-Content`, `head`, `tail` or `less` of a `.env*` file (not `.env.example` and the like) or a `.pem`/`.key` file, `printenv`, `env` or `set` with no arguments, `Get-ChildItem env:`. `log` = allowed, one `guard-log` row in the time log (guard `secrets`, the rule, never the command), counted per track on the Checks tab. `block` = denied, with the hint to reference the variable instead (`psql "$DATABASE_URL"`). `off` = nothing. Block can stop work, so it is not the default | Advanced |
| `redact.envValues` | `true` | The exact values in the main tree's `.env`, `.env.local` and `.env.*` files (never `.env.example`, `.sample`, `.template`) are removed as `[REDACTED:env-value]` from everything Ravenseat stores from transcripts and commands: gate and done tails, the review package, the SILENT snapshot, the time log's remark. Held in memory only, never written or logged; values under 6 characters and plain ones (`true`, `localhost`, numbers, a URL without a password) are skipped. It stops nothing. `false` = the pattern redaction alone, a weakened setting | Basic |
| `approvals.ask` | `true` | Claude Code's own permission dialog before the main session's overrides (see "The main session's overrides ask you"): `merge` with `--allow-*` or `--force*`, `--i-understand`, `--by owner` or `--by theBoard`, `--set-by owner`, `surface accept`, `owner-log accept`, `helpers approve`, a call to the board's API, and a direct Write or Edit of a main tree control file. In the permission modes `dontAsk` and `bypassPermissions` it is a denial with the way out (run it in your own terminal). The ordinary commands never ask. `false` = no question, a weakened guard | Advanced |
| `agentGuard.enabled` | `true` | The push, network and write guards apply to every subagent, whatever its agent type (a general-purpose agent, Explore, a custom one), not only to the queue's own. Read-only commands stay allowed, so Explore and other helpers that only read keep working. The main session is never guarded. `false` = back to the queue's own agent types only (tracks, reviewers, helpers); `ravenseat doctor` warns `AGENT GUARD OFF`, and turning it off is a weakened guard | Basic |
| `agentGuard.except` | `[]` | Agent types (from your own `.claude/agents`) the guards leave alone, e.g. `["my-deployer"]`. The queue's own agent types can never be listed out. `ravenseat doctor` gives an INFO line per entry, and an entry is a weakened guard | Advanced |
| `agentPushBlock.enabled` | `true` | A git `pre-push` hook that stops a push from a track's worktree, also when the push guard never saw the command (a script the agent ran). `fill`, `start` and `resume` install it in the hooks folder git uses (after the first line of an existing shell `pre-push` from husky, lefthook or your own, which keeps running), and `prepare-track` marks the worktree. Pushes from the main checkout and from worktrees you made yourself are not affected, and the git surface baseline knows the block, so it never stops `receive`. `false` = removed at the next `fill`, `start` or `resume`; `ravenseat doctor` warns that agents can push from git itself when the text guard does not see the command, and turning it off is a weakened guard | Advanced |

### Merge and push

| Key | Default | Used for | Marks |
|---|---|---|---|
| `push.mode` | `"owner"` | `owner` = push only on the owner's word; `threshold` = the orchestrator may push on READY or LARGE, never BLOCKED (`ravenseat push-check` prints READY, NOT YET, BLOCKED or LARGE) | Basic |
| `push.minTasks`, `push.warnTasks`, `push.maxAgeHours` | `10`, `50`, `null` | Batch push threshold, counted in merged tasks since the last push. Below `minTasks` (0 = off) or on a red base the push guard asks before a plain push of the base branch; never denies. `warnTasks` makes a batch LARGE; `maxAgeHours` makes old work ready below `minTasks`. `threshold` with 10 and 50 for projects with expensive CI (see orchestration.md, Batch push) | Advanced |
| `push.allowBranches` | `[]` | Branches the main session may push besides the base, for pull request flows: `["feat/*"]`, where `*` is any text. A forced push of such a branch asks first. Queue agents never push, a forced push of the base or a delete stays denied, and the secret scan runs on these too. Without it, you can also point `baseBranch` at an integration branch and open the pull request from that | Advanced |
| `push.pr` | `"off"` | `draft`: `ravenseat pr` opens one draft pull request per batch from `ravenseat/batch-<date>`, after a preview and your yes; the branch must be in `push.allowBranches`. Off by default: it posts on GitHub | Advanced |
| `push.controlsWarning` | `true` | The push guard asks before a plain push of the base branch when the project has no CI config or no gates, with what is missing and how many commits go out. It never blocks. `false` turns the question off; `ravenseat controls dismiss` stops it for this project only, until something else goes missing | Advanced |
| `push.ownerAsk` | `true` | With `push.mode` `owner`, every plain push of the base branch by the main session asks you first, with the tip and the merged tasks, also when the batch is ready (a batch known to be empty does not ask). A denial in `dontAsk` and `bypassPermissions`: push from your own terminal. No effect in `threshold`. `false` = only the batch questions, a weakened guard | Advanced |
| `reviewItems.stop` | `true` (`false` in Lite mode) | Each `FINDING` line of a chosen reviewer becomes an item on the task (`merge`, `resume --reason fix`), and `set <id> done` and the done step of `merge` refuse while one is open, with the commands that close it (`ravenseat review-item`). `false` = done passes and says `REVIEW ITEM STOP OFF`; the items stay open. Off in Lite mode, the same as `reviewItems.stop`: a first try should not meet a hard stop. Turning it off is a weakened guard | Advanced |
| `review.requireFindings` | `true` | `merge` stops when a reviewer chosen for the class has no `FINDINGS` report after the review package, or the newest one has `H>0`. `merge --allow-unreviewed` goes past it (owner only, logged as `unreviewed-overridden`). `false` = no gate; the findings are still recorded. Turning it off is a weakened guard | Advanced |
| `wiring.stop` | `true` (`false` in Lite mode) | Each `WIRE <file> \| <what>` line in a track's report becomes an open item on the task (`receive`), and `set <id> done` and the done step of `merge` refuse while one is open, with one line per item and the commands that close it (`ravenseat wiring <id> <item> --commit <sha>` or `--reject "<reason>"`). `false` = done passes with open items and says `WIRING STOP OFF`; the items stay open. Turning it off is a weakened guard | Advanced |
| `push.ciWatch`, `push.ciWatchIntervalSec`, `push.ciWatchTimeoutMin` | `"off"`, `60`, `90` | The optional CI watch after a batch push: `"github"` (needs `gh`) makes push-check print `ravenseat push-check --watch-ci <sha>` for the orchestrator to start in the background. A failed check gives one fix task `CI-<sha7>` and a red base (exit 9), an infrastructure failure an owner question `ci-<sha7>-infra` and no freeze, a timeout exit 10. Local gates stay the rule (see orchestration.md, Batch push) | Advanced |
| `migrations.folder`, `migrations.filePattern`, `migrations.blockSize` | `null`, `^(\d+)_.*\.sql$`, `10` | Optional numbered migrations: the folder (`null` turns block numbering and migration push off), the pattern whose first group is the number, and how many numbers a task reserves | Advanced |
| `migrations.pushCommand`, `migrations.environmentFile`, `migrations.allowedEnvironment` | `null`, `null`, `[]` | `merge` runs the push command after merging (skip with `--without-migr-push`), but only when the environment file names an allowed environment | Advanced |

### Private and sharing

| Key | Default | Used for | Marks |
|---|---|---|---|
| `share.queueData` | `false` | Keeps the queue's own files (`share.include`) in git as a backup. Off: the whole data folder is ignored. Turned on only by `ravenseat share on`, which explains who can read them and needs `--yes` (and `--public-ok` in a repo that is public or of unknown visibility), or by Turn on on the Checks card, offered only in a private repo; `settings set` cannot write it. On: the .gitignore gets `<dataFolder>/*` and `!<dataFolder>/<file>` per file, and the push and merge guard still refuse every other data folder file | Advanced |
| `share.include` | `["queue.json", "plans.json"]` | The data folder files that are shared. The time log, missions and prompt files, reports, transcript extracts, the owner's answers and questions, locks, the gate evidence, the board key and setup-tips.json can never be listed; such an entry is refused with the reason | Advanced |
| `share.publicOk` | `false` | Written by `share on --public-ok`. Without it, the push guard refuses a commit with the shared files as soon as the repo is not known to be private (also when a private repo turned public after share on). The visibility is cached for 24 hours in `<dataFolder>/repo-visibility.json`; the push guard reads only the cache | Advanced |
| `privatePaths` | `[]` | Your own private folders (`"docs/internal/"`) and files. One list drives the .gitignore (setup, `doctor --fix`), the push and merge guard (a commit that tracks a file there is refused) and the cloud's hidden paths. `{ "path": "...", "read": false }` also denies the queue's agents (tracks, reviewers) a Read there; the main session is never stopped. `ravenseat private add <path> [--no-read]`, `remove`, `list` | Advanced |
| `deps.audit` | `manual` | [The dependency audit](catalog.md#the-dependency-audit): `ravenseat catalog deps --audit` asks OSV.dev about the public packages in your lockfiles (ecosystem, name and version only) when you run it, and the Checks tab shows one card for what it found. Nothing is checked automatically. `off`: the command refuses and there is no card; it weakens no guard | Advanced |
| `deps.privateScopes` | `[]` | Names or prefixes the audit never sends (`@acme`, `github.com/acme`, `acme-*`), besides what the lockfile shows is private: workspace, `file:`, `link:`, git, a local path or another registry | Advanced |
| `deps.auditStop` | `false` | Reserved for a later step: a merge with a package that has a known high hole would stop. Not wired yet, so it does nothing today; off, since it can stop work | Advanced |

### Review and agents

| Key | Default | Used for | Marks |
|---|---|---|---|
| `helpers` | challenger (U, `bug`) and design (`visual`) on; tests, gap, docs off | Optional helper agents with conditions; switch with `ravenseat helpers on\|off <agent>` (see orchestration.md) | queue.json |
| `helpers.reviewer-gap.acceptance` | `true` | A task with `acceptance` criteria gets the gap reviewer at receive even while `reviewer-gap` is off, with one reason line (`acceptance: 3 criteria`); it checks each criterion MET or NOT MET. A NOT MET is a normal fix round, never a stop | Advanced |
| `reviewers` | D: `reviewer`, D+: `reviewer` + `reviewer-security` | Fixed reviewer agents per class after `receive` | Advanced, Full mode only |
| `review.signals` | `{}` (the built-ins `auth`, `secret`, `url-from-data`, `html-sink`) | Review signals: what the diff adds (code files only, never tests, comments or docs) lifts a reviewer in on top of the class, with one line of reason in the package. Per signal `enabled`, `reviewer`, `paths` and `words` (regular expressions, added to a built-in); a name of your own is a new signal. Switching a built-in off is a weakening. `ravenseat helpers` shows the hit rate per signal | Advanced |
| `review.packs` | `[]` | Stack packs for the review signals: ids such as `core`, `nextjs`, `prisma`. A built-in pack is read from the plugin at run time, so it follows updates; an unknown id is ignored. The Checks tab suggests them from the manifests, and `ravenseat checks packs --apply` writes them ([orchestration](orchestration.md#stack-packs)) | Advanced |
| `triage.minAgeDays`, `triage.agentAdded`, `triage.maxPerFill`, `triage.askAgainMin` | `3`, `true`, `3`, `60` | Intake triage before a task starts: tasks added or last edited this many days ago (`null` = off) and agent-added tasks get a `triage` verdict first (`ravenseat triage`); at most this many steps per fill, not asked again within this many minutes. Off with `ravenseat helpers off triage` and in lite mode (see orchestration.md) | Advanced, Full mode only |
| `planReview.mode`, `planReview.classes` | `"advisory"`, `["D+"]` | The plan review before a risky task (a class in the list, or a task in an accepted sensitive zone): a fixed five-point checklist on the triage's step, notes with `file:line` into the mission. `block` makes an `ask` an owner question before the start (off by default, it stops work); `off` turns it off ([plan review](#plan-review-before-a-risky-task)) | Advanced |
| `mission.riskFirst` | `true` | A task's `risk_first` is checked first in the track, which stops with PARTIAL and one owner question if it fails; a zone task without one is told to prove the choice can be reversed. The block appears only when it applies ([riskiest assumption](#riskiest-assumption-first)) | Advanced |
| `planChecks.missionPaths`, `planChecks.emptyOwnership`, `planChecks.sizeNotSet` | `true`, `true`, `true` | The checks before a task starts, each one line at add and start and never a stop: paths the mission names outside the task's files, a K/D/D+ with no `owned_files`, a D/D+ without `content_min` ("size not set") ([checks before a task starts](#checks-before-a-task-starts)) | Advanced, Full mode only |
| `planChecks.ownerQuestionCount` | `true` | At receive, an `ownerQuestions` count on the RESULT line that does not match the report's owner question section gives one NOTE ([checks before a task starts](#checks-before-a-task-starts)) | Advanced |
| `decisionSignals.enabled`, `decisionSignals.deleteMin`, `decisionSignals.bigDiffLines` | `true`, `3`, `300` | Decision signals at receive, read from the diff (no tokens, never a stop): a new package (npm by name, other manifests "changed"), a migration or schema file, at least `deleteMin` deleted non-test files, and unstated choices (`bigDiffLines` changed lines without Assumptions, or owner question text with `ownerQuestions=0`). A signal no owner question names is "not asked". One `SIGNALS:` line, `decision_signals` on the task, one `signal` time log row per delivery and an entry in [Decided for you](#decided-for-you) | Advanced |
| `proposals.autoAccept.enabled`, `proposals.autoAccept.classes`, `proposals.autoAccept.maxEstimateMin`, `proposals.autoAccept.maxValue` | `false`, `["K"]`, `60`, `null` | Auto-accept of agent proposals by the owner's rules (`ravenseat proposals`); the queue's own rules win; never D/D+, `waiting_on`, legal/owner labels, open legal points or protected paths. Switching it on weakens a guard: `ravenseat proposals auto on --i-understand --by owner` | Advanced, queue.json |
| `architectureRules` | `[]` | Short rules copied into every mission | Advanced |
| `attempts.reservationTtlMin` | `30` | A start reservation with no start for this long counts as expired | Advanced |

### Scope and catalog

| Key | Default | Used for | Marks |
|---|---|---|---|
| `scopeNotes.reuse`, `scopeNotes.newFolders`, `scopeNotes.dependencies`, `scopeNotes.drift` | `true`, `true`, `true`, `true` (`drift` is `false` in Lite mode) | [Reuse and scope notes](#reuse-and-scope-notes) at `receive`: a name the base already defines in another file, a new folder, a second package for the same job, and drift in numbers. One `NOTE` line each and a `Reuse and scope` section in `00-package.md`; nothing stops and no tokens are used. `false` turns that part off; it weakens no guard. Drift is off in Lite mode, where a task names no files, so every changed file would count as outside it | Basic |
| `scopeNotes.ignoreNames`, `scopeNotes.folderDepth` | `[]`, `2` | Names the reuse note never reports (on top of `main`, `run`, `setup` and a few others), and how deep the new folder note looks (1 to 3) | Advanced |
| `scopeNotes.driftGap`, `scopeNotes.driftGapFiles`, `scopeNotes.driftGapShare` | `false`, `4`, `40` | Opt-in (V6): receive adds the gap reviewer when at least `driftGapFiles` (1 to 100) changed files and over `driftGapShare` % (1 to 99) of them lie outside the task's files and reads. Costs one reviewer run when it fires; never for a task that names no files | Advanced, Full mode only |
| `scopeNotes.driftWarn` | `false` | Opt-in (V7): one note per file to a track while it writes outside its files and reads, never a denial | Advanced, Full mode only |
| `catalog.doctor` | `true` | `ravenseat doctor` gives one WARN row `catalog` when `ravenseat catalog check` finds an error in [the project catalog](catalog.md) (a bad shape, an unknown status, a choice set to `accepted` that the owner has not accepted). Only a warning; `false` turns the row off and weakens no guard | Advanced |
| `catalog.missionExcerpt`, `catalog.reviewExcerpt`, `catalog.excerptTokens` | `true`, `true`, `1500` | [The catalog excerpt](catalog.md#the-excerpt-in-the-mission-and-the-review-package): the part of the project catalog that meets the task's files goes into its mission and its review package, at most this many tokens (200 to 6000), with the size and what was cut in its heading. Nothing without a catalog; `false` leaves that excerpt out and weakens no guard | Advanced |
| `catalog.index` | `false` | [The code index](catalog.md#the-code-index-and-catalog-find): an index of the code's exports (JS/TS), built at receive and for each mission and cached by file sha in the data folder. The excerpt then gets the helpers tagged `@shared` in the task's folders, and the review package the new names close to an existing export (V1b). `ravenseat catalog find` works without it. Off by default; it stops nothing either way | Advanced |
| `catalog.checks` | `true` | [Check rules](catalog.md#check-rules): receive runs the `check` rule of each design choice against the delivery's added lines in its `paths`. An accepted choice gives a `CATALOG` line, a line in the review package and a record on the task; a proposed one a `NOTE` only. Stops nothing; nothing without a `check` field. `false` turns the rules off and weakens the protection | Advanced |
| `catalog.checkStop` | `false` | An accepted choice with `mode: stop` stops `merge` (exit 1) when its rule matches the merge's diff; `merge <id> --allow-catalog` on the owner's word, logged as `catalog-overridden`. Off by default, since it can stop work: a stop rule is then a warning | Advanced |
| `catalog.gateAfter` | `3` | When the same accepted rule is broken in this many separate tasks (2 to 20), receive proposes a GATE task to make it a real lint, inside the shared proposal cap. Only with `learning.proposals` on | Advanced |
| `catalog.captureAnswers` | `explicit` | [Owner answers into the catalog](catalog.md#from-an-owner-answer-to-a-design-choice): `explicit` lets `resolve --keep` and "Keep as design choice" in Decisions turn an answer into a proposed design choice, which you accept yourself. `suggest` also marks the questions that read like a lasting rule (and `resolve` prints the line to keep one); it can be noise, so it is not the default. `off`: never, and `catalog propose` refuses too. Nothing is ever accepted by it | Advanced |
| `catalog.stackFacts` | `true` | [Stack entries](catalog.md#stack-entries): the tool and the `stack` words of each stack entry you accepted join the stack the Checks tab sees, so a recipe's `stack:<word>` holds and the dependency audit card names its command (`pnpm audit`, `cargo audit`). It can change which cards show and stops nothing; only accepted entries count. Off: the cards follow the manifests alone | Advanced |
| `catalog.depsExcerpt` | `true` | [Dependencies](catalog.md#dependencies): each task's excerpt lists the libraries its files import, with the version locked here, the local types or README and the docs link from the `## Dependencies` table in `stack.md`. Only text inside the same cap, cut before the reuse rows, no network. Off: the excerpt without those rows | Advanced |
| `notBuilding.match` | `true` | [Not building](catalog.md#not-building): a new task at `add`, a track's proposals at `receive` and a captured plan that contain a keyword of an entry you chose not to build get one `INFO not-building:` line with the date and the reason, and doctor names entries whose revisit date has passed. Advice only: it stops nothing, and off weakens no guard | Advanced |
| `catalog.planLinks` | `true` | `plan new` and `plan edit` check a plan entry's `decisions` against [the project catalog](catalog.md) and warn about an id the catalog does not have. The shape (`D-0001`) is always checked; `false` turns the lookup off and weakens no guard | Advanced |

### Board and advice

| Key | Default | Used for | Marks |
|---|---|---|---|
| `guidance` | `guided` | `guided`: advice about CI, gates and checks; `quiet`: no advice, guards and facts stay (`ravenseat guidance quiet\|guided`) | queue.json |
| `board.mascot` | `chatty` | How much the mascot talks when a viewer has switched it on: `chatty`, `events` (only events and clicks) or `off`, for every viewer; the default logo never talks | Basic |
| `board.panelMode` | `float` | How the side panel (a task, Settings, the help) sits on a wide screen: `float` over the board (nothing reflows, a click outside closes it) or `beside` (the board makes room for it); below 1200 px a modal sheet in both (see board.md, The task panel) | Basic |
| `board.shortcuts` | `true` | One-key shortcuts on the whole board: `?` lists them, `/` search, `g` and a letter opens a tab, `j`/`k` between cards; never in text fields or dialogs (see board.md, Keyboard shortcuts). `false` leaves only the keys on a focused card and in Decisions | Basic |
| `board.palette` | `true` | `Ctrl+K` opens the command palette: find a view, a card or a setting and go there, or copy its `ravenseat` command; it changes nothing itself and needs `board.shortcuts` (see board.md, Command palette). `false` leaves `Ctrl+K` to the browser | Basic |
| `board.structuredSearch` | `true` | The search box also reads fields such as `class:D`, `status:blocked`, `age>2d` and `-class:K`, with suggestions; plain words search as before (see board.md, Structured search). `false` searches every word as plain text | Advanced |
| `board.titleCount` | `true` | The browser tab title starts with the number of decisions waiting on you, `(3) Queue board`; running tracks are not counted | Advanced |
| `board.quickFilters` | `true` (full), `false` (lite) | The quick filter buttons over the columns: Changed 24 h, Older than usual, Red gate (see board.md, Quick filter buttons) | Advanced |
| `board.sinceLast` | `true` | "Since you left" at the top of Decisions: merged, recovered without you, blocked, waiting on you, spend and the latest events in the window; hidden when nothing happened (see board.md, Since you left; `ravenseat since` gives the same) | Basic |
| `board.sinceLastWindow` | `last-seen` | Its window: `last-seen` (the seen mark in `<dataFolder>/seen.json`, the last 24 hours without one), `24h` or `7d`; "Decided" in Decisions follows it | Advanced |
| `board.blockedColumn`, `limits.autocompact` | `false`, `true` | A Blocked column right after In queue for the tasks with an open blocker that needs action (see board.md, What it shows; `ravenseat board-setting blocked on\|off`); Claude Code compacts the orchestrator session itself and the queue continues | queue.json |
| `board.port`, `board.title` | `2000`, `Queue board` | The board's local port and title | Advanced |
| `board.hideKey` | `true` | The board opens itself in your browser with its key and prints the link without it (`ravenseat board open` opens it again); a write without the board's Origin is refused. `false` prints the link with the key, as before, and is a weakened guard (see board.md) | Advanced |
| `updates.check` | `true` | Look for a newer ravenseat on GitHub at most once per 24 hours: the board shows a banner, and `ravenseat show` (at most once a day per version) and `ravenseat doctor` (an INFO row) one line with the update command. `show` only reads the cache and refreshes it in the background, so it never waits on the network; the line stays out of `--json`, agents and track worktrees, CI and hooks. `ravenseat update dismiss` hides a version everywhere. It never stops any work. The old name `board.updateCheck` still works; `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also turn it off (see board.md, Update banner) | Advanced |
| `board.showCloud` | `true` | Board: show the Cloud tab while `features.cloud` is on. `false` keeps the tab away with the module on (`ravenseat board-setting cloud on\|off`) | Advanced, queue.json |
| `features.statistics`, `features.follow` | on, off | Modules that can be switched off: the Statistics tab, and the follow-up page with its commands and lines in `show` and the pulse. Off hides them on the board (tabs, buttons, routes; see board.md, Modules); `follow*` commands answer that the module is off with exit 0. Restart the board after a change | Advanced |
| `instructionSize.mode`, `instructionSize.maxLines`, `instructionSize.maxChars` | `warn`, `200`, `40000` | Advice about the size of Claude's instructions (what loads at the start of every session, track and subagent): a doctor row, a Checks suggestion and one chat message when an always-loaded file has more than `maxLines` lines or the whole set more than `maxChars` characters. `off` turns all of it off; it is advice, not a guard, and quiet guidance hides it too. See [costs.md](costs.md#claudes-instructions) | Advanced |
| `client.canary`, `client.shapeLog` | `true`, `false` | The format canary: `ravenseat doctor` reads the tail of the project's newest Claude Code transcript and gives one `canary` row (OK, INFO when the version is newer than the formats Ravenseat's fixtures cover, shown only by `ravenseat doctor --all` since it reads as expected, WARN when rows read differently: new row types, assistant turns without token usage, API errors of an unknown kind; never FAIL), and the Checks tab shows one medium card while such rows are seen. Type names and counts only, never content, and it stops nothing; `false` hides both. `shapeLog` lets `ravenseat checks` write the shape of each new API error form (keys, value types and short codes, no text) to `client-shapes.jsonl` in the data folder, so it can be reported | Advanced |

### Cloud

| Key | Default | Used for | Marks |
|---|---|---|---|
| `features.cloud` | off | Tracks in cloud sessions: the Cloud tab, the cloud filter and the cloud commands (`ravenseat cloud on\|off`); off, `cloud*` commands answer "Cloud is off (features.cloud in queue.config.json)." with exit 0 | Basic |
| `cloud.maxSessions` | `3` | At most this many cloud sessions at once (a bundle counts as one), with no upper limit of its own. They share your plan's usage limits. `ravenseat cloud set` or the gear changes this and the settings below | Advanced |
| `cloud.offerOnLeave` | `true` | The orchestrator offers `ravenseat cloud-go` once when you say you are leaving. `false` keeps it silent; the command still works | Advanced |
| `cloud.collect` | `ask` | When a session has finished: `off` you run the steps, `ask` the orchestrator asks and then runs `cloud collect`, `auto` it runs it without asking. Merge follows the usual rules in all three. `auto` is a weakened guard (the owner no longer sees each session before its work is collected) and needs `--i-understand --by owner`, also from the board | Advanced |
| `cloud.deleteBranch` | `true` | Remove the session's branch from the remote after the merge | Advanced |
| `cloud.bundleMax` | `4` | Tasks in one session, one after another | Advanced |
| `cloud.start` | `terminal` | `terminal`: you run `ravenseat cloud-start <id>`. `routine`: `ravenseat cloud send <id>` fires a scheduled task, without a terminal | Advanced |
| `cloud.fireUrl` | `null` | With `routine`: the API trigger's URL on api.anthropic.com. The token goes in the environment variable `RAVENSEAT_CLOUD_TOKEN`, never in a file | Advanced |
| `cloudHidden` | `[]` | Paths a cloud session cannot see (missions pointing there are stopped) | Advanced |

### Plans and focus

| Key | Default | Used for | Marks |
|---|---|---|---|
| `features.plans`, `features.focus` | on, on (`focus` is off in Lite mode) | The board's Plans room (`ravenseat plan` always works) and Focus tab (`ravenseat focus` always works). The Focus tab is off in Lite mode, which has no focus steps, so it would stay empty | Basic |
| `features.plans.legal`, `features.plans.launch`, `features.plans.documents` | off | The Legal, Launch and Documents surfaces in Plans; a part is off when `features.plans` is off | Advanced, Full mode only |
| `features.plans.inbox` | on | Quick capture in Plans: the "+ New plan" button and form (a title, and optionally a few sentences, straight into the Inbox, with Undo). Off hides the button and the board refuses `/api/plan-capture`; `ravenseat plan capture` always works. Off when `features.plans` is off. It stops nothing | Advanced |
| `plans.startView` | `roadmap` | Where Plans opens: `roadmap` (the plans in horizons, in plain words), `overview` (the area cards) or `list` (Plan entries); the others stay under More views. Has effect only while `features.plans` is on | Basic |
| `plans.roadmapLayout` | `auto` | The Roadmap's layout: `auto` puts the horizons side by side as columns from 1200 px and one list below, `columns` or `list` always that. A viewer's own choice on the board wins (remembered per browser); below 700 px it is always one list | Advanced |
| `plans.roadmapFoldAfter` | `8` | How many plans a long Roadmap section shows before "Show n more" (`0` = never fold). Inbox and Waiting on you always show every plan, Done is folded until opened, a search or filter shows every match | Advanced |
| `plans.leadFromDocument` | `true` | A plan without a summary shows the first lines of its plan document on the Roadmap, marked "From the plan document" (read through the `/api/doc` guard, cached per file, at most 512 KB). `false` reads no document for the Roadmap. It stops nothing | Advanced |
| `plans.searchDocuments` | `true` | The Roadmap and Plan entries search also looks in each plan's document (the same guard and 512 KB cap, passages cached per file by time and size) and shows the matching sentence under the row, with the match marked, after the plans whose title or summary match. Friction: none, it only adds results; `false` for a very large document folder, where the first search after many changes reads every plan document. It stops nothing | Advanced |
| `plans.inboxTriage` | `on-request` | When Claude writes proposals for the Inbox (`/plans inbox`): `on-request` only when asked, `idle` also when the queue has free slots (the `INBOX:` line says so; costs tokens), `off` refuses `plan propose` (sort by hand on the board). Friction: on-request leaves a captured idea waiting until someone asks; nothing applies a proposal without the owner's Accept. It stops nothing | Advanced |
| `plans.inboxAutoApply` | `false` | On: `plan propose` applies a proposal at once when it keeps a captured plan at Later and merges nothing (findings, priorities and merges still wait); `plan undo` takes it back. Friction: off means one Accept per item; on changes plans without the owner seeing them first, so it is off. It stops nothing | Advanced |
| `shape.nudge` | `offer` | A request with no plan entry that would split into more than `shape.threshold` tasks, or touches a sensitive zone: `/add-to-queue` asks once, shape it first (recommended), the smallest version first, or build it all now (recorded as `shaped` on the tasks). `always-shape` shapes without asking first; `off` is as before. Friction: one question, only for large requests. It stops nothing ([plan gate](plan-register.md#decide-before-you-build)) | Advanced |
| `shape.threshold` | `5` | The task count above which the shape-first question comes; a zone hit asks whatever the count | Advanced |
| `plans.decisionNote` | `true` | A plan of size L or XL, or in a sensitive zone, expects a one-page decision section ([decision-note.md](decision-note.md)) linked as a source with role `decision`; `/plans` writes it, `plan get` shows missing, incomplete, skipped or done. Friction: a page per large plan, nothing for small ones. `false`: none is expected | Advanced |
| `plans.readyCheck` | `advisory` | Setting such a plan to `ready` without a complete section: `advisory` prints one WARNING naming what is missing, `block` refuses the edit (off by default, it stops work), `off` says nothing. `plan edit <id> --skip-decision "<reason>"` records a skip and lets it through | Advanced |
| `plans.checkpoint` | `offer` | A large plan (L, XL or a sensitive zone), or the answer "smallest version first": `/add-to-queue` queues the first part and the rest waiting on one checkpoint question `CP-<plan>` (`ravenseat plan checkpoint`). It stays hidden until the first part is done, then asks Continue (the rest starts), Adjust (parked for a rewrite) or Stop (parked; you cancel). `offer` offers it per plan, `always` does it without asking, `off` queues it all startable. Friction: the rest waits for one answer, which stops work, so it is never applied without a choice ([staged queueing](plan-register.md#staged-queueing)) | Advanced |
| `zones.detect` | `true` | Tasks are matched against the sensitive zones accepted in the catalog ([zones](catalog.md#sensitive-zones)): a NOTE line at add, a card badge, and the plan gate covers them. `ravenseat catalog zones` proposes zones from the repo; none counts before you accept it. Friction: none while no zone is accepted; then one line and a badge. It stops nothing; `false`: no task is in a zone | Advanced |
| `plans.postCheck` | `true` | When every queue task of a plan is done: a Plans follow-up row in Statistics (size estimate against tasks and fix rounds, estimate against measured time, cost) and, for a plan with a decision section, one question `PC-<plan>` "Met, partly, not met?" that holds no task ([follow-up](plan-register.md#follow-up-after-building)). Friction: one click per decided plan. It stops nothing | Advanced |
| `plans.devilsAdvocate` | `false` | On: `/plans` offers a challenger run for an XL or zone plan; it sees only the decision section and the code and adds three objections and the cheapest test under the section (`ravenseat plan challenge`). Friction: one agent run per use (tokens), so it is off | Advanced |
| `add.largeBatchWarn` | `5` | `ravenseat add` with at least this many tasks without a plan entry (or fewer, whose estimate is over a week at the measured pace) prints one WARNING to consider `/plans` first; tasks with `shaped` set do not count. Friction: one line. It stops nothing; `0` is off | Advanced |
| `focus.continueWhenEmpty` | `false` | Off: the queue pauses and asks you when a focus has ended. On: it continues with the regular queue | Advanced, Full mode only |
| `focus.restDefault` | `fill` | Outside focus: what happens to tasks outside a new focus. `fill`: they start when the focus leaves a slot free. `wait`: they do not start until the focus changes, so slots can stay empty. Only a new focus reads it (`focus set` without `--rest`, a new focus on the Focus tab); an existing focus keeps its value. `fill` is the default because `wait` can stop work without anything saying so; with `wait`, "What happens now" always says how many tasks outside the focus wait | Advanced, Full mode only |
| `modules`, `projectModuleSuggestion`, `priorityRules`, `documentFolders`, `indexFile`, `planBackup` | see `queue.config.example.json` | Plan register structure: areas, the module link suggestion, the priority rules, document folders, the index file and the backup script (see `plan-register.md`) | Advanced, Full mode only |
| `documents.vendors`, `documents.secretsManifest`, `documents.vendorSwitches` | `[]`, `null`, `[]` | Vendors checked against documents, the file listing the vendors in use, and planned vendor switches | Advanced, Full mode only |
| `links.addWarn` | `true` | `add` and `edit` print one `WARNING: task links` line when a task link (plan sources, `sources`, a path in `source`) is dead, its anchor finds no heading, or the file is gitignored. The task is added anyway; see [Task links](#task-links). It stops nothing, so `false` weakens no guard | Advanced |
| `links.doctor` | `true` | `ravenseat doctor` shows one INFO row `links` with counts for open tasks: dead links, anchors without a heading, gitignored sources, private links and tasks that link to a plan or sources but have nothing to read. Only when there is a finding; counts only, never content. It stops nothing, so `false` weakens no guard | Advanced |

### History and storage

| Key | Default | Used for | Marks |
|---|---|---|---|
| `stateSnapshots.enabled`, `stateSnapshots.tiers` | `true`, `["1h","5h","1d","2d","7d"]` | Rolling copies of queue.json at a few ages, kept in the data folder | Advanced |
| `metrics.idleGapMin` | `5` | A gap longer than this between two transcript entries is idle and not counted as active time | Advanced |
| `metrics.machineSampleMin` | `0` | While the board runs, a `load` row with command `sample` (free memory, CPU, running tracks) every this many minutes, for the Machine section of Statistics. `0` = off: the load rows at fill and start already answer how many tracks fit, and a sample only while the board runs has gaps. A measurement only, it never limits or stops work | Advanced |
| `history.rotateTimeLog` | `"monthly"` | `monthly` moves the time log to one archive per UTC month next to it on the first write of a new month; `off` keeps one file | Advanced |
| `history.archiveDoneAfterDays` | `30` | Done and cancelled tasks untouched for this many days move from queue.json to `queue-archive.json` in the data folder; `null` keeps them all in queue.json | Advanced |
| `queue.missionInlineMax` | `16000` | `add` and `edit` move an inline mission longer than this many characters to `mission/<id>.md` in the data folder and store the path (see the `mission` field), so queue.json stays small; the agent reads the file as before. It stops nothing, so `0` (every mission stays inline) weakens no guard | Advanced |

**Where the history lives.** These settings are about speed, not safety: every command parses queue.json, and the budget
guard, start, fill and the board read the time log, so both used to grow without end. Turning either `history` setting
off is an INFO line in `ravenseat doctor` (with the size once it is large), never a weakened guard. `queue.missionInlineMax`
keeps long mission texts out of queue.json in the same spirit.

- The time log (`timeLog`, default `scripts/.queue/times.jsonl`) is the current month. On the first write of a new UTC
  month the old file is renamed to `times-YYYY-MM.jsonl` (the month of its last write) in the same folder; a second
  archive for the same month gets `.2`, and nothing is ever written over. A lock folder next to the log
  (`times.jsonl.rotate-lock`) lets only one process rename; writers keep appending, so no row is lost or doubled, and a
  crash leaves every row readable. A reader that needs a window (today's budget, a running agent) reads only the files
  that reach it; `ravenseat cost`, the board's statistics, the gate attempt count and the takeover read every archive, so
  no number changes when the log rotates.
- Done and cancelled tasks move to `<dataFolder>/queue-archive.json` once they have been finished for N days (counted
  from when the queue first saw them finished, so nothing moves in the first N days after an upgrade), nothing
  changed them in that time, no open task depends on them, fixes them or is their QA fix, their QA is settled, and they
  are not gate or kickstart tasks. queue.json keeps `archived: { <id>: <status> }`, so an id is never given out again.
  `ravenseat info` and `explain` show an archived task read-only with an ARCHIVED line, `undo` says a change to one
  cannot be undone, plans, the findings, `ravenseat cost` and the board's statistics count them, and the board's
  `/api/task` and `/api/archive?q=` find them. A new task (or an edit) that depends on, fixes or is the QA fix of an
  archived task brings it back into queue.json first. The archive is written before queue.json lets go of a task, so a
  crash between the two leaves it in both, and the next write settles it.
