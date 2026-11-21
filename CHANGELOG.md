# Changelog

All notable changes to Ravenseat (called `cq` up to 0.8.23, and claude-code-queue before that). The version is in
`plugin/.claude-plugin/plugin.json` and `package.json`.

## Unreleased

### Added
- **Catalog entries can reach tasks by class, domain, project, feature or label, not only by files.** `applies` on the
  entry, `catalog propose --applies class:D,label:visual`; no new setting.
- **The catalog excerpt names the installed version of each library a task imports, from the lockfile, with its local
  types and docs.** `catalog.depsExcerpt`, on.
- **The full gate before merge can run in a clean copy of the exact commit.** `gates.runner` (default `worktree`); try
  it once with `ravenseat gates --full --clean`.
- **`ravenseat issues list` and `issues import` propose GitHub issues as plans or tasks, and a linked task shows
  "Issue #12" and gets `Refs: #12` at merge.** Read only, on command only, `--with-body` keeps the body as framed data;
  `issues.refsTrailer` on, `issues.labelMap` off.
- **`ravenseat issues report` and `ravenseat pr` comment on or close linked issues and open one draft PR per batch
  after a push, each a preview first and your yes.** A secret blocks the post; `issues.onPush` off, `push.pr` off.
- **`ravenseat release-notes` drafts notes since a tag, grouped Added, Changed, Fixed and Hardened.** Local by default;
  `--github --post` creates a draft release after your yes and never publishes it.
- **`ravenseat tidy` lists merged worktrees and branches left behind anywhere on disk and removes them on request.**
  Doctor shows the count (`tidy.doctor`, on); removing after a merge is off (`tidy.afterMerge`, off).
- **Statistics measures the cost of each cache expiry, keeps a quota history and can sample the machine while the board
  runs.** The machine sample is off by default (`metrics.machineSampleMin`, `0`).
- **A gate that cannot run, SPINNING tracks and an owner mark on missions.** `receive` asks instead of a fix round,
  stored track text is redacted or withheld, and `SPINNING` and `SUSPICIOUS CONTENT` lines only warn.
- **Plans: "+ New plan" (key `n`) and `ravenseat plan capture` put an idea in the Inbox with only a title.** On by
  default (`features.plans.inbox`, on).
- **Plans: a plan page offers Turn into tasks or See tasks, and the Queue search takes `plan:<id>`.**
- **Plans: the search also finds plans by the words in their plan document and shows the matching sentence.** On by
  default (`plans.searchDocuments`, on).
- **Plans: `/plans inbox` has Claude propose how to sort each Inbox item, and you Accept, Edit, Decline or Merge it
  (keys 1 to 4).** Nothing applies by itself (`plans.inboxTriage`, `on-request`; `plans.inboxAutoApply`, off).
- **`ravenseat cost` shows each cost measure's expected effect beside the measured one.** With too few runs it says
  `not enough runs yet`.
- **A SILENT track gets a local evidence snapshot, redacted before writing, and the SILENT line says where.** On by
  default (`silentSnapshot.enabled`, on).
- **`ravenseat catalog propose` writes the next free design choice as proposed, accepting one that supersedes another
  marks the old one superseded, and an owner answer can become a proposed choice.** Through `resolve --keep` or the
  board's **Keep as design choice** (`catalog.captureAnswers`, `explicit`).
- **"Not building": a declined proposal or a set-aside Checks card can be kept in the catalog, and new proposals that
  match one get an INFO line.** Advice only (`notBuilding.match`, on).
- **Catalog entries have a `kind` (decision, design, stack, dependency, not-building) and `except` paths, and
  Decisions lists them by kind as Project catalog.** Design entries reach missions and reviewer-design, and accepted
  stack entries reach the Checks tab and the dependency notes (`catalog.stackFacts`, on).
- **A green gate where no tests ran ("No test files found", "0 passing", "collected 0 items") gets a NOTE at receive, a line in the review package and a "no tests ran" badge on the card; never a stop.**
### Changed
- **Faster commands on Windows: one `ravenseat merge` starts about a quarter fewer git processes (66 to 48).**
- **The board's top is lower: a small logo as tall as the first row, and speech bubbles only with the mascot.**
  With the mascot on, `board.mascot` (`chatty`) still sets how much it talks.
- **CI runs the Windows suite in 3 shards with a check that every test file ran, and Windows node 20 weekly.** The
  quick gate can run only the changed tests (`node scripts/test-changed.mjs --gate`, with `QUEUE_GATE_BASE`).
- **New screenshots of every board screen in the docs; a board picture and a pain-points table open the README.**
- **Statistics: five numbers on top, then Cost and tokens, Flow, Quality and Machine as folds, each chart asking one
  question with a "Does this look bad?" line to its setting.** Token mix, cache expiry, gate health, gate wait and the
  findings now show, and the context cap follows `autoCompactWindow`.
- **Plans: the room opens on a Roadmap, and a plan opens as a page with its document first.** Horizons (Inbox, Waiting
  on you, Now, Next, Later, Done) as columns on a wide screen and a list on a phone; the old views are under More views.
  Settings `plans.startView` (default `roadmap`), `plans.roadmapLayout` (`auto`), `plans.roadmapFoldAfter` (8) and
  `plans.leadFromDocument` (on).
- **Plans: Filter and Sort menus like the Tasks room replace the left column; plans show their progress in words.**
- **Plans: polish: clearer empty states, sticky Roadmap column headers, start lines in one Copy menu, and the deadline
  band only when there is a deadline.** On a phone the room tabs stay on one line.
