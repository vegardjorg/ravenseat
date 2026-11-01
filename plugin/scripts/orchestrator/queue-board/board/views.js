// =============================================================
// views.js: the wiring of the Focus view (plan.js), the focus line, grouping in Flat and Project lanes,
// and the saved and built-in views.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- The plan view (plan.js), the focus line, grouping, saved views and the help ----
/** What plan.js needs from the board (the same helpers and the same write path). */
function planContext() {
  return {
    main,
    data: t.data,
    el,
    icon,
    api,
    message,
    messageWithInfo,
    update: (force) => update(force),
    drawOnNew: draw,
    status: (text) => ($('status').textContent = text),
    pending: () => t.pending,
  };
}

/** The focus line at the top: the steps, the rest, ready in focus, dragged along, and the warning when the focus has nothing ready. */
const focusLine = $('focusLine');
function drawFocusLine() {
  if (!t.data) {
    focusLine.hidden = true;
    return;
  }
  focusLine.hidden = false;
  const f = t.data.focus;
  const toPlan = (text, title) =>
    el('button', {
      type: 'button',
      class: 'button button-outline button-small',
      text,
      title: title,
      onclick: () => {
        setView('plan');
        draw();
      },
    });
  const draft = window.QueuePlan?.hasDraft()
    ? el('span', {
        class: 'badge old',
        text: 'unsaved draft',
        title:
          'The focus view has changes that are not saved. Open Focus and press "Save focus" or "Discard".',
      })
    : null;
  if (!f) {
    focusLine.className = 'focusLine';
    focusLine.replaceChildren(
      el(
        'div',
        { class: 'focus-row' },
        el('span', { class: 'stripe-name', text: 'Focus' }),
        el('span', {
          class: 'focus-text',
          text: 'No focus: the queue starts the most valuable work per minute first.',
          title:
            'With a focus you decide the order: "Auth first, then Payments" makes everything in Auth start before anything in Payments, ' +
            'regardless of score.',
        }),
        draft,
        toPlan('Set focus', 'Open Focus and drag areas or projects to Now and Next.'),
      ),
    );
    return;
  }
  const notice = f.notice ?? null;
  focusLine.className = `focusLine${notice ? ' notice' : ''}`;
  const stage = (f.stage ?? []).flatMap((x, i) => [
    i ? el('span', { class: 'focus-arrow', 'aria-hidden': 'true', text: '→' }) : null,
    el('span', {
      class: `focus-step${i < f.now_count ? ' now' : ''}`,
      text: `${i + 1} ${x.title}`,
      title:
        `Step ${i + 1} (${i < f.now_count ? 'Now' : 'Next'}): ${x.title}, ${x.type}. ` +
        `${x.waiting} waiting, ${x.readyOnes} ready, ${duration(x.min_left)} left.`,
    }),
  ]);
  const counts = [
    el('span', {
      text: f.rest === 'fill' ? 'rest fills free slots' : 'rest waits',
      title:
        f.rest === 'fill'
          ? 'Tasks outside the steps start only when the focus has nothing ready.'
          : 'Tasks outside the steps do not start until the focus changes (slots may stay empty).',
    }),
    f.active
      ? el('span', {
          text: `${f.readyOnes} ready in focus`,
          title: 'Pending tasks in the steps that can start now (no blockers).',
        })
      : null,
    f.active && f.dragged_with
      ? el('span', {
          text: `${f.dragged_with} dragged along`,
          title:
            'Tasks outside the steps that something in focus waits on. They get the focus task\'s step.',
        })
      : null,
    f.to
      ? el('span', {
          text: `until ${String(f.to).slice(0, 10)}`,
          title: 'The focus period applies up to and including this day.',
        })
      : null,
    f.expired ? el('span', { class: 'badge old', text: 'expired' }) : null,
    f.not_started ? el('span', { class: 'badge', text: 'not started' }) : null,
  ].filter(Boolean);
  // The DOM's replaceChildren turns null into the text "null", so the warning row is included only when it exists.
  focusLine.replaceChildren(
    ...[
      el(
        'div',
        { class: 'focus-row' },
        el('span', { class: 'stripe-name', text: f.name ? `Focus "${f.name}"` : 'Focus' }),
        el('span', { class: 'focus-step-list' }, stage),
        el('span', { class: 'focus-tall' }, counts),
        draft,
        toPlan(
          'Edit focus',
          'Open Focus: drag areas and projects between Now, Next, Later and Waiting.',
        ),
      ),
      notice ? el('p', { class: 'focus-warning', role: 'status', text: notice }) : null,
    ].filter(Boolean),
  );
}

