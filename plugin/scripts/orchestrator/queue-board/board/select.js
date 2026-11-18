// =============================================================
// select.js: multi-select and the selection menu for bulk actions.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Multi-select and bulk actions ----
// The owner selects cards (checkbox, x, Ctrl/Cmd-click, Shift-click, Ctrl/Cmd+A, "Select all matches", group, lane,
// chain or feature) and does one thing with all of them from the selection menu. On a wide screen with a mouse the menu
// is a short vertical list next to the checkbox checked last; on a narrow screen or touch it is a bar at the bottom.
// Every action is previewed first
// (/api/bulk with dry: queue.mjs works out what changes, without writing), and saved only when the owner presses
// "Do it" (with the queue version from the preview, so a queue changed meanwhile is not overwritten). Afterwards
// "Undo" is ready for 30 seconds, and "Undo last" in the gear. The board always sends the id list the owner saw.

/** A text field where keys belong to the field (checkboxes do not count). */
function inputField(e) {
  if (!e) return false;
  if (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') return true;
  return e.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(e.type);
}

/** Can the card be bulk edited now (in queue, proposed or batch queue)? */
function markable(id) {
  const x = t.perId.get(id);
  return !!x && MARKABLE_COLUMNS.has(x.col);
}

/** "On hold through 2026-10-12: waiting on vendor (set by owner)". */
function waitText(p) {
  return (
    `On hold${p.to ? ` through ${String(p.to).slice(0, 10)}` : ' until you take it off'}` +
    (p.reason ? `: ${p.reason}` : '') +
    (p.by ? ` (set by ${p.by})` : '') +
    '. It stays in the queue, but is not started or picked.'
  );
}

/** The checkbox on a card (always visible on a card that can be selected). */
function markBox(k) {
  return el(
    'label',
    {
      class: 'mark-box',
      title:
        'Select the card for the selection menu (bulk actions). Shortcuts: x on the card, Ctrl/Cmd-click, Shift-click selects ' +
        'everything from the previous selected, Ctrl/Cmd+A selects all matches, Esc clears the selection.',
    },
    el('input', {
      type: 'checkbox',
      checked: t.marked.has(k.id),
      'aria-label': `Select ${k.id}`,
      tabindex: '-1', // roving tabindex: only the card that is the stop in the column; x selects too
      onclick: (e) => {
        // Shift-click on the box also selects everything from the previous selected.
        if (e.shiftKey && t.anchor && t.anchor !== k.id) {
          e.preventDefault();
          markArea(t.anchor, k.id);
        }
      },
      onchange: (e) => markMany([k.id], e.target.checked),
    }),
  );
}

/** Selects (on = true) or removes the ids from the selection, and redraws the selection. */
function markMany(ids, on) {
  for (const id of ids) {
    if (!markable(id)) continue;
    if (on) t.marked.add(id);
    else t.marked.delete(id);
  }
  const last = ids.filter(markable).pop();
  if (on && last) t.anchor = last;
  // The selection menu opens next to the box touched last, and a menu closed with Esc opens again on the next change.
  if (last) t.menuAnchor = last;
  t.optionClosed = false;
  updateMarking();
}

/** Shift: selects all cards between `from` and `to` on the board now (both included). */
function markArea(from, to) {
  const sequence = [...main.querySelectorAll('.summary[data-markable]:not([hidden])')].map(
    (e) => e.dataset.id,
  );
  const i = sequence.indexOf(from);
  const j = sequence.indexOf(to);
  if (i < 0 || j < 0) return markMany([to], true);
  markMany(sequence.slice(Math.min(i, j), Math.max(i, j) + 1), true);
  t.anchor = to;
  // The menu belongs next to the box that was Shift-clicked, also when the range ran upwards.
  if (t.menuAnchor !== to) {
    t.menuAnchor = to;
    placeOptionMenu();
  }
}

/** The cards shown after search and filter that can be bulk edited (what "Select all matches" and Ctrl+A take). */
function visibleMarkable() {
  if (!t.data) return [];
  const out = [];
  for (const col of MARKABLE_COLUMNS)
    for (const k of t.data.columns[col] ?? []) if (visible(k, col)) out.push(k.id);
  return out;
}

function markAllMatch() {
  const ids = visibleMarkable();
  if (!ids.length)
    return message('No cards in queue, proposed or batch queue match the search and the filter.', true);
  markMany(ids, true);
  message(
    `${ids.length} selected. Pick an action in the selection menu, or Esc to clear the selection.`,
  );
}

function emptyOption() {
  t.marked.clear();
  t.anchor = null;
  updateMarking();
}

function updateMarking() {
  if (drag || boosted) return;
  // In Flat and Project lanes the selection is set on the existing cards (no rebuild).
  if (t.data && (t.view === 'flat' || t.view === 'lanes')) {
    for (const node of main.querySelectorAll('.summary[data-markable]')) syncSummary(node);
    main.classList.toggle('has-option', t.marked.size > 0);
    updateSearchDep(); // the group boxes, "Select" in the lane header and batch queue
    drawOptionLine();
    drawMarkMatch();
    if (t.selected) drawPanel();
    return;
  }
  draw();
}

/** "Select all matches (N)" by the search: when search or filter is in use, and something can be selected. */
function drawMarkMatch() {
  const button = $('mark-match');
  const search = !!t.filter.search || countFilters() > 0;
  const ids = search && t.view !== 'statistics' && t.view !== 'cloud' ? visibleMarkable() : [];
  button.hidden = !ids.length;
  if (!ids.length) return;
  const all = ids.every((id) => t.marked.has(id));
  button.textContent = all
    ? `All matches selected (${ids.length})`
    : `Select all matches (${ids.length})`;
  button.disabled = all;
  button.title =
    'Select all cards shown after the search and the filter that can be changed together (in queue, proposed and batch queue). ' +
    'Shortcut: Ctrl/Cmd+A.';
}
$('mark-match').addEventListener('click', markAllMatch);

// What every action does (title, explanation in the dialog, tooltip on the row in the selection menu).
const BULK_INFO = {
  project: {
    title: 'Move to project',
    explanation:
      'The tasks get a fixed project. The project controls the lane, the color, the pause and the priority bonus they get.',
  },
  feature: {
    title: 'Set feature',
    explanation:
      'Feature groups tasks within the project (project, feature, task). An empty field removes the feature.',
  },
  park: {
    title: 'Put on hold',
    explanation:
      'The tasks stay in the queue with status waiting, but are not started or picked until you take them off hold. ' +
      'With a date the hold ends by itself after that day.',
  },
  continue: {
    title: 'Take off hold',
    explanation: 'The tasks can be started and picked again, in the order the priority gives.',
  },
  rank: {
    title: 'Move as block',
    explanation:
      'The tasks are moved together within the focus step and keep their order among themselves. The board works out new ' +
      'priority bonuses; the points otherwise do not change.',
  },
  'batch-in': {
    title: 'Add to batch queue',
    explanation:
      'Small tasks that do not block anything are not started alone, but packed together into a track of the right size. ' +
      'D+, tasks others wait on, and tasks with unanswered owner questions cannot be there.',
  },
  'batch-out': {
    title: 'Take out of batch queue',
    explanation: 'The tasks are started as their own tracks again, in the order the priority gives.',
  },
  'batch-pack': {
    title: 'Pack into track',
    explanation:
      'The tasks are merged into one new track with the same class: the content minutes are added together, ownership and ' +
      'dependencies merged, and the mission file gets all the parts\' missions. The parts are canceled with a remark. Packing ' +
      'cannot be undone with "Undo".',
  },
  label: {
    title: 'Label',
    explanation:
      'Add or remove a label (one short word in lowercase). The label "visual" gives a QA queue when the task is ' +
      'done.',
  },
  undo: {
    title: 'Undo last change',
    explanation:
      'Rolls back the last entry in the change log. It is refused when someone has changed the same fields since.',
  },
  // The "Sort" list in Decisions.
  'accept-suggestion': {
    title: 'Accept proposed project',
    explanation:
      'Every task gets the project the queue proposes from the prefix, the plan it comes from and the files it touches. ' +
      'The project decides the area and thus the focus step the task ends up in. Can be undone.',
  },
};
// The actions where all fields are optional: the preview comes as soon as the dialog opens.
const AUTO_PREVIEW = new Set([
  'continue',
  'batch-in',
  'batch-out',
  'batch-pack',
  'park',
  'accept-suggestion',
]);

const countText = (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

// ---- The selection menu ----
// One rendering function with two layouts. On a wide screen with a mouse (the board runs mostly on a PC) it is a short
// vertical menu, like a Windows context menu, that opens next to the checkbox checked last and follows the next one.
// On a narrow screen or touch it is the bar at the bottom (the right pattern there). Same actions, same conditions.

/** The media query for the bar layout: narrow screens (below 600 px) and touch without hover. */
const OPTION_BAR_MEDIA = '(max-width: 599px), (hover: none)';
const optionAsBar = () => !!window.matchMedia?.(OPTION_BAR_MEDIA).matches;
// Distance from the box to the menu, and the smallest distance from the menu to the viewport edge (px).
const MENU_GAP = 4;
const MENU_EDGE = 8;

/** The checkbox (its 24 x 36 target, the label) the menu opens next to, when it is on screen; else null. */
function optionAnchorBox() {
  const ids = [t.menuAnchor, ...[...t.marked].reverse()].filter(Boolean);
  for (const id of ids) {
    const summary = main.querySelector(`.summary[data-markable][data-id="${CSS.escape(id)}"]:not([hidden])`);
    const box = summary?.querySelector('.mark-box');
    if (!box) continue;
    const r = box.getBoundingClientRect();
    // A box in a closed section or scrolled out of the window has nothing to open next to.
    if ((r.width || r.height) && r.bottom > 0 && r.top < window.innerHeight) return box;
  }
  return null;
}

/**
 * Places the menu next to the anchor box: to the right with its top at the box top; flipped to the left near the
 * right edge and upwards near the bottom, then clamped inside the viewport. Horizontally it never overlaps the box,
 * so it does not cover the checkbox it came from. Without a box on screen it sits in the bottom right corner.
 */
function placeOptionMenu() {
  const line = $('optionLine');
  if (line.hidden || !line.classList.contains('as-menu')) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = line.getBoundingClientRect();
  const box = optionAnchorBox();
  let left = vw - MENU_EDGE - m.width;
  let top = vh - MENU_EDGE - m.height;
  if (box) {
    const b = box.getBoundingClientRect();
    left = b.right + MENU_GAP;
    if (left + m.width > vw - MENU_EDGE) left = b.left - MENU_GAP - m.width;
    top = b.top;
    if (top + m.height > vh - MENU_EDGE) top = b.bottom - m.height;
  }
  const clamp = (v, max) => Math.max(MENU_EDGE, Math.min(v, max));
  line.style.left = `${Math.round(clamp(left, vw - MENU_EDGE - m.width))}px`;
  line.style.top = `${Math.round(clamp(top, vh - MENU_EDGE - m.height))}px`;
}

/** The rows of the open menu (empty in the bar layout). */
const optionRows = () => [...$('optionLine').querySelectorAll('[role="menuitem"]')];

/** Focus goes back to the box the menu came from (or the card's title, or the first card in the column). */
function focusOptionAnchor(box = optionAnchorBox()) {
  const target =
    box?.querySelector('input') ??
    main.querySelector('.summary-button[tabindex="0"]') ??
    main.querySelector('.summary-button');
  target?.focus({ preventScroll: true });
}

/** Opens the menu (also after Esc closed it) and puts focus on its first row. Shift+F10 on a card. */
function openOptionMenu() {
  if (!t.marked.size) return;
  t.optionClosed = false;
  drawOptionLine();
  optionRows()[0]?.focus();
}

/** Esc in the menu: it closes, the selection stays, and focus goes back to the checkbox. */
function closeOptionMenu() {
  const box = optionAnchorBox();
  t.optionClosed = true;
  drawOptionLine();
  focusOptionAnchor(box);
}

/** The selection menu or bar: count (and how many are hidden by the filter), minutes and the actions. */
function drawOptionLine() {
  const line = $('optionLine');
  const summary = [...t.marked].map((id) => t.perId.get(id)).filter(Boolean);
  const bar = optionAsBar();
  if (!summary.length || !t.data || t.view === 'statistics' || (t.optionClosed && !bar)) {
    line.hidden = true;
    line.replaceChildren();
    document.body.classList.remove('with-option-line');
    return;
  }
  // A redraw (a new version from the server, another box) keeps the focus on the same row.
  const focused = line.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  const hidden = summary.filter((x) => !visible(x.k, x.col)).length;
  const min = summary.reduce((s, x) => s + (Number(x.k.estimate) || 0), 0);
  const allBatch = summary.every((x) => x.col === 'batch');
  const anyBatch = summary.some((x) => x.col === 'batch');
  const anyParked = summary.some((x) => x.k.parked);
  // A row in the menu, a button in the bar. `action` names it (the focus after a redraw).
  const button = (action, text, title, fn, cls = 'button-outline') =>
    el('button', {
      type: 'button',
      class: bar ? `button ${cls} button-small` : 'option-item',
      role: bar ? null : 'menuitem',
      tabindex: bar ? null : '-1',
      'data-action': action,
      text,
      title: title,
      onclick: fn,
    });
  const clear = () => {
    const box = optionAnchorBox();
    emptyOption();
    if (!bar) focusOptionAnchor(box);
  };
  const actions = [
    button(
      'project',
      'Move to project',
      `${BULK_INFO.project.explanation} You see the change before it is saved.`,
      () => openBulk('project'),
    ),
    button('feature', 'Feature', BULK_INFO.feature.explanation, () => openBulk('feature')),
    button('park', 'Put on hold', BULK_INFO.park.explanation, () => openBulk('park')),
    anyParked
      ? button('continue', 'Take off hold', BULK_INFO.continue.explanation, () => openBulk('continue'))
      : null,
    button('rank', 'Move as block', BULK_INFO.rank.explanation, () => openBulk('rank')),
    !allBatch
      ? button('batch-in', 'Add to batch queue', BULK_INFO['batch-in'].explanation, () =>
          openBulk('batch-in'),
        )
      : null,
    anyBatch
      ? button('batch-out', 'Take out of batch queue', BULK_INFO['batch-out'].explanation, () =>
          openBulk('batch-out'),
        )
      : null,
    allBatch && summary.length >= 2
      ? button(
          'batch-pack',
          'Pack into track',
          BULK_INFO['batch-pack'].explanation,
          () => openBulk('batch-pack'),
          'button-muted',
        )
      : null,
    button('label', 'Label', BULK_INFO.label.explanation, () => openBulk('label')),
    // In the menu a separator keeps "Clear selection" apart from the actions that change the queue.
    bar ? null : el('div', { role: 'separator', class: 'option-separator' }),
    button(
      'clear',
      'Clear selection',
      'Remove all from the selection (Esc). Nothing in the queue changes.',
      clear,
    ),
  ].filter(Boolean); // replaceChildren() would turn null into the text "null"
  const time = duration(min);
  const count = bar
    ? el('p', {
        class: 'option-tall',
        id: 'option-count',
        text: `${summary.length} selected` + (hidden ? ` (${hidden} hidden by the filter)` : '') + ` · ${time}`,
      })
    : el(
        'p',
        { class: 'option-tall', id: 'option-count' },
        `${summary.length} selected · ${time}`,
        hidden ? el('span', { class: 'option-hidden', text: `${hidden} hidden by the filter` }) : null,
      );
  count.title = hidden
    ? `${hidden} of the selected are not shown with the search and the filter now, but are included in the action.`
    : 'Number selected and the sum of the estimates.';
  line.classList.toggle('as-menu', !bar);
  line.replaceChildren(
    count,
    el(
      'div',
      bar
        ? { class: 'option-buttons', role: 'toolbar', 'aria-label': 'Bulk actions for the selected' }
        : {
            class: 'option-buttons',
            role: 'menu',
            'aria-label': 'Bulk actions for the selected',
            'aria-describedby': 'option-count',
          },
      ...actions,
    ),
  );
  line.hidden = false;
  // Only the bar needs room under the board (and lifts the toasts); the menu floats next to the box.
  document.body.classList.toggle('with-option-line', bar);
  if (bar) {
    line.style.left = '';
    line.style.top = '';
    return;
  }
  // One tab stop in the menu (roving tabindex): the row that had focus, else the first.
  const rows = optionRows();
  const stop = rows.find((r) => r.dataset.action === focused) ?? rows[0];
  if (stop) stop.tabIndex = 0;
  placeOptionMenu();
  if (focused && stop) stop.focus({ preventScroll: true });
}

// The keys in the menu: arrows (wrapping), Home and End move between the rows, Enter and Space press the row (the
// button's own), Esc closes the menu and puts focus back on the checkbox. In the bar Esc goes on to the document as
// before (it clears the selection).
$('optionLine').addEventListener('keydown', (e) => {
  const rows = optionRows();
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement);
  let j = null;
  if (e.key === 'ArrowDown') j = (i + 1) % rows.length;
  else if (e.key === 'ArrowUp') j = (i - 1 + rows.length) % rows.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = rows.length - 1;
  else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeOptionMenu();
    return;
  }
  if (j === null) return;
  e.preventDefault();
  for (const r of rows) r.tabIndex = -1;
  rows[j].tabIndex = 0;
  rows[j].focus();
});

// Shift+F10 (the Windows key for a context menu) on a card or its checkbox opens the selection menu and moves focus
// into it, also after Esc has closed it.
main.addEventListener('keydown', (e) => {
  if (e.key !== 'F10' || !e.shiftKey || !t.marked.size || boosted || optionAsBar()) return;
  if (!e.target.closest?.('.summary')) return;
  e.preventDefault();
  openOptionMenu();
});

// The menu follows its box when the board or a column scrolls (capture: columns scroll on their own), and a resize
// can switch between the menu and the bar.
document.addEventListener('scroll', placeOptionMenu, true);
window.addEventListener('resize', () => {
  if (t.marked.size) drawOptionLine();
});