### Fixed
- The red team result no longer shows one unexplained skip: the report runs its own self-check right after writing the page.
- **Missions: a section pointer on a Windows short path (`RUNNER~1`) keeps its line range.**
- **Silent snapshot: a process that names the worktree by its Windows short path is found too, also when the path mixes short and long folder names.**
- **Queue columns fit from 1200 to 1440 px without sideways scroll, also with five columns or the panel beside the board.**
- **On a phone the mascot bubble takes its own row under the top instead of lying over a button at the bottom.**
- **A fresh `catalog init` gives 0 warnings in `catalog check`: the Prefer intro sentence is no longer read as a prefer line.**
- **Statistics: the token mix prices 1-hour cache writes at the 1-hour price and each model at its own, so it adds up to the measured cost.**
- **Statistics: the cache expiry cost is the extra cost (the write minus the read it replaced), not the whole rewrite.**
- **`doctor` gives a WARN with the fix for an `issues.labelMap` of the wrong shape instead of a FAIL.**
- **Statistics: the three y-axis ticks are always distinct, so a small range no longer reads "1 s, 1 s, 0 s".**
- **Plans tree map: the built fill's line no longer runs through a label such as "43 % built", in light and dark.**
- **Checks: suggestion groups with one card sit side by side and use the width instead of one narrow column.**
### Hardened
- **The shell reader treats a backslash-escaped space as part of the word, so `C:/Program\ Files/GitHub\ CLI/gh.exe` is checked as `gh`.**
- **Queue agents may only read with the GitHub CLI: `gh api`, `gh auth`, `gh gist` and every write are denied (rule `gh-cli`).**
- **Secrets in transcripts: the key scan reads every worktree git lists and passwords of any length, an agent printing a
  .env file or the environment is logged on the Checks tab, the project's .env values are redacted in stored text, and
  doctor warns about a .dockerignore that lets .claude/ into an image.** `guards.secretReads` (`log`), `redact.envValues` (on).

## 0.20.0 (2026-11-19)

**The board holds up with large queues and keeps its layout still, test runs pick only what a change touches, tracks read less of large files, and Windows opens no console window per git call.**

### Added
- **Focus: one task can be a step** (`task:<id>`), and `ravenseat focus add <step|id> [--at <n>]` and `focus remove`
  change the list in place. On the board: Add to focus and Remove from focus on cards, and an **Add to focus …** picker.
- **Board: the Focus tab is one ordered list** with each step's tasks in a fold, a "What happens now" line with buttons
  instead of CLI advice, and a "How focus works" box.
- **Board: Settings in six tabs and a help with contents**, each setting in one place and a "?" in every room.
- **Board: Checks groups its suggestions by category**, explains its buttons, and shows a tally per level.
- **Tasks: a `description` field for people**, shown in the board panel and `ravenseat info` (`--description`; a soft
  limit of 320 characters). The agent's mission is unchanged.
- **Read guard: a refused whole-file Read lists the file's outline** (`readGuard.outline`, on), and
  `ravenseat cost --reads` lists the files tracks most often read whole.
- **Updates: the new-version notice reaches the CLI** in `ravenseat show` and `doctor`; `ravenseat update dismiss` hides
  a version. Setting `updates.check` (on; the old `board.updateCheck` still works).
- **`ravenseat controls dismiss`** stops the push question about missing checks for this project; `restore` undoes it.
- **Owner questions: an optional background** with `ravenseat question <id> --context "..."`.
- **test:changed (working on Ravenseat itself): every run is logged** (`testRuns.log`, on;
  `node scripts/test-changed.mjs --stats`).
### Changed
- **Focus: a new focus fills free slots by default** (`focus.restDefault`, `fill` or `wait`, default `fill`).
- **Merge: a PARTIAL delivery merged with `--allow-partial` stays in review**, not done; next is
  `ravenseat resume <id> --reason context`.
- **Board: one place per job.** The side panel floats over the board (`board.panelMode`, default `float`; `beside`
  docks it), Waiting on you opens Decisions, and quick filters and saved presets moved from Selection into Filter.
- **Board: a calmer look and plainer words.** AA contrast in light and dark, underlined tabs, quieter cards, owner
  questions with the recommendation in its own block, the task summary first, and verbs with counts on buttons.
- **Docs: the README explains what Ravenseat does**, checked against the code. Re-ran and corrected some test numbers
  and stats.
### Fixed
- **Windows: no console window per git call under a detached run** (`windows.hideConsoles`, on).
- **Board: layout fixes.** The top bar, the focus line and the tabs keep a fixed size, menus stay inside the window,
  legends stay in their card, the gear closes Settings on a second click, and cards keep their project name.
- **Missions and test:changed:** the task's documents come first with paths that work from the worktree, and a changed
  doc picks only the tests that read it. A flaky board test is fixed.
### Hardened
- **Board: stale data no longer looks live.** A banner says when the board lost contact with its server or why the
  data is old, and Changes are paused until updates come back.
- **Board: Focus holds up at 50+ steps** (compact rows, Move to top or bottom, a drop bar), with one limit of 500 steps.
- **Tasks: a long inline mission moves to `mission/<id>.md`** (`queue.missionInlineMax`, 16000, `0` off), and task
  links that lead nowhere are named at add, edit, doctor and plan check (`links.addWarn`, `links.doctor`, on).
### After you update
- On Windows, detached runs start everything below them hidden (`windows.hideConsoles`, on). `false`, or
  `RAVENSEAT_HIDE_WINDOWS=off` for one shell, shows them again.
