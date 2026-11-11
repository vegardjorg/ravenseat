// =============================================================
// core.js: the shared start of the board's client: constants, the state `t`, the filter sections, the
// helpers (el, icons, the clock) and the toast stack.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// The order is the list in index.html: core, api, cards, draw, views, menus, statistics, settings, inbox, panel,
// edit, select, bulk, interact, top, cloud and start (start.js runs the board).
//
// The client for the kanban board of the work queue. Vanilla JS, no build step.
//
// The board fetches the state from queue-board.mjs (which uses the queue's own rules) and writes only via the server, which
// runs queue.mjs. "Waiting on you" (side panel with owner questions, QA, proposed and what is stuck), the "Next up" strip,
// "unlocks N" and the chain around a selected card (highlighted, the rest muted; Esc resets). The chain, "Next up" and
// the inbox are computed on the server (queueBoard.js); here is only the view. The "Dependencies" view (circles and
// strokes) is drawn by graph.js with the layout from queueGraph.js; here is only the wiring (draw and the chain).
// Here is only view and interaction: search and the Filter menu, flat view, project lanes or statistics,
// detail panel, settings (the gear), drag to reprioritize (mouse) and lift/move/drop with the keyboard
// (Space, arrow keys, Space; Esc cancels). If the server answers with a warning from the guard rules (409), the board asks
// the owner first ("Do it anyway" / "Cancel", and a proposal when there is one).
// All text is set with textContent (never innerHTML), so content from the queue cannot become HTML. The charts are inline
// SVG made here, with the colors from the CSS variables.
// =============================================================
'use strict';

const KEY = 'queue-board-key';
const FILTER_STORAGE = 'queue-board-filter';
const COLUMNS = [
  { key: 'queue', name: 'In queue' },
  { key: 'inProgress', name: 'In progress' },
  { key: 'review', name: 'Review' },
  { key: 'built', name: 'Built' },
];
// The Blocked column (board.blockedColumn, off by default): the tasks with an open blocker that needs action. The server
// moves them there (lib/queueBoard.js takeBlocked), so this is only where it stands: right after In queue.
const BLOCKED_COLUMN = { key: 'blocked', name: 'Blocked' };
/** The columns drawn now: COLUMNS, plus Blocked after In queue when the switch is on and the state has the column. */
function shownColumns() {
  const on = t.data?.boardSwitches?.blockedColumn === true && Array.isArray(t.data?.columns?.blocked);
  return on ? [COLUMNS[0], BLOCKED_COLUMN, ...COLUMNS.slice(1)] : COLUMNS;
}

// The columns where the cards can be bulk edited (status waiting or proposed, also in the batch queue).
const MARKABLE_COLUMNS = new Set(['queue', 'proposed', 'batch']);

const $ = (id) => document.getElementById(id);
const main = $('board');
const panel = $('panel');
const background = $('panel-background');

// "graph" is the "Dependencies" view (graph.js, the layout in queueGraph.js). "plan" is
// the plan view (Now, Next, Later, Waiting) in plan.js. The tab is called "Focus" (the id `plan` is kept), so
// it is not confused with the Plans room (the plan register, plans/plans.js).
const VIEWS = ['flat', 'lanes', 'plan', 'graph', 'cloud', 'statistics'];
// The modules that can be switched off (features in queue.config.json, lib/queueConfig.js): the view tabs they own.
const VIEW_FEATURE = { plan: 'focus', cloud: 'cloud', statistics: 'statistics' };
// The names in the gear's "Modules" section (a key the board does not know shows as itself).
const FEATURE_LABEL = {
  plans: 'Plans',
  'plans.legal': 'Plans: Legal',
  'plans.launch': 'Plans: Launch',
  'plans.documents': 'Plans: Documents and agreements',
  focus: 'Focus tab',
  statistics: 'Statistics tab',
  cloud: 'Cloud',
  follow: 'Follow up',
};
// Browser storage throws when it is blocked (some private modes, strict settings). Every read and write goes through
// this wrapper, so the board still works then; the choices just are not remembered.
const store = {
  getItem(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* blocked storage: not remembered */
    }
  },
  removeItem(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* blocked storage: nothing stored */
    }
  },
};
const savedView = store.getItem('queue-board-view');

