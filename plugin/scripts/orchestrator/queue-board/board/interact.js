// =============================================================
// interact.js: writing (always via the server, which runs queue.mjs; the guard rules first), drag with
// the mouse, click and keyboard, and the roving tabindex.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Writing (always via the server, which runs queue.mjs; the guard rules first) ----
/** A write action via the server. Returns true when it was completed (not aborted or rejected). */
async function action(body, ok) {
  let completed = false;
  const release = busyButton(lastButton);
  lastButton = null;
  try {
    const answer = await writeWithGuard('/api/action', body);
    if (answer) {
      messageWithInfo(ok, answer);
      if (body.id) t.details.delete(body.id);
      completed = true;
    }
  } catch (e) {
    message(e.message, true);
    release(); // error: the button can be used again right away
  }
  await update(true);
  // Success: the Cloud view is drawn after its own fetch that is not awaited here. The button therefore stays busy
  // a little longer, so it does not flash back before the row is redrawn. A button that was replaced is not affected.
  if (completed) setTimeout(release, 1500);
  else release();
  if (t.selected && !t.details.has(t.selected)) getDetails(t.selected);
  return completed;
}

/**
 * The button that was pressed last (captured before the button's own onclick), so action() knows which button is waiting.
 * Applies to all write buttons without each one having to pass the button along.
 */
let lastButton = null;
document.addEventListener(
  'click',
  (e) => {
    lastButton = e.target instanceof Element ? e.target.closest('button') : null;
  },
  true,
);

/**
 * Makes the button inactive with "Saving …" and aria-busy, and the row it sits in muted, until release() is called.
 * Blocks double clicks and shows right away that the press is registered. Returns release (safe to call several times).
 */
function busyButton(button) {
  if (!button || button.disabled) return () => {};
  const text = button.textContent;
  const row = button.closest('li, .row, .cloud-row');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Saving …';
  row?.classList.add('saves');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = text;
    row?.classList.remove('saves');
  };
}

async function move(body, ok) {
  t.busy = true;
  try {
    const answer = await writeWithGuard('/api/move', body);
    if (answer) messageWithInfo(ok, answer);
    else t.pending = true; // aborted at the warning: the card goes back
  } catch (e) {
    message(`The move was not saved: ${e.message}`, true);
    t.pending = true;
  } finally {
    t.busy = false;
  }
  await update(true);
  if (t.pending) draw();
}

/** Saves a move (drag or keyboard): the neighbors above and below at the new place. */
async function save(f) {
  const previous = neighborFor(f, 'previousElementSibling');
  const next = neighborFor(f, 'nextElementSibling');
  if (previous === f.previous && next === f.next) return draw(); // same space
  if (f.type === 'summary') {
    const id = f.el.dataset.id;
    return move(
      { id, over: previous?.dataset.id ?? null, under: next?.dataset.id ?? null },
      `${id} moved`,
    );
  }
  const pid = f.el.dataset.pid;
  t.busy = true;
  try {
    await api('/api/lane', {
      pid,
      over: previous?.dataset.pid ?? null,
      under: next?.dataset.pid ?? null,
    });
    message(`The project ${pid} moved`);
  } catch (e) {
    message(`The move was not saved: ${e.message}`, true);
    t.pending = true;
  } finally {
    t.busy = false;
  }
  await update(true);
  if (t.pending) draw();
}

/** The neighbor card or neighbor lane (only movable lanes count). */
function neighborFor(f, direction) {
  let n = f.el[direction];
  if (f.type === 'lane') while (n && n.dataset.movable !== '1') n = n[direction];
  return n ?? null;
}

function startMove(e, type) {
  return {
    type,
    el: e,
    list: e.parentElement,
    previous: null,
    next: null,
    released: false,
    init() {
      this.previous = neighborFor(this, 'previousElementSibling');
      this.next = neighborFor(this, 'nextElementSibling');
      return this;
    },
  }.init();
}

// ---- Drag with the mouse ----
function nearestAfter(list, selector, y, exception) {
  for (const children of list.querySelectorAll(`:scope > ${selector}`)) {
    if (children === exception) continue;
    const r = children.getBoundingClientRect();
    if (y < r.top + r.height / 2) return children;
  }
  return null;
}

main.addEventListener('dragstart', (e) => {
  const summary = e.target.closest?.('.summary[draggable="true"]');
  const header = e.target.closest?.('.lane-header[draggable="true"]');
  if (summary) drag = startMove(summary, 'summary');
  else if (header) drag = startMove(header.parentElement, 'lane');
  else return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.el.dataset.id ?? drag.el.dataset.pid);
  drag.el.classList.add('drags');
});

