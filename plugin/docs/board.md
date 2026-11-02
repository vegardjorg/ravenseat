# The board (`queue-board.mjs`)

A local web board for the queue and the plan register. It reads the same JSON files as `cq` and writes through
the same functions (same lock, same validation, same undo), so the board and the chat never disagree.

```
cq board            # prints the link, e.g. http://127.0.0.1:2000/#key=… (port: board.port)
```

How to start it:
- **In Claude Code:** `/cq:board`, or ask Claude to start the board. It runs `cq board` in the background (never in
  the foreground: it is a server and would block the chat) and gives you the link. It stops with the session.
- **From your own terminal** (keeps running on its own): in the project folder,
  `node "<plugin folder>/scripts/orchestrator/cq.mjs" board`. `cq` itself is only on the PATH inside Claude Code;
  `/cq:board` prints the full path. In a vendored install: `node scripts/orchestrator/cq.mjs board`.

It listens on 127.0.0.1 only. There is no user login, but every request needs the key in the printed link,
and the key changes on every restart (an old tab then says "The key is old": open the new link). Do not expose
the port.

## What it shows

The switch at the top left changes between two workspaces, **Queue** and **Plans**.

The Queue workspace has these tabs:
- **Flat:** the columns **In queue** (ready now, blocked, proposed by agents and the batch queue), **In progress**,
  **Review** and **Built**. Each card shows class, estimate, value, blockers and owner questions. Click a card for
  its details and actions (to the top of the queue, pick, put on hold, add to the batch queue, edit, cancel task,
  and decline for a proposal). Drag cards to reorder them.
- **Project lanes:** the same cards with one row per project; drag a lane to change the project's priority.
- **Focus:** the order the queue takes work in, as Now, Next, Later and Waiting. Drag areas, projects and features
  between the columns. "Areas …" creates and names the areas. A **Forecast** box above the columns says when the
  remaining tasks in the focus are done at 50, 85 and 95 % (the same as `cq forecast`; the saved focus counts).
