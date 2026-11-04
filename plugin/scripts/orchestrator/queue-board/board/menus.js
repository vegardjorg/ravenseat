// =============================================================
// menus.js: the help ("How to use the board") with the legend, the project lanes and the Filter menu.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// "How to use the board" (in the gear): short help in the side panel.
const HELP = [
  [
    'Areas',
    'An area groups projects that belong together, for example Auth or Payments and invoicing. ' +
      'You prioritize areas instead of many projects. Create and edit them with "Areas …" in Queue → Focus. A project ' +
      'belongs to one area.',
  ],
  [
    'Focus',
    'The focus is the order in which the queue takes work: everything in step 1 before step 2, regardless of score. Within a ' +
      'step the points apply. A step is an area, a project or a feature. The most specific wins: a project with ' +
      'a step of its own takes precedence over its area\'s step. "Rest waits" means nothing outside the steps starts; "fill ' +
      'free slots" starts them only when the focus has nothing ready. Tasks that something in focus waits on are dragged ' +
      'along. The focus applies until you change it, or until the end date. The focus line at the top turns red when the focus ' +
      'has nothing ready, and says which answer unlocks the most.',
  ],
  [
    'The Focus tab',
    'Focus shows the focus as four columns: Now and Next (the steps in order), Later (the rest) and Waiting ' +
      '(projects on pause). Drag areas, projects and features between the columns, or lift with Space, ' +
      'move with the arrow keys and drop with Space (Esc cancels). The changes are a draft until you press "Save ' +
      'focus"; then you first see what changes and what the queue starts next.',
  ],
  [
    'Plans and Queue',
    'The switch at the top left changes workspace. Plans opens on the Overview, with one card per area. "Plan entries" ' +
      'is the plan register: area › project › entry in the list (click to fold), the details on the right, and the filters ' +
      'with counts on the left (on a narrower screen behind the "Filters" button). The copy buttons give the start line for ' +
      '/plans. A badge like PL-ALONE-1 on a card opens the entry in Plans; the Queue tab in the entry\'s ' +
      'details lists its tasks, and a click shows the card here.',
  ],
  [
    'Waiting on you',
    'Owner questions, QA, proposed and what is stuck. With a focus, the questions are sorted by what the answer unlocks in ' +
      'the focus (step 1 first). "Sort" shows tasks without a project or with the wrong project, with proposals you can ' +
      'accept.',
  ],
  [
    'Batch queue',
    'Small tasks that do not block anything can go into the batch queue. There they do not start alone, but are packed ' +
      'together into one track of the right size ("Pack into track" when the group is large enough). D+, tasks others wait on and ' +
      'tasks with open owner questions cannot be there.',
  ],
  [
    'Bulk actions',
    'Select cards with the checkbox, x on the card, Ctrl/Cmd-click or Shift-click, Ctrl/Cmd+A or "Select all ' +
      'matches". The group header selects the whole group. The selection bar at the bottom moves to a project, puts on hold, moves as ' +
      'a block, adds to the batch queue or sets a label. You always see what changes before it is saved, everything happens ' +
      'together or not at all, and "Undo" is ready afterward. Esc clears the selection.',
  ],
  [
    'Selection, tabs and grouping',
    '"Selection" has built-in selections (Focus now, Ready in focus, On hold, Sort, New since last visit …) and your own ' +
      '(search, filter, grouping and view), saved in this browser. "Show all" at the top of the menu removes ' +
      'the selection. The tabs (Flat, Project lanes, Focus …) are the views; the arrow keys move between them, Enter selects. ' +
      'The grouping beside the tabs ' +
      'splits the cards by area and project, project and feature, or focus step.',
  ],
  [
    'The keyboard on the board',
    'Tab goes to one card title per column (or per cell in Project lanes). Arrow up and down move between the cards, ' +
      'arrow left and right to the neighboring column, Home and End to the first and last card. Enter opens the card, x selects ' +
      'it, and Space lifts a card in the queue (the arrow keys move, Space drops, Esc cancels). "Blocked" is ' +
      'closed from the start; open it to see the cards there.',
  ],
];