main.addEventListener('dragover', (e) => {
  if (!drag) return;
  const list = e.target.closest?.(drag.type === 'summary' ? '.shortlist' : '.laneList');
  if (!list || list !== drag.list) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  let after = nearestAfter(list, drag.type === 'summary' ? '.summary' : '.lane', e.clientY, drag.el);
  // A lane cannot be put below "without-project" (it is always last).
  if (drag.type === 'lane' && !after)
    after = list.querySelector(':scope > .lane:not([data-movable])');
  if (after === drag.el) return;
  if (after) {
    if (after !== drag.el.nextElementSibling) list.insertBefore(drag.el, after);
  } else if (list.lastElementChild !== drag.el) list.append(drag.el);
});

main.addEventListener('drop', (e) => {
  if (!drag) return;
  e.preventDefault();
  drag.released = true;
  const f = drag;
  save(f);
});

main.addEventListener('dragend', () => {
  if (!drag) return;
  const f = drag;
  drag = null;
  f.el.classList.remove('drags');
  // Aborted (released outside the list): the card goes back. After a release the save redraws the board.
  if (!f.released) draw();
});

// ---- Click and keyboard ----
main.addEventListener('click', (e) => {
  // The checkboxes (the cloud bundle and multi-select) and the buttons in the groups do not open the detail panel.
  if (e.target.closest?.('.cloud-select, .mark-box, .batch-buttons')) return;
  const summary = e.target.closest?.('.summary');
  if (!summary || boosted) return;
  // Ctrl/Cmd-click selects one card, Shift-click everything from the previous selected to this one.
  if (summary.dataset.markable && (e.shiftKey || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey && t.anchor) markArea(t.anchor, summary.dataset.id);
    else markMany([summary.dataset.id], !t.marked.has(summary.dataset.id));
    return;
  }
  openPanel(summary.dataset.id);
});
// Shift-click should not select the text on the cards.
main.addEventListener('mousedown', (e) => {
  if (e.shiftKey && e.target.closest?.('.summary[data-markable]')) e.preventDefault();
});

// ---- Roving tabindex ----
// One tab stop per column (Flat) or cell (Project lanes): the title button on one card, plus the boxes on the
// same card. The rest of the cards are reached with the arrow keys (window.QueuePerformance.rovingMeasure, tested in vitest). The board remembers
// which card was the stop in every column (t.roving), so the stop stays where it was after a redraw.
const AREA = '.col-body, .lane-cell';
let suppressWhitespace = false;

function areaKey(o) {
  const lane = o.closest('.lane');
  return lane ? `${lane.dataset.pid}|${o.dataset.col}` : (o.dataset.scroll ?? '');
}

/** Can the card get focus: not hidden by the search, and not in a closed group or section. */
const canBeFocused = (li) => !li.closest('[hidden], details:not([open])');

/** The cards in an area that can get focus (for the arrow keys). */
function visibleSummary(o) {
  return [...o.querySelectorAll('.summary')].filter(canBeFocused);
}

/** Makes the controls on the card (the title button and the boxes) a tab stop (on) or not. */
function setStop(li, on) {
  const v = on ? 0 : -1;
  for (const c of li.querySelectorAll('.summary-button, input')) if (c.tabIndex !== v) c.tabIndex = v;
}

/** First card in the area that can get focus (without going through all). */
function firstVisible(o) {
  for (const li of o.querySelectorAll('.summary')) if (canBeFocused(li)) return li;
  return null;
}

/**
 * Gives every column (or cell) one tab stop: the card that last had it, otherwise the first visible one. The controls
 * are built with tabindex -1, so only those that are the stop now (tabindex 0) and the new stop are touched.
 */
function rovingSetup() {
  for (const o of main.querySelectorAll(AREA)) {
    const remembered = t.roving.get(areaKey(o));
    const rememberedEl = remembered ? o.querySelector(`.summary[data-id="${CSS.escape(remembered)}"]`) : null;
    const active = rememberedEl && canBeFocused(rememberedEl) ? rememberedEl : firstVisible(o);
    for (const c of o.querySelectorAll('[tabindex="0"]')) {
      const li = c.closest('.summary');
      if (li && li !== active) setStop(li, false);
    }
    if (active) setStop(active, true);
  }
}

/** Makes the card the tab stop in its area (when it gets focus with Tab, click or arrow key). */
function selectStop(li) {
  const o = li.closest(AREA);
  if (!o) return;
  t.roving.set(areaKey(o), li.dataset.id);
  for (const c of o.querySelectorAll('[tabindex="0"]')) {
    const other = c.closest('.summary');
    if (other && other !== li) setStop(other, false);
  }
  setStop(li, true);
}

