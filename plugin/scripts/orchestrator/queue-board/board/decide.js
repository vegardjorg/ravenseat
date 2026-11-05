// =============================================================
// decide.js: the Decisions view, everything that waits on the owner as one list, one card per decision.
//
// The data is the same inbox "Waiting on you" shows (state.inbox, lib/queueBoard.js); the rules are
// lib/queueDecisions.js (window.QueueDecisions, the same file `cq decide` and the tests use): the items, the impact
// sort, the groups Decide / Check / Approve / Unstick, the impact line and the write each option does. So the board and
// /cq:decide make the same queue.mjs calls with the same --by. The side panel "Waiting on you" (inbox.js) stays: it has
// the bulk tools (QA ok and approve for many) and the Sort cleanup; the view links to it.
//
// A one-click answer is not written at once: the card leaves the list and an "Undo" toast stands for
// QueueDecisions.UNDO_MS (5 s) before the write, so undo never needs a revert. A new answer, leaving the page or the
// timer writes the waiting one. Keys in the view: j/k (or the arrows) move, Enter = the recommended option, 1-4 = that
// option, u = undo.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

const decideTab = $('show-decisions');
/** The view's own state: the card with focus, the answer waiting for its timer, and the open text form. */
t.decide = {
  focusKey: null,
  pending: null, // { item, option, text, timer, label }
  hidden: new Set(), // keys taken out of the list on this page: waiting to be written, or "keep"
  form: null, // { key, option: index or 'free' } the open text field
  draft: new Map(), // key → text written so far
  doneOpen: false, // "Decided today" is open
  queueView: VIEWS.includes(savedView) && savedView !== 'decisions' ? savedView : 'flat',
  landed: false,
};
const DV = () => window.QueueDecisions ?? null;

/** The decisions now, without the ones waiting to be written or kept on this page. */
function decisionItems() {
  const D = DV();
  if (!D || !t.data?.inbox) return [];
  return D.fromInbox(t.data.inbox).filter((x) => !t.decide.hidden.has(x.key));
}

/** The tab next to Plans and Queue: "Decisions" and the count. */
function drawDecisionsTab() {
  if (!decideTab) return;
  const n = DV() ? decisionItems().length : (t.data?.inbox?.count ?? 0);
  decideTab.replaceChildren(
    'Decisions',
    ...(n ? [el('span', { class: 'inbox-count', text: String(n) })] : []),
  );
  decideTab.setAttribute('aria-label', n ? `Decisions: ${n} waiting` : 'Decisions: nothing waiting');
  drawRoomTabs();
}

/** Which of Plans, Queue and Decisions is selected (Plans is drawn by plans/plans.js, which calls this after it). */
function drawRoomTabs() {
  if (!decideTab) return;
  const plans = document.body.classList.contains('room-plans');
  const d = !plans && t.view === 'decisions';
  decideTab.setAttribute('aria-selected', d ? 'true' : 'false');
  decideTab.tabIndex = d ? 0 : -1;
  const q = $('room-queue');
  q.setAttribute('aria-selected', !plans && !d ? 'true' : 'false');
  q.tabIndex = !plans && !d ? 0 : -1;
}

/** Opens the Decisions view (from Plans too). */
function openDecisions() {
  window.QueuePlans?.showQueue?.();
  if (t.view !== 'decisions') setView('decisions');
  draw();
  drawRoomTabs();
  main.querySelector('.decide-card[tabindex="0"]')?.focus();
}
decideTab?.addEventListener('click', openDecisions);
// "Queue" from the Decisions view goes back to the queue view the owner had (Plans handles its own room).
$('room-queue').addEventListener('click', () => {
  if (t.view !== 'decisions' || document.body.classList.contains('room-plans')) return;
  setView(t.decide.queueView);
  draw();
  drawRoomTabs();
});