// The legend for the classes, WIP and the badges on the cards. Shown in the help and in the statistics tab,
// because the tooltips do not work on touch or with the keyboard.
const BADGES = [
  ['badge ready-badge', 'Ready now', 'Can start now: no blockers.'],
  ['badge', '45 min', 'Estimated content in minutes.'],
  ['badge visual', 'visual', 'The owner does a visual check after delivery.'],
  ['badge wait-badge', 'on hold', 'Parked until a date or an event.'],
  ['badge locks', 'unlocks 3', 'This many tasks are waiting on this one via the chain.'],
  ['badge cloud-badge', 'Cloud', 'Running in a cloud session.'],
  ['badge old', 'old', 'Picked or registered outside the queue more than 72 hours ago.'],
  ['badge tone-warn silent-badge', 'silent', 'Running with an agent, but no sign of life for a while (cq show says what to do).'],
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
            class: `badge${k.class === 'D+' ? ' class-dplus' : ''}`,
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
      BADGES.map(([cls, text, explanation]) =>
        row(el('span', { class: cls, text }), explanation),
      ),
      row(
        el('span', { class: 'summary-project', text: 'project' }),
        'The project\'s short name; the color stripe on the left of the card is the project\'s color. Not shown when the cards ' +
          'are already grouped per project.',
      ),
      row(
        el('span', { class: 'explanation-edge', text: 'dashed edge' }),
        'Blocked: waiting on something (the blocker is at the bottom of the card). Solid edge in the primary color: ready now.',
      ),
    ),
  );
}

function openHelp() {
  t.selected = null;
  t.setting = null;
  t.inbox = false;
  t.help = true;
  showPanel();
  panel.scrollTop = 0;
  panel.replaceChildren(
    el(
      'div',
      { class: 'panel-header' },
      el('div', null, el('h2', { id: 'panel-title', text: 'How to use the board' })),
      el(
        'button',
        { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
        icon('close'),
      ),
    ),
    ...HELP.map(([title, text]) =>
      el(
        'section',
        { class: 'help-del' },
        el('h3', { class: 'setting-title', text: title }),
        el('p', { class: 'help-text', text }),
      ),
    ),
    legend('help'),
    el('p', {
      class: 'inbox-info',
      text:
        'Everything the board writes goes via cq with a lock, and nothing changes before you have seen the explanation and confirmed.',
    }),
  );
  panel.querySelector('.button-icon')?.focus();
}
// The help opens from the gear (the button at the top of the settings), no longer from "?" at the top.

function laneEl(p, per) {
  // The numbers in the lane header and whether the lane is shown follow the search (searchBound at the bottom).
  const countsEl = el('span', { class: 'counts' });
  const visibleBuilt = t.showMore ? per.built : per.built.filter((x) => x.recent);
  const allSummary = [...per.queue, ...per.batch, ...per.inProgress, ...per.review, ...visibleBuilt];
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
    ['queue', 'inProgress', 'review', 'built'].map((col) =>
      el(
        'div',
        { class: 'lane-cell', 'data-col': col },
        columnContent(col, per[col], null, col === 'queue' ? per.batch : null),
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
      : `Select the ${ids.length} shown cards in queue and batch queue in ${p.pid}, for the selection bar`;
  });
  return button;
}

// ---- The Filter menu (one line with search and "Filter" instead of the chip row) ----
const filterButton = $('filter-button');
const filterMenu = $('filter-menu');

/** Pause or resume a project (guard rule 6 warns when something is in progress). In the Filter menu and the lane header. */
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

/** The button shows the number of active filters; the menu is redrawn when it is open. */
function drawFilter() {
  const n = countFilters();
  filterButton.textContent = n ? `Filter · ${n}` : 'Filter';
  filterButton.setAttribute('aria-label', n ? `Filter, ${n} active` : 'Filter');
  filterButton.classList.toggle('active', n > 0);
  if (!filterMenu.hidden) drawFilterMenu();
}

function drawFilterMenu() {
  const focus = filterMenu.contains(document.activeElement)
    ? document.activeElement.dataset.focus
    : null;
  // Open cards per project (In queue, In progress, Review).
  const opened = new Map();
  for (const col of ['queue', 'inProgress', 'review'])
    for (const k of t.data?.columns[col] ?? [])
      opened.set(k.project, (opened.get(k.project) ?? 0) + 1);
  const parts = FILTER_SECTIONS.map((s) => {
    const option = s.option();
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
              p?.pause ? el('span', { class: 'paused', text: 'paused' }) : null,
              p
                ? el('span', {
                    class: 'filter-count',
                    text: String(opened.get(p.pid) ?? 0),
                    title: 'Open: in queue, in progress and review',
                  })
                : null,
            ),
            p?.movable ? pauseButton(p) : null,
          );
        }),
      ),
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
  filterMenu.replaceChildren(...parts);
  if (focus) filterMenu.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
}

function changedFilter() {
  saveFilter();
  draw();
}
function openFilter() {
  filterMenu.hidden = false;
  filterButton.setAttribute('aria-expanded', 'true');
  drawFilterMenu();
  filterMenu.querySelector('input')?.focus();
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
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFilter(true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    // The arrow keys move between the rows (the checkboxes); Space checks.
    const rows = [...filterMenu.querySelectorAll('input[type="checkbox"]')];
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