// Grouping in Flat and Project lanes. Closed groups are remembered in the browser.
const GROUPINGS = {
  none: 'No grouping',
  area: 'Area → project',
  feature: 'Project → feature',
  stage: 'Focus step',
};
const savedGrouping = store.getItem('queue-board-grouping');
t.grouping = Object.hasOwn(GROUPINGS, savedGrouping ?? '') ? savedGrouping : 'none';
t.closedGroups = new Set(readList('queue-board-closed-groups'));

/** A list of short texts from localStorage (empty on error). */
function readList(key) {
  try {
    const x = JSON.parse(store.getItem(key) ?? '[]');
    return Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.length <= 200) : [];
  } catch {
    return [];
  }
}
function saveLocally(key, val) {
  try {
    store.setItem(key, JSON.stringify(val));
  } catch {
    /* private mode or full storage: applies only to this session */
  }
}

/** The group a card belongs to in the selected grouping: { key, title, orderState }. */
function groupFor(k, g) {
  const projects = t.data.projects ?? [];
  const pIndex = Math.max(
    0,
    projects.findIndex((p) => p.pid === k.project),
  );
  if (g === 'area') {
    const areas = t.data.areas ?? [];
    const oi = areas.findIndex((o) => o.oid === k.area);
    const o = areas[oi];
    const name = o?.title ?? (k.area === 'without-area' ? 'No area' : k.area);
    return {
      key: `o:${k.area}/${k.project}`,
      title: `${name} › ${k.project}`,
      orderState: [oi < 0 ? 9999 : oi, pIndex, ''],
    };
  }
  if (g === 'feature')
    return {
      key: `f:${k.project}/${k.feature ?? ''}`,
      title: `${k.project} › ${k.feature ?? '(no feature)'}`,
      orderState: [pIndex, k.feature ? 0 : 1, k.feature ?? ''],
    };
  // Focus step: the steps in order, then dragged along into the step, outside focus, and on hold last.
  const pl = k.space;
  const f = t.data.focus;
  if (!pl) return { key: 't:other', title: 'Not in the queue', orderState: [9998, 0, ''] };
  if (k.parked) return { key: 't:wait', title: 'On hold', orderState: [9997, 0, ''] };
  if (!f?.active) return { key: 't:none', title: 'No focus', orderState: [0, 0, ''] };
  if (pl.step == null)
    return { key: 't:outside', title: 'Outside focus', orderState: [9990, 0, ''] };
  return {
    key: `t:${pl.step}`,
    title: `T${pl.step + 1} ${f.stage?.[pl.step]?.title ?? ''}`,
    orderState: [pl.step, 0, ''],
  };
}
const compareOrder = (a, b) =>
  a.orderState[0] - b.orderState[0] ||
  a.orderState[1] - b.orderState[1] ||
  a.orderState[2].localeCompare(b.orderState[2], 'en');

/** Like list(), but grouped by the selected grouping (every group can be closed and selected together). */
function groupedList(summary, col, section) {
  const g = t.grouping;
  // Focus step exists only for cards in the queue (in In progress, Review and Built everything would end up in "Not in the queue").
  if (
    g === 'none' ||
    (t.view === 'lanes' && g === 'area') ||
    (g === 'stage' && !MARKABLE_COLUMNS.has(col)) ||
    !summary.length
  )
    return list(summary, col, section);
  const groups = new Map();
  for (const k of summary) {
    const x = groupFor(k, g);
    if (!groups.has(x.key)) groups.set(x.key, { ...x, summary: [] });
    groups.get(x.key).summary.push(k);
  }
  return el(
    'div',
    { class: 'groups' },
    [...groups.values()].sort(compareOrder).map((gr) => {
      const saved = `${section ?? col}|${gr.key}`;
      // The ids, the counter and the box follow the search and the selection (searchBound at the bottom).
      let ids = [];
      const d = el('details', { class: 'group', open: !t.closedGroups.has(saved) });
      d.addEventListener('toggle', () => {
        if (d.open) t.closedGroups.delete(saved);
        else t.closedGroups.add(saved);
        saveLocally('queue-board-closed-groups', [...t.closedGroups].slice(-300));
        rovingSetup(); // the cards in a closed group cannot be the tab stop
      });
      const sum = el('summary', { class: 'group-header' });
      const box = MARKABLE_COLUMNS.has(col)
        ? el('input', {
            type: 'checkbox',
            class: 'mark-group-box',
            'aria-label': `Select the whole group ${gr.title}`,
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => markMany(ids, e.target.checked),
          })
        : null;
      const counter = el('span', { class: 'counter' });
      sum.append(
        ...[box, el('span', { class: 'group-name', text: gr.title }), counter].filter(Boolean),
      );
      d.append(sum, list(gr.summary, col, section));
      searchBound(gr.summary, (match) => {
        ids = match.map((k) => k.id);
        d.hidden = !match.length;
        sum.title = `${gr.title}: ${ids.length} cards. Click to close or open.`;
        counter.textContent = `${ids.length} · ${duration(match.reduce((s2, k) => s2 + (Number(k.estimate) || 0), 0))}`;
        if (box) {
          box.checked = ids.length > 0 && ids.every((id) => t.marked.has(id));
          box.title = `Select all ${ids.length} cards in the group for the selection bar (bulk actions)`;
        }
      });
      return d;
    }),
  );
}