/**
 * The first state decides where the board lands: Decisions when anything waits on the owner, otherwise the queue (a
 * saved Decisions view goes back to the queue view). Plans in the url is left alone. Runs once per page.
 */
function landingView() {
  if (t.decide.landed || !t.data) return;
  t.decide.landed = true;
  if (!DV() || document.body.classList.contains('room-plans')) return;
  if ((t.data.inbox?.count ?? 0) > 0) setView('decisions');
  else if (t.view === 'decisions') setView(t.decide.queueView);
}

// ---- Writing: wait, then write; undo before the write ----

/** Takes the card out and writes after the undo window. A waiting answer is written first. */
function scheduleDecision(item, option, text) {
  const D = DV();
  if (!D) return;
  if (t.decide.pending) commitDecision();
  const action = { ...option.action };
  if (text != null) {
    if (action.type === 'resolve') action.answer = text;
    else if (action.type === 'qa-deviation' || action.type === 'track-answer') action.text = text;
    else if (action.type === 'decline') action.reason = text;
  }
  const label = D.doneText(item, option, text);
  // The next card gets focus before this one leaves (j/k order).
  const order = D.walkOrder(decisionItems()).map((x) => x.key);
  const i = order.indexOf(item.key);
  t.decide.focusKey = order[i + 1] ?? order[i - 1] ?? null;
  t.decide.hidden.add(item.key);
  t.decide.form = null;
  t.decide.draft.delete(item.key);
  if (action.type === 'keep') {
    message(`${label} (until the board is reloaded).`);
    drawDecisionsTab();
    drawDecisions(true);
    return;
  }
  t.decide.pending = {
    item,
    action,
    label,
    timer: setTimeout(commitDecision, D.UNDO_MS),
  };
  decisionToast(label);
  drawDecisionsTab();
  drawDecisions(true);
}

/** Writes the waiting answer now (the timer, a new answer, or leaving the page). */
async function commitDecision() {
  const p = t.decide.pending;
  if (!p) return;
  clearTimeout(p.timer);
  t.decide.pending = null;
  closeDecisionToast();
  const call = DV()?.boardCall(p.action);
  try {
    const answer = call ? await writeWithGuard(call.path, call.body) : { info: [] };
    if (answer) messageWithInfo(p.label, answer);
    else t.decide.hidden.delete(p.item.key); // the owner cancelled at the guard: the card comes back
  } catch (e) {
    message(`${p.item.id}: ${e.message}`, true);
    t.decide.hidden.delete(p.item.key);
  }
  await update(true);
  // Written (or failed): the server's list is the truth again for this key.
  t.decide.hidden.delete(p.item.key);
  drawDecisionsTab();
  if (t.view === 'decisions') drawDecisions(false);
}

/** Undo: the waiting answer is dropped before anything was written, and its card comes back with focus. */
function undoDecision() {
  const p = t.decide.pending;
  if (!p) return false;
  clearTimeout(p.timer);
  t.decide.pending = null;
  t.decide.hidden.delete(p.item.key);
  t.decide.focusKey = p.item.key;
  closeDecisionToast();
  message(`Undone: ${p.label}. Nothing was written.`);
  drawDecisionsTab();
  drawDecisions(true);
  return true;
}

/** The toast in the same stack as the other "Undo" (one at a time; the bulk one is closed first). */
function decisionToast(label) {
  if (typeof closeUndoToast === 'function') closeUndoToast();
  const box = $('undo-message');
  const seconds = Math.round((DV()?.UNDO_MS ?? 5000) / 1000);
  box.replaceChildren(
    el('span', { class: 'undo-text', text: `${label}. Saving in ${seconds} s.` }),
    el('button', {
      type: 'button',
      class: 'button button-muted button-small',
      text: 'Undo',
      'aria-keyshortcuts': 'u',
      title: 'Takes the answer back before it is written (key: u)',
      onclick: undoDecision,
    }),
  );
  box.dataset.decision = '1';
  showToast('undo');
}
function closeDecisionToast() {
  const box = $('undo-message');
  if (box.dataset.decision !== '1') return;
  delete box.dataset.decision;
  hideToast('undo');
  box.replaceChildren();
}

