// =============================================================
// menus.js: the help ("How to use the board") with the legend, the project lanes and the Filter menu.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// "How to use the board" (in the gear): short help in the side panel. The sections come in the order a new user needs
// them (B30, UX review H1): what the board shows, Waiting on you and Decisions, and picking and running work first, then
// the rooms, and the advanced parts last (filter, bulk actions, the batch queue, the keyboard, areas). Each section
// has an id (help-<id>) that the contents list at the top and the "?" in each room header (roomHelp) jump to.
const HELP = [
  {
    id: 'board',
    title: 'What the board shows',
    text: [
      'The tabs at the top left are the rooms: Queue holds the cards, Decisions what waits on you, Plans the plan ' +
        'register, and Checks (when it is on) what your project has for checking its code. In Queue the columns are ' +
        'In queue, In progress, Review and Built; Blocked gets a column of its own when that is switched on in Settings.',
      'The view tabs under the rooms show the queue in other ways: Flat, Project lanes, Focus, Dependencies and ' +
        'Statistics (Cloud when the cloud is on). The gear at the top right opens Settings, where this help lives, and ' +
        'the "?" in a room\'s header opens the help at that room.',
    ],
  },
  {
    id: 'waiting',
    title: 'Waiting on you and Decisions',
    text: [
      'The button at the top opens Decisions and carries the only count: owner questions, QA, proposed and what is stuck, ' +
        'one card each. The board opens there only when something is new since your last visit; otherwise it opens the ' +
        'queue view you used last. With a focus, the questions are sorted by what the answer unlocks in the focus (step 1 ' +
        'first).',
      'Number keys pick a choice (the number is its --choice number), Enter takes the recommendation, u undoes. ' +
        'Check the cards for "QA ok for selected" or "Approve selected". "Sort" lists tasks without a project or with the ' +
        'wrong project, with proposals you can accept.',
    ],
  },
  {
    id: 'work',
    title: 'Picking and running work',
    text: [
      'The queue starts the work itself when it runs (/ravenseat:queue in Claude Code). "Ready now" in In queue is what ' +
        'can start now, with no blockers, and "Next up" above the columns is what the queue starts in the next free slot. ' +
        'The order follows the focus, then the points.',
      'To change it, open a card: "To the top of the queue" moves it first, and "Pick" (with who is picking) takes it ' +
        'to do yourself. A picked task takes no agent slot, and "Release" puts it back in the queue. In the queue, Space ' +
        'on a card lifts it, the arrow keys move it and Space drops it.',
    ],
  },
  {
    id: 'panel',
    title: 'The task panel',
    text: [
      'A card opens its panel: the title, a short line on what the task is about (from the mission\'s "What and why", ' +
        'or its first paragraph), the actions, the full mission, and the technical facts last under "Details" (closed ' +
        'from the start, remembered in this browser).',
      'On a wide screen (about 1200 px and up) the panel floats over the right side of the board, so the board does ' +
        'not move when it opens: the board stays usable, a click on another card shows that card, and a click ' +
        'anywhere else closes the panel (not while a form in it has unsaved changes). Prefer the board to make room ' +
        'for it? Set "Side panel" to beside in Settings, Board. On a narrower screen it covers the board until you ' +
        'close it. Esc and Close close it, and focus goes back to the card.',
    ],
  },
  {
    id: 'focus',
    title: 'Focus',
    text: [
      'The focus is the order in which the queue takes work: everything in step 1 before step 2, regardless of score. ' +
        'Within a step the points apply. A step is an area, a project or a feature. The most specific wins: a project ' +
        'with a step of its own takes precedence over its area\'s step. "Rest waits" means nothing outside the steps ' +
        'starts; "fill free slots" starts them only when the focus has nothing ready. Tasks that something in focus waits ' +
        'on are dragged along. The focus applies until you change it, or until the end date. The focus line at the top ' +
        'turns red when the focus has nothing ready, and says which answer unlocks the most.',
      'The Focus tab shows the focus as one ordered list, In focus (the steps in order, each one opens to show its ' +
        'tasks), then Not in focus (the rest) and On pause (projects on pause). Drag areas, projects and features ' +
        'between them, or lift with Space, move with the arrow keys (up and down in In focus, left and right between ' +
        'the sections) and drop with Space (Esc cancels). The name, the rest, the end date, dragging along, what ' +
        'happens when the focus is done and Areas sit in Focus settings below the lists. The changes are a draft until ' +
        'you press "Save focus"; then you first see what changes and what the queue starts next.',
    ],
  },
  {
    id: 'plans',
    title: 'Plans and Queue',
    text: [
      'The switch at the top left changes workspace. Plans opens on the Overview, with one card per area. "Plan entries" ' +
        'is the plan register: area › project › entry in the list (click to fold), the details on the right, and the ' +
        'filters with counts on the left (on a narrower screen behind the "Filters" button). The copy buttons give the ' +
        'start line for /plans.',
      'A badge like PL-ALONE-1 on a card opens the entry in Plans; the Queue tab in the entry\'s details lists its ' +
        'tasks, and a click shows the card here.',
    ],
  },
  {
    id: 'checks',
    title: 'Checks',
    text: [
      'Checks shows what your project has for checking its code (CI, gates, scripts, git hooks and config), read from ' +
        'your files. Ravenseat did not run any of it, so it shows what is set up, not that it works. "Read again" reads ' +
        'the files again.',
      'The suggestions under it are grouped by category, the most important first in each group, and all of them are ' +
        'optional. "How it works" at the top of the room shows the four steps: "Add investigation to queue" puts an ' +
        'investigation in the queue (the click is your yes), it ends in a plan with recommended steps and changes no ' +
        'files, you choose which steps become tasks, and nothing is built before you approve it. "Turn on" and "Use as ' +
        'gates" need no agent. The Important box leads to its cards. "Set aside" hides a suggestion until you bring it ' +
        'back. The tab can be turned off in Settings.',
    ],
  },
  {
    id: 'statistics',
    title: 'Statistics',
    text: [
      'Statistics shows throughput, lead time and usage over the last days: the key figures, the forecast, the charts ' +
        'of done and added per day, the blockers and guard decisions of the last 7 days, and the flow. The legend for ' +
        'the badges on the cards is at the bottom, as here.',
    ],
  },
  {
    // QA-1d: the presets moved from the old "Selection" button into the Filter menu ("selection" means ticked cards).
    id: 'filters',
    title: 'Filter, tabs and grouping',
    text: [
      'The Filter menu starts with Quick filters (Focus now, Ready in focus, On hold, Sort, New since last visit …) and ' +
        'Saved: your own filters (search, filter, grouping and view), saved in this browser with "Save current as…". ' +
        'Under them are the filter sections. The Filter button says what is in use ("Filter · 2", or the name of the ' +
        'quick or saved filter), and "Show all" at the top of the menu clears it. With a search or filter on, the first ' +
        'row is "Select all N matches". The tabs (Flat, Project lanes, Focus …) are the views; the arrow keys move ' +
        'between them, Enter selects. The grouping beside the tabs splits the cards by area and project, project and ' +
        'feature, or focus step.',
    ],
  },
  {
    id: 'bulk',
    title: 'Bulk actions',
    text: [
      'Select cards with the checkbox, x on the card, Ctrl/Cmd-click or Shift-click, Ctrl/Cmd+A or "Select all N ' +
        'matches" at the top of the Filter menu. The group header selects the whole group. The selection menu next to the box you checked last (a bar ' +
        'at the bottom on a narrow or touch screen) moves to a project, puts on hold, moves as a block, adds to the ' +
        'batch queue or sets a label.',
      'You always see what changes before it is saved, everything happens together or not at all, and "Undo" is ready ' +
        'afterward. In the menu the arrow keys move, Esc closes it and Shift+F10 on a card opens it again. Esc clears ' +
        'the selection.',
    ],
  },
  {
    id: 'batch',
    title: 'Batch queue',
    text: [
      'Small tasks that do not block anything can go into the batch queue. There they do not start alone, but are packed ' +
        'together into one track of the right size ("Pack into track" when the group is large enough). D+, tasks others ' +
        'wait on and tasks with open owner questions cannot be there.',
    ],
  },
  {
    id: 'keyboard',
    title: 'The keyboard on the board',
    text: [
      'Tab goes to one card title per column (or per cell in Project lanes). Arrow up and down move between the cards, ' +
        'arrow left and right to the neighboring column, Home and End to the first and last card. Enter opens the card, ' +
        'x selects it, and Space lifts a card in the queue (the arrow keys move, Space drops, Esc cancels).',
      '"Blocked", "Proposed" and "Batch queue" are folds: the arrow before the name shows whether it is open, and a ' +
        'click, Enter or Space opens or closes it. Blocked is open from the start when it has 20 cards or fewer, Proposed ' +
        'is closed, and what you choose holds for the visit. When a card in a chain is not visible, the chain line says ' +
        'why (a closed fold, the search, the filter, the selection, or older than 7 days in Built) with a button that ' +
        'shows it.',
    ],
  },
  {
    id: 'areas',
    title: 'Areas',
    text: [
      'An area groups projects that belong together, for example Auth or Payments and invoicing. You prioritize areas ' +
        'instead of many projects. Create and edit them with "Areas …" in Queue → Focus. A project belongs to one area.',
    ],
  },
];