- In this repo, `npm run test:changed` and `npm test` each log one row (`testRuns.log`, on).
- A long inline mission moves to a mission file at add and edit.
- No setting changes its value on update, and no guard is turned off.

## 0.19.0 (2026-11-18)

**Settings and checks are easier to read and quieter, the board key stays out of Claude's view, the review gate shows before merge, and overrides and owner-mode pushes ask in the permission dialog. No protective default is weakened.**

### Added
- **`ravenseat settings <key>`** shows one setting in full; rows say what they protect against and what they need
  (`[needs <key>]`, `[no effect now: <key> is off]`).
- **Board: reviews k/n on a Review card**, and every merge override is counted.
- **Checks: Add to gates.quick** for an unused gate guard (`ravenseat checks quick-add <G-n>`), and **Build as gate**
  for a class that keeps coming back (`ravenseat checks build-gate <class>@<area>`), with recipes for your stack.
- **Guards: `ravenseat guards add --class <class> --area <path>`.**
- **Checks: recipe damping** (`learning.recipeDamping`, on; `ravenseat checks recipe <id> show|damp|auto`) and database
  probe recipes (`learning.dbProbes`, off), which check the host first and roll back.
- **Format canary:** doctor and a card say when Claude Code writes an unknown transcript form (`client.canary`, on).
### Changed
- **`ravenseat board` opens the board in your browser** and prints the link without its key (`board.hideKey`, on).
- **Settings in sixteen groups** with plainer titles, and `learning.idleGuardInfo` is folded into
  `learning.idleGuardDays` (7, `0` off).
- **Lite: `wiring.stop`, `scopeNotes.drift` and `features.focus` are off by default** (still on in full).
- **Quieter checks:** general ideas fold under More ideas, receive notes are one line per kind
  (`receive <id> --all` for all), off checks speak only on an important gap, and the banner counts only guards.
### Fixed
- **Gates: a gate whose merge dies no longer runs on for ever.**
- **Cost: a usage limit in the newer API error form counts as a rate limit**, and the estimates for Fable 5.2, Mythos 5.2
  and Sonnet 5.5 are corrected (they came out too high).
### Hardened
- **Permissions: the main session's overrides and an owner-mode push ask in the permission dialog** (`approvals.ask`,
  `push.ownerAsk`, on); with no one to see a dialog the answer is deny.
- **Control files: a queue agent cannot write the main tree's control files**, shell forms included, and the guards
  log what they decide (`controlFiles.guard`, `controlFiles.fingerprint`, `guardLog.enabled`, on).
- **doctor names an important gap even when its card is set aside**; Claude Code formats are locked by fixtures.
### After you update
- `ravenseat board` opens the board itself and prints the link without its key. `ravenseat board open` (or `--follow`)
  opens it again; a script that wrote to the board needs `--key-file`. `board.hideKey` off gives the old start line.
- `learning.idleGuardInfo` is now part of `learning.idleGuardDays` (0 = off, default 7); an old
  `"idleGuardInfo": false` still turns the line off.
- In lite, `wiring.stop`, `scopeNotes.drift` and the Focus tab are off unless queue.config.json sets them.
- No key is renamed apart from the folded idle guard row. `receive <id> --all` prints every scope and catalog note.
- No setting changes its value on update, and no guard is turned off.

## 0.18.0 (2026-11-17)

**A project catalog of helpers and design choices reaches the track and the reviewer, Claude Code formats are read in one place, the Checks tab gets its own page, and a check over its time budget leaves no processes behind. The new stops are off until you turn them on.**

### Added
- **Catalog in `docs/queue/catalog/`:** stack, reusable building blocks and design choices
  (`ravenseat catalog init|show|check|find`). The mission and review package get the part that meets the task's files.
- **Catalog: a design choice can carry a `check` rule** run at receive (`catalog.checks`, on); it stops the merge only
  with `catalog.checkStop` (off), and `merge --allow-catalog` is the logged override.
- **Receive: NOTE lines for a helper written again, new folders, duplicate packages and drift** (`scopeNotes`, on), plus
  two opt-in drift guards, `scopeNotes.driftGap` and `scopeNotes.driftWarn`.
- **Checks: a copy detector in CI**, and the tab's own page `plugin/docs/checks.md`.
### Fixed
- **A check over its time budget ends with its whole process tree.**
- **Checks: a set-aside card that no longer applies can still be brought back**, and the database rules card hides
  when probes exist.
- **API errors in the newer transcript form are counted.**
### Hardened
- **Claude Code formats are read in one place** behind a client adapter; the push guard still denies a forced push if
  it breaks.
### After you update
- Catalog `check:` rules run at receive and warn (`catalog.checks`, on). Turn on `catalog.checkStop` to stop the merge;
  `--allow-catalog` is the logged way past. `catalog.index`, `scopeNotes.driftGap` and `scopeNotes.driftWarn` are off.
- API errors in the newer transcript form are counted, so rate limit and overload figures can go up from 0.
- A card you set aside stays under Set aside even when it no longer applies, so you can bring it back.
- No setting changes its value on update.

## 0.17.0 (2026-11-16)

**Review findings are tracked to a close, every caught failure lands in one local finding log classed by a rule, a fix needs a red test first, and a class that comes back past its guard lights the red dot. New stops are off until you turn them on, except the merge wait for reviewers' findings.**

