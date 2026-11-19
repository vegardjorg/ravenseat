# Changelog

All notable changes to Ravenseat (called `cq` up to 0.8.23, and claude-code-queue before that). The version is in
`plugin/.claude-plugin/plugin.json` and `package.json`.

## Unreleased

- **Task links: the shape of a task's own `sources` is checked at add and edit (0p2 B4).** Hardening of the field for
  a few edge cases. `sources` (`[{ path, anchor?, role? }]`) now gets the plan register's own source check: `add` and
  `edit` refuse a value that is not a list, an entry that is not an object or has an unknown field, a path that is
  absolute, uses `.` or `..`, a backslash or a line break, an anchor that spans lines, and a role other than `plan`,
  `investigation`, `spec`, `history` and `reference`, with the same `Nothing added:` and `Invalid change:` messages
  as other field shapes. A file that is missing stays a link warning. `edit` replaces the whole list, and `[]` or
  `null` removes it. The plan register's path check also refuses a line break now. `source` is documented as the
  task's origin (free text, read by nobody), and docs/queue.md explains how `plan`, `sources` and `source` relate.

- **Task links: the mission reads the task's documents first, with paths that work from the worktree (0p2 B3).**
  Hardening of the read-first list for three edge cases. A task's plan entry sources (roles `plan`, `investigation`
  and `spec`; a source without a role counts as `plan`) or its own `sources` (which replace the plan's) now come
  first in the mission's "Read these in your first turn" list, an anchor as a line range such as `docs/auth.md:41-80`,
  and the mission's own paths fill what is left under the same cap of 12. A file the agent's worktree will not have,
  because it is gitignored or not committed at the mission's head, is written with its absolute path in the main
  tree, also when the mission text names it; before, its relative path led nowhere from the worktree. A file under
  `privatePaths` with `"read": false` gets a line to ask the orchestrator for an excerpt instead of a path. A task
  without `plan` or `sources` gets the same mission as before, byte for byte, and a path in `source` stays origin
  only. The links are looked up by the orchestrator when it writes the track block (`READ:` and `PRIVATE:` lines
  above the `## TRACK` heading); `make-mission.mjs` reads them from there.

- **Task links: add, edit, doctor and plan check name a link that does not lead anywhere (0p2 B2).** Hardening of the
  task links, for three edge cases that went unnoticed. A task's reading material is its plan entry's sources and its
  own `sources`; a path in `source` is origin. When one of these is missing, its anchor finds no heading, or the file
  is gitignored, `add` and `edit` now print one `WARNING: task links` line naming the task, the link and what is
  wrong. The task is added anyway and the exit code is the same; `edit` checks only when it writes `plan`, `sources`
  or `source`. `add` gets `--answer-json` like `edit`, and both carry the problems there as `linkProblems`.
  `ravenseat doctor` adds one INFO row `links` with counts for open tasks (dead links, anchors without a heading,
  gitignored sources, private links, tasks that link somewhere but have nothing to read), only when there is a
  finding, and never with a path or a title. `ravenseat plan check` now reports a plan source whose anchor finds no
  heading as "Anchors without a heading" (`anchor_misses` in `--json`); before, the miss was a quiet null. Anchors are
  found with the mission's own lookup everywhere, so the three agree. New settings `links.addWarn` and `links.doctor`
  (Plans and focus), both on: they stop nothing.

- **Docs: the README explains what Ravenseat does, checked against the code.** A new section "What Ravenseat does"
  covers how a task flows, the guarantees the code enforces, parallel work, machine load, learning, modes and the known
  limits. It replaces "Is it for you?", "Status" and the guarantee bullets, and shortens two sections that said the same.
- **Updates: the new-version notice also reaches CLI users (0u3).** Edge case closed in the update check. Only the
  board said that a newer ravenseat was out, so a project run from the terminal or by Claude alone never heard of it.
  `ravenseat show` now prints one line, `ravenseat X is out (you have Y): claude plugin update ravenseat@ravenseat,
  then ravenseat setup --settings`, at most once a day per version, and `ravenseat doctor` gives it as an INFO row
  (never WARN or FAIL). `show` only reads the board's cache (`<dataFolder>/update-check.json`) and never waits on the
  network: an old cache starts a background refresh with the board's check and timeout, so the answer is there next
  time; `doctor` checks directly with a 3 second timeout. The line stays out of `--json`, agents (track worktrees and
  the agent role), CI and hooks, and out of every other command. `ravenseat update dismiss` hides a version, and the
  board's X now stores the same field, so a dismissal holds in every browser and in the CLI. The setting is now
  `updates.check` (on by default, never stops any work); the old name `board.updateCheck` still works, and
  `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turn it off as before.
- **Focus: a new focus fills free slots by default, with the setting Outside focus (B22).** Edge case closed in the
  focus default. A focus set without `--rest` used `wait`, so tasks outside it did not start and slots could stay
  empty while nothing on the board said why. The new setting `focus.restDefault` (Settings, Plans and focus, label
  Outside focus; choices `fill` and `wait`, default `fill`) decides what a NEW focus does with the tasks outside its
  steps: `ravenseat focus set` without `--rest`, and a new focus from the Focus tab, which now preselects the setting.
  An explicit `--rest` or the board's choice wins. A focus already set keeps its stored value, nothing is migrated,
  and a board save without a rest keeps the value of the focus it replaces. "How focus works" describes the value a
  new focus would get, and with `wait` the "What happens now" line always says how many tasks outside the focus
  wait, also when none do. Someone who wants a strict focus picks `wait` once.
- **Merge: a PARTIAL delivery merged with `--allow-partial` stays in review.** Edge case closed in the merge flow.
  `ravenseat merge <id> --allow-partial` merged a track that called itself unfinished and then set the task done, so
  the rest of the task had no place in the queue. Now the merge, the migration push, the gates, the base gate and
  fill run as before, but the done step is left out: the task stays in review with a remark that the rest remains,
  `delivered_partial` stays set until a finished delivery is received, and the track branch and worktree are kept.
  Because the task is not done, it frees no dependent task, gets no cost measurement and leaves the focus as it is.
  The merge output says the task stays in review and names the next command, `ravenseat resume <id> --reason
  context`, then `receive` and `merge` again. A second `merge` or `merge --resume` before that says the same and
  changes nothing. No new setting.

- **Board: focus on the cards, and a picker on the Focus tab.** Edge cases closed in the Focus feature. Putting one
  task into the focus or taking it out meant the CLI or dragging on the Focus tab, and a card outside the focus named
  `ravenseat focus` as its way out. A task outside every step now has **Add to focus** in the detail panel, on its card
  right after the reason and, for several cards, in Selection; a task that is its own step has **Remove from focus**.
  A task that a broader step (feature, project or area) holds gets a note naming that step and no button, since it
  cannot leave the focus alone. Each action shows the same preview as Save focus and saves on confirm through
  `POST /api/focus { change }`, which runs the same code as `ravenseat focus add` / `focus remove`, so one `undo` takes
  it back; a preview the queue has moved past is shown again. Several cards go in as one change: `focus add` takes
  several steps (in together at `--at`, a step already there skipped and named), and `focus add` / `focus remove` take
  `--json` and `--expect-changed`. Taking out the only step is refused with a pointer to Clear focus. The Focus tab has
  **Add to focus …** (kind, what, position) that puts the step into the draft. A task step taken out of In focus in the
  draft now stands in Not in focus, so it can be dragged back. No new setting.

- **Focus: one task can be a step, and one step can be added or taken out without writing the list again.** Edge
  cases closed in the Focus feature. A focus step could only be an area, a project or a feature, so putting one
  task first meant moving it into a feature of its own, and adding or dropping one step meant typing the whole list
  again with `focus set`. A step can now be `task:<id>`; it is the most specific kind, so it wins over a feature,
  project or area step that also holds the task. `ravenseat focus add <step|id> [--at <n>]` and
  `ravenseat focus remove <step|id>` change the list in place and keep the rest of the focus as it is; a bare task id
  means `task:<id>`. Adding a step already in the list changes nothing and says so; an unknown task id, an `--at` out
  of range, a step not in the list, no focus set and the last step are refused with a clear message and exit 1, with
  nothing changed. Each change is one changelog entry, so `ravenseat undo` takes it back. A task step whose task is
  done leaves the focus through `focus clean`, as other done steps do. The board accepts task steps when the focus is
  saved, and the Focus tab shows a task step with its id and title, its fold showing that one task. No new setting.

- **Board: the Focus tab is one ordered list, with each step's tasks and the settings in a fold.** Edge cases closed in
  the Focus feature. The steps stood in two columns, Now and Next, whose split changed nothing the queue does, so a
  step could look more or less "in focus" than it was, and a step never showed which tasks it held. The steps now
  stand in one list, In focus, in step order; each row opens with a Tasks button to the step's tasks with a status per
  task (ready, blocked, waits on an answer, QA waiting on you and more), from the same assignment the queue uses, and
  a done step keeps its "done" badge. Not in focus and On pause follow as sections of their own. The name, the rest,
  the end date, dragging along, what happens when the focus is done, Clear focus and Areas moved into Focus settings,
  a fold below the lists that is closed by default; Discard and Save focus stay beside the list. Below 600 px the
  sections stand one under another in reading order. The arrow keys move a lifted step up and down in the list and
  left and right between the sections. The saved `now_count` stays in the data and is sent back unchanged. Nothing new
  stops work, no new setting and no new colors: only the theme's tokens.

- **Board: the Focus tab says how focus works and what happens now, with buttons instead of CLI advice.** Edge
  cases closed in the Focus feature. A focus that stood still on a rest (a done task waiting on your QA, an owner
  question, a proposal, the batch queue) or had ended showed a red band with `ravenseat` commands and no button, and
  the owner question about a finished focus only came at the next fill. The server now builds one plain sentence,
  "What happens now", from the focus status and the step evaluation: which step goes first and what is left, why
  nothing starts, or that the focus is done and the queue is paused. It stands at the top of the Focus tab and, when
  the focus line warns, in the band on the other tabs, with the buttons that settle it: QA, answer or review the card
  in Decisions, pack the batch queue, continue the regular queue, or set a new focus. A copyable command shows only
  where the board has no button. A "How focus works" box at the top of the Focus tab explains the four steps with
  this focus's own values (the rest waits or fills free slots, the queue pauses and asks or goes on); it closes, and
  the choice is remembered in the browser only. `ravenseat qa ok` now cleans the focus in the same write, as receive,
  set and fill do, so the question comes right after the last QA. In Decisions, the answer "Set a new focus" opens the
  Focus tab. Nothing new stops work, no new setting and no new colors: only the theme's tokens.

- **Board: a done focus step says "done", and the Focus tab speaks one language.** Edge cases closed in the Focus
  feature. A step that points to a feature whose tasks are all done, or that only has rests left (QA waiting on you, a
  proposal, the batch queue), showed "does not exist" on the Focus tab, because the plan view listed features from
  pending tasks only. Such a feature now keeps its row and the step carries a neutral "done" badge, with what keeps it
  in the focus in the tooltip; a feature no task has ever had still says "does not exist". The "Set focus" and "Edit
  focus" button in the focus line is hidden on the Focus tab itself, where it only switched to the tab already open.
  The Now column no longer has a fixed blue tone that looked like an active drop zone: it looks like the other columns,
  and the steps in Now in the focus line have the primary edge and bold text instead of a fill. The board, the
  previews, the warnings, the CLI texts and the docs say "step" for a focus step everywhere ("stage" is gone; the data
  field keeps its name). A project step in the focus line is written like the project on a card, by its id with the
  title in the tooltip, and a feature step as "project › feature"; the Focus tab shows the id beside a project's title.
  No new setting and no new colors: only the theme's tokens.

- **Board: the Statistics charts keep their legends inside the card, and a value text gives way to a line.** Edge
  cases closed in the Statistics tab. Two rules written for other views shared a class name with the charts and won by
  coming later in the style sheet: the Dependencies graph's full-height rule stretched each chart over its whole card,
  and the help legend's grid stacked the color samples, so the legends ended 59 to 115 px below the card edge. Those
  rules are now scoped to their own views (the graph surface and the help legend), the chart rules to the chart card,
  and a test fails if a rule for the graph or the help matches inside a chart card again. A legend line sample is now
  drawn like its line in the chart (dashed for the estimate, the quota, the cap and Done; solid for Added). In the
  horizontal charts a value text such as "288k" moves past a cap or estimate line instead of sitting on it, and the
  lines are drawn first so the text is on top. The context chart's axis ends a tenth past the larger of the max and
  the cap, so the cap sits at about 91 % of the width instead of 60 % and the top value never lands on the edge. No new
  setting and no new colors.
- **Board: the dependency graph's ids stay clear of the ring, and priority is not red anywhere in Plans.** Edge cases
  closed in the Dependencies view and the Plans views. An id under a task sat 13 units below the circle without
  counting the ring around it, so at a thick ring (in progress, selected) the text ran into it, and the font grew with
  the zoom to about 18 px and more. The id now hangs below the ring's outer edge with its thickest stroke and a small
  gap, at every circle size, and the font is held between 12 and 14 px on screen at any zoom (the board's text floor
  and one step up); a question's id and its "unlocks N" keep the same distance to the square. Every legend sample now
  has an edge in the color of the ring it explains that holds 3:1 against the surface in light and dark (the owner
  question sample was a pale square with no edge), and the legend text is one step larger. In Plans, the list's
  priority symbols, the priority facet, the tree map, the structure legend and the dependency nodes still drew Now in
  red; they now use the area cards' colors (strong primary for Now, the warn tone for Owner, a muted neutral for
  Later), and a Now field keeps a visible selection outline, focus ring and built fill. Red stays for errors,
  deadlines and legal warnings. Keyboard and screen reader behaviour are unchanged; no new setting and no new colors.
- **Board: the area cards in Plans read at a glance, and priority is no longer red.** Edge cases closed on the Plans
  overview. Each area card repeated a running legend under its bars ("Idea and investigated 0 · Planned and ready
  1 · ..."), so a card was three lines of text, and a maturity segment in the planned color barely showed on the
  bar's track. The bars now have labelled segments: each segment carries its symbol and count as text, grows with its
  count but never gets narrower than its text, has its word in the tooltip and a 1 px edge that holds 3:1 against the
  card in light and dark, and a group at 0 draws no segment. One shared legend above the cards says once what every
  symbol and color means, and the card's accessible name names every group with its count. Priority used the error
  red for Now, while red elsewhere on the board means an error; Now is the strong primary tone, Owner the warn tone
  (waits on you) and Later a muted neutral, and red stays for errors and deadlines. The full breakdown, every group
  with its word and count, also those at 0, sits in a **Details** disclosure under each card: its own tab stop after
  the card button, never inside it, and opening it grows only that card. No new setting and no new colors: only the
  theme's tokens.
- **Board: buttons and hints say what they do, in plain words.** Edge cases closed in the board's wording. The bulk
  dialog's main button said "Do it" whatever the action; it now names the verb and the count of the selection ("Put 3
  tasks on hold", "Move 2 tasks", "Remove the label from 2 tasks") and follows the add or remove choice. A CLI command
  the board cannot run itself no longer stands mid-sentence: it sits last in a small "Claude Code:" chip with a Copy
  button (a new project in the bulk dialog, cancelling a running task in the panel, legal points in Plans), and where
  the board has the switch itself (Settings, the Checks dot, answering in Plans) the text no longer names the CLI. The
  pace in Plans used a decimal comma in English text ("2,3 finished queue tasks per week"); it is "2.3" now. Short
  durations read naturally: "opened today" instead of "open for 0 d", "unlocks 1 task (1 h 30 min)" as in Decisions
  instead of "90 min in queue", and "updated 9 min ago" instead of the full pulse timestamp (still in the tooltip). A
  success toast is now a polite status and only an error is an alert, so "Saved" no longer interrupts a screen reader.
  The keyboard hint in Decisions shows the keys as key caps in a readable size and never names a number key beyond 4,
  the last one that works. No new setting and no new colors: only the theme's tokens.
- **Board: the Checks room explains its buttons, groups its suggestions and holds its place while it reads.**
  Edge cases closed in the Checks room. The suggestions were one long list sorted by priority, so cards about tests,
  CI and security stood mixed; they now come in one group per category with a real heading, in the catalog's order
  (Using what you have, Tests, CI, Code quality, Security, Dependencies, Database, Claude's instructions, Claude Code),
  the most important first inside each group, and a category with no card draws no group. The "More ideas" fold is
  unchanged. A **How it works** box at the top shows in four steps with an icon each what a button really does: the
  click on "Add investigation to queue" puts one investigation (`KS-PLAN-<KEY>`) in the queue and is your yes, the
  agent writes a plan (recommendation, cost, risk and build steps, where "not worth it" is a fine answer) and changes
  no files, you choose which steps become tasks, and the approved ones are built in the queue; one line says that
  "Turn on" and "Use as gates" need no agent. The box is a button with aria-expanded and a region, open until you
  close it, remembered in this browser and still working where storage is blocked; only its own height changes. The
  **Important** box said how many suggestions were open but led nowhere while the cards stood below the fold: each one
  is now a button that scrolls to its card and puts focus on it, also when the category filter hid it, and "Go to
  suggestions" goes to the list. While the first read runs, placeholders in the cards' shape (still for someone who
  asked for less motion) and one status line replace the near empty view that jumped when the cards came. No new
  setting and no new colors: only the theme's tokens.
- **Board: the help starts with the basics and can be reached from every room.** "How to use the board" was 13
  sections of running text in one column that began with Areas, a full-mode idea, had no contents, and could only be
  reached through the gear; once open, the only way out was Close, which dropped you out of Settings. Now a contents
  list at the top links every section and the legend, and a link moves focus to that heading without touching the
  address (where the board's key lives). The sections come in the order a new user needs them: what the board shows,
  Waiting on you and Decisions, and picking and running work first, then the task panel, Focus, Plans, Checks and
  Statistics, with selection, bulk actions, the batch queue, the keyboard and Areas last. What the board shows,
  Picking and running work, Checks and Statistics are new sections written from what the board does; the others keep
  their text, split into shorter paragraphs, and Focus and the Focus tab are one section. Opened from
  Settings, the help has **Back to menu**, which returns to Settings with focus on the button that opened it, also
  while Settings are still loading. Each room has a small "?" in its own header (Decisions, Checks, Statistics, the
  Focus toolbar, the Plans breadcrumb line, and the In queue column header for the queue) named "Help for <room>",
  which opens the help at that room's section; closing puts focus back on the "?", even when the room was redrawn
  meanwhile. It is 24 px drawn with a 36 px hit area (44 px on touch), so the fixed top and the rooms' one-line
  headers keep their height, and it uses only the theme's tokens.
- **Board: Settings in six tabs, each setting in one place.** Settings had grown to one General page of 29 sections
  (about 8 800 px at 1440 x 900, over nine screens of scrolling) next to a Helper agents tab, and a few rows in the
  categories only said "Changed in Guidance" (or Logo and mascot, Columns, Cloud) without a control. Settings now have
  six tabs built on the registry's sixteen categories: Queue and context, Checks, Guards, Agents, Project and Board,
  each between about 1 600 and 1 900 px. Every category sits in exactly one tab; a setting with its own section
  (Guidance, the Checks switch, Columns, Cloud, Auto-accept, Helper agents, Logo and mascot) is only there, with its
  real control, and the read-only Modules list no longer repeats a module that has a switch of its own. Logo and
  mascot is the very last section, also while Settings load. The tabs are a real tab list (one tab stop, the arrow
  keys, Home and End), and the chosen tab is remembered per browser; an old saved General or Helper agents tab, a value
  that is no tab and blocked browser storage all open a working tab. Lite and full mode, and the Advanced folds, work inside each tab as before.
  Every way in to one setting switches to its tab first: **Turn it off in Settings** in the Checks view lands on the
  Checks switch, and the links in the weakened banner and in "Has effect only when" open the fold and focus the
  control in whichever tab it is, without changing the address.
- **Board: stale data no longer looks live.** When the server stopped, only the status text turned red ("Could not
  read the queue (Failed to fetch)"), while the cards kept counting "running 1 h 3 min" from old data and every
  button still wrote. Now one banner below the top says in plain words what is wrong and what to do, with the time of
  the last good update: the board lost contact with its server (with `ravenseat board` to copy), the queue file cannot
  be read, the server answered with an error, or nothing has been fetched for over a minute; the key case keeps the
  key banner and gets the time too. Broken states use the danger tone, old data the warn tone, and each has Try again.
  While stale the cards are dimmed with the surface and text color (4.5:1 kept, dashed edge), the running times stop
  at the last update, and writes, drags and keyboard lifts are refused with a toast that says why. Error text from
  failed calls is a plain sentence instead of "Failed to fetch" or "HTTP 500", and never includes the key. When
  updates come back the banner goes by itself and the board is drawn again without a reload; a screen reader hears
  going stale and coming back once each, not every failed retry.
- **Board menus with one job each.** The Filter menu had a Pause button on every project row next to the filter
  checkboxes, so a click meant to narrow the view could pause a project for everyone. Filter now holds only filters:
  Pause and Continue stay in each project's lane header with the same write and the same in-progress warning, and the
  line under Projects in Filter switches to Project lanes with focus on the first Pause. A Filter section with nothing
  to choose (Plan entry before any task has one) is no longer drawn as a heading with a lone "Select all". The
  Selection menu explained Sort, Outside focus ready and On hold only in tooltips, which a keyboard or touch user never
  sees; every built-in selection now has a short visible line under its name (its description for a screen reader),
  in a 240 px menu with 36 px rows (44 px on touch) like the selection menu. "Waiting on me" is out of it (it opened
  Decisions, which the Waiting on you button does), your own selections sit under "Saved", the empty line has the
  menu's side padding, and the arrow keys move between the selections. In Checks, "Turn this tab off" sat next to
  "Read again" with the same weight; the header keeps only Read again, and a quiet line at the end of the tab opens
  Settings at the existing Checks switch.
- **Board polish: hover and press that show in dark mode, empty columns that say something, and an empty search that
  is said once.** Hover was a different rule per control (a surface swap on tabs and folds, a 5 % brightness filter on
  buttons, only an edge on cards), and in dark mode the button filter and the card-to-hover step (1.15:1) were close
  to invisible; a pressed control had no state of its own except on buttons. Buttons, tabs, fold headers, link and
  icon buttons, the "Next up" chips and cards now share one hover tone and one press tone: a thin layer of the text
  color over the control's own surface (8 % and 14 %, a filled button uses its own text color), so it darkens a light
  surface and lightens a dark one. The tones are computed from the palette in both modes: at least 1.15:1 against
  every surface, press always stronger, and the text on them keeps 4.5:1. Forced colors drop the layers, the press
  movement still stops with reduced motion, and the focus rings are unchanged. Cards get their 12 px padding from B4,
  with the checkbox re-centered on the id row. An empty column said "Nothing here."; In progress, Review, Built and
  the Blocked column now say in one calm line what goes there. Choosing a card added " · selected" to its id row, so
  "unlocks 2" wrapped to its own line and the card grew a row; the word is now screen reader text out of the flow and
  the ring shows the choice. A search that matched nothing printed "Nothing matches" with Clear search in every
  column while "Next up" still offered a card the search hid; now one message with Clear search stands above the
  columns, the columns show 0, a column the search empties while others match says "No matches here.", and "Next up"
  shows only what the search keeps ("1 hidden by the search"; the server's list itself is unchanged). Keyboard order,
  roles and the roving tab stop are unchanged. Tests cover the shared tones per control, the contrast math in both
  modes, the forced-colors and reduced-motion rules, the card padding, the column texts, the selected word and the
  empty search with Next up.

- **Board polish: a top bar that stays put, and a half-screen window that works.** The top had no fixed height: its
  rows sized themselves to the mascot zone and to what wrapped, so row 1 sat 1 px higher in Plans (row 2 is hidden
  there and the grid spread the mascot's 104 px over one row instead of two), and at about 1000 px the top was 117,
  145, 153 or 185 px tall depending on the room, with the gear dropping under the logo and the grouping on a third
  row. Opening the settings or a card beside the board at 1280 or 1440 px narrowed the top and wrapped it to 185 px,
  and in Statistics a hidden screen reader text made the whole page scroll, so the right side of the top moved 15 px.
  The top now has two fixed rows (117 px, the same in every room and at every width from 721 px up), and nothing in it
  wraps: the title and the status clip with an ellipsis, the search shrinks first, and below 1200 px the room icons
  go, the search starts at 160 px and the view tabs scroll in their own row. The page never scrolls (the board and the
  Plans room contain their hidden text), and with the panel beside the board the top keeps its full width and the
  panel starts below it. **Waiting on you** has a fixed place right after the room tabs; the status ("Updated at
  ...", the checks count, an error), whose length varies, comes last before the gear with its full text as the
  tooltip. A chosen room tab keeps its width (the bold label is reserved) and the Checks marker dot no longer widens
  its tab, so the tabs, Waiting on you and the gear stand at the same x and y in every room. The flat and lane
  columns narrow to 220 px below 1200 px, so four columns fit at 1000 px (before, Built ended up off screen). The
  focus line keeps its height from the first paint (it used to appear after the first fetch and push the board 45 px
  down), choosing a card puts its chain line into the "Next up" row instead of adding a row (the board moved 38 px
  down), with short line pieces instead of empty squares as the before and after legend, and the Plans breadcrumb has
  one height on every surface. The accent is calmer: the title is plain text, the counter on Waiting on you and on the
  Decisions groups is the warning tone instead of filled blue, Decisions fills the recommended answer only on the
  current card (the others show it as a secondary button, same order and keys), the room tabs get icons, and the
  "working now" pulse in Plans runs three times and stops. Tests cover the fixed rows, the phone-only wrapping, the
  page that never scrolls, the panel beside the top, the accent rules, the compact rules, the column fit at 1000 and
  1100 px, the order in row 1, the clipped status and its tooltip, the reserved tab width, the focus line and the
  one-row strip.
- **Board polish: headings in sentence case, and folds that look and behave like folds.** Column and group headings,
  the mission heading, the setting titles, the filter section titles, the area headings and the paused label are no
  longer set in capitals: "Ready now (4)" and "Blocked (5)" read as normal text in weight 600 with the count in normal
  weight. The In progress header keeps its name on one line next to the agents badge (before, at 1200 to 1440 px with
  the panel open or with five columns, "In progress" wrapped to two lines and the badge ran into Review); the badge now
  ends in an ellipsis in a narrow column, and its tooltip starts with the full text. The flat columns stop at 480 px on
  a wide screen. **Blocked**, **Proposed** and **Batch queue** were collapsed sections styled exactly like the static
  Ready now heading, with no arrow; they are now real disclosure buttons in a heading, with a chevron that turns when
  open, a hover surface, a 32 px target (44 px on touch), `aria-expanded` and `aria-controls`, and Enter and Space as
  for any button. Blocked is open from the start when it has 20 cards or fewer and closed above that, so what holds
  work back is visible on a normal queue while a large one still costs nothing to draw; Proposed stays closed, the
  batch queue open, and your own choice holds for the visit as before. The chain line said "hidden by the filter" for
  every chain card it could not see, also when the cause was a closed fold and no filter was on; it now names the real
  cause per group ("2 in the closed Blocked group", "hidden by the search", "hidden by the filter", "outside the
  selection", "older than 7 days in Built", "not shown in this view") with a button right after it where one helps
  (Show opens the fold, Clear search, Remove filter, Show all, Show more). The Plans folds (plan entry groups, document
  and legal groups, the filter facets, the Unregistered box) and the Focus features use the same chevron and hover
  instead of small text arrows in different sizes, and the Unregistered box gets its intended padding and accent edge
  back (its rules named a class the box never had, so the arrow sat 8 px from the window edge). The card's screen
  reader text is unchanged. Tests cover the missing capitals, the header rule, the fold semantics, the 20-card default
  on both sides, the remembered choice and each chain line cause.
- **Board polish: the task panel says what the task is about first, and stays out of the way on a wide screen.** The
  panel now reads top down: the title, a short line on what the task is about, the actions, the full mission, and the
  technical facts (status, placement and score, owner files, branch, cloud, migrations, QA, verification, source,
  remarks and the rest) last under **Details**. Details is closed from the start, shows the status on its row, and
  whether you keep it open is remembered in this browser (with no browser storage it holds for the visit). The short
  line is the first paragraph under a "What and why", "Why", "Goal", "Purpose", "Background" or "Summary" heading (also
  the Norwegian "Hva og hvorfor"), or a bold `**Goal:**` label; without one it is the first plain paragraph, skipping
  generated lines (the `=====ID=====` marker, `TITLE:` and `BRANCH:` lines, headings, `**Ownership in the queue:**`
  blocks, code and tables), and last the first list item, clipped at a word boundary near 320 characters. A mission
  with no text shows no line. From about 1200 px wide the panel is no longer modal: no scrim, no focus trap and no
  inert board; the page makes room for it so every card, the top and the gear stay clickable, a click on another card
  shows that card in the panel, the Decisions keys work while focus is in the view, the selection menu opens to the
  left of its checkbox instead of under the panel, and messages center over the board. Esc still closes the panel,
  focus still moves into it on open and back to the card on close (the card clicked last, when the content was
  swapped), and the screen reader names (Close, Actions, The mission) are unchanged. Crossing 1200 px while the panel
  is open switches the mode at once. Below 1200 px it is the modal sheet as before. Settings and the help open in the
  same panel and follow the same rule.
- **Board polish: one place to answer, one counter, and an owner question that reads the same everywhere.** The
  "Waiting on you" side panel is gone. The button at the top keeps its name, its count and its keyboard access, and
  now opens Decisions, which has everything the panel had: a checkbox on each Check and Approve card with **QA ok for
  selected** and **Approve selected**, the **Sort** list with **Accept proposal**, choosing an option with a note, and
  the line about answers not in the decision log yet. The count is shown once, on the button (the Decisions tab no
  longer repeats it). The board now opens on Decisions only when a decision is new since your last visit in this
  browser; otherwise it opens the queue view you used last (with no browser storage every visit counts as the first,
  as before). Decisions, Plans > Decisions and the Plans overview draw owner questions with one renderer and one word
  table: the same type names (Question, Waiting on condition, Waiting on lawyer, Owner task), the choices in the order
  they were written with the recommended one filled, so the number on a button and in `ravenseat decide` is the
  `--choice` number (before, the recommended choice was moved first and the numbers did not match), and the same
  button words. An owner task gets **Mark done** with an optional note instead of a question on the button; an empty
  note sends "Done", and the request to the server keeps its shape. Plans > Decisions answers with the same buttons and
  text field (a click writes at once there, and "Answer anyway" still covers a guard warning). Tests cover the shared
  words and order, the moved bulk tools, the one counter and both sides of the landing rule.
- **Board polish: selecting cards opens a short menu next to the checkbox, like a desktop context menu.** With a
  mouse on a wide screen the bulk actions no longer sit in a wide bar at the bottom centre, far from the card you
  just checked. A narrow vertical menu opens next to the box you checked last, with the count and the summed estimate
  on top, the same actions under the same conditions as before, and **Clear selection** below a line. It follows the
  next box you check (also in another column), moves along when you scroll or resize, flips left or up near an edge
  and never covers the box it came from. Arrow keys, Home and End move between the rows, Esc closes the menu and puts
  focus back on the checkbox (Esc again clears the selection, as before), and Shift+F10 on a card opens it again. The
  checkbox is now visible on every card that can be selected, with room to the card edge and the id. Narrow screens
  (below 600 px) and touch screens keep the bar at the bottom, which now uses the full width on a phone instead of
  shrinking to half of it. The preview, the dialog and **Undo** are unchanged. A test covers the order, the anchoring
  and clamping, the keyboard and both layouts.
- **The Filter and Selection menus no longer stick out past the right edge on a wide screen.** Both menus opened
  from the left edge of their button, which sits at the right end of the top bar, so on a 1440 px screen the
  Selection menu ended about 100 px outside the window and the page got a sideways scroll. They now open from the
  right edge of the button, leftwards. Narrow screens keep their full-width menu. A test checks the anchoring.

- **The push question about missing checks can be dismissed for one project, without losing the fact.** A project
  with no CI config or no gates asked before every push, also in owner mode right after you said push.
  `ravenseat controls dismiss` now stops that question for this project. It remembers what was missing, so the
  question comes back as soon as something else goes missing (for example the gates are emptied after you dismissed
  "no CI config"). `ravenseat controls restore` undoes it, and `ravenseat controls` shows where it stands. The
  dismissal is your own state in queue.json (ignored by git), so it never silences a colleague, and a broken value
  counts as no dismissal. push-check keeps the fact on one quiet line with the undo, and doctor names it once on its
  ci or gates row. `push.controlsWarning` keeps its default (on) and its meaning, and the secret scan and the
  owner-mode push question still ask as before.
- `push-check` printing its Controls line with `push.controlsWarning: false` was already fixed; a test covers it.
- **Board polish: the card id lines up with the title.** The selection checkbox on a card now sits in the card's
  left padding instead of taking room in the header, so the id no longer starts about 40 px in on cards that can be
  selected. On touch screens the box keeps its 44 px target and the header makes room for it. The Decisions headings
  use weight 600 like the rest of the board, and three `flex-basis` rules that were misspelled (and so ignored) now
  apply.
- **Board polish: a calmer palette with readable contrast in both themes.** In dark mode the cards now sit slightly
  lighter than the canvas behind the columns, so they read as raised surfaces instead of holes. Muted text,
  dividers and control borders are tuned so every text pair holds WCAG AA (4.5:1) and every control border 3:1 on
  each surface, in light and dark; a test checks all of them. The palette also gains six tinted badge tones, each
  with one meaning (neutral, ready, done, waiting on you, blocked, heavy class), ready for the card cleanup that
  follows.
- **Board polish: calmer buttons and tabs, same hit areas.** Buttons are no longer round capsules: they use a small
  6 px corner and 36 px height with a mouse, and keep the full 44 px target on touch screens. Each button has one
  level: the main action is the only filled one, ordinary actions sit on the card surface with a thin outline, and
  link actions such as "Answer in your own words" are plain text with a hover surface. The room and view switchers
  and the settings tabs are underlined tabs (a 2 px line under the chosen one), so the colored stripe under the top
  is gone and the chosen tab shows which room is open. Badges and counters use a 4 px corner and cards and panels
  8 px; only dots and the switch stay round. Purple no longer marks the Plans room. The arrow keys, Home and End in
  the tabs work as before. Visual only, no new setting.
- **Board polish: quieter cards with one meaning per color.** The project color is now a small dot in front of the
  project name instead of a stripe down every card; the stripe is kept only for cards in the Blocked column, where it
  means "needs action". The class (K, D, U) and the estimate are plain text, and only D+ keeps a badge, so purple
  means the heavy class and nothing else. "visual" is a small eye icon and "unlocks N" carries a small arrow. Every
  badge is a tinted label without a frame, taken from the palette's badge tones (ready, waiting on you, blocked and
  so on), and a ready card no longer gets a blue frame since its badge says it. In select mode the checkboxes get
  their own room instead of touching the card edge. What a screen reader says on each card is unchanged, word for
  word; a test checks it. Visual only, no new setting.
- **Board polish: an owner question reads like a question in a chat, with the recommendation easy to see.** In
  "Waiting on you" and on the Decisions cards each question now comes in a fixed order: the question first and
  largest, then the recommendation in its own highlighted block with a clear "Recommendation" label (at least the
  size of the question, where it used to be a small grey line), then why it is asked and one muted line with what
  the answer unlocks, the waiting tasks and the source, and last the answers. The doubled "Use the recommendation
  (recommended)" is now **As recommended**, and a choice equal to the recommendation reads "As recommended: Vendor B"
  without a "(recommended)" suffix; the screen reader name says what is answered ("Answer Q-SSO as recommended:
  ..."). "Answer in your own words" is now **Other decision**, and `ravenseat decide` prints the same words. A
  question can carry an optional background, `ravenseat question <id> --context "..."`, so the question text no
  longer has to mix the question and the reason; existing questions and queue.json files work unchanged. The source
  is a link when it names a task or a plan entry. Colors come from the existing tone tokens, checked at 4.5:1 in
  light and dark. No new setting.

## 0.19.0 (2026-11-18)

**The settings and checks are easier to read and quieter: sixteen groups, plain explanations, `ravenseat settings <key>`, a line on what each guard protects against, and a note when a setting has no effect because another one is off. Checks that are off by choice stop reminding you, receive prints one note line per kind, and the Checks tab folds the general ideas. The board key stays out of the output Claude reads, the review gate shows on the card before merge, and every merge override is counted. The main session's overrides and an owner-mode push now ask in the permission dialog, and the main tree's control files are out of a queue agent's reach. No protective default is weakened.**

- **The board key stays out of Claude's view.** `ravenseat board` now opens the board in your browser with its key
  and prints the link without it, so the key no longer lands in the output Claude reads when it starts the board in
  the background. `ravenseat board open` opens the running board again (a closed tab, `--follow` for the read view).
  A write without the board's own Origin is refused, a `--key-file` for scripts is an override that asks first and is
  denied to queue agents, and a new test fails if any start or open line carries the key. `board.hideKey` (on by
  default) is the setting; off prints the link with the key as before and counts as a weakened guard.
- **The review gate is visible before merge, and every merge override is counted.** A card in Review now shows
  **reviews k/n**: how many of the reviewers `receive` chose have reported FINDINGS after that receive, with a warning
  while one is missing or the newest report has a HIGH, the two cases where `merge` already stops. The board reads the
  same reports as the gate (one shared mapping), only reviewer transcripts, and only when the agents or the receive
  change. The Statistics table and the doctor `decisions` row now also count `unreviewed-overridden`,
  `no-test-overridden` and `catalog-overridden`, which were logged but left out of the override counts. No default
  changes and no guard is weaker.
- **One row for the idle guard line, and a quieter canary in doctor.** `learning.idleGuardInfo` and
  `learning.idleGuardDays` are one setting now: `learning.idleGuardDays` (7 by default, `0` turns the INFO line off).
  An old `"idleGuardInfo": false` in queue.config.json still turns the line off, and setting the number with
  `ravenseat settings set` (or on the board) turns that old switch on with it. The format canary's INFO row for a
  Claude Code version newer than the fixtures (the rows still read as expected) is shown only by `ravenseat doctor
  --all`; a format that reads differently is still a WARN in plain doctor. No default changes and no guard is weaker.
- **The Checks tab folds the general ideas.** A typical project had around ten low cards that only needed gates and
  tests, CI or an opt-in check that is off, so they showed nearly everywhere. A low card that observes nothing in the
  project now sits under a closed **More ideas (n)** fold below the suggestions (a native details element, keyboard and
  screen reader friendly), and leaves it by itself once something is found (`medium_when`, `important_when`). Cards
  with a gap or a hit, medium and high cards, and cards in the queue stay in the list as before. No card is removed and
  no priority changes; `ravenseat checks --json` marks a folded card `"quiet": true`.
- **Receive notes are one line per kind.** The reuse and scope facts (reuse, new folders, dependencies, drift) were
  up to thirteen `NOTE` lines per delivery, and two or more proposed catalog choices one `NOTE catalog` line each. Each
  kind is now one line with the counts (and the choice ids) and where the details are: every fact is still in the
  `Reuse and scope` and `Catalog rules` sections of `00-package.md`, and `ravenseat receive <id> --all` prints the line
  of each fact. A single fact keeps its own full line. The lines that stop or ask for something (`CATALOG`, ownership,
  hotspots, test weakening, control files) stay whole, and a `CATALOG` line now comes before the notes. No check is
  removed and no default changes.

- **One setting in full, and what each guard protects against.** `ravenseat settings <key>` shows one setting with
  its explanation, the value now and where it comes from (queue.config.json, queue.json or the default of the mode),
  the defaults in lite and full, the values it takes, what it needs, whether a value weakens a guard and the command
  that changes it. A name space such as `learning.` lists its rows, and a mistyped key names the nearest ones (exit 1).
  On the board, 52 rows now have one line "Protects against: ..." under the explanation: the 40 that can weaken a guard
  (the text was only in the weakening dialog before) and 12 guards without a weakening value, such as the gates, the
  read stop and the deploy commands. Advice rows have none. No default or behavior changed.
- **Settings that depend on another one say so.** 49 settings have an effect only while another one is on, such as the
  CI watch numbers (`push.ciWatch` `github`), the gap review numbers (`scopeNotes.driftGap`), the recipe damping (the
  inspection queue and `learning.repeats`) and the fix without a test line (`gates.redOnBase`). Each such row now names
  that setting: `ravenseat settings` marks it `[needs <key>]`, plus `[no effect now: <key> is off]` while it is off, and
  the board says "Has effect only when ..." and dims the row with a **No effect now** mark and a tooltip. Nothing is
  hidden and no default or behavior changes; a registry test checks that each named setting exists, that there are no
  cycles, and that a setting in another group is named in the row's text.
- **Hardening for set-aside checks, one red card per cause, and a shorter guards group.** An important gap now shows in
  `ravenseat doctor` also when its Checks card is set aside (or you said no in setup): setting a suggestion aside hides
  the card, but a key in a tracked file or `bypassPermissions` in the shared settings is still named. Without such a gap
  the off line stays behind `doctor --all`, as before. The `secret-scan-receive` card rises only to medium, never high,
  while a secret file is already in git, so the red marker counts that cause once (the `secret-files` card) instead of
  twice. Agent guards (29 rows, all Advanced) is split into File and read guards (15 rows, main switch
  `controlFiles.guard` under Basic) and Command and secret guards (14 rows, main switch `agentGuard.enabled` under
  Basic). No setting key or default changed.
- **Better overview of the settings, and three calmer defaults in lite.** The settings come in fifteen groups instead
  of twelve: Gates is split into Gates, Tests and evidence, and Checks tab and learning, and the scope notes and the
  catalog get their own group, Scope and catalog, so no group holds most of the rows and each has its main switches
  under Basic. The Checks tab and learning group says in one note that the three sources that can propose a new guard
  share a limit of three open proposals and each waits for your approval. Many titles and explanations are plainer and
  say what the setting guards, why the default is what it is and what happens when it is off. In lite mode
  `wiring.stop`, `scopeNotes.drift` and `features.focus` are now off by default (still on in full mode): done passes
  with open wiring items and names them, the same as `reviewItems.stop`; a lite task names no files, so the drift count
  had nothing to measure against; and lite has no focus stages, so the Focus tab stayed empty (`ravenseat focus` works
  either way). A value you set in queue.config.json wins in both modes, and doctor's lite line names `wiring.stop`
  with the other softer defaults. No setting key changed.
- **The weakened-guards banner counts only guards.** `learning.quickGateCard`, `learning.ciParityLift`,
  `learning.idleGuardInfo` and `testWeakening.findingLog` only show a card, order cards, give an INFO line or write a
  log row, so turning one off is no longer treated as weakening a guard: no slide to confirm, no row in "guards are
  weaker than the default", no line in doctor's `settings` row. The rows that stop, ask or deny keep their mark, and so
  does `guardLog.enabled` while the overrides are being measured. No setting changed.
- **Less noise from the checks that are off by choice.** An opt-in check that is off no longer reminds you on every
  run. `ravenseat doctor` names it only while a quiet look finds an important gap (a key in a tracked approved command
  or `.mcp.json`, the personal settings not ignored by the project, `bypassPermissions` in the shared settings), and not
  when its Checks card is set aside; `doctor --all` still lists every one. A no in setup is the same set aside, so the
  line goes too. The three cards that applied in every project (`allowlist-scan`, `gitignore-own-rules`,
  `secret-scan-receive`) are low now and rise to high only on such a gap; the receive scan rises when a secret file is
  already in git. Setup asks one question for all the checks that are off instead of one per check (up to seven
  before). No setting changed, and nothing is turned on or off.
- **Hardening: the main session's overrides and an owner-mode push now ask the owner in the permission dialog.** A
  queue agent was already denied the overrides; the orchestrator could still be talked into one by a line in a report
  or a document. With `approvals.ask` (on) the push guard answers `ask` on the main session's `merge` with `--allow-*`
  or `--force*`, `--i-understand`, `--by owner` or `--by theBoard` (also `--by=owner` and `--set-by`), `surface` and
  `owner-log accept`, `helpers approve` and a call to the board's `/api/`, and the write guard asks on its Write and
  Edit of a control file. The dialog names the task, the flags and the branch tip, never a flag value. With
  `push.ownerAsk` (on) every plain push of the base branch in `push.mode` `owner` asks too, with the tip and the merged
  tasks; threshold mode is unchanged. Edge cases covered: the override behind `npx` or `npm exec`, in `bash -c` or
  `powershell -c`, chained after a harmless step, in an `eval` or another line the parser cannot read, the board on a
  loopback form or by its key header, and the plugin's own source in the project, which is left out so working on the
  plugin does not ask every edit. In `dontAsk` and `bypassPermissions`, where no one sees a dialog, the answer is deny
  with a line saying the owner can run the command in their own terminal. A plain `merge`, `receive` or `settings set`
  does not ask. Each answer is a `guard-ask` or `guard-deny` row. Both settings are guards, so turning one off counts
  as weakened. `ravenseat doctor` gives an INFO for a `PermissionRequest` hook with a broad matcher in the project
  settings, and changes nothing.
- **Hardening: the main tree's control files are out of a queue agent's reach, and the guards now log what they
  decide.** With `controlFiles.guard` (on) a queue agent is denied Write and Edit on the main tree's
  `queue.config.json`, `.claude/` (not `.claude/worktrees/`), `CLAUDE*.md`, `.git/hooks/`, `.git/config` and the
  plugin's own scripts, and the push guard denies the shell forms with the same parser as the push and network rules.
  Edge cases covered: a redirection or append, `cp`, `mv`, `tee`, `sed -i` and `node -e` that writes, a `cd` or
  `git -C` to the main tree first, `$CLAUDE_PROJECT_DIR`, a `../` path back out of the worktree, a nested
  `CLAUDE.local.md`, and `git config` or `git remote` writes, also from the agent's own worktree, which shares the main
  tree's `.git/config`. Reading stays free, the agent's own worktree copies are free, and the main session is never
  stopped. With `controlFiles.fingerprint` (on) `start` records short hashes and `receive` names a change that git
  does not explain (CONTROL FILES CHANGED), as a warning: the owner and `settings set` change these files too. With
  `guardLog.enabled` (on) every deny and ask from the push, write and read guards is one time log row with the guard,
  the rule, the agent type and the task, never the command, path or content; `merge --force` on a running task logs
  `force-merged`, and a weakened setting with no `setting-weakened` row logs `config-changed-outside-cli`.
  `ravenseat doctor` and the board's Statistics tab count them per track. All three settings are guards, so turning
  one off counts as weakened. Not closed locally, and documented: a script the agent writes and then runs, a path
  built at run time and a process that outlives its run; the fingerprint at receive is the net for those.
- **Hardening: a gate guard that no merge runs is now seen, and its command can be added to the merge gate in one
  click without weakening anything.** A gate guard in the registry whose command is not in `gates.quick` gets the card
  "Run a built gate guard on every merge" on the Checks tab, with an **Add to gates.quick** button per guard and
  `ravenseat checks quick-add <G-n>` in the terminal. Edge cases covered: the command is read from the registry, never
  from the board (the board sends only the guard id, checked before anything runs); the write only adds the command at
  the end of `gates.quick` and keeps the rest of `queue.config.json` as written, so it can never remove, replace or
  reorder a command; a `gates.quick` that is not a list of commands, a deploy command (`deployCommands`), a push, a
  command of more than one line, a retired or unknown guard and a run from a track worktree are refused with the file
  unchanged; nothing is run. When a gate guard runs tests, a type check or lint that CI does not run, "Run your tests
  in CI" or "Run lint and type check in CI" is put first in its priority and names the guard (new card field
  `lift_when`, condition `guard-not-in-ci:<kinds>`), never raised to the red dot. `ravenseat guards` and
  `ravenseat doctor` give one INFO line for a gate guard with 0 runs 7 days after it was built. Settings, all on since
  none of them stops work or runs a command: `learning.quickGateCard`, `learning.ciParityLift`,
  `learning.idleGuardInfo` and `learning.idleGuardDays` (7).
- **Hardening: a guard can now name the failure class and area it guards against, so a class that comes back past
  it is seen.** `ravenseat guards add` takes `--class <failure class>` and `--area <path>` (`--area '*'` or none is the
  whole project), and the repeat count reads them as the guard for that class and area ("guard failed" after it). The
  class must be one of the project's (the core ones and its own in `docs/queue/failure-classes.json`); `other`, an unknown
  class, an area without a class and an area that is not one plain path are refused, and nothing is written. The gate
  tasks from the finding log and "Build as gate", and a GATE line in the new form with a class, now record their guard
  with `--class` and `--area` instead of naming the class as text in `--against`; `--from-task` on such a task fills the
  class and area from its source even when the flags are left out. The registry is tracked, so an entry holds the
  class, the area and its one sentence, never an excerpt. An entry without a class keeps the shape it had.
- **Hardening: a recipe you keep declining no longer keeps coming back as a suggestion, and one you trust stays.**
  Ravenseat now counts what became of each recipe's gate proposals from the finding log, from the tasks themselves (no
  new file): approved or built is accepted, cancelled is declined, and one still waiting counts for nothing yet. A gate
  task from "Build as gate" or from the log's own proposal keeps the recipe's id and database mark in its own field
  `recipe`; a class with only a hint, or no recipe, counts for its class alone. A recipe below 30 percent accepted
  after at least 5 decided proposals is damped: listed under "Recipe precision" on the Checks tab and in
  `ravenseat checks` with its proposals, accepted share and state, but no longer offered on the card, which then shows
  the next recipe whose `when` holds or names the damped one. It stops nothing. Database probe recipes are counted on
  their own rows and need 10 decided proposals, so a few declines of a heavy probe do not silence them. The owner's
  choice per recipe wins both ways (`ravenseat checks recipe <id> show|damp|auto`). New settings
  `learning.recipeDamping` (on), `learning.recipeMinProposals` (5), `learning.recipeMinProposalsDb` (10) and
  `learning.recipeMinAccepted` (30, checked from 1 to 100). Only recipe ids, class ids and counts are read.
- **Hardening: access control and migration failures that keep coming back can get a database probe as their guard,
  and a probe never runs against a shared database by mistake.** The recipes now cover the classes access control and
  migration: pgTAP probes with `supabase test db` for Supabase, with `pg_prove` for another Postgres, and tests in the
  project's own runner against a throwaway database for the rest, each pointing to the existing database cards. They are
  off by default (new setting `learning.dbProbes`) and shown only when the scan finds a local or throwaway database
  (`supabase/config.toml`, a database image in a compose file, or testcontainers in the manifests; a `DATABASE_URL`
  alone is not local), with the new card conditions `has-local-database`, `local-db:<engine>` and `db-probes-on`. With
  them off and a local database found, the card says how to turn them on. Every database recipe names the host check
  and the rollback in its own text, and "Build as gate" for a database class in a project with a database adds the
  shared database guard to the mission: check that the host is localhost, 127.0.0.1, ::1 or the container the run
  started before anything writes, stop with one line naming the host otherwise (never the URL), show that stop once on
  a made-up host, roll back every write, and say whether `dbGuard.localOnly` is on (recommended, never changed by the
  agent). A project recipe marked `db` without the setting and a local database in its `when` is left out and named.
  A compose file or testcontainers now also counts as a database for the existing database cards.
- **Hardening: a failure class that keeps coming back can now become a gate in one click, and a gate without a red
  reproduction is not built.** The card "A kind of failure keeps coming back: what would guard it" has a Build as gate
  button per class and area with nothing proposed yet (`ravenseat checks build-gate <class>@<area>`). It adds one
  proposed gate task in the same `GATE-<n>` series and the same cap of three as the inspection and gate proposals, so
  the same class and area is never proposed twice, a declined one stays declined, and a full cap makes it wait (the
  card says so). Its mission names the project's gate commands, the CI file, the test runner, the recipe and the places
  (paths only, never code or an error text), and the criteria: red on the reproduction and green on the fixed code,
  both runs shown; without a red reproduction the report says "no gate" and the guard registry gets the decision
  `none` with its reason. Every gate task (GATE lines, the finding log's proposals and this button) now ends with
  `guards add`, so the guard registry learns what was built. The board checks the item before it reaches the command
  line, and the command refuses it from a track worktree, with the inspection queue off, or for a class that is not
  due. No new setting: it only proposes, needs `inspection.mode` on like the card, and the card can be set aside.
- **Hardening: a failure class that keeps coming back now comes with a concrete guard for your stack, and a declined one
  stays declined.** The finding log already counted the same class of failure in the same part of the code, but the
  Checks tab only said that it was due. A new card, "A kind of failure keeps coming back: what would guard it", names
  for at most three classes how often, where (paths only, never code or an error text), the stack, and a recipe that
  points to the card that already does the work (lint, type check, secret scan in CI, test time limits and a worker
  cap) instead of a copy of it. The recipes are data in `checks-catalog/recipes.json` (unchecked errors, type drift,
  leaked secrets and flaky or weakened tests for Node, TypeScript and Python), with examples a test checks, and a
  project adds, replaces or removes them in `docs/queue/checks/recipes.json`. A new card condition `stack:` reads the
  stacks and packs found. A class and area whose gate proposal you cancelled, or that already has a gate, no longer
  counts as due, also for `ledger-due` and the proposals card. No new setting: the card is medium, stops nothing, never
  lights the red dot, needs the inspection queue on (`inspection.mode`) like the proposals, and can be set aside.
- **Hardening: a gate whose merge dies without warning no longer runs on for ever.** When `ravenseat merge`, the gate
  runner or the wait mode's runner was killed in the middle (a crash, SIGKILL, taskkill without /T, a closed terminal),
  the command it had started lived on, and a hanging one never ended, since its time budget died with its parent. On
  POSIX the command ran in its own process group, out of reach of a kill of the merge's group; on Windows what the shell
  started outlived a parent that was ended alone. Every gate command, done command, base gate and wait mode run now
  starts under a small guard that looks every second whether its runner still lives and ends the command's whole tree
  once it does not (the process group on POSIX, taskkill /T on Windows). While the runner lives, nothing changes: the
  same output, exit codes and time budgets. No new setting: ending an orphaned command never stops work that could
  still finish, since nobody is left to read its result.
- **Hardening: when a newer Claude Code writes its transcripts in a form Ravenseat does not know yet, you now get one
  line in `ravenseat doctor` and one card on the Checks tab instead of quietly short counts.** A format canary reads
  only the tail of the project's newest transcript and compares it with the formats the fixtures cover: a newer
  version alone is an INFO line, while row types the adapter does not know, assistant turns without token usage and
  API errors of an unknown kind give a WARN line (never FAIL) and a medium card that never lights the red marker. Both
  name the version, the row types and counts, never content, and say what to do: update Ravenseat, or report the form
  if it stays. It never stops a track or a merge. The row types that are unknown on purpose (the request rows, the
  edit snapshot) give no noise. New settings `client.canary` (on; off hides the line and the card) and
  `client.shapeLog` (off; on lets `ravenseat checks` write the shape of a new API error form, keys and types without
  values, to `client-shapes.jsonl` in the data folder, so it can be confirmed).
- **Hardening: the cost rows are now read through the same transcript row reader as the rest of the queue, and a
  usage limit in the newer API error form counts as a rate limit, as it does in the older form.** The time and cost
  analysis (tokens with the cache split, streamed turns, models, tool calls and failed results, thinking, version and
  working directory) no longer reads Claude Code's transcript fields itself, so a format change is fixed in one place
  and the fixtures per version hold the result byte for byte. A failed API call that Claude Code 2.1.317 and later
  writes with only the usage limit code was counted as "other" in the API error tally; it is now a rate limit, like
  the same limit in the older form, and the usage limit pause still recognizes it. No new setting.
- **Hardening: the cost estimate for Fable 5.2, Mythos 5.2 and Sonnet 5.5 is corrected, and the Claude Code formats
  the queue reads are now locked by fixtures per version.** Fable 5.2 and Mythos 5.2 were priced at the older Fable
  row ($10 and $50 per million tokens, cache reads at $1) and Sonnet 5.5 at the Sonnet 5 row (cache reads at $0.20),
  so their time log and cost guard estimates came out too high; each now has its own row ($8 and $40 with cache reads
  at $0.20, and cache reads at $0.10). New fixtures hold one scrubbed transcript per Claude Code version family (text,
  thinking, tool calls and failed tool results, the cache fields with and without the 5 minute and 1 hour split,
  compaction, the handback, a REPL call, unknown row types and API errors in both forms: rate limit, overload, usage
  limit and a plain 429) plus the hook and status line payloads, and contract tests run them through the adapter, the
  time and cost analysis, the usage limit pause and the end gate, naming the version and the row when one breaks. The
  owner message and the block a hook answers are now built in one place, byte for byte as before, and the coupling
  gate catches a new direct build.

### After you update
- `ravenseat board` now opens the board in your browser itself and prints the link without its key. Use `ravenseat board open` (or `--follow`) to open it again. A script that wrote to the board without the board's own Origin needs `--key-file`, which asks first. `board.hideKey` off gives the old start line back.
- `learning.idleGuardInfo` is now part of `learning.idleGuardDays` (0 = off, default 7). An `"idleGuardInfo": false` in queue.config.json still turns the line off.
- In lite, `wiring.stop`, `scopeNotes.drift` and the Focus tab are off unless queue.config.json sets them. Full mode is unchanged.
- The settings come in sixteen groups; no key is renamed apart from the folded idle guard row. `receive <id> --all` prints the scope and catalog notes one per finding, as before.
- No setting changes its value on update, and no guard is turned off.

## 0.18.0 (2026-11-17)

**A project catalog of helpers and accepted design choices now reaches the track and the reviewer, so code is not written twice and a choice is not broken silently. Claude Code formats are read in one place behind a client adapter, so a renamed field or a moved transcript is one fix. The Checks tab gets its own page, and three of its edge cases are closed. A check that hangs past its time budget no longer leaves processes behind. The new stops are off until you turn them on.**


- **Hardening: a check that runs over its time budget is now ended together with everything it started.** The base
  gate, a task's done command (`done_when`) and the check for tests that fail on the base ran through a shell whose
  timeout ended only the shell, so on Windows the real command it had started (node, npm, a test runner) lived on with
  a dead parent, and a hanging one never ended: it held its folder, its memory and its pipes for days. Those runs now
  go through a small supervisor that ends the whole process tree at the budget (taskkill /T on Windows, the process
  group on POSIX), the way the quick and full gates already did. What you notice: no leftover `node` processes after
  a red "time budget" result, and the run's folder can be removed. The red team scenarios now fail when a process of
  their own run outlives them, and their hanging fixtures end by themselves after two minutes. No new setting.
- **Hardening: three edge cases on the Checks tab.** A card you set aside whose condition later stops holding stayed
  out of sight, so it could not be brought back; it is now listed under "Set aside" as "does not apply now", with the
  same "Bring back" (also `ravenseat checks restore <key>`), and it never counts for the red dot or the summary. The
  report gives every card `applies` (false only for such a card), so older readers keep working; `checks plan` and
  `checks turn-on` refuse a card that does not apply. "Test your database rules" now shows only when the project has a
  database and no database probes were found (`pg_prove`, pgTAP, `supabase test db`, `sqlx test` or a probe folder),
  read from the files as before. And the text of "A guard did not hold" now says what it does: high with the red dot
  by default, medium without it when `learning.guardFailedMarker` is off. No new setting.
- **The Checks tab has its own page, and its card table cannot go stale.** `plugin/docs/checks.md` explains the tab
  from the top down: what it reads and never runs, the four card states, exactly when the red dot lights, what each
  button runs, set aside and bring back, lite mode, turning it off, your own cards in `docs/queue/checks/`, the
  commands and a short FAQ. One table lists all 46 cards with when each shows, its priority and what raises it, its
  button and its setting, and one section puts the three thresholds for repeats side by side (the cards' 3 in one area
  within 30 days, the finding log's 2 in an area or 3 in the project within 90, the inspection queue's 2 within 30)
  with why they differ. The card table and the list of conditions are generated from the card files and the code
  (`npm run docs:checks`), and a test fails when a card is missing from the table or its row is out of date. The
  section in queue.md is now a short introduction with links; board.md and catalog.md keep their short notes. Fixed on
  the way: queue.md said the database probes card turns important, which it never does, and the catalog README listed
  only part of the conditions and kinds. Nothing changes in how the tab works.
- **Hardening: API errors in the newer transcript form are now recognized, and transcript rows are read in one place.**
  Claude Code 2.1.317 and later can record a failed API call as a system row instead of an assistant entry. The cost
  rows counted such rows as no error at all, and the usage limit check skipped them and could let an older limit
  entry decide. Both forms are now read, so the rate limit and overload counts can go up from 0 to the real number,
  and a usage limit or a plain 429 in the new form is judged on the row that actually ended the turn. The readers
  of transcript rows (the approval wait, the ask bundle, the context and end guards, the results, the track guard,
  the turn statistics and the usage limit) now go through one row reader behind the client adapter, which also
  gives a row type it does not know a safe "unknown" instead of guessing. No new setting.
- **Hardening: when Claude Code renames a hook or status line field, one file needs the fix instead of seventeen.**
  The hooks, the status line and the cost, quota and tool trouble readers now read the stdin payload, and build the
  deny, ask and additionalContext answers, through one reader behind the client adapter
  (`lib/clients/claude/hookInput.js`). New tests lock the guard and context answers byte for byte before and after the move, and
  the coupling allowlist shrinks from 22 to 9 files. The push guard's internal-error path does not go through the
  adapter registry, and reads the command itself when even the reader does not load, so a forced push or a branch
  delete is still denied when the adapter breaks. The adapter now loads its parts on first use, so the hooks that run
  on every tool call pay about 2 ms for it instead of about 30. The end gate was checked against a track that delivers
  its report with SubagentHandback while the closing text has no RESULT line: it already reads the call from the
  transcript, and a test now holds that. Nothing changes for users.
- **Hardening: when Claude Code moves its transcript files, one file needs the fix instead of eight.** Where the
  transcripts live (the projects folder and its slug rule) and how an agent's file is found, listed and tailed now sit
  in one place behind the client adapter (`lib/clients/claude/transcript.js`), instead of five copies of the folder
  rule and four of the file search spread over `ravenseat ask`, `cost`, the event and track commands, the context hook, the silent track check and
  the fix round. Tests lock the old behaviour before and after the move, including the default folder and the
  `QUEUE_TRANSCRIPTS` override, and the coupling allowlist shrinks from 29 to 22 files. Nothing changes for users.
- **Hardening: a Claude Code format change is fixed in one place, and no new file starts depending on it.** The
  transcript fields, transcript paths, hook and status line payloads, cache lifetimes, model ids, environment
  variables, CLI flag and settings paths the queue reads are now dated client facts in `lib/clients/claude/facts.js`,
  each with its source, how fragile it is and the files that read it. A new test fails when a file outside
  `lib/clients/` starts reading a transcript or hook field directly, and when a file on its allowlist stops doing so,
  so the list only shrinks as the reading moves into the adapter. Nothing changes for users.
- **Hardening: a change that drifts far outside its task can get a closer look, opt-in.** Two guards build on the
  drift note at receive, both off by default. `scopeNotes.driftGap` adds the gap reviewer when at least 4 changed
  files, and over 40 % of them, lie outside the task's files and reads (`driftGapFiles`, `driftGapShare`), with one
  reason line. `scopeNotes.driftWarn` gives a track one note per file while it writes outside its files, never a
  denial, and says not to stop for it alone. A task that names no files never fires either. Each has a Checks card that
  turns important when the finding log shows scope drift three times in one area within 30 days; in lite mode no scope
  drift card lights the red marker. With both off, reviewers and write warnings are exactly as before.
- **Hardening: a design choice the owner accepted can no longer be broken silently.** A choice in
  `docs/queue/catalog/decisions/` can carry a `check` rule (`forbid`, plus `hit` and `miss` examples that
  `catalog check` runs, so a broken rule is an error before it is used). Receive runs it against the delivery's added
  lines in the choice's paths, test files and comments left out. An accepted choice gives a `CATALOG` line, a line in
  the review package and a record on the task; a proposed one only a note that binds nothing. `mode: stop` stops the
  merge only with `catalog.checkStop` on (off by default), with `merge --allow-catalog` as a logged override. The rules
  are always read from the main tree, so a track cannot turn its own rule off. The same rule broken in
  `catalog.gateAfter` tasks proposes a GATE task to make it a real lint, inside the shared proposal cap and only with
  `learning.proposals` on. A project without check rules gets byte-identical output.
- **Hardening: a helper that is only in the code can now be found before it is written again.** A `@shared <purpose>`
  line in a helper's JSDoc marks it for reuse, where it moves and goes with the code. `ravenseat catalog find <word>`
  searches an index of the code's top-level exports (JS/TS), the reuse rows, the design choices and the prefer lines,
  in at most ten lines, and queue agents may run it. The index is cached by git blob sha in the data folder, so an
  unchanged file is never read twice, also after a move, and queue agents cannot write the cache. The scan follows
  strings, template literals, comments and regex literals and reads only the top level, so a name in a string or an
  inner function is never taken for an export; a tag on a name that is not exported is named, not indexed. With
  `catalog.index` on (off by default), the excerpt gets the tagged helpers in the task's folders and the review package
  gets the new names that are close to an existing export (V1b), inside the same cap. A project without it gets the
  excerpt byte for byte as before.
- **Hardening: the catalog now reaches the track and the reviewer, and only the part that matters.** A task's mission
  gets the part of the project catalog that meets its owned files and reads: the design choices that hold, the
  proposed ones marked as suggestions, the prefer lines and the reuse rows in its folders. Only a choice the owner
  accepted counts as binding; one set to accepted by hand stays a suggestion, and a superseded one never comes. The
  excerpt has a cap (1500 tokens by default) that cuts the reuse rows first, and its heading says what it used and what
  was cut, so `fill` can print the size per track. The review package gets the same excerpt, and the reviewer and the
  gap reviewer check the delivery against it, as `duplication` for a helper written again and `scope-drift` for a
  broken invariant. A task that names no files gets only the choices that hold, a fix round's short mission leaves it
  out, and a project without a catalog gets not one byte more. Both parts and the cap have their own setting.
- **Hardening: a track no longer has to guess the stack, the helpers or the design choices.** The new project catalog
  in `docs/queue/catalog/` holds what a track should know before it writes code: the stack with one "Prefer" line per
  job, the building blocks meant for reuse, and the design choices, each with one invariant that can be checked.
  `ravenseat catalog init` drafts it from the manifests and never writes over a file, `show` lists it and `check`
  names a bad shape, a reused id, a stale reuse row or paths that match nothing. Only the owner accepts a choice
  (`accept --by owner`, refused from a track worktree), and a choice set to accepted by hand, or changed after the
  accept, reads as unconfirmed until the owner accepts it again. The folder is a protected path, plan entries can link
  to choices with `decisions`, and the Checks tab suggests the catalog for a known stack. The doctor row and the plan
  link warning have their own settings; neither stops work.
- **Hardening: copied code under a new name no longer has to slip past.** The reuse note at receive sees a name the
  base already has, not a body copied under another name. The Checks tab now suggests a copy detector in CI for a
  known stack whose CI has none (jscpd for JS and TS and most other languages, pylint's duplicate-code for Python,
  PMD CPD for Java and C#, dupl for Go, flay for Ruby), with the command for each and a threshold at today's level so
  CI does not start red. The card only adds an investigation when you ask for it, so it needs no setting, and it turns
  important only when the finding log shows duplication three times in one area within 30 days.
- **Hardening: receive names a helper written again and a change that drifts.** A delivery that defines a name the
  base already defines in another file (JS and TS, a use never counts), adds a file in a folder the base does not
  have, adds a second package for a job its manifest already has one for (dates, HTTP, validation, test runner and
  more, a table that is data with tested examples), or changes files outside its own and its reads now gets one NOTE
  line for each at receive, with the numbers and both places, and a "Reuse and scope" section in the review package
  for the reviewer to weigh as duplication or scope drift. Test files, moved names, common names such as `main` and a
  task that names no files in one folder stay quiet. They are facts only: nothing stops, nothing uses tokens, and all
  four are on by default, also in lite, each with its own setting under `scopeNotes`.

### After you update
- The catalog's `check:` rules in design choices run at receive and warn (`catalog.checks`, on). Turn on `catalog.checkStop` if a broken rule should stop the merge; `--allow-catalog` is the logged way past. The catalog index (`catalog.index`) and the drift cards (`scopeNotes.driftGap`, `scopeNotes.driftWarn`) are off until you turn them on.
- API errors in the newer transcript form are now counted, so the rate limit and overload figures can go up from 0. A rejected quota in that form now gives the usage limit pause, and a plain 429 no longer gives a stale one.
- On the Checks tab, a card you set aside stays in Set aside even when it no longer applies, so you can bring it back. The database rules card no longer shows when the project already has database probes.
- No setting changes its value on update.

## 0.17.0 (2026-11-16)

**Review findings are tracked to a close, and every check that catches a failure writes it to one local finding log, classed by a rule. A fix needs a red test first, and a failure class that comes back where a guard was in place lights the red dot until it holds again. The new stops are off until you turn them on, except the merge wait for the chosen reviewers' findings.**

- **Hardening: a guard that does not hold is no longer trusted quietly.** The finding log is now counted per failure
  class and part of the code: the same kind of mistake in two separate tasks in one area within 90 days, or three
  across the project, is a repeat, and a fix without a proven red test weighs twice. Low-confidence rows and the class
  `other` never count, and old rows from before the red-test-first rule count once. When a class comes back where a
  guard for it, or a fix with a proven test, was already in place, the Checks tab shows "A guard did not hold" with the
  red dot until a new guard or a tested fix is in place; it stops nothing. Guard proposals from the log are off until
  you turn them on (one tip, one card), and then share one cap of three waiting proposals with the inspection queue and
  the gate lines, so the three kinds can no longer add up to nine; a proposal you cancel is not made again for that
  class and place. Each part has its own setting under `learning`.

- **Hardening: a fix needs a red test first.** A fix task (one with `fixes`, a QA or base fix, a task from a finding,
  or a GATE line in its report) whose red on base check shows no test that fails without it now gets one warning at
  receive, and its finding log row keeps the verdict and is marked fixed without test, so a bug fixed without proof
  weighs more when it comes back. It is a warning by default; `gates.redOnBaseStrict` (off until you turn it on) makes
  merge stop on it, with `--allow-no-test` as the owner's logged way past, which the queue's agents cannot pass. The
  Checks tab suggests the red on base command for your stack (vitest, jest, pytest, `go test {dirs}`), and what the
  test-weakening check finds at receive is now its own source in the finding log, classed as a weak test. Both the
  fix line (`gates.fixWithoutTestWarning`) and the new log source (`testWeakening.findingLog`) are settings of their
  own, on by default since neither stops anything.

- **Hardening: finding log rows get their class from a rule.** A red `tsc`, a TS2532, a missing module, a secret hit
  or a flaky command now lands in the finding log with its class (contract drift, null or undefined, dependency and
  build, leaked secret, weak test) instead of `other`, from a rule register that is data, so a class that keeps coming
  back can be counted. The class a reviewer or track wrote still wins, an unsure match is marked low and never
  suggests anything, and a project can add or turn off rules in `docs/queue/failure-rules.json` (a broken file gives
  one doctor warning and the core rules). Track gates are now logged only from the orchestrator's evidence runs, so a
  track's own trial runs no longer fill the log.

- **Hardening: two more finding classes.** Reviewers can now mark a rule or helper written again (`duplication`) and
  a change outside the mission or its files (`scope-drift`), so both can be counted per area. A test keeps every
  reviewer file naming exactly the classes in `failure-classes.json`.

- **Hardening: review findings are tracked to a close.** A merge now waits for a FINDINGS report from each chosen
  reviewer and stops on a HIGH (`--allow-unreviewed` is the owner's way past it, logged). Each finding becomes an
  item on the task that is fixed, moved to a task or a batch, or rejected with a reason before done, and every close
  lands in the finding log. `ravenseat review-item --defer-all-L` moves the LOWs that may wait in one call. Lite mode
  keeps the done stop off.

- **Hardening: every check that catches a failure records it in the finding log.** Red track gates, flaky
  commands, failed CI checks, new base fix tasks, red done commands, red on base, secret hits at receive, GATE lines,
  `ravenseat finding`, fix links and QA deviations now each add one row, so a failure class that keeps coming back can
  be seen across all of them. Logging is silent and local: rows hold short masked excerpts (never a secret's value or
  the owner's QA text), nothing extra runs for them, and a write that fails gives one warning and never stops the
  command.

- Tidied up the FAQ.

### After you update
- A merge now waits for a FINDINGS report from each reviewer the task class chose, and stops on a HIGH. `--allow-unreviewed` is the owner's logged way past; the queue's agents cannot use it. Each finding becomes a review item to close before done (`ravenseat review-item`); lite mode keeps that done stop off.
- A fix task without a proven red test gets a warning at receive. Turn on `gates.redOnBaseStrict` if you want merge to stop on it.
- Guard proposals from the finding log are off until you turn on `learning.proposals`. Inspection, GATE lines and those proposals now share one cap of three waiting, so you may see fewer waiting proposals than before.
- The finding log lives in the data folder and is never shared. A project can add or turn off classification rules in `docs/queue/failure-rules.json`; without the file the core rules apply.

## 0.16.0 (2026-11-16)

**Review findings get one line form with a class and a place, also the low ones, so none is lost between rounds. New guards, all off until you turn them on, find keys in .mcp.json, broad shared permissions and probes aimed at a shared database, and the queue files can be shared in git on your word. `npm run test:changed` runs only the tests a change can reach.**

- **Hardening: every review finding is one FINDING line.** Every finding, also LOW, now comes as one line with a
  severity, a mark, a class and a place, and a line that cannot be read still becomes a finding instead of being
  dropped. The classes are data a project can extend, and equal codes from different reviewers are counted separately.
  Tracks keep their GATE line, with the same tail.
- **Hardening: `npm run test:changed`** (for working on Ravenseat itself) picks the tests a change can reach (imports,
  spawned scripts, the command map) and falls back to the full suite with a stated reason whenever it cannot tell.
  Docs-only changes no longer trigger unrelated tests, but tests that read those docs still run.
- **Keys in .mcp.json, broad shared permissions, and probes only against a local database** (all off until you turn
  them on). `secretScan.allowlist` now also covers `.mcp.json` (a key in a server's env, headers, args or url, named by
  path, never the value; FAIL when tracked). `permissionsCheck.enabled` names broad rules in the tracked
  `.claude/settings.json`, and `dbGuard.localOnly` refuses a database probe gate whose database is not local.
- **More Checks cards:** a Database group (probes for the database rules, migrations from an empty database in CI,
  the probe guard), and branch protection, Actions pinned to a SHA (the `--ci` template now is), the lockfile in git, a
  formatter, a pinned runtime, `.env.example`, unused code, and flaky tests seen in the time log.
- **The queue's files in git, on your word, and private paths** (sharing is off by default). `ravenseat share on`
  explains who can read `queue.json` and `plans.json` once pushed and needs `--yes` (and `--public-ok` in a repo not
  known to be private); the time log, missions and answers can never be shared. `privatePaths` (`ravenseat private add`)
  keeps your own folders out of git and, with `read: false`, out of the agents' reads. The push guard and `merge` deny a
  commit that tracks either, and the shared files once a private repo turns public. `doctor --fix` writes the `.gitignore`.
- **`ravenseat secrets clean`** removes the approved commands that hold a key, after a copy in the data folder, and
  never prints the rule. A no to a setup tip now sets its Checks card aside too.
- **Keys in approved commands, and the project's own .gitignore** (both off until you turn them on: `secretScan.allowlist`,
  `gitignoreCheck.enabled`; setup tips once, the Checks tab has a "Turn on" card). `ravenseat doctor` then reads the commands Claude Code
  approved (`permissions.allow`, `ask`, `deny`, also in the agents' worktrees) and names one with a key by file and
  index, never the key: FAIL in a tracked file, WARN on disk. It checks that the project's `.gitignore`, not only your
  global one, ignores the personal settings and the queue's data (also a moved `dataFolder`, which `setup` now adds).
- **A key a track commits is found at receive** (off until you turn it on: `secretScan.atReceive`). `receive` scans the track's own commits with the push check's patterns;
  a hit opens the blocker `secret-found` and `merge` refuses until a clean receive or `merge --allow-secret` (owner only,
  logged).
- **Setup asks about parallel tracks and a daily budget.** `/ravenseat:setup` now shows what `ravenseat machine`
  suggests for this machine (the default of 5 is above it on 16 GB) and asks before it sets `maxConcurrent`, and asks
  for a daily budget; a subscription user may skip it. Nothing is set without a yes, and the question comes also with
  quiet guidance.
- **The machine suggestion counts the checks, not the agents.** Measured: an agent costs under 0.1 GB, a light quick
  check about 0.6 GB, and one heavy check counts once because of the gate queue. `ravenseat machine` now starts from the
  free memory when no track runs, and caps at one track per core (one per 1.5 cores with the gate queue off). A light
  project gets about 8 tracks on 32 GB with 8 cores instead of 4, and 2-4 on 16 GB instead of 1.
  `ravenseat machine --measure` also runs the quick check once and counts it per track, so a project with heavy checks
  gets its own, lower figure.
- **A merge that started tracks ends with START NOW.** When fill started tracks, the very last line of `merge` names
  them and the queue-fill.json path, so a merge run in the background and read with `tail` no longer hides that agents
  must be started. The agent lines are not repeated, so the same agent is not started twice. The exit code is unchanged.
- **The grace time before NO AGENT is a limit.** `ravenseat limit noAgentMin <n>` (default 15, 0 = off) sets how long a
  track marked running may go without an agent on its branch before show, pulse and the board warn. A project that wants
  it stricter can set 5.
- **Red team: rows 2, 6 and RT-14 are challenged.** 13 guards behind "an interrupted merge leaves the repo half
  merged", "an agent reports green without passing" and "a broken queue file loses the queue" were removed one at a
  time, and their tests went red. One did not: no test cut a queue.json write off half way, so writing in place instead
  of through a temporary file would have passed. That test is added. See [the red team](plugin/docs/redteam.md).
- **Docs.** The FAQ cost section uses the latest window, the same-file answer says the second task waits, lite mode's
  dependency files only warn, the review signals and the Checks tab are described where reviewers and the tab are, and
  the newer commands are in commands.md and the usage text.

### After you update
- Reviewers now report with FINDING lines (`FINDING <code> <H|M|L> <mark> <class> @ <place> | <sentence>`). Your own reviewer prompts outside the plugin should use the same form; an unreadable line is still counted, as a finding of class `other`.
- If sharing is off and a file from the data folder is tracked in git, the push guard and `merge` now deny the commit. `ravenseat doctor --fix` writes the `.gitignore`, and `ravenseat share on` is the way to share on purpose.
- The new guards (`secretScan.allowlist` for `.mcp.json`, `permissionsCheck.enabled`, `dbGuard.localOnly`) are off until you turn them on; the Checks tab has a card for each.

## 0.15.0 (2026-11-14)

**Review signals: what a diff adds now brings in the security reviewer, on top of the class, and stack packs from your manifests add the risky calls of your stack after your yes on the Checks tab, which also shows important suggestions you skipped and a small red dot while one is open. The cost numbers lead with the last measured week.**

- **Hardening: review signals.** Reviewer choice now also looks at what a diff adds, not only the task class and paths.
  Changes to sign-in and session handling, secrets, request URLs built from data and raw HTML bring in
  `reviewer-security` with a one-line reason. Narrow by design (added lines in code files only), and the class stays the
  floor. Projects can tune it in `review.signals`, and `ravenseat helpers` shows how often each signal fires. See
  [orchestration](plugin/docs/orchestration.md#review-signals).
- **Hardening: review signals for your stack.** About 30 stack packs add the risky calls of a stack (raw SQL, rules
  that open access, CORS and CSRF, unsafe deserializing, code from data, uploads, TLS off) to the review signals. The
  stack is read from the manifests, never run, and the Checks tab suggests the packs; `review.packs` is written only
  after your yes (`ravenseat checks packs --apply`). A known stack without a pack gets a suggestion to research one, and
  your own packs in `docs/queue/review-packs/` are checked against their examples. The Checks tab now shows important
  suggestions you skipped with one click back, and a small red dot while one is open (`checksPanel.marker`, on by
  default; `ravenseat checks marker off` hides it).
- **Cost numbers.** The README and [costs](plugin/docs/costs.md) now lead with the last measured week, the fairest
  comparison, with every week and the whole 19 days beside it. A queue turn costs no more than a turn in one chat, and
  the checks come on top. The claim of the same cost per line is dropped, and no per-day averages over idle days.
  The checks cost what your own tests cost: the measured share came from a very heavy test suite, and the same suite
  would cost about the same without the queue. The explanation GIF is remade with these numbers and no small print.

### After you update
- A diff that adds sign-in or session changes, a secret, a request URL built from data or raw HTML now gets
  `reviewer-security` on top of its class, so some K and U tasks get one more review. `ravenseat helpers` shows how
  often each signal hits; `review.signals` narrows or switches one off (switching off is a weakening, doctor names it).
- Nothing changes for the stack packs until you say yes: the Checks tab suggests them, and `ravenseat checks packs
  --apply` writes `review.packs`. The red dot on the Checks tab is on by default; `ravenseat checks marker off` hides it.

## 0.14.0 (2026-11-13)

**Fewer turns per round and nothing left unwired: a pulse tick is one call that answers SILENT or the actions with their next commands, a wiring spec becomes open items that stop done until each is carried out or rejected, missions open with the files to read in one turn, a narrow researcher agent takes the orchestrator's own analysis, and full runs get priority in the gate queue with a load factor in gate health.**

### Added
- `ravenseat pulse-check`, the pulse in one read-only call (`cli/pulseCheck.mjs`). A repeated pulse (a scheduled or
  looped prompt overnight) used to run `orchestrator pulse`, `state` and maybe `next` per tick, each a turn with the
  whole context. It now runs one command: exactly `SILENT` (exit 0) when nothing needs the orchestrator, otherwise
  `ACTION: <n>` (exit 13) and one line per item with the exact next command: `RECEIVE` (a delivered track), `NO AGENT`
  and `SILENT` (the existing checks and `silentMin` limit), `START` (free slots and startable tasks after the start
  guards), `RUN` (a wait-mode run that finished with nobody waiting) and `WIRING` (open wiring items on a merged task).
  What only `orchestrator pulse` acts on is surfaced too, so nothing is lost when a loop runs only this: `CLOUD` (a
  cloud track finished, stopped, or with a tip not read yet; one `ls-remote`, no fetch), `CONFLICTS` (a predicted
  conflict the pulse has not reported), `AUTO-ACCEPT` (proposals the owner's rules would take, tried on a copy) and
  `INSPECTION` (a proposal the hourly scan would add); their Next is `orchestrator pulse` or the cloud command, which
  records the step so the next tick is silent. Owner questions and finished cloud tracks under `cloud.collect` ask are
  never ACTION; `--include-owner` adds a count for the morning. It writes only the orchestrator marker (no cache the
  pulse keeps), never starts, receives, merges, accepts or collects, runs in-process, and exits 2 on a usage error. The `parallel-wave` skill
  and `docs/orchestration.md` say: on a pulse tick run only this, and on `SILENT` answer one line and stop.
- A read-first list at the top of every track mission: "Read these in your first turn, all in the same turn:" with the
  repo files the mission names (a "Read also" section first, deduplicated, at most 12, keeping a `:line`, `:a-b` or
  `§ N` suffix; the ownership, reads and done command lines only fill what is left), so a track reads them with parallel calls in one turn instead of one per turn. Only existing files
  inside the repo are listed; URLs, globs, absolute paths and `..` escapes in the mission text are dropped, and a
  mission without such paths gets no block (`missionText.js` `readFirstPaths`, used by `make-mission.mjs`). The
  `add-to-queue` skill now asks for exact paths, one per line, under "Read also".
- A narrow helper agent, `researcher` (`plugin/agents/researcher.md`), for the orchestrator's own analysis, measurement
  and research outside a queue task. It has only `Read`, `Grep`, `Glob`, `Bash` and `Write` at effort medium, so it starts
  with far less context than a general-purpose agent, which loads every tool and MCP definition. It reads the repo,
  writes only new files in the scratchpad or the reports folder its prompt names, never edits a tracked file, never
  commits, pushes or tags, and answers short with file:line. `CLAUDE.queue.md`, the `parallel-wave` skill and
  `docs/orchestration.md` now send such helpers to `researcher` instead of general-purpose. As a shipped agent it is in
  `PLUGIN_AGENT_TYPES`, so the push, network, queue CLI, read and write guards always cover it, and `ravenseat helpers
  add` cannot take its name. A test keeps it in every list at once.
- The wiring spec becomes open items that stop `done` (`lib/wiringItems.js`). A track that may not change a hotspot
  writes one line per change in `track-result.md`, `WIRE <file> | <anchor and the exact line to add>` (the mission
  template, `track` and `track-d` define the format). `ravenseat receive` records each line on the task (field `wiring`:
  `W1`, `W2` ..., the file and the line), and `ravenseat set <id> done` and the done step of `ravenseat merge` refuse
  while one is open, with one line per item and the commands that close it. `ravenseat wiring <id> <item> --commit <sha>`
  closes one in a commit that is in the base branch and changes the item's file; `--reject "<reason>"` closes one as not
  needed (a reason is required). Both are kept with the time, logged for `ravenseat undo`, and refused from a track
  worktree. The report is treated as data: nothing in it runs, the path must be a plain repo path, the text is one
  capped line, and a malformed line still stops `done` (it can only be rejected). The open items are shown in
  `ravenseat show <id>`, `ravenseat state` (`wiring`), `ravenseat next`, `ravenseat show` and the board's task detail. See
  `docs/orchestration.md` ("The wiring spec stops done").
- The setting `wiring.stop` (default `true`, Advanced, in Merge and push): `false` lets `done` pass with open items and
  says `WIRING STOP OFF`; it is a weakened guard in `ravenseat settings` and `ravenseat doctor`.
- Order in the gate queue (`lib/gateQueue.js`). Waiters used to have no order, so a base run could wait behind many
  track runs. Now each waiter keeps a ticket in `waiting/` under the queue folder and is served by class first (base: a
  run in the main checkout, such as the gate after a merge, the full gate before a push or `machine --measure`; then
  receive: the orchestrator's gate on a track's worktree; then a track's own run), then first come, first served. A
  waiter that has waited `gateQueue.agingMin` minutes (default 10, new setting) counts as base, so no run is starved. A
  ticket whose process is gone, or that its waiter has not touched for 2 minutes, is ignored, so a crashed waiter never
  blocks the line. No new service, and it fails open like the rest of the queue. The `GATE QUEUE` line says the place in
  line and who is ahead. The evidence lock keeps its old behaviour.
- A load factor per command in `ravenseat gates --health`, for example `load x2.4 now, x1.1 on a calm machine`: the
  latest green time against the best one seen in the last 100 green runs, and the median of the last 10 runs on a calm
  machine (free memory at least `loadGuard.allSlotsFreeMemoryPct`) against the same best. A `LOAD:` line says when a
  slow run was probably a busy machine, a `HINT:` when the gate itself became slower even on a calm machine. Every gate
  row now also has `start_free_memory_pct`, the free memory when the run started (the sampler's first sample, no extra
  measurement). `--json` has `best`, `latest`, `loadNow` and `loadCalm`.
- Two Checks suggestions for projects that build their own gates, both in Tests: `test-timeouts-under-load` (give each
  run its own state, split out the tests that must run alone, keep the time budgets) and `env-precheck` (a short check
  that the services a gate needs answer, which stops with one line). `docs/full-mode.md` has a new short section, "If
  you build your own gates".

### Changed
- `reviewer-security` has five web security checkpoints, each with what to look for and what a finding names: a URL
  from data in an outgoing request (SSRF: host allowlist, fixed scheme, no internal addresses or redirects to them),
  data in an HTML, attribute, script or style context without the escaping for that context, the scheme of a stored
  link (`javascript:`, `data:` and the like refused), a path from the caller joined without normalization and a root
  check (traversal, links), and a parser differential (two parsers reading the same input differently). It is still a
  fixed reviewer for class D+; there is no signal list that picks it.
- The `parallel-wave` skill and `CLAUDE.queue.md` say the orchestrator writes no status text between tool calls or
  after a background notification unless something needs the owner; it goes on with the next call.

### Fixed
- The per-agent state folders of the track hooks in the OS temp folder (`queue-track-context-guard`,
  `queue-read-hint`, `queue-track-end`, `queue-write-warn`) were never cleaned. Each hook now sweeps its own folder
  right before it writes (`lib/stateSweep.js`): only `<id>.json` files older than 7 days, never a link, a folder or
  another name, never a parent or sibling folder, at most once a day per folder by the mtime of a `.last-sweep`
  marker (one stat on other calls), and never failing the hook.
- A track's own green `gates --quick` run in its worktree looked like one `receive` would reuse, and the config text
  said "reusing a green run on the same tip". By design only ravenseat's own run (`receive`, `merge`, or a run in the
  main checkout) records gate evidence, so `receive` ran the quick gates again. The rule is unchanged; the words now
  match it: a gate run in a linked worktree without `--evidence` prints a line saying it is not gate evidence, and
  `receive` says why it runs the gates (no green run of its own on that tip with the current gate setup). The
  `gateEvidence.mode` text in `queue.config.example.json` and `docs/queue.md` says the same.
- `ravenseat add` accepted a task field no task has (`owns` for `owned_files`) without a word, so the task ran without
  what was meant. It now prints one WARNING line per unknown field with the nearest known field, `unknown field "owns";
  the queue does not read it (did you mean owned_files?)` (`lib/taskFields.js`), as it already did for `minutes`. The
  task is still added (the existing rule for `minutes`), and the fields the queue writes itself give no warning, so a
  task copied from another queue file adds quietly.
- `docs/queue.md` (wait mode) now says that `--wait <id>` on a finished run whose output was already shown prints the
  whole output again.
- Triage read the DB objects a task owns from `owned_db`, a field no task has, so they never reached the triage
  package; it reads `owner_db` now.

### After you update
- Plugin installs get the new agent with the update. A vendored install runs `node scripts/install.mjs <project>` once
  more: it adds `.claude/agents/researcher.md` and keeps your other files.
- `done` can now refuse: a task whose track wrote `WIRE` lines waits until each item is closed with `ravenseat wiring`.
  When `ravenseat merge` stops at the done step for this, the merge is in; apply the items, close them, then
  `ravenseat merge <id> --resume`. Tracks write the lines once they have the new mission template and track agents
  (a vendored install gets them from `node scripts/install.mjs <project>`); `wiring.stop false` turns the stop off.

## 0.13.0 (2026-11-13)

**Long calls no longer stall a session, and you can see where the turns go: gates, receive and merge return within the prompt cache window with one RUNNING line and the exact next command, and `ravenseat cost` shows calls per turn, serial reads, output per tool and the cost of turns above a context threshold. The README opens with a short explanation gif.**

### Added
- A "Turns and tools" block in `ravenseat cost` (and `turnsAndTools` in `--json`, `lib/turnTools.js`), per agent type,
  the orchestrator session and other main sessions over the cost window, read from the transcripts with the existing
  transcript reader (`analyzeTranscript` with `{ detail: true }`): tool calls per turn (median, p90) and the share of
  turns with more than one call; serial single reads (runs of 3 or more turns that each make one read call) as a share
  of read turns; tool result size per tool in characters, top 5; the share of cost from turns above a context threshold;
  and the turns that start from a background task notification with their cost share. Measurement only. See
  `docs/costs.md` ("Turns and tools").
- A main session whose tool calls mostly point outside the project (a conservative rule: at least 10 path calls, 60 %
  outside, into one other folder) is listed as "worked in another repo" with its cost, and left out of the groups and of
  the orchestration figures.
- The setting `cost.contextThresholdK` (default 200, Advanced): the context, in thousands of tokens, that the block
  splits the cost at.
- One wait mode for long calls (`lib/waitMode.js`, `lib/waitRunner.js`): `ravenseat gates`, `receive` and `merge` block for
  at most `wait.blockSec` (new setting, default 280 s, at most 590, Advanced), under the 5 minute prompt cache. A run not
  done by then goes on in a detached process, and the call ends (exit 75) with one line
  `RUNNING: <what> (run <id>), started <time>. Next: ravenseat <command> --wait <id> (Bash timeout <ms>)`. The next command
  waits for the same run, shows only the output not shown yet and ends with the run's own exit code. The same command on
  the same commit is never started twice while one runs (`ALREADY RUNNING`), and a hard cap (at least 2 hours) ends a
  hung run as red and timed out. See `docs/queue.md` ("Long calls: the wait mode").

### Changed
- The README opens with a 40 second explanation gif, and the two infographics are refreshed.
- The common track text, `CLAUDE.queue.md` and the parallel-wave skill say to run gates, receive and merge in the
  foreground with Bash timeout 600000 and to follow the RUNNING line, never `run_in_background` or a poll loop.

### After you update
- A `ravenseat gates`, `receive` or `merge` call that runs longer than 280 s now returns with a RUNNING line (exit 75)
  instead of blocking until done; run the `Next:` command it prints. A terminal still blocks as before, and
  `ravenseat settings set wait.blockSec 0` gives the old behaviour everywhere.

## 0.12.0 (2026-11-13)

**Failures that keep coming back become guards, and fix rounds get cheaper: the same gate or CI failure seen in two tasks becomes one proposal to build a guard, recorded in a guard registry shown on the board; a fix round continues the agent that delivered while it is warm, a new fix agent gets a short mission, and the review after it reads only the new commits. The README now shows what it costs next to doing the work yourself in one chat.**

### After you update
- The inspection queue is on by default: when the same gate or CI failure goes red in two separate tasks or commits within
  30 days, the pulse proposes one task `INSP-<n>` to build a guard for it. Nothing runs until you approve it.
  `ravenseat cancel <id>` rejects it, `ravenseat inspection snooze <id>` holds it, and
  `ravenseat settings set inspection.mode off` turns it off.
- A fix round can now print `CONTINUE <id> (fix round N)` instead of a new prompt: send the SendMessage line it gives to
  the agent that delivered, and start no new agent. `ravenseat resume <id> --reason fix --new-agent` gives the old
  behaviour, and `ravenseat settings set fixRound.continueWithinMin 0` turns it off.
- The review after a fix round gets only the commits since the last review. `ravenseat receive <id> --full-review` gives
  the whole package.

### Added
- Failure signatures (`lib/failureSignature.js`): the time log's gate rows keep a short, redacted first error line per red
  command (`errors`), and the CI watch rows the failed jobs (`failures`). Paths, line numbers, times, ids and shas are
  normalized away, so the same failure in two worktrees is one signature.
- The inspection queue (`ravenseat inspection`, `lib/inspection.js`): a signature with `inspection.minRepeats` incidents
  (default 2: separate tasks, branch days or CI commits) within `inspection.windowDays` (30) becomes one proposal to
  build a guard, never auto-accepted. A rejected one comes back only when its incidents double; `ravenseat inspection
  snooze <id>` holds one. At most three wait at a time. The state is `inspection.json` in the data folder.
- The guard registry (`ravenseat guards`, `lib/guardRegistry.js`): a tracked file, `.ravenseat/guards.json` by default
  (`inspection.registryFile`), with one entry per guard: title, explanation, kind, what it guards against, task, date,
  status and `measures`. `ravenseat guards add --from-task <id>` records the guard an inspection task built. For a gate
  the measures ("caught N times since built") come from the gate rows. The board's Checks tab shows Guards and Repeated
  failures, and `ravenseat gates --health` ends with the last inspection state.
- Continuation first in fix rounds (`lib/fixRound.js`): when the track agent that delivered can still be reached and was
  active within `fixRound.continueWithinMin` minutes (default 60) with less than `fixRound.continueMaxContextK` thousand
  tokens of context (default 200), `ravenseat resume <id> --reason fix` writes the fix brief `fix-<id>-r<N>.md` and prints
  a short SendMessage line. The round counts toward the cap, the plateau and the fix cost as before. `--new-agent` skips it.
- Delta review (`lib/deltaReview.js`): receive stores `review_sha` and the reviewers that got the package, and the package after a fix round holds only the
  commits since then (the whole package again when a reviewer runs that did not see the earlier commits), with `previous-findings.md` and `diff-full.patch`. The reviewers, their effort and every gate are
  chosen from the whole diff as before. `--full-review` forces the whole package.

### Changed
- A new fix agent gets a short mission: the fix list, branch, worktree, the gates to run again, the conflict lines and
  the ownership, with a pointer to `mission-<id>.md` instead of the original mission's text. `--reason context` is as
  before. The findings are kept per round in `findings-<id>-r<N>.md`.
- The fix-round count in `ravenseat cost` counts each continued round (`mode: "continue"` in `resumed`).
- The README's cost section is a table against doing the work by hand in one chat, and `plugin/docs/costs.md` has the
  measured comparison from one week, with its limits.

### Fixed
- Checked against real CI logs: the same failure in several matrix jobs (node 20 and 22) is one failure of the run, the
  excerpt starts with the test's FAIL line so tests with the same bare assertion stay apart, and the `^[` color codes
  `gh run view --log-failed` writes are removed.
- Checked in a live fix round: the fix brief no longer lists the review package's own `mission.md` as a reviewer file,
  and the docs say that SendMessage writes a new start row for the same agent.

## 0.11.0 (2026-11-12)

**Know where the cost goes, and keep Claude's instructions small: `ravenseat cost` measures thinking per turn, splits build, review and fix rounds and shows week over week; `ravenseat gates --health` finds slow, flaky and never-red gates; doctor warns when the instructions Claude loads at start grow too large and `ravenseat instructions --plan` proposes a split; the push guard now denies a forced push, a branch delete and `--mirror` even when it has an internal error; and the `ask` helper starts without your CLAUDE.md.**

### After you update
- `ravenseat doctor` gets an `instructions` row with the size of what Claude loads at start (your project's CLAUDE.md, its imports and rules, your ~/.claude/CLAUDE.md and Ravenseat's CLAUDE.queue.md). If it warns, `ravenseat instructions --plan` proposes a split; nothing changes until you make it. `ravenseat settings set instructionSize.mode off` turns the advice off.

### Added
- Claude's instructions: the doctor rows `instructions` (a file over 200 lines, or more than 40,000 characters loaded at start in all, with the share of the project, your ~/.claude, Ravenseat and the organization; hidden in quiet) and `instructions-cut` (a file loaded on demand over 40,000 characters, of which Claude sees only the start), one message in the chat the first time the total passes the limit (again only after more than 10% growth; to you, never into Claude's context), the Checks suggestion `slim-instructions` in the new category "Claude's instructions", and `ravenseat instructions [--json] [--plan]`, which shows what loads and where each section could go and never writes your instruction files. The settings `instructionSize.mode` (`warn` or `off`), `instructionSize.maxLines` and `instructionSize.maxChars` are under Advanced. Tests keep Ravenseat's own share small: CLAUDE.queue.md under 6,000 characters, each skill under 500 lines, the skill descriptions under 6,500 characters and the common track text under 15,000.
- Per-turn measurements. At `set <id> done` each agent's measurement keeps its turns, output per turn, thinking tokens and thinking per turn (from `output_tokens_details.thinking_tokens`; left out when the transcript has none, so unknown is never 0) and the Claude Code version. The time log's done rows carry `thinking_tokens`, `thinking_turns` and `cc_version` too.
- A `WARN` line at `set <id> done` when an agent's output or thinking per turn is over 2x its agent type's median over the last 14 days (at least 5 agents in the baseline), and a "Per turn" block in `ravenseat cost`: the last 24 hours against the 14 days before, per agent type, with n and the Claude Code versions seen. A measurement only: it never stops the queue.
- `ravenseat cost` has "Where the cost went": the orchestrator session as its own line, and the unknown share split by its source (no task id in the mission, a label that is no task, no agent type) with the agent types. Then week over week: subagent spend, the orchestrator, and the tasks started each week with n and their median cost.
- `ravenseat gates --health [--json]`: per gate command the runs, red and flaky ones, p50 and p95 seconds and the slowest, from the time log and all its archives, and a hint for every command never red in 50 or more runs. Gate rows now store the seconds per command (`durations`).

### Changed
- The `ask` helper starts without your CLAUDE.md (`omitClaudeMd: true`), so each question costs less. It answers from the bundle and needs none of your rules; a test keeps every other agent loading them.
- `ravenseat instructions --plan` no longer asks for a Read before the first Write in a folder. On Claude Code 2.1.319 a rule with `paths:` loads on Write of a new file too, also in a subagent.
- The per-class cost figures in `ravenseat cost` and `--since` count tasks by their start date, not their done date, and the output says so.

### Fixed
- Fix rounds are counted apart from build. The measurement stores `cost.phases` (build, review, fix, fix rounds) and a `phase` per agent: a `<id>-r<N>` agent is a fix round (a `context` continuation stays build), and so is the growth of the same agent continued with SendMessage after the receive. The docs already said the split was stored, but it was not. The mascot's "most fix rounds" uses it when a task has it.
- The push guard no longer lets everything through when it has an internal error (a module that does not load, a rule that throws). It still fails open for ordinary commands, but a forced push, a branch delete and `--mirror` are denied by a small fallback rule with no dependencies (`lib/pushGuardFallback.js`), with the error in the reason. No deny list in the settings stands behind the guard, so before this one bug meant no guard at all.

## 0.10.0 (2026-11-12)

**History moves out of the hot files, and every command starts faster: the time log rotates per month and old done tasks move to an archive that commands and the board still read, so `next` and `show` on a large history went from about 20 s to 2-3 s; each `ravenseat` command now runs in one process and loads only what it needs (about 300 ms faster), `cost` on a long history went from 22 s to 3 s, and the helper scan reads frontmatter keys the way YAML does.**

### After you update
- Nothing moves at once. Done and cancelled tasks start counting the day after the update, so the first ones move from queue.json to `queue-archive.json` about 30 days later. The time log rotates on its first write in December.
- If something reads `scripts/.queue/times.jsonl` or `queue.json` directly (a script of your own), it now sees only the current month and the tasks that are not archived. The older rows are in `times-YYYY-MM.jsonl` next to the log, and the old tasks are in `queue-archive.json`.

### Added
- `history.rotateTimeLog` (`monthly` by default, or `off`; History and storage, Advanced). On the first write of a new UTC month the time log is renamed to `times-YYYY-MM.jsonl` in the same folder. A lock folder makes sure only one process renames it, and nothing is copied or cut, so no row is lost or doubled, and a crash leaves every row readable. A reader that needs a short window (today's budget, a running agent's rows) reads only the files that reach it. `ravenseat cost`, the board's statistics, the gate attempt count and the takeover read every archive, so no number changes. With a 40 MB, 150,000-row log and 3,000 done tasks, `next` went from about 21 s to 1.9 s and `show` from about 20 s to 2.8 s.
- `history.archiveDoneAfterDays` (`30` by default, `null` = never). On a queue write, done and cancelled tasks move from queue.json to `queue-archive.json` in the data folder when all of these hold:
  - they have been finished for that many days, and nothing changed them in that time;
  - no open task depends on them, fixes them or is their QA fix;
  - their QA is settled;
  - they are not gate or kickstart tasks.
  
  queue.json keeps their ids in `archived`, so an id is never given out again and an explicit one is refused. `ravenseat info` and `explain` show an archived task read-only with an ARCHIVED line, and `undo` says a change to one cannot be undone. Plans, findings, `ravenseat cost` and the board's statistics still count archived tasks. The board's `/api/task` and the new `/api/archive?q=` find them. A new task (or an edit) that depends on, fixes or is the QA fix of an archived task brings it back first. In the benchmark above, queue.json went from 3.4 MB to 85 KB.
- `ravenseat doctor` has a `history` line. Turning either setting off is an INFO line, with the size once it is large, and never counts as a weakened guard. A broken `queue-archive.json` is a WARN, and nothing moves until you fix it.

### Changed
- `ravenseat <command>` is faster. A queue command now runs in the one node process the `ravenseat` command starts, instead of starting a second one, and it loads only the code for that command instead of all of it. On a Windows test machine (median of 20 warm runs), `ravenseat mode` went from about 0.6 to 0.3 s, `next` from 0.7 to 0.4 s and `show` from 0.9 to 0.55 s. The command line, output and exit codes are the same.
- `ravenseat cost` is much faster with a long history: the local date of each usage row no longer builds a new date formatter. With a 47 MB, 150,000-row time log it went from about 22 s to 3 s, with the same output.

### Fixed
- The scan of your own helper agents (`ravenseat helpers scan`) now reads frontmatter keys the way a YAML parser does. A quoted `"permissionMode"` or `'hooks'`, an escaped key, a key with a tag, a frontmatter written as one `{...}` mapping, a key given twice, and a key that differs from `permissionMode`, `mcpServers` or `hooks` only in case or `_`/`-` are all red now, and `tools` on more lines is read whole. `Bash(*)` and other patterns that match every command count as unrestricted Bash (yellow). An approved helper stays approved (the approval is for its sha256), but `ravenseat helpers scan <name>` can now show red for a file that was green or yellow: read the red lines and decide whether to keep it on.
- `ravenseat helpers add` sets the helper's registered name with the same reader. A quoted, escaped, look-alike or repeated `name` key (and one inside a `{...}` frontmatter) is replaced, and any further copies are cut, so the copied agent file has exactly one `name`. Before, a second `name:` line was inserted next to it, and Claude Code could start the agent under the other name.

## 0.9.0 (2026-11-12)

**Every setting in one place, and no guard weakened by accident: `ravenseat settings` and the board list every setting by category with basic first and Advanced folded below, and turning a guard down needs a warning and a confirmation (a slide on the board, `--i-understand --by owner` in the CLI) and is logged. Merge now rests on ravenseat's own evidence instead of what a track can write, owner rows are checked against an owner log, the guards cover every subagent, a git hook stops pushes from track worktrees, and an outside review's merge gaps are closed (non-ASCII paths, binary conflicts, a commit landing after the checks, hidden pushes).**

### After you update
- `ravenseat doctor` has a new `settings` row. If you already turned a guard off (for example `secretScan.enabled: false` or `baseGate.enabled: false`), it shows as a WARN; that is expected when you chose it.
- If you already have a program-valued git key set (such as `core.editor`), the git surface check shows it once as a difference: run `ravenseat surface accept --by owner`.
- The first queue write after the update records the current queue as the owner log's baseline. If `receive` or `merge` later stops on an owner row with no recorded write, check it and run `ravenseat owner-log accept <id> --by owner`.
- `ravenseat proposals auto on`, `ravenseat mode lite` on a full project and `ravenseat cloud set collect auto` now need `--i-understand --by owner`. A new project's first `init` still gets lite with no question.
- General-purpose, Explore and custom subagents are now under the same push, network and write guards as the queue's own agents. Reading is unchanged. `agentGuard.except` lists types to leave out (a confirmed weakening).
- `merge` may run the quick gates or the done command once more for a task received before the update, since records in queue.json no longer count as evidence.

### Added
- `lib/settingsRegistry.js` has one row per setting (11 categories, basic or advanced, lite or full, where it is stored, and warning texts for settings that weaken a guard). A coverage test makes sure every setting has a row. `ravenseat settings` and the board's gear read it.
- `ravenseat settings [<category>] [--advanced] [--all] [--changed] [--json]` lists every setting by category with its value, the default and where it is saved, and names the guards weaker than the default on the first line. Advanced rows are marked; in lite the full-only rows are counted on one line per category (`--all` shows them).
- `ravenseat settings set <key> <value>` changes one setting in the file its row names; queue.config.json keeps its form. A value that weakens a guard prints the warning and exits 1 without writing anything, unless you add `--i-understand --by owner`; then a `setting-weakened` row goes to the time log. It is refused from a track worktree and denied to queue agents.
- The board's gear lists every setting by category (basic rows first, Advanced folded under them, full-only rows behind one line in lite), shows where each is saved, and has a banner for weakened guards. `POST /api/setting` writes one row through `ravenseat settings set`.
- Weakening a guard on the board opens a warning dialog with what the guard protects against, why not and what changes. Only a completed slide sends the change: drag it, or hold the right arrow key or Enter for about a second; a single click does not. The server refuses a weakening value without that confirmation (422).
- `ravenseat doctor` has a `budget` line: a WARN when no daily budget is set, with `ravenseat limit dailyBudget <usd>` as an optional fix (new tasks stop when the day's measured spend reaches it). It never fails and does not change the exit code, and quiet guidance hides it like the other advice.
- `ravenseat doctor` has a `settings` row: one WARN line names every guard weaker than its default (for example `protectedPaths leaves out every default path`, `secretScan.enabled off` or `proposals.autoAccept.enabled on`), with INFO lines for what lite softens and for each `protectedPaths.remove` entry. Quiet guidance does not hide it, so the "Doctor will report it" in the warning texts is now true.
- `protectedPaths` can be `{ "add": [...], "remove": [...] }` in queue.config.json: `add` extends the default list and `remove` takes paths out of it, so you no longer copy the whole list to change one entry. A path in the floor (the queue config, `.claude/`, git hooks, `CLAUDE*.md`, the queue scripts) stays protected whatever `remove` says. Removing a default path counts as weakening a guard. A list works as before, and a malformed object keeps the defaults and is a FAIL in `ravenseat doctor`.
- `gates.timeoutSec` gives a track's own gate run a time budget. Before, `ravenseat gates --quick` in a track had none, so a hanging test held the track until its agent was stopped; now a gate over the budget is red. The default `null` uses `baseGate.timeoutSec` (900 s), and `0` turns the budget off. Receive and merge keep passing their own budget, and the main checkout has no budget unless one is passed.
- A git `pre-push` hook stops a push from a track's worktree in git itself, also one the push guard never saw (a script the agent wrote and ran). `fill`, `start` and `resume` install it in the hooks folder git uses, after the first line of a shell `pre-push` you already have (husky, lefthook, your own or `core.hooksPath`), which keeps running; `prepare-track` marks the worktree. Pushes from the main checkout and from worktrees you made yourself go on as before, and the git surface baseline knows the block, so it never stops `receive`. `agentPushBlock.enabled: false` removes it; `ravenseat doctor` has a `pushblock` row.
- `gateEvidence.mode` (`own` by default, `external` or `off`) and `gateEvidence.external` set whose gate evidence `receive` and `merge` rely on. `external` lets a green run of the listed GitHub checks on exactly the same commit count as the full gate: `ravenseat gates --full` in the main checkout asks `gh` and runs nothing locally when they are green. An empty list counts nothing and says so. Both weaker values need the confirmation; doctor gives INFO for `external` and warns `GATE EVIDENCE OFF` for `off`.
- The owner log (`owner-log.json` in the data folder): every queue write records the owner rows it added (your answers, edits, resolutions, approvals and added tasks). `receive` and `merge` stop when a task relies on an owner row no ravenseat write recorded, and `ravenseat owner-log <id>` lists such rows; `ravenseat owner-log accept <id> --by owner` confirms them. The first use takes the rows there are as the baseline.
- `ownership.sharedPatchCollides` (on by default, Agent guards, Advanced, full mode only): a path in a task's `shared_patch` that another active task has in `owned_files` now counts as a shared file. The second task waits at `next` and `start` ("file x is owned by A" or "file x is in the shared_patch of P"), and `merge` stops with exit 4 on such a path ("owned by B, in this task's shared_patch"; `--allow-guard` overrides and is logged); `receive`, the pulse and the write guard name it early. Before, one task could own a file while another patched it, both ran at once, and the patching task merged with no stop. `false` keeps the old behaviour; turning it off is a weakened guard that needs `--i-understand --by owner`, and `ravenseat doctor` names it.

### Fixed
- `queue.config.example.json` now matches the defaults for `board.showCloud` (true) and `indexFile` (`docs/INDEX.md`). A test keeps every example value equal to the default unless it is listed as a deliberate example value.
- The queue reference had `protectedPaths` twice, both saying `[]` turns the guard off; one row is left, and it says `[]` drops the defaults but keeps the floor. The base gate key is `baseGate.commands`.
- "Next up" on the board, `next`, `fill` and the focus view no longer offer a waiting task with an open blocker that needs action (the codes of the Blocked column, such as `gate-red` or `owner-question`). The start rules (`blockers`) now name the open block, `blocked: <code> since <time>; ravenseat unblock <id>`, so the board and the CLI share one rule; `ravenseat unblock` frees the task.
- The merge guard now reads paths with non-ASCII characters as they are. With git's default `core.quotepath`, a protected file such as `.claude/skills/ø/SKILL.md` or `ø/CLAUDE.md` came out quoted and went through as ownership drift (a warning) instead of stopping the merge. `merge-track` reads the diff with `-z`, and the queue's git calls set `core.quotepath=off`.
- A conflict in a binary file, or in text that is not UTF-8, is now left for you to resolve. The automatic conflict merge read it as text, found no changes, and committed a damaged copy of the base version, losing both sides' changes.
- A queue agent can no longer hide a push in a git command that runs a command itself: `rebase -x`, a program-valued key given with `-c` (`core.pager`, `core.sshCommand` …), `submodule foreach`, `bisect run`, filter-branch filters, `difftool -x`, `--upload-pack`/`--receive-pack`/`--exec`, and variables such as `GIT_EDITOR` or `GIT_SSH_COMMAND`. With a push in the line they are denied for agents and asked about for the main session; without one they stay free.
- `ravenseat merge` now merges the exact commit its checks ran on: a commit that lands on the track branch after the checks stops the merge (receive again) instead of going in unchecked, and the merge commit must have that commit as its second parent. A trial merge (`git merge-tree`, git 2.38+) runs first, so a conflict that must be resolved by hand no longer leaves the main checkout mid-merge; the stop says to resolve it on the track branch (a fix round or `git merge <base>` in its worktree), then receive and merge again.
- The push guard reads the gate evidence name the way the shell does: in any case, without quotes, backticks or backslash escapes, so `GATE-EVIDENCE.json` or `gate-"evidence".json` no longer gets past it. A queue agent's shell write to `queue.json`, `base-health.json` or `queue.config.json` (a redirection, or a writing command such as `cp`, `mv`, `tee`, `sed -i` or `Set-Content` naming one) is now denied too; reading them stays free.
- The secret check before a push now has one overall limit of 6 s, below the push guard hook's own 10 s. Each git or gitleaks call had its own `secretScan.timeoutMs`, so slow steps could add up past the hook limit; Claude Code then killed the hook and the push went without a question. A scan out of time now asks, and the hint no longer suggests raising `timeoutMs`.
- More git config keys count as running a program: `gpg.program` and `gpg.*.program`, `core.editor`, `sequence.editor`, `core.askPass`, `core.gitProxy`, `diff.*.textconv`, `pager.*`, `remote.*.uploadpack` and `receivepack`, `mergetool.*` and `difftool.*` `cmd` and `path`, `include.path`, `interactive.diffFilter` and others (the list is in the queue reference). The git surface check watches them, `git -c` with one hides no push, and a queue agent may no longer set them with `git config`. A key you already had set shows once as a difference after the update: `ravenseat surface accept --by owner`.
- `cleanup-worktree --all --execute` no longer deletes a folder under `.claude/worktrees/` that git does not list when its `.git` is a folder or points to a gitdir that exists, or when `git status` there fails or shows changes. After a moved or renamed project a real worktree with uncommitted work could look unknown and be deleted; the message now suggests `git worktree repair`.
- `ravenseat merge` no longer skips a task's done command because the `done_check` in queue.json says it was green on the same commit and command: a track can write that file. Under `gateEvidence.mode own` and `external`, receive and merge now record each done command run in the gate evidence store, and merge skips the command only when ravenseat's own newest run on that commit, with that command and a clean worktree, was green (the skip line says "ravenseat's own run at ..."). Otherwise it runs the command again. `off` keeps the old rule.
- full-mode.md said lite has no focus or value-based priority. Lite has the Focus tab on by default (`features.focus`), every task gets value 5, and `ravenseat add --priority 1-10` moves one up or down. A test now checks that row against the code.

### Changed
- `ravenseat merge` no longer believes the `gate_check` in queue.json before the merge: it uses the gate evidence ravenseat recorded for the track tip (the run `receive` made, so nothing runs twice) and runs the quick gates in the track's worktree when there is none. A red result stops the merge as before. `gateEvidence.mode off` keeps the old behaviour and also lets `receive` take the track's `gates=OK` without running them.
- The push, network and write guards now apply to every subagent, not only to the queue's own agent types: a general-purpose agent, Explore or a custom agent can no longer push, use the network, install packages, run ravenseat write commands or write the queue's state files. Read-only work goes on as before. The main session is never guarded. `agentGuard.except` lists agent types to leave alone, and `agentGuard.enabled: false` goes back to the queue's own types; both weaken a guard and `ravenseat doctor` names them.
- The gear's "The queue" section is gone: the limits are in the Limits and cost category, with the same fields and guard rules, and their titles and explanations now come from the settings registry. In lite, `maxDPlus` and `maxPerDomain` have no field (they are behind the "full mode only" line).
- Switching auto-accept of proposals on in the gear now opens the warning dialog first, and `/api/proposals` refuses it without the dialog's confirmation (422). `ravenseat proposals auto on` in the CLI now needs `--i-understand --by owner` as well (see below).
- full-mode.md and guide.md now say what lite really has: the Plans room is on by default (`features.plans`), and `reviewer-light` reviews class K tasks when the project has no CI config or no gates. A test pins this against the code.
- The docs for the queue for heavy gates and the FAQ say where it has run: developed and run on Windows, CI runs its tests on Linux and Windows, and it has not been tried on macOS.
- The track hooks that run on every tool call no longer load the whole queue logic: `lib/contextGuard.js` loads it only when it binds the orchestrator, which saves some 35 modules and 70 ms per call.
- The cost docs give their sources: they describe how cost per task is measured, the class table has its date window and n per class, says it is subagents only and that cost per task drifts (with later windows), the orchestrator's cost per finished task is a measured 14-day window, the compaction sample is corrected, fix-round savings are called design rather than measured, the long main sessions are listed as a measured cost, the calibration ratios in the queue reference come from their real sample, and the `maxConcurrent` table says 3-4 for 32 GB, where five tracks broke the gates in one large project.
- `ravenseat proposals auto on` now follows the same rule as `ravenseat settings set`: switching auto-accept on from off prints what the guard protects against, writes nothing and exits 1 unless you add `--i-understand --by owner`, and it is refused from a track worktree. With the flags it is written and logged as `setting-weakened`. Off, and changing the other rules while it is on, need no flag. The board passes the flags only after its warning dialog. `limit` and `cloud set` go through the same check.
- `ravenseat mode lite` on an existing full project (also `settings set mode lite`, `init --lite` and the Mode list in the gear) is now a confirmed weakening, since lite softens `gitSurface` and `dependencyFiles`: without `--i-understand --by owner` it prints what it changes, writes nothing and exits 1, with the flags it is written and logged as `setting-weakened`, and it is refused from a track worktree. A new project's first `ravenseat init` still gets lite with no question, `kickstart` and `setup` do not change the mode, and a project already in lite is not reported as a weakened guard (doctor keeps its INFO line for what lite softens). `mode full` needs no flag.
- `ravenseat cloud set collect auto` (and `settings set cloud.collect auto`) is now a confirmed weakening with the same rule; the Cloud section in the gear opens the warning dialog first, and the server refuses it without the dialog's yes (422). `off` and `ask` need no flag. A project that already has `collect: auto` now gets it named on doctor's `settings` WARN line.
- `ravenseat guidance quiet` and `ravenseat kickstart gates` are not weakenings; a test pins that they need no flag.
- The doctor row about `disableAllHooks` in a Claude Code settings file is now called `hooks-off`, since `settings` is the new row below. The INFO line under `secrets` for a switched-off secret scan moved into that row.
- The configuration table in the queue reference is split into the eleven settings categories, one row per registry setting, each marked Advanced, Full mode only or queue.json. A test checks that every registry setting is in it. guide.md and full-mode.md link to it.

## 0.8.35 (2026-11-11)

**Fewer ways for a green gate to mean nothing, and fewer fix rounds for nothing: new tests can be checked to fail without the change, a focus marker stops the merge, a flaky track gate is rerun once instead of sent back, and the guards close three gaps an outside review found (installs through the shared node_modules, lockfiles beyond npm, network calls hidden behind a runner). The board can show stuck tasks in their own Blocked column, and the FAQ answers what a new user asks before choosing it.**

### Added
- The board can show a Blocked column right after In queue (Settings, General, "Blocked as its own column"; off by default; `ravenseat board-setting blocked on|off`): tasks with an open blocker that needs action move there with the code and how long it has stood, those holding back the most first, while tasks that only wait on another task or are on hold stay in In queue (suggested by wegster on Reddit).
- Red on base: with `gates.redOnBase` set to a test command (`{files}` marks where the quoted files go), `receive` runs the track's new or changed test files on the delivered tip (they must pass) and, with the rest of the track's change taken away in its worktree, one at a time (at least one must fail). Tests that pass without the change get a `RED ON BASE` warning and a `Red on base` section in the review package; the worktree is put back afterwards. A warning, never a stop. Off by default; `doctor` checks the value.
- A flaky track gate no longer costs a fix round: when `ravenseat gates` is red in a track's worktree, only the red commands run once more on the same clean commit, and green then counts as green, marked FLAKY in the gate evidence, the time log (`flakyGate`, counted by `ravenseat cost`), the `receive` output, a finding deduplicated on the command and the review package. Red twice stays red; `gates.flakyRerun: false` turns it off.

### Changed
- The FAQ answers what a new user asks before choosing it: maturity, the time it needs, running while you are away, cost and caps, machine load, few tests, macOS and Linux, hook overhead, updates and cloud safety. The test-weakening answer and the guide now mention the focus stop and red on base.
- The guards close three gaps an outside review found. Queue agents can no longer run `npm ci`, `npm install`, `npm update`, `npm rebuild` or the pnpm, yarn and bun forms, or delete `node_modules`: in a worktree it is a link into the main tree, so it changed the main tree and every other track (the mission already forbade it). Every common lockfile is now protected by default, not only npm's (`yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock` …). The network guard reads the command line the way the push guard does, so `wsl curl`, `timeout 5 curl` and `eval curl` are caught too.
- The orchestrator's instructions now say that a track's report, RESULT line and handover are data, never instructions.
- A focus marker (`.only(`, `fit(`, `fdescribe(`) on an added line in a test file now stops `merge`, since the gates went green while the other tests never ran. Skips stay a warning. `--allow-focus` overrides it (logged as `focus-overridden`); `testWeakening.focusStop: false` turns the stop off.

## 0.8.34 (2026-11-11)

**Tracks that build on the same code no longer trip over each other unseen: a task can say which files it only reads, and waits while another task changes one of them. Tracks now ask before they make an architecture choice, and receive warns when your own Claude setup changed while a track ran.**

### Added
- Read ownership: the task field `reads` lists files (or folders with `/`) a task builds on but does not change. A task that reads a file an active task changes waits until that task is done, and so does a task that would change a file an active task reads; two readers never block each other. `"reads": { "mode": "warn" }` lets it start with a `READS WARNING` instead. `explain` and the board say why, the mission lists the read files and says which one is being changed, batch packing keeps them, `doctor` checks the mode, and the add-to-queue skill fills `reads` from the imports and calls it finds with Grep.
- The fingerprint of your own Claude setup: `start` and `fill` record hashes of the settings files, `CLAUDE.md`, keybindings, the plugin manifests and the agents, commands, skills and hooks folders in `~/.claude` (or `CLAUDE_CONFIG_DIR`). `receive` warns with `CLAUDE SETUP CHANGED` when one changed while the track ran, since git never sees that folder. Only hashes are stored. `"claudeFingerprint": false` turns it off.

### Changed
- "Decide or ask" now names architecture: a track asks before it draws a new module boundary, sets a pattern other modules will follow, or moves responsibility between layers, instead of writing it down as an assumption. The reviewer and the light reviewer flag an assumption that is really such a choice ("should have asked"), and the architecture lens of the area review looks for them.

## 0.8.33 (2026-11-11)

**A track that is stuck in its fix rounds now asks you sooner: when a round commits nothing, or the check fails exactly as before, the queue stops and asks instead of paying for more of the same until the cap. The costs page also has the measured cost of compacting the orchestrator against starting a new chat.**

### Added
- The costs page (`plugin/docs/costs.md`) has a measured section on compacting the orchestrator against starting a new chat: about the same cost, back to work in about 6 turns instead of 17, compaction at about 268k tokens of context. The compaction call itself is an estimate, and the page says so.
- The fix-round plateau: before a fix round, the queue asks the owner (exit 8, question `<id>.plateau<N>`, `FIX-ROUND PLATEAU`) when the previous fix round committed nothing or the check fails exactly as before it, instead of paying for more of the same until the cap. Durations, clock times and shas in the output do not count as a change. The owner's answer allows the round; `"fixPlateau": false` turns it off.

## 0.8.32 (2026-11-10)

**Ownership is now enforced: a file another active task owns stops the merge, shared config gets hotspots with a serial lock, the ranking prefers short tasks on contended files, and new tasks get ownership hints from what earlier tasks really changed. Tracks are warned while they write, a refused or failing tool gets its own card, and `setup --update` merges the project's doc copies.**

### Changed
- A track that changes a file another active task owns (running, in review or picked) now stops the merge (exit 4, before the merge), with the file and its owner named. Before, it merged with only `WARNING ownership drift` and stopped only on a text conflict. `--allow-guard` overrides and is logged as `guard-overridden`. `receive` and the pulse say it early, so it is fixed while a fix round is cheap; the pulse caches the changed files per tip sha. Another task's `shared_patch` is not counted as ownership.
- The ranking counts ownership contention: when other open tasks own an overlapping file, only one of them can run at a time, so a short task (60 min or less) gets +10 % per contender and a long one (above 120 min) -10 %, at most five counted. The board's Placement shows the factor.
- `owner_db` is compared without the default schema and the argument list: `users` and `public.users`, and `fn(uuid)` and `fn`, are now a conflict. Another schema (`auth.users`) is still a different object.

### Added
- `merge` keeps the files a task actually changed (`changed_files`, at most 300). `add` prints an OWNERSHIP HINT when earlier tasks that changed the new task's files also changed other files (in at least two of them and at least half), so they can be owned before the track starts.
- Hotspots: `hotspots` in `queue.config.json` lists shared config many tasks touch. A hotspot can never be in `owned_files` (`add` and `edit` refuse it); a task names the hotspots it may change in `hotspot_patch`, and two active tasks holding the same hotspot are a start conflict. An unagreed hotspot change gives a write warning, a note in `receive` and the pulse, and stops the merge (exit 4, `--allow-guard` overrides and is logged). The default is `[]`, so nothing changes until a project lists its hotspots.
- Write warnings for tracks: the write guard now tells a track, once per file and kind and without stopping the write, when the write will be stopped later: a protected path its task does not own, a file another active task owns, a hotspot it has not agreed, a new skip or focus marker in a test file, or a test file that loses all its assertions. The warning says what happens at merge or receive and tells the track to ask the owner, or to fix the code instead of the test. Reviewers, helpers and the main session get none.
- `ravenseat setup --update`: a three-way update of the project's copies (the docs in `docs/queue/` and `CLAUDE.queue.md`). Setup now records the plugin text it wrote as the base. A copy nobody edited follows the plugin, a copy with only your edits stays, edits on both sides in different places are merged, and a conflict leaves the copy as it is and saves the merge with markers in `scripts/.queue/setup-merge/`. `--dry` shows what it would do. A copy from before bases were kept is not touched; `--overwrite` replaces it. `queue.config.json` is never merged. `doctor` and `setup` now point to `--update` for old copies.
- A **TOOL TROUBLE** card in "Waiting on you" when auto mode refuses a track's tool call, or when a track fails the same tool three times within half an hour. PermissionDenied and PostToolUseFailure hooks keep only the agent id, the tool name and the time in `<dataFolder>/tool-trouble.json`, never the reason, the input or the error text. A plugin install gets the hooks with the update; a project set up from settings.queue.json gets them with `ravenseat setup --settings`.

### Fixed
- The NEEDS APPROVAL card from 0.8.31 now shows in a real session. A live run found that the board tied the waiting agent to no task: the time log's start row is written before the agent's transcript exists, so it carries the agent id. The board now reads the mission at the start of the agent's transcript (`prompt-<ID>.md` or "track <ID>", the same rule as the time log) when the time log has no task for it.

### Tests
- An opt-in live test (`RAVENSEAT_LIVE_APPROVAL=1`, Windows, never in CI) starts a real claude in its own window, lets a background agent stop on a Write prompt and checks the card on the real board. A claude started with the CLAUDE_* variables of another Claude Code session wrote no transcripts in the first run, so the test starts it with a clean environment.

## 0.8.31 (2026-11-10)

**A track's own choices are now in front of you before the merge, a track that waits on a permission prompt gets its own card, queue.json keeps copies at a few ages, and `ravenseat explain <ID>` says why one task stands where it stands.**

### Added
- `receive` prints the Assumptions section of a track's report next to its owner questions, and the review package carries it with a note to the reviewer: a choice the owner should have made (what the feature does for its users, a public API or file format, deleting data, a security or legal tradeoff) is a MEDIUM finding. In a round with real agents, a track made a public API choice itself and only wrote it there.
- A **NEEDS APPROVAL** card in "Waiting on you" when a track's agent stands still on a permission prompt, with the tool's name and since when. A Notification hook (matcher `permission_prompt`) finds the waiting agent from the session's subagent transcripts and keeps only its id, the tool and the time in `<dataFolder>/approval-waits.json`, never the prompt text. The card goes once the agent moves on. A plugin install gets the hook with the update; a project set up from settings.queue.json gets it with `ravenseat setup --settings`.
- Rolling copies of queue.json in `<dataFolder>/snapshots/` (default 1h, 5h, 1d, 2d and 7d). A copy moves up a tier once it has reached its own tier's age, so no two tiers hold the same copy, and a broken queue.json never pushes out a good one. The cost is one file check per tier on each write. `ravenseat doctor` names the copies when queue.json is broken. `stateSnapshots.tiers` in queue.config.json sets 2 to 8 ages, and `enabled: false` turns it off.
- `ravenseat explain <ID> [--json]`: why one task stands where it stands, from the rules the queue starts by. For a waiting task: what blocks it, a stop on the whole queue, the full limits and its place among the startable ones. For a running task: when it started, the round, an open block and the last sign of life with its source, SILENT over `silentMin`.

### Fixed
- The gates run in a track worktree outside the project folder (a linked worktree of the same repository), instead of refusing it.
- `prepare-track --continue` after `resume` counts only the track's own commits, so a freed worktree is READY again, and a detached HEAD with a stray commit is still refused.
- `fill --ids A,B` fills both tasks; a comma-separated list was read as one unknown id.

### Docs
- The FAQ and the red team page make narrower claims after a review, the FAQ answers how to use Ravenseat in an existing project, and the red team result names the check it skips.

## 0.8.30 (2026-11-08)

**Every row on the red team map is now tested, not only named: a cold restart of the orchestrator, two agents in the same file, files outside a task, missing tools and runaway cost run as real flows. The round found four more problems, and all four are fixed. A project without git, or without a first commit, gets a clear stop and a card with the text to give Claude.**

### Added
- Red team scenarios:
  - the orchestrator and an agent killed with no handover, picked up by a new process from what is on disk;
  - two real tracks changing the same line, with the second merge stopping and its fix round told both sides;
  - a file outside a task's list (a warning) and a protected path (a stop before `git merge`);
  - git, node, `gh` and `claude` each missing from PATH, a node older than 20, and a gate program that is not installed;
  - a changed helper agent that has not been approved again;
  - lite to full mode and back;
  - a project without git or without a first commit.
- A first-commit card on the Checks tab and in `ravenseat checks`, for a project with no git or no commit. It shows the text to give Claude in your own session (`git init`, a `.gitignore` that keeps secrets out, a first commit after your yes, no push) with a copy button. A queue agent cannot take this step, so it adds no task. Set it aside, or turn the tab off, if you know git. Suggestion files can use the new `action: ask` and the conditions `no-git` and `no-commit`.
- `ravenseat doctor` warns when a gate's program is not found on PATH (for example `pytest` or `cargo`), so a gate that is red on every run is named before the first track. It only looks the program up and never runs the gate.
- The cost guard warns about the first runaway track of a class too: until a class has three finished tasks in seven days, it compares with the task's own estimate. The warning says which it used.

### Fixed
- In a repo with git but no commit yet, `start` marked a task running and the agent then stopped at its first step. `start` and `fill` now refuse before anything is marked and say to make a first commit.
- With git missing from PATH, `doctor` passed and blamed the repo. It now fails first, naming git.
- When an agent died with uncommitted work, `resume` did not mention it, and the new agent started without it. `resume` now names the changes and how to commit them to the branch first.

### Known limits
- Unclear requirements are still not verified: that needs rounds with real agents.
- The gate program check looks at doctor's PATH, which may differ from the agents', and does not judge a program behind `$VAR`, `npx` or an npm script.
- Before a class has history, the cost guard's estimate is the class default, which can be far from the real cost.

## 0.8.29 (2026-11-08)

**Ravenseat now has a red team suite that tests it the way a careless user would use it, with a page and a FAQ that answer "can it break my repo?" with tests. It found ten problems, and all ten are fixed. Cloud tracks also work on a normal subscription.**

### Added
- A red team suite (`npm run redteam`). It uses real git, real `ravenseat` processes and the real hooks, and only the agent is fake. After every scenario one shared check makes sure your uncommitted, untracked, staged and stashed work is as it was, history only grew, the remote is untouched, and every task is in the queue exactly once. Scenarios:
  - uncommitted work through a whole task;
  - a merge interrupted and resumed;
  - two sessions on the same task;
  - a task that never passes;
  - a hanging test;
  - a weakened test;
  - a gate that checks nothing;
  - forced pushes in 17 written forms;
  - folders with spaces and æøå;
  - 20 tasks changed at the same moment.
- [Red team page](plugin/docs/redteam.md) with the map of fears, status and level, the findings and the limits, and a [FAQ](plugin/docs/faq.md) ordered by what people worry about, with the tests behind each answer. The result section is generated by `npm run redteam:report`. A test keeps the map, the FAQ and the links in step with the tests.
- `receive` and the review package name a test file left with no assertions. Like deleted tests and skip markers, this is a warning for the reviewers, not a stop.
- `ravenseat doctor` warns when every gate command checks nothing: `exit 0`, `true`, an `echo`, or an npm script that is one of them.
- `ravenseat set <id> done` warns when the task never started or its branch has commits that are not in the base. The warning names the tasks it frees and the way back. It never stops you, since you may have merged the work yourself.
- `ravenseat doctor` names a `queue.json.<pid>.tmp` left by a process that is gone.
- Cloud tracks on a normal subscription:
  - `features.cloud` is the one switch, and the Cloud tab comes with it. `cloud settings`, `cloud set` and a Cloud section in the gear change the rest. `cloud.maxSessions` and a doctor check are new.
  - `cloud collect` brings finished sessions home one at a time (worktree, prepare, receive), so the gates and the evidence stay local. Merge is still its own step, and it removes the session's branch from the remote unless `cloud.deleteBranch` is off.
  - `cloud-go` starts several sessions before you leave. It says first if the base is not pushed, and the offer can be turned off. Cloud starts obey the usage-limit pause.
  - `cloud setup` suggests a setup script from the lockfile, and advises protecting the base branch.
- `ARCHITECTURE.md` with the decisions, trade-offs and failure modes.

### Fixed
- A test that hung could hold a merge for good when the base gate was off. The merge's gates now always get the time budget.
- With a staged change, or uncommitted work in a file the task's branch changes, `git merge` refused. Before it refused, its own save and restore had rewritten your other files with CRLF under `core.autocrlf` (the Git for Windows default). The merge now stops before `git merge`, names the files and touches nothing.
- Two tracks received at the same moment could read each other's gate evidence as tampering, and both stopped for you. Gate runs that record evidence now take turns.
- `add` and `edit` refuse dependencies that wait on each other. Such tasks used to wait forever without a word. `doctor` names a cycle that is already in the file.
- A task edited by hand without a domain or class no longer crashes `next` and `show`.
- Our own tests no longer pick up the queue of the checkout they run in.

### Known limits
- Removing some assertions while one remains is not named. It looks like ordinary tidying.
- Green means your checks passed, not that the change is right. `doctor` says when the gates check nothing, not when a real suite is too thin.

## 0.8.28 (2026-11-07)

**A lock nobody holds no longer stops your commands.**

### Fixed
- On Windows, a queue command could fail with "Could not get the lock" although nobody held the lock. When a command released the lock, Windows could refuse to remove the lock folder, and the empty folder made the others wait until they gave up. An empty lock folder is now taken after 2 seconds.

## 0.8.27 (2026-11-07)

**Ravenseat now pauses at the subscription's usage limit instead of starting work that cannot finish, and each check cleans up its own temp folder.**

### Added
- A pause at the usage limit. When a turn ends on the limit, a hook saves the reset time, and no new tracks or fix rounds start until then (exit code 12). Running tracks are left alone. The pulse and the board say when work resumes. `usageLimit.pause` false turns it off, and `ravenseat limit usageLimit clear` lifts one pause. This has only been tested against recorded signals, not a real limit.
- Each run of `gates.mjs` gives its commands a temp folder of their own and removes it afterwards, so what a project's tests leave goes with it. A folder holding a link is left in place, and the run says so. `gateTemp.enabled` false turns it off. A separate base gate and a task's done command keep the normal temp folder.
- `ravenseat doctor` has a `temp` line with the number of entries and the prefixes with the most. It removes nothing.

### Docs
- The orchestration guide has a section on what each kind of interruption leaves behind and how to resume, backed by new tests that kill merge and receive without warning.
- The queue guide explains the temp folder, and why a plugin's hooks multiply with the number of agents.
- The README mentions the shared queue for checks and `ravenseat machine`.

### Fixed
- Our own tests no longer leave folders in the temp folder.

## 0.8.26 (2026-11-07)

**Heavy checks now take turns across the whole machine, so several projects or tracks no longer choke it, and `ravenseat machine` suggests how many tracks your PC can carry.**

An existing project keeps its own copy of the mission template, so its tracks get the new instructions on proposals only after `ravenseat setup --overwrite` (it replaces your own edits in the copied files; `--dry` lists them first). Commit the result.

### Added
- A shared queue for heavy checks. Gate runs wait for a free slot, across all projects on the machine, and the time budget starts when the check starts. The wait is shown and logged. It lets everything through if the queue itself fails, and `QUEUE_GATE_QUEUE=off` turns it off.
- `ravenseat machine [--measure]` shows cores, memory and free memory, and suggests a `maxConcurrent`. The suggestion is an estimate, and it changes nothing. `--measure` times one full check when no track runs.
- `ravenseat doctor` and setup give the same suggestion. `doctor` gives a WARN when `maxConcurrent` is above it, and the default of 5 does so on machines under about 33 GB.
- Free memory is sampled during a check. The lowest value goes in the time log, and a red check on a machine short of memory says that load is the likely cause.
- Two new cards under Checks: run only the changed tests in the quick check, and cap the number of test workers.
- `ravenseat --version`.

### Changed
- A proposal from a track no longer goes in the batch queue or trips the small-task and project warnings. The owner decides that when approving.
- Proposals in the batch queue are counted and shown in the inbox, the state line, `approve`, `decide` and `info`.
- The mission has one paragraph on new work, and explains why PowerShell 5.1 needs one command per call.
- A track's mission says what it means when no files are listed for the task.
- The board screenshots in the docs are new, and show the Checks, Decisions and Focus tabs.

### Fixed
- A merge of a task without `owned_files` now lists the files it changed.
- The warnings from a green merge step (ownership drift, dependency files) reach the owner. Before, they only went to the merge log.
- A track is no longer told that someone must set its project and feature. It runs without them.
- A time budget that runs out now stops the check's whole process tree, not only its shell. Check commands get no stdin.
- `vitest` could end a run with exit 1 and every test green when one long test blocked its progress calls on a busy machine. The longest test now lets them through. It can still happen on a very busy machine.

### Known limits
- `ravenseat merge` holds the merge lock while it waits for a slot, so other merges in that project are refused for that time.
- Runs waiting for a slot have no fixed order.
- The shared queue has been tested automatically and on Windows, but not yet in a real test round or on macOS and Linux.

## 0.8.25 (2026-11-06)

**A track can now propose work with only an id, a title and a mission, and the owner sees the proposal in `ravenseat show`.**

An existing project keeps its own copy of the mission template, so its tracks get the new instructions only after `ravenseat setup --overwrite` (it replaces your own edits in the copied files; `--dry` lists them first). Commit the result.

### Changed
- The mission now shows a track how to propose work outside its mission, also the `--file` form for Windows. Before, only one line in `CLAUDE.queue.md` mentioned it.
- A proposal from a track needs only `id`, `title` and `mission`. `domain`, `project` and `feature` follow the track and the class is K, unless the task sets them. A track that does database work should set `"class":"D"`, or the proposal counts as K, also for auto-accept when that is on.
- `ravenseat show` names up to 5 proposals with the track they came from, and `ravenseat proposals` lists all of them with their titles.
- The guard's list of allowed commands says `add` must run on its own, from the track's own branch, with no `cd`.

### Fixed
- A track was told to fix a missing project or feature with `edit-many`, a command it may not run. Now it is told there is nothing for it to do.
- The mission gave `gates --log` a folder name and called it a log folder, but `--log` writes a file, so a track failed when it tried to `cd` into it. The mission now says `gates.log`.

## 0.8.24 (2026-11-06)

**The plugin and its command are now called `ravenseat`. `cq` is gone, with no alias.**

### If you have the old `cq` plugin

A plain update does not work: `claude plugin update cq@ravenseat` fails with `Plugin "cq" not found`. The update banner in 0.8.23 suggests that command, so ignore it. As soon as the marketplace updates, `cq` fails to load and its hooks, the push guard among them, are off. Swap it in a terminal (add `--scope project` to the first and last line if you installed it for one project; your queue data stays):

```
claude plugin uninstall cq@ravenseat
claude plugin marketplace update ravenseat
claude plugin install ravenseat@ravenseat
```

Then open Claude Code in the project, ask it to run `ravenseat setup --overwrite --settings` (the command is only on the PATH inside Claude Code), and commit.

The explanatory `_` lines in your own `queue.config.json` keep the old name, which is harmless. Scripts of your own that call `cq` must be changed.

### Changed
- Renamed to `ravenseat`: the plugin, the CLI, the skills (`/ravenseat:queue`), the agents (`ravenseat:track`), the entry script and every text. A new CI workflow is written as `.github/workflows/ravenseat-gates.yml`. An existing `cq-gates.yml` is not recognised, so delete it if you run `setup --ci` again, or you get two workflows.
- All guards read the product's name from one file (`lib/productNames.js`), and a test fails when a command in `plugin/bin/` is not listed there.
- A track may now add proposals with `ravenseat add` from its own branch. Never with `--approved`, it always becomes a proposal, and at most 3 can be open per track. Elsewhere, or moved with `cd` or a `QUEUE_` variable, it stays denied.
- `requirements*.txt`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle(.kts)` and `composer.json` now count as dependency files: they stop in full and warn in lite.

### Fixed
- `ravenseat init` in a repo without `main` (a repo on `master`) left the base branch at `main`: `show` said a task could start, and `fill` failed. Init now writes the current branch. A base branch in the config, or an existing `main`, is left alone.
- `ravenseat init` now also adds `.claude/worktrees/` to `.gitignore`, so an open track no longer shows as untracked in `git status`.

## 0.8.23 (2026-11-06)

### Added
- `cq checks` and a Checks tab on the board: what the project has for checking its code (CI files, triggers and jobs, each
  kind of check and where it runs) and prioritized suggestions as cards. Files are only read, nothing is run. A button
  adds one investigation task that ends in a plan, never in code. Each suggestion is a template file, and a project can
  add, replace or remove them in `docs/queue/checks`. Turn it off with `cq checks off`, on the tab or in Settings.
- `dependencyFiles` in the merge guard. It warns in lite and stops in full.
- `identity.allow` accepts a listed address.

### Changed
- `gitSurface` warns in lite and stops in full, so a first try does not stop where it should not.
- A forced push of a branch in `push.allowBranches` asks first. The base, other branches and agents stay denied.
- Commits outside the queue are one neutral line and exit 0 in push mode owner. They still stop in threshold.
- The `ci-cost` lines show only with `cq doctor --all`, and doctor says when the secret check is off.
- `cq setup --overwrite --dry` lists only files that would change, and says how many are already up to date.
- The cleanup after a track says `Shared folders in the main tree, unchanged` instead of a raw fingerprint.
- `cq decide` headings name the problem, and `cq show` says when setup is behind.

### Fixed
- The push guard now also reads the Monitor tool, quotes or a backslash inside a word (`g"i"t`, `g\it`) and brace lists
  outside quotes. It is still no security boundary, and the docs name what it cannot read.
- `cq finding` stopped with `Which project?` in a project with no projects registered, and an agent could not fix that.
  The first finding now creates a project called `general`.
- A task in review with an open round is no longer aged or called `DELIVERED` by `cq takeover`. A hung agent in such a
  round gets `SILENT`, and an earlier round's report does not turn that off.
- The fix round line says to free the branch when a note says it is held.
- `cq show` refuses `--json`, and `edit` on an unknown id says so.
- `--over-load` is only offered when it helps.
- The Waiting on you panel follows Seen on the Decisions tab.
- Tasks in review or proposed are not an empty queue for the mascot.

## 0.8.22 (2026-11-05)

### Added
- `cq wait` checks the tracks every 5 minutes (`--check-min`, 0 = off). A track no agent took, or a silent one, gives
  `TRACKS NEED A LOOK` and exit 11, once per finding. The check costs no tokens.
- `ROUND WITHOUT AGENT` in `cq show` and the pulse: a round from `cq resume` that no agent started after 15 minutes, with
  the command to run. `cq decide` and the board get a card, and `cq takeover` says `NO AGENT`. It needs a client with
  hooks and a start row in the time log, so a project without the hook gets no false warning.
- A track silent for 60 minutes gets a card in `cq decide` and on the board.
- `cq guidance quiet`, also on the board and asked in setup: stops advice about CI, gates and lockfiles, the light
  review, intake triage and gate proposals. Guard stops still apply.
- `push.allowBranches` for pull request flows. Agents still never push, force and delete stay denied, and the secret
  scan runs.
- `cq show` and `cq decide` list tasks waiting on a cancelled task.

### Changed
- The merge guard has a floor that `protectedPaths` cannot remove: the queue config, `.claude/`, git hooks, `CLAUDE*.md`
  and the queue scripts.
- `git push --tags` is denied like a named tag.
- `cq fill --ids` says why a task cannot start.
- `cq takeover` says when `DELIVERED` rests on commits without a report.
- `ci-cost` in `cq doctor` is INFO.

### Fixed
- An owner's answer on the board wakes `cq wait`. Before, the orchestrator slept on while the round stood ready.
- A report from before the start no longer turns off `STARTED WITHOUT AGENT` and `SILENT`.
- `baseGate.enabled: false` gave a FAIL in `cq doctor`.
- `cq push-check` ignored `controlsWarning`.
- A declined check counted as missing on the board.
- The guide contradicted the secret scan.

## 0.8.21 (2026-11-05)

### Changed
- `cq resume` frees the branch itself when it continues a PARTIAL delivery and the old worktree is clean. A fix round
  still gets the advice, since it may be fixed in that worktree.
- The `cq takeover` warning about another orchestrator says what it saw, so you can tell when it was your own command.
- `cq receive` mentions an approved review in its merge line only when a review starts.
- `cq add` names the usual wrong field names (`minutes` is `content_min`), and `cq edit` names a flag it did not
  understand when nothing changed.

### Fixed
- A base fix task nobody has started is cancelled when the base goes green, so the next fill does not start an agent on
  nothing. A started task, or one the CI watch added, stays and is pointed out.
- The owner's answer stays first in the brief when the same round is written again with `cq resume`.
- With an open track question, `cq receive` and `cq merge` name `--answer` in their next step.
- An answer to a track counts in `cq decide --today` and under Decided today on the board.
- A continuation without a handover no longer tells the agent to work from one.

## 0.8.20 (2026-11-05)

### Added
- `cq show <id>` shows that task, the same as `cq info <id>`.

### Changed
- The board's push line gives the same verdict and reason as `cq push-check`, also for external commits, a remote ahead of
  the base and a missing full gate.
- The guards no longer read text as commands when a quoted heredoc only writes it to a file or a commit message
  (`cat > file <<'EOF'`, `git commit -F - <<'EOF'`). Anything that could run the text is still read.

### Fixed
- `cq set` no longer makes an orchestrator whose time ran out look alive, and `cq takeover` does not warn about one.
- The board's answer buttons are named for what they do, and its two counters agree. An answer in its undo window or a card
  marked Seen leaves both, and the Decisions tab says when `cq decide` still lists something.

## 0.8.19 (2026-11-05)

### Added
- A track's question can be answered: `cq resume <id> --reason context --answer "<text>"`. It is the recommended option in
  `cq decide` and on the board. The answer leads the new agent's brief and stays for later rounds.
- `cq edit <id> --files a,b` sets the files a task owns.

### Changed
- `cq merge` stops on a PARTIAL delivery unless you pass `--allow-partial`, and `cq receive` no longer shows the way to merge one.
  The next round delivering DONE clears the stop.
- `cq edit` with nothing to write is an error instead of printing `changed:`.
- A `GATE` line or `cq gate` with a long failure class keeps the whole class in the mission. Only the title is cut.

### Fixed
- A worktree the agent detached when it delivered is found: cancelling names it, `cq cleanup-worktree --abandon` removes it,
  `cq merge --resume` tidies it and `cq doctor` lists it.
- When nothing can start, `cq fill` says which tasks hold the slots. It shows held-back tasks also when the machine is full,
  and names the file the task owns rather than git's folder.
- `cq setup` leaves `settings.json` alone when nothing in it changes, and names what is uncommitted.
- A block left open on a cancelled task no longer counts as open or grows.
- A continuation made twice with no agent between counts as one round, and a brief after a red gate no longer points at
  a review package that was never written.
- `cq <command> --help` shows the help for queue commands instead of running them.
- Clearer texts for merge conflicts, a red base, the git identity warning and changed files.

## 0.8.18 (2026-11-04)

### Added
- The first push is scanned for secrets, since no earlier push has checked what is in the history.
- `cq cleanup-worktree <branch> --abandon --execute` removes the worktree of a cancelled task. The branch and its commits stay.
- A `GATE` line can name its place: `GATE <failure class> @ <file:line>`.

### Changed
- A migration from a task that does not own it stops the merge.
- `cq decide` recommends declining a gate task with no file and line behind it, since the gate needs a failing example.
  `GATE` lines from an older mission template have no place, so they get this advice too.
- Nothing counts as running long before 30 minutes, and a task in review does not count as stuck while the base is red.
- After a merge, merged `worktree-agent-*` branches with no worktree are deleted.

### Fixed
- Output that is not a terminal is no longer cut, and `cq decide` keeps its whole lines in a terminal too.
- A track's owner question no longer stays in a file nobody opens: `cq receive` shows it, also with no commits, and opens a card in
  `cq decide` and on the board. `cq receive` also says when a delivery is PARTIAL, and when its commit count is wrong.
- `cq add` warns when a mission names a protected path it does not own, and the track delivers PARTIAL with a question
  instead of stopping late.
- A fix task from the base gate or CI watch starts even when tasks in review fill the slots. Hard stops still apply.
- `cq doctor` and `cq setup` say when the project's mission template, docs or status line differ from the plugin. The
  fix is `cq setup --overwrite`, which replaces your own edits in those files.
- `cq takeover` without a queue says to run `cq init` instead of crashing.
- `cq fill`, `cq show` and `cq decide` name a task held back by an uncommitted file, and `cq setup` says what to commit
  and that `cq init` comes next.
- The fix round after red quick gates names the gates and shows their output. A `cq resume` right after `cq receive` is the
  same round and counts once. `cq resume` warns about an unfinished merge in the main tree.
- `cq decide` advises putting a task started without an agent back in the queue, on the board too.
- `cq merge <id> --resume` on a done task removes what an earlier cleanup left. `cq set <id> cancelled` says what stays and
  how to drop it. `cq doctor` lists every leftover branch, and gives its own advice for one that still has a worktree.

## 0.8.17 (2026-11-04)

### Fixed
- `cq merge --resume` left the worktree and the branch when the project path had another spelling than the one git prints,
  such as a link or a short Windows path. The cleanup now compares real paths.

## 0.8.16 (2026-11-04)

### Fixed
- `cq setup` wrote `main` and `npm run lint` from its template. It now reads the branch and the checks from the project,
  and `cq doctor` names a branch or a gate script that does not exist.
- Merge stops and a red base reach the owner: each stop has its own code and its own text in `cq decide` and on the board,
  and only real conflicts count as conflicts. A green `cq receive` closes `gate-red`.
- A whole `cq merge` removes the worktree and the merged queue branch, also at `--resume`. `cq doctor` names merged agent
  branches that are left behind.
- `cq cost` counts an undone merge as a defect, and only fix rounds that really ran.
- `cq setup` writes the plugin's absolute status line path to `.claude/settings.local.json`, and moves an old one there.
- `cq doctor` and `cq fill` warn about a git identity `cq merge` will refuse, before the agents spend tokens.
- `cq push-check` no longer fails before the first push. It says that is normal and what comes next.
- `cq setup` adds `.env`, `.env.*` and `!.env.example` to `.gitignore`.
- `cq receive` on a branch without commits no longer guesses that the work was merged. It says the task stays as it was,
  and names the next steps.
- A cancelled task closes its open block.
- `cq mode` changes one word. `push.mode` no longer made it rewrite the whole config. It also says to commit the file.
- `cq takeover` warns about another orchestrator only with a cursor or a running task, not after setup or `cq add`.
- `cq kickstart` says only what it knows about CI: the config exists, not what it runs.

### Added
- `cq add --depends a,b` in lite mode. An unknown id is refused.
- `cq add` warns when a task owns a protected path, since that lets its changes past the merge guard.
- `cq receive` names `--scratchpad` in its merge line when `cq merge` would not find the folder itself.
- The guide says what `--scope project` limits.

## 0.8.15 (2026-11-04)

### Fixed
- Track agents could not write their report. Claude Code refuses subagents a file named `report.md`, so reports, the
  `GATE` line and the sections read from them were lost. The file is now `track-result.md`, and a `report.md` is still
  read. `cq receive` also reads the `GATE` line from the agent's answer, and warns when the file is missing.
- `cq merge` merged what `cq receive` had just stopped. It now refuses while the quick gates are red from the last
  receive: a fix round on the same commit, a new `cq receive` after new commits. `--force-red-gate` overrides, on the
  owner's word, and is logged as `gate-red-overridden`.

### Changed
- Track missions name `track-result.md`, and say what to put in the answer if the file is refused.

## 0.8.14 (2026-11-04)

### Added: checks you can add one step at a time
- `cq kickstart` shows what the project has and one next step in plain words: git, gates, secret files, then CI. It reads
  only, and works before `cq init` and without git. `/cq:kickstart` explains it for someone new to all of this.
- `cq kickstart gates --apply` sets the checks your project already has as gates, never over gates already set. It reads
  Node/TypeScript and Python. The skill reads other stacks itself.
- `cq kickstart add` proposes a step as a task. It starts only when you approve it, and it uses tokens like any other task.
  A step you cancel stays declined.
- The board shows the same steps under Settings, with a short line in the status bar while something is missing.

### Added: known bugs can become gates
- A bug that can happen again becomes a gate task, from a line `GATE <failure class>` in `report.md` or from
  `cq gate "<failure class>"`. `gates.fromKnownBugs` chooses `propose` (default), `auto` or `off`. `auto` uses tokens
  without asking.
- At most three gate tasks are open at a time. A bug stopped by that limit is not saved: the message names it and asks you
  to approve or cancel an open task first. The same class again adds the new place to the open task, and a class you
  cancelled is not proposed again.

### Changed
- The hints about missing checks now point to `/cq:kickstart` instead of `/cq:setup`.
- Track missions have a new paragraph about the `GATE` line.

### Fixed
- `cq init` and `cq setup` stop outside git in a plugin install and say to run `git init` first. They used to write into
  the plugin's own folder.

## 0.8.13 (2026-11-04)

### Changed: a project with no checks now hears about it
- The push guard asks before a plain push of the base branch when the project has no CI config or no gates, also on a
  first push. It says what is missing and how many commits go out, and points to `/cq:setup`. It never blocks.
  `"push": { "controlsWarning": false }` turns the question off. CI is detected by its config file, which does not prove
  that it runs on this push.
- A K task in such a project gets a short agent review (`reviewer-light`): plain misses against the mission, secrets,
  access and injection. This uses tokens. `cq helpers` shows what it has cost, and `cq helpers off reviewer-light` turns it
  off.

### Added
- `cq receive` says `NO CHECKS RAN` when there are no quick gates and no done command.
- `cq merge` records a verification status on the task: verified (your gates or done command passed), audited (only an
  agent review ran) or unverified (nothing ran). A review alone never makes a task verified.
- Cards on the board show **Merged, not verified** or **Audited**, and the detail panel shows the status. Tasks merged
  before this version have no status.
- `cq push-check` names the missing controls.

### Fixed
- Mission text is the same on every platform. A Windows checkout of the mission template left one extra blank line in
  track prompts, and the Ubuntu CI jobs for 0.8.12 failed on it. The difference was whitespace only.

## 0.8.12 (2026-11-04)

### Changed: check this if a check needs a token
- Gates, `done_when`, the base gate and `qa auto` now run without tokens, cloud keys and variables that point to the
  queue's data folder. Variables are dropped by name (such as `GITHUB_TOKEN`, `*_API_KEY`, `AWS_*`, `SUPABASE_*`), the
  rest are kept, and no setting lets a dropped one through. A check that reads one from the environment fails until it
  gets the value another way. This guards against accidents and simple cheating. It is not a sandbox.
- `cq receive`, `cq merge` and the push check compare git hooks and git config that run code against an accepted
  baseline, and stop if they differ. The first run accepts what is there. After installing husky or lefthook, or
  changing a git alias, run `cq surface accept --by owner`.

### Added
- `gitSurface` in `queue.config.json`: `stop` (default), `warn` or `off` for the baseline check above, for repositories
  where it gives too much friction.
- `cq surface` shows each difference against the baseline, with the full path of a hook and the file a setting comes
  from.
- `cq unlock` shows who holds the queue lock, and `cq unlock --force --by owner` releases it.
- `cq attempt list <id>` and `cq attempt close <id> --outcome <...>`: each start of a task is now a recorded attempt, and
  a running attempt blocks a new one until it is closed.
- Gate evidence entries say what they covered (runner, shared links, untracked and ignored files).

### Fixed
- A hook planted during a gate run made that run red, but a rerun could go green. A hook written outside a gate run was
  never seen. Both now stop against the baseline.
- Only the orchestrator writes gate evidence, per commit and gate setup, and a run that changes the evidence store is
  recorded red. Base health reads only this trusted evidence.
- The queue lock has an owner: a live holder on the same machine is never taken over, and a holder that lost the lock
  can neither publish nor remove it. `cq doctor` uses the same rule, so it no longer calls a live holder stale.
- The command notes in `queue.mjs` describe the actual fields in `queue-fill.json`.
- The test run ended with exit 1 although every test passed ("Timeout calling onTaskUpdate"). The 0.8.10 explanation was
  wrong: the cause is `spawnSync` blocking the test worker past vitest's 60 s limit, not the number of workers. The event
  loop now turns after each test and inside the two longest tests. This reduces the error but does not remove it: on a
  heavily loaded machine a run can still end with one such error.

### Internal
- Fill, start and resume build a client-neutral mission description, and the Claude Code format comes from an adapter.
  Compatibility snapshots check that the Claude output is unchanged. This is groundwork for other clients: no other
  client is supported yet.

## 0.8.11 (2026-11-03)

### Fixed (found by the first CI run)
- `cq init` now adds the data folder to `.gitignore` also when the project path is a Windows short name
  (`C:\Users\RUNNER~1\...`) or goes through a symlink; real paths are compared. Before, nothing was added.
- The bench path check uses the path rules of the platform it is asked about, so it gives the same answer on Linux.
- A test of file times allows the sub-millisecond rounding Linux file systems give.

## 0.8.10 (2026-11-03)

### Added
- CI for Ravenseat itself: the full test suite on Linux and Windows with Node 20 and 22, on every push to `main` and
  every pull request. Actions are pinned by commit SHA, the workflow has read-only access. Badge in the README.

### Fixed
- The test run could end with exit 1 although every test passed ("Timeout calling onTaskUpdate" on a busy machine):
  vitest now uses half the cores.

## 0.8.9 (2026-11-03)

### Fixed
- Docs now match the code on security: deleted tests and skip markers give a warning at receive, not a merge stop;
  the secret scan covers each commit in a base-branch push from Claude Code, with its known gaps listed (first push,
  over 2 MB, timeout, fail open); the quarantine rule is described as a recommended pattern, not a control.
- Stale code comments in `shellCommands.js`, `configGuard.js` and `secretScan.js`.

## 0.8.8 (2026-11-03)

### Changed
- README reorganized and cut to about half: the product promise, Quick start before the diagrams, two infographics
  (task flow, and Claude Code plus the optional board), decisions in one place, "Agents don't grade their own
  homework", a lite vs full table, one cost number with its caveats, and who it is for.
- New docs pages for what left the front page: `full-mode.md` (classes, helper agents, focus, guards, load guard,
  recovery), `costs.md` (the token measurements), `commands.md` and `why-i-built-it.md`. The board tour moved to
  `board.md`, the architecture infographic to `orchestration.md`, and the sandbox caveat to "Guarantees and limits".

## 0.8.7 (2026-11-02)

### Changed
- README: chat-first hero and Quick start in plain words ("set up the queue", "start the queue", "what is waiting on
  me?"), a note that phone access uses Claude Code's Remote Control, and red checks described as "your configured
  checks fail before a merge".
- README: a contents line, a "Who it's for" section, "What it gives me now" folded into `<details>`, the class letters
  K, U, D and D+ explained, and K's review listed as "your gates (no reviewer agent)" with what that means when no
  gates are set up.
- README: "every board action has a command" narrowed to every change the board makes to the queue (CLI parity lists
  the one remaining gap).

## 0.8.6 (2026-11-02)

### Changed
- New board screenshots from the demo project, showing the 0.8 board with the Decisions tab.

## 0.8.5 (2026-11-02)

### Changed
- README: four main points instead of six ("parallel work that stays out of each other's way", with `cq conflicts`),
  the guarantees table moved to the guide (`#guarantees-and-limits`), and the "Ken sent me." line removed.

## 0.8.4 (2026-11-02)

### Changed
- `cq init` adds the queue data folder to `.gitignore` (only in a git repo, only when not already ignored).
- README: a shorter quick start (decisions through `/cq:decide`, details moved to the guide) and a "when something
  fails" line above the loop.

## 0.8.3 (2026-11-02)

### Changed
- README: opens with autonomy ("Your agents keep building. You make the decisions."), shows the self-correcting
  loop, a simpler quick start without internal commands, and a local-first line (no hosted service, no new CI).

## 0.8.2 (2026-11-02)

### Changed
- README: quality you can check up front, `cq setup --ci` explained, merge recovery, and a table of what Ravenseat
  checks versus what needs a boundary outside it, with the known gaps in the command guard.

## 0.8.1 (2026-11-02)

### Added
- **`cq merge` survives interruptions:** one merge at a time (`merge.lock`, stale-lock takeover), a refusal while git
  has a merge, rebase or cherry-pick in progress, a check that the track tip is in base before `done`
  (`merge_commit` stored on the task), and `cq merge <id> --resume` to finish the remaining steps after Ctrl-C, a
  crash or a stop.
- **queue.json.prev** keeps the previous good queue state on every write, and the rename is retried on Windows
  EPERM/EBUSY/EACCES. A broken queue.json stops the CLI with the way back, and `cq doctor` names it too.
- **More secret rules:** JWTs, Supabase `sb_secret_`, npm, SendGrid, Hugging Face, DigitalOcean, Google OAuth, GCP
  service accounts, URIs with passwords and `.env` value lines, and cloud key names in the generic rule.

### Fixed
- A `queue.config.json` that exists but does not parse no longer runs on the defaults: the CLI stops with
  file:line:column and a hint (`cq doctor` and `cq help` still run), and a BOM is accepted.
- The secret precheck scans every pushed commit (`git log -p`), not only the net diff.

### Changed
- `protectedPaths` also covers `.husky/`, lefthook, `.npmrc`, `.yarnrc(.yml)`, `.pnpmfile.cjs`, `.vscode/`,
  `.gitattributes`, and `CLAUDE.md` / `.claude/` at any level, and the match ignores case.
- **Queue agents are locked down:** tracks, reviewers, helpers, `ask` and `reviewer-area` can no longer push in any
  form, and may run only an allow-list of queue commands (no merge/set/edit/approve/resolve/undo, no `--allow-guard`,
  `--force` or `--by owner`). `owned_files`, `shared_patch`, `owner_db` and `migr_block` are locked after start like
  `done_when`. The push guard reads nested commands (`bash -c`, `pwsh -Command`, `cmd /c`, `&`, `( )`, `$( )`,
  backticks, `eval`, `git -c alias.*`) and asks or denies when it cannot. Deleting the base on the remote is denied
  for everyone. A broken config makes the hook ask before push, migrate and deploy.

## 0.8.0 (2026-11-02)

### Added
- **Transcript metrics:** per-model cost with a price table per family (Opus, Sonnet, Haiku, Fable; `prices`
  override), tool calls and errors, API errors, active time (`metrics.idleGapMin`), and killed agents measured from
  their transcripts; shown in `cq cost`, `log-time --cost` and the Statistics tab.
- **Safety baseline:** `cq doctor` checks secret files, empty gates, missing CI, lockfiles, `productionBranch` and
  large files; the push guard scans what a base-branch push sends for secrets (gitleaks or built-in patterns) and
  asks before `deployCommands`; `cq setup --ci` offers a GitHub Actions template that runs your `gates.quick`.
- **`cq wait`:** a background waiter the orchestrator starts when only owner items are left. It exits with
  `OWNER ACTED: <action> <ids>` when the owner answers, approves, does QA, adds or edits on the board (exit 10 on
  `TIMEOUT` after 8 h), so a board answer starts the next round. "Waiting on you" on the board says "Orchestrator
  listening" while it runs.
- **Event rows in the time log:** the orchestrator session's cost (status line, compaction and SessionEnd hooks)
  shown as orchestration overhead in `cq cost`; fix rounds, merge conflicts, base gate verdicts, triage verdicts and
  pushes as a Flow view in `cq cost` and the board's Statistics tab (first-pass rate, fix rounds per task, conflicts
  and pushes per week); a load row per fill/start with a Load history in `cq limit`.
- **Done lock and acceptance criteria:** `done_when` and the new optional `acceptance` criteria
  (`cq add/edit --accept`) are locked once a task starts: only `--by owner` or the board may change them, never from
  inside a track worktree, undo included. The mission lists them as "Acceptance criteria (fixed, do not change)",
  `cq info` and the board's detail panel show them, and reviewer-gap answers MET / NOT MET / UNCLEAR per criterion
  (NOT MET is a HIGH finding).
- **Guard tests:** the merge guard protects the test, lint and type configs by default (glob entries in
  `protectedPaths`: vitest/jest/playwright/cypress/karma/mocha configs, tsconfig*.json, eslint/biome, pytest.ini,
  tox.ini, setup.cfg, conftest.py, pyproject.toml, mypy.ini, .coveragerc, .flake8, .golangci.*, Cargo.toml,
  Makefile/Justfile, .pre-commit-config.yaml, phpunit.xml*, .rspec). `cq receive` warns about test weakening
  (deleted test files, test files moved out of the test paths, added skip/focus markers) with one WARN line and a
  Test weakening section in 00-package.md (`testWeakening.enabled`, `testPaths`, `markers`).
- **Quality figures:** right first time, post-merge defects and owner interventions per 10 merged, autonomy
  (verified tasks per owner intervention, longest stretch without the owner, failures corrected without the owner),
  reviewer hit rate per type with a "0 fixes in N runs" hint, and inflow by source with a 3-week growth hint, in
  `cq cost`, `--json` and the board's Flow box. `cq finding --cause <id>` and `cq resume --from <reviewer,...>`
  record the links.
- **`/cq:review <area> [<lens>]`:** review a path, feature or project through a lens (security, logic, ux,
  architecture or free text) with read-only Opus `reviewer-area` agents. Every finding gets file:line, severity and a
  class; after one owner question, one-off bugs become fix tasks, repeatable mistakes become `gate` tasks that add a
  red-first check to the project's own CI, and design questions become owner questions or plan entries. The review
  is recorded as a `PL-REVIEW-…` plan entry.
- **Decide or ask:** tracks fix technical failures themselves and ask the owner only on unclear requirements,
  hard-to-reverse choices (data model, public API, new dependency, deletion) and security or legal tradeoffs; other
  assumptions go in a new "Assumptions" section of report.md.
- **Gate evidence bound to the sha:** `cq receive` no longer trusts the track's `RESULT gates=` line or its gate rows
  in the time log. It needs a green, clean quick-gate run on exactly the delivered tip, recorded by `gates.mjs` for
  the orchestrator in `gate-evidence.json`, and otherwise runs the quick gate itself in the track's worktree (red:
  fix round, exit 1/8; dirty or missing worktree: refused, exit 1). The base gate's skip rule reads the same store.
  `push-check` is BLOCKED and the push guard asks when the tip has no green `cq gates --full` run from the main
  checkout. Queue agents may not pass `--evidence`/`--cwd` to the gate runner or touch the store.
- **Focus end:** when every focus stage is done or the focus period is over, the queue no longer continues silently.
  With `focus.continueWhenEmpty` off (the default) fill starts nothing, `focus.finished_at` is recorded, and one
  owner question "Focus X is done: set a new focus or continue the regular queue?" appears in Waiting on you;
  answering "Continue the regular queue" lifts the pause. On keeps the old behavior with one notice line. Per focus:
  `cq focus set ... --continue-when-empty on|off`; `cq focus` and `cq doctor` know the setting.
- **`/cq:decide` and `cq decide`:** one list of everything waiting on you, most impact first, with the board's new
  Decisions tab (the landing view when anything waits; one-click answers with undo; keys j/k/Enter/1-4/u).
  `approve` and `qa ok` record `--by owner`. The Cloud tab is hidden by default (`board.showCloud`,
  `cq board-setting cloud on`). The Focus view sets what happens when the focus is done and shows FINISHED /
  QUEUE PAUSED. `docs/cli-parity.md` maps every board action to its command.
- **CI watch after a batch push:** `push-check --watch-ci <sha>` (`push.ciWatch: "github"`, default off, needs gh).
  A failed check gives one fix task `CI-<sha7>` and a red base (exit 9); an infrastructure failure gives an owner
  question and no freeze; a timeout exits 10. Only a redacted tail of the failed log is kept.
- **Flaky check before freezing the base** (`baseGate.flakyRerun`, default on): a red base gate reruns only the
  failed commands once on the same sha. Green is recorded as flaky (a finding, a `flakyGate` row in `cq cost` Flow)
  and does not freeze; red twice freezes.
- **Write guard hook** (`hook-write-guard.mjs`, Write|Edit|NotebookEdit): queue agents can no longer write the gate
  evidence store or the queue's `queue.json` and `base-health.json` with the file tools.
- **Review fixes (package E):** the context hook counts compactions incrementally (only the new transcript tail is
  read, cached in `compact-count.json`); worktree cleanup deletes without a shell (paths with `&` are safe);
  `cq doctor` warns about a leftover MERGE_HEAD, `disableAllHooks` in Claude settings, and done tasks whose merge is
  missing from the base branch.
- **Conflict prediction:** `cq orchestrator pulse` and the new `cq conflicts [--json]` check running and delivered
  track tips against the base and each other with `git merge-tree --write-tree` (cached per sha pair,
  time-budgeted, with a suggested merge order; git older than 2.38 falls back to file overlap and `cq doctor` says
  so). A real conflict in `cq merge` names the files and the other tasks that touched them in the fix round brief.
- **`cq ask <id> ["<question>"]`:** answer a question about an earlier track without resuming its agent. It builds a
  size-capped, secret-redacted bundle (mission, report.md, handover.md, queue notes and owner answers, commits and
  diffstat, transcript tail); `--bundle` writes it for the new `/cq:ask` skill and read-only `ask` agent, `--json`
  describes it.
- **Gate from incident:** after a post-merge defect, a red base or an owner-found bug, the orchestrator proposes a
  `Gate: <failure class>` task when the class is repeatable. Gate tasks are red first: the check is shown failing on
  the original bug and passing on the fix, both runs in the report.

### Changed
- README: parallel chats colliding (push and file conflicts) added to the pain points; "What the guards are not"
  (guard rails, not a sandbox) in the safety baseline; the board as the interface, orchestration as the product.

## 0.7.0 (2026-11-02)

### Changed
- **New name: Ravenseat.** The repo is now `vegardjorg/ravenseat` and the marketplace is `ravenseat`; the plugin is
  still `cq`, so `/cq:queue` and every `cq` command stay the same. The update banner, the docs and the install lines
  use the new name. **Moving an existing install:** `/plugin marketplace remove claude-code-queue`, then
  `/plugin marketplace add vegardjorg/ravenseat` and `/plugin install cq@ravenseat`. Your queue data is not touched.
- **The Ravenseat logo** (two ravens on the high seat) is the board's default picture; the raven on the right does the
  talking. The mascot is a switch under **Logo and mascot** in the gear. The README opens with the logo.

## 0.6.0 (2026-11-02)

### Added
- **Intake triage:** a cheap read-only `triage` helper checks tasks that waited `triage.minAgeDays` (3) days or were
  added by an agent before a track starts. `cq fill` skips them, prints the triage step in the same turn and keeps
  starting the others. `cq triage <id> --verdict ready|done|stale|adjust` records the answer: adjust adds the note to
  the mission, and done and stale become an owner question with choices, never an auto-close. Off with
  `cq helpers off triage` and in lite mode; the board shows its cost and verdicts.
- **Base gate:** `cq merge` records the base branch's health per tip after each merge (the quick gates by default,
  or `baseGate.commands`). A red base refuses further merges (exit 9, `--force-red-base` is logged), adds a value-10
  fix task `<id>-BASE<n>`, and shows in `cq show`, the pulse and the board status line. Gate rows now carry the sha
  and whether the tree was clean, and `gates.mjs` takes `--timeout-sec`.
- **Push threshold:** config `push` (`mode` owner or threshold, `minTasks` 10, `warnTasks` 50, `maxAgeHours`) counts
  merged tasks since the last push. `cq push-check` prints the batch and READY, NOT YET, BLOCKED, LARGE or NOTHING;
  the push guard asks before a plain base push below `minTasks` or on a red base (it never denies); `cq doctor`
  checks the push keys and warns about push workflows without `concurrency` `cancel-in-progress` or path filters;
  the board's status line shows the batch.

## 0.5.0 (2026-11-02)

### Added
- **Choices on owner questions:** a question can carry 2-4 answer options (`choices`):
  `cq question <id> --choice "..." --choice "..."`, answer with `cq resolve <id> --choice <n|text> [--answer "note"]`
  or one click on the board's "Waiting on you". The choices are listed numbered in `cq question`, `cq resolutions` and
  the after-compact summary.
- **Done command and fix-round cap:** a task can name a done command (`done_when`). The mission states it, `cq receive`
  and `cq merge` run it in the track's worktree (budget `doneCheck.timeoutSec`, only the last `doneCheck.tailLines`
  lines are kept), and a red run gives a fix round instead of a review or merge. Fix rounds are capped per task
  (`maxFixRounds`, default 3, task field `max_fix_rounds`); at the cap the task becomes an owner question
  (`<id>.fixcap<N>`, blocker `owner-question`, exit 8).
- **Cost per task:** `cq cost` shows the cost per task including all its runs: fix rounds, continuations (`<id>-rN`)
  and the fix tasks that point to it. "USD per merged change" uses these totals, so a done fix task is counted with
  the change it fixes, not as a merged change of its own. `--json` has `perTask`.
- **`cq doctor [--json]`:** a read-only health check of Node and the `node` the hooks find, the hooks and their
  scripts, `queue.config.json`, the state files, a stale lock, half-deleted worktree folders, missing git worktrees and
  branches of finished tasks. Each line is OK, WARN or FAIL with a fix hint; exit 1 on any FAIL.
- **`cq finding "<title>" [--detail] [--task] [--files a,b]`** and `cq finding list [--all]`: a track reports
  something outside its scope as an idea in the plan register (`PL-FINDING-<n>`), linked to the task and
  deduplicated on the title. `orchestrator pulse` and `cq show` print the number of untriaged findings, and the track
  prompt tells tracks to use it instead of fixing.
- **Lite mode** (`"mode": "lite"` in `queue.config.json`, `lib/liteMode.js`): a zero-config mode with the core loop
  only. `cq add "<title>"` adds a task with just a title (optional `--mission`, `--priority 1-10`, `--files`, `--id`);
  the id (`T-001` ...), class K, value 5, size 30 min and the mission (the title) are filled in. Lite skips the
  small-task guard and the batch queue rules on `add` (a `batched` flag is dropped with a note), tasks run in the
  order added unless `--priority` is set, and `cq help` lists only init, add, show, fill, receive, merge and the owner
  questions. Owner questions work as before. Every other command still works when typed. The queue, parallel-wave,
  add-to-queue and setup skills have a short lite branch (`cq mode`). README: "Quick start (lite)".
- **`cq mode [lite|full]`** shows or switches the mode (writes only the `mode` key and keeps the rest of the file),
  and **`cq init --lite|--full`** does the same at init. A fresh `cq init` (no queue yet) without a flag writes
  lite when the config has no `mode` of its own; lite gets the project `tasks` (prefix `T-`). A config without `mode`
  is full, so existing installs do not change.
- **Model per agent**: `models` in `queue.config.json` (agent name to `opus`, `sonnet`, `haiku` or `fable`, e.g.
  `{ "reviewer-docs": "sonnet" }`). The start lines from `fill`, `start`, `resume` and `receive` then say `model=<m>`
  (also `model` in `queue-fill.json`), and the orchestrator passes it to the Agent tool. Empty by default (each agent
  file's model); an unknown value is ignored. Measure the effect with `cq cost`.
- **Gate rows in the time log**: every `cq gates` run (`--quick`, `--full`, `--precheck`) appends one `gate` row
  (track, branch, kind, gates, failed, duration, ok, exit, attempt, timed_out). `cq merge` passes `--track`; `attempt`
  above 1 is a rerun. Fail open.
- **Compaction rows in the time log**: `hook-after-compact.mjs` logs each main session compaction (scope `session`,
  with an `orchestrator` flag), and `hook-track-context.mjs` logs each new track compaction (scope `track`, with the
  running count).
- **`fixes` task field**: a fix task names the task id(s) it fixes. `add` and `edit` check that the ids exist,
  `cq info` shows `fixes` and `fixed by`, `cq state` lists open fix tasks as `fixLinks`, and `qa deviation` sets it.
- **The benchmark reads these rows**: gate runs and reruns per task, compactions per task and in orchestrator sessions
  (when the transcript shows none), and `fixes` links as defects after merge, whatever the defect window. It also reads
  cq's `added_at`.
- **Calibrated cost estimates** (`lib/costEstimate.js`): per class and class + size bucket, the median measured USD of
  done tasks in the last 28 days (at least 5), otherwise the static model corrected by the class's measured/model
  ratio, otherwise the static model. Shown as `~$x` next to the minute estimate in `show`, `show --full`, `next`, the
  `fill` lines and `info`, and as `costEstimate` in `state`. With `dailyBudget` set, `next` and `show` print a budget
  outlook line (information only; the guard still stops on measured usage).
- **`cq calibrate [--days 28] [--min 5] [--json]`**: per class n, the median actual/estimate ratio for minutes and the
  suggested weight, the median measured USD, the model's USD and the cost correction factor. Read-only.
- **USD per merged change**: all measured cost in the window (time log: tracks, reviewers, helpers, fix rounds,
  cancelled and open work, agents without a task) divided by the tasks that reached done. The first line of
  `cq cost` (window `--since`, default 28 days; `--json` too) and the first key figure in the board's Statistics
  (14 days). Per content minute is only a secondary, estimate-based figure.
- **Load-aware parallelism** (`lib/loadSlots.js`): `fill`, `next`, `start`, `show` and `state` open fewer than
  `maxConcurrent` slots while the machine is loaded, instead of all or nothing. All slots at or above
  `loadGuard.allSlotsFreeMemoryPct` free memory (default 40, off on macOS), `loadGuard.minSlots` (default 1) at the
  hard limit `minFreeMemoryPct`, linear in between, rounded down. CPU is optional (`allSlotsCpuPct` and
  `minSlotsCpuPct`, off by default). The commands print why (`LOAD: 2 of 5 slots: free memory 18 % (all slots from
  40 %)`), `state` has `loadSlots` and `cq limit` shows the slots now. `loadGuard.adaptive: false` or
  `QUEUE_LOAD_ADAPTIVE=off` turns it off; `fill --over-load` and `start --force` skip it. The hard load guard (exit 7)
  is unchanged. Why: a heavy user's data showed that with many parallel tracks the machine, not tokens, was the limit:
  the median gate time more than tripled from 1-2 to 3-4 running tracks, and most gate runs were reruns.
  `QUEUE_LOAD` also takes `cpu=<pct>`.

### Changed
- **The board client is split into modules**: the 7,300-line `queue-board/board.js` is now 17 classic scripts in
  `queue-board/board/` (core, api, cards, draw, views, menus, statistics, settings, inbox, panel, edit, select, bulk,
  interact, top, cloud, start), loaded in order with `defer` and sharing one scope. Pure move: the code is the same
  statement for statement, and the board looks and works as before. The server allow-lists each file by name; the
  Content-Security-Policy is unchanged. A new test (`queueBoardServe.test.ts`) checks that every file is served with
  the right type and the same CSP.
- **`queue.mjs` is split into modules**: the file of about 6,300 lines is now the usage comment and the dispatch on
  the command word, and the commands' code is in `scripts/orchestrator/cli/` (one module per area of 140 to 600 lines,
  the shared state in `cli/context.mjs`). The code was moved as it was: every command gives the same output, exit
  codes and files. A new test (`__tests__/queueDispatch.test.ts`) checks that every command word reaches an exported
  function.
- **`lib/queueLogic.js` is split into modules under `lib/logic/`** (about 7,350 lines into 22 modules of 100 to 670
  lines: base, projects, evidence, validate, conflicts, ranking, questions, commits, guards, batch, edit, focus,
  select, pick, external, cloud, agents, results, classify, merge, monitor, resume). Pure move, no behaviour change:
  `queueLogic.js` stays as a facade that re-exports exactly the same names, so every `require('./queueLogic.js')`
  keeps working. A module requires only the modules below it (no require cycles); the layout is in the header of
  `queueLogic.js`. `lib/__tests__/queueLogicFacade.test.ts` locks the export names and checks that each module loads
  on its own. The installer and the plugin copy whole folders, so the new folder ships without list changes.
- **The bench load sampler counts processes on Windows**: `tasklist` did not finish within the timeout on a loaded
  machine, so `processes` and `node_processes` came out null. It now uses PowerShell `Get-Process` (45 s timeout),
  with `tasklist` only as the fallback when PowerShell is missing.
- **Hooks run in exec form**: every hook in `hooks/hooks.json` and `settings.queue.json` is `"command": "node",
  "args": ["<root>/scripts/orchestrator/hook-x.mjs"]`, so Claude Code spawns node directly instead of through a shell.
  On Windows the shell is Git Bash, started on every call: with the PostToolUse hook on every tool call, this cuts the
  hook start by about 40 % (measured on a loaded Windows machine, 20 calls each, two runs: median about 1.9 to 2.1 s
  exec form against 3.3 to 3.4 s shell form). Tested live on Claude Code 2.1.316: the hook runs as a direct child of
  Claude Code (no bash.exe), `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are substituted in `args`, and the
  additionalContext of a synchronous exec-form PostToolUse hook reaches the subagent. `setup --hooks` / `install.mjs`
  rewrite the older shell-form queue hooks in `.claude/settings.json` to exec form (other hooks are left alone), and
  the board's setup check accepts both forms. Needs `node` on PATH as a real executable (`node.exe` on Windows).
- **The 400k block in other chats is opt-in**: chats that are not the orchestrator get the notice from 250k, but the
  message is only stopped at 400k with `contextGuard.blockOtherChats: true` in `queue.config.json`
  (`CONTEXT_BLOCK_OTHERS=1` overrides). The orchestrator's compact, wind-down and hard stop are unchanged.
- **The load guard is on by default**: `loadGuard.minFreeMemoryPct` is 10 (no new starts while free memory is below
  10 %), off on macOS, which counts the page cache as used. In one heavily used project, 14 parallel tracks made DB
  tasks take 165 instead of 34 minutes and gates go red from memory, not code. `cq limit minFreeMemoryPct off` turns it off for a queue.
- **The quota forecast and `cq forecast` price the queue with the calibrated estimate**: `capacity`'s queue cost and
  the forecast's expected cost sum the calibrated estimate per task (by class and size) instead of the static model or
  remaining count x one median. The order of the queue is unchanged (the priority still uses the minute estimate).

## 0.4.1 (2026-10-31)

### Added
- **`cq help` in groups, and "Did you mean"**: `cq help` prints 14 key commands in four groups (Get started, Daily,
  Owner, Orchestrator) instead of about 200 lines; `cq help all` prints every command with its full description (the
  old filter cut many off mid-sentence) and puts the internal scripts (make-queue-common, make-mission,
  cost-guard-statistics, context-measure, statusline) under "Internal"; `cq help <command>` prints one command in full,
  or a script's header. An unknown command prints `Unknown command "shwo". Did you mean "show"? See cq help.` (edit
  distance up to 2, or a prefix; nothing when nothing is close; exit code unchanged). The logic is in `lib/cliHelp.js`.
- **Forecast**: `cq forecast [--project <pid>] [--days 28] [--json]` says when the remaining tasks (the focus stages,
  otherwise all open work) are done at 50, 85 and 95 %, from a Monte Carlo over the daily throughput in the window
  (zero days included), with the sample size and the expected cost (remaining x median measured cost). "Not enough
  data" under 5 done. The board shows it as a box in the Focus view and a line in Statistics (`lib/queueForecast.js`).
- **Auto-accept of proposals** (default off): `cq proposals auto on|off [--classes K,U] [--max-estimate <min|none>]
  [--max-value <1-10|none>]`, `cq proposals log` and `cq proposals undo <id>`. A proposal that fits the rules is
  approved by `cq add` and `cq orchestrator pulse` through the approve path, with a remark and a log entry
  (`auto_accepted`). Never D or D+, `waiting_on`, legal/owner labels, a plan entry with open legal points or a
  protected path. Config default `proposals.autoAccept`; the board's gear has the switch, the rules and the log with
  Undo (`lib/queueProposals.js`).
- **Cancel, decline and edit from the board**: the detail panel has **Edit** (value 1-10, content minutes, class;
  checked like `cq add` / `cq edit`) and **Cancel task** for waiting tasks, and **Edit** and **Decline** for
  proposals (also in **Waiting on you**). Cancel and decline ask first, take an optional reason (saved as a remark)
  and show **Undo**. Running and review tasks are not cancelled from the board; the panel shows the CLI command
  instead of "No actions for this status". New `cq cancel <id> [--remark "…"] [--json]`: the same result as
  `cq set <id> cancelled --remark`, but logged in the changelog so `cq undo` puts the task back; `cq edit` takes
  `--answer-json`. The board posts to `/api/task-edit`; the rules are in `lib/queueTaskEdit.js`.
- **Started without agent**: `cq show`, `cq state` (`withoutAgent`) and `cq orchestrator pulse` warn about tracks
  marked running for more than 15 minutes whose branch no worktree has checked out and that have no report, with the
  fix (`cq set <id> waiting`, then `cq fill --ids <id>`). `fill` only marks tracks; when it ran where nobody read the
  output (a background `merge`, a chained merge script), tracks could stand for hours without an agent. The
  after-compact resume text names the check, and `merge` ends its fill excerpt with a note to use `--without-fill`
  when the output is not read.
- **Module switches**: `features` in `queue.config.json` (`plans`, `plans.legal`, `plans.launch`,
  `plans.documents`, `focus`, `statistics`, `cloud`, `follow`; one table in `lib/queueConfig.js`, helpers
  `features()` and `featureOn()`). The board hides the tabs, buttons, filter, detail row and routes of modules that
  are off, and the gear shows a read-only **Modules** section. `cloud*` and `follow*` commands answer "Cloud is off
  (features.cloud in queue.config.json)." (or Follow) with exit 0, and `show` and the pulse skip follow-up lines
  when follow is off. The plan register is never gated in the CLI.
- **First-run card**: a queue with nothing open shows three steps (add work, `/cq:queue`, "Waiting on you") and a
  link to the help instead of empty columns. README: "First run in 5 minutes".

### Changed
- **Off by default**: cloud sessions, follow-up entries and the Legal, Launch and Documents surfaces in Plans. Set
  `features.<name>` to `true` in `queue.config.json` to turn them on.
- `cq diagnose` and the parallelism paragraph (fill, receive, pulse) no longer say LOW PARALLELISM when nothing can
  start (the waiting tasks only wait on running work, a limit or a pause, and no finding would release one).
- **Silent tracks**: `cq show`, `cq state` (`silent`) and `cq orchestrator pulse` print `SILENT` for a running track
  whose agent has a worktree but has shown no sign of life (commit, worktree or track folder mtime, transcript or time
  log) for `limits.silentMin` minutes (default 20, `cq limit silentMin <n>`, 0 = off), with the advice to check it and
  `cq resume <id> --reason context` or stop it. The board marks the card "silent" (measured at most once a minute).
- **Blocker reasons**: `cq block <id> <code> [--note]` and `cq unblock <id>` record `blocks` on a task from one fixed
  code table; `cq merge` opens `merge-conflict` or `gate-red` when it stops there and closes it after the next
  successful merge. `cq blockers [--days 7] [--json]` gives count and blocked time per code, and the board's
  Statistics has the table "Blockers last 7 days".
- **Hiding the mascot needs no password**: **Hide the mascot completely** in the gear is a plain button now (still
  per browser; **Show the mascot again** undoes it).

## 0.4.0 (2026-10-31)

### Changed
- **The network guard covers reviewers and helper agents**: `curl`, `wget`, `iwr`, a pipe into a shell and an
  unknown `npx` package are now blocked (or asked about) for every reviewer and helper agent, builtin or custom, not
  only for `track` and `track-d`. The list is the read guard's (`queueAgentTypes`), also with the `cq:` prefix. The
  orchestrator is still not affected.
- `reviewers.U` is empty by default; the challenger for U now comes from `helpers` (same result, but it can be
  switched off). A config that lists `reviewer-challenger` under `reviewers.U` keeps it as a fixed reviewer.
- The read guard also covers `reviewer-challenger` and every helper agent in the setup.

### Added
- **Fail-fast precheck**: `cq gates --precheck` runs the cheapest checks first, in a fixed order, only on the files
  changed against `baseBranch`, and stops at the first red one. The checks are `gates.precheck` (commands or
  `{ name, command, files, budgetSec }`, with `{changed}` or `{file}`); the default `null` gives `node --check` on the
  changed JS files, `tsc --noEmit`, eslint on the changed files and the related tests (vitest or jest) when the project
  has them locally. A check with no relevant changed file is skipped, each check has a time budget
  (`gates.precheckBudgetSec`, 120 s; exit 3 over it), and `--json` gives a machine-readable summary. The mission
  template and the `track`/`track-d` agents run it before the class's full gate, which is unchanged.
- **Custom helper agents**: `cq helpers add <file.md> [--name] [--classes/--labels/--paths]` (or **Add a custom
  helper** in the board's Helper agents tab) copies an agent file to `.claude/agents/<name>.md` and registers it in
  `queue.json` as `source: custom` with its sha256, off. Nothing in the file is run, and a builtin name is refused.
  `cq helpers scan` (`lib/helperScan.js`) gives red, yellow or green with line numbers for the frontmatter tools and
  keys, calls out of the machine, prompt injection and misuse, hidden content and missing guards. The new `add-helper`
  skill has Claude read the whole file and ask the owner; `cq helpers approve <name> --by .. --sha256 ..` binds the
  approval to the hash (a red scan needs `--force`). A custom helper can only be switched on, and is only picked by
  `reviewersForTask`, while its file matches the approved hash; a changed file is turned off and shown as "Changed
  since approval". The board shows the custom badge, the scan, the review state and who approved it, and can never
  approve. `cq helpers when` changes the conditions and `cq helpers remove [--delete-file]` drops one. The read guard
  and the push guard cover custom helpers, and `merge-track` protects their agent files.
- **Helper agents**: optional reviewers on top of the fixed ones per class, switched with `cq helpers on|off <agent>`
  or the new **Helper agents** tab in the board's settings (saved in `queue.json`, which wins over the new `helpers`
  block in `queue.config.json`). Each runs when it is on and one condition hits: class, label, changed paths, most
  of the diff, a plan entry or the number of mission points. New agents `reviewer-design` (on for `visual`),
  `reviewer-tests`, `reviewer-gap` and `reviewer-docs` (off), adapted from testdouble/han (MIT, see NOTICE);
  `reviewer-challenger` moves into the same system (on for U and `bug`). The reviewers for a task are worked out in
  one place (`lib/queueHelpers.js`) and used by `receive`, the cost per task, the cost guard and the read guard.
  The review package lists each reviewer with a `why:` line and carries the mission as `mission.md`.
- **Helper measurement**: the cost per agent now keeps its tokens, minutes and FINDINGS numbers, so `cq helpers`,
  `cq cost` and the board show per helper the runs, median and total minutes, tokens and USD, its share of the task
  cost and findings per run.
- **Counter-evidence step in every reviewer**: a HIGH or MEDIUM finding is disproved first (reread, look for an
  existing guard or test, check that the change introduced it, lower it one level without ground). Security findings
  are lowered only on counter-evidence at file:line and carry an `EXPLOIT:` part; `Unverified:` lines and a
  self-consistency rule for all.
- **Update banner on the board**: the board server checks GitHub for a newer `cq` at most once per 24 hours (a plain
  GET with a short timeout that sends nothing about you; errors are silent) and shows "cq X is out (you have Y)" with
  a CHANGELOG link and copyable update steps. Close it per version. Off with `board.updateCheck: false` or
  `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- **Setup notice after an update**: `cq setup --settings` records the plugin version in `<dataFolder>/setup.json`,
  and the board says when the installed plugin differs from it (local, works with the check off). The vendored
  installer writes `scripts/orchestrator/cq-version.json` so the board knows that version too.

### Upgrading
Update the plugin, then run `cq setup --settings` once, and restart the session (or run `/agents`) so the new
reviewer agents are picked up.

## 0.3.0 (2026-10-30)

Fixes and features ported back from the queue in the project cq was split out of.

### Added
- **Status line** (`statusline.mjs`): context size, session cost, the 5-hour and 7-day quota and running tracks.
  A plugin cannot set a status line itself, so `cq setup --settings` writes it with an absolute path. Run it again
  after each plugin update.
- **Handover note in two parts** (`cq handover archive|now`): after compaction the orchestrator reads only the "Now"
  part; dated log entries older than 24 hours move to `handover-archive/<year-month>.md`.
- **Quota calibration from the status line**: `cq capacity --calibrate auto` uses the 7-day percentage the status
  line saw last.
- **Adopting running tracks**: a track's `report.md` carries the RESULT signal, so a new orchestrator chat can take
  over tracks that are still running. New commands `cq deliveries` and `cq resume <id> --reason fix|context`; the
  pulse prints NEW DELIVERY, and `cq receive` finds fix-round reports.
- **Migration blocks**: start, fill and pick skip blocks that are already taken; `cq migr move <id> <block>` moves a
  task to another block.
- **Load guard**: no new starts (exit 7) while free memory is below `loadGuard.minFreeMemoryPct` or
  `cq limit minFreeMemoryPct`. Off by default.
- **Focus clean-up**: `cq focus evaluate` and `cq focus clean` take done focus stages out (also automatic, and it can
  be undone).
- **Follow-up entries**: `cq follow add|log|show|report|close|extend` for something to watch over a period, with its
  own board page at `/follow`.
- **QA evidence**: tracks write an `EVIDENCE` line in the report; `cq qa evidence <id> <type>` sets it by hand, and
  `cq qa auto --run` closes entries whose automatic evidence is green. The types are in `config().qa`.
- **`plan check`** also shows index drift against the plan register (field `index` in `--json`).

### Security
- **Merge guard**: `merge-track` stops (exit 4) when a branch changes hooks, settings, agents, the orchestrator
  scripts or the queue config without owning them (`protectedPaths` in `queue.config.json`; `--allow-guard`
  overrides).
- **Network guard for tracks**: tracks cannot run `curl`, `wget`, `iwr` or a pipe into a shell.
- **Data, not instructions** in every agent file and the mission template, checked by `make-queue-common`.
- **Agent limits**: `maxTurns` 400/600 and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` in `settings.queue.json`.
- **Context guards after compaction**: a track that compacts twice or passes 280k stops as PARTIAL; a SubagentStop
  end gate (`hook-track-end.mjs`) stops a track once if it ends without a commit and without a RESULT line; pause
  advice above 150k.

### Fixed
- The plan room no longer shows a raw "null" text when optional parts are missing.
- The board builds the queue lookups once per board instead of once per card: with 3,000 tasks it went from about
  59 s to about 0.15 s.
- The fallback migration pattern in `queue.mjs` had lost its backslashes (the same bug as in `setup.mjs` in 0.2.1).

### Upgrading
Update the plugin, then run `cq setup --settings` once to get the new hooks and the status line.

## 0.2.1 (2026-10-29)
- Fixed the broken hook-path regex in `setup.mjs`, and every shipped script is syntax-checked in the tests.
