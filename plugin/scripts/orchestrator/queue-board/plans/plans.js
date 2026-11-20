// =============================================================
// plans.js: the Plans room on the queue board (see docs/board.md).
// Vanilla JS, no build step, no CDN.
//
// The board has two workspaces at the top: Plans and Queue. The room is in the url (`?room=plans`), together with the
// filters, the search, the selected entry and the tab, so the back button and bookmarks work. The Queue room is
// today's board (board.js), unchanged.
//
// Plans has three panes: filters with match counts (left), a foldable list module › project › entry with rolled-up
// progress (middle) and the detail panel with tabs (right). Above them sits the breadcrumb with copy buttons.
// All the rules (url, the facets, the tree, path, the copy lines, the queue status) are the pure functions in
// scripts/lib/queuePlanView.js (window.QueuePlanView, tested in jest); here is only the view and the interplay.
//
// Reading: GET /api/plans (plans.json and queue.json, read only, with a version so unchanged data is not sent again).
// The room writes nothing: changes to the plan register are made with `queue.mjs plan …` (and later batches).
// All text is set with textContent (never innerHTML), so content from the register cannot become HTML.
//
// The link to the queue: window.QueuePlans.openEntry(id) (marker on the queue cards) and window.QueueBoard.showTask(id)
// (the links in the Queue tab, set by board.js).
//
// The room has two surfaces, Plan entries and Documents and agreements (`surface=doc` in the url).
// The document surface is drawn by plans/documents.js (window.QueuePlanDoc.cells) with helpers from here.
//
// The plan entries can be shown as List or Priority map (`show=map`), and the deadline band sits above
// the panes. Both are drawn by plans/map.js (window.QueuePlanMap) with helpers from here; the map is the only thing in
// the room that writes (POST /api/plan-prioritize, after a preview).
//
// In addition Tree map (`show=treeMap`) and Dependencies (`show=dep`, the selection or the selected entry with
// its neighbors), drawn by plans/structure.js (window.QueuePlanStructure) with helpers from here. They write nothing.
//
// The Documents tab reads the sources (GET /api/doc), and the Unregistered box sits above the panes on the Plan
// entries surface with "New entry" and "Add as source" (preview first). Both are drawn by plans/read.js
// (window.QueuePlanRead) with helpers from here.
//
// The Legal, Decisions and Launch surfaces are drawn by plans/legal.js
// (window.QueuePlanLegal), which also does its own two write calls (answer via resolve and the lawyer package).
//
// The Overview surface (the start page when you enter Plans) is drawn by plans/overview.js
// (window.QueuePlanOverview). The keyboard (j, k, Enter, /, 1 to 4, c, x), Ctrl+K, multi select with the action bar,
// the row menu and "changed by session" live in plans/work.js (window.QueuePlanWork). Here is only the wiring, and the
// live update: a call to /api/plans with wait=1 that the server holds until the register changes.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;
  const $ = (id) => document.getElementById(id);
  const room = $('plans-room');
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)
  const OPEN_STORAGE = 'queue-board-plans-open';
  const FACET_STORAGE = 'queue-board-plans-facets';
  const VIEW_STORAGE = 'queue-board-plans-views';
  const CLOSED_STORAGE = 'queue-board-plans-doc-closed'; // the document groups you have closed
  // The Roadmap's choices per viewer (layout, group, compact, Details open on the plan page). Only a convenience: with
  // storage blocked the defaults apply (plans.roadmapLayout and the width).
  const ROADMAP_STORAGE = 'queue-board-plans-roadmap';

  const s = {
    data: null,
    version: null,
    error: null,
    fetching: false,
    state: V.readUrl(location.search),
    // The Plans state the last time the room was open, so "Plans" at the top takes you back to where you were.
    lastPlans: null,
    openOnes: new Set(readList(OPEN_STORAGE)),
    facetOpen: new Set(readList(FACET_STORAGE, ['module', 'pri'])),
    ownOnes: readList(VIEW_STORAGE).map(V.cleanOwnView).filter(Boolean),
    undo: [], // previous filter choices (search parts), for "Undo filter"
    drawer: false, // narrow screen: the filters of Documents and Legal are open as a drawer
    // P4: the open Filter, Sort or narrow "Filter and sort" menu (plans/filter.js), the "Save current as…" field and
    // what is typed in it, so a redraw from a live update keeps them as they were.
    menu: null,
    saveAsOpen: false,
    saveName: '',
    // P6: the "+ New plan" form (plans/capture.js): open, what is typed, busy while it saves, the last error.
    capture: { open: false, title: '', text: '', busy: false, error: null },
    closed: new Set(readList(CLOSED_STORAGE)), // closed document groups (open by default)
    roadmap: readObject(ROADMAP_STORAGE), // the viewer's Roadmap choices
    roadmapOpen: new Set(), // the Roadmap sections opened past the fold (this visit only)
    moreViews: false, // the More views disclosure is open
    roadmapTop: 0, // where the Roadmap was scrolled, so Back from a plan page lands in the same place
    startPending: false, // Plans was opened before the register came; plans.startView is applied when it does
    // P5: the last answer from /api/plan-search: for which search and register version, the hits by plan id, the search
    // on its way (busy) and whether the server stopped at its limit (partial).
    docSearch: { q: '', version: null, hits: new Map(), busy: null, partial: false },
  };

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
  // PLAN-3a-QA1: the room is filled only with the parts that apply to the surface. Optional parts are null, and adding
  // them directly would insert a raw "null" text under the tabs (Element.append turns null into text).
  const fillRoom = (...children) => room.append(...V.roomChildren(children));
  function readList(key, standard = []) {
    try {
      const x = JSON.parse(localStorage.getItem(key) ?? 'null');
      return Array.isArray(x) ? x : standard;
    } catch {
      return standard;
    }
  }
  function readObject(key) {
    try {
      const x = JSON.parse(localStorage.getItem(key) ?? 'null');
      return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
    } catch {
      return {};
    }
  }
  function save(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* private mode or full storage: applies only to this session */
    }
  }
  function message(text, error) {
    if (window.QueueBoard?.message) window.QueueBoard.message(text, error);
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      // The confirmation shows exactly what was copied.
      message(`Copied: ${text}`);
    } catch {
      message(`Could not copy automatically. Select and copy it yourself: ${text}`, true);
    }
  }
  function copyButton(text, label, cls = 'button-small button-outline plans-copy') {
    return el('button', {
      type: 'button',
      class: cls,
      text: 'Copy',
      title: text,
      'aria-label': label,
      onclick: (e) => {
        e.stopPropagation();
        copy(text);
      },
    });
  }
  /**
   * A CLI command the board cannot run itself, as the same chip as on the board (cliChip in board/core.js, B31 X6):
   * "Claude Code:", the command, and "Copy", last in its text, never mid-sentence.
   */
  function cliChip(command) {
    return el(
      'span',
      { class: 'cli-chip' },
      el('span', { class: 'cli-chip-label', text: 'Claude Code:' }),
      el('code', { text: command }),
      copyButton(command, `Copy ${command}`, 'button-small button-outline'),
    );
  }
  const date = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? String(iso)
      : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  };
  const entryFor = (id) => s.data?.entries.find((p) => p.id === id) ?? null;

  // ---- The room and the url ----
  const isPlans = () => s.state.room === 'plans';
  // The modules that can be switched off (features in queue.config.json; board.js sets window.QueueFeatures from the
  // state). The surfaces that belong to one; a surface that is off is not shown and its url falls back to the overview.
  const featureOn = (name) => window.QueueFeatures?.on(name) ?? true;
  const SURFACE_FEATURE = { jur: 'plans.legal', launch: 'plans.launch', doc: 'plans.documents' };
  const surfaceOn = (id) => !SURFACE_FEATURE[id] || featureOn(SURFACE_FEATURE[id]);

  /**
   * New state: the url is updated (push = a new step in the history; otherwise the step is replaced, e.g. while you
   * type in the search), the room is shown and Plans is drawn. The Queue room has no search part, so its address is as before.
   */
  function useState(fresh, { push = true, scroll = false, focus = null } = {}) {
    if (isPlans() && fresh.room !== 'plans') s.lastPlans = s.state;
    // an open Filter or Sort menu closes when you move to another surface, view or plan
    if (fresh.room !== s.state.room || fresh.surface !== s.state.surface || fresh.show !== s.state.show || fresh.entry !== s.state.entry)
      s.menu = null;
    s.state = fresh;
    const url = location.pathname + (fresh.room === 'plans' ? V.writeUrl(fresh) : '');
    if (url !== location.pathname + location.search) {
      if (push) history.pushState(null, '', url);
      else history.replaceState(null, '', url);
    }
    showRoom();
    // `focus`: the data-focus of the element that gets focus after drawing (the plan page's title, or the card you
    // came from when you go back to the Roadmap).
    if (isPlans()) draw({ scroll, focus });
  }

  /** Filter change: the previous choice goes on the undo stack. `opts` goes to useState (for example the focus). */
  function newFilter(filter, extra = {}, opts = {}) {
    const previous = V.writeUrl({ ...s.state, entry: null });
    s.undo.push(previous);
    if (s.undo.length > 20) s.undo.shift();
    useState({ ...s.state, filter, ...extra }, opts);
  }

  function showRoom() {
    const p = isPlans();
    document.body.classList.toggle('room-plans', p);
    room.hidden = !p;
    for (const [id, selected] of [
      ['room-plans', p],
      ['room-queue', !p],
    ]) {
      const b = $(id);
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
      b.tabIndex = selected ? 0 : -1;
    }
    // The Decisions tab (board/decide.js) sits in the same tab list: it sets Queue and Decisions from the view.
    if (typeof drawRoomTabs === 'function') drawRoomTabs();
    document.title = p ? 'Plans' : 'Work queue';
    const h1 = document.querySelector('.top .title');
    if (h1) h1.textContent = p ? 'Plans' : 'Work queue';
    if (p && !s.data) get();
  }

  window.addEventListener('popstate', () => {
    const fresh = V.readUrl(location.search);
    if (isPlans() && fresh.room !== 'plans') s.lastPlans = s.state;
    s.menu = null;
    s.state = fresh;
    showRoom();
    if (isPlans()) draw({ scroll: true });
  });

  function selectRoom(r) {
    if (r === 'plans') {
      if (isPlans()) return;
      // Plans opens where you were, else on plans.startView (the Roadmap by default; the overview and the list are the
      // other choices). Before the register has come the setting is not known yet: the Roadmap is shown, and get()
      // moves to the chosen start page when the answer comes (startPending).
      if (!s.lastPlans && !s.data) s.startPending = true;
      useState(s.lastPlans ?? V.readUrl(V.startSearch(s.data?.view?.startView)));
    } else if (isPlans()) useState({ ...s.state, room: 'queue' });
  }
  $('room-plans').addEventListener('click', () => selectRoom('plans'));
  $('room-queue').addEventListener('click', () => selectRoom('queue'));
  // The room tabs: the arrow keys move focus, Enter or space selects (like the view tabs).
  $('room-option').addEventListener('keydown', (e) => {
    // Plans can be off and so can Checks; Decisions (board/decide.js) and Checks (board/checks.js) come after Queue.
    const buttons = [$('room-plans'), $('room-queue'), $('show-decisions'), $('show-checks')].filter((b) => b && !b.hidden);
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const j = window.QueueA11y.tabMeasure(buttons.length, i, e.key);
    if (j == null) return;
    e.preventDefault();
    buttons[i].tabIndex = -1;
    buttons[j].tabIndex = 0;
    buttons[j].focus();
  });

  // ---- Fetching ----
  async function get(force = false, { wait = false } = {}) {
    const key = sessionStorage.getItem(KEY);
    // the waiting call (wait) has its own flag, so a normal fetch (e.g. after a save) is not
    // held back by it.
    const flag = wait ? 'listener' : 'fetching';
    if (s[flag] || !key) return;
    s[flag] = true;
    try {
      // wait=1 holds the answer until plans.json or queue.json changes (live update).
      const q =
        s.version && !force
          ? `?version=${encodeURIComponent(s.version)}${wait ? '&wait=1' : ''}`
          : '';
      const res = await fetch(`/api/plans${q}`, { headers: { 'X-Queue-Key': key } });
      let answer = null;
      try {
        answer = await res.json();
      } catch {
        answer = null;
      }
      if (!res.ok) throw new Error(answer?.message ?? `HTTP ${res.status}`);
      s.error = null;
      if (!answer.unchanged) {
        // entries a session has changed since last time get a short "changed by session" marker.
        window.QueuePlanWork?.changed(V.changedEntries(s.data, answer.data));
        s.data = answer.data;
        // the document folders the reader allows come from the configuration on the server.
        if (Array.isArray(answer.data?.read_folders)) V.setReadFolders(answer.data.read_folders);
        s.version = answer.version;
        // The first answer after Plans was opened from the top: the start page from plans.startView, as long as you
        // are still on the Roadmap you got while waiting.
        if (s.startPending) {
          s.startPending = false;
          const start = V.startSearch(answer.data?.view?.startView);
          if (isPlans() && V.writeUrl(s.state) === V.writeUrl(V.readUrl(V.startSearch('roadmap'))) && start !== V.startSearch('roadmap')) {
            s.state = V.readUrl(start);
            history.replaceState(null, '', location.pathname + V.writeUrl(s.state));
          }
        }
        // while a chip is dragged or lifted in the priority map, the drawing waits until it is dropped.
        // the same while a row menu is open (it redraws when it closes).
        if (isPlans() && !window.QueuePlanMap?.busy() && !window.QueuePlanWork?.busy()) draw();
      }
    } catch (e) {
      s.error = e.message;
      if (isPlans() && !s.data) draw();
    } finally {
      s[flag] = false;
    }
  }

  // ---- Full-text search in the plan documents (P5) ----
  // The search box filters the register here in the browser at once; for a search of at least V.DOC_SEARCH_MIN
  // characters the server also looks in the plan documents (GET /api/plan-search, read only, cached per file there).
  // The answer is kept per search and register version, so a redraw from the poll does not ask again; the plans it adds
  // come after the plans whose own words match (V.searchWithDocuments). Off with plans.searchDocuments false.
  const docSearchOn = () => featureOn('plans') && s.data?.view?.searchDocuments !== false;

  /** The hits for the search in use (a Map by plan id), asking the server when they are missing or old; null when off. */
  function docHitsFor(search) {
    const q = String(search ?? '');
    if (!docSearchOn() || q.length < V.DOC_SEARCH_MIN) return null;
    const ds = s.docSearch;
    if (ds.q !== q || ds.version !== s.version) fetchDocHits(q);
    // an answer for the same search from an older version still shows until the fresh one comes
    return ds.q === q ? ds.hits : null;
  }

  /** The state roadmap.js shows in its status line, or null when the documents are not part of this search. */
  function docSearchState() {
    const q = s.state.search ?? '';
    if (!docSearchOn() || q.length < V.DOC_SEARCH_MIN) return null;
    return { busy: s.docSearch.busy === q, partial: s.docSearch.q === q && s.docSearch.partial };
  }

  async function fetchDocHits(q) {
    const key = sessionStorage.getItem(KEY);
    if (!key || s.docSearch.busy === q) return;
    const version = s.version;
    s.docSearch.busy = q;
    let hits = new Map();
    let partial = false;
    try {
      const res = await fetch(`/api/plan-search?q=${encodeURIComponent(q)}`, { headers: { 'X-Queue-Key': key } });
      const answer = await res.json().catch(() => null);
      if (res.ok && answer?.enabled !== false)
        for (const x of Array.isArray(answer?.hits) ? answer.hits : [])
          if (x && typeof x.id === 'string' && typeof x.match === 'string') hits.set(x.id, x);
      partial = answer?.partial === true;
    } catch {
      hits = new Map(); // the register's own matches still show; the documents are a bonus
    }
    if (s.docSearch.busy === q) s.docSearch.busy = null;
    // the search moved on while this one was on its way: its answer is not used
    if ((s.state.search ?? '') !== q) return;
    s.docSearch = { q, version, hits, busy: s.docSearch.busy, partial };
    if (isPlans() && !window.QueuePlanMap?.busy() && !window.QueuePlanWork?.busy()) draw();
  }

  // ---- Drawing ----
  /**
   * Redraws the whole room. Focus and scrolling are kept (the element with the same data-focus gets focus back,
   * and the search field gets the cursor where it was), so an update from the server does not move you.
   */
  function draw({ scroll = false, focus = null } = {}) {
    window.QueuePlanMap?.doneDrawn();
    const active = document.activeElement;
    // `focus` is the element that should have focus afterwards (e.g. the chip that was just moved).
    const focusKey = focus ?? (room.contains(active) ? active?.dataset?.focus : null);
    const cursor = active?.selectionStart ?? null;
    const scrolling = [...room.querySelectorAll('[data-scroll]')].map((e) => [
      e.dataset.scroll,
      e.scrollTop,
    ]);
    // the Roadmap's scroll position survives a visit to a plan page (Back lands where you were).
    for (const [n, top] of scrolling) if (n === 'roadmap') s.roadmapTop = top;

    room.replaceChildren();
    if (!s.data) {
      fillRoom(
        el('p', {
          class: 'empty plans-fetching',
          text: s.error ? `Could not read the plan register: ${s.error}` : 'Fetching the plan register …',
        }),
      );
      return;
    }
    const d = s.data;
    // A surface whose module is off (an old link or bookmark) shows the overview instead.
    if (!surfaceOn(s.state.surface)) s.state = { ...s.state, surface: 'overview' };
    const t = s.state;
    // The overview is drawn by overview.js.
    if (t.surface === 'overview' && window.QueuePlanOverview) {
      room.classList.remove('has-selected');
      fillRoom(
        pathEl(d),
        surfaceOptionEl(d),
        window.QueuePlanMap ? window.QueuePlanMap.deadlineBand(mapHelp, d, null) : null,
        window.QueuePlanOverview.side(workHelp, d),
      );
      afterDrawing(focusKey, cursor, scrolling, false);
      return;
    }
    // The Roadmap and the plan page are drawn by roadmap.js (P1 and P2 of the Plans rework). No filter pane and no
    // detail panel: the page is one column that scrolls, and the plan page takes the whole width.
    if (t.surface === 'roadmap' && window.QueuePlanRoadmap) {
      room.classList.remove('has-selected', 'drawer-open');
      const p = t.entry ? entryFor(t.entry) : null;
      // P4: the Roadmap's plans in the chosen Sort (Roadmap order by default).
      // P5: with a search, the plans found in their plan document come after the ones whose own words match.
      const sorted = p
        ? []
        : V.searchWithDocuments(d.entries, t.filter, t.search, docHitsFor(t.search), { sort: currentSort() });
      const body = p
        ? window.QueuePlanRoadmap.page(roadmapHelp, d, p)
        : window.QueuePlanRoadmap.cells(roadmapHelp, d, sorted);
      fillRoom(
        pathEl(d, { drawer: false }),
        surfaceOptionEl(d),
        el(
          'div',
          { class: 'plans-roadmap-scroll', 'data-scroll': p ? 'page' : 'roadmap' },
          t.entry && !p
            ? el('p', {
                class: 'empty',
                text: `Did not find ${t.entry} in the register (merged or removed).`,
              })
            : null,
          body,
        ),
      );
      if (!p && !scrolling.some(([n]) => n === 'roadmap')) scrolling.push(['roadmap', s.roadmapTop]);
      afterDrawing(focusKey, cursor, scrolling, false);
      return;
    }
    // the document surface is drawn by documents.js; the plan entries as before.
    const docSurface = t.surface === 'doc' && !!window.QueuePlanDoc;
    // Legal, Decisions and Launch are drawn by legal.js.
    const jbSurface = V.JB_SURFACES.includes(t.surface) && !!window.QueuePlanLegal;
    if (jbSurface) {
      room.classList.toggle('has-selected', window.QueuePlanLegal.hasSelected(legalHelp, d));
      room.classList.toggle('drawer-open', s.drawer);
      fillRoom(
        pathEl(d),
        surfaceOptionEl(d),
        t.surface === 'launch' && window.QueuePlanMap
          ? window.QueuePlanMap.deadlineBand(mapHelp, d, window.QueuePlanLegal.launchIds(d))
          : null,
        window.QueuePlanLegal.cells(legalHelp, d),
      );
      afterDrawing(focusKey, cursor, scrolling, scroll);
      return;
    }
    // the priority map (show=map) has the same filters and selection as the list, plus the dropped ones for the folded
    // Drop column.
    const map = !docSurface && t.show === 'map' && !!window.QueuePlanMap;
    // tree map (show=treeMap) and dependencies (show=dep), with the same filters and selection as the list.
    const structure =
      !docSurface && (t.show === 'treeMap' || t.show === 'dep') && !!window.QueuePlanStructure;
    // P4: the list follows the chosen Sort (within each project, since the list is grouped); the maps have their own order.
    const sortable = !docSurface && !map && !structure;
    const match = docSurface
      ? []
      : sortable
        ? V.searchWithDocuments(d.entries, t.filter, t.search, docHitsFor(t.search), { sort: currentSort() })
        : V.filter(d.entries, t.filter, t.search);
    const selected = !docSurface && t.entry ? entryFor(t.entry) : null;
    const selectedDoc = docSurface && t.doc ? (d.documents ?? []).some((x) => x.id === t.doc) : false;
    room.classList.toggle('has-selected', docSurface ? selectedDoc : !!selected);
    room.classList.toggle('drawer-open', s.drawer);
    const pickedOut = V.countFilters(t.filter) > 0 || !!t.search;
    fillRoom(
      // Plan entries has no filter column any more (P4): its search, Filter and Sort sit in a toolbar, so no drawer.
      pathEl(d, { drawer: docSurface }),
      surfaceOptionEl(d),
      docSurface ? null : entriesToolbarEl(d, match, { sort: sortable }),
      docSurface ? null : (window.QueuePlanCapture?.form(captureHelp) ?? null),
      docSurface || !window.QueuePlanMap
        ? null
        : window.QueuePlanMap.deadlineBand(mapHelp, d, pickedOut ? match.map((p) => p.id) : null),
      // The Unregistered box, only on the Plan entries surface.
      docSurface || !window.QueuePlanRead ? null : window.QueuePlanRead.unregisteredBox(readHelp, d),
      docSurface
        ? window.QueuePlanDoc.cells(docHelp, d)
        : el(
            'div',
            { class: 'plans-grid plans-grid-wide' },
            map
              ? window.QueuePlanMap.middle(mapHelp, d, V.mapEntries(d.entries, t.filter, t.search), selected)
              : structure
                ? window.QueuePlanStructure[t.show](structureHelp, d, match, selected)
                : listEl(d, match, selected),
            detailEl(d, selected),
          ),
      // the action bar for multi select, at the bottom.
      docSurface || !window.QueuePlanWork ? null : window.QueuePlanWork.optionLine(workHelp, d),
    );
    afterDrawing(focusKey, cursor, scrolling, scroll && (selected || selectedDoc));
  }

  /** After drawing: scrolling, focus and cursor back, and the chosen row in view (with `scroll`). */
  function afterDrawing(focusKey, cursor, scrolling, scroll) {
    for (const [n, top] of scrolling) {
      const e = room.querySelector(`[data-scroll="${n}"]`);
      if (e) e.scrollTop = top;
    }
    if (focusKey) {
      const fresh = room.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (fresh) {
        fresh.focus();
        if (cursor != null && typeof fresh.setSelectionRange === 'function')
          fresh.setSelectionRange(cursor, cursor);
      }
    }
    if (scroll)
      room
        .querySelector('.plans-entry.selected, .doc-row.selected, .jb-row.selected')
        ?.scrollIntoView({ block: 'nearest' });
  }

  // ---- the surfaces in the room (Plan entries, Documents and agreements, and Legal, Decisions and
  // Launch) ----
  function surfaceOptionEl(d) {
    const now = V.SURFACES.some((f) => f.id === s.state.surface) ? s.state.surface : 'entries';
    // Legal and Decisions show the open ones, Launch what remains.
    const count = V.surfaceCount(d);
    // The overview is not a tab any more (it is under More views, with the maps); without roadmap.js loaded it stays.
    const shown = V.SURFACES.filter(
      (f) =>
        surfaceOn(f.id) &&
        (window.QueuePlanRoadmap ? !f.more : f.id !== 'roadmap'),
    );
    // On a More views page no tab is selected; the first tab then takes the Tab key, so the list stays reachable.
    const reachable = shown.some((f) => f.id === now) ? now : shown[0]?.id;
    const tabs = el(
      'div',
      {
        class: 'plans-surfaces',
        role: 'tablist',
        'aria-label': 'What the room shows',
        onkeydown: (e) => {
          const buttons = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const i = buttons.indexOf(document.activeElement);
          if (i < 0) return;
          const j = window.QueueA11y.tabMeasure(buttons.length, i, e.key);
          if (j == null) return;
          e.preventDefault();
          buttons[i].tabIndex = -1;
          buttons[j].tabIndex = 0;
          buttons[j].focus();
        },
      },
      ...shown.map((f) =>
          el(
            'button',
            {
              type: 'button',
              role: 'tab',
              class: 'plans-surface',
              'aria-selected': f.id === now ? 'true' : 'false',
              tabindex: f.id === reachable ? '0' : '-1',
              'data-focus': `surface:${f.id}`,
              onclick: () => {
                // Plan entries while a map is shown: back to the list (the maps are under More views).
                if (f.id === 'entries' && now === 'entries' && V.moreViewNow(s.state))
                  useState({ ...s.state, show: 'list' });
                else if (f.id !== now) useState({ ...s.state, surface: f.id, entry: null });
              },
            },
            f.text,
            count[f.id] != null ? el('span', { class: 'plans-count', text: String(count[f.id]) }) : null,
          ),
        ),
    );
    return el('div', { class: 'plans-surfaces-row' }, tabs, moreViewsEl());
  }

  /**
   * More views: the overview and the maps (Priority map, Tree map, Dependencies), which are tools for working on the
   * plans rather than for reading them. A disclosure with one button per view; the one shown is marked (aria-current).
   */
  function moreViewsEl() {
    if (!window.QueuePlanRoadmap) return null;
    const current = V.moreViewNow(s.state);
    const views = V.MORE_VIEWS.filter((v) =>
      v.id === 'overview'
        ? !!window.QueuePlanOverview
        : v.id === 'map'
          ? !!window.QueuePlanMap
          : !!window.QueuePlanStructure,
    );
    if (!views.length) return null;
    const label = current ? `More views: ${views.find((v) => v.id === current)?.text ?? ''}` : 'More views';
    // The open state survives a redraw from a live update (s.moreViews), and closes when a view is chosen.
    return el(
      'details',
      {
        class: 'plans-more-views',
        open: s.moreViews || null,
        ontoggle: (e) => {
          s.moreViews = e.currentTarget.open;
        },
      },
      el('summary', { 'data-focus': 'more-views' }, label),
      el(
        'ul',
        { class: 'plans-more-views-list' },
        views.map((v) =>
          el(
            'li',
            null,
            el('button', {
              type: 'button',
              class: 'link-button',
              text: v.text,
              'aria-current': v.id === current ? 'true' : null,
              'data-focus': `more-view:${v.id}`,
              onclick: () => {
                s.moreViews = false;
                // the selected plan entry stays selected between the list and the maps, as before.
                const entry = s.state.surface === 'entries' ? s.state.entry : null;
                useState({ ...s.state, ...v.state, entry }, { focus: 'more-views' });
              },
            }),
          ),
        ),
      ),
    );
  }

  /** The helpers map.js gets (same building blocks as the list, so there is one design language). */
  const mapHelp = {
    el,
    message,
    draw: (opts) => draw(opts),
    get: (force) => get(force),
    activeFilters: (d) => activeFiltersEl(d),
    selectEntry: (id, tab) =>
      useState({ ...s.state, entry: id, tab: tab ?? s.state.tab }, { push: true }),
    selectDoc: (id) => useState({ ...s.state, surface: 'doc', doc: id }, { scroll: true }),
  };

  /**
   * The helpers structure.js gets. The zoom in the tree map is the filter (module and project; the other filters stay),
   * so the breadcrumb zooms out and undo filter and the back button work.
   */
  const structureHelp = {
    el,
    state: () => s.state,
    activeFilters: (d) => activeFiltersEl(d),
    pickedOut: () => V.countFilters(s.state.filter) > 0 || !!s.state.search,
    selectEntry: (id) => useState({ ...s.state, entry: id }, { push: true }),
    zoom: (part) => newFilter({ ...s.state.filter, ...part }, { entry: null }),
    setDep: (dep) => useState({ ...s.state, dep }),
  };

  /** The helpers read.js gets (the reader and the Unregistered box). */
  const readHelp = {
    el,
    message,
    copyButton,
    date,
    list: (...a) => list(...a),
    draw: (opts) => draw(opts),
    get: (force) => get(force),
    goToEntry: (id) =>
      useState(
        {
          ...s.state,
          surface: 'entries',
          filter: V.emptyFilter(),
          search: '',
          entry: id,
          tab: 'summary',
        },
        { scroll: true },
      ),
  };

  /** The helpers documents.js gets (same building blocks as the plan entries, so there is one design language). */
  const docHelp = {
    el,
    copy,
    copyButton,
    cliChip,
    date,
    field: (...a) => field(...a),
    list: (...a) => list(...a),
    priEl: (p) => priEl(p),
    state: () => s.state,
    use: (change, opts) => useState({ ...s.state, ...change }, opts),
    newDocFilter: (dfilter, extra = {}) =>
      useState({ ...s.state, dfilter, doc: null, ...extra }),
    facetIsOpen: (key, standard = []) =>
      s.facetOpen.has(key) || (standard.includes(key) && !s.facetOpen.has(`!${key}`)),
    setFacetOpen: (key, open) => {
      if (open) {
        s.facetOpen.add(key);
        s.facetOpen.delete(`!${key}`);
      } else {
        s.facetOpen.delete(key);
        s.facetOpen.add(`!${key}`);
      }
      save(FACET_STORAGE, [...s.facetOpen]);
    },
    isClosed: (key) => s.closed.has(key),
    toggleClosed: (key) => {
      if (s.closed.has(key)) s.closed.delete(key);
      else s.closed.add(key);
      save(CLOSED_STORAGE, [...s.closed]);
      draw();
    },
    goToEntry: (id) =>
      useState(
        {
          ...s.state,
          surface: 'entries',
          filter: V.emptyFilter(),
          search: '',
          entry: id,
          tab: 'summary',
        },
        { scroll: true },
      ),
  };

  /** The helpers legal.js gets (the document helpers plus message and fetching; the writing lives in legal.js). */
  const legalHelp = {
    ...docHelp,
    message,
    draw: (opts) => draw(opts),
    get: (force) => get(force),
  };

  /**
   * The helpers overview.js and work.js get (same building blocks, so there is one design language). The order of
   * entries in the list is the one shown (DOM), so j and k follow the folding.
   */
  const workHelp = {
    ...legalHelp,
    room,
    isPlans,
    data: () => s.data,
    entryFor,
    progressEl: (f, name) => progressEl(f, name),
    newFilter: (filter, extra) => newFilter(filter, extra),
    visibleEntries: () =>
      [...room.querySelectorAll('.plans-middle .plans-entry[data-entry]')].map((e) => e.dataset.entry),
    selectEntry: (id, { push = false } = {}) =>
      useState({ ...s.state, surface: 'entries', entry: id }, { push, scroll: true }),
    goToList: (change = {}) =>
      useState({ ...s.state, surface: 'entries', ...change }, { scroll: true }),
    selectRoom,
    // P4: `f` opens the Filter menu; while one is open the room's own keys wait (work.js).
    openFilter: () => openFilter(),
    filterMenuOpen: () => !!s.menu,
    // P6: `n` opens "+ New plan" (plans/capture.js).
    openCapture: () => window.QueuePlanCapture?.open(captureHelp),
  };

  /** Saves one of the viewer's Roadmap choices (layout, group, compact, details) and redraws. */
  function setRoadmapPref(change, { redraw = true } = {}) {
    s.roadmap = { ...s.roadmap, ...change };
    save(ROADMAP_STORAGE, s.roadmap);
    if (redraw) draw();
  }

  /**
   * The helpers roadmap.js gets (the same building blocks as the other surfaces). `use` opens and closes the plan page
   * with focus where a keyboard user expects it: on the page's title, and back on the plan's card.
   */
  const roadmapHelp = {
    el,
    copyButton,
    cliChip,
    date,
    state: () => s.state,
    use: (change) => {
      const back = change.entry === null && s.state.entry ? `roadmap:${s.state.entry}` : null;
      const opens = change.entry && change.surface !== 'entries' ? 'page-title' : null;
      useState({ ...s.state, ...change }, { focus: back ?? opens, scroll: change.surface === 'entries' });
    },
    search: (value) => {
      clearTimeout(searchTime);
      const v = String(value).slice(0, 120);
      searchTime = setTimeout(() => useState({ ...s.state, search: v.trim(), entry: null }, { push: false }), 200);
    },
    // P5: the document search's state for the status line (null when the documents are not part of the search).
    docSearch: () => docSearchState(),
    // the window's width, the same measure as the CSS media queries (the layout toggle hides below 700 px).
    width: () => window.innerWidth,
    prefs: () => ({
      layout: ['columns', 'list'].includes(s.roadmap.layout) ? s.roadmap.layout : null,
      group: s.roadmap.group === 'area' ? 'area' : 'horizon',
      compact: s.roadmap.compact === true,
    }),
    setPref: (change) => setRoadmapPref(change),
    isExpanded: (id) => s.roadmapOpen.has(id),
    toggleExpanded: (id) => {
      if (s.roadmapOpen.has(id)) s.roadmapOpen.delete(id);
      else s.roadmapOpen.add(id);
      draw({ focus: `roadmap-more:${id}` });
    },
    detailsOpen: () => s.roadmap.details === true,
    // no redraw: the details element has already opened or closed itself.
    setDetailsOpen: (open) => setRoadmapPref({ details: open === true }, { redraw: false }),
    activeFilters: () => activeFiltersEl(s.data),
    tabContent: (tab, p, d, opts) => tabContent(tab, p, d, opts),
    planDocument: (p) =>
      window.QueuePlanRead?.planDocument
        ? window.QueuePlanRead.planDocument(readHelp, p)
        : tabContent('doc', p, s.data),
    showInQueue: (id) => showInQueue(id),
    // P8: "See tasks" opens the Queue filtered on the plan (plan:<id> in the Queue search, board/start.js).
    showPlanTasks: (id) => {
      useState({ ...s.state, room: 'queue' });
      window.QueueBoard?.showPlan?.(id);
    },
    // P4: the Filter and Sort controls in the Roadmap's toolbar (plans/filter.js), and the Sort in use.
    filterControls: (opts) =>
      window.QueuePlanFilter ? window.QueuePlanFilter.controls(filterHelp, s.data, opts) : null,
    sort: () => currentSort(),
    // P6: "+ New plan" and its form (plans/capture.js); null while features.plans.inbox is off.
    newPlanButton: () => window.QueuePlanCapture?.button(captureHelp) ?? null,
    captureForm: () => window.QueuePlanCapture?.form(captureHelp) ?? null,
  };

  /**
   * The helpers plans/capture.js gets. The form's state lives in `s.capture`, so a live redraw keeps what is typed;
   * typing itself does not redraw (redraw: false), only opening, closing, an error or a save does. The writing (POST)
   * lives in capture.js, as it does in work.js and legal.js: the room itself only reads.
   */
  const captureHelp = {
    el,
    featureOn: () => featureOn('plans') && featureOn('plans.inbox'),
    capture: () => s.capture,
    setCapture: (change, { redraw = true, focus = null } = {}) => {
      Object.assign(s.capture, change);
      if (redraw) draw({ focus });
    },
    message,
    // the board's toast with Undo (board/bulk.js roomUndoToast); a plain message when it is not there
    undoToast: (text, onUndo, title) =>
      window.QueueBoard?.undoToast ? window.QueueBoard.undoToast(text, onUndo, title) : message(text),
    refresh: async () => {
      await get(true);
      draw();
    },
  };

  // The Roadmap's layout follows the width (columns from 1200 px, always a list below 700 px): redraw when the window
  // crosses one of those widths, not on every pixel.
  if (typeof window.matchMedia === 'function')
    for (const w of [V.ROADMAP_NARROW, V.ROADMAP_WIDE]) {
      const q = window.matchMedia(`(min-width: ${w}px)`);
      const redraw = () => {
        if (isPlans() && s.data && s.state.surface === 'roadmap' && !s.state.entry) draw();
      };
      if (typeof q.addEventListener === 'function') q.addEventListener('change', redraw);
    }
  // P4: below 600 px Filter and Sort become one "Filter and sort" tray, on the Roadmap and on Plan entries alike.
  if (typeof window.matchMedia === 'function') {
    const q = window.matchMedia(`(min-width: ${window.QueuePlanFilter?.TRAY_BELOW ?? 600}px)`);
    if (typeof q.addEventListener === 'function')
      q.addEventListener('change', () => {
        if (!isPlans() || !s.data) return;
        s.menu = null;
        draw();
      });
  }

  // ---- The breadcrumb ----
  function pathEl(d, { drawer = true } = {}) {
    const part = V.breadcrumbs(s.state, d);
    return el(
      'nav',
      { class: 'plans-path', 'aria-label': 'Breadcrumb trail' },
      el(
        'ol',
        { class: 'plans-path-list' },
        ...part.map((l, i) => {
          const latest = i === part.length - 1;
          return el(
            'li',
            { class: 'plans-path-part' },
            latest
              ? el('span', { class: 'plans-path-here', 'aria-current': 'location', text: l.text })
              : el('button', {
                  type: 'button',
                  class: 'link-button',
                  text: l.text,
                  'data-focus': `path:${l.level}`,
                  // the parts on the document surface carry the state a click gives.
                  // from a plan page back to the Roadmap, focus lands on the plan's card again.
                  onclick: () =>
                    l.state
                      ? useState(
                          { ...s.state, ...l.state },
                          { focus: s.state.surface === 'roadmap' && s.state.entry ? `roadmap:${s.state.entry}` : null },
                        )
                      : newFilter(l.filter, { entry: null, search: '' }),
                }),
            l.copy
              ? copyButton(
                  l.copy,
                  `Copy the start line for ${l.text}`,
                  'button-small button-outline',
                )
              : null,
          );
        }),
      ),
      // the Roadmap has no filter pane (its search is in its own toolbar), so no Filters button.
      !drawer
        ? null
        : el(
        'button',
        {
          type: 'button',
          class: 'button button-outline plans-drawer-button',
          'aria-expanded': s.drawer ? 'true' : 'false',
          'aria-controls': 'plans-filters',
          'data-focus': 'drawer',
          onclick: () => {
            s.drawer = !s.drawer;
            draw();
          },
        },
        (() => {
          const fl = s.state.surface;
          const n =
            fl === 'doc'
              ? V.countDocFilters(s.state.dfilter)
              : fl === 'jur' || fl === 'decision'
                ? V.countJbFilters(fl, fl === 'jur' ? s.state.jfilter : s.state.bfilter)
                : V.countFilters(s.state.filter);
          return `Filters${n ? ` (${n})` : ''}`;
        })(),
      ),
      // B30: the "?" for the Plans room, last in its one-line header (roomHelp is the board's, board/menus.js).
      typeof roomHelp === 'function' ? roomHelp('plans', 'Plans') : null,
    );
  }

  // ---- The toolbar: search, Filter and Sort (P4 of the Plans rework) ----
  // The old left column (search, views and facet lists) is gone from Plan entries. The search, the Filter menu and the
  // Sort menu sit in one toolbar above the list, like the Tasks room; plans/filter.js draws the two menus, and the
  // Roadmap gets the same controls through roadmapHelp.filterControls. The saved views keep their storage key
  // (VIEW_STORAGE), so views saved in the old column carry over.
  let searchTime = null;

  /** The Sort in use (a per-browser choice in the Roadmap prefs, plan section 8: a view convenience, not a setting). */
  function currentSort() {
    return V.cleanSort(s.roadmap.sort);
  }

  /** The button an open menu belongs to: the tray below 600 px, else Filter. */
  const filterButtonKey = () =>
    window.innerWidth < (window.QueuePlanFilter?.TRAY_BELOW ?? 600) ? 'plans-tray' : 'plans-filter';

  /** The helpers plans/filter.js gets. Every change redraws the room with the focus on the control it belongs to. */
  const filterHelp = {
    el,
    state: () => s.state,
    data: () => s.data,
    width: () => window.innerWidth,
    menu: () => s.menu,
    setMenu: (name, focus) => {
      s.menu = name;
      // a menu opens with the name field closed and empty
      if (name) {
        s.saveAsOpen = false;
        s.saveName = '';
      }
      draw({ focus: focus ?? null });
    },
    ownViews: () => s.ownOnes,
    saveAsOpen: () => s.saveAsOpen,
    setSaveAsOpen: (open) => {
      s.saveAsOpen = open === true;
      if (!s.saveAsOpen) s.saveName = '';
      draw({ focus: s.saveAsOpen ? 'pf-save-name' : 'pf-save-as' });
    },
    saveName: () => s.saveName,
    // no redraw while typing: the field keeps what is typed, and a live update draws it again with the same text
    setSaveName: (v) => {
      s.saveName = String(v ?? '').slice(0, 60);
    },
    saveView: (name) => {
      const n = String(name ?? '').trim();
      if (!n) {
        message('Give the saved filter a name first.', true);
        return;
      }
      if (V.QUICK_FILTERS.some((q) => q.name.toLowerCase() === n.toLowerCase())) {
        message(`"${n}" is already a quick filter. Pick another name.`, true);
        return;
      }
      const fresh = V.cleanOwnView({ name: n, search: V.writeUrl({ ...s.state, entry: null }), sort: currentSort() });
      if (!fresh) return;
      // the same name replaces the old one; at most 30 saved filters, the oldest goes first
      s.ownOnes = [...s.ownOnes.filter((x) => x.name !== fresh.name), fresh].slice(-30);
      save(VIEW_STORAGE, s.ownOnes);
      s.saveAsOpen = false;
      s.saveName = '';
      message(`The filter "${fresh.name}" is saved in this browser.`);
      draw({ focus: 'pf-save-as' });
    },
    deleteView: (name) => {
      s.ownOnes = s.ownOnes.filter((x) => x.name !== name);
      save(VIEW_STORAGE, s.ownOnes);
      message(`The saved filter "${name}" is deleted from this browser.`);
      draw({ focus: 'pf-save-as' });
    },
    newFilter: (filter, extra) => newFilter(filter, extra),
    // a quick or saved filter: the menu closes and the focus goes back to its button. A saved view also brings its sort.
    applyView: (v) => {
      s.menu = null;
      if (v.sort) setRoadmapPref({ sort: V.cleanSort(v.sort) }, { redraw: false });
      const fresh = V.readUrl(v.search);
      newFilter(fresh.filter, { search: fresh.search, entry: null }, { focus: filterButtonKey() });
    },
    showAll: () => {
      s.menu = null;
      newFilter(V.emptyFilter(), { search: '', entry: null }, { focus: filterButtonKey() });
    },
    sort: () => currentSort(),
    // no redraw here: filter.js closes the menu right after, and that draws
    setSort: (id) => setRoadmapPref({ sort: V.cleanSort(id) }, { redraw: false }),
  };

  /** `f` (work.js): opens the Filter menu (the tray on a narrow screen) with the focus on its first row. */
  function openFilter() {
    if (!window.QueuePlanFilter) return;
    s.menu = filterButtonKey() === 'plans-tray' ? 'tray' : 'filter';
    s.saveAsOpen = false;
    draw();
    room.querySelector('.plans-filter-menu')?.querySelector('.view-option, input[type="checkbox"]')?.focus();
  }

  /** The search field on Plan entries (the Roadmap has its own in roadmap.js). `/` jumps here (data-focus "search"). */
  function searchFieldEl() {
    return el(
      'label',
      { class: 'plans-search-label' },
      el('span', { class: 'hidden-for-eye', text: 'Search in the plans' }),
      el('input', {
        type: 'search',
        class: 'search plans-search',
        placeholder: 'Search plans',
        autocomplete: 'off',
        value: s.state.search,
        'data-focus': 'search',
        oninput: (e) => {
          clearTimeout(searchTime);
          const v = e.target.value.slice(0, 120);
          searchTime = setTimeout(() => useState({ ...s.state, search: v.trim() }, { push: false }), 200);
        },
      }),
    );
  }

  /** The toolbar above the Plan entries list and maps: search, Filter, Sort (the list only) and the count. */
  function entriesToolbarEl(d, match, { sort = true } = {}) {
    return el(
      'div',
      { class: 'plans-toolbar' },
      searchFieldEl(),
      window.QueuePlanFilter ? window.QueuePlanFilter.controls(filterHelp, d, { sort }) : null,
      // P6: "+ New plan" (plans/capture.js) is in this toolbar too, so `n` works on Plan entries as well.
      window.QueuePlanCapture?.button(captureHelp) ?? null,
      el('p', {
        class: 'plans-match',
        role: 'status',
        text: `${match.length} of ${d.entries.length} entries`,
      }),
    );
  }

  // ---- Middle: the chips and the foldable list ----
  function listEl(d, match, selected) {
    const t = s.state;
    const actively = V.chips(t.filter, d).length > 0 || !!t.search;
    const tree = V.tree(match, d);
    const header = activeFiltersEl(d);
    let content;
    if (!d.exists)
      content = el('p', {
        class: 'empty',
        text: 'The plan register does not exist yet (scripts/.queue/plans.json).',
      });
    else if (!match.length)
      content = el(
        'div',
        { class: 'empty empty-state' },
        el('p', {
          text: actively ? 'No entries match the filters and the search.' : 'No entries in the register.',
        }),
        actively
          ? el('button', {
              type: 'button',
              class: 'link-button',
              text: 'Reset the filters',
              onclick: () => newFilter(V.emptyFilter(), { search: '' }),
            })
          : null,
      );
    else
      content = el(
        'ul',
        { class: 'plans-tree', 'aria-label': 'The plans by area and project' },
        ...tree.map((m) => moduleEl(m, actively, selected, d)),
      );
    return el(
      'section',
      { class: 'plans-middle', 'aria-label': 'Plan list', 'data-scroll': 'list' },
      header,
      content,
    );
  }

  /** The active filters as chips above the list (and above the priority map), with Reset and Undo filter. */
  function activeFiltersEl(d) {
    const t = s.state;
    const chips = V.chips(t.filter, d);
    const actively = chips.length > 0 || !!t.search;
    return el(
      'div',
      { class: 'plans-chips', 'aria-label': 'Active filters' },
      ...chips.map((b) =>
        el(
          'span',
          { class: 'badge plans-chip' },
          b.text,
          el('button', {
            type: 'button',
            class: 'plans-chip-remove',
            text: '✕',
            'aria-label': `Remove the filter ${b.text}`,
            'data-focus': `chip:${b.facet}:${b.val}`,
            onclick: () => {
              const fresh = {
                ...t.filter,
                [b.facet]: t.filter[b.facet].filter((x) => x !== b.val),
              };
              newFilter(fresh);
            },
          }),
        ),
      ),
      t.search ? el('span', { class: 'badge plans-chip', text: `Search: ${t.search}` }) : null,
      actively
        ? el('button', {
            type: 'button',
            class: 'button-small button-outline',
            text: 'Reset',
            'data-focus': 'reset',
            onclick: () => newFilter(V.emptyFilter(), { search: '' }),
          })
        : null,
      s.undo.length
        ? el('button', {
            type: 'button',
            class: 'button-small button-outline',
            text: 'Undo filter',
            'data-focus': 'undo-filter',
            onclick: () => {
              const previous = V.readUrl(s.undo.pop());
              useState({ ...s.state, filter: previous.filter, search: previous.search });
            },
          })
        : null,
    );
  }

  /** Is the group open? With a filter or search everything with matches is open; otherwise what you opened, and the path to the selected entry. */
  function isOpen(key, actively, selected, check) {
    return actively || s.openOnes.has(key) || (selected && check(selected));
  }
  function toggleOpen(key) {
    if (s.openOnes.has(key)) s.openOnes.delete(key);
    else s.openOnes.add(key);
    save(OPEN_STORAGE, [...s.openOnes]);
    draw();
  }

  function progressEl(f, name) {
    const pst = Math.round(f.share * 100);
    return el(
      'span',
      { class: 'plans-progress' },
      el(
        'span',
        {
          class: 'plans-bar',
          role: 'img',
          'aria-label': `${name}: ${f.built} of ${f.n} built, ${pst} percent done`,
        },
        el('span', { class: 'plans-bar-fill', '--share': `${pst}%` }),
      ),
      el('span', {
        class: 'plans-progress-text',
        'aria-hidden': 'true',
        text: `${f.built}/${f.n}`,
      }),
    );
  }

  function groupRow(levelClass, key, open, title, count, f, copyText, fullTitle) {
    const id = `plans-g-${key.replace(/[^a-z0-9-]/gi, '_')}`;
    return el(
      'div',
      { class: `plans-row ${levelClass}` },
      el(
        'button',
        {
          type: 'button',
          class: 'plans-fold',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': id,
          'data-focus': `g:${key}`,
          title: fullTitle ?? null,
          onclick: () => toggleOpen(key),
        },
        el('span', { class: 'plans-fold-arrow fold-chevron', 'aria-hidden': 'true' }),
        el('span', { class: 'plans-group-title', text: title }),
        el('span', {
          class: 'plans-count',
          text: String(count),
          'aria-label': `${count} entries`,
        }),
      ),
      progressEl(f, title),
      copyText ? copyButton(copyText, `Copy the start line for ${title}`) : null,
    );
  }

  function moduleEl(m, actively, selected, d) {
    const key = `m:${m.oid}`;
    const open = isOpen(key, actively, selected, (p) => (p.module ?? V.WITHOUT_MODULE) === m.oid);
    const id = `plans-g-${key.replace(/[^a-z0-9-]/gi, '_')}`;
    const modCopy = m.oid === V.WITHOUT_MODULE ? null : V.copyLine('module', m.oid, [m.title]);
    return el(
      'li',
      { class: 'plans-module' },
      groupRow('plans-row-module', key, open, m.title, m.count, m.progress, modCopy),
      open
        ? el(
            'ul',
            { id, class: 'plans-projects' },
            ...m.projects.map((pr) => projectEl(m, pr, actively, selected, d)),
          )
        : null,
    );
  }

  function projectEl(m, pr, actively, selected, d) {
    const key = `p:${m.oid}/${pr.pid}`;
    const open = isOpen(
      key,
      actively,
      selected,
      (p) => (p.module ?? V.WITHOUT_MODULE) === m.oid && (p.project ?? V.WITHOUT_PROJECT) === pr.pid,
    );
    const id = `plans-g-${key.replace(/[^a-z0-9-]/gi, '_')}`;
    const modCopy =
      pr.pid === V.WITHOUT_PROJECT ? null : V.copyLine('project', pr.pid, [m.title, pr.title]);
    return el(
      'li',
      { class: 'plans-project' },
      groupRow(
        'plans-row-project',
        key,
        open,
        pr.title,
        pr.entries.length,
        pr.progress,
        modCopy,
        pr.fullTitle,
      ),
      open
        ? el('ul', { id, class: 'plans-entries' }, ...pr.entries.map((p) => entryEl(p, selected, d)))
        : null,
    );
  }

  /** The warning icons on the row: owner question, legal, stale and deadline. The symbol always carries a text as well. */
  function notices(p) {
    const out = [];
    const openSp = (p.ownerQuestions ?? []).filter((x) => !x.resolved).length;
    if (openSp) out.push({ k: 'owner', draw: '?', text: `${openSp} open owner questions` });
    if (p.legal_open) out.push({ k: 'jur', draw: '§', text: `${p.legal_open} open legal points` });
    if (p.stale) out.push({ k: 'stale', draw: '⟳', text: 'The verification is stale' });
    if (p.deadline) {
      const band = V.deadlineBand(p.deadline);
      out.push({
        k: `deadline deadline-${band}`,
        draw: '◷',
        text: `Deadline ${p.deadline}${band === 'overdue' ? ' (overdue)' : ''}`,
      });
    }
    if (p.active) out.push({ k: 'active', draw: '◉', text: 'Being worked on in Claude Code' });
    return out;
  }

  function priEl(p) {
    const v = V.PRIORITY[p.priority] ?? { text: p.priority ?? 'unknown', symbol: '·' };
    const cat =
      p.priority === 'now' && p.now_category?.length
        ? ` · ${p.now_category.map((k) => V.CATEGORY[k] ?? k).join(', ')}`
        : '';
    return el(
      'span',
      { class: `plans-pri pri-${p.priority}` },
      el('span', { class: 'plans-pri-symbol', 'aria-hidden': 'true', text: v.symbol }),
      el('span', { text: `${v.text}${cat}` }),
    );
  }

  function maturityText(p) {
    const t = V.MATURITY[p.maturity] ?? p.maturity ?? '';
    return p.maturity === 'partial' && p.fraction ? `${t} ${p.fraction}` : t;
  }

  function entryEl(p, selected, d) {
    const isSelected = selected?.id === p.id;
    const vars = notices(p);
    // multi select (x), "changed by session" and the pulse for "Working now" (work.js).
    const A = window.QueuePlanWork;
    const extra = A ? A.rowClasses(p) : '';
    // P5: a plan found in its plan document shows the matching sentence under the row (roadmap.js docHit).
    const hitId = `plans-entry-hit-${String(p.id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const hit = window.QueuePlanRoadmap?.docHit ? window.QueuePlanRoadmap.docHit(el, p, hitId) : null;
    return el(
      'li',
      {
        class: `plans-entry${isSelected ? ' selected' : ''}${hit ? ' has-doc-hit' : ''}${extra}`,
        'data-entry': p.id,
      },
      A ? A.markEl(workHelp, p) : null,
      el(
        'button',
        {
          type: 'button',
          class: 'plans-entry-button',
          'aria-current': isSelected ? 'true' : null,
          'aria-describedby': hit ? hitId : null,
          'data-focus': `entry:${p.id}`,
          onclick: () =>
            useState({ ...s.state, entry: p.id, tab: s.state.tab }, { push: true }),
        },
        priEl(p),
        el('span', { class: 'plans-entry-id', text: p.id }),
        el('span', { class: 'plans-entry-title', text: p.title }),
        el('span', { class: 'badge plans-maturity', text: maturityText(p) }),
        p.size
          ? el('span', {
              class: 'badge',
              text: p.size,
              title: `Size: ${V.SIZE[p.size] ?? p.size}`,
              'aria-label': `Size ${p.size}`,
            })
          : null,
        vars.length
          ? el(
              'span',
              { class: 'plans-warnings' },
              ...vars.map((x) =>
                el(
                  'span',
                  { class: `plans-warning v-${x.k}`, title: x.text },
                  el('span', { 'aria-hidden': 'true', text: x.draw }),
                  el('span', { class: 'hidden-for-eye', text: x.text }),
                ),
              ),
            )
          : null,
      ),
      // "changed by session" as text (not only color), and the row menu for priority and maturity.
      A ? A.changedBadge(p) : null,
      A ? A.rowMenuEl(workHelp, p, d) : null,
      copyButton(V.entryLine(p, d), `Copy the start line for ${p.id}`),
      hit,
    );
  }

  // ---- Right pane: the detail panel with tabs ----
  function detailEl(d, p) {
    if (!p)
      return el(
        'aside',
        { class: 'plans-detail empty-detail', 'aria-label': 'Detail panel' },
        el('p', {
          class: 'empty',
          text: s.state.entry
            ? `Did not find ${s.state.entry} in the register (merged or removed).`
            : 'Select an entry in the list to see the details.',
        }),
      );
    const t = s.state;
    const k = V.prepare(p, d);
    const tabIdx = Math.max(
      0,
      V.TABS.findIndex((f) => f.id === t.tab),
    );
    const counters = {
      doc: p.sources.length,
      queue: p.queue.length,
      legal: p.legal_open,
      decisions: p.ownerQuestions.filter((x) => !x.resolved).length,
      history: p.history.length,
    };
    const tabList = el(
      'div',
      {
        class: 'plans-tabs',
        role: 'tablist',
        'aria-label': 'Details about the entry',
        onkeydown: (e) => {
          const buttons = [...e.currentTarget.querySelectorAll('[role="tab"]')];
          const i = buttons.indexOf(document.activeElement);
          if (i < 0) return;
          const j = window.QueueA11y.tabMeasure(buttons.length, i, e.key);
          if (j == null) return;
          e.preventDefault();
          buttons[i].tabIndex = -1;
          buttons[j].tabIndex = 0;
          buttons[j].focus();
        },
      },
      ...V.TABS.map((f, i) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            id: `plans-tab-${f.id}`,
            class: 'plans-tab',
            'aria-selected': i === tabIdx ? 'true' : 'false',
            'aria-controls': 'plans-tab-content',
            tabindex: i === tabIdx ? '0' : '-1',
            'data-focus': `tab:${f.id}`,
            onclick: () => useState({ ...s.state, tab: f.id }, { push: false }),
          },
          f.text,
          counters[f.id]
            ? el('span', { class: 'plans-count', text: String(counters[f.id]) })
            : null,
        ),
      ),
    );
    return el(
      'aside',
      { class: 'plans-detail', 'aria-label': `Details for ${p.id}`, 'data-scroll': 'detail' },
      el('button', {
        type: 'button',
        class: 'button-small button-outline plans-back',
        text: 'Back to the list',
        onclick: () => useState({ ...s.state, entry: null }),
      }),
      el(
        'header',
        { class: 'plans-detail-header' },
        el('p', { class: 'plans-detail-id', text: p.id }),
        el('h2', { class: 'plans-detail-title', text: p.title }),
        el(
          'p',
          { class: 'plans-detail-badges' },
          priEl(p),
          el('span', { class: 'badge plans-maturity', text: maturityText(p) }),
          p.size ? el('span', { class: 'badge', text: `Size ${p.size}` }) : null,
          p.active
            ? el('span', {
                class: 'badge plans-active',
                text: 'Being worked on in Claude Code',
                title: `Pulse ${date(p.active.at)} (${p.active.by})`,
              })
            : null,
        ),
        el(
          'div',
          { class: 'plans-actions' },
          el('button', {
            type: 'button',
            class: 'button button-filled',
            text: 'Copy start line',
            title: V.entryLine(p, d),
            'data-focus': 'copy-start',
            onclick: () => copy(V.entryLine(p, d)),
          }),
          el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Prepare for queue',
            title: k.line,
            'data-focus': 'prepare',
            onclick: () => copy(k.line),
          }),
          // the reading view of the same plan (the Roadmap's plan page).
          window.QueuePlanRoadmap
            ? el('button', {
                type: 'button',
                class: 'button button-outline',
                text: 'Open the plan page',
                'data-focus': 'plan-page',
                onclick: () => useState({ ...s.state, surface: 'roadmap', entry: p.id }, { focus: 'page-title' }),
              })
            : null,
        ),
        k.warnings.length
          ? el(
              'div',
              { class: 'plans-control' },
              el('p', { class: 'plans-control-title', text: 'Check before packing' }),
              el('ul', {}, ...k.warnings.map((a) => el('li', { text: a }))),
            )
          : null,
      ),
      tabList,
      el(
        'section',
        {
          id: 'plans-tab-content',
          class: 'plans-tab-content',
          role: 'tabpanel',
          'aria-labelledby': `plans-tab-${V.TABS[tabIdx].id}`,
        },
        tabContent(V.TABS[tabIdx].id, p, d),
      ),
    );
  }

  function field(name, ...val) {
    const v = val.flat().filter((x) => x != null && x !== '' && x !== false);
    if (!v.length) return null;
    return [el('dt', { text: name }), el('dd', {}, ...v)];
  }

  function entryLink(id) {
    const q = entryFor(id);
    return el('button', {
      type: 'button',
      class: 'link-button',
      text: q ? `${id} ${q.title}` : id,
      onclick: () => useState({ ...s.state, entry: id }, { scroll: true }),
    });
  }

  function list(elements, emptyText) {
    return elements.length
      ? el('ul', { class: 'plans-detail-list' }, ...elements)
      : el('p', { class: 'empty', text: emptyText });
  }

  // withSummary false: the plan page shows the summary at the top already, so its Details leaves it out.
  function tabContent(tab, p, d, { withSummary = true } = {}) {
    const over = [
      ...V.breadcrumbs({ entry: p.id, filter: V.emptyFilter() }, d)
        .slice(1, 3)
        .map((l) => l.text),
      p.id,
    ];
    if (tab === 'summary') {
      const v = V.PRIORITY[p.priority];
      return el(
        'div',
        {},
        withSummary && p.summary ? el('p', { class: 'plans-summary', text: p.summary }) : null,
        el(
          'dl',
          { class: 'plans-field' },
          field(
            'Priority in the plan register',
            `${v ? `${v.symbol} ${v.text}` : p.priority}${
              p.now_category.length
                ? ` (${p.now_category.map((x) => V.CATEGORY[x] ?? x).join(', ')})`
                : ''
            }, set by ${p.priority_set_by === 'owner' ? 'the owner' : 'agent'}`,
          ),
          field('Reason', p.priority_reason),
          field(
            'Maturity',
            `${maturityText(p)}${
              p.maturity_plan && p.maturity_plan !== p.maturity
                ? ` (from the plan work: ${V.MATURITY[p.maturity_plan] ?? p.maturity_plan})`
                : ''
            }`,
          ),
          field('Size', p.size ? `${p.size}: ${V.SIZE[p.size] ?? ''}` : null),
          field('Deadline', p.deadline),
          field(
            'Depends on',
            p.depends_on.length
              ? list(
                  p.depends_on.map((id) => el('li', {}, entryLink(id))),
                  '',
                )
              : null,
          ),
          field(
            'Blocks',
            p.blocks.length
              ? list(
                  p.blocks.map((id) => el('li', {}, entryLink(id))),
                  '',
                )
              : null,
          ),
          field(
            'Verified',
            p.verified
              ? `${p.verified.date ?? ''} by ${p.verified.by ?? 'unknown'}${p.verified.findings ? `: ${p.verified.findings}` : ''}${
                  p.stale ? ' (stale)' : ''
                }`
              : 'Not verified against the code yet',
          ),
          field('Reason for drop', p.drop_reason),
          field('Merged from', p.merged_from.join(', ')),
          field('Roadmap', p.roadmap.join(', ')),
          field('Remark', p.remark),
        ),
      );
    }
    // the sources with the reader (plans/read.js).
    if (tab === 'doc' && window.QueuePlanRead) return window.QueuePlanRead.sourceTab(readHelp, p);
    if (tab === 'doc')
      return el(
        'div',
        {},
        el('p', {
          class: 'plans-help',
          text: 'The sources the entry points to (the reader is not loaded).',
        }),
        list(
          p.sources.map((k) =>
            el(
              'li',
              { class: 'plans-source' },
              el('code', { text: k.path }),
              k.anchor ? el('span', { class: 'badge', text: k.anchor }) : null,
              k.role ? el('span', { class: 'badge', text: k.role }) : null,
              copyButton(k.path, `Copy path ${k.path}`),
            ),
          ),
          'The entry has no sources.',
        ),
      );
    if (tab === 'queue') {
      const v = V.PRIORITY[p.priority];
      return el(
        'div',
        {},
        el('p', {
          class: 'plans-help',
          text:
            `Priority in the plan register: ${v?.text ?? p.priority}. The focus step is the queue's own order and is set ` +
            'per task. Click a task to see its card in Queue.',
        }),
        list(
          p.queue.map((o) =>
            el(
              'li',
              { class: 'plans-queue-task' },
              el('button', {
                type: 'button',
                class: 'link-button',
                text: `${o.id} ${o.title ?? ''}`.trim(),
                'aria-label': `Show ${o.id} in Queue`,
                onclick: () => showInQueue(o.id),
              }),
              el('span', {
                class: `badge plans-queue-status queue-${o.column ?? 'none'}`,
                text: V.queueStatusText(o),
              }),
            ),
          ),
          'No queue tasks yet. "Prepare for queue" copies the line for /add-to-queue.',
        ),
      );
    }
    if (tab === 'legal') {
      const j = p.legal;
      if (!j) return el('p', { class: 'empty', text: 'No legal points on the entry.' });
      const pv = j.privacy ?? null;
      return el(
        'div',
        {},
        el(
          'dl',
          { class: 'plans-field' },
          field('Affects', (j.affects ?? []).join('; ')),
          field(
            'Privacy',
            pv
              ? [
                  pv.art9 ? 'art. 9 data' : null,
                  pv.dpia ? `DPIA: ${pv.dpia}` : null,
                  pv.dpa_change ? 'DPA must change' : null,
                ]
                  .filter(Boolean)
                  .join(', ')
              : null,
          ),
        ),
        list(
          (j.points ?? []).map((x) =>
            el(
              'li',
              { class: 'plans-point' },
              el('p', {}, el('strong', { text: x.id ?? '' }), ` ${x.question ?? ''}`),
              el(
                'p',
                { class: 'plans-point-meta' },
                el('span', { class: 'badge', text: `Status: ${x.status ?? 'unknown'}` }),
                x.blocks
                  ? el('span', { class: 'badge', text: `Blocks: ${x.blocks}` })
                  : null,
                x.deadline ? el('span', { class: 'badge', text: `Deadline ${x.deadline}` }) : null,
                x.id
                  ? copyButton(V.copyLine('jur', x.id, over), `Copy the start line for ${x.id}`)
                  : null,
              ),
              x.ai_assessment
                ? el('p', { class: 'plans-help', text: `AI assessment: ${x.ai_assessment}` })
                : null,
            ),
          ),
          'No points.',
        ),
      );
    }
    if (tab === 'decisions') {
      const sorted = [...p.ownerQuestions].sort((a, b) => Number(a.resolved) - Number(b.resolved));
      return list(
        sorted.map((x) =>
          el(
            'li',
            { class: `plans-point${x.resolved ? ' resolved' : ''}` },
            el(
              'p',
              {},
              el('strong', { text: x.id }),
              ` ${x.text ?? '(the question does not exist in the queue)'}`,
            ),
            el(
              'p',
              { class: 'plans-point-meta' },
              el('span', { class: 'badge', text: x.resolved ? 'Answered' : 'Open' }),
              copyButton(V.copyLine('owner', x.id, over), `Copy the start line for ${x.id}`),
            ),
            x.answer ? el('p', { class: 'plans-help', text: `Answer: ${x.answer}` }) : null,
          ),
        ),
        'No owner questions on the entry.',
      );
    }
    return list(
      p.history.map((h) =>
        el(
          'li',
          { class: 'plans-history' },
          el('span', { class: 'badge', text: `nr. ${h.nr}` }),
          ` ${date(h.at)} · ${h.action ?? ''} · ${h.by ?? ''} · `,
          el('span', { text: h.field.includes('*') ? 'whole entry' : h.field.join(', ') }),
        ),
      ),
      'No changes in the changelog (it keeps the last 50).',
    );
  }

  // ---- The link to the queue ----
  function showInQueue(id) {
    useState({ ...s.state, room: 'queue' });
    window.QueueBoard?.showTask?.(id);
  }

  window.QueuePlans = {
    /** Leave Plans for the queue room (the Decisions tab, board/decide.js). */
    showQueue() {
      if (isPlans()) useState({ ...s.state, room: 'queue' });
    },
    /** Marker on a queue card: switch to Plans with the entry open (the filters reset, so the entry is always in the list). */
    openEntry(id) {
      if (!featureOn('plans')) return; // the Plans module is off (features.plans)
      // The plan page on the Roadmap (the plan first, the facts under Details); without roadmap.js the entry list.
      if (window.QueuePlanRoadmap) {
        useState({ ...V.readUrl('?room=plans&surface=roadmap'), entry: id }, { focus: 'page-title' });
        return;
      }
      useState({ ...V.readUrl('?room=plans'), entry: id, tab: 'summary' }, { scroll: true });
      room.querySelector('.plans-entry.selected .plans-entry-button')?.focus();
    },
    /** The title of a plan entry (for the marker on the queue card), or null before the register is fetched. */
    title(id) {
      return entryFor(id)?.title ?? null;
    },
    /** The module switches came with a new state (board.js): leave Plans when it is off, otherwise redraw the surfaces. */
    featuresChanged() {
      if (!isPlans()) return;
      if (!featureOn('plans')) useState({ ...s.state, room: 'queue' }, { push: false });
      else if (s.data) draw();
    },
  };

  // ---- Start ----
  showRoom();
  get();
  // the keyboard and Ctrl+K (work.js), and live update: a call that waits until the register changes, so
  // changes from a Claude Code session show without a reload. If it fails, it is retried shortly; the interval
  // below is the fallback.
  window.QueuePlanWork?.install(workHelp);
  window.QueuePlanFilter?.install(filterHelp);
  async function listen() {
    if (isPlans() && !document.hidden && s.version && !s.listener) {
      await get(false, { wait: true });
      setTimeout(listen, s.error ? 10_000 : 50);
      return;
    }
    setTimeout(listen, 1_000);
  }
  listen();
  setInterval(() => {
    if (!document.hidden && isPlans()) get();
  }, 15_000);
  window.addEventListener('focus', () => {
    if (isPlans()) get();
  });
})();