### Added
- **Reviews: findings are tracked to a close.** Merge waits for each chosen reviewer and stops on a HIGH
  (`--allow-unreviewed`, logged); each finding is a review item to close before done.
- **Finding log:** every check that catches a failure adds one local row, classed by a rule register
  (`docs/queue/failure-rules.json`), with the new classes `duplication` and `scope-drift`.
- **Checks: "A guard did not hold"** lights the red dot when a class comes back where a guard was.
### Changed
- **A fix needs a red test first:** a warning at receive, and a merge stop with `gates.redOnBaseStrict` (off).
- **Proposals share one cap of three** across inspection, GATE lines and the finding log (`learning.proposals`, off).
- **Docs: tidied up the FAQ.**
### After you update
- A merge waits for a FINDINGS report from each chosen reviewer and stops on a HIGH. `--allow-unreviewed` is the owner's
  logged way past. Close each finding with `ravenseat review-item`; lite keeps that done stop off.
- A fix task without a proven red test gets a warning; turn on `gates.redOnBaseStrict` to make merge stop.
- Guard proposals are off until `learning.proposals`; the shared cap of three may show fewer waiting proposals.
- The finding log stays in the data folder. Without `docs/queue/failure-rules.json` the core rules apply.

## 0.16.0 (2026-11-16)

**Review findings get one line form, new opt-in guards find keys in .mcp.json, broad shared permissions and probes aimed at a shared database, the queue files can be shared in git on your word, and `npm run test:changed` runs only the tests a change reaches.**

### Added
- **Reviews: every finding is one FINDING line**, LOW included.
- **Opt-in guards:** keys in `.mcp.json` and approved commands (`secretScan.allowlist`), broad shared permissions
  (`permissionsCheck.enabled`), probes against a shared database (`dbGuard.localOnly`), the project's `.gitignore`
  (`gitignoreCheck.enabled`) and a key a track commits (`secretScan.atReceive`). `ravenseat secrets clean` helps.
- **Sharing: `ravenseat share on --yes`** puts the queue files in git; `privatePaths` keeps folders out of git and reads.
- **Checks: more cards**, among them a Database group, SHA-pinned Actions and flaky tests.
- **Setup asks about parallel tracks and a daily budget**, and `ravenseat limit noAgentMin <n>` (15) is new.
- **`npm run test:changed`** (working on Ravenseat itself) runs only the tests a change can reach.
### Changed
- **`ravenseat machine` counts the checks, not the agents**, and a merge that started tracks ends with START NOW.
### Hardened
- **Red team: three more rows are challenged**, with a new test for a cut-off queue.json write.
### After you update
- Reviewers report with FINDING lines (`FINDING <code> <H|M|L> <mark> <class> @ <place> | <sentence>`). Your own
  reviewer prompts should use the same form; an unreadable line counts as class `other`.
- With sharing off, the push guard and `merge` deny a commit that tracks a data folder file. `ravenseat doctor --fix`
  writes the `.gitignore`, and `ravenseat share on` shares on purpose.
- The new guards are off until you turn them on; the Checks tab has a card for each.

## 0.15.0 (2026-11-14)

**What a diff adds can bring in the security reviewer, stack packs add your stack's risky calls after your yes, and the cost numbers lead with the last measured week.**

### Added
- **Review signals:** sign-in, secrets, URLs from data and raw HTML bring in `reviewer-security` (`review.signals`).
- **Stack packs:** about 30, written to `review.packs` only after `ravenseat checks packs --apply`.
- **Checks: skipped important suggestions come back in one click**, with a red dot (`checksPanel.marker`, on).
### Changed
- **Docs: the cost numbers lead with the last measured week.** Re-ran and corrected some numbers.
### After you update
- A diff with sign-in or session changes, a secret, a request URL built from data or raw HTML gets `reviewer-security`
  on top of its class. `review.signals` narrows or switches a signal off (a weakening that doctor names).
- Stack packs change nothing until `ravenseat checks packs --apply`. `ravenseat checks marker off` hides the red dot.

## 0.14.0 (2026-11-13)

**Fewer turns per round and nothing left unwired: one-call pulse ticks, wiring items that stop done, read-first missions, a narrow researcher agent, and order in the gate queue.**

### Added
- **`ravenseat pulse-check`:** the pulse in one read-only call, `SILENT` (exit 0) or `ACTION: <n>` (exit 13).
- **Wiring items stop done:** a track writes `WIRE` lines, closed with `ravenseat wiring <id> <item> --commit <sha>` or
  `--reject "<reason>"` (`wiring.stop`, on).
- **Missions open with a read-first list**, and a narrow **`researcher`** agent takes the orchestrator's own analysis.
- **Gate queue order** (base, receive, track; `gateQueue.agingMin` 10) and a load factor in `ravenseat gates --health`.
### Changed
- **`reviewer-security` has five web security checkpoints**, and the orchestrator stays quiet between tool calls.
### Fixed
- **Small fixes:** hooks clean their temp state, a track's own gate run says it is not evidence, `add` names an unknown
  field, and triage reads `owner_db`.
### After you update
- A vendored install runs `node scripts/install.mjs <project>` once more to get `.claude/agents/researcher.md`.
- `done` can refuse while `WIRE` items are open. If `ravenseat merge` stops there, apply and close the items, then run
  `ravenseat merge <id> --resume`. `wiring.stop false` turns the stop off.

## 0.13.0 (2026-11-13)

**Long calls no longer stall a session, and `ravenseat cost` shows where the turns go. The README opens with a short explanation GIF.**