/** The arrow keys, Home and End from the card `li`: areas are the columns (Flat) or the cells in the same lane. */
function moveFocus(li, keyPress) {
  const here = li.closest(AREA);
  if (!here) return;
  const lane = here.closest('.lane');
  const areas = lane
    ? [...lane.querySelectorAll('.lane-cell')]
    : [...main.querySelectorAll('.col-body')];
  const summary = areas.map(visibleSummary);
  const o = areas.indexOf(here);
  const measure = window.QueuePerformance.rovingMeasure(
    summary.map((k) => k.length),
    o,
    Math.max(0, summary[o].indexOf(li)),
    keyPress,
  );
  if (!measure) return;
  const fresh = summary[measure.o][measure.i];
  selectStop(fresh);
  const button = fresh.querySelector('.summary-button');
  button?.focus();
  button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

main.addEventListener('focusin', (e) => {
  const li = e.target.closest?.('.summary');
  if (li && !boosted) selectStop(li);
});
// A Space that lifted or dropped a card should not also "click" the title button when the key is released.
main.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  if (suppressWhitespace && e.target.closest?.('.summary-button')) e.preventDefault();
  suppressWhitespace = false;
});

function moveBoosted(direction) {
  const f = boosted;
  const selector = f.type === 'summary' ? '.summary' : '.lane[data-movable]';
  // Cards the search has hidden are skipped (they are in the list, but not shown).
  const siblings = [...f.list.querySelectorAll(`:scope > ${selector}:not([hidden])`)];
  const i = siblings.indexOf(f.el);
  const j = i + direction;
  if (j < 0 || j >= siblings.length) return;
  if (direction < 0) f.list.insertBefore(f.el, siblings[j]);
  else f.list.insertBefore(f.el, siblings[j].nextElementSibling);
  // On the card it is the title button that has focus.
  const focus =
    f.type === 'summary'
      ? (f.el.querySelector('.summary-button') ?? f.el)
      : f.el.querySelector('.lane-header');
  focus.focus();
  focus.scrollIntoView?.({ block: 'nearest' });
  $('status').textContent =
    `Place ${j + 1} of ${siblings.length}. Space drops, Esc cancels.`;
}

main.addEventListener('keydown', (e) => {
  if (boosted) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveBoosted(e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.key === ' ') suppressWhitespace = true; // the button's click on keyup should not open the panel
      const f = boosted;
      boosted = null;
      f.el.classList.remove('boosted');
      save(f);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      boosted.el.classList.remove('boosted');
      boosted = null;
      draw();
      drawStatus();
    }
    return;
  }
  // Keys work on the title button (the card itself no longer has focus).
  const button = e.target.closest?.('.summary-button');
  const summary = button?.closest('.summary');
  const header = e.target.closest?.('.lane-header');
  if (summary && e.target === button) {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // The shortcuts with Ctrl/Cmd/Alt (Ctrl+A etc.) go on to the document.
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openPanel(summary.dataset.id);
    } else if (
      (e.key === 'x' || e.key === 'X') &&
      summary.dataset.markable &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      // X selects the card in focus (Shift+x: everything from the previous selected to here).
      e.preventDefault();
      if (e.shiftKey && t.anchor) markArea(t.anchor, summary.dataset.id);
      else markMany([summary.dataset.id], !t.marked.has(summary.dataset.id));
    } else if (e.key === ' ' && summary.draggable) {
      e.preventDefault();
      suppressWhitespace = true;
      boosted = startMove(summary, 'summary');
      summary.classList.add('boosted');
      $('status').textContent =
        `${summary.dataset.id} is lifted. Arrow up and down moves, Space drops, Esc cancels.`;
    } else if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
    ) {
      // Without a lift: up and down within the column, left and right to the neighbor column (or neighbor cell in the lane).
      e.preventDefault();
      moveFocus(summary, e.key);
    }
  } else if (header && e.target === header && header.draggable && e.key === ' ') {
    e.preventDefault();
    boosted = startMove(header.parentElement, 'lane');
    header.parentElement.classList.add('boosted');
    $('status').textContent =
      'The lane is lifted. Arrow up and down moves, Space drops, Esc cancels.';
  }
});

document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+A selects all shown cards that can be bulk edited (outside text fields and dialogs).
  if (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    (e.key === 'a' || e.key === 'A') &&
    !t.bulk &&
    !boosted &&
    !inputField(document.activeElement) &&
    !panel.contains(document.activeElement) &&
    t.data &&
    t.view !== 'statistics' &&
    t.view !== 'cloud' &&
    t.view !== 'plan' && // the plan has no cards to select
    !document.body.classList.contains('room-plans') // the Queue room is hidden
  ) {
    e.preventDefault();
    markAllMatch();
    return;
  }
  if (e.key !== 'Escape' || boosted || t.bulk) return;
  if (t.selected || t.setting || t.inbox || t.help) {
    e.preventDefault();
    closePanel();
  } else if (t.chain) {
    // The first Esc closes the panel, the next resets the chain, then the selection is cleared.
    e.preventDefault();
    resetChain();
  } else if (
    t.marked.size &&
    !filterMenu.contains(document.activeElement) &&
    !inputField(document.activeElement)
  ) {
    e.preventDefault();
    emptyOption();
  }
});
background.addEventListener('click', closePanel);