const t = {
  key: null,
  data: null,
  version: null,
  fetched: null,
  error: null,
  perId: new Map(),
  // The filters: checked options per section in the Filter menu (FILTER_SECTIONS), plus the search.
  filter: { selected: readFilter(), search: '' },
  view: VIEWS.includes(savedView) ? savedView : 'flat',
  showMore: false,
  // Closed sections. Blocked is closed from the start (400+ cards), and the content of a closed
  // section is built only when it is opened (section()).
  closed: new Set(['proposed', 'blocked']),
  // The card that is the tab stop in each column or cell (area key → card id).
  roving: new Map(),
  // What depends on the search (counters, empty texts, groups, lanes). Filled by draw(); the search
  // updates them without rebuilding the board (useSearch()).
  searchDep: [],
  selected: null, // the id in detailPanel
  setting: null, // the settings panel: the answer from /api/settings (null = closed)
  stat: { data: null, version: null, error: null }, // the statistics from /api/statistics
  cloudQueue: { data: null, error: null }, // the "Cloud" view: bundle proposals from /api/cloud-bundles
  details: new Map(), // id → { mission, branch } from /api/task
  busy: false, // a move is being saved: do not redraw the board meanwhile
  pending: false,
  // The chain view
  chain: null, // the id of the card whose chain is highlighted (null = none)
  inbox: false, // "Waiting on you" is open in the side panel
  selectedQa: new Set(), // checked in the QA part
  selectedSuggestion: new Set(), // checked in the Suggestion part
  selectedSort: new Set(), // checked in the Sort part
  answerOpen: null, // the question whose answer field is open
  answerDraft: new Map(), // question → text written so far (survives redraws)
  fromInbox: false, // detailPanel was opened from the inbox (the "Back" button)
  // The cloud view
  cloudSelected: new Set(), // cards in the queue checked for a cloud bundle (the "Suitable for cloud" filter)
  cloudPackage: null, // { ids, text, copied } the last fetched cloud package (the text field is the fallback when copying fails)
  // Multi-select. The selection is ids (survives redraws, filter and view changes); `anchor` is the last selected
  // (Shift-click selects everything between). `bulk` is the bulk action dialog (null = closed).
  marked: new Set(),
  anchor: null,
  bulk: null,
  // The server answered 401 (restarted); the banner is shown and polling stops.
  keyInvalid: false,
};

// ---- The filters (the Filter menu) ----
// The sections are data, so more filters (e.g. class or migrations) are one more entry. `mode`:
//   'all' → every checked option must match (narrowing, like "Only ready now"),
//   'any' → the card must match at least one checked option; none checked = no filtering (like projects).
const FILTER_SECTIONS = [
  {
    key: 'show',
    title: 'Show',
    mode: 'all',
    option: () => [
      {
        val: 'readyOnes',
        text: 'Only ready now',
        matches: (k, col) => (col !== 'queue' && col !== 'proposed' && col !== 'batch') || k.ready,
      },
      { val: 'visuals', text: 'Only visuals', matches: (k) => k.visual },
      // Suitable for a cloud session (queueLogic.cloudSuitable), or already in the cloud. With this filter the cards in the
      // queue get a checkbox, so several can be sent as one bundle.
      {
        val: 'cloud',
        text: 'Suitable for cloud',
        matches: (k, col) =>
          (col !== 'queue' && col !== 'proposed' && col !== 'batch') || !!k.cloud?.suitable,
      },
    ].filter((x) => x.val !== 'cloud' || featureOn('cloud')),
  },
  {
    key: 'projects',
    title: 'Projects',
    mode: 'any',
    option: () =>
      (t.data?.projects ?? []).map((p) => ({
        val: p.pid,
        text: p.pid,
        project: p,
        matches: (k) => k.project === p.pid,
      })),
  },
  // The cards (and the project lanes) filtered by plan entry.
  {
    key: 'plan',
    title: 'Plan entry',
    mode: 'any',
    option: () =>
      [...new Set([...t.perId.values()].map((x) => x.k?.plan).filter(Boolean))]
        .sort()
        .map((id) => ({
          val: id,
          text: [id, window.QueuePlans?.title(id)].filter(Boolean).join(' '),
          matches: (k) => k.plan === id,
        })),
  },
];