### Added
- **Wait mode:** `gates`, `receive` and `merge` block at most `wait.blockSec` (280 s), then print a `RUNNING` line.
- **`ravenseat cost`: Turns and tools** per agent type (`cost.contextThresholdK`, 200).
### Changed
- **README: a 40 second explanation GIF**, and long calls run in the foreground.
### After you update
- A `gates`, `receive` or `merge` call over 280 s returns with a RUNNING line (exit 75); run the `Next:` command it
  prints. `ravenseat settings set wait.blockSec 0` gives the old behaviour.

## 0.12.0 (2026-11-13)

**Failures that keep coming back become guards, fix rounds get cheaper, and the README shows the cost against doing the work yourself in one chat.**

### Added
- **Inspection queue and guard registry:** a failure seen in two tasks becomes one guard proposal `INSP-<n>`
  (`ravenseat inspection`), and built guards are listed in `ravenseat guards`.
- **Fix rounds continue the agent that delivered** while it is warm (`fixRound.continueWithinMin` 60), and the review
  after one reads only the new commits.
### Changed
- **A new fix agent gets a short mission**, and the README compares cost with one chat.
### Fixed
- **CI failures across matrix jobs count once**, and the fix brief no longer lists the package's own `mission.md`.
### After you update
- The inspection queue is on: nothing runs until you approve a proposal. `ravenseat cancel <id>` rejects one,
  `ravenseat inspection snooze <id>` holds one, and `ravenseat settings set inspection.mode off` turns it off.
- A fix round can print `CONTINUE <id> (fix round N)`: send its SendMessage line to the agent that delivered.
  `--new-agent` gives the old behaviour; `fixRound.continueWithinMin 0` turns it off.
- The review after a fix round gets only the new commits; `ravenseat receive <id> --full-review` gives the whole package.

## 0.11.0 (2026-11-12)

**Know where the cost goes and keep Claude's instructions small; the push guard denies destructive pushes even on an internal error, and the `ask` helper starts without your CLAUDE.md.**

### Added
- **Instruction size:** doctor rows and `ravenseat instructions [--plan]`, which proposes a split and never writes
  (`instructionSize.mode`, `warn`).
- **Cost:** per-turn measurements, Where the cost went, week over week, and `ravenseat gates --health`.
### Changed
- **The `ask` helper starts without your CLAUDE.md**, and per-class cost counts tasks by start date.
### Fixed
- **Fix rounds are counted apart from build**, and the push guard denies a forced push, a branch delete and `--mirror`
  even on an internal error.
### After you update
- `ravenseat doctor` has an `instructions` row. If it warns, `ravenseat instructions --plan` proposes a split; nothing
  changes until you make it. `ravenseat settings set instructionSize.mode off` turns the advice off.

## 0.10.0 (2026-11-12)

**History moves out of the hot files and every command starts faster; `next` and `show` on a large history went from about 20 s to 2-3 s.**

### Added
- **History:** the time log rotates per month (`history.rotateTimeLog`), and done tasks move to `queue-archive.json`
  after `history.archiveDoneAfterDays` (30); every reader still finds them.
### Changed
- **Every `ravenseat` command runs in one process** and loads only what it needs; `cost` is much faster.
### Fixed
- **`ravenseat helpers scan` and `add` read frontmatter keys as YAML does.** An approved helper may now scan red.
### After you update
- Nothing moves at once: the first done tasks move to `queue-archive.json` about 30 days after the update, and the time
  log rotates on its first write in December.
- A script of your own that reads `times.jsonl` or `queue.json` directly sees only the current month and the tasks not
  archived; older rows are in `times-YYYY-MM.jsonl` and `queue-archive.json`.

## 0.9.0 (2026-11-12)

**Every setting in one place and no guard weakened by accident; merge rests on ravenseat's own evidence, the guards cover every subagent, and an outside review's merge gaps are closed.**

### Added
- **`ravenseat settings` and the board's gear list every setting**; weakening a guard needs
  `--i-understand --by owner` (or a slide on the board) and is logged.
- **Guards:** a `pre-push` hook in track worktrees (`agentPushBlock.enabled`), `gates.timeoutSec`, the owner log,
  `ownership.sharedPatchCollides`, and `protectedPaths` as `{ "add", "remove" }`.
- **`gateEvidence.mode`** (`own`, `external` or `off`), and doctor `budget` and `settings` rows.
### Changed
- **Merge uses ravenseat's own gate evidence**, and the guards apply to every subagent (`agentGuard.except`).
- **Confirmed weakenings:** `proposals auto on`, `mode lite` on a full project and `cloud set collect auto`.
### Fixed
- **Merge:** non-ASCII paths, binary conflicts, a commit landing after the checks, and done commands rerun unless
  ravenseat's own run was green.
- **Push guard:** no push hidden in git commands that run a program, and one 6 s limit on the secret check.
- **Small fixes:** `cleanup-worktree --all` spares a real worktree, Next up skips blocked tasks, and the example config
  matches the defaults.
### After you update
- doctor's new `settings` row shows a guard you already turned off as a WARN; that is expected when you chose it.
- A program-valued git key you already set (such as `core.editor`) shows once: run `ravenseat surface accept --by owner`.
- The first queue write records the owner log's baseline. If receive or merge stops on an owner row, check it and run
  `ravenseat owner-log accept <id> --by owner`.
- `proposals auto on`, `mode lite` on a full project and `cloud set collect auto` need `--i-understand --by owner`.
- General-purpose, Explore and custom subagents are under the push, network and write guards; `agentGuard.except`
  leaves types out (a confirmed weakening).