const groupingOption = $('grouping');
groupingOption.replaceChildren(
  ...Object.entries(GROUPINGS).map(([val, text]) =>
    el('option', { value: val, text, selected: val === t.grouping }),
  ),
);
groupingOption.addEventListener('change', () => {
  t.grouping = groupingOption.value;
  store.setItem('queue-board-grouping', t.grouping);
  draw();
});

// Saved and built-in views: in the browser (localStorage) for now.
const VIEWS_STORAGE = 'queue-board-views';
const LAST_VISIT = 'queue-board-last-visit';
t.lastVisit = Date.parse(store.getItem(LAST_VISIT) ?? '') || null;
const rememberVisit = () => {
  try {
    store.setItem(LAST_VISIT, new Date().toISOString());
  } catch {
    /* no storage */
  }
};
window.addEventListener('pagehide', rememberVisit);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) rememberVisit();
});

/** The built-in views (cannot be deleted). `special` is a filter on the cards in queue, proposed and the batch queue. */
const BUILT_IN = [
  {
    name: 'Focus now',
    special: 'focus1',
    title: 'Only tasks in the first focus step, ready ones first.',
  },
  {
    name: 'Ready in focus',
    special: 'readyFocus',
    title: 'Ready tasks in the focus steps, including those dragged along.',
  },
  {
    name: 'Outside focus, ready',
    special: 'outsideReady',
    title: 'Tasks stopped only by the focus: they can start if you give them a step.',
  },
  { name: 'On hold', special: 'onWait', title: 'Tasks that are put on hold.' },
  {
    name: 'Sort',
    special: 'sort',
    title:
      'Tasks without a project, with an uncertain proposal, or where the project conflicts with the files and the plan they come from.',
  },
  {
    name: 'New since last visit',
    special: 'newEntry',
    title: 'Tasks added after the previous time the board was open in this browser.',
  },
  { name: 'Waiting on me', inbox: true, title: 'Opens "Waiting on you".' },
];
const SPECIAL = {
  focus1: (k) => k.space?.step === 0,
  readyFocus: (k) => k.ready && k.space?.step != null,
  outsideReady: (k) =>
    !!k.space?.outside && !k.parked && k.blockers.every((h) => h === k.space.reason),
  onWait: (k) => !!k.parked,
  sort: (k) => (t.data?.inbox?.sort ?? []).some((r) => r.id === k.id),
  newEntry: (k) => !!t.lastVisit && !!k.added_at && Date.parse(k.added_at) > t.lastVisit,
};
t.special = null;
t.viewName = null;

function ownViews() {
  try {
    const x = JSON.parse(store.getItem(VIEWS_STORAGE) ?? '[]');
    return Array.isArray(x)
      ? x.filter((v) => v && typeof v.name === 'string' && v.name.length <= 60).slice(0, 30)
      : [];
  } catch {
    return [];
  }
}

function useView(v) {
  closeViews(false);
  if (v.inbox) return openInbox();
  t.special = v.special && SPECIAL[v.special] ? v.special : null;
  t.viewName = v.name;
  // Your own views include search, filter, grouping and view; the built-in ones reset search and filter.
  t.filter.search = typeof v.search === 'string' ? v.search.slice(0, 100) : '';
  $('search').value = t.filter.search;
  for (const [n, set] of Object.entries(t.filter.selected)) {
    set.clear();
    for (const x of v.filter?.[n] ?? []) if (typeof x === 'string') set.add(x);
  }
  saveFilter();
  if (v.grouping && Object.hasOwn(GROUPINGS, v.grouping)) {
    t.grouping = v.grouping;
    groupingOption.value = v.grouping;
    store.setItem('queue-board-grouping', v.grouping);
  }
  const show = VIEWS.includes(v.view) ? v.view : null;
  if (show && ['flat', 'lanes', 'graph'].includes(show)) setView(show);
  else if (!['flat', 'lanes', 'graph'].includes(t.view)) setView('flat');
  drawViewButton();
  draw();
}