// Leaving the page writes the waiting answer (keepalive lets the request finish after the page is gone).
window.addEventListener('pagehide', () => {
  const p = t.decide.pending;
  if (!p) return;
  clearTimeout(p.timer);
  t.decide.pending = null;
  const call = DV()?.boardCall(p.action);
  if (!call) return;
  try {
    fetch(call.path, {
      method: 'POST',
      keepalive: true,
      headers: { 'X-Queue-Key': t.key ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify(call.body),
    });
  } catch {
    /* the page is going away; the answer is not written and the card is there again next time */
  }
});

// ---- Drawing ----

/** The option buttons on a card: the recommended one filled, with its number (1-4) as the key. */
function decisionButtons(item) {
  const buttons = item.options.map((o, i) =>
    el('button', {
      type: 'button',
      class: `button ${o.recommended ? 'button-filled' : 'button-outline'}`,
      'data-focus': `decide:${item.key}:${i}`,
      'aria-keyshortcuts': o.recommended ? `Enter ${i + 1}` : String(i + 1),
      title: o.recommended ? `The recommendation (key: Enter or ${i + 1})` : `Key: ${i + 1}`,
      onclick: () => pickOption(item, i),
    },
    el('span', { class: 'decide-key', 'aria-hidden': 'true', text: String(i + 1) }),
    o.recommended ? `${o.label} (recommended)` : o.label,
    ),
  );
  const extra = [];
  if (item.free)
    extra.push(
      el('button', {
        type: 'button',
        class: item.options.length ? 'link-button' : 'button button-filled',
        'data-focus': `decide:${item.key}:free`,
        'aria-keyshortcuts': item.options.length ? null : 'Enter',
        text: item.free.label,
        onclick: () => openForm(item, 'free'),
      }),
    );
  if (item.open)
    extra.push(
      el('button', {
        type: 'button',
        class: 'link-button',
        text: `Open ${item.open}`,
        onclick: () => openPanel(item.open),
      }),
    );
  return el(
    'div',
    { class: 'decide-options', role: 'group', 'aria-label': `Answers for ${item.id}` },
    buttons,
    extra,
  );
}

/** One option: straight to the undo window, or the text field first when the answer needs text. */
function pickOption(item, i) {
  const o = item.options[i];
  if (!o) return;
  if (o.needsText) return openForm(item, i);
  scheduleDecision(item, o, null);
}

function openForm(item, option) {
  t.decide.form = { key: item.key, option };
  t.decide.focusKey = item.key;
  drawDecisions(true);
  main.querySelector(`#decide-text`)?.focus();
}

/** The text field for an answer in your own words, a QA deviation or a reason for declining. */
function decisionForm(item) {
  const f = t.decide.form;
  const option = f.option === 'free' ? null : item.options[f.option];
  const label = option ? option.needsText : item.free.label;
  const optional = !!option?.optionalText;
  const field = el('textarea', {
    id: 'decide-text',
    rows: 3,
    'data-focus': `decide:${item.key}:text`,
    oninput: (e) => t.decide.draft.set(item.key, e.target.value),
  });
  field.value = t.decide.draft.get(item.key) ?? '';
  const save = () => {
    const text = field.value.trim();
    if (!text && !optional) return message(`${label.replace(/\?$/, '')}: write it first.`, true);
    const chosen = option ?? { ...item.free, recommended: false };
    scheduleDecision(item, chosen, text || null);
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      t.decide.form = null;
      drawDecisions(true);
    }
  });
  return el(
    'div',
    { class: 'decide-form' },
    el('label', { for: 'decide-text', text: optional ? `${label}` : label }),
    field,
    el(
      'div',
      { class: 'decide-form-buttons' },
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Cancel',
        onclick: () => {
          t.decide.form = null;
          drawDecisions(true);
        },
      }),
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: option ? option.label : 'Save answer',
        title: 'Ctrl+Enter',
        onclick: save,
      }),
    ),
  );
}

