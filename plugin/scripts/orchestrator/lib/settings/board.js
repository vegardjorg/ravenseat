// =============================================================
// settings/board.js: the rows of Board and advice, and Cloud (sections 12 and 13).
//
// Part of the settings registry (SPLIT-1): lib/settingsRegistry.js puts the area files together, in the order of
// AREAS there, into SETTINGS. A new row goes into the area file of its category, inside the section of that category,
// with its "Friction:" comment, as row(key, category, type, title, explanation, options) from ./rowKit.js; its default
// goes into lib/queueConfig.js STANDARD and its table row into plugin/docs/queue.md. A `requires` goes into
// ./requires.js. The row's place in this list is its place on the board and in `ravenseat settings`.
//
// Used by: lib/settingsRegistry.js.
// Tested in: lib/__tests__/settingsRegistry.test.ts (coverage, complete rows) and
// lib/__tests__/settingsRegistrySplit.test.ts (no row lost, moved or changed by the split).
// =============================================================
'use strict';

const { row, BASIC, QUEUE, offWeakens } = require('./rowKit.js');

/** The rows of this area, in the order they are shown. */
const ROWS = Object.freeze([
  // ---- 12. Board and advice ----
  row('guidance', 'board', 'choice', 'Guidance',
    'guided: advice about CI, gates and checks. quiet: no advice; guards and facts stay. Only for you.',
    { ...BASIC, ...QUEUE, choices: ['guided', 'quiet'] }),
  // Track hdr. Friction: bubbles show only when a viewer switches the mascot on (the gear); the default logo never talks,
  // which removes a talking element from the default view. No guard is weakened, and the default (chatty) is unchanged
  // for people who turn the mascot on.
  row('board.mascot', 'board', 'choice', 'Mascot bubbles',
    'How much the mascot talks once it is switched on in the gear (the logo never talks): chatty, events (only ' +
    'events and clicks) or off, for every viewer.', { ...BASIC, choices: ['chatty', 'events', 'off'] }),
  row('board.blockedColumn', 'board', 'onoff', 'Blocked column',
    'Tasks with an open blocker that needs action get a column after In queue.', { ...BASIC, ...QUEUE }),
  // QA-1c Q5. Friction: float removes the reflow, since a docked panel narrowed the board and rewrapped the focus line
  // and the Dependencies view's top row every time a task, Settings or the help opened; the cost is that the panel
  // covers the right side of the board while it is open, and a click outside closes it. beside is kept as an option for
  // those who want to read the cards next to the panel. Not a guard, so neither value weakens anything.
  row('board.panelMode', 'board', 'choice', 'Side panel',
    'float: on a wide screen the panel opens over the board, so nothing moves, and a click outside closes it. ' +
    'beside: the board makes room for the panel and rewraps while it is open. Below 1200 px it covers the board in ' +
    'both.', { ...BASIC, choices: ['float', 'beside'] }),
  // Roadmap 0ø J1. Friction: none; the board often sits in a background tab, and the count is a quiet signal instead of
  // desktop notifications (which stay off). It counts only what waits on the owner. Off: the plain title.
  // Demo mode (owner decision 22.11). Friction: none for the work. It costs zero tokens and cannot stop or start
  // anything; it is one dismissible card on an empty board that never had a task ("Not now", "Don't show again"), and
  // the demo itself lives in its own folder, locked down on the server. On in lite and full because a first-time (lite)
  // user gets the most from seeing a board with work on it. Off: no card; Settings > Show demo board still opens it.
  row('board.demoOffer', 'board', 'onoff', 'Demo board offer',
    'An empty board that has never had a task offers a made-up demo board with work in every column. It lives in its ' +
    'own folder and nothing done there reaches your queue. Off: no offer; the Show demo board row at the bottom of ' +
    'Settings still opens it.', BASIC),
  row('board.titleCount', 'board', 'onoff', 'Count in the tab title',
    'The browser tab title starts with the number of decisions that wait on you, "(3) Queue board". Running tracks ' +
    'are not counted. Off: the plain title.'),
  // J3. Friction: none for most; a screen reader user may meet a clash with their own keys, so the shortcuts can be
  // turned off here or from the ? overview. They never fire in text fields or dialogs, or with Ctrl, Alt or Cmd held,
  // so the browser's own shortcuts are untouched. Not a guard.
  row('board.shortcuts', 'board', 'onoff', 'Keyboard shortcuts',
    'One-key shortcuts on the whole board: ? lists them, / goes to the search, g and a letter opens a tab, j and k ' +
    'move between cards. Never in text fields or dialogs. Off: only the keys on a focused card and in Decisions.',
    BASIC),
  // J7. Friction: none for the work; it only navigates and copies a command, never changes anything (owner answer 4).
  // While the board has focus it takes Ctrl+K from the browser (which would focus its own search bar), never inside a
  // text field. On by default since it is the fast way to a card or one of the many settings. Needs board.shortcuts.
  row('board.palette', 'board', 'onoff', 'Command palette (Ctrl+K)',
    'Ctrl+K opens one field that finds a view, a card (id or title) or a setting and goes there, with the ravenseat ' +
    'command behind each to copy. It changes nothing itself. Needs the keyboard shortcuts on. Off: Ctrl+K is the ' +
    "browser's again.", BASIC),
  // J6. Friction: none; plain words search exactly as before, and an unknown field is shown as a hint, never emptying
  // the board. On by default since it only adds meaning to words with a colon or a > or <. Off: every word is plain text.
  row('board.structuredSearch', 'board', 'onoff', 'Structured search',
    'The search box also understands fields: class:D, status:blocked, project:x, block:gate-red, label:visual, age>2d, ' +
    'cost>1, and -class:K to leave out, with suggestions while you type. Plain words search as before. Off: every ' +
    'word is searched as plain text.'),
  // J4. Friction: a row of three buttons over the columns takes a little room; off in lite so the first board stays
  // simple (owner answer 6). They only filter what is shown, never what the queue does.
  row('board.quickFilters', 'board', 'onoff', 'Quick filter buttons',
    'Buttons over the columns: Changed 24 h, Older than usual and Red gate. Each filters the cards; several combine. ' +
    'On in full mode, off in lite.', { defaultByMode: { lite: false, full: true } }),
  // Roadmap TIDSLINJE T-A (gantt investigation 18.11, section 6). Friction: none for the work; it is one more tab that
  // only reads the schedule (the same simulation as ravenseat schedule) and never changes the queue, costs no tokens.
  // On in full since it answers "when is this step done"; off in lite, where there are no focus steps to show.
  row('board.timeline', 'board', 'onoff', 'Timeline tab',
    'A Timeline tab: what ran in the last day and what runs now, then the plan played forward as rough bars per focus ' +
    'step (or per project), with a now line, a table view, and the tasks that cannot start with the reason. Read only. ' +
    'On in full mode, off in lite.', { defaultByMode: { lite: false, full: true } }),
  // T-A. Friction: none; it only sets how far the chart reaches. 3 days by default because beyond a few days new tasks
  // rank in ahead and the plan is mostly noise (investigation section 2). 1 to 14; a value outside is clamped.
  row('board.timelineHorizonDays', 'board', 'integer', 'Timeline: days ahead',
    'How many days ahead the Timeline shows, 1 to 14 (3 by default). Tasks that start later are listed in the table ' +
    'and counted on their row. The plan gets weaker the further out it goes.'),
  // T-A. Friction: none; it only picks the rows. step by default because the focus steps are what decide the order;
  // project is how many owners think. A viewer can switch on the tab for their own browser.
  row('board.timelineRows', 'board', 'choice', 'Timeline: rows',
    'step: one row per focus step, in the focus order (what decides what runs first). project: one row per project. ' +
    'The ran and running part is always first. Each browser can switch on the tab itself; this is the default.',
    { choices: ['step', 'project'] }),
  // Roadmap TIDSLINJE T-B. Friction: none for the work; a drag only changes order (rank in a step, the focus order for a
  // step row) through the same guarded server paths as the cards and the Focus tab, and every save has Undo. It never
  // sets a time (sideways and across steps are refused with the reason). On since order is the one thing the owner
  // steers and the chart is where they see its effect; off leaves the Timeline read only.
  row('board.timelineDrag', 'board', 'onoff', 'Timeline: drag to change the order',
    'Drag a task bar up or down within its focus step, or a step row up or down, to change the order (Space, the arrows ' +
    'and Enter do the same with the keyboard). Time is calculated, so sideways is refused. Off: the Timeline is read only.',
    { fullWhy: 'the Timeline tab is off in lite' }),
  // T-B. Friction: one more click per drop (Save). On since a drop can move a whole step's end by hours and the owner
  // should see that in words before it is written; off saves at once, with Undo in the toast.
  row('board.timelineDragPreview', 'board', 'onoff', 'Timeline: preview before a drop is saved',
    'A drop first shows what it does to the plan in words (which step is done how much earlier or later, which task ' +
    'starts first), then Save or Cancel. Off: the drop is saved at once, with Undo in the toast.',
    { fullWhy: 'the Timeline tab is off in lite' }),
  // Roadmap TIDSLINJE T-C. Friction: none for the work; read only, it can never stop or slow a track and costs no
  // tokens. Compute: the plan is played up to 200 times (fewer for a big queue, capped by runs x open tasks), about a
  // quarter of a second on the demo queue, cached on the server; the backtest once a day. On since without a band the
  // bars look surer than they are; off shows the plan's step ends alone.
  row('board.timelineUncertainty', 'board', 'onoff', 'Timeline: uncertainty band per step',
    'Each focus step gets a band from P50 to P85 (the plan played many times with the measured actual-to-estimate ' +
    'spread), "done around X (likely by Y)", and a line on how often past steps were done by the end of their band. ' +
    'Tasks keep one rough bar each. Off: the step ends alone, without the band.',
    { fullWhy: 'the Timeline tab is off in lite' }),
  // Roadmap 3e AW-2 (owner answers 21.11 as recommended). Friction: display only, it never stops or slows work; it takes
  // some height at the top of Decisions, hidden when nothing happened and closable for the visit. On by default since
  // it answers the first question after a pause. Not a guard.
  row('board.sinceLast', 'board', 'onoff', 'Since you left',
    'A short summary at the top of Decisions: merged, recovered without you, blocked, waiting on you and spend since ' +
    'you last looked, with the latest events. Hidden when nothing happened. Off: no band.', BASIC),
  // AW-2/AW-3. Friction: none; it only picks the window. last-seen is the default because "what happened while I was
  // away" is the question; it falls back to 24 h without a mark. A browser can pick another one for itself on the band.
  row('board.sinceLastWindow', 'board', 'choice', 'Since you left: window',
    'last-seen: since your seen mark (Decisions on screen a few seconds, "Mark seen", or ravenseat since --mark); ' +
    '24 h without one. 24h or 7d: a fixed window. "Decided" in Decisions follows it.', { choices: ['last-seen', '24h', '7d'] }),
  row('limits.autocompact', 'board', 'onoff', 'Automatic compaction',
    'On: Claude Code compacts the orchestrator session itself and the queue continues. Off: a ready /compact line; ' +
    'then also turn off auto-compaction in Claude Code ("autoCompactEnabled": false), or it compacts anyway.',
    { ...BASIC, ...QUEUE }),
  row('board.port', 'board', 'integer', 'Board port',
    'The local port the board listens on (2000 by default). Change it when another program already uses that port.'),
  row('board.title', 'board', 'text', 'Board title', 'The title in the board\'s header and browser tab.'),
  row('board.hideKey', 'board', 'onoff', 'Keep the board key from Claude',
    'The board opens itself in your browser with its key and prints the link without it; ravenseat board open opens ' +
    'it again. A write without the Origin of the board (a script, not the browser) is refused.', {
      weakens: offWeakens,
      protects: 'Claude reading the key from the start line and then doing owner actions on the board with curl or fetch.',
      whyNot: 'The key is in the output Claude reads when it starts the board, and the board takes a script call as yours.',
      changes: 'The start line prints the link with the key, and a write with the key but no Origin is let through.',
    }),
  // Friction: none. It never stops or slows work (show only reads the cache, the refresh runs detached, doctor waits
  // at most 3 s) and costs zero tokens; agents, CI, hooks and --json never see the line. So on by default. The same in
  // lite and full (both modes, no defaultByMode): a new user is the one who most needs to hear about a fix (roadmap 0u3).
  row('updates.check', 'board', 'onoff', 'Update check',
    'Ravenseat looks for a newer version on GitHub at most once a day (a plain GET that sends nothing about you): the ' +
    'board shows a banner, and ravenseat show and doctor one line. It never stops any work. The old name ' +
    'board.updateCheck still works; DISABLE_UPDATES and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also turn it off.'),
  row('board.showCloud', 'board', 'onoff', 'Show the Cloud tab',
    'The Cloud tab, when cloud sessions are on (features.cloud).', QUEUE),
  row('features.statistics', 'board', 'onoff', 'Statistics tab',
    'The Statistics tab on the board. On by default; off only hides the tab, and the time log is written as before.'),
  row('features.follow', 'board', 'onoff', 'Follow-up entries',
    'The follow-up page, the follow commands and their lines in show and pulse.'),
  // Advice about the size of Claude's instructions (lib/instructionSize.js). Not a guard, so off never weakens; owner
  // decision 2026-11-12 puts all three under Advanced.
  row('instructionSize.mode', 'board', 'choice', 'Instruction size advice',
    'warn: doctor, the Checks tab and one chat message say when the instructions Claude loads in every session grow ' +
    'past the limits below. off: none of it. Quiet guidance hides the advice either way.', { choices: ['warn', 'off'] }),
  row('instructionSize.maxLines', 'board', 'integer', 'Lines per instruction file',
    'Advice when a file loaded in every session (CLAUDE.md, a rule without paths:, an import) has more lines than this. ' +
    '200 is the target in the Claude Code docs.'),
  row('instructionSize.maxChars', 'board', 'integer', 'Instruction characters in all',
    'Advice when everything loaded at the start of a session has more characters than this. 40,000 is where Claude ' +
    'Code itself warns.'),
  // The client format canary (lib/clientCanary.js, roadmap 0w W4). On by default in both modes: it only shows (one
  // doctor row, one medium card that never lights the red marker) and stops nothing, so off weakens no guard. The shape
  // log is off by default: it writes a file in the data folder that is only of use when someone reports a form.
  row('client.canary', 'board', 'onoff', 'Notice when Claude Code changes its log format',
    'Doctor reads the tail of the newest Claude Code transcript and says when the version is newer than the formats ' +
    'Ravenseat was tested on, or rows read differently (new row types, turns without usage, unknown API errors); the ' +
    'Checks tab shows one card while such rows are seen. Type names and counts only, never content. It stops nothing. ' +
    'On by default, so a change that could make the cost and time numbers wrong is seen early. Off: no row and no card.'),
  row('client.shapeLog', 'board', 'onoff', 'Log new API error forms',
    '`ravenseat checks` writes the shape of each new API error form (keys and value types, short codes, no text) to ' +
    'client-shapes.jsonl in the data folder, so the form can be confirmed and reported. Off by default.'),
  // Friction: none. One INFO row in doctor while Code Mode is on; it never stops anything and costs no tokens, so warn
  // is the default (C3, owner 23.11; not the 16.11 deny). No deny value: the stance is to support the official feature.
  // The REPL counts in `ravenseat cost` (lib/turnTools.js) get no row: pure measurement, like the other turn figures.
  row('codeMode.policy', 'board', 'choice', 'Say when Claude Code\'s Code Mode is on',
    'Doctor shows one INFO row while Code Mode is on (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE in the environment or in ' +
    '~/.claude/settings.json; Ravenseat only reads it, never sets it): what it means for the guards and the cost ' +
    'figures. warn shows the row, off hides it.', {
      choices: ['warn', 'off'],
    }),

  // ---- 13. Cloud ----
  row('features.cloud', 'cloud', 'onoff', 'Cloud sessions',
    'Tracks in cloud sessions: the Cloud tab, the cloud filter and the cloud commands.', BASIC),
  row('cloud.maxSessions', 'cloud', 'integer', 'Sessions at once',
    'Cloud sessions at once. They all count against your plan\'s usage limits.'),
  row('cloud.offerOnLeave', 'cloud', 'onoff', 'Offer sessions when I leave',
    'The orchestrator offers cloud-go once when you say you are leaving.'),
  row('cloud.collect', 'cloud', 'choice', 'When a session has finished',
    'off: you run the steps. ask: the orchestrator asks. auto: it fetches and runs the local gates without asking.', {
      choices: ['off', 'ask', 'auto'],
      // Owner decision 2026-11-12: auto brings cloud work home without you looking first. off and ask never weaken.
      weakens: (v, std) => v === 'auto' && std !== 'auto',
      protects: 'Work from a cloud session being fetched and run on your machine before you have looked at it.',
      whyNot: 'A cloud session ran out of your sight; its branch runs its own code here (the gates and the done command) ' +
        'as soon as it is fetched.',
      changes: 'The orchestrator fetches each finished session and runs the local gates on it without asking. The merge ' +
        'still follows the usual rules. Doctor will report it.',
    }),
  row('cloud.deleteBranch', 'cloud', 'onoff', 'Remove the branch after the merge',
    'The session\'s branch is removed from the remote after the merge.'),
  row('cloud.bundleMax', 'cloud', 'integer', 'Tasks per session',
    'At most this many tasks in one cloud session, run one after another (4 by default).'),
  row('cloud.start', 'cloud', 'choice', 'How a session starts',
    'terminal: cloud-start in your terminal. routine: a scheduled task (see `ravenseat cloud setup`).',
    { choices: ['terminal', 'routine'] }),
  row('cloud.fireUrl', 'cloud', 'text', 'Routine URL',
    'The scheduled task `cloud send` fires with start routine. The token is only ever in the environment.',
    { edit: 'file' }),
  row('cloudHidden', 'cloud', 'list', 'Paths hidden from the cloud',
    'Paths a cloud session cannot see (for example gitignored folders); a mission that points there is stopped.'),
]);

module.exports = { ROWS };
