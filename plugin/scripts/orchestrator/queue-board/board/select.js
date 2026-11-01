// =============================================================
// select.js: multi-select and the selection bar for bulk actions.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Multi-select and bulk actions ----
// The owner selects cards (checkbox, x, Ctrl/Cmd-click, Shift-click, Ctrl/Cmd+A, "Select all matches", group, lane,
// chain or feature) and does one thing with all of them from the selection bar at the bottom. Every action is previewed first
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

/** The checkbox on a card (shown on hover and focus, and always when something is selected). */
function markBox(k) {
  return el(
    'label',
    {
      class: 'mark-box',
      title:
        'Select the card for the selection bar (bulk actions). Shortcuts: x on the card, Ctrl/Cmd-click, Shift-click selects ' +
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
    `${ids.length} selected. Pick an action in the bar at the bottom, or Esc to clear the selection.`,
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

// What every action does (title, explanation in the dialog, tooltip on the button in the selection bar).
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
  // The "Sort" list in "Waiting on you".
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

/** The selection bar at the bottom: count (and how many are hidden by the filter), minutes and the actions. */
function drawOptionLine() {
  const line = $('optionLine');
  const summary = [...t.marked].map((id) => t.perId.get(id)).filter(Boolean);
  if (!summary.length || !t.data || t.view === 'statistics') {
    line.hidden = true;
    line.replaceChildren();
    document.body.classList.remove('with-option-line');
    return;
  }
  const hidden = summary.filter((x) => !visible(x.k, x.col)).length;
  const min = summary.reduce((s, x) => s + (Number(x.k.estimate) || 0), 0);
  const allBatch = summary.every((x) => x.col === 'batch');
  const anyBatch = summary.some((x) => x.col === 'batch');
  const anyParked = summary.some((x) => x.k.parked);
  const button = (text, title, fn, cls = 'button-outline') =>
    el('button', {
      type: 'button',
      class: `button ${cls} button-small`,
      text,
      title: title,
      onclick: fn,
    });
  line.replaceChildren(
    el('p', {
      class: 'option-tall',
      text:
        `${summary.length} selected` +
        (hidden ? ` (${hidden} hidden by the filter)` : '') +
        ` · ${duration(min)}`,
      title: hidden
        ? `${hidden} of the selected are not shown with the search and the filter now, but are included in the action.`
        : 'Number selected and the sum of the estimates.',
    }),
    el(
      'div',
      { class: 'option-buttons', role: 'toolbar', 'aria-label': 'Bulk actions for the selected' },
      button(
        'Move to project',
        `${BULK_INFO.project.explanation} You see the change before it is saved.`,
        () => openBulk('project'),
      ),
      button('Feature', BULK_INFO.feature.explanation, () => openBulk('feature')),
      button('Put on hold', BULK_INFO.park.explanation, () => openBulk('park')),
      anyParked
        ? button('Take off hold', BULK_INFO.continue.explanation, () => openBulk('continue'))
        : null,
      button('Move as block', BULK_INFO.rank.explanation, () => openBulk('rank')),
      !allBatch
        ? button('Add to batch queue', BULK_INFO['batch-in'].explanation, () =>
            openBulk('batch-in'),
          )
        : null,
      anyBatch
        ? button('Take out of batch queue', BULK_INFO['batch-out'].explanation, () =>
            openBulk('batch-out'),
          )
        : null,
      allBatch && summary.length >= 2
        ? button(
            'Pack into track',
            BULK_INFO['batch-pack'].explanation,
            () => openBulk('batch-pack'),
            'button-muted',
          )
        : null,
      button('Label', BULK_INFO.label.explanation, () => openBulk('label')),
      button('Clear selection', 'Remove all from the selection (Esc). Nothing in the queue changes.', emptyOption),
    ),
  );
  line.hidden = false;
  document.body.classList.add('with-option-line');
}
