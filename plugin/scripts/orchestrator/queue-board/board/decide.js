// =============================================================
// decide.js: the Decisions room, everything that waits on the owner as one list, one card per decision.
//
// The data is the inbox the server builds (state.inbox, lib/queueBoard.js); the rules are lib/queueDecisions.js
// (window.QueueDecisions, the same file `ravenseat decide` and the tests use): the items, the impact sort, the groups
// Decide / Check / Approve / Unstick, the impact line and the write each option does. So the board and
// /ravenseat:decide make the same queue.mjs calls with the same --by. The cards are drawn with the one renderer for
// owner questions and answer buttons (board/question.js), which Plans uses too.
//
// This is the only place on the board to answer (board step B24): the "Waiting on you" button at the top opens this
// room and carries the only counter. What the old side panel had is here: QA ok and Approve for many (check the
// cards, then "QA ok for selected" or "Approve selected"), the Sort cleanup (accept-suggestion), and the answers not
// in the decision log yet.
//
// A one-click answer is not written at once: the card leaves the list and an "Undo" toast stands for
// QueueDecisions.UNDO_MS (5 s) before the write, so undo never needs a revert. A new answer, leaving the page or the
// timer writes the waiting one. Keys in the room: j/k (or the arrows) move, Enter = the recommended option, 1-4 = that
// option (for a question's choice, its --choice number), u = undo.
//
// Landing (B24): the board opens here only when a decision is new since the owner last saw this room
// (queue-board-decisions-seen in this browser); otherwise it opens the queue view used last.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