// The legend for the classes, WIP and the badges on the cards. Shown in the help and in the statistics tab,
// because the tooltips do not work on touch or with the keyboard.
const BADGES = [
  ['badge ready-badge', 'Ready now', 'Can start now: no blockers.'],
  ['summary-estimate', '45 min', 'Estimated content in minutes.'],
  ['summary-visual', 'visual', 'The owner does a visual check after delivery.'],
  ['badge wait-badge', 'on hold', 'Parked until a date or an event.'],
  ['badge locks', 'unlocks 3', 'This many tasks are waiting on this one via the chain.'],
  ['badge cloud-badge', 'Cloud', 'Running in a cloud session.'],
  ['badge old', 'old', 'Picked or registered outside the queue more than 72 hours ago.'],
  ['badge tone-warn silent-badge', 'silent', 'Running with an agent, but no sign of life for a while (ravenseat show says what to do).'],
  ['badge tone-warn reviews-badge', 'reviews 1/2', 'In review: this many of the reviewers receive chose have reported. Merge waits for all, and for no HIGH.'],
  ['badge qa', 'Waiting for QA', 'Built, but the owner has not looked it over.'],
  ['badge deviation', 'QA deviation', 'The owner found something during the check.'],
  ['badge deviation', 'Merged, not verified', 'No gates, no done command and no agent review ran on this task.'],
  ['badge qa', 'Audited', 'An agent reviewed the change, but no check ran. Not the same as verified.'],
];
function legend(idPrefix) {
  const row = (badge, text) =>
    el('div', { class: 'explanation-row' }, el('dt', null, badge), el('dd', { text }));
  return el(
    'section',
    { class: 'legend', 'aria-labelledby': `${idPrefix}-draw` },
    el('h3', { id: `${idPrefix}-draw`, class: 'setting-title', text: 'Legend' }),
    el('h4', { class: 'explanation-title', text: 'Risk classes' }),
    el(
      'dl',
      { class: 'explanation' },
      window.QueueA11y.CLASSES.map((k) =>
        row(
          el('span', {
            class: `summary-class${k.class === 'D+' ? ' badge class-dplus' : ''}`,
            text: k.class,
          }),
          `${k.name[0].toUpperCase()}${k.name.slice(1)}. ${k.explanation}`,
        ),
      ),
    ),
    el('h4', { class: 'explanation-title', text: 'Slots in In progress' }),
    el(
      'dl',
      { class: 'explanation' },
      row(
        el('span', {
          class: 'wip',
          text: window.QueueA11y.wipText({ agents: 3, max: 4, dPlus: 1, maxDPlus: 2 }),
        }),
        'Agents: the slots in use (running and review) out of at most this many at once. Heavy: D+ tasks out of at most ' +
          'this many at once. Picked tasks and work outside the queue take no slot. Red when everything is full.',
      ),
    ),
    el('h4', { class: 'explanation-title', text: 'Badges on the cards' }),
    el(
      'dl',
      { class: 'explanation' },
      // The marks drawn as on the card: visual is the eye with the word as hidden text, unlocks carries its arrow.
      BADGES.map(([cls, text, explanation]) =>
        row(
          cls === 'summary-visual'
            ? el('span', { class: cls }, icon('eye'), el('span', { class: 'hidden-for-eye', text }))
            : cls === 'badge locks'
              ? el('span', { class: cls }, icon('unlocks'), text)
              : el('span', { class: cls, text }),
          explanation,
        ),
      ),
      row(
        el('span', { class: 'summary-project', text: 'project' }),
        'The project\'s short name; the dot in front of it is the project\'s color. Not shown when the cards ' +
          'are already grouped per project.',
      ),
      row(
        el('span', { class: 'explanation-edge', text: 'dashed edge' }),
        'Blocked: waiting on something (the blocker is at the bottom of the card). A red stripe on the left: the card is ' +
          'in the Blocked column and needs action.',
      ),
    ),
  );
}