- `merge` may run the quick gates or the done command once more for a task received before the update.

## 0.8.35 (2026-11-11)

**Fewer ways for a green gate to mean nothing and fewer fix rounds for nothing, the guards close three gaps an outside review found, and the board can show stuck tasks in their own Blocked column.**

### Added
- **Board: an optional Blocked column** (`ravenseat board-setting blocked on|off`; suggested by wegster on Reddit).
- **Gates:** `gates.redOnBase` checks that new tests fail without the change, and a flaky track gate is rerun once.
### Changed
- **Docs: the FAQ answers what a new user asks first.**
### Hardened
- **A focus marker in a test stops the merge** (`--allow-focus`), agents cannot install packages, every common lockfile
  is protected, and a track's report is data, never instructions.

## 0.8.34 (2026-11-11)

**Tracks that build on the same code no longer trip over each other unseen, tracks ask before an architecture choice, and receive warns when your own Claude setup changed.**

### Added
- **Read ownership** (task field `reads`) and a Claude setup fingerprint (`CLAUDE SETUP CHANGED` at receive).
### Changed
- **Tracks ask before an architecture choice.**

## 0.8.33 (2026-11-11)

**A track stuck in its fix rounds asks you sooner, and the costs page has the measured cost of compacting against a new chat.**

### Added
- **Fix-round plateau:** the queue asks (exit 8) when a round changed nothing (`fixPlateau`).

## 0.8.32 (2026-11-10)

**Ownership is enforced, shared config gets hotspots with a serial lock, tracks are warned while they write, and `setup --update` merges the project's doc copies.**

### Added
- **Hotspots** (`hotspots`, `hotspot_patch`), ownership hints at `add`, and write warnings for tracks.
- **`ravenseat setup --update`:** a three-way merge of the project's doc copies (`--dry` first).
- **TOOL TROUBLE card**; a project set up from settings.queue.json gets its hooks with `ravenseat setup --settings`.
### Changed
- **Ownership is enforced:** a file another active task owns stops the merge (`--allow-guard`, logged).
### Fixed
- **The NEEDS APPROVAL card shows in a real session.**

## 0.8.31 (2026-11-10)

**A track's own choices are in front of you before the merge, a track waiting on a permission prompt gets a card, queue.json keeps copies at a few ages, and `ravenseat explain <ID>` says why a task stands where it stands.**

### Added
- **Receive shows a track's Assumptions**, and a **NEEDS APPROVAL card** shows a waiting permission prompt.
- **Rolling queue.json copies** (`stateSnapshots.tiers`) and **`ravenseat explain <ID>`**.
### Fixed
- **Small fixes:** gates in an outside linked worktree, `prepare-track --continue`, and `fill --ids A,B`.

## 0.8.30 (2026-11-08)

**Every row on the red team map is now tested, not only named, and four more findings are fixed. A project without git, or without a first commit, gets a clear stop and a card.**

### Added
- **Red team: every row on the map runs as a real flow**, and a first-commit card for a project without git.
- **doctor warns about a gate program not on PATH**, and the cost guard watches a class's first track.
### Fixed
- **`start` and `fill` refuse without a first commit**, doctor names missing git, and `resume` names uncommitted work.
### Known limits
- Unclear requirements are not verified yet, and the PATH check uses doctor's PATH.

## 0.8.29 (2026-11-08)

**A red team suite tests Ravenseat the way a careless user would use it, with a page and a FAQ, and its ten findings are fixed. Cloud tracks work on a normal subscription.**

### Added
- **Red team suite (`npm run redteam`)** with real git, processes and hooks, a red team page and a FAQ.
- **Warnings** for a test left with no assertions, gates that check nothing, and `set <id> done` on unmerged work.
- **Cloud tracks on a normal subscription** (`features.cloud`, `cloud collect`, `cloud-go`), and `ARCHITECTURE.md`.
### Fixed
- **Merge:** its gates always get a time budget, and it stops before `git merge` with uncommitted work in the way.
- **Small fixes:** simultaneous receives, dependency cycles, hand-edited tasks, and tests that read the checkout's queue.
### Known limits
- Removing some assertions while one remains is not named. Green means your checks passed, not that the change is right.

## 0.8.28 (2026-11-07)

**A lock nobody holds no longer stops your commands.**

### Fixed
- **Windows: an empty lock folder nobody holds is taken after 2 seconds.**

## 0.8.27 (2026-11-07)

**Ravenseat now pauses at the subscription's usage limit instead of starting work that cannot finish, and each check cleans up its own temp folder.**

### Added
- **Pause at the usage limit** (`usageLimit.pause`; `ravenseat limit usageLimit clear`), tested on recorded signals.
- **Each gate run gets its own temp folder** (`gateTemp.enabled`), and doctor has a `temp` line.

## 0.8.26 (2026-11-07)

**Heavy checks now take turns across the whole machine, and `ravenseat machine` suggests how many tracks your PC can carry.**

### Added
- **A shared queue for heavy checks** (`QUEUE_GATE_QUEUE=off`), `ravenseat machine [--measure]` and `--version`.
### Changed
- **Track proposals skip the batch queue**, and missions explain new work and PowerShell 5.1.
### Fixed
- **A time budget stops the whole process tree**, and merge warnings reach the owner.
### Known limits
- `ravenseat merge` holds the merge lock while it waits for a slot, and macOS and Linux are untried.
### After you update
- Run `ravenseat setup --overwrite` (it replaces your edits in the copied files; `--dry` lists them first), and commit.