/** Saved filters from this browser (localStorage). Empty or broken gives the default: no filters. */
function readFilter() {
  const selected = {};
  let saved = null;
  try {
    saved = JSON.parse(store.getItem(FILTER_STORAGE) ?? 'null');
  } catch {
    saved = null;
  }
  for (const key of ['show', 'projects', 'plan']) {
    const list = saved && Array.isArray(saved[key]) ? saved[key] : [];
    selected[key] = new Set(list.filter((x) => typeof x === 'string' && x.length <= 60));
  }
  return selected;
}
function saveFilter() {
  try {
    const out = {};
    for (const [k, set] of Object.entries(t.filter.selected)) out[k] = [...set];
    store.setItem(FILTER_STORAGE, JSON.stringify(out));
  } catch {
    /* private mode or full storage: the filters apply only to this session */
  }
}
const countFilters = () =>
  Object.values(t.filter.selected).reduce((sum, set) => sum + set.size, 0);
let drag = null; // { type: 'summary' | 'lane', el, list, previous, next, released }
let boosted = null; // same shape, lifted with the keyboard

// ---- Helpers ----
function el(tag, attr, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k.startsWith('--')) e.style.setProperty(k, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const b of children.flat()) if (b != null && b !== false) e.append(b);
  return e;
}

const ICONS = {
  lock: [
    ['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2, fill: 'currentColor' }],
    [
      'path',
      { d: 'M8 11V7a4 4 0 0 1 8 0v4', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 },
    ],
  ],
  close: [
    [
      'path',
      {
        d: 'M6 6l12 12M18 6L6 18',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
      },
    ],
  ],
  // Checkmark: empty inbox ("Nothing waiting on you").
  checkmark: [
    [
      'path',
      {
        d: 'M5 12.5l4.5 4.5L19 7',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
    ],
  ],
  handle: [9, 15].flatMap((x) =>
    [6, 12, 18].map((y) => ['circle', { cx: x, cy: y, r: 1.6, fill: 'currentColor' }]),
  ),
  // Gear: a ring and eight teeth.
  gear: [
    ...[0, 45, 90, 135, 180, 225, 270, 315].map((v) => [
      'rect',
      {
        x: 10.25,
        y: 1.5,
        width: 3.5,
        height: 5,
        rx: 1,
        fill: 'currentColor',
        transform: `rotate(${v} 12 12)`,
      },
    ]),
    [
      'circle',
      { cx: 12, cy: 12, r: 5.25, fill: 'none', stroke: 'currentColor', 'stroke-width': 3 },
    ],
  ],
};
function icon(name, label) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', `icon ${name}`);
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  for (const [tag, attr] of ICONS[name]) {
    const d = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attr)) d.setAttribute(k, String(v));
    s.append(d);
  }
  return s;
}

/** "14 min", "3 h 12 min", "4 d" (display only). */
function age(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  return hours < 48 ? `${hours} h ${min % 60} min` : `${Math.floor(hours / 24)} d`;
}
const clock = (d) =>
  d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---- The toast stack ----
// The message and "Undo" sit in the same stack (#toaster, flex-column), so they never overlap. The queue
// (QueueA11y.toastAdd) says which are shown and in which order: newest at the bottom. "Undo" never drops out of the
// queue before the 30 seconds have passed or the owner closes it.
const TOAST_EL = { message: 'message', undo: 'undo-message' };
let toastQueue = [];
function drawToaster() {
  for (const [key, id] of Object.entries(TOAST_EL)) {
    const i = toastQueue.indexOf(key);
    const box = $(id);
    box.hidden = i < 0;
    box.style.order = String(Math.max(0, i));
  }
}
function showToast(key) {
  toastQueue = window.QueueA11y.toastAdd(toastQueue, key, { max: 3, kept: ['undo'] });
  drawToaster();
}
function hideToast(key) {
  toastQueue = window.QueueA11y.toastRemove(toastQueue, key);
  drawToaster();
}

let messageTime = null;
function message(text, error, ms) {
  const m = $('message');
  m.textContent = text;
  m.classList.toggle('error', !!error);
  showToast('message');
  clearTimeout(messageTime);
  messageTime = setTimeout(() => hideToast('message'), ms ?? (error ? 9000 : 6000));
}