- **Dependencies:** a graph of which tasks wait on which.
- **Cloud:** tasks that can run in a cloud session, and the cloud sessions (off by default, see [Modules](#modules)).
- **Statistics:** done per day, added versus finished, time per class, cost per day (API-equivalent USD), context at
  the end of tracks, key figures (first **Cost per merged change**: all measured cost in the last 14 days divided by
  the tasks merged in them, with where the cost went and, as a secondary estimate-based figure, the cost per content
  minute; see [Cost estimates and calibration](queue.md#cost-estimates-and-calibration); then usage today), the forecast line, the table **Blockers last 7 days** (per
  blocker code: count and blocked time, the same numbers as `cq blockers`), the section **Agents last 14 days: models,
  tools and errors** (cost and share per model, the top tools with their error rate, API errors, active time and
  killed agents, the same numbers as `cq cost`), the box **Flow last 14 days** (first pass, fix rounds, merge
  conflicts, base red, pushes and triage, then right first time, post-merge defects and owner interventions per 10
  merged, the autonomy figures (verified tasks per owner intervention, the longest stretch without the owner, failures
  corrected without the owner), inflow by source with added/done for the last 3 weeks, the reviewer hit rate table
  and the hints; see
  [Flow and quality](queue.md#cost-estimates-and-calibration)), and the legend for the badges on the cards.
- A running card gets the badge **silent** when the track has an agent worktree but no sign of life for
  `limits.silentMin` minutes (the same rule as `SILENT` in `cq show`; the server measures it at most once a minute).

**Cancel, decline and edit.** For a waiting task (also on hold or in the batch queue) the detail panel has **Edit**
(value 1-10, content minutes and class, checked like `cq add` / `cq edit`) and **Cancel task**; for a proposal it has
**Edit** and **Decline**. Cancel and decline ask first, with an optional one-line reason, and run `cq cancel <id>
--remark "cancelled: …"` or `"declined: …"` (the same result as `cq set <id> cancelled --remark …`, but logged).
Edit runs `cq edit <id> --json '{…}'`. All three go through `/api/task-edit` and give **Undo** for 30 seconds. A
running, picked or review task is never cancelled from the board, since an agent or a person may be working on it:
the panel shows `cq set <id> cancelled --remark "<why>"` instead. **Waiting on you** has **Decline** next to
**Approve** for each proposal; it opens the task with the confirm step.

**Decisions** (the tab next to Plans and Queue, with a count) is the owner's main view: everything that waits on
the owner as one list, one card per decision, most impact first (minutes unlocked in focus stage 1 first, then what
the answer unlocks), grouped as **Decide** (owner questions), **Check** (QA), **Approve** (proposals) and **Unstick**
(an old pick, or work running long). Each card has an impact line, the recommendation as the filled button, and the
other answers next to it. A click does not write at once: the card leaves and an **Undo** toast stands for 5 seconds;
a new answer, leaving the page or the timer writes it. Keys: `j` / `k` move, `Enter` takes the recommendation, `1`-`4`
picks an answer, `u` undoes. With nothing waiting it shows the listening status; **Decided today** (closed) is at the
bottom. The board opens on Decisions when anything waits and on the queue otherwise. The rules are
`lib/queueDecisions.js`, the same file `cq decide` and `/cq:decide` use, so the writes are the same commands (see
[CLI parity](cli-parity.md)). "Flag for the orchestrator" on running work is `cq block <id> other` with a fixed note.

**Waiting on you** (the button at the top) collects what needs the owner: owner questions, proposals to approve,
QA (done tasks with the label `visual` that wait for a manual check, `qa ok` / `qa deviation`) and what is stuck.
An owner question with `choices` shows one button per choice (the recommended one filled); a click answers it through
the same `POST /api/action { type: 'resolve' }` with `{ choice: <n> }`, and the text in the open answer field goes
along as a note. "Answer in your own words" keeps the free text answer. A line under the title says
"Orchestrator listening" while `cq wait` runs in the orchestrator session (its heartbeat is under 90 s old), so an
answer starts the next round at once; otherwise "Answers are picked up the next time the orchestrator runs".

The **Plans** workspace is the plan register. **Overview** has one card per area, what is being worked on now and
what waits on you. **Plan entries** shows the entries as a list, a priority map, a tree map or dependencies, with
filters and the details of the selected entry. **Documents and agreements**, **Legal**, **Decisions** and **Launch**
show the documents, the legal points, the owner decisions and what stands between the plan and launch.

The gear holds the settings and the help, in two tabs. **General**: theme, mascot, the queue's limits, **Auto-accept
proposals** (the switch, the classes K and U, max estimate and max value, saved together through `cq proposals auto`
via `/api/proposals`, and the log of what was auto-accepted with an Undo button per row, `/api/proposals-undo` =
`cq proposals undo <id>`; see [queue.md](queue.md#auto-accept-of-proposals)) and the read-only setup. **Helper agents**: one row per [helper agent](orchestration.md#helper-agents) with what it does,
when it runs (classes, labels, paths in plain text), an on/off switch (a checkbox with role switch; Space toggles it)
and what it has cost: runs, median and total minutes, tokens and USD, its share of the task cost, and H/M/L findings
per run ("No runs yet" until it has run). The switch is saved through `cq helpers on|off <agent>` (the board posts
to `/api/helper` behind the key and the Origin check, like every other write; it never writes files itself). The
arrow keys move between the two tabs, and the board remembers the last one.

A [custom helper](orchestration.md#custom-helper-agents) has a **custom** badge, its scan level (red, yellow or
green) and its review state: **Approved** (with who approved it and when, in local time), **Needs review** or
**Changed since approval** (the file differs from the approved one, so it is turned off). Its switch is disabled,
with the reason read out to a screen reader, until it is approved for the file as it is now. **Add a custom helper**
takes the path to an agent file (`.md`) and an optional name, and posts to `/api/helper-add`, which runs
`cq helpers add`: the file is copied, scanned and registered, and stays off. The board has no way to approve a
helper: approval is `cq helpers approve`, after Claude has read the file and the owner has said yes (the `add-helper`
skill), and `/api/helper` refuses to switch on a helper that is not approved.

## Empty queue

When the queue has no task that is not done or cancelled, Flat and Project lanes show a first-run card instead of
empty columns: 1. add work (say "add to the queue" in Claude Code, or `cq add --file`), 2. start the queue with
`/cq:queue`, 3. answer questions here under **Waiting on you**, plus a link to the help.

## Modules

Some parts of the board can be switched off with `features` in `queue.config.json` (see
[configuration](queue.md#configuration)). The board server sends the resolved switches with the state, and the board
hides what is off:

| Key | Default | Hides when off |
|---|---|---|
| `plans` | on | The Plans button (and the room; a `?room=plans` link falls back to Queue) |
| `plans.legal`, `plans.launch`, `plans.documents` | off | The Legal, Launch and Documents and agreements surfaces in Plans, with their counters (an old link shows the Overview) |
| `focus` | on | The Focus tab |
| `statistics` | on | The Statistics tab |
| `cloud` | off | The Cloud tab, the "Suitable for cloud" filter and the Cloud row in the task detail |
| `follow` | off | The `/follow` page and its link in the terminal |

The gear's **General** tab has a read-only **Modules** section: each module, On or Off, and the key to set. There
is no switch in the browser; change the file and restart the board.

The **Cloud** tab also needs `board.showCloud`, which is off by default: turn it on in the gear (**Board**, "Show the
Cloud tab") or with `cq board-setting cloud on` (both write `board.showCloud` in queue.json, which wins over
queue.config.json). A saved Cloud view still opens while the tab is hidden, with a note where to turn it on.

## Update banner

When a newer cq is out, a banner below the top says "cq X is out (you have Y)", links to the CHANGELOG and lists the
steps with a Copy button each: `claude plugin update cq@ravenseat`, then `/reload-plugins` (or a new session),
then `cq setup --settings`. A vendored install gets `git pull` in your Ravenseat folder and
`node scripts/install.mjs <project> --overwrite` instead. Close it with the X: it stays away until a newer version is out
(remembered in this browser).

How it checks: the board server (not the browser) fetches the published `plugin.json` from GitHub at start, at most
once per 24 hours (cached in `<dataFolder>/update-check.json`). It is a plain GET with a 3 second timeout that sends
nothing about you or the project; any error just means no banner. Turn it off with `"board": { "updateCheck": false }`
in `queue.config.json`; it is also off when `DISABLE_UPDATES` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

Setup after an update (local, no network, also with the check off): `cq setup --settings` records the plugin version
it set up in `<dataFolder>/setup.json`. When the installed plugin differs from that record, the banner says to run
`cq setup --settings` again (the status line path holds the plugin version). This notice cannot be closed; it goes
away once setup has run. If setup was run for a newer plugin than the running board, it says to restart the board.

## Logo

The picture in the upper-left corner is loaded from `<dataFolder>/logo.webp` if it exists, otherwise from
`scripts/orchestrator/queue-board/logo.webp`. Keeping the picture there is a friendly request, not a license
condition (see "The name and the logo" in the README).

## The mascot

The mascot in the upper-left corner now and then says something in a speech bubble: a night line when you work
between 00:00 and 05:00, encouragement, a statistic from the queue (the priciest task today, the oldest card in
Review, proposals waiting, and so on), and events between two polls (merged, queue empty, new owner question, high
finding, weekly quota over 90 %). Click the mascot for a line; five clicks within ten seconds gives another one.

Timing rules: a night line at most every 30 minutes, random chat at most every 10 minutes, events at most one per
minute. A line is never repeated within the last 8. The bubble stays 10 seconds (longer while the mouse is over it)
and closes on click. The text is always set as plain text.

**Modes.** The gear menu has a **Mascot** choice: **Chatty** (everything), **Events only** (only events and clicks)
or **Off** (no bubbles at all). The choice is remembered in this browser, like the theme. The default for every
browser comes from `queue.config.json`:

```json
"board": { "port": 2000, "title": "Queue board", "mascot": "chatty" }
```

`cq board --mascot off` overrides it for one run. With `"off"` from the config or
the flag, the mascot is off for every viewer: no bubbles, no click, nothing is computed on the server, and the choice
in the gear is locked.

**Logo or mascot.** The Ravenseat logo is the default picture; the raven on the right talks. **Show the mascot instead
of the logo** under Logo and mascot in the gear switches to the mascot (`/logo`), per browser.

**Hiding the picture.** Off keeps the picture. To remove it completely in one browser, click **Hide the picture
completely** in the gear. **Show the picture again** in the same place brings it back.

**Your own phrases.** The board ships the mascot's full built-in repertoire (night owl jabs, encouragement, stats roasts, events and vibe-coding jokes) in `lib/queueMascot.js`. To use your own, put
`mascot-phrases.json` in the queue's data folder (`<dataFolder>`, default `scripts/.queue/`, which the installer adds
to `.gitignore`, so your phrases never end up in git). Categories you leave out keep the built-in phrases; an
invalid file falls back to the built-in set and prints one line in the board's terminal.

```json
{
  "version": 1,
  "night": [{ "text": "It is {time}. Go to bed." }],
  "encouragement": [{ "text": "{done_today} done today.", "weight": 2 }],
  "statistics": [{ "text": "{id} cost ${cost} today.", "source": "priciest" }],
  "events": [{ "text": "Merged {id}!", "event": "merged" }],
  "vibe": [{ "text": "Another round. Onward." }]
}
```

- `weight` (optional, up to 10) makes a phrase more likely within its category.
- Placeholders that every phrase can use: `{time}`, `{done_today}`, `{done_week}`, `{days}` (days without a high
  finding), `{night_cost}`, `{n}` (answers after midnight) and `{p}` (weekly quota in percent, only with a calibrated
  quota). A phrase whose placeholder has no value right now is skipped.
- Statistics phrases take their values from a `source`: `priciest` ({id}, {cost}), `fixRounds` ({id}, {n}), `inbox`
  ({hours}), `review` ({id}, {hours}), `nightShare` ({share}), `proposed` ({n}), `qa` ({n}), `record` ({n}),
  `responseTime` ({min}), `remaining` ({n}, {date}) and `dPlus` ({min}). Without `source` it is guessed from the words
  in the text.
- Events: `merged` ({id}), `queue-empty`, `new-question`, `high-finding` ({id}), `quota-90` ({p}), `click` and
  `click-5`.
- Vibe phrases get a higher chance for 15 minutes after a D/D+ review is merged or a fix round starts.

## Files

The board is plain files under `scripts/orchestrator/queue-board/`, with no build step and no CDN. `queue-board.mjs`
serves only the files in its allow list (`STATIC`), all with the same strict Content-Security-Policy (`script-src
'self'`, no inline script).

- `index.html`, `board.css` and `theme.css` (built by the server): the page.
- `board/`: the board itself, 17 classic scripts that `index.html` loads in this order with `defer`:
  `core.js` (constants, the state, helpers, toasts), `api.js` (key, API calls, fetching, the warning dialog),
  `cards.js` (filters, search, the card), `draw.js` (the columns, the chain, the strip), `views.js` (Focus wiring,
  grouping, saved views), `menus.js` (help, project lanes, the Filter menu), `statistics.js`, `settings.js` (the
  gear), `inbox.js` ("Waiting on you"), `panel.js` (the detail panel), `edit.js` (cancel, decline, edit, markdown),
  `select.js` (multi-select), `bulk.js` (bulk dialog and undo), `interact.js` (writing, drag, keyboard), `top.js`
  (theme, gear sections, modules, view tabs), `cloud.js` (the Cloud view) and `start.js` (update banner, logo and
  the start). They share the page's global scope, so a top-level name in one is visible in the others, as when they
  were one `board.js`. Code that runs while a script loads may only use names from the scripts before it; a new
  file goes into `BOARD_SCRIPTS` in `queue-board.mjs` and into `index.html` in the same place.
- `a11y.js`, `performance.js`, `graph.js`, `plan.js` and `mascot.js`: shared helpers and views with their own
  `window.Queue…` object; the pure rules they use are served from `lib/` (the same files the tests use).
- `plans/`: the Plans room (see [plan register](plan-register.md)).