## 0.8.25 (2026-11-06)

**A track can now propose work with only an id, a title and a mission, and the owner sees the proposal in `ravenseat show`.**

### Changed
- **Proposals need only `id`, `title` and `mission`** (database work sets `"class":"D"`), and `show` lists them.
### Fixed
- **Mission texts:** no `edit-many` advice, and `gates.log` is a file.
### After you update
- Run `ravenseat setup --overwrite` (it replaces your edits in the copied files; `--dry` lists them first), and commit.

## 0.8.24 (2026-11-06)

**The plugin and its command are now called `ravenseat`. `cq` is gone, with no alias.**

### Changed
- **Renamed to `ravenseat`:** plugin, CLI, skills and agents. A new CI workflow is `ravenseat-gates.yml`; delete an old
  `cq-gates.yml` if you run `setup --ci` again.
- **Tracks may add proposals** from their own branch, and more manifests count as dependency files.
### Fixed
- **`ravenseat init` on a `master` repo writes the current branch**, and ignores `.claude/worktrees/`.
### After you update
- `claude plugin update cq@ravenseat` fails (ignore the 0.8.23 banner), and once the marketplace updates the `cq` hooks,
  the push guard among them, are off. Swap it in a terminal (add `--scope project` to the first and last line for a
  project install; your queue data stays):
  ```
  claude plugin uninstall cq@ravenseat
  claude plugin marketplace update ravenseat
  claude plugin install ravenseat@ravenseat
  ```
- Then ask Claude Code in the project to run `ravenseat setup --overwrite --settings`, and commit.
- Change scripts of your own that call `cq`. The old `_` lines in `queue.config.json` are harmless.

## 0.8.23 (2026-11-06)

### Added
- **`cq checks` and a Checks tab** with suggestions as cards, plus `dependencyFiles` and `identity.allow`.
### Changed
- **`gitSurface` warns in lite**, a forced push to an allowed branch asks, and doctor and setup are quieter.
### Fixed
- **The push guard reads more forms** (Monitor, quoted letters, brace lists), and `cq finding` and `takeover` handle
  edge cases.

## 0.8.22 (2026-11-05)

### Added
- **`cq wait` checks tracks every 5 minutes**, with `ROUND WITHOUT AGENT` and silent-track cards.
- **`cq guidance quiet`** and **`push.allowBranches`** for pull request flows.
### Changed
- **The merge guard has a floor** `protectedPaths` cannot remove, and `git push --tags` is denied.
### Fixed
- **A board answer wakes `cq wait`**, plus small doctor and push-check fixes.

## 0.8.21 (2026-11-05)

### Changed
- **`cq resume` frees the branch itself** for a clean PARTIAL continuation, with clearer messages.
### Fixed
- **Owner answers stay first in the brief**, and an unstarted base fix task is cancelled when the base goes green.

## 0.8.20 (2026-11-05)

### Added
- **`cq show <id>`.**
### Changed
- **The board's push line matches `cq push-check`**, and quoted heredoc text is not read as commands.
### Fixed
- **An expired orchestrator no longer looks alive**, and the board's counters agree.

## 0.8.19 (2026-11-05)

### Added
- **Answer a track's question** with `cq resume <id> --reason context --answer "<text>"`, and `cq edit --files`.
### Changed
- **`cq merge` stops on a PARTIAL delivery** unless you pass `--allow-partial`.
### Fixed
- **Detached worktrees are found**, `cq fill` says which tasks hold the slots, and texts are clearer.

## 0.8.18 (2026-11-04)

### Added
- **The first push is scanned for secrets**, `cleanup-worktree --abandon`, and a place on `GATE` lines.
### Changed
- **A migration from a task that does not own it stops the merge.**
### Fixed
- **A track's owner question reaches `receive`, `decide` and the board**, and output is no longer cut.

## 0.8.17 (2026-11-04)

### Fixed
- **`cq merge --resume` cleans up when the project path has another spelling** than git prints.

## 0.8.16 (2026-11-04)

### Added
- **`cq add --depends` in lite**, and a warning when a task owns a protected path.
### Fixed
- **`cq setup` reads the branch and the checks from the project**, merge stops reach the owner, a whole merge cleans up,
  and doctor and fill warn about a refused git identity.

## 0.8.15 (2026-11-04)

### Fixed
- **Track reports are written to `track-result.md`**, since subagents may not write `report.md` (still read).
- **`cq merge` refuses while the last receive's quick gates are red** (`--force-red-gate`, logged).

## 0.8.14 (2026-11-04)

### Added
- **`cq kickstart`**: one next step for your checks, `kickstart gates --apply` and `kickstart add`.
- **Known bugs can become gate tasks** from a `GATE` line or `cq gate` (`gates.fromKnownBugs`, `propose`).
### Fixed
- **`cq init` and `cq setup` stop outside git** in a plugin install.

## 0.8.13 (2026-11-04)

### Added
- **`NO CHECKS RAN`**, and a verification status per task (verified, audited or unverified).
### Changed
- **A project with no CI or no gates hears about it:** the push guard asks (`push.controlsWarning`), and K tasks get
  `reviewer-light`.

## 0.8.12 (2026-11-04)

### Added
- **`gitSurface`, `cq surface`, `cq unlock` and `cq attempt list|close`.**
### Changed
- **Checks run without tokens and cloud keys**, and git hooks and config are compared against a baseline.
### Fixed
- **Only the orchestrator writes gate evidence**, and a live lock holder is never taken over.
### After you update
- A check that reads a token from the environment fails until it gets the value another way.
- After installing husky or lefthook, or changing a git alias, run `cq surface accept --by owner`.

