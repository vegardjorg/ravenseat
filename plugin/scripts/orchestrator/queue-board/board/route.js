// =============================================================
// route.js: the count in the tab title and the deep links (roadmap 0ø J1 and J2, plans/jira-vurdering-2026-11-18.md).
//
// J1: the browser tab title starts with what waits on the owner, "(3) Queue board", the same number as "Waiting on you"
// (owner answer 2: only what needs you, not running tracks). board.titleCount false keeps the plain title.
// J2: the view and the open card stand in the address, #view=flat&task=EX-12, so the back button works and a link the
// orchestrator writes in the chat opens the card. The board key is never part of it: api.js getKey takes the key out of
// the hash at once (keeping the rest), and routeHash below has no field for it. The Plans room keeps its own address
// (?room=plans, plans/plans.js), so nothing here writes while it is shown.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

/** A display switch from the state (lib/queueConfig.js boardDisplay). Without the field (an older server) it is on. */
function displayOn(name) {
  const d = t.data?.boardDisplay;
  return !d || d[name] !== false;
}

// ---- J1: the count in the tab title ----
const TITLE_COUNT = /^\(\d+\) /;
/**
 * Puts "(n) " before the title when n decisions wait on the owner, and takes it away at 0 or with board.titleCount
 * off. The base is whatever the page has now (board.title, or Plans and Work queue from plans/plans.js), so the two
 * never fight over the title. Called with every new state (drawWaitingButton) and after Plans sets its title.
 */
function drawTabTitle() {
  // Demo mode (board/demo.js): "Demo · " before the title, so the demo tab never passes for the real board.
  const prefix = window.QueueDemo?.TEXTS.titlePrefix ?? 'Demo · ';
  const plain = document.title.replace(TITLE_COUNT, '');
  const bare = plain.startsWith(prefix) ? plain.slice(prefix.length) : plain;
  const base = typeof demoOn === 'function' && demoOn() ? prefix + bare : bare;
  const n = t.data && displayOn('titleCount') ? (DV() ? decisionItems().length : (t.data.inbox?.count ?? 0)) : 0;
  const want = n > 0 ? `(${n}) ${base}` : base;
  if (document.title !== want) document.title = want;
}

// ---- J2: deep links ----
const ROUTE_VIEWS = new Set([...VIEWS, 'decisions', 'checks']);
/** A task id as the queue writes them (letters, digits, dot, dash, underscore); anything else is ignored. */
const ROUTE_TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The view and task in a hash ('#view=flat&task=EX-1'); unknown values are null. The key is never read here. */
function readRoute(hash) {
  const p = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const view = p.get('view');
  const task = p.get('task');
  return { view: ROUTE_VIEWS.has(view) ? view : null, task: task && ROUTE_TASK.test(task) ? task : null };
}

/** The hash for a view and a task: only these two fields, so the key can never be written back. */
function routeHash({ view, task }) {
  const parts = [];
  if (view && ROUTE_VIEWS.has(view)) parts.push(`view=${encodeURIComponent(view)}`);
  if (task && ROUTE_TASK.test(task)) parts.push(`task=${encodeURIComponent(task)}`);
  return parts.length ? `#${parts.join('&')}` : '';
}

/** False until the first state has applied the link in the address: until then nothing may overwrite it. */
let routeReady = false;
/** True while a link is applied: the setView and openPanel it calls do not write a new history step. */
let routeApplying = false;

/**
 * Writes the view and the open card into the address after a change by the owner (a tab, a card, Esc), as a new
 * history step so the back button goes to the previous one. Called from setView, openPanel and closePanel.
 */
function syncRoute() {
  if (!routeReady || routeApplying || document.body.classList.contains('room-plans')) return;
  const want = routeHash({ view: t.view, task: t.selected });
  if (want === hashWithoutKey(location.hash)) return;
  history.pushState(null, '', location.pathname + location.search + want);
}

/** Shows the view and card a link names. An unknown task gets a message and nothing opens. */
function applyRoute(r) {
  routeApplying = true;
  try {
    if (r.view || r.task) window.QueuePlans?.showQueue?.();
    let view = r.view;
    // A view whose module or tab is off is left as it is.
    if (view && VIEW_FEATURE[view] && !featureOn(VIEW_FEATURE[view])) view = null;
    if (view === 'checks' && $('show-checks')?.hidden) view = null;
    if (view === 'timeline' && $('show-timeline')?.hidden) view = null;
    // A card alone opens over a queue view, not over Statistics or Cloud.
    if (!view && r.task && ['statistics', 'cloud'].includes(t.view)) view = 'flat';
    if (view && view !== t.view) {
      setView(view);
      draw();
    }
    if (r.task && r.task !== t.selected) {
      if (t.perId.has(r.task)) {
        openPanel(r.task);
        main.querySelector(`.summary[data-id="${CSS.escape(r.task)}"]`)?.scrollIntoView?.({ block: 'nearest' });
      } else message(`${r.task} is not on the board (done long ago, cancelled or unknown).`, true);
    } else if (!r.task && t.selected) closePanel();
  } finally {
    routeApplying = false;
  }
}

/** The first state is in: apply the link that opened the board (it wins over the landing in Decisions). */
function routeFirstState() {
  if (routeReady || !t.data) return;
  routeReady = true;
  const r = readRoute(location.hash);
  if (r.view || r.task) applyRoute(r);
  if (document.body.classList.contains('room-plans')) return;
  // The address now says where the board is, without adding a history step.
  history.replaceState(null, '', location.pathname + location.search + routeHash({ view: t.view, task: t.selected }));
}

// Back, forward or a pasted link: a key in it is stored and taken out at once (getKey), then the rest is applied.
window.addEventListener('hashchange', () => {
  if (/[#&]key=/.test(location.hash)) t.key = getKey();
  if (!routeReady || document.body.classList.contains('room-plans')) return;
  applyRoute(readRoute(location.hash));
});

window.QueueRoute = { readRoute, routeHash, drawTitle: drawTabTitle };