function decisionCard(item, focusKey) {
  const D = DV();
  const open = t.decide.form?.key === item.key;
  return el(
    'li',
    {
      class: `decide-card${item.key === focusKey ? ' current' : ''}`,
      'data-key': item.key,
      tabindex: item.key === focusKey ? '0' : '-1',
      'aria-label': `${item.kindName} ${item.id}: ${item.title}`,
      onfocus: (e) => {
        if (e.target !== e.currentTarget) return;
        t.decide.focusKey = item.key;
        for (const c of main.querySelectorAll('.decide-card')) {
          c.classList.toggle('current', c === e.currentTarget);
          c.tabIndex = c === e.currentTarget ? 0 : -1;
        }
      },
    },
    el(
      'div',
      { class: 'decide-card-head' },
      el('span', {
        class: `badge sp-type${item.verb === 'decide' ? ` sp-${item.kind}` : ''}`,
        text: item.kindName,
      }),
      el('span', { class: 'sp-id', text: item.id }),
    ),
    el('p', { class: `decide-title${item.text === null && item.verb === 'decide' ? ' missing' : ''}`, text: item.title }),
    el('p', { class: 'decide-impact', text: D.impactLine(item) }),
    ...item.context.slice(0, 2).map((c) => el('p', { class: 'decide-context', text: c })),
    open ? decisionForm(item) : decisionButtons(item),
  );
}