## 0.8.11 (2026-11-03)

### Fixed
- **`cq init` adds the data folder to `.gitignore`** on a Windows short path or a symlink, and two tests pass on Linux.

## 0.8.10 (2026-11-03)

### Added
- **CI for Ravenseat itself** on Linux and Windows with Node 20 and 22.

## 0.8.9 (2026-11-03)

### Fixed
- **Docs match the code on security.**

## 0.8.8 (2026-11-03)

### Changed
- **README cut to about half**, with new docs pages for what left it.

## 0.8.7 (2026-11-02)

### Changed
- **README: a chat-first Quick start.**

## 0.8.6 (2026-11-02)

### Changed
- **New board screenshots.**

## 0.8.5 (2026-11-02)

### Changed
- **README: four main points.**

## 0.8.4 (2026-11-02)

### Changed
- **`cq init` adds the queue data folder to `.gitignore`.**

## 0.8.3 (2026-11-02)

### Changed
- **README opens with autonomy.**

## 0.8.2 (2026-11-02)

### Changed
- **README: what Ravenseat checks against what needs a boundary outside it.**

## 0.8.1 (2026-11-02)

### Added
- **`cq merge` survives interruptions** (`cq merge <id> --resume`), `queue.json.prev`, and more secret rules.
### Changed
- **Queue agents are locked down**, and `protectedPaths` covers more.
### Fixed
- **A broken `queue.config.json` stops the CLI**, and the secret precheck scans every pushed commit.

## 0.8.0 (2026-11-02)

### Added
- **Measuring:** transcript metrics, event rows, quality figures and `cq cost` views.
- **Safety baseline:** doctor checks, a secret scan before a base push, guard tests and `cq setup --ci`.
- **Gate evidence bound to the sha**, a done lock with `acceptance` criteria, and a write guard hook.
- **Owner flow:** `cq wait`, `/cq:decide` with the Decisions tab, and a focus end that pauses and asks.
- **Reviews:** `/cq:review <area> [<lens>]`, decide or ask, and gates from incidents.
- **Base and CI:** CI watch after a push, a flaky rerun before freezing the base, and `cq conflicts`.
- **`cq ask <id>`** answers a question about an earlier track.
### Fixed
- **Review fixes:** incremental compaction counts, shell-free worktree cleanup and more doctor checks.

## 0.7.0 (2026-11-02)

### Changed
- **New name: Ravenseat**, with the logo on the board; the plugin is still `cq`.
### After you update
- Move an existing install: `/plugin marketplace remove claude-code-queue`, then
  `/plugin marketplace add vegardjorg/ravenseat` and `/plugin install cq@ravenseat`. Your queue data is not touched.

## 0.6.0 (2026-11-02)

### Added
- **Intake triage, a base gate** (`--force-red-base`, logged) **and a push threshold** (`cq push-check`).

## 0.5.0 (2026-11-02)

### Added
- **Owner questions with choices**, a done command (`done_when`) and a fix-round cap (`maxFixRounds`, 3).
- **Lite mode** (`"mode": "lite"`, `cq mode`), `cq doctor`, `cq finding` and a model per agent (`models`).
- **Cost:** cost per task, USD per merged change, calibrated estimates and `cq calibrate`.
- **Load-aware parallelism** (`loadGuard.adaptive`), plus gate and compaction rows and the `fixes` field.
### Changed
- **The code is split into modules**, with no behaviour change, and hooks run in exec form (needs `node` on PATH).
- **The load guard is on by default** (10 % free memory, off on macOS), and the 400k block in other chats is opt-in.
### Fixed
- **The bench load sampler counts processes on Windows.**

## 0.4.1 (2026-10-31)

### Added
- **`cq help` in groups**, `cq forecast`, opt-in auto-accept of proposals, and module switches (`features`).
- **Board: cancel, decline and edit** with Undo, and a first-run card.
### Changed
- **Off by default:** cloud, follow-up entries and the Legal, Launch and Documents surfaces.
- **Silent tracks and blocker reasons** (`limits.silentMin`, `cq block`), and the mascot hides without a password.

## 0.4.0 (2026-10-31)

### Added
- **Helper agents**, including custom ones approved by hash (`cq helpers add`), with measurement per helper.
- **`cq gates --precheck`**, a counter-evidence step in every reviewer, and an update banner on the board.
### Changed
- **The network and read guards cover reviewers and helper agents.**
### After you update
- Update the plugin, run `cq setup --settings` once, and restart the session (or run `/agents`) so the new reviewer
  agents are picked up.

## 0.3.0 (2026-10-30)

**Fixes and features ported back from the queue in the project cq was split out of.**

### Added
- **Status line**, a two-part handover note, and adopting running tracks (`cq resume`).
- **Migration blocks, a load guard, focus clean-up, follow-up entries and QA evidence.**
### Fixed
- **The board builds its lookups once**, so 3,000 tasks draw in about 0.15 s, and two small display fixes.
### Hardened
- **Merge, network and context guards** for tracks, and data, not instructions, in every agent file.
### After you update
- Update the plugin, then run `cq setup --settings` once to get the new hooks and the status line.

## 0.2.1 (2026-10-29)

### Fixed
- **The hook-path regex in `setup.mjs` works**, and every shipped script is syntax-checked in the tests.