function saveView(name) {
  const n = name.trim().slice(0, 60);
  if (!n) return message('Write a name for the selection.', true);
  if (BUILT_IN.some((v) => v.name === n))
    return message(`"${n}" is a built-in selection. Choose another name.`, true);
  const fresh = {
    name: n,
    view: t.view,
    search: t.filter.search,
    filter: Object.fromEntries(Object.entries(t.filter.selected).map(([k, set]) => [k, [...set]])),
    grouping: t.grouping,
    special: t.special,
  };
  const list = ownViews().filter((v) => v.name !== n);
  saveLocally(VIEWS_STORAGE, [...list, fresh].slice(-30));
  t.viewName = n;
  message(`Selection "${n}" is saved in this browser.`);
  drawViewButton();
  drawViewMenu();
}

const viewButton = $('views');
const viewMenu = $('views-menu');
function drawViewButton() {
  const name = t.viewName;
  // The saved filters are called "Selection", so they are not confused with the "View" tabs. "Show all"
  // sits at the top of the Selection menu when a selection is in use.
  viewButton.textContent = name ? `Selection: ${name}` : 'Selection';
  viewButton.classList.toggle('active', !!t.special || !!name);
  viewButton.setAttribute(
    'aria-label',
    name ? `Selection, selected: ${name}` : 'Selection: saved and built-in',
  );
}
/** Removes the selection and shows all the cards again (search and filter stay as they are). */
function showAll() {
  closeViews(true);
  t.special = null;
  t.viewName = null;
  drawViewButton();
  draw();
}
function drawViewMenu() {
  const ownOnes = ownViews();
  const row = (v, removeIt) =>
    el(
      'li',
      { class: 'filter-row' },
      el('button', {
        type: 'button',
        class: 'link-button view-option',
        text: v.name,
        title: v.title ?? 'Your saved selection: search, filter, grouping and view.',
        'aria-current': t.viewName === v.name ? 'true' : null,
        onclick: () => useView(v),
      }),
      removeIt
        ? el('button', {
            type: 'button',
            class: 'pause-button',
            text: 'Delete',
            title: `Delete selection "${v.name}" from this browser. The queue does not change.`,
            onclick: () => {
              saveLocally(
                VIEWS_STORAGE,
                ownViews().filter((x) => x.name !== v.name),
              );
              if (t.viewName === v.name) t.viewName = null;
              drawViewButton();
              drawViewMenu();
            },
          })
        : null,
    );
  const nameField = el('input', {
    id: 'view-name',
    type: 'text',
    maxlength: 60,
    placeholder: 'Name of the selection',
    'aria-label': 'Name of the selection',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveView(e.target.value);
      }
    },
  });
  const inUse = !!t.special || !!t.viewName;
  viewMenu.replaceChildren(
    // replaceChildren() turns null into the text "null", so the button is added only when a selection is in use.
    ...(inUse
      ? [
          el(
            'div',
            { class: 'filter-footer show-all' },
            el('button', {
              type: 'button',
              class: 'button button-outline button-small',
              text: 'Show all',
              title: 'Remove the selection and show all cards again',
              onclick: showAll,
            }),
          ),
        ]
      : []),
    el(
      'section',
      { class: 'filter-section' },
      el('div', { class: 'filter-section-header' }, el('h3', { text: 'Built in' })),
      el(
        'ul',
        { class: 'filter-list' },
        BUILT_IN.map((v) => row(v, false)),
      ),
    ),
    el(
      'section',
      { class: 'filter-section' },
      el('div', { class: 'filter-section-header' }, el('h3', { text: 'Your' })),
      ownOnes.length
        ? el(
            'ul',
            { class: 'filter-list' },
            ownOnes.map((v) => row(v, true)),
          )
        : el('p', { class: 'empty', text: 'No saved selections yet.' }),
    ),
    el(
      'div',
      { class: 'filter-footer view-save' },
      nameField,
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Save current',
        title:
          'Saves the search, the filter, the grouping and the view you see now under the name, in this browser. The queue does not change.',
        onclick: () => saveView(nameField.value),
      }),
    ),
  );
}
function openViews() {
  closeFilter(false);
  viewMenu.hidden = false;
  viewButton.setAttribute('aria-expanded', 'true');
  drawViewMenu();
  viewMenu.querySelector('button')?.focus();
}
function closeViews(focusOn) {
  if (viewMenu.hidden) return;
  viewMenu.hidden = true;
  viewButton.setAttribute('aria-expanded', 'false');
  if (focusOn) viewButton.focus();
}
viewButton.addEventListener('click', () =>
  viewMenu.hidden ? openViews() : closeViews(true),
);
viewMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeViews(true);
  }
});
document.addEventListener('click', (e) => {
  if (viewMenu.hidden) return;
  const filePath = e.composedPath();
  if (!filePath.includes(viewMenu) && !filePath.includes(viewButton)) closeViews(false);
});