/** "Decided today" at the bottom, closed unless the owner opened it. */
function decidedPart() {
  const list = t.data?.inbox?.decided ?? [];
  if (!list.length) return null;
  const verbName = Object.fromEntries((DV()?.VERBS ?? []).map((v) => [v.verb, v.title]));
  const box = el(
    'details',
    { class: 'decide-done', open: t.decide.doneOpen },
    el('summary', { text: `Decided today (${list.length})` }),
    el(
      'ul',
      { class: 'decide-done-list' },
      list.map((d) =>
        el(
          'li',
          null,
          el('span', { class: 'decide-done-time', text: new Date(d.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }),
          el('span', { class: 'badge', text: verbName[d.verb] ?? d.verb }),
          el('span', { class: 'sp-id', text: d.id }),
          el('span', { class: 'decide-done-what', text: d.what }),
        ),
      ),
    ),
  );
  box.addEventListener('toggle', () => (t.decide.doneOpen = box.open));
  return box;
}

/**
 * Draws the view into the board area. `fresh` = an action by the owner (redraw even while a text field has focus,
 * and put focus on the current card).
 */
function drawDecisions(fresh) {
  if (t.view !== 'decisions') return;
  const D = DV();
  const active = document.activeElement;
  if (!fresh && main.contains(active) && active.tagName === 'TEXTAREA') return;
  const hadFocus = fresh || main.contains(active);
  const focusData = main.contains(active) ? active.dataset?.focus : null;
  const scroll = main.scrollTop;
  main.replaceChildren();
  main.className = 'board decisions';
  if (!D || !t.data) {
    main.append(
      el('p', {
        class: 'empty',
        text: t.error ? `Could not read the queue: ${t.error}` : 'Fetching the queue …',
      }),
    );
    return;
  }
  const items = decisionItems();
  const groups = D.groupItems(items);
  const order = groups.flatMap((g) => g.items.map((x) => x.key));
  if (!order.includes(t.decide.focusKey)) t.decide.focusKey = order[0] ?? null;
  const focusKey = t.decide.focusKey;
  const head = el(
    'header',
    { class: 'decide-head' },
    el('h2', { id: 'decide-title', class: 'decide-heading', text: 'Decisions' }),
    items.length
      ? el('p', {
          class: 'decide-keys',
          text: 'j / k to move · Enter = recommended · 1-4 = choose · u = undo',
        })
      : null,
    listeningLine(Math.max(items.length, 1)),
    t.data.baseHealth?.status === 'red' ? el('p', { class: 'decide-base-red', text: t.data.baseHealth.text }) : null,
  );
  const parts = [head];
  if (!items.length)
    parts.push(
      el('p', { class: 'inbox-empty' }, icon('checkmark'), el('span', { text: 'Nothing waiting on you' })),
      el('p', {
        class: 'inbox-info',
        text: 'New questions, checks and proposals land here. You can also answer them in Claude Code with /cq:decide.',
      }),
    );
  for (const g of groups)
    parts.push(
      el(
        'section',
        { class: 'decide-group', 'aria-labelledby': `decide-${g.verb}` },
        el(
          'h3',
          { id: `decide-${g.verb}`, class: 'decide-group-title' },
          g.title,
          el('span', { class: 'inbox-count', text: String(g.items.length) }),
        ),
        el('p', { class: 'decide-hint', text: g.hint }),
        el('ol', { class: 'decide-list' }, g.items.map((x) => decisionCard(x, focusKey))),
      ),
    );
  const sortCount = t.data.inbox?.sort?.length ?? 0;
  parts.push(
    el(
      'p',
      { class: 'decide-more' },
      el('button', {
        type: 'button',
        class: 'link-button',
        text: sortCount ? `Bulk answers and Sort (${sortCount}) in the side panel` : 'Bulk answers in the side panel',
        title: 'QA ok and approve for many at once, and the Sort cleanup',
        onclick: openInbox,
      }),
    ),
    decidedPart(),
  );
  main.append(el('section', { class: 'decide', 'aria-labelledby': 'decide-title' }, parts));
  main.scrollTop = scroll;
  if (!hadFocus) return;
  const again = focusData ? main.querySelector(`[data-focus="${CSS.escape(focusData)}"]`) : null;
  if (again && !fresh) again.focus();
  else if (t.decide.form) main.querySelector('#decide-text')?.focus();
  else main.querySelector(`.decide-card[data-key="${CSS.escape(focusKey ?? '')}"]`)?.focus();
}

// ---- Keys ----

/** Moves focus to the next (+1) or previous (-1) card. */
function moveDecision(step) {
  const cards = [...main.querySelectorAll('.decide-card')];
  if (!cards.length) return;
  const i = cards.findIndex((c) => c.dataset.key === t.decide.focusKey);
  const j = Math.max(0, Math.min(cards.length - 1, (i < 0 ? 0 : i + step)));
  cards[j].focus();
  cards[j].scrollIntoView?.({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (t.view !== 'decisions' || document.body.classList.contains('room-plans')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (t.selected || t.setting || t.inbox || t.help || t.bulk || !$('guard-background').hidden) return;
  if (inputField(document.activeElement)) return;
  const inView = main.contains(document.activeElement) || document.activeElement === document.body;
  if (e.key === 'u' || e.key === 'U') {
    if (undoDecision()) e.preventDefault();
    return;
  }
  if (!inView) return;
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    moveDecision(1);
    return;
  }
  if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveDecision(-1);
    return;
  }
  const item = decisionItems().find((x) => x.key === t.decide.focusKey);
  if (!item) return;
  // Enter on a button presses that button (the browser does it); on the card it is the recommendation.
  if (e.key === 'Enter' && e.target.classList?.contains('decide-card')) {
    e.preventDefault();
    const rec = item.options.findIndex((o) => o.recommended);
    if (rec >= 0) pickOption(item, rec);
    else if (item.free) openForm(item, 'free');
    return;
  }
  if (/^[1-4]$/.test(e.key) && item.options[Number(e.key) - 1]) {
    e.preventDefault();
    pickOption(item, Number(e.key) - 1);
  }
});