/**
 * Opens "How to use the board" in the side panel. `o.at` is a section id ('focus', 'checks' ...): the help opens there
 * with focus on that section's heading (the "?" in a room header). `o.fromSettings` is set by the button in Settings:
 * the header then has "Back to menu" (B9), which goes back to Settings with focus on that button. Called with no
 * argument (or with a click event) it opens at the top with focus on Close, as before.
 */
function openHelp(o) {
  const at = typeof o?.at === 'string' ? o.at : null;
  const fromSettings = o?.fromSettings === true;
  t.selected = null;
  t.setting = null;
  t.help = true;
  showPanel();
  panel.scrollTop = 0;
  // B9: first in the header, so it is the first tab stop and sits where a way back is looked for.
  const back = fromSettings
    ? el(
        'button',
        { type: 'button', class: 'button button-outline help-back', onclick: backToSettings },
        icon('back'),
        'Back to menu',
      )
    : null;
  panel.replaceChildren(
    el(
      'div',
      { class: 'panel-header' },
      back,
      el('div', null, el('h2', { id: 'panel-title', text: 'How to use the board' })),
      el(
        'button',
        { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
        icon('close'),
      ),
    ),
    helpContents(),
    ...HELP.map(({ id, title, text }) =>
      el(
        'section',
        { class: 'help-del', id: `help-${id}`, 'aria-labelledby': `help-${id}-title` },
        el('h3', { id: `help-${id}-title`, class: 'setting-title', tabindex: -1, text: title }),
        text.map((x) => el('p', { class: 'help-text', text: x })),
      ),
    ),
    el('div', { id: 'help-legend' }, legend('help')),
    el('p', {
      class: 'inbox-info',
      text:
        'Everything the board writes goes via ravenseat with a lock, and nothing changes before you have seen the explanation and confirmed.',
    }),
  );
  if (!at || !helpGoTo(at)) panel.querySelector('.panel-header .button-icon')?.focus();
}

/**
 * The contents list at the top of the help: one link per section and the legend. A link moves focus to its heading
 * (helpGoTo) and never sets the hash: the board's key lives in the hash.
 */
function helpContents() {
  const entries = [...HELP.map((x) => [x.id, x.title]), ['legend', 'Legend']];
  return el(
    'nav',
    { class: 'help-contents', 'aria-label': 'Contents' },
    el(
      'ol',
      { class: 'help-contents-list' },
      entries.map(([id, title]) =>
        el(
          'li',
          null,
          el('a', {
            href: `#help-${id}`,
            text: title,
            onclick: (e) => {
              e.preventDefault();
              helpGoTo(id);
            },
          }),
        ),
      ),
    ),
  );
}

/** Scrolls the help to a section and gives its heading focus (the heading is no tab stop: tabindex -1). False if none. */
function helpGoTo(id) {
  const heading = id === 'legend' ? panel.querySelector('#help-legend h3') : $(`help-${id}-title`);
  if (!heading || !panel.contains(heading)) return false;
  heading.tabIndex = -1;
  heading.scrollIntoView?.({ block: 'start' });
  heading.focus();
  return true;
}

/** B9: "Back to menu" goes back to Settings, with focus on "How to use the board" once Settings are drawn. */
async function backToSettings() {
  // The button is drawn while Settings load too: focus goes there at once, and again once the loaded Settings are
  // drawn (a redraw replaces the button), unless the panel was closed meanwhile.
  const loading = openSettings();
  $('settings-open-help')?.focus();
  await loading;
  if (t.setting && !panel.contains(document.activeElement)) $('settings-open-help')?.focus();
}

/**
 * The small "?" in a room's own header (B30): opens the help at the room's section. `name` gives the accessible name
 * ("Help for Decisions"); the visible text is only "?". data-help lets closePanel find it again after a redraw.
 */
function roomHelp(section, name) {
  return el('button', {
    type: 'button',
    class: 'room-help',
    'aria-label': `Help for ${name}`,
    title: `How ${name} works`,
    'data-help': section,
    'data-focus': `help:${section}`,
    text: '?',
    onclick: (e) => {
      e.stopPropagation();
      openHelp({ at: section });
    },
  });
}

function laneEl(p, per, columns = COLUMNS) {
  // The numbers in the lane header and whether the lane is shown follow the search (searchBound at the bottom).
  const countsEl = el('span', { class: 'counts' });
  const visibleBuilt = t.showMore ? per.built : per.built.filter((x) => x.recent);
  const allSummary = [...per.queue, ...per.batch, ...(per.blocked ?? []), ...per.inProgress, ...per.review, ...visibleBuilt];
  const header = el(
    'header',
    {
      class: 'lane-header',
      tabindex: p.movable ? 0 : null,
      draggable: p.movable ? 'true' : null,
      'aria-label': p.movable
        ? `Project ${p.title ?? p.pid}. Space lifts the lane, the arrow keys move it.`
        : null,
    },
    p.movable ? icon('handle') : null,
    el('span', { class: 'dot', '--p': `var(--color-${p.color})` }),
    el('h2', { text: p.title ?? p.pid }),
    el('span', { class: 'pid', text: p.pid }),
    p.pause ? el('span', { class: 'badge old', text: 'paused' }) : null,
    p.priority_bonus
      ? el('span', {
          class: 'badge',
          text: `${p.priority_bonus > 0 ? '+' : ''}${p.priority_bonus}`,
          title: 'The project\'s priority bonus',
        })
      : null,
    countsEl,
    markLaneButton(p, per),
    p.movable ? pauseButton(p) : null,
  );
  const row = el(
    'div',
    { class: 'lane-row' },
    columns.map(({ key: col }) =>
      el(
        'div',
        { class: 'lane-cell', 'data-col': col },
        columnContent(col, per[col] ?? [], null, col === 'queue' ? per.batch : null),
      ),
    ),
  );
  const lane = el(
    'li',
    { class: 'lane', 'data-pid': p.pid, 'data-movable': p.movable ? '1' : null },
    header,
    row,
  );
  searchBound(allSummary, (match) => {
    const ids = new Set(match.map((k) => k.id));
    const n = (list) => list.filter((k) => ids.has(k.id)).length;
    countsEl.textContent = [
      n(per.queue) ? `${n(per.queue)} in queue` : null,
      n(per.batch) ? `${n(per.batch)} in batch queue` : null,
      n(per.blocked ?? []) ? `${n(per.blocked)} blocked` : null,
      n(per.inProgress) ? `${n(per.inProgress)} in progress` : null,
      n(per.review) ? `${n(per.review)} in review` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    // A lane selected in the Projects filter is shown even when empty (as before).
    lane.hidden = !match.length && !t.filter.selected.projects.has(p.pid);
  });
  return lane;
}

/** "Select" in the lane header selects the cards in the lane that can be bulk edited (in queue and batch queue, after the filter). */
function markLaneButton(p, per) {
  const summary = [...per.queue, ...per.batch];
  if (!summary.length) return null;
  // The button applies to the cards matching the search, and follows the search and the selection (searchBound).
  let ids = [];
  let all = false;
  const button = el('button', {
    type: 'button',
    class: 'pause-button',
    onclick: (e) => {
      e.stopPropagation();
      markMany(ids, !all);
    },
  });
  searchBound(summary, (match) => {
    ids = match.map((k) => k.id);
    all = ids.length > 0 && ids.every((id) => t.marked.has(id));
    button.hidden = !ids.length;
    button.textContent = all ? 'Deselect' : 'Select';
    button.setAttribute('aria-pressed', all ? 'true' : 'false');
    button.title = all
      ? `Remove the ${ids.length} cards in ${p.pid} from the selection`
      : `Select the ${ids.length} shown cards in queue and batch queue in ${p.pid}, for the selection menu`;
  });
  return button;
}

// ---- The Filter menu (one line with search and "Filter" instead of the chip row) ----
const filterButton = $('filter-button');
const filterMenu = $('filter-menu');

/**
 * Pause or resume a project (guard rule 6 warns when something is in progress). In the project's lane header only: it
 * changes the queue for everyone, so it is a command and not a filter (B28, UX review M1). The Filter menu points here.
 */
function pauseButton(p) {
  return el('button', {
    type: 'button',
    class: 'pause-button',
    'data-focus': `pause:${p.pid}`,
    text: p.pause ? 'Continue' : 'Pause',
    'aria-label': `${p.pause ? 'Continue' : 'Pause'} the project ${p.pid}`,
    onclick: (e) => {
      e.stopPropagation();
      action(
        { type: p.pause ? 'continue' : 'pause', pid: p.pid },
        `${p.pid}: ${p.pause ? 'continues' : 'paused'}`,
      );
    },
  });
}

/**
 * The Filter button says what is in use (QA-1d, Q10), and the menu is redrawn when it is open.
 *   nothing                      "Filter"
 *   checked filters only         "Filter · 2"
 *   a quick or saved filter      "Filter · Ready in focus" (the name wins over the count; a saved filter usually
 *                                brings its own checked filters, so the count is in the aria-label and tooltip)
 * The button has a fixed width (.filter-fixed) and the label is cut with an ellipsis (.filter-label), so a long name
 * never widens the top bar; the full text is in the tooltip. The search is not counted: it shows in its own box.
 */
function drawFilter() {
  const n = countFilters();
  const name = t.viewName ?? null;
  const text = name ? `Filter · ${name}` : n ? `Filter · ${n}` : 'Filter';
  // replaceChildren also drops the whitespace text nodes around the label from index.html.
  filterButton.replaceChildren(el('span', { class: 'filter-label', text }));
  filterButton.setAttribute(
    'aria-label',
    ['Filter', name ? `${name} in use` : null, n ? `${n} active` : null].filter(Boolean).join(', '),
  );
  filterButton.title = name
    ? `Filter: "${name}" is in use${n ? `, ${n} filters checked` : ''}. Quick filters, saved filters and the filter sections.`
    : n
      ? `Filter: ${n} checked. Quick filters, saved filters and the filter sections.`
      : 'Quick filters, saved filters and the filter sections. They change what you see, not the queue.';
  filterButton.classList.toggle('active', n > 0 || !!name || !!t.special);
  if (!filterMenu.hidden) drawFilterMenu();
}

/**
 * The first row of the Filter menu when anything narrows the board: "Select all N matches" (Q9, it used to sit in the
 * top bar) and "Show all" (clears the quick or saved filter, the checked filters and the search). Null otherwise.
 */
function filterTopRow() {
  const mm = markMatchState();
  const anything = !!t.special || !!t.viewName || countFilters() > 0 || !!t.filter.search;
  if (!mm && !anything) return null;
  return el(
    'div',
    { class: 'filter-footer filter-top' },
    mm
      ? el('button', {
          type: 'button',
          class: 'button button-outline button-small',
          'data-focus': 'mark-match',
          text: mm.all ? `All ${mm.n} matches selected` : `Select all ${mm.n} matches`,
          disabled: mm.all,
          title:
            'Select every card shown after the search and the filter that can be changed together (in queue, proposed ' +
            'and batch queue), for the selection menu. Shortcut: Ctrl/Cmd+A.',
          onclick: () => {
            // The menu closes first, with focus on Filter: the next step is the selection menu, not this menu.
            closeFilter(true);
            markAllMatch();
          },
        })
      : null,
    anything
      ? el('button', {
          type: 'button',
          class: 'button button-outline button-small',
          'data-focus': 'show-all',
          text: 'Show all',
          title: 'Remove the quick or saved filter, the checked filters and the search, and show every card again',
          onclick: showAll,
        })
      : null,
  );
}

function drawFilterMenu() {
  const focus = filterMenu.contains(document.activeElement)
    ? document.activeElement.dataset.focus
    : null;
  // Open cards per project (In queue, Blocked, In progress, Review).
  const opened = new Map();
  for (const col of ['queue', 'blocked', 'inProgress', 'review'])
    for (const k of t.data?.columns[col] ?? [])
      opened.set(k.project, (opened.get(k.project) ?? 0) + 1);
  // A section with nothing to choose (Plan entry before any task has one) is not drawn: no lone "Select all" (B28, M2).
  const sections = FILTER_SECTIONS.map((s) => ({ s, option: s.option() })).filter((x) => x.option.length);
  const parts = sections.map(({ s, option }) => {
    const selected = t.filter.selected[s.key];
    const all = option.length > 0 && option.every((v) => selected.has(v.val));
    return el(
      'section',
      { class: 'filter-section', 'aria-labelledby': `filter-${s.key}` },
      el(
        'div',
        { class: 'filter-section-header' },
        el('h3', { id: `filter-${s.key}`, text: s.title }),
        el('button', {
          type: 'button',
          class: 'link-button',
          'data-focus': `all:${s.key}`,
          text: all ? 'Select none' : 'Select all',
          onclick: () => {
            if (all) selected.clear();
            else for (const v of option) selected.add(v.val);
            changedFilter();
          },
        }),
      ),
      el(
        'ul',
        { class: 'filter-list' },
        option.map((v) => {
          const id = `f-${s.key}-${v.val}`;
          const p = v.project;
          return el(
            'li',
            { class: 'filter-row' },
            el('input', {
              type: 'checkbox',
              id,
              'data-focus': id,
              checked: selected.has(v.val),
              onchange: (e) => {
                if (e.target.checked) selected.add(v.val);
                else selected.delete(v.val);
                changedFilter();
              },
            }),
            el(
              'label',
              { for: id, title: p?.title ?? null },
              p ? el('span', { class: 'dot', '--p': `var(--color-${p.color})` }) : null,
              el('span', { class: 'filter-name', text: v.text }),
              // "paused" is state, so it stays; the command itself is in the lane header.
              p?.pause ? el('span', { class: 'paused', text: 'paused' }) : null,
              p
                ? el('span', {
                    class: 'filter-count',
                    text: String(opened.get(p.pid) ?? 0),
                    title: 'Open: in queue, in progress and review',
                  })
                : null,
            ),
          );
        }),
      ),
      s.key === 'projects' ? pauseHint(option) : null,
    );
  });
  parts.push(
    el(
      'div',
      { class: 'filter-footer' },
      el('button', {
        type: 'button',
        class: 'button button-outline',
        'data-focus': 'reset',
        text: 'Reset',
        disabled: countFilters() === 0,
        onclick: () => {
          for (const set of Object.values(t.filter.selected)) set.clear();
          changedFilter();
        },
      }),
    ),
  );
  // QA-1d: the top row, then Quick filters and Saved (board/views.js), then the filter sections and Reset.
  // replaceChildren() turns null into the text "null", so the top row is added only when it exists.
  const top = filterTopRow();
  filterMenu.replaceChildren(...(top ? [top] : []), ...presetSections(), ...parts);
  if (focus) filterMenu.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
}

/** The rows the arrow keys move between: the quick and saved filters, then the checkboxes, in menu order. */
const filterRows = () => [...filterMenu.querySelectorAll('.view-option, input[type="checkbox"]')];

/**
 * The line under Projects that says where Pause went: a view switch to Project lanes, never the command itself. The
 * focus lands on the first lane's Pause, so the keyboard way is one Enter more than before. Only when a project can be paused.
 */
function pauseHint(option) {
  if (!option.some((v) => v.project?.movable)) return null;
  return el(
    'p',
    { class: 'filter-hint' },
    "Pause and resume sit in each project's lane header. ",
    el('button', {
      type: 'button',
      class: 'link-button',
      'data-focus': 'pause-hint',
      text: 'Show project lanes',
      onclick: () => {
        closeFilter(false);
        setView('lanes');
        draw();
        main.querySelector('.lane-header [data-focus^="pause:"]')?.focus();
      },
    }),
  );
}

function changedFilter() {
  saveFilter();
  draw();
}
function openFilter() {
  saveAsOpen = false;
  filterMenu.hidden = false;
  filterButton.setAttribute('aria-expanded', 'true');
  drawFilterMenu();
  filterRows()[0]?.focus();
}
function closeFilter(focusOn) {
  if (filterMenu.hidden) return;
  filterMenu.hidden = true;
  filterButton.setAttribute('aria-expanded', 'false');
  if (focusOn) filterButton.focus();
}
filterButton.addEventListener('click', () =>
  filterMenu.hidden ? openFilter() : closeFilter(true),
);
filterMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.id === 'view-name') {
    // Esc in the name field closes the field, not the menu.
    e.preventDefault();
    e.stopPropagation();
    saveAsOpen = false;
    drawFilterMenu();
    filterMenu.querySelector('[data-focus="save-as"]')?.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFilter(true);
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.id !== 'view-name') {
    // The arrow keys move between the rows (quick filters, saved filters, the checkboxes); Enter picks a filter,
    // Space checks a box, and Tab still reaches Delete, "Save current as…" and the section buttons.
    const rows = filterRows();
    const i = rows.indexOf(document.activeElement);
    const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    rows[j]?.focus();
  }
});
// A click outside closes. composedPath is the path when the click happened, so an element the menu just redrew still counts.
document.addEventListener('click', (e) => {
  if (filterMenu.hidden) return;
  const filePath = e.composedPath();
  if (!filePath.includes(filterMenu) && !filePath.includes(filterButton)) closeFilter(false);
});