const decideTab = $('show-decisions');
const waitingButton = $('inbox');
/** The keys the owner last saw in this room (the landing rule). Per browser; a blocked storage reads as a first visit. */
const SEEN_STORAGE = 'queue-board-decisions-seen';
/** The room's own state: the card with focus, the answer waiting for its timer, and the open text form. */
t.decide = {
  focusKey: null,
  pending: null, // { item, option, text, timer, label }
  hidden: new Set(), // keys taken out of the list on this page: waiting to be written, or "keep"
  form: null, // { key, option: index or 'free' } the open text field
  draft: new Map(), // key → text written so far
  keep: new Set(), // keys with "Keep as design choice" pressed (catalog.captureAnswers, roadmap 0z Z-A)
  doneOpen: false, // "Decided today" is open
  nbOpen: false, // "Not building" is open (roadmap 0f)
  nbQuery: '', // its search, kept across the redraws
  catOpen: false, // "Project catalog" is open (roadmap 0å KD-0)
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

/**
 * The "Waiting on you" button at the top: the only counter on the board. It opens the Decisions room. "Seen" and an
 * answer still in its undo window leave the count first; ravenseat decide lists them until they are written.
 */
function drawWaitingButton() {
  if (!waitingButton) return;
  const n = DV() ? decisionItems().length : (t.data?.inbox?.count ?? 0);
  waitingButton.replaceChildren(
    'Waiting on you',
    ...(n ? [el('span', { class: 'inbox-count', text: String(n) })] : []),
  );
  waitingButton.setAttribute('aria-label', n ? `Waiting on you: ${n}, opens Decisions` : 'Waiting on you: nothing, opens Decisions');
  waitingButton.classList.toggle('active', n > 0);
  const out = DV() && t.data?.inbox ? DV().fromInbox(t.data.inbox).length - n : 0;
  waitingButton.title = out
    ? `Opens Decisions. ${out} set aside on this board until it is reloaded; ravenseat decide still lists them`
    : 'Opens Decisions: questions, proposals to approve and checks that need you';
}
waitingButton?.addEventListener('click', () => openDecisions());

/** The tab next to Plans and Queue. No count here: the count is on "Waiting on you" (one counter). */
function drawDecisionsTab() {
  if (!decideTab) return;
  decideTab.replaceChildren(icon('tab-decisions'), tabLabel('Decisions'));
  drawWaitingButton();
  drawRoomTabs();
}

/** Which of Plans, Queue and Decisions is selected (Plans is drawn by plans/plans.js, which calls this after it). */
function drawRoomTabs() {
  if (!decideTab) return;
  const plans = document.body.classList.contains('room-plans');
  const d = !plans && t.view === 'decisions';
  decideTab.setAttribute('aria-selected', d ? 'true' : 'false');
  decideTab.tabIndex = d ? 0 : -1;
  const c = !plans && t.view === 'checks';
  const checks = $('show-checks');
  checks.setAttribute('aria-selected', c ? 'true' : 'false');
  checks.tabIndex = c ? 0 : -1;
  const q = $('room-queue');
  q.setAttribute('aria-selected', !plans && !d && !c ? 'true' : 'false');
  q.tabIndex = !plans && !d && !c ? 0 : -1;
}

/** Opens the Decisions room (from Plans too); `key` puts focus on that card ("decide:<question id>"). */
function openDecisions(key) {
  window.QueuePlans?.showQueue?.();
  if (t.selected || t.setting || t.help) closePanel();
  if (key) t.decide.focusKey = key;
  if (t.view !== 'decisions') setView('decisions');
  draw();
  drawRoomTabs();
  main.querySelector('.decide-card[tabindex="0"]')?.focus();
}
decideTab?.addEventListener('click', () => openDecisions());
// "Queue" from the Decisions room goes back to the queue view the owner had (Plans handles its own room).
$('room-queue').addEventListener('click', () => {
  if ((t.view !== 'decisions' && t.view !== 'checks') || document.body.classList.contains('room-plans')) return;
  setView(t.decide.queueView);
  draw();
  drawRoomTabs();
});

/** The keys the owner saw in this room last time, or null (a first visit, or storage the browser keeps from us). */
function seenDecisions() {
  try {
    const x = JSON.parse(store.getItem(SEEN_STORAGE) ?? 'null');
    return Array.isArray(x) ? x.filter((k) => typeof k === 'string') : null;
  } catch {
    return null;
  }
}

/** Remembers what the room shows now (also the cards set aside on this page: they were seen). */
function rememberSeen() {
  if (!DV() || !t.data?.inbox) return;
  store.setItem(SEEN_STORAGE, JSON.stringify(DV().fromInbox(t.data.inbox).map((x) => x.key)));
}

/**
 * The first state decides where the board lands: Decisions when a decision is new since the owner last saw the room
 * (QueueDecisions.landInDecisions), otherwise the queue view used last. Plans in the url is left alone. Once per page.
 */
function landingView() {
  if (t.decide.landed || !t.data) return;
  t.decide.landed = true;
  const D = DV();
  if (!D || document.body.classList.contains('room-plans')) return;
  const keys = t.data.inbox ? D.fromInbox(t.data.inbox).map((x) => x.key) : [];
  if (D.landInDecisions(keys, seenDecisions())) setView('decisions');
  else if (t.view === 'decisions') setView(t.decide.queueView);
}

/**
 * Whether answers given here are picked up now: `ravenseat wait` runs in the orchestrator session and its heartbeat is
 * fresh (state.listening, lib/ownerWait.js). Only shown when something waits on the owner.
 */
function listeningLine(count) {
  if (!count) return null;
  const on = t.data?.listening === true;
  return el(
    'p',
    { class: `inbox-listening${on ? ' on' : ''}` },
    el('span', { class: 'inbox-listening-dot', 'aria-hidden': 'true' }),
    el('span', { text: on ? 'Orchestrator listening' : 'Answers are picked up the next time the orchestrator runs' }),
  );
}

// ---- Writing: wait, then write; undo before the write ----

/** Takes the card out and writes after the undo window. A waiting answer is written first. */
function scheduleDecision(item, option, text) {
  const D = DV();
  if (!D) return;
  if (t.decide.pending) commitDecision();
  const write = { ...option.action };
  if (text != null) {
    if (write.type === 'resolve') write.answer = text;
    else if (write.type === 'qa-deviation' || write.type === 'track-answer') write.text = text;
    else if (write.type === 'decline') write.reason = text;
  }
  // "Keep as design choice" pressed on this card: resolve --keep (a proposed draft the owner accepts later). On a
  // proposal, "Keep as not building" (roadmap 0f) goes with Decline only: cancel --keep, the reason as its text.
  const kind = keepOffered(item);
  const keep = t.decide.keep.has(item.key) && ((kind === 'design' && write.type === 'resolve') || (kind === 'not-building' && write.type === 'decline'));
  if (keep) write.keep = true;
  const kept = kind === 'not-building' ? ', kept as a proposed "not building" entry' : ', kept as a proposed design choice';
  const label = `${D.doneText(item, option, text)}${keep ? kept : ''}`;
  // The next card gets focus before this one leaves (j/k order).
  const order = D.walkOrder(decisionItems()).map((x) => x.key);
  const i = order.indexOf(item.key);
  t.decide.focusKey = order[i + 1] ?? order[i - 1] ?? null;
  t.decide.hidden.add(item.key);
  t.decide.form = null;
  t.decide.draft.delete(item.key);
  if (write.type === 'keep') {
    message(`${label} (until the board is reloaded).`);
    drawDecisionsTab();
    drawDecisions(true);
    return;
  }
  t.decide.pending = {
    item,
    action: write,
    label,
    timer: setTimeout(commitDecision, D.UNDO_MS),
  };
  decisionToast(label);
  drawDecisionsTab();
  drawDecisions(true);
  // B18: "Set a new focus" on the "focus ended" question (lib/logic/focus.js, choice 1) is answered as any choice and
  // then opens the Focus tab, where the new focus is set. The undo window and the toast stay as they are.
  if (String(item.id ?? '').startsWith('focus-done-') && write.type === 'resolve' && write.choice === 1) {
    setView('plan');
    draw();
  }
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
    if (answer) {
      messageWithInfo(p.label, answer);
      t.decide.keep.delete(p.item.key);
    } else t.decide.hidden.delete(p.item.key); // the owner cancelled at the guard: the card comes back
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

/** The answer buttons on a card (board/question.js), with the number keys and "Open <task>" for more. */
function decisionButtons(item) {
  return answerButtons(item, {
    keys: true,
    onOption: (i) => pickOption(item, i),
    onFree: () => openForm(item, 'free'),
    extra: item.open
      ? [el('button', { type: 'button', class: 'link-button', text: `Open ${item.open}`, onclick: () => openPanel(item.open) })]
      : [],
  });
}

/**
 * Which keep a card offers, or null: 'design' ("Keep as design choice", roadmap 0z Z-A) on a plain owner question, and
 * 'not-building' ("Keep as not building", roadmap 0f) on a proposal, which goes with Decline. Both need
 * catalog.captureAnswers explicit or suggest (the state's captureAnswers). A condition, a lawyer's word or an owner task
 * is no lasting rule.
 */
function keepOffered(item) {
  const mode = t.data?.captureAnswers;
  if (mode !== 'explicit' && mode !== 'suggest') return null;
  if (item.verb === 'decide' && item.kind === 'question') return 'design';
  if (item.verb === 'approve' && item.kind === 'proposed') return 'not-building';
  return null;
}

/**
 * The "Keep as design choice" toggle under a question's answers: pressed, the answer is also written as a proposed
 * design choice in the catalog (resolve --keep), which the owner accepts later with `catalog accept`. Never pressed by
 * itself; with suggest, a question that reads like a lasting rule gets a short hint beside it.
 */
function keepRow(item) {
  const kind = keepOffered(item);
  if (!kind) return null;
  const on = t.decide.keep.has(item.key);
  const hintId = `decide-keep-hint-${item.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const hint = kind === 'design' && t.data.captureAnswers === 'suggest' && item.keepSuggested;
  const nb = kind === 'not-building';
  return el(
    'div',
    { class: 'decide-keep' },
    el('button', {
      type: 'button',
      class: `button button-small ${on ? 'button-filled' : 'button-outline'}`,
      'aria-pressed': on ? 'true' : 'false',
      'aria-describedby': hint ? hintId : null,
      'data-focus': `keep:${item.key}`,
      title: nb
        ? 'If you decline it, also writes a proposed "not building" entry in the project catalog, your reason as its text. You accept it yourself later.'
        : 'Also writes the answer as a proposed design choice in the project catalog. You accept it yourself later.',
      text: nb ? 'Keep as not building' : 'Keep as design choice',
      onclick: () => {
        if (t.decide.keep.has(item.key)) t.decide.keep.delete(item.key);
        else t.decide.keep.add(item.key);
        drawDecisions(true);
      },
    }),
    hint ? el('span', { id: hintId, class: 'decide-keep-hint', text: 'Reads like a lasting rule' }) : null,
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

/** The text field for an answer in text, a QA deviation or a reason for declining (board/question.js). */
function decisionForm(item) {
  const f = t.decide.form;
  const option = f.option === 'free' ? null : item.options[f.option];
  const close = () => {
    t.decide.form = null;
    drawDecisions(true);
  };
  return answerForm(item, {
    option,
    value: t.decide.draft.get(item.key) ?? '',
    onInput: (v) => t.decide.draft.set(item.key, v),
    onSave: (text) => scheduleDecision(item, option ?? { ...item.free, recommended: false }, text),
    onOptionWithText: (i, text) => scheduleDecision(item, item.options[i], text),
    onCancel: close,
    onError: (m) => message(m, true),
  });
}

/** The checkbox on a Check or Approve card, for "QA ok for selected" and "Approve selected". */
function bulkCheck(item) {
  const set = item.verb === 'check' ? t.selectedQa : item.verb === 'approve' ? t.selectedSuggestion : null;
  if (!set) return null;
  return el('input', {
    type: 'checkbox',
    class: 'decide-check',
    'data-focus': `select:${item.key}`,
    'aria-label': `Select ${item.id} for ${item.verb === 'check' ? '"QA ok for selected"' : '"Approve selected"'}`,
    checked: set.has(item.id),
    onchange: (e) => {
      if (e.target.checked) set.add(item.id);
      else set.delete(item.id);
      drawDecisions(true);
    },
  });
}

function decisionCard(item, focusKey, { check = false } = {}) {
  const D = DV();
  const open = t.decide.form?.key === item.key;
  const question = item.verb === 'decide';
  const head = questionHead(item);
  if (check) head.prepend(bulkCheck(item));
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
    head,
    // An owner question: the shared blocks (the question, the recommendation, why, and the muted line with what it
    // unlocks, what waits and the source). The other cards: the title, the impact and their context lines.
    ...(question
      ? questionBody(item)
      : [
          el('p', { class: 'decide-title', text: item.title }),
          el('p', { class: 'decide-impact', text: D.impactLine(item) }),
          ...item.context.slice(0, 2).map((c) => el('p', { class: 'decide-context', text: c })),
        ]),
    open ? decisionForm(item) : decisionButtons(item),
    keepRow(item),
  );
}

/**
 * "QA ok for selected" or "Approve selected" under the Check and Approve groups (with two or more cards): select all,
 * then one write for every checked card, at once and without the undo window (as `ravenseat qa ok` / `approve` with ids).
 */
function bulkBar(group) {
  if (group.items.length < 2 || (group.verb !== 'check' && group.verb !== 'approve')) return null;
  const qa = group.verb === 'check';
  const set = qa ? t.selectedQa : t.selectedSuggestion;
  const ids = group.items.map((x) => x.id);
  for (const id of [...set]) if (!ids.includes(id)) set.delete(id);
  const n = set.size;
  const all = n === ids.length;
  const name = qa ? 'QA ok for selected' : 'Approve selected';
  return el(
    'div',
    { class: 'decide-bulk' },
    el('button', {
      type: 'button',
      class: 'link-button',
      'data-focus': `bulk-all:${group.verb}`,
      text: all ? 'Select none' : 'Select all',
      onclick: () => {
        if (all) set.clear();
        else for (const id of ids) set.add(id);
        drawDecisions(true);
      },
    }),
    el('button', {
      type: 'button',
      class: 'button button-muted',
      'data-focus': `bulk:${group.verb}`,
      text: n ? `${name} (${n})` : name,
      disabled: n === 0,
      onclick: async () => {
        const chosen = ids.filter((id) => set.has(id));
        const body = qa ? { type: 'qa-ok', ids: chosen } : { type: 'approve', ids: chosen };
        if (await action(body, qa ? `QA ok: ${chosen.join(', ')}` : `Approved: ${chosen.join(', ')}`)) set.clear();
        drawDecisions(true);
      },
    }),
  );
}

/**
 * "Sort": tasks without a project, with an uncertain proposal, or where the project conflicts with the files and the
 * plan. Rows with a proposal can be accepted one by one or together (the bulk action accept-suggestion, with
 * preview). Not counted on "Waiting on you": it is cleanup, not something that stops the queue.
 */
function sortPart(rows) {
  if (!rows?.length) return null;
  const ids = new Set(rows.map((r) => r.id));
  for (const id of [...t.selectedSort]) if (!ids.has(id)) t.selectedSort.delete(id);
  const withSuggestion = rows.filter((r) => r.proposed && markable(r.id));
  const chosen = [...t.selectedSort].filter((id) => withSuggestion.some((r) => r.id === id));
  const TYPE = {
    disagree: ['conflicts', 'The current project conflicts with a strong signal (files, plan or prefix).'],
    move: ['without project', 'Without a project today, with a confident proposal.'],
    sort: ['uncertain', 'Without a project or with an uncertain proposal: pick the project yourself.'],
  };
  const row = (r) =>
    el(
      'li',
      { class: 'decide-sort-row' },
      el(
        'div',
        { class: 'decide-card-head' },
        r.proposed && markable(r.id)
          ? el('input', {
              type: 'checkbox',
              class: 'decide-check',
              'data-focus': `sort:${r.id}`,
              'aria-label': `Select ${r.id} for "Accept all proposals for selected"`,
              checked: t.selectedSort.has(r.id),
              onchange: (e) => {
                if (e.target.checked) t.selectedSort.add(r.id);
                else t.selectedSort.delete(r.id);
                drawDecisions(true);
              },
            })
          : null,
        el('button', { type: 'button', class: 'link-button', text: r.id, title: 'Open task', onclick: () => openPanel(r.id) }),
        el('span', { class: 'badge', text: TYPE[r.type]?.[0] ?? r.type, title: TYPE[r.type]?.[1] ?? null }),
      ),
      el('p', { class: 'decide-title', text: r.title ?? '' }),
      el('p', {
        class: 'decide-context',
        text: `Now: ${r.now}${r.proposed ? ` · proposed: ${r.proposed}` : ' · no proposal'}${r.reason ? ` · ${r.reason}` : ''}`,
      }),
      r.proposed && markable(r.id)
        ? el(
            'div',
            { class: 'decide-options' },
            el('button', {
              type: 'button',
              class: 'button button-outline button-small',
              text: 'Accept proposal',
              title: `Move ${r.id} to the project ${r.proposed}. You see the change before it is saved.`,
              onclick: () => openBulk('accept-suggestion', [r.id]),
            }),
          )
        : null,
    );
  return el(
    'section',
    { class: 'decide-group decide-sort', 'aria-labelledby': 'decide-sort' },
    el('h3', { id: 'decide-sort', class: 'decide-group-title', text: `Sort (${rows.length})` }),
    el('p', {
      class: 'decide-hint',
      text: 'Cleanup, not something that stops the queue: the project decides the area and the focus step a task ends up in.',
    }),
    el('ol', { class: 'decide-list' }, rows.map(row)),
    withSuggestion.length
      ? el(
          'div',
          { class: 'decide-bulk' },
          el('button', {
            type: 'button',
            class: 'link-button',
            'data-focus': 'sort-all',
            text: chosen.length === withSuggestion.length ? 'Select none' : 'Select all with proposal',
            onclick: () => {
              if (chosen.length === withSuggestion.length) t.selectedSort.clear();
              else for (const r of withSuggestion) t.selectedSort.add(r.id);
              drawDecisions(true);
            },
          }),
          el('button', {
            type: 'button',
            class: 'button button-muted',
            'data-focus': 'sort-accept',
            text: `Accept all proposals for selected (${chosen.length})`,
            disabled: !chosen.length,
            title: 'Gives every selected task the project the queue proposes. You see the changes before they are saved.',
            onclick: () => openBulk('accept-suggestion', chosen),
          }),
        )
      : null,
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

/** The status of a catalog entry in words: the badge text and whether it holds. */
function catalogBadge(status) {
  if (status === 'accepted') return { text: 'Holds', hold: true };
  if (status === 'unconfirmed') return { text: 'Unconfirmed', hold: false };
  return { text: 'Proposed', hold: false };
}

/**
 * One catalog entry: id, status, title, the invariant (the only text a track gets), where it applies and, for a design
 * entry, where its tokens live.
 */
function catalogItem(e) {
  const badge = catalogBadge(e.status);
  const where = `Applies to: ${(e.paths ?? []).join(', ')}${e.except?.length ? `; not ${e.except.join(', ')}` : ''}`;
  return el(
    'li',
    { class: 'decide-nb-item' },
    el(
      'p',
      { class: 'decide-nb-title' },
      el('span', { class: 'sp-id', text: e.id }),
      el('span', { class: badge.hold ? 'badge' : 'badge decide-nb-draft', text: badge.text }),
      el('span', { class: 'decide-nb-name', text: e.title }),
    ),
    e.invariant ? el('p', { class: 'decide-nb-why', text: e.invariant }) : null,
    el('p', { class: 'decide-nb-meta', text: where }),
    // A design entry (KD-1) names where its tokens live; the catalog never copies them.
    e.source ? el('p', { class: 'decide-nb-meta', text: `Tokens: ${[].concat(e.source).join(', ')}` }) : null,
    // A stack entry (KD-3) says the tool for the job and what it was chosen over.
    e.uses?.tool
      ? el('p', { class: 'decide-nb-meta', text: `Uses: ${e.uses.tool}${e.uses.job ? ` for ${e.uses.job}` : ''}` })
      : null,
    e.alternatives?.length ? el('p', { class: 'decide-nb-meta', text: `Chosen over: ${e.alternatives.join(', ')}` }) : null,
    badge.hold
      ? null
      : el('p', { class: 'decide-nb-meta', text: `Accept it with: ravenseat catalog accept ${e.id} --by owner` }),
  );
}

/**
 * "Project catalog" (roadmap 0å KD-0): the design language, stack and design choices of docs/queue/catalog/, grouped by
 * kind, folded like "Not building". Display only: the entries are written with `catalog propose` and accepted with
 * `catalog accept`. Not-building entries have their own part below.
 */
function catalogPart() {
  const groups = t.data?.catalogGroups ?? [];
  const n = groups.reduce((s, g) => s + (g.entries?.length ?? 0), 0);
  if (!n) return null;
  const box = el(
    'details',
    { class: 'decide-done decide-nb', open: t.decide.catOpen },
    el('summary', { text: `Project catalog (${n})` }),
    el('p', {
      class: 'decide-hint',
      text: 'The rules a track works under, by kind. One that holds binds the tracks; a proposed one is a suggestion until you accept it.',
    }),
    ...groups.flatMap((g) => [
      el('h3', { class: 'decide-cat-kind', text: `${g.title} (${g.entries.length})` }),
      el('ul', { class: 'decide-nb-list', 'aria-label': g.title }, g.entries.map(catalogItem)),
    ]),
  );
  box.addEventListener('toggle', () => (t.decide.catOpen = box.open));
  return box;
}

/** The words an entry is searched on: its id, title, reason, keywords, revisit line and source. */
function notBuildingText(e) {
  return [e.id, e.title, e.why, ...(e.keywords ?? []), e.revisit, e.source].filter(Boolean).join(' ').toLowerCase();
}

/** Whether an entry matches the search: every word of the query is somewhere in its text (case does not matter). */
function notBuildingMatch(e, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const text = notBuildingText(e);
  return words.every((w) => text.includes(w));
}

/** The count line under the search ("4 entries", "1 of 4 match"), read out by a screen reader as it changes. */
function notBuildingCount(shown, all) {
  if (shown === all) return `${all} ${all === 1 ? 'entry' : 'entries'}`;
  return shown ? `${shown} of ${all} match` : `None of ${all} match`;
}

/** One entry: id, title, state, when and by whom, why, the revisit line, the keywords and how to reopen or accept it. */
function notBuildingItem(e) {
  const draft = e.status !== 'not-building';
  const when = draft
    ? 'Draft, not accepted yet'
    : `Chosen not to build${e.decided ? ` ${e.decided}` : ''}${e.by ? ` by ${e.by}` : ''}`;
  const note =
    e.state === 'due'
      ? 'The revisit date has passed: is the reason still true?'
      : e.state === 'old'
        ? 'Decided a long time ago: is the reason still true?'
        : null;
  return el(
    'li',
    { class: 'decide-nb-item', 'data-nb': notBuildingText(e) },
    el(
      'p',
      { class: 'decide-nb-title' },
      el('span', { class: 'sp-id', text: e.id }),
      el('span', { class: draft ? 'badge decide-nb-draft' : 'badge', text: draft ? 'Draft' : 'Not building' }),
      el('span', { class: 'decide-nb-name', text: e.title }),
    ),
    el('p', { class: 'decide-nb-when', text: when }),
    e.why ? el('p', { class: 'decide-nb-why', text: e.why }) : null,
    e.revisit ? el('p', { class: 'decide-nb-meta', text: `Revisit when: ${e.revisit}` }) : null,
    note ? el('p', { class: 'decide-nb-due', text: note }) : null,
    e.keywords?.length ? el('p', { class: 'decide-nb-meta', text: `Keywords: ${e.keywords.join(', ')}` }) : null,
    el('p', {
      class: 'decide-nb-meta',
      text: draft
        ? `Accept it with: ravenseat catalog accept ${e.id} --by owner`
        : `Reopen it with: ravenseat catalog propose --title "..." --supersedes ${e.id} (it is set superseded on accept)`,
    }),
  );
}

/**
 * "Not building" (roadmap 0f): the catalog's entries for what the owner chose not to build, at the bottom of the room,
 * folded like "Decided today", with a search that filters in place. Display only: the entries are written with
 * `cancel --keep`, `checks dismiss --keep` or `catalog propose --not-building`, and accepted with `catalog accept`.
 */
function notBuildingPart() {
  const list = t.data?.notBuilding ?? [];
  if (!list.length) return null;
  const query = t.decide.nbQuery ?? '';
  const shown = list.filter((e) => notBuildingMatch(e, query)).length;
  const count = el('p', { id: 'decide-nb-count', class: 'decide-nb-count', role: 'status', 'aria-live': 'polite', text: notBuildingCount(shown, list.length) });
  const items = list.map((e) => {
    const li = notBuildingItem(e);
    li.hidden = !notBuildingMatch(e, query);
    return li;
  });
  const search = el('input', {
    type: 'search',
    id: 'decide-nb-search',
    class: 'search decide-nb-search', // the Tasks room's search field
    value: query,
    placeholder: 'Search title, reason or keyword',
    'aria-describedby': 'decide-nb-count',
    'data-focus': 'nb-search',
    autocomplete: 'off',
  });
  // Filters in place (no redraw), so the caret and the focus stay where they are.
  search.addEventListener('input', () => {
    t.decide.nbQuery = search.value;
    let n = 0;
    list.forEach((e, i) => {
      const hit = notBuildingMatch(e, search.value);
      items[i].hidden = !hit;
      if (hit) n += 1;
    });
    count.textContent = notBuildingCount(n, list.length);
  });
  const box = el(
    'details',
    { class: 'decide-done decide-nb', open: t.decide.nbOpen },
    el('summary', { text: `Not building (${list.length})` }),
    el('p', {
      class: 'decide-hint',
      text: 'What you chose not to build, with the reason. A new proposal that reads like one gets an INFO line; nothing is stopped.',
    }),
    el('label', { class: 'decide-nb-label', for: 'decide-nb-search', text: 'Search' }),
    search,
    count,
    el('ul', { class: 'decide-nb-list' }, items),
  );
  box.addEventListener('toggle', () => (t.decide.nbOpen = box.open));
  return box;
}

/** Answers given but not entered in the decision log yet (the orchestrator does that). */
function unloggedLine() {
  const list = t.data?.inbox?.unlogged ?? [];
  if (!list.length) return null;
  return el('p', {
    class: 'inbox-info',
    text:
      `${list.length} ${list.length === 1 ? 'answer is' : 'answers are'} not entered in the decision log yet ` +
      `(${list.map((x) => x.sp).join(', ')}). The orchestrator enters them (ravenseat resolutions --unlogged).`,
  });
}

/**
 * Draws the room into the board area. `fresh` = an action by the owner (redraw even while a text field has focus,
 * and put focus on the current card).
 */
function drawDecisions(fresh) {
  if (t.view !== 'decisions') return;
  const D = DV();
  const active = document.activeElement;
  // A text field with focus is not redrawn under the owner's hands (the answer, and the "Not building" search).
  if (!fresh && main.contains(active) && (active.tagName === 'TEXTAREA' || active.id === 'decide-nb-search')) return;
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
  rememberSeen();
  const items = decisionItems();
  const groups = D.groupItems(items);
  const order = groups.flatMap((g) => g.items.map((x) => x.key));
  if (!order.includes(t.decide.focusKey)) t.decide.focusKey = order[0] ?? null;
  const focusKey = t.decide.focusKey;
  // The keys hint names only the numbers that exist on the cards now, and never more than the keys that work.
  const most = Math.min(D.NUMBER_KEYS, Math.max(0, ...items.map((x) => x.options.length)));
  const kbd = (k) => el('kbd', { text: k });
  const head = el(
    'header',
    { class: 'decide-head' },
    el('h2', { id: 'decide-title', class: 'decide-heading', text: 'Decisions' }),
    // B30: the "?" opens the help at Waiting on you and Decisions.
    roomHelp('waiting', 'Decisions'),
    items.length
      ? el(
          'p',
          { class: 'decide-keys' },
          kbd('j'),
          ' ',
          kbd('k'),
          ' move · ',
          kbd('Enter'),
          ' recommended',
          ...(most ? [' · ', kbd('1'), ...(most > 1 ? [' to ', kbd(String(most))] : []), ' choose'] : []),
          ' · ',
          kbd('u'),
          ' undo',
        )
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
        text: 'New questions, checks and proposals land here. You can also answer them in Claude Code with /ravenseat:decide.',
      }),
    );
  for (const g of groups) {
    const bar = bulkBar(g);
    const hint =
      g.verb === 'decide' && t.data.inbox?.focus_sorted
        ? `${g.hint} Sorted by how much the answer unlocks in focus: step 1 first, then the minutes.`
        : g.hint;
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
        el('p', { class: 'decide-hint', text: hint }),
        el('ol', { class: 'decide-list' }, g.items.map((x) => decisionCard(x, focusKey, { check: !!bar }))),
        bar,
      ),
    );
  }
  parts.push(sortPart(t.data.inbox?.sort), unloggedLine(), decidedPart(), catalogPart(), notBuildingPart());
  main.append(el('section', { class: 'decide', 'aria-labelledby': 'decide-title' }, parts));
  main.scrollTop = scroll;
  if (!hadFocus) return;
  const again = focusData ? main.querySelector(`[data-focus="${CSS.escape(focusData)}"]`) : null;
  if (again && !fresh) again.focus();
  else if (again && focusData.startsWith('select:')) again.focus(); // a checkbox keeps focus while ticking
  else if (again && (focusData.startsWith('bulk') || focusData.startsWith('sort') || focusData.startsWith('keep:'))) again.focus();
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
  // The open panel stops the keys while it is modal, or while focus is in it (from 1200 px, floating or beside, the
  // Decisions keys still work when focus is in the view).
  const panelOpen = t.selected || t.setting || t.help;
  if (panelOpen && (panelModal() || panel.contains(document.activeElement))) return;
  if (t.bulk || !$('guard-background').hidden) return;
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
  const n = Number(e.key);
  if (/^[1-9]$/.test(e.key) && n <= (DV()?.NUMBER_KEYS ?? 4) && item.options[n - 1]) {
    e.preventDefault();
    pickOption(item, n - 1);
  }
});
