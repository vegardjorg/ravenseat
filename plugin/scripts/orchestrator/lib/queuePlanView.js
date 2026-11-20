// =============================================================
// queuePlanView.js: the pure rules for the Plans room on the queue board (see docs/board.md and docs/plan-register.md).
//
// The file is both a CommonJS module (queue-board.mjs and the tests, lib/__tests__/queuePlanView.test.ts) and a script in
// the browser (queue-board.mjs serves it as /queuePlanView.js, and it sets window.QueuePlanView), so the board uses
// exactly the code the tests check. No DOM, no file or network access.
//
//   - plansData: what /api/plans sends (the server calls it with plans.json and queue.json). Builds on the pure
//     functions in queuePlan.js (derived maturity, sorting, blocks, active sessions); only that part requires queuePlan.js,
//     and it never runs in the browser.
//   - The state in the url (room, filters, search, selected entry and tab), so the back button and bookmarks work.
//   - The facets (module, priority, Now category, maturity, waiting on, deadline) with match counts per value.
//   - The tree module › project › entry with rolled-up progress, and "Without project" so nothing disappears.
//   - The breadcrumb and the copy lines (only id and titles, never content from documents).
//   - The link to the queue: the status text for a queue task with the focus step, and "Prepare for queue".
//   - The ready-made views (Before prod, Security, Waiting on me, Stale, Dropped by agent).
//   - The surface "Documents and agreements" in the same room, with the same three-cell pattern: the facets
//     group, status, audience, priority and problems (with counts), a table per group, "What must be done",
//     the timeline of revisions per month and the path Plans › Documents and agreements › Group › DOC-id.
//   - Priority map (module × Now security, before prod, important, Owner, Later, Drop) with draft
//     and the calls to `queue.mjs plan prioritize`, and the deadline band for the next 90 days.
//   - Tree map module › project › entry (area = size, color = priority, fill = built; the zoom
//     is the filter) with the squarified layout, and the dependency graph for the selection or selected entry with its neighbors, with
//     blocked entries and the critical path (queueGraph.criticalPath; the layout is queueGraph.layer).
//   - The allowlist for the read view (readPathError, the folders from queue.config.json `documentFolders`; the server adds the symlink and realpath guard on top in
//     queueBoard.readDocument), markdown split into blocks and pieces drawn with textContent (markdownBlocks,
//     inlineParts, linkMeasure, anchorIndex), and the Unregistered box (groups, proposed, "New entry" and "Add as
//     source" with the arguments to `queue.mjs plan new` and `plan edit --set {sources}`).
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueuePlanView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- The room's children (PLAN-3a-QA1) ---------------------------------------------------------------------------

  /**
   * The children that really go into the room: optional parts (the deadline band, the Unregistered box, the action line
   * ...) are null or false when they do not apply to the surface. Element.append(null) inserts the text "null", so they
   * are removed first.
   * @param {unknown[]} children
   * @returns {unknown[]}
   */
  function roomChildren(children) {
    return (children ?? []).filter((c) => c != null && c !== false);
  }

  // ---- The values and how they are shown ---------------------------------------------------------------------------

  /** The priorities in display order (like queuePlan.PRIORITIES). The symbol always sits together with the text. */
  const PRIORITY = {
    now: { text: 'Now', symbol: '●' },
    owner: { text: 'Owner', symbol: '◆' },
    later: { text: 'Later', symbol: '○' },
    drop: { text: 'Drop', symbol: '✕' },
  };
  const PRIORITIES = Object.keys(PRIORITY);
  const CATEGORY = { security: 'security', 'for-prod': 'before prod', important: 'important' };
  const MATURITY = {
    idea: 'Idea',
    investigated: 'Investigated',
    planned: 'Planned',
    ready: 'Ready',
    'in-queue': 'In queue',
    partial: 'Partially built',
    built: 'Built',
    verified: 'Verified',
  };
  const SIZE = {
    S: 'under half a day',
    M: '1 to 3 tracks',
    L: '4 to 10 tracks',
    XL: 'a whole area',
  };
  const WAITING = { owner: 'The owner', lawyer: 'Legal resolution', none: 'Nothing' };
  /** The deadline bands (days from today). */
  const DEADLINE = {
    overdue: 'Overdue',
    30: 'Within 30 days',
    90: 'Within 90 days',
    later: 'Later',
    none: 'No deadline',
  };
  /** Set by (for "Dropped by Claude"). */
  const SET_BY = { agent: 'Agent', owner: 'The owner' };
  /**
   * The roadmap horizons as filter values (P4). HORIZONS further down is built from this, so the Filter menu and the
   * Roadmap's sections always use the same words. Defined here because FACETS below needs it when the file loads.
   */
  const HORIZON_TEXT = {
    inbox: 'Inbox',
    waiting: 'Waiting on you',
    now: 'Now',
    next: 'Next',
    later: 'Later',
    done: 'Done',
    dropped: 'Dropped',
  };
  /** Has tasks (P4): does the plan have queue tasks that are not cancelled? */
  const HAS_TASKS = { yes: 'Yes', no: 'No' };
  /** Legal points with these statuses are open. */
  const LEGAL_OPEN = new Set(['open', 'ai-assessed', 'to-lawyer']);
  /** The tabs in the detail panel. */
  const TABS = [
    { id: 'summary', text: 'Summary' },
    { id: 'doc', text: 'Documents' },
    { id: 'queue', text: 'Queue' },
    { id: 'legal', text: 'Legal' },
    { id: 'decisions', text: 'Decisions' },
    { id: 'history', text: 'History' },
  ];
  const WITHOUT_PROJECT = '(without-project)';
  const WITHOUT_MODULE = '(without-module)';
  const ENTRY_ID = /^PL-[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5-]{1,60}$/;
  const KEY = /^[a-z0-9][a-z0-9-]{0,60}$/;

  // ---- the surfaces in the room and the values for documents -------------------------------------------
  // The values are the same as in queuePlan.js (DOC_GROUPS, DOC_STATUSES, …); queuePlanView.test.ts checks that they match.

  /** The surfaces in the Plans room: the plan entries and the document register (same pattern, own filters). */
  const SURFACES = [
    // The Roadmap (`surface=roadmap`, P1 of plans/plans-tab-ux-review-2026-11-19.md) is the start page when you enter
    // Plans (plans.startView). The overview is still a surface, but no tab: it sits under More views (`more`) with the
    // maps. A web address without surface is still Plan entries, so old links and saved views work as before.
    { id: 'roadmap', text: 'Roadmap' },
    { id: 'overview', text: 'Overview', more: true },
    { id: 'entries', text: 'Plan entries' },
    { id: 'doc', text: 'Documents and agreements' },
    // legal panel, owner decisions and the launch overview.
    { id: 'jur', text: 'Legal' },
    { id: 'decision', text: 'Decisions' },
    { id: 'launch', text: 'Launch' },
  ];
  const DOC_GROUP = {
    customerAgreements: 'Customer agreements',
    privacy: 'Privacy',
    public: 'Public on the website',
    governance: 'Governance documents',
    vendors: 'Purchasing and vendors',
    contract: 'Contract work',
  };
  /** Status with symbol: color is never the only carrier. */
  const DOC_STATUS = {
    missing: { text: 'Missing', symbol: '✕' },
    draft: { text: 'Draft', symbol: '✎' },
    'ai-assessed': { text: 'AI-assessed', symbol: '◐' },
    'to-lawyer': { text: 'To lawyer', symbol: '§' },
    approved: { text: 'Approved', symbol: '✓' },
    published: { text: 'Published', symbol: '●' },
    outdated: { text: 'Outdated', symbol: '⚠' },
  };
  const DOC_AUDIENCE = {
    customer: 'Customer',
    public: 'Public',
    internal: 'Internal',
    vendor: 'Vendor',
  };
  const DOC_PRI = { ...PRIORITY, none: { text: 'No priority', symbol: '·' } };
  /** The notices a row can have (the facet "Problems and revision"). */
  const DOC_WARNING = {
    'problem-high': 'Problem with high severity',
    problem: 'Has problems',
    miss: 'Version skew',
    overdue: 'Revision overdue',
    soon: 'Revision within 30 days',
    none: 'No notices',
  };
  const DOC_SEVERITY = { high: 'High', medium: 'Medium', low: 'Low' };
  const DOC_PUBLISHED = {
    webPage: 'Web page',
    admin: 'Admin',
    app: 'App',
    signed: 'Signed',
    other: 'Other',
  };
  const DOC_ID = /^DOC-[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5-]{1,60}$/;

  // ---- The state in the url -----------------------------------------------------------------------------------

  /**
   * The facets in the left cell, in order. `param` is the name in the url, `values` the valid values (null =
   * from the data: module and project), `by(entry, now)` the values an entry has (an entry can have several, e.g. categories).
   * Within a facet the choices are "or"; between the facets "and".
   * P4: they are the sections of the Filter menu (the left column is gone), in the order the plan names: Horizon, Area,
   * Project, Priority, Maturity, Waiting on, Deadline, Has tasks, Set by, Verification (Now category stays after
   * Priority). The url parameter of each is unchanged, so old links and saved views keep working.
   */
  const FACETS = [
    {
      id: 'horizon',
      title: 'Horizon',
      param: 'hz',
      values: HORIZON_TEXT,
      by: (p) => [horizonFor(p)],
    },
    {
      id: 'module',
      title: 'Area',
      param: 'module',
      values: null,
      by: (p) => [p.module ?? WITHOUT_MODULE],
    },
    {
      id: 'project',
      title: 'Project',
      param: 'project',
      values: null,
      by: (p) => [p.project ?? WITHOUT_PROJECT],
    },
    { id: 'pri', title: 'Priority', param: 'pri', values: PRIORITY, by: (p) => [p.priority] },
    {
      id: 'cat',
      title: 'Now category',
      param: 'cat',
      values: CATEGORY,
      by: (p) => (p.priority === 'now' ? (p.now_category ?? []) : []),
    },
    { id: 'mod', title: 'Maturity', param: 'mod', values: MATURITY, by: (p) => [p.maturity] },
    {
      id: 'waiting',
      title: 'Waiting on',
      param: 'waiting',
      values: WAITING,
      by: (p) => waitingOn(p),
    },
    {
      id: 'deadline',
      title: 'Deadline',
      param: 'deadline',
      values: DEADLINE,
      by: (p, now) => [deadlineBand(p.deadline, now)],
    },
    {
      id: 'tasks',
      title: 'Has tasks',
      param: 'tasks',
      values: HAS_TASKS,
      by: (p) => [(p.queue ?? []).some((o) => o?.status !== 'cancelled') ? 'yes' : 'no'],
    },
    {
      id: 'set',
      title: 'Priority set by',
      param: 'set',
      values: SET_BY,
      by: (p) => [p.priority_set_by ?? 'agent'],
    },
    {
      id: 'stale',
      title: 'Verification',
      param: 'stale',
      values: { yes: 'Stale', no: 'Not stale' },
      by: (p) => [p.stale ? 'yes' : 'no'],
    },
  ];

  /** The facets for documents (group, status, audience and "has problems", plus priority). */
  const DOC_FACETS = [
    { id: 'group', title: 'Group', param: 'dgr', values: DOC_GROUP, by: (d) => [d.group] },
    { id: 'status', title: 'Status', param: 'dst', values: DOC_STATUS, by: (d) => [d.status] },
    {
      id: 'audience',
      title: 'Audience',
      param: 'dmg',
      values: DOC_AUDIENCE,
      by: (d) => [d.audience],
    },
    {
      id: 'pri',
      title: 'Priority',
      param: 'dpri',
      values: DOC_PRI,
      by: (d) => [d.priority ?? 'none'],
    },
    {
      id: 'notice',
      title: 'Problems and revision',
      param: 'dvars',
      values: DOC_WARNING,
      by: (d) => (Array.isArray(d.notice) && d.notice.length ? d.notice : ['none']),
    },
  ];

  /** Empty document filters: one list per facet. */
  function emptyDocFilter() {
    const f = {};
    for (const x of DOC_FACETS) f[x.id] = [];
    return f;
  }

  /** Empty filters: one list per facet. */
  function emptyFilter() {
    const f = {};
    for (const x of FACETS) f[x.id] = [];
    return f;
  }

  /** Is the value valid in the facet? Module and project: a safe name (if it is not in the data, it just gives zero matches). */
  function validValue(facet, v) {
    if (typeof v !== 'string' || !v || v.length > 60) return false;
    if (facet.values) return Object.hasOwn(facet.values, v);
    return KEY.test(v) || v === WITHOUT_MODULE || v === WITHOUT_PROJECT;
  }

  /**
   * Reads the state from the search part of the url (`?room=plans&pri=now&cat=for-prod&entry=PL-X&tab=queue`). Invalid
   * values are dropped silently, so an old or handwritten link never breaks the board.
   * @param {string} search location.search (with or without "?")
   * @returns {{ room: 'plans'|'queue', filter: Record<string,string[]>, search: string, entry: string|null, tab: string }}
   */
  function readUrl(search) {
    const q = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
    const filter = emptyFilter();
    for (const f of FACETS) {
      const out = [];
      for (const chunk of (q.get(f.param) ?? '').split(',')) {
        const v = chunk.trim();
        if (validValue(f, v) && !out.includes(v)) out.push(v);
      }
      filter[f.id] = out.slice(0, 40);
    }
    const entry = q.get('entry');
    const tab = q.get('tab');
    // the surface (plan entries or documents) and the documents' own filters, search and selection.
    const dfilter = emptyDocFilter();
    for (const f of DOC_FACETS) {
      const out = [];
      for (const chunk of (q.get(f.param) ?? '').split(',')) {
        const v = chunk.trim();
        if (Object.hasOwn(f.values, v) && !out.includes(v)) out.push(v);
      }
      dfilter[f.id] = out;
    }
    const doc = q.get('doc');
    const surface = q.get('surface');
    return {
      room: q.get('room') === 'plans' ? 'plans' : 'queue',
      surface: SURFACES.some((x) => x.id === surface) ? surface : 'entries',
      // the filters, the search and the selection on the Legal and Decisions surfaces.
      ...jbReadUrl(q),
      filter,
      search: String(q.get('q') ?? '').slice(0, 120),
      entry: entry && ENTRY_ID.test(entry) ? entry : null,
      tab: TABS.some((x) => x.id === tab) ? tab : 'summary',
      dfilter,
      dsearch: String(q.get('dq') ?? '').slice(0, 120),
      doc: doc && DOC_ID.test(doc) ? doc : null,
      // the view of the plan entries (the list, priority map, tree map or
      // dependencies), and which dependencies are shown (whole selection or selected entry with its neighbors).
      show: VIEWS.includes(q.get('show')) ? q.get('show') : 'list',
      dep: q.get('dep') === 'entry' ? 'entry' : 'selection',
    };
  }

  /**
   * The search part for a state (stable order, empty values excluded). The Queue room is the default and is not written, so
   * the url for the queue is as before. Other parameters in `extra` (from the queue) are not kept: the room owns the search part.
   */
  function writeUrl(state) {
    const q = new URLSearchParams();
    if (state.room === 'plans') q.set('room', 'plans');
    for (const f of FACETS) {
      const v = state.filter?.[f.id] ?? [];
      if (v.length) q.set(f.param, v.join(','));
    }
    if (state.search) q.set('q', state.search);
    if (state.entry) q.set('entry', state.entry);
    if (state.entry && state.tab && state.tab !== 'summary')
      q.set('tab', state.tab);
    // the document surface. The filters are kept when you switch surface, so you come back where you were.
    if (
      state.surface &&
      state.surface !== 'entries' &&
      SURFACES.some((x) => x.id === state.surface)
    )
      q.set('surface', state.surface);
    jbWriteUrl(q, state);
    for (const f of DOC_FACETS) {
      const v = state.dfilter?.[f.id] ?? [];
      if (v.length) q.set(f.param, v.join(','));
    }
    if (state.dsearch) q.set('dq', state.dsearch);
    if (state.doc) q.set('doc', state.doc);
    if (VIEWS.includes(state.show) && state.show !== 'list') q.set('show', state.show);
    if (state.show === 'dep' && state.dep === 'entry') q.set('dep', 'entry');
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  /** Count of active filter choices (the search not included). */
  function countFilters(filter) {
    return FACETS.reduce((n, f) => n + (filter?.[f.id]?.length ?? 0), 0);
  }

  // ---- Derived properties of an entry ------------------------------------------------------------------------------

  /** Date (YYYY-MM-DD) in local time (the browser's time zone) for a point in time. */
  function osloDate(now) {
    return new Intl.DateTimeFormat('sv-SE').format(new Date(now));
  }

  /** Whole days from `from` to `to` (both YYYY-MM-DD). */
  function days(from, to) {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  }

  /** The deadline band for a deadline: overdue, 30, 90, later or none. */
  function deadlineBand(deadline, now = new Date()) {
    if (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return 'none';
    const d = days(osloDate(now), deadline);
    if (d < 0) return 'overdue';
    if (d <= 30) return '30';
    if (d <= 90) return '90';
    return 'later';
  }

  /** Open legal points (status open, ai-assessed or to-lawyer). */
  function legalOpen(entry) {
    const pk = entry?.legal?.points;
    return Array.isArray(pk) ? pk.filter((x) => x && LEGAL_OPEN.has(x.status)) : [];
  }

  /** What the entry is waiting on: owner (priority owner or an unresolved owner question), lawyer, otherwise none. */
  function waitingOn(entry) {
    const out = [];
    const ownerQuestions = Array.isArray(entry?.ownerQuestions) ? entry.ownerQuestions : [];
    if (entry?.priority === 'owner' || ownerQuestions.some((s) => s && !s.resolved)) out.push('owner');
    if ((entry?.legal_open ?? legalOpen(entry).length) > 0) out.push('lawyer');
    return out.length ? out : ['none'];
  }

  // ---- Filtering and facet counts -----------------------------------------------------------------------------------

  /** Does the search match the entry? Case-insensitive, in id, title, summary, project, roadmap and sources. */
  function searchMatch(entry, search) {
    const s = String(search ?? '')
      .trim()
      .toLowerCase();
    if (!s) return true;
    return [
      entry.id,
      entry.title,
      entry.summary,
      // the lead the server took from the plan document (P3), so a plan without a summary is found by its words too.
      entry.lead?.text,
      entry.project,
      entry.remark,
      ...(entry.roadmap ?? []),
      ...(entry.sources ?? []).map((k) => k?.path),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
      .includes(s);
  }

  /** Does the entry fit the facet (no choice = all fit)? */
  function matchesFacet(entry, facet, selected, now) {
    if (!selected?.length) return true;
    const includesOr = facet.by(entry, now);
    return includesOr.some((v) => selected.includes(v));
  }

  /**
   * Entries that fit the filters and the search. Dropped entries are hidden by default and shown when the priority
   * filter includes Drop. `except` is a facet that is not counted (used for the facet counts).
   */
  function applyFilter(entries, filter = {}, search = '', { now = new Date(), except = null } = {}) {
    const pri = filter.pri ?? [];
    // The Horizon section's Dropped shows them too (P4), and its counts include them, so Dropped can be chosen.
    const dropAsked = pri.includes('drop') || (filter.horizon ?? []).includes('dropped');
    return (entries ?? []).filter((p) => {
      if (p.priority === 'drop' && !dropAsked && except !== 'pri' && except !== 'horizon') return false;
      for (const f of FACETS) {
        if (f.id === except) continue;
        if (!matchesFacet(p, f, filter[f.id], now)) return false;
      }
      return searchMatch(p, search);
    });
  }

  /**
   * The facets with match counts per value. The count for a value is computed with all the other filters on (and without
   * the choices in its own facet), so the number says how many matches you get by checking it. Values without matches are hidden, but a
   * selected filter always stays, so it can be removed.
   * @returns {{ id, title, option: { val, text, count, selected }[] }[]}
   */
  function facetNumber(
    entries,
    filter,
    search,
    { now = new Date(), modules = [], projects = {} } = {},
  ) {
    return FACETS.map((f) => {
      const basis = applyFilter(entries, filter, search, { now, except: f.id });
      const counts = new Map();
      for (const p of basis)
        for (const v of new Set(f.by(p, now))) counts.set(v, (counts.get(v) ?? 0) + 1);
      let name;
      if (f.id === 'module') {
        name = new Map(modules.map((m) => [m.oid, m.title]));
        name.set(WITHOUT_MODULE, 'Without area');
      } else if (f.id === 'project') {
        name = new Map(Object.entries(projects).map(([pid, x]) => [pid, x?.summary ?? pid]));
        name.set(WITHOUT_PROJECT, 'Without project');
      } else name = new Map(Object.entries(f.values).map(([v, x]) => [v, valueText(x)]));
      const selected = filter?.[f.id] ?? [];
      const order = [...new Set([...name.keys(), ...counts.keys(), ...selected])];
      const option = order
        .filter((v) => (counts.get(v) ?? 0) > 0 || selected.includes(v))
        .map((v) => ({
          val: v,
          text: name.get(v) ?? v,
          count: counts.get(v) ?? 0,
          selected: selected.includes(v),
        }));
      return { id: f.id, title: f.title, option };
    });
  }

  /** The text for a value in a facet (the priorities are objects with text and symbol). */
  function valueText(x) {
    return x && typeof x === 'object' ? x.text : String(x);
  }

  /** The chips above the list: one per active filter choice, with the text that is shown. */
  function chips(filter, { modules = [], projects = {} } = {}) {
    const out = [];
    const modName = new Map(modules.map((m) => [m.oid, m.title]));
    for (const f of FACETS)
      for (const v of filter?.[f.id] ?? []) {
        let text = f.values?.[v] != null ? valueText(f.values[v]) : null;
        if (f.id === 'module') text = v === WITHOUT_MODULE ? 'Without area' : (modName.get(v) ?? v);
        if (f.id === 'project')
          text = v === WITHOUT_PROJECT ? 'Without project' : (projects[v]?.summary ?? v);
        out.push({ facet: f.id, val: v, text: `${f.title}: ${text ?? v}` });
      }
    return out;
  }

  // ---- The tree: module › project › entry ------------------------------------------------------------------------------

  /** The built share for entries: built and verified count 1, partial counts finished/total, the rest 0. */
  function progress(entries) {
    let sum = 0;
    let built = 0;
    for (const p of entries) {
      if (p.maturity === 'built' || p.maturity === 'verified') {
        sum += 1;
        built += 1;
      } else if (p.maturity === 'partial' && p.total > 0) sum += p.finished / p.total;
    }
    const n = entries.length;
    return { built, n, share: n ? sum / n : 0 };
  }

  /**
   * The tree for the list: modules in the register's order (only those with matches), projects in every module (alphabetical by
   * title, "Without project" last) and entries in the order they came (the server has sorted them by the priority rules).
   * Each level has the combined progress of its entries.
   */
  function tree(entries, { modules = [], projects = {} } = {}) {
    const perModule = new Map();
    for (const p of entries) {
      const m = p.module ?? WITHOUT_MODULE;
      const pid = p.project && projects[p.project] ? p.project : WITHOUT_PROJECT;
      if (!perModule.has(m)) perModule.set(m, new Map());
      const pm = perModule.get(m);
      if (!pm.has(pid)) pm.set(pid, []);
      pm.get(pid).push(p);
    }
    const orderState = [
      ...modules.map((m) => m.oid),
      ...[...perModule.keys()].filter((m) => !modules.some((x) => x.oid === m)),
    ];
    const titleFor = new Map(modules.map((m) => [m.oid, m.title]));
    const out = [];
    for (const oid of orderState) {
      const pm = perModule.get(oid);
      if (!pm) continue;
      const proj = [...pm.entries()]
        .map(([pid, list]) => ({
          pid,
          title: pid === WITHOUT_PROJECT ? 'Without project' : (projects[pid]?.summary ?? pid),
          fullTitle: pid === WITHOUT_PROJECT ? null : (projects[pid]?.title ?? null),
          entries: list,
          progress: progress(list),
        }))
        .sort(
          (a, b) =>
            (a.pid === WITHOUT_PROJECT) - (b.pid === WITHOUT_PROJECT) ||
            a.title.localeCompare(b.title, 'en'),
        );
      const all = proj.flatMap((x) => x.entries);
      out.push({
        oid,
        title: oid === WITHOUT_MODULE ? 'Without area' : (titleFor.get(oid) ?? oid),
        projects: proj,
        count: all.length,
        progress: progress(all),
      });
    }
    return out;
  }

  // ---- The breadcrumb and the copy lines --------------------------------------------------------------

  /** Short name for a project: the title up to the first parenthesis or colon (project titles are often long). */
  function summaryName(title, pid) {
    const t = String(title ?? '')
      .split(/\s[(:]|[(:]/)[0]
      .trim();
    return t || pid;
  }

  /** "Module › Project › Title" for an entry, project or module (only titles). */
  function pathText(parts) {
    return parts.filter(Boolean).join(' › ');
  }

  /**
   * Copy line for a level, so the owner writes the instruction right after. Only id and titles.
   *   module    /plans core (Core). Instruction:
   *   project /plans export (Core › Export). Instruction:
   *   entry    /plans PL-EXPORT-1 (Core › Export › CSV-export …). Instruction:
   *   owner     /plans owner SP-EXPORT-1 (Core › Export › PL-EXPORT-1). Instruction:
   *   jur      /plans jur J-EXPORT-2 (Core › Export › PL-EXPORT-1). Instruction:
   */
  function copyLine(level, sortKey, parts) {
    const prefix = level === 'owner' ? 'owner ' : level === 'jur' ? 'jur ' : '';
    const filePath = pathText(parts);
    return `/plans ${prefix}${sortKey}${filePath ? ` (${filePath})` : ''}. Instruction:`;
  }

  /** The titles above an entry: [module, project] (short names), as the breadcrumb shows them. */
  function overEntry(entry, data) {
    const modName = (data.modules ?? []).find((m) => m.oid === entry.module);
    const pr = entry.project ? data.projects?.[entry.project] : null;
    return [
      modName?.title ?? (entry.module ? entry.module : 'Without area'),
      pr ? (pr.summary ?? entry.project) : entry.project ? entry.project : 'Without project',
    ];
  }

  /**
   * The breadcrumb below the top: Plans › Module › Project › Entry. With a selected entry the path is built from the entry; otherwise
   * from the filter when it is set to exactly one module (and one project, if any). Each part has the state a click gives and
   * the copy line for the level (not for "Plans").
   * @returns {{ level: 'room'|'module'|'project'|'entry', sortKey: string|null, text: string, copy: string|null,
   *   filter: Record<string,string[]>|null, entry: string|null }[]}
   */
  function breadcrumbs(state, data) {
    if (state.surface === 'doc') return docBreadcrumbs(state, data);
    if (JB_SURFACES.includes(state.surface)) return jbBreadcrumbs(state, data);
    // the Roadmap: Plans › Roadmap, and on the plan page › the plan's title (Roadmap then takes you back).
    if (state.surface === 'roadmap') {
      const entry = state.entry ? (data.entries ?? []).find((p) => p.id === state.entry) : null;
      const base = { sortKey: null, copy: null, filter: null, entry: null };
      return [
        { ...base, level: 'room', text: 'Plans', state: { surface: 'roadmap', entry: null } },
        { ...base, level: 'surface', sortKey: 'roadmap', text: 'Roadmap', state: { entry: null } },
        ...(entry ? [{ ...base, level: 'entry', sortKey: entry.id, text: entry.title || entry.id, entry: entry.id }] : []),
      ];
    }
    // the overview. "Plans" takes you to the list of plan entries.
    if (state.surface === 'overview')
      return [
        {
          level: 'room',
          sortKey: null,
          text: 'Plans',
          copy: null,
          filter: null,
          entry: null,
          state: { surface: 'entries' },
        },
        {
          level: 'surface',
          sortKey: 'overview',
          text: 'Overview',
          copy: null,
          filter: null,
          entry: null,
        },
      ];
    const out = [
      {
        level: 'room',
        sortKey: null,
        text: 'Plans',
        copy: null,
        filter: emptyFilter(),
        entry: null,
      },
    ];
    const entry = state.entry ? (data.entries ?? []).find((p) => p.id === state.entry) : null;
    let modName = null;
    let project = null;
    if (entry) {
      modName = entry.module ?? null;
      project = entry.project ?? null;
    } else {
      if (state.filter?.module?.length === 1) modName = state.filter.module[0];
      if (state.filter?.project?.length === 1) {
        project = state.filter.project[0];
        if (!modName) modName = data.projects?.[project]?.area ?? null;
      }
    }
    if (modName === WITHOUT_MODULE) modName = null;
    if (project === WITHOUT_PROJECT) project = null;
    const moduleTitle = modName
      ? ((data.modules ?? []).find((m) => m.oid === modName)?.title ?? modName)
      : null;
    if (modName) {
      const f = emptyFilter();
      f.module = [modName];
      out.push({
        level: 'module',
        sortKey: modName,
        text: moduleTitle,
        copy: copyLine('module', modName, [moduleTitle]),
        filter: f,
        entry: null,
      });
    }
    if (project) {
      const pr = data.projects?.[project];
      const name = pr?.summary ?? project;
      const f = emptyFilter();
      if (modName) f.module = [modName];
      f.project = [project];
      out.push({
        level: 'project',
        sortKey: project,
        text: name,
        copy: copyLine('project', project, [moduleTitle, name]),
        filter: f,
        entry: null,
      });
    }
    if (entry) {
      out.push({
        level: 'entry',
        sortKey: entry.id,
        text: entry.id,
        copy: entryLine(entry, data),
        filter: null,
        entry: entry.id,
      });
    }
    return out;
  }

  /** The start line for an entry: /plans PL-X (Module › Project › Title). Instruction: */
  function entryLine(entry, data) {
    return copyLine('entry', entry.id, [...overEntry(entry, data), entry.title]);
  }

  /**
   * "Prepare for queue": line for /add-to-queue and the checks before packing (entry is ready, no open
   * owner question, no open legal points that block packing or prod). The warnings do not stop the copying.
   */
  function prepare(entry, data) {
    const warnings = [];
    if (entry.maturity !== 'ready')
      warnings.push(
        `Entry is ${MATURITY[entry.maturity]?.toLowerCase() ?? entry.maturity}, not ready.`,
      );
    const openSp = (entry.ownerQuestions ?? []).filter((s) => !s.resolved);
    if (openSp.length)
      warnings.push(
        `${openSp.length} ${openSp.length === 1 ? 'open owner question' : 'open owner questions'}: ` +
          `${openSp.map((s) => s.id).join(', ')}.`,
      );
    const jur = legalOpen(entry).filter(
      (x) => x.blocks === 'packing' || x.blocks === 'prod',
    );
    if (jur.length)
      warnings.push(
        `${jur.length} ${jur.length === 1 ? 'open legal point that blocks' : 'open legal points that block'}: ` +
          `${jur.map((x) => x.id).join(', ')}.`,
      );
    const line = `/add-to-queue ${entry.id} (${pathText([...overEntry(entry, data), entry.title])})`;
    return { line, warnings };
  }

  // ---- The link to the queue ---------------------------------------------------------------------------------

  const COLUMN_TEXT = {
    proposed: 'Proposed, not approved',
    batch: 'In the batch queue, to be packed into a track',
    inProgress: 'In progress',
    review: 'In review',
    built: 'Done',
  };

  /**
   * The status text for a queue task in the Queue tab: e.g. "In queue, step 2 in focus (Core)" or "In queue, outside focus:
   * not started". The focus step is the queue's axis; the priority (Now, Later) is the plan register's, and they are shown separately.
   * @param {{ status?: string, column?: string|null, step?: number|null, outside?: boolean, applies?: boolean,
   *   step_title?: string|null }} o
   */
  function queueStatusText(o) {
    if (o.column === 'queue') {
      if (!o.applies) return 'In queue';
      if (o.outside || o.step == null) return 'In queue, outside focus: not started';
      return `In queue, step ${o.step + 1} in focus${o.step_title ? ` (${o.step_title})` : ''}`;
    }
    if (o.column && COLUMN_TEXT[o.column]) return COLUMN_TEXT[o.column];
    return o.status === 'cancelled' ? 'Cancelled' : String(o.status ?? 'unknown');
  }

  /**
   * P8 (plan to tasks): the Queue search split into `plan:<id>` parts and the plain words, both lowercased. A lone
   * "plan:" is just a word. The Queue's search box (board/cards.js) uses it, so "plan:PL-AUTH sessions" shows the
   * cards of that plan whose text has "sessions".
   * @returns {{ plans: string[], text: string }}
   */
  function searchParts(search) {
    const plans = [];
    const words = [];
    for (const w of String(search ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      const m = /^plan:(\S+)$/.exec(w);
      if (m) plans.push(m[1]);
      else words.push(w);
    }
    return { plans, text: words.join(' ') };
  }

  /**
   * Does a Queue card match the search? The plan parts are "or" (any of them), the words must appear in the card's id,
   * title, feature or project (the Queue's plain search, unchanged).
   */
  function cardMatchesSearch(k, search) {
    const { plans, text } = searchParts(search);
    if (plans.length && !plans.includes(String(k?.plan ?? '').toLowerCase())) return false;
    if (!text) return true;
    return `${k?.id} ${k?.title} ${k?.feature ?? ''} ${k?.project}`.toLowerCase().includes(text);
  }

  /**
   * P8: which step from a plan to tasks the plan page offers (section 7.4: plan work and building stay apart, the board
   * adds no task itself):
   *   'see'   the plan has tasks (cancelled ones not counted): See tasks opens the Queue on the plan,
   *   'turn'  shaped (maturity ready) and no tasks yet: Turn into tasks hands off to Claude Code with the /add-to-queue
   *           line and the checks before packing (prepare),
   *   'shape' not shaped yet (an idea, investigated, planned, or still in the inbox): it must be shaped first,
   *   'none'  dropped, or built without tasks: nothing to offer.
   */
  function planToTasks(p, data = {}) {
    const q = (p?.queue ?? []).filter((o) => o.status !== 'cancelled');
    if (q.length) return { kind: 'see', count: q.length };
    const h = horizonFor(p);
    if (h === 'dropped' || h === 'done') return { kind: 'none' };
    if (h === 'inbox' || p?.maturity !== 'ready') return { kind: 'shape' };
    const prep = prepare(p, data);
    return { kind: 'turn', line: prep.line, warnings: prep.warnings };
  }

  /**
   * P8: the first focus step that covers a task of the plan, from the same placement the Queue cards use (the server's
   * queueInfo: L.focusSpace per task). Only tasks waiting in the queue have a step; null without a focus or outside it.
   * @returns {{ step: number, title: string|null, text: string }|null}
   */
  function planFocus(p) {
    let best = null;
    for (const o of p?.queue ?? []) {
      if (o?.column !== 'queue' || !o.applies || o.outside || !Number.isInteger(o.step)) continue;
      if (!best || o.step < best.step) best = { step: o.step, title: o.step_title ?? null };
    }
    if (!best) return null;
    return { ...best, text: `In focus through step T${best.step + 1}${best.title ? `: ${best.title}` : ''}.` };
  }

  // ---- Done views ----------------------------------------------------------------------------------

  /**
   * The Quick filters at the top of the Filter menu (P4, the Tasks room's QA-1d pattern): built in, cannot be deleted,
   * each a search part with a short line that says what it shows. The ids of the older ready-made views are kept.
   * Own views are saved in the same form in the browser ("Saved" in the menu).
   */
  const QUICK_FILTERS = [
    {
      id: 'waiting',
      name: 'Waiting on you',
      search: '?room=plans&waiting=owner',
      explain: 'A question or a decision from you holds them.',
    },
    { id: 'inbox', name: 'Inbox', search: '?room=plans&hz=inbox', explain: 'Reported or captured, not sorted yet.' },
    {
      id: 'building',
      name: 'Being built',
      search: '?room=plans&hz=now',
      explain: 'In the queue, partly built or worked on now.',
    },
    {
      id: 'ready',
      name: 'Ready to become tasks',
      search: '?room=plans&mod=ready',
      explain: 'Shaped plans that can be split into queue tasks.',
    },
    {
      id: 'for-prod',
      name: 'Before prod',
      search: '?room=plans&pri=now&cat=for-prod',
      explain: 'Now, and needed before going live.',
    },
    {
      id: 'security',
      name: 'Security',
      search: '?room=plans&pri=now&cat=security',
      explain: 'Now, and marked as security work.',
    },
    { id: 'stale', name: 'Stale', search: '?room=plans&stale=yes', explain: 'The check against the code is out of date.' },
    {
      id: 'drop-agent',
      name: 'Dropped by Claude',
      search: '?room=plans&pri=drop&set=agent',
      explain: 'Dropped without your say, so you can look them over.',
    },
  ];
  /** The older name of the list (the overview and older code read it). */
  const DONE_VIEWS = QUICK_FILTERS;

  /**
   * What the Filter button says (P4, as the Tasks room's drawFilter): "Filter", "Filter · 2" for checked filters, or
   * "Filter · <name>" when a quick filter (its filters) or a saved view (its filters and search) is in use. `label` is
   * for a screen reader, `active` paints the button as in use. The search is not counted: it shows in its own box.
   * @param {object} state the room's state (readUrl)
   * @param {{ name: string, search: string }[]} ownViews the viewer's saved views
   * @returns {{ text: string, label: string, title: string, active: boolean, name: string|null, n: number }}
   */
  function filterButtonText(state, ownViews = []) {
    const n = countFilters(state?.filter);
    const now = writeUrl({ room: 'plans', filter: state?.filter ?? emptyFilter(), search: state?.search ?? '' });
    const nowFilterOnly = writeUrl({ room: 'plans', filter: state?.filter ?? emptyFilter() });
    let name = null;
    if (n > 0 || state?.search) {
      const own = ownViews.find((v) => v && typeof v.search === 'string' && sameView(v.search, now));
      const quick = n > 0 ? QUICK_FILTERS.find((v) => sameView(v.search, nowFilterOnly)) : null;
      name = own?.name ?? quick?.name ?? null;
    }
    const text = name ? `Filter · ${name}` : n ? `Filter · ${n}` : 'Filter';
    const label = ['Filter', name ? `${name} in use` : null, n ? `${n} active` : null].filter(Boolean).join(', ');
    const title = name
      ? `Filter: "${name}" is in use${n ? `, ${n} filters checked` : ''}. Quick filters, saved filters and the filter sections.`
      : n
        ? `Filter: ${n} checked. Quick filters, saved filters and the filter sections.`
        : 'Quick filters, saved filters and the filter sections. They change what you see, not the plans.';
    return { text, label, title, active: n > 0 || !!name, name, n };
  }

  /**
   * The sorts in the Sort menu (P4). Roadmap order is the default: the register is already sorted by horizon rank,
   * priority, deadline and how many plans wait on it (queuePlan.sortEntries), so it keeps the order it was given.
   * Within each section of the Roadmap the chosen sort applies; the sections stay.
   */
  const PLAN_SORTS = [
    { id: 'roadmap', text: 'Roadmap order', explain: 'By horizon, then the priority rules and the deadline.' },
    { id: 'changed', text: 'Recently changed', explain: 'The latest change in the register first.' },
    { id: 'added', text: 'Recently added', explain: 'The newest plans first.' },
    { id: 'deadline', text: 'Deadline', explain: 'The nearest deadline first, plans without one last.' },
    { id: 'title', text: 'Title', explain: 'A to Z.' },
    {
      id: 'blocked',
      text: 'Most blocked',
      explain: 'Held by an open question first, then the plans most others wait on.',
    },
  ];
  const PLAN_SORT_IDS = PLAN_SORTS.map((x) => x.id);

  /** A sort id from storage or a saved view: a known one, else Roadmap order. */
  function cleanSort(x) {
    return PLAN_SORT_IDS.includes(x) ? x : 'roadmap';
  }

  /**
   * The plans in the chosen order (a new list; ties keep the order they came in, so Roadmap order is the tie-break).
   * @param {object[]} entries
   * @param {string} sort an id from PLAN_SORTS
   */
  function sortPlans(entries, sort) {
    const list = (entries ?? []).map((p, i) => ({ p, i }));
    const by = cleanSort(sort);
    if (by === 'roadmap') return list.map((x) => x.p);
    const time = (iso) => {
      const t = Date.parse(iso ?? '');
      return Number.isNaN(t) ? null : t;
    };
    // newest first, unknown last
    const newest = (a, b) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a);
    const changedAt = (p) => (p.history ?? []).reduce((m, h) => Math.max(m, time(h?.at) ?? -Infinity), -Infinity);
    const held = (p) =>
      p.priority === 'owner' || (p.ownerQuestions ?? []).some((q) => q && !q.resolved) || (p.legal_open ?? 0) > 0;
    const compare = {
      changed: (a, b) => {
        const x = changedAt(a);
        const y = changedAt(b);
        return newest(Number.isFinite(x) ? x : null, Number.isFinite(y) ? y : null);
      },
      added: (a, b) => newest(time(a.created), time(b.created)),
      deadline: (a, b) => {
        const x = typeof a.deadline === 'string' ? a.deadline : null;
        const y = typeof b.deadline === 'string' ? b.deadline : null;
        return x == null ? (y == null ? 0 : 1) : y == null ? -1 : x.localeCompare(y);
      },
      title: (a, b) =>
        String(a.title ?? a.id).localeCompare(String(b.title ?? b.id), undefined, { sensitivity: 'base' }),
      blocked: (a, b) =>
        Number(held(b)) - Number(held(a)) ||
        (b.blocks ?? []).length - (a.blocks ?? []).length ||
        (b.ownerQuestions ?? []).filter((q) => !q?.resolved).length -
          (a.ownerQuestions ?? []).filter((q) => !q?.resolved).length,
    }[by];
    return list.sort((a, b) => compare(a.p, b.p) || a.i - b.i).map((x) => x.p);
  }

  /** Same filters and search (the order in the lists does not count)? Used to mark the view that is in use. */
  function sameView(a, b) {
    const ta = readUrl(a);
    const tb = readUrl(b);
    if (ta.search !== tb.search) return false;
    return FACETS.every((f) => {
      const x = [...ta.filter[f.id]].sort().join(',');
      const y = [...tb.filter[f.id]].sort().join(',');
      return x === y;
    });
  }

  /** An own view from the browser (localStorage): name and search part, cleaned. Invalid gives null. */
  function cleanOwnView(x) {
    if (!x || typeof x !== 'object') return null;
    const name = String(x.name ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 60);
    if (!name) return null;
    const t = readUrl(String(x.search ?? ''));
    const out = {
      name,
      search: writeUrl({
        ...t,
        room: 'plans',
        entry: null,
        surface: 'entries',
        dfilter: emptyDocFilter(),
        dsearch: '',
        doc: null,
      }),
    };
    // P4: a view saved from the Filter menu also keeps the sort; views saved before have none and keep working.
    if (PLAN_SORT_IDS.includes(x.sort)) out.sort = x.sort;
    return out;
  }

  // ---- Data from the server (/api/plans) -----------------------------------------------------------------------------

  /** The project's short name and title, module (area) and phase. */
  function projectInfo(projects) {
    const out = {};
    for (const [pid, p] of Object.entries(projects ?? {})) {
      out[pid] = {
        title: p?.title ?? pid,
        summary: summaryName(p?.title, pid),
        area: p?.area ?? null,
        phase: p?.phase ?? null,
      };
    }
    return out;
  }

  /**
   * What /api/plans sends: modules, projects and entries with everything the list and the panel need. Entries are sorted
   * by the priority rules (queuePlan.sortEntries), with derived maturity, queue tasks with status and focus step, the owner questions
   * with text, open legal points, "Working now" and the history from the changelog (only field names).
   * @param {object} reg plans.json (normalized)
   * @param {object} queue queue.json
   * @param {{ now?: Date, queueInfo?: (o: object) => object, queuePlan?: object }} ctx queueInfo gives column and focus step
   *   for a queue task (the server computes it with queueBoard and queueLogic)
   */
  function plansData(reg, queue, ctx = {}) {
    const P = ctx.queuePlan ?? require('./queuePlan.js');
    const now = ctx.now ?? new Date();
    const queueInfo = ctx.queueInfo ?? (() => ({}));
    const projects = projectInfo(queue?.projects);
    const areas = queue?.areas ?? {};
    const known = P.MODULES.map((m) => m.oid);
    const modules = [
      ...known.filter((oid) => Object.hasOwn(areas, oid)),
      ...Object.keys(areas).filter((oid) => !known.includes(oid)),
    ].map((oid) => ({ oid, title: areas[oid]?.title ?? oid }));
    const perId = new Map((queue?.tasks ?? []).map((o) => [o.id, o]));
    const resolved = new Set(queue?.resolved ?? []);
    const activeOnes = P.activeEntries(reg, { now });
    const history = new Map();
    for (const h of reg.changelog ?? []) {
      const perEntry = new Map();
      for (const e of h?.changes ?? []) {
        if (!e?.id) continue;
        if (!perEntry.has(e.id)) perEntry.set(e.id, []);
        perEntry.get(e.id).push(String(e.field ?? '*'));
      }
      for (const [id, field] of perEntry) {
        if (!history.has(id)) history.set(id, []);
        history.get(id).push({
          nr: h.nr,
          at: h.at ?? null,
          by: h.by ?? null,
          action: h.action ?? null,
          field,
        });
      }
    }
    const all = reg.entries ?? [];
    // The Roadmap's Inbox (P1): a finding nobody has sorted yet (queueFindings.isNewFinding, the same rule as the
    // FINDINGS line in `ravenseat show`). The lead (P3) comes from the server (ctx.leadFor reads the plan document,
    // cached per file), so this function stays pure; without leadFor nothing is read.
    const QF = ctx.queueFindings ?? require('./queueFindings.js');
    const leadFor = typeof ctx.leadFor === 'function' ? ctx.leadFor : null;
    const entries = P.sortEntries(all).map((p) => {
      const by = P.derivedMaturity(p, queue?.tasks, { now });
      const jur = p.legal && typeof p.legal === 'object' ? p.legal : null;
      const out = {
        id: p.id,
        title: p.title ?? p.id,
        summary: p.summary ?? null,
        project: p.project ?? null,
        module: P.moduleFor(p, queue?.projects) ?? null,
        priority: p.priority ?? null,
        now_category: Array.isArray(p.now_category) ? p.now_category : [],
        priority_reason: p.priority_reason ?? null,
        priority_set_by: p.priority_set_by ?? 'agent',
        maturity: by.maturity,
        maturity_plan: p.maturity ?? null,
        size: p.size ?? null,
        deadline: p.deadline ?? null,
        sources: (p.sources ?? []).map((k) => ({
          path: k?.path ?? '',
          anchor: k?.anchor ?? null,
          role: k?.role ?? null,
        })),
        roadmap: p.roadmap ?? [],
        depends_on: p.depends_on ?? [],
        blocks: P.blocks(p, all).map((q) => q.id),
        ownerQuestions: (p.ownerQuestions ?? []).map((s) => ({
          id: s,
          text: queue?.question?.[s]?.text ?? null,
          resolved: resolved.has(s),
          answer: queue?.resolutions?.[s]?.answer ?? null,
          // an owner action with a deadline sits in the deadline band (the field is only included when it exists).
          ...(typeof queue?.question?.[s]?.deadline === 'string' ? { deadline: queue.question[s].deadline } : {}),
        })),
        legal: jur,
        legal_open: legalOpen(p).length,
        stale: by.stale,
        finished: by.finished,
        total: by.total,
        fraction: by.fraction,
        queue: by.queue_tasks.map((id) => {
          const o = perId.get(id) ?? {};
          return { id, title: o.title ?? null, status: o.status ?? null, ...queueInfo(o) };
        }),
        verified: p.verified ?? null,
        drop_reason: p.drop_reason ?? null,
        remark: p.remark ?? null,
        merged_from: p.merged_from ?? [],
        active: activeOnes[p.id] ?? null,
        created: p.created ?? null, // "Recently registered"
        history: (history.get(p.id) ?? []).slice(-20).reverse(),
        // Inbox: { by, at } while the plan waits to be sorted, else null: a captured plan (P6, lib/planInbox.js, by
        // 'owner') or a finding nobody has triaged (by 'track'). A queue task that points to it has sorted it.
        inbox:
          p.inbox && p.priority !== 'drop' && !(queue?.tasks ?? []).some((o) => o?.plan === p.id)
            ? { by: typeof p.inbox.by === 'string' ? p.inbox.by : 'owner', at: p.inbox.at ?? null }
            : QF.isNewFinding(p, queue?.tasks ?? [])
              ? { by: 'track', at: p.finding?.reported ?? null }
              : null,
        // The lead from the plan document, only when nobody wrote a summary: { text, path, anchor } or null.
        lead: !p.summary && leadFor ? (leadFor(p) ?? null) : null,
      };
      return out;
    });
    return {
      modules,
      projects,
      entries,
      ...documentsData(reg, queue, { now, P, history }),
      // legal panel, owner decisions and the launch overview.
      ...jbData(reg, queue, { now, P }),
      // The document folders the read view can read from (the browser calls setReadFolders with them).
      read_folders: readFolders.slice(),
      // the priority rules (queuePlan.PRIORITY_RULES, from the configuration) for the columns in the priority map.
      rules: (P.PRIORITY_RULES ?? []).map((r) => ({
        nr: r.nr,
        name: r.name,
        priority: r.priority,
        categories: r.categories ?? [],
      })),
      // the capacity in Now with a notice when Now grows faster than the queue empties, and what was recently
      // changed and registered. The server computes ctx.donePerWeek from the queue (like `plan check`).
      ...(P.capacity
        ? (() => {
            const ch = P.capacity(reg, queue, { donePerWeek: ctx.donePerWeek ?? null, now });
            const days = P.CAPACITY_WINDOW_DAYS ?? 28;
            const access = nowAccess(reg, { now, days, sizeTrack: P.SIZE_TRACK ?? {} });
            return {
              capacity: { ...ch, access, ...capacityWarning(ch, access, { days }) },
            };
          })()
        : {}),
      recent: { changed: recentChanged(reg), registered: recentRegistered(reg) },
      changed: reg.changed ?? null,
    };
  }

  /** The plan entry each queue task belongs to (task id → entry id), for the marker on the queue cards. */
  function planForTask(entries) {
    const out = {};
    for (const p of entries ?? []) for (const o of p.queue ?? []) out[o.id] = p.id;
    return out;
  }

  // ---- Documents and agreements -------------------------------------------------------

  /** Does the search match the document? In id, title, source, remark and the problems. */
  function docSearchMatch(d, search) {
    const s = String(search ?? '')
      .trim()
      .toLowerCase();
    if (!s) return true;
    return [d.id, d.title, d.source, d.remark, ...(d.problems ?? []).map((p) => p?.text)]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
      .includes(s);
  }

  /**
   * Documents that fit the filters and the search. Dropped ones are hidden until the priority filter includes Drop (like entries).
   * `except` is a facet that is not counted (the facet counts).
   */
  function docFilter(documents, dfilter = {}, search = '', { except = null } = {}) {
    const pri = dfilter.pri ?? [];
    return (documents ?? []).filter((d) => {
      if (d.priority === 'drop' && !pri.includes('drop') && except !== 'pri') return false;
      for (const f of DOC_FACETS) {
        if (f.id === except) continue;
        const selected = dfilter[f.id];
        if (selected?.length && !f.by(d).some((v) => selected.includes(v))) return false;
      }
      return docSearchMatch(d, search);
    });
  }

  /** The facets for documents with match counts per value (same rule as facetNumber). */
  function docFacetNumber(documents, dfilter, search) {
    return DOC_FACETS.map((f) => {
      const basis = docFilter(documents, dfilter, search, { except: f.id });
      const counts = new Map();
      for (const d of basis)
        for (const v of new Set(f.by(d))) counts.set(v, (counts.get(v) ?? 0) + 1);
      const selected = dfilter?.[f.id] ?? [];
      const option = Object.keys(f.values)
        .filter((v) => (counts.get(v) ?? 0) > 0 || selected.includes(v))
        .map((v) => ({
          val: v,
          text: valueText(f.values[v]),
          symbol: f.values[v]?.symbol ?? null,
          count: counts.get(v) ?? 0,
          selected: selected.includes(v),
        }));
      return { id: f.id, title: f.title, option };
    });
  }

  /** The chips above the table: one per active document filter. */
  function docChips(dfilter) {
    const out = [];
    for (const f of DOC_FACETS)
      for (const v of dfilter?.[f.id] ?? [])
        out.push({ facet: f.id, val: v, text: `${f.title}: ${valueText(f.values[v] ?? v)}` });
    return out;
  }

  /** Count of active document filters (the search not included). */
  function countDocFilters(dfilter) {
    return DOC_FACETS.reduce((n, f) => n + (dfilter?.[f.id]?.length ?? 0), 0);
  }

  /**
   * One table per group, in the order of DOC_GROUP; only groups with matches. Every group has
   * a count per status (for the summary) and a count of those that need something done.
   */
  function docGroups(match) {
    const out = [];
    for (const [id, title] of Object.entries(DOC_GROUP)) {
      const documents = (match ?? []).filter((d) => d.group === id);
      if (!documents.length) continue;
      const status = {};
      for (const d of documents) status[d.status] = (status[d.status] ?? 0) + 1;
      out.push({
        id,
        title,
        documents,
        count: documents.length,
        must: documents.filter((d) => (d.reasons ?? []).length).length,
        status,
      });
    }
    return out;
  }

  /** "October 2026" for a month (YYYY-MM). */
  function monthName(ym) {
    const t = new Intl.DateTimeFormat('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${ym}-15T12:00:00Z`));
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /**
   * The timeline for revisions and deadlines, split into "Overdue" and one column per month (only months with something in them), so
   * what is close comes first.
   * @param {{ id, title, type, date, days, overdue }[]} elements from queuePlan.revisionTimeline
   * @returns {{ sortKey: string, title: string, overdue: boolean, elements: object[] }[]}
   */
  function timelineMonths(elements) {
    const out = [];
    const overdue = (elements ?? []).filter((e) => e.overdue);
    if (overdue.length)
      out.push({ sortKey: 'overdue', title: 'Overdue', overdue: true, elements: overdue });
    const perMonth = new Map();
    for (const e of elements ?? []) {
      if (e.overdue) continue;
      const ym = String(e.date).slice(0, 7);
      if (!perMonth.has(ym)) perMonth.set(ym, []);
      perMonth.get(ym).push(e);
    }
    for (const ym of [...perMonth.keys()].sort())
      out.push({ sortKey: ym, title: monthName(ym), overdue: false, elements: perMonth.get(ym) });
    return out;
  }

  /** Copy line for a document, like queuePlan.docCopyLine. */
  function docLine(d) {
    return `/plans doc ${d.id}. Instruction:`;
  }

  /**
   * Path for the document surface: Plans › Documents and agreements › Group › DOC-id. Each part has `state` (what a
   * click sets) and the copy line where there is one.
   */
  function docBreadcrumbs(state, data) {
    const out = [
      {
        level: 'room',
        sortKey: null,
        text: 'Plans',
        copy: null,
        filter: null,
        entry: null,
        state: { surface: 'entries', doc: null },
      },
      {
        level: 'surface',
        sortKey: 'doc',
        text: 'Documents and agreements',
        copy: null,
        filter: null,
        entry: null,
        state: { surface: 'doc', dfilter: emptyDocFilter(), dsearch: '', doc: null },
      },
    ];
    const d = state.doc ? (data?.documents ?? []).find((x) => x.id === state.doc) : null;
    const group = d
      ? d.group
      : state.dfilter?.group?.length === 1
        ? state.dfilter.group[0]
        : null;
    if (group && DOC_GROUP[group]) {
      const f = emptyDocFilter();
      f.group = [group];
      out.push({
        level: 'group',
        sortKey: group,
        text: DOC_GROUP[group],
        copy: null,
        filter: null,
        entry: null,
        state: { surface: 'doc', dfilter: f, doc: null },
      });
    }
    if (d)
      out.push({
        level: 'doc',
        sortKey: d.id,
        text: d.id,
        copy: docLine(d),
        filter: null,
        entry: null,
        state: { surface: 'doc', doc: d.id },
      });
    return out;
  }

  /**
   * Documents as the tab shows them (the server calls this from plansData): the fields from the register, version skew,
   * next revision, the notices for the facet, the "What must be done" reasons, the links with titles and the history (only
   * field names). In addition the list "What must be done" and the timeline for the next 12 months.
   */
  function documentsData(reg, queue, { now = new Date(), P, history = new Map() } = {}) {
    const all = Array.isArray(reg?.documents) ? reg.documents : [];
    const resolved = new Set(queue?.resolved ?? []);
    const entryTitle = new Map((reg?.entries ?? []).map((p) => [p.id, p.title ?? p.id]));
    const docTitle = new Map(all.map((d) => [d.id, d]));
    const documents = all.map((d) => {
      const miss = P.versionSkew(d);
      const next = P.nextRevision(d, { now });
      const problems = Array.isArray(d.problems) ? d.problems : [];
      const notice = [];
      if (problems.some((p) => p?.severity === 'high')) notice.push('problem-high');
      if (problems.length) notice.push('problem');
      if (miss.length) notice.push('miss');
      if (next?.overdue) notice.push('overdue');
      else if (next?.soon) notice.push('soon');
      return {
        id: d.id,
        title: d.title ?? d.id,
        group: d.group ?? null,
        audience: d.audience ?? null,
        status: d.status ?? null,
        source: d.source ?? null,
        published: Array.isArray(d.published) ? d.published : [],
        version: d.version ?? null,
        current_version: d.current_version ?? null,
        last_revised: d.last_revised ?? null,
        revision_every: d.revision_every ?? null,
        revisions: Array.isArray(d.revisions) ? d.revisions : [],
        problems,
        priority: d.priority ?? null,
        now_category: Array.isArray(d.now_category) ? d.now_category : [],
        priority_reason: d.priority_reason ?? null,
        priority_set_by: d.priority_set_by ?? null,
        drop_reason: d.drop_reason ?? null,
        deadline: d.deadline ?? null,
        remark: d.remark ?? null,
        legal_points: d.legal_points ?? [],
        depends_on_docs: (d.depends_on_docs ?? []).map((id) => ({
          id,
          title: docTitle.get(id)?.title ?? null,
          status: docTitle.get(id)?.status ?? null,
        })),
        used_by: all.filter((x) => (x.depends_on_docs ?? []).includes(d.id)).map((x) => x.id),
        planEntries: (d.planEntries ?? []).map((id) => ({ id, title: entryTitle.get(id) ?? null })),
        ownerQuestions: (d.ownerQuestions ?? []).map((id) => ({
          id,
          text: queue?.question?.[id]?.text ?? null,
          resolved: resolved.has(id),
        })),
        miss,
        next_revision: next,
        notice,
        reasons: P.docReasons(d, { now }),
        history: (history.get(d.id) ?? []).slice(-20).reverse(),
      };
    });
    return {
      documents,
      doc_must_be_done: P.docMustBeDone(all, { now }),
      doc_timeline: P.revisionTimeline(all, { now, days: 365 }),
    };
  }

  // ---- priority map and the deadline band -------------------------------------------------------
  //
  // Priority map: modules as rows, Now (security, before prod, important), Owner, Later and Drop (folded) as
  // columns. Entries are dragged between the columns in the same row (the module follows the project and is not changed here). The moves
  // are batched in a draft ({ [entry-id]: { to, reason? } }) that is previewed and saved together via queue.mjs plan prioritize.
  // The deadline band: deadlines from entries, documents and owner actions in the next 90 days, plus what is overdue.

  /** The columns in the map, in order. The symbol always sits together with the text (color is never the only carrier). */
  const MAP_COLUMNS = [
    {
      id: 'now-security',
      priority: 'now',
      category: 'security',
      text: 'Now: security',
      symbol: '●',
    },
    {
      id: 'now-for-prod',
      priority: 'now',
      category: 'for-prod',
      text: 'Now: before prod',
      symbol: '●',
    },
    { id: 'now-important', priority: 'now', category: 'important', text: 'Now: important', symbol: '●' },
    { id: 'owner', priority: 'owner', category: null, text: 'Owner', symbol: '◆' },
    { id: 'later', priority: 'later', category: null, text: 'Later', symbol: '○' },
    { id: 'drop', priority: 'drop', category: null, text: 'Drop', symbol: '✕', folded: true },
  ];
  const MAP_COLUMN_IDS = MAP_COLUMNS.map((k) => k.id);
  /** The Now categories in the order an entry with several categories is placed (the first one it has). */
  const NOW_ORDER = ['security', 'for-prod', 'important'];
  /** The deadline band shows the next 90 days. */
  const DEADLINE_DAYS = 90;
  /** The limits for saving (the server checks the same ones). */
  const DRAFT_MAX = 300;
  const REASON_MAX = 500;

  /** The column from the id (null when it is unknown). */
  function mapColumn(id) {
    return MAP_COLUMNS.find((k) => k.id === id) ?? null;
  }

  /**
   * The column an entry sits in according to the register: Now by the first category it has (security before before prod before
   * important), otherwise the priority. Now without a category (invalid in the register) sits under important. Unknown priority: null.
   */
  function mapColumnFor(entry) {
    if (entry?.priority === 'now') {
      const cat = NOW_ORDER.find((k) => (entry.now_category ?? []).includes(k)) ?? 'important';
      return `now-${cat}`;
    }
    return MAP_COLUMN_IDS.includes(entry?.priority) ? entry.priority : null;
  }

  /** The column the entry sits in with the draft. */
  function columnWithDraft(entry, draft) {
    return draft?.[entry.id]?.to ?? mapColumnFor(entry);
  }

  /**
   * The priority rules that give a column (queuePlan.PRIORITY_RULES, sent as `rules` in /api/plans), so the column
   * header can show why an entry belongs there.
   */
  function columnRules(rules, columnId) {
    const k = mapColumn(columnId);
    if (!k) return [];
    return (rules ?? []).filter(
      (r) =>
        r.priority === k.priority && (!k.category || (r.categories ?? []).includes(k.category)),
    );
  }

  /**
   * The entries the map shows: the same as the list (filters and search), and in addition the dropped ones that fit the other
   * filters when the priority filter is empty, so the Drop column (folded) has something to count. If you set the priority filter
   * yourself, it applies as in the list.
   */
  function mapEntries(entries, filter = {}, search = '', { now = new Date() } = {}) {
    const show = applyFilter(entries, filter, search, { now });
    if ((filter.pri ?? []).length) return show;
    const drop = applyFilter(entries, filter, search, { now, except: 'pri' }).filter(
      (p) => p.priority === 'drop',
    );
    return [...show, ...drop];
  }

  /**
   * The grid: one row per module with matches (in module order, "Without module" last), one cell per column. Every
   * chip has the entry, whether it is moved in the draft, and the column it came from. The order in the cells is the list's.
   * @returns {{ columns: object[], rows: { oid, title, count, cells: Record<string, object[]> }[], withoutPriority: object[] }}
   */
  function mapGrid(entries, modules = [], draft = {}) {
    const rowSequence = [...(modules ?? []).map((m) => m.oid), WITHOUT_MODULE];
    const titles = new Map((modules ?? []).map((m) => [m.oid, m.title]));
    titles.set(WITHOUT_MODULE, 'Without area');
    const rows = new Map();
    const count = Object.fromEntries(MAP_COLUMN_IDS.map((k) => [k, 0]));
    const withoutPriority = [];
    for (const p of entries ?? []) {
      const from = mapColumnFor(p);
      const to = columnWithDraft(p, draft);
      if (!mapColumn(to)) {
        withoutPriority.push(p);
        continue;
      }
      const oid = p.module ?? WITHOUT_MODULE;
      if (!rows.has(oid)) {
        if (!rowSequence.includes(oid)) rowSequence.splice(rowSequence.length - 1, 0, oid);
        rows.set(oid, Object.fromEntries(MAP_COLUMN_IDS.map((k) => [k, []])));
      }
      rows.get(oid)[to].push({ entry: p, moved: to !== from, from });
      count[to] += 1;
    }
    return {
      columns: MAP_COLUMNS.map((k) => ({ ...k, count: count[k.id] })),
      rows: rowSequence
        .filter((oid) => rows.has(oid))
        .map((oid) => {
          const cells = rows.get(oid);
          return {
            oid,
            title: titles.get(oid) ?? oid,
            count: MAP_COLUMN_IDS.reduce((n, k) => n + cells[k].length, 0),
            cells,
          };
        }),
      withoutPriority,
    };
  }

  /**
   * Moves an entry in the draft (a new object; the old one is not changed). Moving back to the column it has in the register
   * removes the move. The reason is kept as long as the entry sits in Drop.
   */
  function moveInDraft(draft, entry, to) {
    if (!entry?.id || !mapColumn(to)) return { ...(draft ?? {}) };
    const out = { ...(draft ?? {}) };
    const old = out[entry.id];
    if (to === mapColumnFor(entry)) delete out[entry.id];
    else out[entry.id] = to === 'drop' && old?.reason ? { to, reason: old.reason } : { to };
    return out;
  }

  /** Sets the reason for an entry that is moved to Drop in the draft. */
  function setDraftReason(draft, id, reason) {
    const out = { ...(draft ?? {}) };
    if (out[id]?.to !== 'drop') return out;
    out[id] = { to: 'drop', reason: String(reason ?? '').slice(0, REASON_MAX) };
    return out;
  }

  /**
   * Removes what no longer applies in the draft: entries that are gone (merged) and entries that already sit in
   * the target column (changed by another session meanwhile). Called when the register is read again.
   */
  function cleanDraft(draft, entries) {
    const perId = new Map((entries ?? []).map((p) => [p.id, p]));
    const out = {};
    for (const [id, x] of Object.entries(draft ?? {})) {
      const p = perId.get(id);
      if (!p || !mapColumn(x?.to) || mapColumnFor(p) === x.to) continue;
      out[id] = x.to === 'drop' && x.reason ? { to: 'drop', reason: x.reason } : { to: x.to };
    }
    return out;
  }

  /** The neighbor column to the left (-1) or right (+1), or null at the edge (the keyboard). */
  function columnNeighbor(id, direction) {
    const i = MAP_COLUMN_IDS.indexOf(id);
    if (i < 0) return null;
    return MAP_COLUMN_IDS[i + (direction < 0 ? -1 : 1)] ?? null;
  }

  /**
   * The changes in the draft as the preview shows them, in the list's order, and the errors that stop saving
   * (Drop requires one sentence as the reason; too many at once).
   * @returns {{ changes: { id, title, from, to, fromText, toText, reason }[], error: string[] }}
   */
  function draftChanges(draft, entries) {
    const changes = [];
    const error = [];
    for (const p of entries ?? []) {
      const x = draft?.[p.id];
      if (!x) continue;
      const from = mapColumnFor(p);
      if (x.to === from || !mapColumn(x.to)) continue;
      const reason = String(x.reason ?? '').trim();
      changes.push({
        id: p.id,
        title: p.title ?? p.id,
        from,
        to: x.to,
        fromText: mapColumn(from)?.text ?? 'No priority',
        toText: mapColumn(x.to).text,
        reason: reason || null,
      });
      if (x.to === 'drop' && !reason) error.push(`${p.id}: Drop requires one sentence as the reason.`);
    }
    if (changes.length > DRAFT_MAX)
      error.push(`Too many changes at once (${changes.length}, at most ${DRAFT_MAX}).`);
    return { changes, error };
  }

  /**
   * The changes combined into calls: one per priority, category and reason (queue.mjs plan prioritize sets one priority for
   * many entries). Drop has the reason per entry, so every dropped entry is often its own call.
   * @returns {{ priority: string, category: string[], reason: string|null, ids: string[] }[]}
   */
  function draftGroups(changes) {
    const out = new Map();
    for (const e of changes ?? []) {
      const k = mapColumn(e.to);
      if (!k) continue;
      const reason = k.priority === 'drop' ? (e.reason ?? null) : null;
      const key = `${k.priority}|${k.category ?? ''}|${reason ?? ''}`;
      if (!out.has(key))
        out.set(key, {
          priority: k.priority,
          category: k.category ? [k.category] : [],
          reason,
          ids: [],
        });
      out.get(key).ids.push(e.id);
    }
    return [...out.values()];
  }

  /** The text from the board becomes a safe argument: without control chars and without a leading "-" (queue.mjs would read a flag). */
  function cleanArg(x, max) {
    return String(x ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .replace(/^-+\s*/, '')
      .slice(0, max);
  }

  /**
   * The server's check of the groups from the board and the arguments to `queue.mjs plan prioritize` (one call per group). The owner
   * sits at the board, so the calls have --set-by owner. Anything invalid gives an error, and then nothing runs.
   * @returns {{ error: string[], call: string[][] }}
   */
  function prioritizeCall(groups) {
    const error = [];
    const call = [];
    if (!Array.isArray(groups) || !groups.length) return { error: ['no changes'], call };
    const set = new Set();
    for (const g of groups) {
      if (!g || typeof g !== 'object') {
        error.push('invalid group');
        continue;
      }
      if (!PRIORITIES.includes(g.priority)) {
        error.push(`unknown priority ${String(g.priority).slice(0, 20)}`);
        continue;
      }
      const category = Array.isArray(g.category) ? g.category.map(String) : [];
      if (category.some((k) => !NOW_ORDER.includes(k))) {
        error.push('unknown Now category');
        continue;
      }
      if (g.priority === 'now' ? category.length !== 1 : category.length) {
        error.push('Now needs exactly one category, and only Now has a category');
        continue;
      }
      const ids = Array.isArray(g.ids) ? g.ids.map(String) : [];
      if (!ids.length || ids.some((id) => !ENTRY_ID.test(id) || set.has(id))) {
        error.push('invalid or duplicate entry ids');
        continue;
      }
      for (const id of ids) set.add(id);
      const reason = g.reason == null ? '' : cleanArg(g.reason, REASON_MAX);
      if (g.priority === 'drop' && !reason) {
        error.push(`${ids.join(', ')}: Drop requires one sentence as the reason`);
        continue;
      }
      call.push([
        'plan',
        'prioritize',
        ...ids,
        g.priority,
        ...(category.length ? ['--category', ...category] : []),
        ...(reason ? ['--reason', reason] : []),
        '--set-by',
        'owner',
        '--by',
        'theBoard',
        '--json',
      ]);
    }
    if (set.size > DRAFT_MAX) error.push(`too many entries (at most ${DRAFT_MAX})`);
    return { error, call: error.length ? [] : call };
  }

  /**
   * The elements in the deadline band: deadlines on entries, owner questions with a deadline (owner actions) and the documents' deadlines and
   * next revision, overdue or within `days` days. `ids` are the entries in the selection (same filters as the list): then
   * only documents linked to one of them are included, and only their owner questions. Without `ids` everything is included.
   * `share` is the position on the strip (0 = today, 1 = in `days` days; overdue ones sit at 0).
   * @returns {{ id, type: 'entry'|'owner'|'doc'|'revision', title, date, days, overdue, share, entry: string|null, doc: string|null }[]}
   */
  function deadlineElements(
    entries,
    documents,
    { now = new Date(), days: window = DEADLINE_DAYS, ids = null } = {},
  ) {
    const today = osloDate(now);
    const selection = ids ? new Set(ids) : null;
    const out = [];
    const add = (x, date) => {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const n = days(today, date);
      if (n > window) return;
      out.push({ ...x, date, days: n, overdue: n < 0, share: n < 0 ? 0 : n / window });
    };
    const set = new Set();
    for (const p of entries ?? []) {
      if (selection && !selection.has(p.id)) continue;
      if (p.priority === 'drop') continue;
      add({ id: p.id, type: 'entry', title: p.title ?? p.id, entry: p.id, doc: null }, p.deadline);
      for (const s of p.ownerQuestions ?? []) {
        if (!s?.deadline || s.resolved || set.has(s.id)) continue;
        set.add(s.id);
        add({ id: s.id, type: 'owner', title: s.text ?? s.id, entry: p.id, doc: null }, s.deadline);
      }
    }
    for (const d of documents ?? []) {
      if (d.priority === 'drop') continue;
      const linked = (d.planEntries ?? []).map((x) => (typeof x === 'string' ? x : x?.id));
      if (selection && !linked.some((id) => selection.has(id))) continue;
      const title = d.title ?? d.id;
      if (d.status !== 'outdated')
        add({ id: d.id, type: 'doc', title, entry: null, doc: d.id }, d.deadline);
      const nr = d.next_revision;
      if (nr?.date) add({ id: d.id, type: 'revision', title, entry: null, doc: d.id }, nr.date);
    }
    const typeSequence = { entry: 0, owner: 1, doc: 2, revision: 3 };
    return out.sort(
      (a, b) =>
        a.days - b.days || typeSequence[a.type] - typeSequence[b.type] || a.id.localeCompare(b.id),
    );
  }

  /**
   * Spreads the marks on the strip over rows, so they do not overlap: a badge goes in the first row where
   * the previous badge is at least `distance` (share of width) away. Beyond `maxRows` the rest are collected in `hidden` (shown
   * as "+N" and listed under the strip).
   * @returns {{ rows: object[][], hidden: object[] }}
   */
  function deadlineRows(elements, { distance = 0.06, maxRows = 3 } = {}) {
    const rows = [];
    const hidden = [];
    for (const e of elements ?? []) {
      const r = rows.find((row) => e.share - row[row.length - 1].share >= distance);
      if (r) r.push(e);
      else if (rows.length < maxRows) rows.push([e]);
      else hidden.push(e);
    }
    return { rows, hidden };
  }

  /** The marks under the strip: today and every 30th day, with a date (en-GB, "15 Oct"). */
  function deadlineScale(now = new Date(), window = DEADLINE_DAYS) {
    const today = osloDate(now);
    const out = [];
    for (let n = 0; n <= window; n += 30) {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      const date = d.toISOString().slice(0, 10);
      const text =
        n === 0
          ? 'Today'
          : new Intl.DateTimeFormat('en-GB', {
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            }).format(d);
      out.push({ days: n, share: n / window, date, text });
    }
    return out;
  }

  /** The text for an element in the deadline band (for screen readers and title): what, when and how long until. */
  function deadlineText(e) {
    const what = { entry: 'Deadline', owner: 'Owner action', doc: 'Document deadline', revision: 'Revision' }[
      e.type
    ];
    const when = e.overdue
      ? `overdue by ${-e.days} ${-e.days === 1 ? 'day' : 'days'}`
      : e.days === 0
        ? 'today'
        : `in ${e.days} ${e.days === 1 ? 'day' : 'days'}`;
    return `${what} ${e.date} (${when}): ${e.id} ${e.title}`;
  }

  // ---- the read view of documents and the Unregistered box ------------------------------

  /**
   * The folders /api/doc can read from (relative to the main tree): only markdown under the document folders (queue.config.json
   * `documentFolders`, default docs/). Everything else (code, .env, configuration, other file types) is rejected before the server
   * touches the disk. In Node the folders are read from the configuration when the module loads; in the browser plans.js sets them from
   * `read_folders` in /api/plans (setReadFolders).
   */
  const READ_FOLDERS_DEFAULT = ['docs/'];
  let readFolders = READ_FOLDERS_DEFAULT.slice();

  /** Sets the folders the read view and the Unregistered box use. An empty or invalid list gives the default. */
  function setReadFolders(list) {
    const ok = (Array.isArray(list) ? list : [])
      .filter((m) => typeof m === 'string' && m.trim() && !readPathFolderError(m.trim()))
      .map((m) => m.trim().replace(/\/+$/, '') + '/');
    readFolders = ok.length ? ok : READ_FOLDERS_DEFAULT.slice();
    return readFolders.slice();
  }

  /** A folder in the list must be relative, without `.`/`..` and hidden parts. */
  function readPathFolderError(m) {
    if (/^[A-Za-z]:|^[\\/]/.test(m) || m.includes('\\')) return 'not relative';
    const parts = m.replace(/\/+$/, '').split('/');
    return parts.some((d) => !d || d === '.' || d === '..' || d.startsWith('.')) ? 'invalid part' : null;
  }
  /** The largest document the read view shows (bytes). */
  const READ_MAX_BYTE = 2 * 1024 * 1024;
  const READ_PATH_MAX = 300;
  const ANCHOR_MAX = 120;
  /** Same pattern as queuePlan.ID_PATTERN (PL-NAME-1). */
  const NEW_ENTRY_ID = /^PL-[A-Z0-9\u00C6\u00D8\u00C5](?:[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5-]*[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5])?$/;
  const TITLE_MAX = 160;

  /** Does the text have control chars (line breaks, tab, NUL and such)? */
  function hasControlChars(s) {
    for (let i = 0; i < s.length; i += 1) {
      const k = s.charCodeAt(i);
      if (k < 32 || k === 127) return true;
    }
    return false;
  }

  /**
   * Is the path allowed to read in the read view? First guard (the server also checks symlinks, real path and size):
   * relative path with slashes, no `.`, `..`, empty parts or hidden parts (`.env`, `.git`), no characters Windows
   * treats specially (`:` for data streams, wildcards), only `.md`, and only under the document folders (setReadFolders).
   * @returns {string|null} the error text, or null when the path is allowed
   */
  function readPathError(filePath) {
    if (typeof filePath !== 'string' || !filePath) return 'missing path';
    if (filePath.length > READ_PATH_MAX) return 'path is too long';
    if (hasControlChars(filePath)) return 'path has control chars';
    if (/^[A-Za-z]:|^[\\/]/.test(filePath)) return 'path must be relative to the project root';
    if (filePath.includes('\\')) return 'use slash /, not \\';
    if (/[:*?"<>|]/.test(filePath)) return 'path has characters that are not allowed';
    const parts = filePath.split('/');
    if (parts.some((d) => d === '' || d === '.' || d === '..'))
      return '. and .. and empty parts are not allowed in a path';
    if (parts.some((d) => d.startsWith('.'))) return 'hidden files and folders are not read';
    if (parts.some((d) => /^\s|[\s.]$/.test(d)))
      return 'a part cannot start with whitespace or end with a period or whitespace';
    if (parts.some((d) => /~\d/.test(d))) return 'short file names (8.3) are not allowed';
    if (!/\.md$/i.test(filePath)) return 'only markdown (.md) can be read';
    if (!readFolders.some((m) => filePath.startsWith(m)))
      return `only documents under ${readFolders.join(', ')}`;
    return null;
  }

  /**
   * Where a link in a document points: another document that can be read (relative to the document, or to the root with
   * a leading `/`), an anchor in the same document, a web address (shown as text, never opened from here), or something else
   * (mailto:, javascript:, files outside the allowlist), which is only shown as text.
   * @returns {{ type: 'doc', path: string, anchor: string|null } | { type: 'anchor', anchor: string } |
   *   { type: 'external', url: string } | { type: 'another' }}
   */
  function linkMeasure(from, href) {
    const h = String(href ?? '').trim();
    if (!h) return { type: 'another' };
    if (/^https?:\/\//i.test(h)) return { type: 'external', url: h };
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return { type: 'another' };
    const decode = (x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return null;
      }
    };
    const hash = h.indexOf('#');
    const chunk = hash >= 0 ? h.slice(0, hash) : h;
    const anchor = hash >= 0 ? decode(h.slice(hash + 1)) : null;
    if (!chunk) return anchor ? { type: 'anchor', anchor } : { type: 'another' };
    const pathPart = decode(chunk);
    if (pathPart == null || pathPart.includes('\\')) return { type: 'another' };
    const out = pathPart.startsWith('/')
      ? []
      : String(from ?? '')
          .split('/')
          .slice(0, -1);
    for (const d of pathPart.split('/')) {
      if (d === '' || d === '.') continue;
      if (d === '..') {
        if (!out.length) return { type: 'another' };
        out.pop();
      } else out.push(d);
    }
    const filePath = out.join('/');
    return readPathError(filePath) ? { type: 'another' } : { type: 'doc', path: filePath, anchor: anchor || null };
  }

  /**
   * Splits a line of markdown into pieces that can be drawn with textContent: text, code, bold, italic and link. No HTML
   * is interpreted: `<b>` stays as text. Images are shown as "[image: alt]".
   * @returns {Array<{ type: string, text?: string, template?: string, parts?: object[] }>}
   */
  function inlineParts(text, depth = 0) {
    const s = String(text ?? '');
    const out = [];
    let buf = '';
    const empty = () => {
      if (buf) out.push({ type: 'text', text: buf });
      buf = '';
    };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && /[\\`*_[\]()#+\-.!|<>~{}]/.test(s[i + 1])) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        let n = 1;
        while (s[i + n] === '`') n += 1;
        const badge = '`'.repeat(n);
        const j = s.indexOf(badge, i + n);
        if (j > i) {
          empty();
          out.push({ type: 'code', text: s.slice(i + n, j).replace(/^ (.*) $/, '$1') });
          i = j + n;
        } else {
          buf += badge;
          i += n;
        }
        continue;
      }
      if (c === '!' && s[i + 1] === '[') {
        const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(s.slice(i));
        if (m) {
          buf += `[image: ${m[1] || m[2]}]`;
          i += m[0].length;
          continue;
        }
      }
      if (c === '[') {
        const m = /^\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
        if (m) {
          empty();
          out.push({ type: 'link', text: cleanText(m[1]) || m[2], template: m[2] });
          i += m[0].length;
          continue;
        }
      }
      if (c === '<') {
        const m = /^<(https?:\/\/[^>\s]+)>/i.exec(s.slice(i));
        if (m) {
          empty();
          out.push({ type: 'link', text: m[1], template: m[1] });
          i += m[0].length;
          continue;
        }
      }
      if ((c === '*' || c === '_') && depth < 4) {
        const double = s[i + 1] === c;
        const badge = double ? c + c : c;
        const for_ = s[i - 1] ?? '';
        // _ in the middle of a word (snake_case) is not emphasis.
        const inWord = c === '_' && /[\p{L}\p{N}]/u.test(for_);
        const start = i + badge.length;
        const j = inWord ? -1 : s.indexOf(badge, start);
        if (j > start && !/\s/.test(s[start]) && !/\s/.test(s[j - 1])) {
          empty();
          out.push({
            type: double ? 'bold' : 'italic',
            parts: inlineParts(s.slice(start, j), depth + 1),
          });
          i = j + badge.length;
          continue;
        }
        buf += badge;
        i += badge.length;
        continue;
      }
      buf += c;
      i += 1;
    }
    empty();
    return out;
  }

  /** Only the text in a line of markdown (without the marks), for headings, anchors and screen readers. */
  function cleanText(text) {
    const flat = (parts) => parts.map((d) => (d.parts ? flat(d.parts) : (d.text ?? ''))).join('');
    return flat(inlineParts(text));
  }

  const POINT = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  /** The cells in a table row (`|` with a leading backslash is part of the text). */
  function tableCells(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const out = [];
    let buf = '';
    let code = false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') {
        buf += '|';
        i += 1;
      } else if (c === '`') {
        code = !code;
        buf += c;
      } else if (c === '|' && !code) {
        out.push(buf.trim());
        buf = '';
      } else buf += c;
    }
    out.push(buf.trim());
    return out;
  }

  /**
   * Splits a markdown document into blocks that the read view draws with textContent (never innerHTML): heading,
   * paragraph, list (with a level per point), code, quote, table and divider. The front matter between `---` lines at the start
   * of the file is shown as code. HTML in the document stays as text.
   * @returns {object[]}
   */
  function markdownBlocks(text) {
    const lines = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    const out = [];
    let paragraph = [];
    const end = () => {
      if (paragraph.length) out.push({ type: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    };
    let i = 0;
    if (lines[0] === '---') {
      const j = lines.indexOf('---', 1);
      if (j > 0 && j < 60) {
        out.push({ type: 'code', language: 'yaml', text: lines.slice(1, j).join('\n') });
        i = j + 1;
      }
    }
    while (i < lines.length) {
      const l = lines[i];
      const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(l);
      if (fence) {
        end();
        const badge = fence[1];
        const code = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(badge)) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push({ type: 'code', language: fence[2] || null, text: code.join('\n') });
        continue;
      }
      if (!l.trim()) {
        end();
        i += 1;
        continue;
      }
      const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(l);
      if (h) {
        end();
        out.push({ type: 'heading', level: h[1].length, text: h[2] });
        i += 1;
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) {
        end();
        out.push({ type: 'line' });
        i += 1;
        continue;
      }
      if (
        l.includes('|') &&
        i + 1 < lines.length &&
        TABLE_SEPARATOR.test(lines[i + 1]) &&
        lines[i + 1].includes('-')
      ) {
        end();
        const header = tableCells(l);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(tableCells(lines[i]));
          i += 1;
        }
        out.push({ type: 'table', header, rows });
        continue;
      }
      if (/^\s{0,3}>/.test(l)) {
        end();
        const s = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          s.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        out.push({ type: 'quote', text: s.filter((x) => x.trim()).join(' ') });
        continue;
      }
      const point = POINT.exec(l);
      if (point) {
        end();
        const points = [];
        while (i < lines.length) {
          const m = POINT.exec(lines[i]);
          if (m) {
            const indent = m[1].replace(/\t/g, '    ').length;
            points.push({
              level: Math.min(4, Math.floor(indent / 2)),
              sorted: /\d/.test(m[2]),
              nr: /\d/.test(m[2]) ? parseInt(m[2], 10) : null,
              text: m[3],
            });
            i += 1;
          } else if (lines[i].trim() && /^\s/.test(lines[i]) && points.length) {
            points[points.length - 1].text += ` ${lines[i].trim()}`;
            i += 1;
          } else break;
        }
        out.push({ type: 'list', points });
        continue;
      }
      paragraph.push(l.trim());
      i += 1;
    }
    end();
    return out;
  }

  /** The anchor as GitHub makes it from a heading (lowercase, hyphen for whitespace). */
  function slug(text) {
    return String(text ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s/g, '-');
  }

  /**
   * The heading an anchor points to (like queuePlan.anchorText: "§ 3.4" matches "### 3.4 Maturity …"; otherwise a
   * heading that contains the anchor, or with the same slug as a `#link`). -1 when none matches.
   */
  function anchorIndex(blocks, anchor) {
    const a = String(anchor ?? '').trim();
    if (!a) return -1;
    const nr = a.replace(/^§\s*/, '');
    const low = a.toLowerCase();
    const slugA = slug(a);
    return (blocks ?? []).findIndex((b) => {
      if (b?.type !== 'heading') return false;
      const t = cleanText(b.text).trim();
      return (
        t.includes(a) ||
        t.toLowerCase().includes(low) ||
        t === nr ||
        t.startsWith(`${nr} `) ||
        t.startsWith(`${nr}. `) ||
        slug(t) === slugA
      );
    });
  }

  /**
   * The groups in the Unregistered box: one per document folder (the longest first, so a subfolder wins over the folder
   * it sits in), plus "Other". The first prefix that fits wins.
   * @returns {{ id: string, prefix: string, text: string }[]}
   */
  function unregisteredGroupsDef(folders = readFolders) {
    return [
      ...[...folders]
        .sort((a, b) => b.length - a.length || a.localeCompare(b))
        .map((m) => ({ id: m.replace(/\/$/, ''), prefix: m, text: m })),
      { id: 'other', prefix: '', text: 'Other' },
    ];
  }

  /**
   * The unregistered documents (from `plan check`) grouped by folder, with counts. Empty groups are not included.
   * @returns {Array<{ id: string, text: string, paths: string[] }>}
   */
  function unregisteredGroups(paths, folders = readFolders) {
    const def = unregisteredGroupsDef(folders);
    const out = def.map((g) => ({ id: g.id, text: g.text, paths: [] }));
    for (const s of [...new Set((paths ?? []).filter((x) => typeof x === 'string'))].sort()) {
      const i = def.findIndex((g) => s.startsWith(g.prefix));
      out[i].paths.push(s);
    }
    return out.filter((g) => g.paths.length);
  }

  /**
   * Suggested id and title for a new plan entry from the file name ("docs/export-draft-2026-10-10.md" gives
   * "Export draft" and PL-EXPORT-DRAFT-1). The date and other tails are kept out of the title, and out of the id beyond the first four
   * words. The id is available (not in `used`).
   */
  function entrySuggestion(filePath, used) {
    const busy = used instanceof Set ? used : new Set(used ?? []);
    const file = String(filePath ?? '')
      .split('/')
      .pop()
      .replace(/\.md$/i, '')
      .replace(/[-_]?\d{4}-\d\d-\d\d$/, '');
    const word = file.split(/[-_\s.]+/).filter(Boolean);
    const title = word.length
      ? `${word[0][0].toUpperCase()}${word[0].slice(1)} ${word.slice(1).join(' ')}`.trim()
      : 'New plan';
    const idPart =
      word
        .slice(0, 4)
        .join('-')
        .toUpperCase()
        .replace(/[^A-Z0-9\u00C6\u00D8\u00C5-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'PLAN';
    let n = 1;
    while (busy.has(`PL-${idPart}-${n}`)) n += 1;
    return { id: `PL-${idPart}-${n}`, title: title.slice(0, TITLE_MAX) };
  }

  /**
   * The new plan entry from the form in the Unregistered box ("New entry"). The owner creates it (`--set-by owner`), so
   * the priority is the owner's choice; the maturity is always idea, and the document is the only source.
   * @param {{ id?: string, title?: string, project?: string, priority?: string, category?: string,
   *   reason?: string }} form
   * @returns {{ entry: object|null, error: string[] }}
   */
  function newEntryFromForm(form, filePath) {
    const error = [];
    const s = form && typeof form === 'object' ? form : {};
    const id = String(s.id ?? '').trim();
    const title = String(s.title ?? '').trim();
    const project = String(s.project ?? '').trim();
    const priority = String(s.priority ?? 'owner');
    const reason = String(s.reason ?? '').trim();
    if (!NEW_ENTRY_ID.test(id))
      error.push('id must look like PL-NAME-1 (capital letters, digits and hyphens)');
    if (!title) error.push('title missing');
    else if (title.length > TITLE_MAX) error.push(`the title is over ${TITLE_MAX} characters`);
    if (hasControlChars(title)) error.push('the title has control chars');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) error.push('select a project');
    if (!['now', 'owner', 'later'].includes(priority))
      error.push('priority must be Now, Owner or Later');
    const category = priority === 'now' ? String(s.category ?? '') : '';
    if (priority === 'now' && !Object.hasOwn(CATEGORY, category))
      error.push('Now needs a category (security, before prod or important)');
    if (reason.length > REASON_MAX) error.push(`the reason is over ${REASON_MAX} characters`);
    if (hasControlChars(reason)) error.push('the reason has control chars');
    const sf = readPathError(filePath);
    if (sf) error.push(`the source: ${sf}`);
    if (error.length) return { entry: null, error };
    return {
      entry: {
        id,
        title,
        project,
        priority,
        ...(priority === 'now' ? { now_category: [category] } : {}),
        ...(reason ? { priority_reason: reason } : {}),
        maturity: 'idea',
        sources: [{ path: filePath }],
      },
      error: [],
    };
  }

  /** Common tail for the write calls from the box: owner choice, the board as sender, preview or version. */
  function writeTail({ dry, expect: expectValue } = {}) {
    return [
      '--json',
      '--set-by',
      'owner',
      '--by',
      'theBoard',
      ...(dry ? ['--dry'] : []),
      ...(!dry && expectValue ? ['--expect-changed', String(expectValue)] : []),
    ];
  }

  /** The arguments to `queue.mjs plan new` (the entry sits in a temporary file). */
  function newEntryArgs(file, option = {}) {
    return ['plan', 'new', '--file', String(file), ...writeTail(option)];
  }

  /**
   * The source list after "Add as source": the old sources unchanged, and the document last (with an anchor when one is given).
   * `entry` is the entry as it is in plans.json.
   * @returns {{ sources: object[]|null, error: string[] }}
   */
  function sourceBonus(entry, filePath, anchor) {
    const error = [];
    if (!entry || typeof entry !== 'object') return { sources: null, error: ['unknown plan entry'] };
    const sf = readPathError(filePath);
    if (sf) error.push(`the source: ${sf}`);
    const a = String(anchor ?? '').trim();
    if (a.length > ANCHOR_MAX) error.push(`the anchor is over ${ANCHOR_MAX} characters`);
    if (hasControlChars(a)) error.push('the anchor has control chars');
    const oldOnes = Array.isArray(entry.sources) ? entry.sources : [];
    if (oldOnes.some((k) => k?.path === filePath && String(k?.anchor ?? '') === a))
      error.push(`${entry.id ?? 'entry'} already has this source`);
    if (error.length) return { sources: null, error };
    return {
      sources: [...oldOnes.map((k) => ({ ...k })), { path: filePath, ...(a ? { anchor: a } : {}) }],
      error: [],
    };
  }

  /** The arguments to `queue.mjs plan edit <id> --set '{"sources":[…]}'` (the whole list, the old sources included). */
  function sourceArgs(id, sources, option = {}) {
    return ['plan', 'edit', String(id), '--set', JSON.stringify({ sources }), ...writeTail(option)];
  }

  // ---- the Legal, Decisions and Launch surfaces ---------------------------------
  //
  // Same three-cell pattern as the plan entries and documents: facets with counts on the left, a foldable list split into
  // groups in the middle and the detail panel on the right. Legal has the facets status, blocks and module; Decisions has
  // status, type, deadline, how much is blocked, and module. Closed points and answered questions are hidden until
  // the status filter includes them (like Drop for entries). Launch is one overview without its own filters.

  const JB_SURFACES = ['jur', 'decision', 'launch'];
  /** Status of a legal point with symbol (color is never the only carrier). The order is the work order. */
  const LEGAL_STATUS = {
    open: { text: 'Open', symbol: '○' },
    'ai-assessed': { text: 'AI-assessed', symbol: '◐' },
    'to-lawyer': { text: 'To lawyer', symbol: '§' },
    resolved: { text: 'Resolved', symbol: '✓' },
    'not-relevant': { text: 'Not relevant', symbol: '·' },
  };
  /** What a point blocks, the most severe first. */
  const LEGAL_BLOCK = {
    prod: { text: 'Prod', symbol: '■' },
    packing: { text: 'Packing', symbol: '▲' },
    nothing: { text: 'Nothing', symbol: '·' },
  };
  const DPIA_TEXT = {
    needed: 'DPIA needed',
    exists: 'DPIA exists',
    'not-relevant': 'DPIA not relevant',
    unassessed: 'DPIA not assessed',
  };
  const DEC_STATUS = { open: 'Open', answered: 'Answered' };
  /**
   * The types in the queue (queueLogic.QUESTION_TYPES) by the names in the one word table for owner questions
   * (lib/queueDecisions.js QUESTION_WORDS, B24), so Plans and the Decisions room call a type the same.
   */
  const DECISION_RULES =
    typeof module === 'object' && module.exports ? require('./queueDecisions.js') : globalThis.QueueDecisions;
  const DEC_TYPE = Object.fromEntries(
    Object.entries(DECISION_RULES?.QUESTION_WORDS ?? {}).map(([type, w]) => [type, w.name]),
  );
  const DEC_AMOUNT = {
    many: 'Two or more plan entries',
    one: 'One plan entry',
    tasks: 'Only queue tasks',
    none: 'Nothing',
  };
  /** This many open decisions sit in the group "Answer this first". */
  const DEC_FIRST = 5;
  const LEGAL_POINT = /^[A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5][A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5._-]{0,39}$/;

  function decAmount(x) {
    const n = (x.blocked_entries ?? []).length;
    if (n >= 2) return 'many';
    if (n === 1) return 'one';
    return (x.tasks ?? []).length ? 'tasks' : 'none';
  }

  const LEGAL_FACETS = [
    { id: 'status', title: 'Status', param: 'jst', values: LEGAL_STATUS, by: (x) => [x.status] },
    {
      id: 'block',
      title: 'Blocks',
      param: 'jbl',
      values: LEGAL_BLOCK,
      by: (x) => [x.blocks],
    },
    {
      id: 'module',
      title: 'Area',
      param: 'jmod',
      values: null,
      by: (x) => [x.module ?? WITHOUT_MODULE],
    },
  ];
  const DEC_FACETS = [
    {
      id: 'status',
      title: 'Status',
      param: 'bst',
      values: DEC_STATUS,
      by: (x) => [x.resolved ? 'answered' : 'open'],
    },
    { id: 'type', title: 'Type', param: 'bty', values: DEC_TYPE, by: (x) => [x.type] },
    {
      id: 'deadline',
      title: 'Deadline',
      param: 'bfr',
      values: DEADLINE,
      by: (x, now) => [deadlineBand(x.deadline, now)],
    },
    {
      id: 'block',
      title: 'Blocks',
      param: 'bbl',
      values: DEC_AMOUNT,
      by: (x) => [decAmount(x)],
    },
    {
      id: 'module',
      title: 'Area',
      param: 'bmod',
      values: null,
      by: (x) => (x.modules?.length ? x.modules : [WITHOUT_MODULE]),
    },
  ];

  const jbFacets = (surface) => (surface === 'jur' ? LEGAL_FACETS : DEC_FACETS);

  /** Empty filters for the surface (one list per facet). */
  function emptyJbFilter(surface) {
    const f = {};
    for (const x of jbFacets(surface)) f[x.id] = [];
    return f;
  }

  /** The filters, the search and the selection for Legal and Decisions from the url (invalid values are dropped silently). */
  function jbReadUrl(q) {
    const read = (surface) => {
      const f = emptyJbFilter(surface);
      for (const x of jbFacets(surface)) {
        const out = [];
        for (const chunk of (q.get(x.param) ?? '').split(',')) {
          const v = chunk.trim();
          if (validValue(x, v) && !out.includes(v)) out.push(v);
        }
        f[x.id] = out.slice(0, 40);
      }
      return f;
    };
    const jur = q.get('jur');
    const sp = q.get('sp');
    return {
      jfilter: read('jur'),
      jsearch: String(q.get('jq') ?? '').slice(0, 120),
      jur: jur && LEGAL_POINT.test(jur) ? jur : null,
      bfilter: read('decision'),
      bsearch: String(q.get('bq') ?? '').slice(0, 120),
      sp:
        typeof sp === 'string' && sp && sp.length <= 120 && !/[\u0000-\u001f\u007f]/.test(sp)
          ? sp
          : null,
    };
  }

  /** Writes the filters, the search and the selection for Legal and Decisions into the search part. */
  function jbWriteUrl(q, t) {
    for (const [surface, key] of [
      ['jur', 'jfilter'],
      ['decision', 'bfilter'],
    ])
      for (const x of jbFacets(surface)) {
        const v = t?.[key]?.[x.id] ?? [];
        if (v.length) q.set(x.param, v.join(','));
      }
    if (t?.jsearch) q.set('jq', t.jsearch);
    if (t?.jur) q.set('jur', t.jur);
    if (t?.bsearch) q.set('bq', t.bsearch);
    if (t?.sp) q.set('sp', t.sp);
  }

  function jbSearchMatch(surface, x, search) {
    const s = String(search ?? '')
      .trim()
      .toLowerCase();
    if (!s) return true;
    const field =
      surface === 'jur'
        ? [
            x.id,
            x.question,
            x.entry,
            x.entry_title,
            x.project,
            x.ai_assessment,
            ...(x.affects ?? []),
          ]
        : [
            x.id,
            x.text,
            x.recommendation,
            x.source,
            x.answer,
            ...(x.entries ?? []),
            ...(x.projects ?? []),
          ];
    return field.filter(Boolean).join('\n').toLowerCase().includes(s);
  }

  /** Is the element hidden by default (closed point, answered question) with these filters? */
  function jbHidden(surface, x, filter, except) {
    if (except === 'status') return false;
    const st = filter?.status ?? [];
    if (surface === 'jur') return !LEGAL_OPEN.has(x.status) && !st.includes(x.status);
    return x.resolved === true && !st.includes('answered');
  }

  /** The elements on the surface that fit the filters and the search. `except` is a facet that is not counted. */
  function jbFilter(
    surface,
    list,
    filter = {},
    search = '',
    { now = new Date(), except = null } = {},
  ) {
    return (list ?? []).filter((x) => {
      if (jbHidden(surface, x, filter, except)) return false;
      for (const f of jbFacets(surface)) {
        if (f.id === except) continue;
        const selected = filter?.[f.id];
        if (selected?.length && !f.by(x, now).some((v) => selected.includes(v))) return false;
      }
      return jbSearchMatch(surface, x, search);
    });
  }

  /** The facets for the surface with match counts per value (same rule as facetNumber). */
  function jbFacetNumber(surface, list, filter, search, { now = new Date(), modules = [] } = {}) {
    return jbFacets(surface).map((f) => {
      const basis = jbFilter(surface, list, filter, search, { now, except: f.id });
      const counts = new Map();
      for (const x of basis)
        for (const v of new Set(f.by(x, now))) counts.set(v, (counts.get(v) ?? 0) + 1);
      const name =
        f.id === 'module'
          ? new Map([...modules.map((m) => [m.oid, m.title]), [WITHOUT_MODULE, 'Without area']])
          : new Map(Object.entries(f.values).map(([v, t]) => [v, valueText(t)]));
      const selected = filter?.[f.id] ?? [];
      const option = [...new Set([...name.keys(), ...counts.keys(), ...selected])]
        .filter((v) => (counts.get(v) ?? 0) > 0 || selected.includes(v))
        .map((v) => ({
          val: v,
          text: name.get(v) ?? v,
          symbol: f.values?.[v]?.symbol ?? null,
          count: counts.get(v) ?? 0,
          selected: selected.includes(v),
        }));
      return { id: f.id, title: f.title, option };
    });
  }

  /** The chips above the list: one per active filter. */
  function jbChips(surface, filter, { modules = [] } = {}) {
    const modName = new Map(modules.map((m) => [m.oid, m.title]));
    const out = [];
    for (const f of jbFacets(surface))
      for (const v of filter?.[f.id] ?? []) {
        const text =
          f.id === 'module'
            ? v === WITHOUT_MODULE
              ? 'Without area'
              : (modName.get(v) ?? v)
            : valueText(f.values[v] ?? v);
        out.push({ facet: f.id, val: v, text: `${f.title}: ${text}` });
      }
    return out;
  }

  function countJbFilters(surface, filter) {
    return jbFacets(surface).reduce((n, f) => n + (filter?.[f.id]?.length ?? 0), 0);
  }

  /** All the elements on the surface (Decisions: open in the sorting from queuePlan, then the answered ones). */
  function jbList(surface, data) {
    if (surface === 'jur') return data?.jur_points ?? [];
    if (surface === 'decision')
      return [...(data?.decisions?.openOnes ?? []), ...(data?.decisions?.answered ?? [])];
    return [];
  }

  /**
   * The groups in the middle. Legal: one group per status in work order. Decisions: "Answer this first" (the
   * DEC_FIRST top open ones), "Other open" and "Answered" (the history, newest first).
   * @returns {{ id: string, title: string, elements: object[] }[]}
   */
  function jbGroups(surface, match) {
    if (surface === 'jur')
      return Object.keys(LEGAL_STATUS)
        .map((s) => ({
          id: s,
          title: LEGAL_STATUS[s].text,
          symbol: LEGAL_STATUS[s].symbol,
          elements: (match ?? []).filter((x) => x.status === s),
        }))
        .filter((g) => g.elements.length);
    const openOnes = (match ?? []).filter((x) => !x.resolved);
    const out = [
      { id: 'first', title: 'Answer this first', elements: openOnes.slice(0, DEC_FIRST) },
      { id: 'openOnes', title: 'Other open', elements: openOnes.slice(DEC_FIRST) },
      { id: 'answered', title: 'Answered', elements: (match ?? []).filter((x) => x.resolved) },
    ];
    return out.filter((g) => g.elements.length);
  }

  /** The module and project titles above a point or question (only titles, for the copy line). */
  function jbOver(modName, project, data) {
    const m = (data?.modules ?? []).find((x) => x.oid === modName);
    const p = project ? data?.projects?.[project] : null;
    return [m?.title ?? null, p ? (p.summary ?? project) : null];
  }

  /** Copy line for a legal point: /plans jur J-X (Module › Project › PL-X). Instruction: */
  function legalLine(x, data) {
    return copyLine('jur', x.id, [...jbOver(x.module, x.project, data), x.entry]);
  }

  /** Copy line for an owner question: /plans owner SP-X (Module › Project › PL-X). Instruction: */
  function ownerLine(x, data) {
    const entry = (x.entries ?? [])[0] ?? null;
    const pd = entry ? (data?.entries ?? []).find((p) => p.id === entry) : null;
    return copyLine('owner', x.id, [
      ...jbOver(
        pd?.module ?? x.modules?.[0] ?? null,
        pd?.project ?? x.projects?.[0] ?? null,
        data,
      ),
      entry,
    ]);
  }

  /** Path for the surfaces: Plans › Legal › Status › point, Plans › Decisions › id, Plans › Launch. */
  function jbBreadcrumbs(t, data) {
    const surface = t.surface;
    const name = SURFACES.find((x) => x.id === surface)?.text ?? surface;
    const out = [
      {
        level: 'room',
        sortKey: null,
        text: 'Plans',
        copy: null,
        filter: null,
        entry: null,
        state: { surface: 'entries' },
      },
      {
        level: 'surface',
        sortKey: surface,
        text: name,
        copy: null,
        filter: null,
        entry: null,
        state:
          surface === 'jur'
            ? { surface, jfilter: emptyJbFilter('jur'), jsearch: '', jur: null }
            : surface === 'decision'
              ? { surface, bfilter: emptyJbFilter('decision'), bsearch: '', sp: null }
              : { surface },
      },
    ];
    if (surface === 'jur') {
      const x = t.jur ? (data?.jur_points ?? []).find((p) => p.id === t.jur) : null;
      const st = x ? x.status : t.jfilter?.status?.length === 1 ? t.jfilter.status[0] : null;
      if (st && LEGAL_STATUS[st]) {
        const f = emptyJbFilter('jur');
        f.status = [st];
        out.push({
          level: 'status',
          sortKey: st,
          text: LEGAL_STATUS[st].text,
          copy: null,
          filter: null,
          entry: null,
          state: { surface, jfilter: f, jur: null },
        });
      }
      if (x)
        out.push({
          level: 'point',
          sortKey: x.id,
          text: x.id,
          copy: legalLine(x, data),
          filter: null,
          entry: null,
          state: { surface, jur: x.id },
        });
    }
    if (surface === 'decision' && t.sp) {
      const x = jbList('decision', data).find((s) => s.id === t.sp);
      if (x)
        out.push({
          level: 'question',
          sortKey: x.id,
          text: x.id,
          copy: ownerLine(x, data),
          filter: null,
          entry: null,
          state: { surface, sp: x.id },
        });
    }
    return out;
  }

  /**
   * The data for the three surfaces (the server calls this from plansData): the legal points, privacy per module,
   * owner decisions and the launch overview, computed by the pure functions in queuePlan.js.
   */
  function jbData(reg, queue, { now = new Date(), P } = {}) {
    if (!P?.legalPoints) return {};
    return {
      jur_points: P.legalPoints(reg, queue, { now }),
      privacy: P.privacyPerModule(reg, queue),
      decisions: P.ownerDecisions(reg, queue, { now }),
      launch: P.launchOverview(reg, queue, { now }),
    };
  }

  /** The count the surface picker shows for every surface (Legal: open points; Decisions: open; Launch: remaining). */
  function surfaceCount(d) {
    return {
      // the overview shows how many are waiting on you (owner questions and legal points).
      overview: waitingOnYou(d).total,
      // the Roadmap shows the plans that are not dropped.
      roadmap: (d?.entries ?? []).filter((p) => p.priority !== 'drop').length,
      entries: (d?.entries ?? []).length,
      doc: (d?.documents ?? []).length,
      jur: (d?.jur_points ?? []).filter((x) => LEGAL_OPEN.has(x.status)).length,
      decision: (d?.decisions?.openOnes ?? []).length,
      launch: d?.launch?.remaining ?? 0,
    };
  }

  /** The body of POST /api/action when the owner answers a question (same cell as "Waiting on you"). */
  function resolveBody(sp, answer, { confirm = false } = {}) {
    const s = String(answer ?? '').trim();
    if (!s) return { error: 'Write an answer first.' };
    if (s.length > 4000) return { error: 'The answer is over 4000 characters.' };
    return {
      body: { type: 'resolve', sp: String(sp), answer: s, ...(confirm ? { confirm: true } : {}) },
    };
  }

  // ---- The overview page, keyboard, Ctrl+K, multi-select, change in the row and "Working now" ---------------------
  // The rules here are pure; plans/overview.js and plans/work.js draw, and queue-board.mjs
  // runs the calls (always via queue.mjs, with the same lock, --expect-changed and changelog as the queue).

  /** The maturities the owner sets (like queuePlan.MATURITY_MANUAL); in-queue, partial, built and verified are computed. */
  const MATURITY_MANUAL = ['idea', 'investigated', 'planned', 'ready'];
  /**
   * The maturity bar on the module card: four groups, each with text, symbol and number (color is never the only
   * carrier). The symbols differ from the priority symbols, so a segment reads on its own with the shared legend (B32).
   */
  const MATURITY_GROUPS = [
    { id: 'early', text: 'Idea and investigated', symbol: '◌', by: ['idea', 'investigated'] },
    { id: 'planned', text: 'Planned and ready', symbol: '◔', by: ['planned', 'ready'] },
    { id: 'work', text: 'In queue and partially built', symbol: '◑', by: ['in-queue', 'partial'] },
    { id: 'built', text: 'Built and verified', symbol: '✓', by: ['built', 'verified'] },
  ];
  /** The priorities on the module card, in bar order (Drop is counted apart, as "N dropped"). */
  const AREA_PRIORITIES = ['now', 'owner', 'later'];
  /**
   * The one shared legend above the area cards (B32, PL1): every symbol with its word, once for the page, instead of
   * a running legend under every bar.
   */
  const AREA_LEGEND = Object.freeze({
    priority: AREA_PRIORITIES.map((k) => ({ id: k, text: PRIORITY[k].text, symbol: PRIORITY[k].symbol })),
    maturity: MATURITY_GROUPS.map((g) => ({ id: g.id, text: g.text, symbol: g.symbol })),
  });
  /** Keys for priority: 1 Now, 2 Later, 3 Owner, 4 Drop. */
  const PRIORITY_KEY = { 1: 'now', 2: 'later', 3: 'owner', 4: 'drop' };
  /** "Waiting on you" shows the five that block the most. */
  const WAITING_MAX = 5;
  /** A legal point with a deadline within this many days counts as urgent (like DECISION_URGENT_DAYS). */
  const LEGAL_URGENT_DAYS = 14;
  /** How many changes and new entries "Recent" shows. */
  const RECENT_MAX = 8;
  /** At most this many entries in one multi-select. */
  const BULK_MAX = 100;
  /** The command palette (Ctrl+K): at most this many matches, and this many recently used are remembered. */
  const PALETTE_MAX = 30;
  const PALETTE_RECENT = 8;
  /** The actions in the multi-select: priority, project, maturity and merging. Copying happens in the browser. */
  const BULK_ACTIONS = ['priority', 'project', 'maturity', 'combine'];
  /** The actions the command palette can run (in addition to jumping to a module, project and entry). */
  const PALETTE_ACTIONS = [
    { id: 'copy-selected', text: 'Copy start line for all selected' },
    { id: 'prepare', text: 'Prepare for queue (selected entry)' },
    { id: 'overview', text: 'Go to the overview' },
    { id: 'list', text: 'Show the list of plan entries' },
    { id: 'map', text: 'Show the priority map' },
    { id: 'reset', text: 'Reset the filters' },
    { id: 'empty-option', text: 'Clear the multi-select' },
  ];

  /**
   * The module cards on the overview: one per module (in the register's order, also modules without entries), plus
   * "Without module" when any entries lack a module. Dropped entries are counted only in `dropped`; the rest in the count, the bars,
   * the build rate and the three notice numbers (open owner questions and open legal points counted uniquely per module).
   */
  function moduleSummary(d) {
    const per = new Map();
    for (const m of d?.modules ?? []) per.set(m.oid, []);
    for (const p of d?.entries ?? []) {
      const m = p.module ?? WITHOUT_MODULE;
      if (!per.has(m)) per.set(m, []);
      per.get(m).push(p);
    }
    const titles = new Map((d?.modules ?? []).map((m) => [m.oid, m.title]));
    const out = [];
    for (const [oid, all] of per) {
      const activeOnes = all.filter((p) => p.priority !== 'drop');
      const pri = (k) => activeOnes.filter((p) => p.priority === k).length;
      const ownerQuestions = new Set();
      for (const p of activeOnes)
        for (const s of p.ownerQuestions ?? []) if (s && !s.resolved) ownerQuestions.add(s.id);
      const f = progress(activeOnes);
      out.push({
        oid,
        title: oid === WITHOUT_MODULE ? 'Without area' : (titles.get(oid) ?? oid),
        count: activeOnes.length,
        dropped: all.length - activeOnes.length,
        priority: AREA_PRIORITIES.map((k) => ({
          id: k,
          text: PRIORITY[k].text,
          symbol: PRIORITY[k].symbol,
          count: pri(k),
        })),
        maturity: MATURITY_GROUPS.map((g) => ({
          id: g.id,
          text: g.text,
          symbol: g.symbol,
          count: activeOnes.filter((p) => g.by.includes(p.maturity)).length,
        })),
        built: f.built,
        share: f.share,
        ownerQuestions: ownerQuestions.size,
        legal: activeOnes.reduce((n, p) => n + (Number(p.legal_open) || 0), 0),
        stale: activeOnes.filter((p) => p.stale).length,
        active: activeOnes.filter((p) => p.active).length,
      });
    }
    return out;
  }

  /**
   * The accessible name of an area card (B32): the card face shows symbols and counts, so the name says the words.
   * Every priority and maturity group is named with its count (also 0), then how much is built and what a click does.
   * @param {ReturnType<typeof moduleSummary>[number]} k
   */
  function areaCardLabel(k) {
    const list = (parts) => parts.map((x) => `${x.text} ${x.count}`).join(', ');
    const pst = Math.round((k.share ?? 0) * 100);
    return (
      `${k.title}: ${k.count} ${k.count === 1 ? 'entry' : 'entries'}${k.dropped ? `, ${k.dropped} dropped` : ''}. ` +
      `Priority: ${list(k.priority)}. Maturity: ${list(k.maturity)}. ` +
      `Built ${k.built} of ${k.count} (${pst} %). Open the list filtered on the area.`
    );
  }

  /**
   * "Waiting on you": the open owner questions (from ownerDecisions) and the open legal points, those that
   * block the most on top. Urgent ones (deadline within 14 days or overdue) go first, earliest deadline first; then the weight:
   * blocked plan entries (×10), queue tasks that are waiting, and +5 for a legal point that blocks prod.
   * @returns {{ points: { type: 'owner'|'jur', id, text, blocks, tasks, urgent, deadline, entry: string|null }[],
   *   total: number }}
   */
  function waitingOnYou(d, { max = WAITING_MAX } = {}) {
    const entries = new Map((d?.entries ?? []).map((p) => [p.id, p]));
    const out = [];
    for (const b of d?.decisions?.openOnes ?? [])
      out.push({
        type: 'owner',
        id: String(b.id),
        text: b.text ?? String(b.id),
        blocks: (b.blocked_entries ?? []).length,
        tasks: (b.tasks ?? []).length,
        urgent: b.urgent === true,
        deadline: b.deadline ?? null,
        entry: (b.entries ?? [])[0] ?? null,
        hinders: null,
      });
    for (const j of d?.jur_points ?? []) {
      if (!(j.open ?? LEGAL_OPEN.has(j.status))) continue;
      const p = entries.get(j.entry);
      if (!p || p.priority === 'drop') continue;
      out.push({
        type: 'jur',
        id: String(j.id),
        text: j.question || String(j.id),
        blocks: 1 + (p.blocks ?? []).length,
        tasks: 0,
        urgent: j.deadline_days != null && j.deadline_days <= LEGAL_URGENT_DAYS,
        deadline: j.deadline ?? null,
        entry: j.entry,
        hinders: j.blocks ?? null,
      });
    }
    const weight = (x) => x.blocks * 10 + x.tasks + (x.hinders === 'prod' ? 5 : 0);
    out.sort(
      (a, b) =>
        Number(b.urgent) - Number(a.urgent) ||
        (a.urgent ? String(a.deadline ?? '9999').localeCompare(String(b.deadline ?? '9999')) : 0) ||
        weight(b) - weight(a) ||
        a.id.localeCompare(b.id, 'en'),
    );
    return { points: out.slice(0, max), total: out.length };
  }

  /**
   * How fast Now grows: Now entries that came into Now in the last `days` days (new entry with priority now, or
   * a change of priority to now in the changelog), with the tracks they need (sizeTrack). The changelog keeps
   * only the last 50 writes, so the number is a minimum.
   * @returns {{ entries: number, track: number, per_week: number, ids: string[] }}
   */
  function nowAccess(reg, { now = new Date(), days = 28, sizeTrack = {} } = {}) {
    const from = new Date(now).getTime() - days * 86400000;
    const input = new Set();
    for (const h of reg?.changelog ?? []) {
      const t = Date.parse(h?.at);
      if (!Number.isFinite(t) || t < from || h?.undone) continue;
      for (const e of h?.changes ?? []) {
        if (!e?.id || (e.collection && e.collection !== 'entries')) continue;
        const toNow = e.field === 'priority' && e.after === 'now' && e.before !== 'now';
        const newNow = e.field === '*' && e.before == null && e.after?.priority === 'now';
        if (toNow || newNow) input.add(e.id);
      }
    }
    for (const p of reg?.entries ?? []) {
      const t = Date.parse(p?.created);
      if (p?.priority === 'now' && Number.isFinite(t) && t >= from) input.add(p.id);
    }
    const ids = [];
    let track = 0;
    for (const p of reg?.entries ?? [])
      if (p.priority === 'now' && input.has(p.id)) {
        ids.push(p.id);
        track += Number(sizeTrack[p.size]) || 0;
      }
    return { entries: ids.length, track, per_week: Math.round((track / (days / 7)) * 10) / 10, ids };
  }

  /** A decimal number with one decimal place. */
  const comma = (x) => String(Math.round(x * 10) / 10);

  /**
   * The capacity in Now: the text from queuePlan.capacity, and a notice when Now has gained more tracks per week
   * than the queue gets done per week (or the queue has not completed anything, while Now grows).
   * @param {{ text: string, per_week: number|null }} ch queuePlan.capacity
   * @param {{ track: number, per_week: number, entries: number }} access nowAccess
   */
  function capacityWarning(ch, access, { days = 28 } = {}) {
    if (!ch || !access || !access.track) return { notice: false, warning_text: null };
    const out = ch.per_week ?? 0;
    if (access.per_week <= out) return { notice: false, warning_text: null };
    return {
      notice: true,
      warning_text:
        `Now grows faster than the queue empties: about ${comma(access.per_week)} tracks per week into Now in the last ` +
        `${days} days (${access.entries} entries), against ${comma(out)} finished queue tasks per week.`,
    };
  }

  /** What the last plan session did: the last writes in the changelog, newest first, with the entries they touched. */
  function recentChanged(reg, { max = RECENT_MAX } = {}) {
    return (reg?.changelog ?? [])
      .slice(-max)
      .reverse()
      .map((h) => ({
        nr: h.nr,
        at: h.at ?? null,
        by: h.by ?? null,
        action: h.action ?? null,
        undone: !!h.undone,
        ids: [...new Set((h.changes ?? []).map((e) => e?.id).filter(Boolean))].slice(0, 12),
      }));
  }

  /** Recently registered entries: by `created`, newest first. */
  function recentRegistered(reg, { max = RECENT_MAX } = {}) {
    return (reg?.entries ?? [])
      .filter((p) => Number.isFinite(Date.parse(p?.created)))
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
      .slice(0, max)
      .map((p) => ({ id: p.id, title: p.title ?? p.id, at: p.created }));
  }

  /** "Working now": entries with a live marker, newest pulse first. */
  function workingNow(d) {
    return (d?.entries ?? [])
      .filter((p) => p.active)
      .map((p) => ({ id: p.id, title: p.title, at: p.active.at ?? null, by: p.active.by ?? null }))
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  }

  /**
   * Live update: entries that are new or have gained a newer record in the changelog since the previous data,
   * and that were not changed by the board itself (they are marked "changed by session"). The first fetch gives no marking.
   * @returns {{ id: string, by: string|null, new: boolean }[]}
   */
  function changedEntries(old, fresh) {
    if (!Array.isArray(old?.entries) || !Array.isArray(fresh?.entries)) return [];
    const previous = new Map(old.entries.map((p) => [p.id, p]));
    const out = [];
    for (const p of fresh.entries) {
      const g = previous.get(p.id);
      const h = p.history?.[0] ?? null;
      if (!g) out.push({ id: p.id, by: h?.by ?? null, new: true });
      else {
        const gh = g.history?.[0] ?? null;
        if (h && (!gh || Number(h.nr) > Number(gh.nr)))
          out.push({ id: p.id, by: h.by ?? null, new: false });
      }
    }
    return out.filter((x) => x.by !== 'theBoard');
  }

  /**
   * The limits of quick capture ("+ New plan", P6), one set for the form, the server and the CLI (lib/planInbox.js
   * reads them from here): the title is a heading; the text has a soft limit the form shows and a hard one it refuses.
   */
  const CAPTURE = Object.freeze({ TITLE_MAX: 160, TEXT_SOFT: 2000, TEXT_MAX: 4000 });

  // ---- Keyboard ----

  /**
   * What a key press does in the Plans room. Ctrl+K (Cmd+K) works everywhere; the others only outside input fields and menus and
   * without Ctrl, Cmd or Alt (so the browser's own shortcuts work as before).
   * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean }} e
   * @returns {{ type: 'palette'|'move'|'opened'|'search'|'filter'|'new'|'priority'|'copy'|'mark'|'cancel',
   *   direction?: number, val?: string }|null}
   */
  function keyAction(e, { inputField = false, busy = false } = {}) {
    const k = e?.key;
    if ((e?.ctrlKey || e?.metaKey) && !e?.altKey && !e?.shiftKey && (k === 'k' || k === 'K'))
      return { type: 'palette' };
    if (busy || inputField || e?.ctrlKey || e?.metaKey || e?.altKey) return null;
    if (k === 'j') return { type: 'move', direction: 1 };
    if (k === 'k') return { type: 'move', direction: -1 };
    if (k === 'Enter') return { type: 'opened' };
    if (k === '/') return { type: 'search' };
    // f opens the Filter menu (P4, plan section 7.7)
    if (k === 'f') return { type: 'filter' };
    // n opens "+ New plan" (P6, quick capture)
    if (k === 'n') return { type: 'new' };
    if (Object.hasOwn(PRIORITY_KEY, k)) return { type: 'priority', val: PRIORITY_KEY[k] };
    if (k === 'c') return { type: 'copy' };
    if (k === 'x') return { type: 'mark' };
    if (k === 'Escape') return { type: 'cancel' };
    return null;
  }

  /** Next or previous entry in the list (j and k). Without a current entry: first (j) or last (k). Stops at the ends. */
  function neighborEntry(ids, current, direction) {
    const l = Array.isArray(ids) ? ids : [];
    if (!l.length) return null;
    const i = l.indexOf(current);
    if (i < 0) return direction < 0 ? l[l.length - 1] : l[0];
    return l[Math.min(l.length - 1, Math.max(0, i + (direction < 0 ? -1 : 1)))];
  }

  /**
   * What key presses 1 to 4 do with an entry: `call` (the group for /api/plan-prioritize) when the priority can be set directly, otherwise
   * `menu` (Now without a category needs a choice of category; Drop needs one sentence as the reason). Same priority and
   * category gives `unchanged`.
   * @returns {{ unchanged?: true, menu?: 'now'|'drop', group?: { ids: string[], priority: string, category: string[] } }}
   */
  function priorityFromKey(entry, priority) {
    if (!entry || !PRIORITIES.includes(priority)) return { unchanged: true };
    if (priority === 'drop')
      return entry.priority === 'drop' ? { unchanged: true } : { menu: 'drop' };
    if (priority === 'now') {
      if (entry.priority === 'now') return { unchanged: true };
      return { menu: 'now' };
    }
    if (entry.priority === priority) return { unchanged: true };
    return { group: { ids: [entry.id], priority, category: [] } };
  }

  // ---- The command palette (Ctrl+K) ----

  /**
   * Everything the command palette can jump to: modules, projects that have entries, and entries (dropped ones too, marked), each
   * with the breadcrumb, plus the actions. `sortKey` is stable (for "recently used").
   * @returns {{ type: 'module'|'project'|'entry'|'action', sortKey: string, id: string, text: string,
   *   path: string, drop?: boolean }[]}
   */
  function paletteCandidates(d) {
    const out = PALETTE_ACTIONS.map((h) => ({
      type: 'action',
      sortKey: `action:${h.id}`,
      id: h.id,
      text: h.text,
      path: 'Action',
    }));
    const modTitle = new Map((d?.modules ?? []).map((m) => [m.oid, m.title]));
    for (const m of d?.modules ?? [])
      out.push({
        type: 'module',
        sortKey: `module:${m.oid}`,
        id: m.oid,
        text: m.title,
        path: 'Plans',
      });
    const withEntries = new Set((d?.entries ?? []).map((p) => p.project).filter(Boolean));
    for (const [pid, pr] of Object.entries(d?.projects ?? {})) {
      if (!withEntries.has(pid)) continue;
      out.push({
        type: 'project',
        sortKey: `project:${pid}`,
        id: pid,
        text: pr?.summary ?? pid,
        path: pathText([
          'Plans',
          pr?.area ? (modTitle.get(pr.area) ?? pr.area) : 'Without area',
        ]),
      });
    }
    for (const p of d?.entries ?? [])
      out.push({
        type: 'entry',
        sortKey: `entry:${p.id}`,
        id: p.id,
        text: `${p.id} ${p.title ?? ''}`.trim(),
        path: pathText(['Plans', ...overEntry(p, d ?? {})]),
        drop: p.priority === 'drop',
      });
    return out;
  }

  /** How well the candidate matches the search (lower is better), or null when one of the words is missing. */
  function paletteScore(k, word) {
    const id = k.id.toLowerCase();
    const text = k.text.toLowerCase();
    const alt = `${id}\n${text}\n${k.path.toLowerCase()}`;
    if (!word.every((o) => alt.includes(o))) return null;
    const whole = word.join(' ');
    let p = 4;
    if (id === whole) p = 0;
    else if (id.startsWith(whole)) p = 1;
    else if (text.startsWith(whole)) p = 2;
    else if (
      word.every((o) =>
        new RegExp(`(^|[\\s›(:-])${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(alt),
      )
    )
      p = 3;
    return p + (k.drop ? 0.5 : 0);
  }

  /**
   * The matches in the command palette. Empty search: the recently used (that still exist), then the actions and modules. With a search: all
   * words must be present (id, title or path); recently used come first, then the best matches, then the order in the register.
   */
  function paletteMatch(candidates, search, recentOnes = [], { max = PALETTE_MAX } = {}) {
    const all = Array.isArray(candidates) ? candidates : [];
    const perKey = new Map(all.map((k) => [k.sortKey, k]));
    const recentSet = new Set(recentOnes);
    const word = String(search ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    if (!word.length) {
      const out = [];
      for (const n of recentOnes) if (perKey.has(n)) out.push({ ...perKey.get(n), recent: true });
      for (const k of all)
        if ((k.type === 'action' || k.type === 'module') && !recentSet.has(k.sortKey))
          out.push({ ...k, recent: false });
      return out.slice(0, max);
    }
    return all
      .map((k, i) => ({ k, i, p: paletteScore(k, word) }))
      .filter((x) => x.p != null)
      .sort(
        (a, b) =>
          Number(recentSet.has(b.k.sortKey)) - Number(recentSet.has(a.k.sortKey)) ||
          a.p - b.p ||
          a.i - b.i,
      )
      .slice(0, max)
      .map((x) => ({ ...x.k, recent: recentSet.has(x.k.sortKey) }));
  }

  /** Puts a key first in "recently used" (without duplicates, at most PALETTE_RECENT). Invalid values are dropped. */
  function addToRecent(list, sortKey, max = PALETTE_RECENT) {
    const ok = (x) =>
      typeof x === 'string' && x.length <= 80 && /^(module|project|entry|action):/.test(x);
    const l = (Array.isArray(list) ? list : []).filter(ok);
    if (!ok(sortKey)) return l.slice(0, max);
    return [sortKey, ...l.filter((x) => x !== sortKey)].slice(0, max);
  }

  /** The start lines for several entries ("Copy start line for all selected"), one per line in the list's order. */
  function startLines(ids, d) {
    const per = new Map((d?.entries ?? []).map((p) => [p.id, p]));
    return (ids ?? [])
      .map((id) => per.get(id))
      .filter(Boolean)
      .map((p) => entryLine(p, d))
      .join('\n');
  }

  // ---- Multi-select and change in the row ----

  /** Tail for a write call from the board: owner choice, the board as sender and a JSON answer. */
  const OWNER_TAIL = ['--set-by', 'owner', '--by', 'theBoard', '--json'];

  /**
   * The server's check of a multi-select (or a change in the row) and the calls to queue.mjs. Anything invalid gives an error,
   * and then nothing runs.
   *   priority:   { priority, category?, reason? }  → `plan prioritize <id…> <priority>` (like the priority map)
   *   project:    { project: pid|null }            → `plan edit <id> --set {"project":…}` per entry
   *   maturity:    { maturity: idea|investigated|planned|ready } → `plan edit <id> --set {"maturity":…}` per entry
   *   combine: { to }  (one of the selected)       → `plan combine <to> <the others…>`
   * @returns {{ error: string[], call: string[][] }}
   */
  function planBulkCall(b) {
    const no = (f) => ({ error: [f], call: [] });
    if (!b || typeof b !== 'object') return no('invalid body');
    if (!BULK_ACTIONS.includes(b.action))
      return no(`unknown action ${String(b.action).slice(0, 30)}`);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!ids.length) return no('no entries selected');
    if (ids.length > BULK_MAX) return no(`too many entries (at most ${BULK_MAX})`);
    if (ids.some((id) => !ENTRY_ID.test(id)) || new Set(ids).size !== ids.length)
      return no('invalid or duplicate entry ids');
    if (b.action === 'priority') {
      const cat = b.category == null || b.category === '' ? [] : [].concat(b.category).map(String);
      return prioritizeCall([{ ids, priority: b.priority, category: cat, reason: b.reason }]);
    }
    if (b.action === 'project') {
      const pid = b.project == null || b.project === '' ? null : String(b.project);
      if (pid != null && !KEY.test(pid)) return no('invalid project');
      return {
        error: [],
        call: ids.map((id) => [
          'plan',
          'edit',
          id,
          '--set',
          JSON.stringify({ project: pid }),
          ...OWNER_TAIL,
        ]),
      };
    }
    if (b.action === 'maturity') {
      if (!MATURITY_MANUAL.includes(b.maturity))
        return no(
          'the maturity can only be set to idea, investigated, planned or ready (the rest is computed)',
        );
      return {
        error: [],
        call: ids.map((id) => [
          'plan',
          'edit',
          id,
          '--set',
          JSON.stringify({ maturity: b.maturity }),
          ...OWNER_TAIL,
        ]),
      };
    }
    // combine
    const to = String(b.to ?? '');
    if (!ids.includes(to))
      return no('select which of the selected entries the others are merged into');
    const from = ids.filter((id) => id !== to);
    if (!from.length) return no('merging needs at least two entries');
    return { error: [], call: [['plan', 'combine', to, ...from, '--by', 'theBoard', '--json']] };
  }

  /**
   * Undo a saved multi-select: the changelog numbers (from the answer to the save) are undone newest first with `plan undo --nr`,
   * which only undoes when the number is still the last change (a session that has written meanwhile stops the undo).
   * @returns {{ error: string[], call: string[][] }}
   */
  function undoCall(nr) {
    const l = Array.isArray(nr) ? nr : [];
    if (!l.length || l.length > BULK_MAX) return { error: ['no changes to undo'], call: [] };
    if (l.some((n) => !Number.isInteger(n) || n < 1))
      return { error: ['invalid change number'], call: [] };
    return {
      error: [],
      call: [...new Set(l)]
        .sort((a, b) => b - a)
        .map((n) => ['plan', 'undo', '--nr', String(n), '--json', '--by', 'theBoard']),
    };
  }

  /** The text for a multi-select (for the preview and the confirmation), e.g. "3 entries: priority Now (before prod)". */
  function bulkText(b, { projects = {} } = {}) {
    const n = Array.isArray(b?.ids) ? b.ids.length : 0;
    const who = n === 1 ? b.ids[0] : `${n} entries`;
    if (b?.action === 'priority') {
      const v = PRIORITY[b.priority]?.text ?? b.priority;
      const cat = b.category ? ` (${CATEGORY[b.category] ?? b.category})` : '';
      return `${who}: priority ${v}${cat}`;
    }
    if (b?.action === 'project')
      return `${who}: project ${b.project ? (projects[b.project]?.summary ?? b.project) : 'none'}`;
    if (b?.action === 'maturity')
      return `${who}: maturity ${MATURITY[b.maturity] ?? b.maturity}`;
    if (b?.action === 'combine') return `${who}: merged into ${b.to}`;
    return who;
  }

  // ---- tree map and dependencies for the selection ------------------------------------------------

  /** The views of the plan entries (`show` in the url): the list, priority map, tree map and dependencies. */
  const VIEWS = ['list', 'map', 'treeMap', 'dep'];
  /** Selection in the dependency view (`dep` in the url): the whole selection, or the selected entry with its neighbors. */
  const DEP_MODE = ['selection', 'entry'];

  /**
   * The weight (the area in the tree map, the weight along the critical path) per size, in queue tracks. Same numbers as
   * queuePlan.SIZE_TRACK (the capacity), so the tree map and "Now is about N weeks" compute alike (the test keeps them equal).
   * An entry without a size counts as WITHOUT_SIZE_WEIGHT and is marked "without size", so it does not disappear.
   */
  const SIZE_WEIGHT = { S: 1, M: 2, L: 7, XL: 15 };
  const WITHOUT_SIZE_WEIGHT = 1;
  /** Done maturities: built and verified are no longer open (never on the critical path and block nothing). */
  const DONE_MATURITY = ['built', 'verified'];
  /** The largest selection the dependency view draws (never the whole register, since that becomes a tangle). */
  const DEP_MAX = 120;
  /** The surface the tree map is computed in (width × height). The client scales to percent, so only the ratio matters. */
  const TREE_MAP_SURFACE = { width: 1000, height: 600 };
  /** Below this width or height (in TREE_MAP_SURFACE) only the name is shown in the field; the rest goes in the label. */
  const TREE_MAP_SMALL = { width: 110, height: 70 };

  /** The weight of an entry (the estimate in queue tracks). */
  function entryWeight(p) {
    return SIZE_WEIGHT[p?.size] ?? WITHOUT_SIZE_WEIGHT;
  }

  /** How much of the entry is built (0 to 1): built and verified are 1, partial is finished/total, the rest 0. */
  function builtShare(p) {
    if (DONE_MATURITY.includes(p?.maturity)) return 1;
    if (p?.maturity === 'partial' && p.total > 0) return Math.min(1, (p.finished ?? 0) / p.total);
    return 0;
  }

  /** Is the entry open (not built, not verified, not dropped)? */
  function entryOpen(p) {
    return !!p && !DONE_MATURITY.includes(p.maturity) && p.priority !== 'drop';
  }

  /**
   * The level the tree map shows, given the filter (the zoom is the filter, so the breadcrumb zooms out and the back button works):
   * one project selected gives entries, one module gives projects, otherwise modules.
   * @returns {'module'|'project'|'entry'}
   */
  function treeMapLevel(filter) {
    if ((filter?.project ?? []).length === 1) return 'entry';
    if ((filter?.module ?? []).length === 1) return 'project';
    return 'module';
  }

  /**
   * The fields in the tree map for the level: modules, projects or entries in the selection (`match` is the filtered entries).
   * The area is the sum of the estimates, the fill how much is built (weighted by the estimate) and the color the priority (for
   * a combined field: the priority that has the most size, with Now first on a tie). `shares` is the distribution per
   * priority, which the field also shows as text. `zoom` is the filter a click gives (null for an entry: a click opens it).
   * Sorted by weight (largest first), then title.
   * @returns {{ level: string, fields: object[], sum: number, withoutSize: number }}
   */
  function treeMapFields(match, data = {}, filter = {}) {
    const level = treeMapLevel(filter);
    const projects = data.projects ?? {};
    const modules = data.modules ?? [];
    const groups = new Map();
    const addTo = (key, p) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    };
    for (const p of match ?? []) {
      if (level === 'module') addTo(p.module ?? WITHOUT_MODULE, p);
      else if (level === 'project')
        addTo(p.project && projects[p.project] ? p.project : WITHOUT_PROJECT, p);
      else addTo(p.id, p);
    }
    const fields = [];
    for (const [key, list] of groups) {
      let weight = 0;
      let built = 0;
      let without = 0;
      const perPri = new Map();
      for (const p of list) {
        const v = entryWeight(p);
        weight += v;
        built += v * builtShare(p);
        if (!SIZE_WEIGHT[p.size]) without += 1;
        const pri = Object.hasOwn(PRIORITY, p.priority) ? p.priority : 'owner';
        perPri.set(pri, (perPri.get(pri) ?? 0) + v);
      }
      const shares = PRIORITIES.filter((x) => perPri.has(x)).map((x) => ({
        priority: x,
        weight: perPri.get(x),
      }));
      const priority = shares.reduce((a, x) => (!a || x.weight > a.weight ? x : a), null).priority;
      let title;
      let zoom = null;
      if (level === 'module') {
        title =
          key === WITHOUT_MODULE
            ? 'Without area'
            : (modules.find((m) => m.oid === key)?.title ?? key);
        zoom = { module: [key], project: [] };
      } else if (level === 'project') {
        title =
          key === WITHOUT_PROJECT
            ? 'Without project'
            : (projects[key]?.summary ?? summaryName(projects[key]?.title, key));
        zoom = { module: [...(filter?.module ?? [])], project: [key] };
      } else title = list[0].title ?? key;
      fields.push({
        id: key,
        level,
        title,
        weight,
        count: list.length,
        withoutSize: without,
        built: weight ? Math.round((built / weight) * 1000) / 1000 : 0,
        priority,
        shares,
        zoom,
        ...(level === 'entry'
          ? {
              entry: list[0].id,
              size: list[0].size ?? null,
              maturity: list[0].maturity ?? null,
            }
          : {}),
      });
    }
    fields.sort(
      (a, b) =>
        b.weight - a.weight ||
        a.title.localeCompare(b.title, 'en') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return {
      level,
      fields,
      sum: fields.reduce((s, f) => s + f.weight, 0),
      withoutSize: fields.reduce((s, f) => s + f.withoutSize, 0),
    };
  }

  /**
   * The cells in the tree map: the "squarified" layout (Bruls, Huizing and van Wijk), where each field gets an area by its weight and
   * the cells are kept as close to square as possible. The fields are placed largest first (the input order is kept on equal weight).
   * Deterministic. The coordinates are in the surface's units, rounded to two decimals.
   * @param {{ id: string, weight: number }[]} fields
   * @param {{ width: number, height: number }} surface
   * @returns {{ id: string, x: number, y: number, width: number, height: number }[]} in the same order as laid out
   */
  function treeMapCells(fields, surface = TREE_MAP_SURFACE) {
    const W = surface?.width > 0 ? surface.width : TREE_MAP_SURFACE.width;
    const H = surface?.height > 0 ? surface.height : TREE_MAP_SURFACE.height;
    const list = (fields ?? [])
      .map((f, i) => ({ id: f.id, weight: Number(f.weight) > 0 ? Number(f.weight) : 0, i }))
      .filter((f) => f.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.i - b.i);
    const total = list.reduce((s, f) => s + f.weight, 0);
    if (!total) return [];
    const things = list.map((f) => ({ id: f.id, surfaceArea: (f.weight / total) * W * H }));
    const rest = { x: 0, y: 0, b: W, h: H };
    const out = [];
    const r2 = (x) => Math.round(x * 100) / 100;
    // The worst aspect ratio in a row with the given side (the short side of the rest).
    const worst = (row, side) => {
      const s = row.reduce((a, t) => a + t.surfaceArea, 0);
      let max = 0;
      for (const t of row)
        max = Math.max(max, (side * side * t.surfaceArea) / (s * s), (s * s) / (side * side * t.surfaceArea));
      return max;
    };
    const addOut = (row) => {
      const s = row.reduce((a, t) => a + t.surfaceArea, 0);
      if (rest.b >= rest.h) {
        // A column on the left of the rest.
        const width = s / rest.h;
        let y = rest.y;
        for (const t of row) {
          const h = t.surfaceArea / width;
          out.push({ id: t.id, x: r2(rest.x), y: r2(y), width: r2(width), height: r2(h) });
          y += h;
        }
        rest.x += width;
        rest.b -= width;
      } else {
        // A row at the top of the rest.
        const height = s / rest.b;
        let x = rest.x;
        for (const t of row) {
          const b = t.surfaceArea / height;
          out.push({ id: t.id, x: r2(x), y: r2(rest.y), width: r2(b), height: r2(height) });
          x += b;
        }
        rest.y += height;
        rest.h -= height;
      }
    };
    let row = [];
    for (const t of things) {
      const side = Math.min(rest.b, rest.h);
      if (!row.length || worst([...row, t], side) <= worst(row, side)) row.push(t);
      else {
        addOut(row);
        row = [t];
      }
    }
    if (row.length) addOut(row);
    return out;
  }

  /** Is the cell too small for more than the name (the rest then goes in the label and the tooltip)? */
  function treeMapSmall(cell) {
    return cell.width < TREE_MAP_SMALL.width || cell.height < TREE_MAP_SMALL.height;
  }

  /** "12 tracks" / "1 track": the estimate in queue tracks, with a decimal only when needed. */
  function trackText(weight) {
    const v = Math.round(weight * 10) / 10;
    return `${v} ${v === 1 ? 'track' : 'tracks'}`;
  }

  /**
   * The text for a field in the tree map, so color is never the only carrier: name, count, size, the priority
   * (symbol and text; for a combined field the distribution) and how much is built.
   * @returns {{ name: string, lines: string[], label: string }}
   */
  function treeMapText(field) {
    const pri = PRIORITY[field.priority] ?? PRIORITY.owner;
    const percent = `${Math.round(field.built * 100)} % built`;
    const lines = [];
    if (field.level === 'entry') {
      lines.push(`${pri.symbol} ${pri.text}`);
      lines.push(
        field.size && SIZE_WEIGHT[field.size]
          ? `${field.size} (${trackText(field.weight)})`
          : 'Without size',
      );
      lines.push(percent);
    } else {
      lines.push(
        `${field.count} ${field.count === 1 ? 'entry' : 'entries'}, ${trackText(field.weight)}`,
      );
      lines.push(
        field.shares
          .map(
            (a) =>
              `${PRIORITY[a.priority].symbol} ${PRIORITY[a.priority].text} ${trackText(a.weight)}`,
          )
          .join(', '),
      );
      lines.push(percent);
      if (field.withoutSize) lines.push(`${field.withoutSize} without size`);
    }
    const name = field.level === 'entry' ? `${field.id}: ${field.title}` : field.title;
    const action = field.level === 'entry' ? 'Open entry' : 'Zoom in';
    return { name, lines, label: `${name}. ${lines.join('. ')}. ${action}.` };
  }

  /**
   * The graph in the dependency view, as nodes and edges queueGraph.layer can lay out from left to right.
   * Shows only the selection or the selected entry with its neighbors, never the whole register:
   *   - `selection`: entries in the selection that have a dependency (both ways). Entries they depend on or that depend on
   *     them outside the selection are included as small neighbors (role `neighbor`), so you see what is holding things back. If the selection is the whole
   *     register (`wholeRegister`), or larger than DEP_MAX, nothing is drawn.
   *   - `entry`: the selected entry, what it depends on and what depends on it.
   * An open entry is blocked when at least one entry it depends on is still open. The critical path is the heaviest
   * chain of open entries (the estimate as weight, queueGraph.criticalPath), and is shown only when it has at least two parts.
   * `reason` explains an empty image: 'select-entry', 'whole-register', 'for-large' or 'none-edges'.
   * @returns {{ nodes: object[], edges: object[], projects: [], critical: { path: string[], sum: number },
   *   tall: { entries: number, neighbors: number, blocked: number, without: number, selection: number }, reason: string|null }}
   */
  function planGraph(entries, option = {}) {
    const {
      mode = 'selection',
      selection = [],
      selected = null,
      wholeRegister = false,
      max = DEP_MAX,
      graph = null,
    } = option;
    const G =
      graph ??
      (typeof module === 'object' && module.exports ? require('./queueGraph.js') : globalThis.QueueGraph);
    const perId = new Map((entries ?? []).map((p) => [p.id, p]));
    const pred = new Map();
    const after = new Map();
    for (const p of perId.values()) {
      const f = [...new Set(p.depends_on ?? [])].filter((x) => x !== p.id && perId.has(x)).sort();
      pred.set(p.id, f);
      for (const x of f) {
        if (!after.has(x)) after.set(x, []);
        after.get(x).push(p.id);
      }
    }
    const neighbors = (id) => [...(pred.get(id) ?? []), ...(after.get(id) ?? [])];
    const blocked = (p) =>
      entryOpen(p) && (pred.get(p.id) ?? []).some((f) => entryOpen(perId.get(f)));
    const empty = (reason, extra = {}) => ({
      nodes: [],
      edges: [],
      projects: [],
      critical: { path: [], sum: 0 },
      counts: { entries: 0, neighbors: 0, blocked: 0, without: 0, selection: 0, ...extra },
      reason,
    });

    const role = new Map();
    let without = 0;
    let countSelection = 0;
    if (mode === 'entry') {
      if (!selected || !perId.has(selected)) return empty('select-entry');
      role.set(selected, 'core');
      for (const n of neighbors(selected)) role.set(n, 'core');
      countSelection = 1;
    } else {
      const ids = [...new Set(selection ?? [])].filter((id) => perId.has(id));
      countSelection = ids.length;
      if (wholeRegister) return empty('whole-register', { selection: ids.length });
      if (ids.length > max) return empty('for-large', { selection: ids.length });
      for (const id of ids) {
        if (neighbors(id).length) role.set(id, 'core');
        else without += 1;
      }
      for (const id of [...role.keys()])
        for (const n of neighbors(id)) if (!role.has(n)) role.set(n, 'neighbor');
    }
    if (!role.size) return empty('none-edges', { selection: countSelection, without });

    const MEASURE = G?.MEASURE ?? { rMin: 7, rMax: 22, rSmall: 5 };
    const radius = (p) =>
      SIZE_WEIGHT[p.size]
        ? Math.min(
            MEASURE.rMax,
            Math.round((MEASURE.rMin + 4 * Math.sqrt(SIZE_WEIGHT[p.size])) * 10) / 10,
          )
        : MEASURE.rMin + 2;
    const nodes = [...role.keys()].sort().map((id) => {
      const p = perId.get(id);
      const r = role.get(id);
      return {
        id,
        art: 'entry',
        role: r,
        selected: id === selected,
        title: p.title ?? id,
        project: p.project ?? null,
        priority: Object.hasOwn(PRIORITY, p.priority) ? p.priority : 'owner',
        maturity: p.maturity ?? null,
        size: p.size ?? null,
        weight: entryWeight(p),
        built: builtShare(p),
        isOpen: entryOpen(p),
        blocked: blocked(p),
        r: r === 'neighbor' ? MEASURE.rSmall : radius(p),
      };
    });
    const edges = [];
    for (const n of nodes)
      for (const f of pred.get(n.id) ?? [])
        if (role.has(f))
          edges.push({ from: f, to: n.id, art: 'dep', muted: !entryOpen(perId.get(f)) });
    edges.sort((a, b) =>
      a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
    );

    const route = G?.criticalPath
      ? G.criticalPath(nodes, edges, { with: (n) => n.isOpen, weight: (n) => n.weight })
      : { path: [], sum: 0, edges: [] };
    const critical = route.path.length >= 2 ? route : { path: [], sum: 0, edges: [] };
    const onPath = new Set(critical.path);
    const edgeOnPath = new Set(critical.edges);
    for (const n of nodes) n.critical = onPath.has(n.id);
    for (const k of edges) k.critical = edgeOnPath.has(`${k.from}>${k.to}`);
    return {
      nodes,
      edges,
      projects: [],
      critical: { path: critical.path, sum: critical.sum },
      counts: {
        entries: nodes.filter((n) => n.role === 'core').length,
        neighbors: nodes.filter((n) => n.role === 'neighbor').length,
        blocked: nodes.filter((n) => n.blocked).length,
        without,
        selection: countSelection,
      },
      reason: null,
    };
  }

  /** The text for a node in the dependency view (the label and the tooltip): color is never the only carrier. */
  function planNodeText(n) {
    const pri = PRIORITY[n.priority] ?? PRIORITY.owner;
    return [
      `${n.id}: ${n.title}`,
      `${pri.symbol} ${pri.text}, ${MATURITY[n.maturity] ?? 'unknown maturity'}${n.size ? `, ${n.size}` : ', without size'}`,
      n.blocked ? 'Blocked: waiting on an open entry' : null,
      n.isOpen ? null : 'Done or dropped',
      n.critical ? 'On the critical path' : null,
      n.role === 'neighbor' ? 'Outside selection' : null,
    ].filter(Boolean);
  }

  /** The summary above the dependency graph, or the explanation when it is empty. */
  function planGraphText(g) {
    if (g.reason === 'select-entry')
      return 'Select an entry in the list or the tree map to see it with its neighbors.';
    if (g.reason === 'whole-register')
      return 'Dependencies are only shown for a selection. Pick a filter or search, or select an entry and "Selected entry with neighbors".';
    if (g.reason === 'for-large')
      return `The selection has ${g.counts.selection} entries. Dependencies are drawn for at most ${DEP_MAX}; narrow it down with the filters.`;
    if (g.reason === 'none-edges')
      return g.counts.selection
        ? `None of the ${g.counts.selection} entries in the selection have dependencies.`
        : 'No entries in the selection.';
    const parts = [`${g.counts.entries} ${g.counts.entries === 1 ? 'entry' : 'entries'}`];
    if (g.counts.neighbors) parts.push(`${g.counts.neighbors} outside the selection`);
    parts.push(`${g.counts.blocked} blocked`);
    if (g.counts.without) parts.push(`${g.counts.without} in the selection without dependencies (not drawn)`);
    return parts.join(', ');
  }

  /** "Critical path: A → B → C (about 9 tracks)", or null when there is no chain of open entries. */
  function criticalPathText(g) {
    if (!g?.critical?.path?.length) return null;
    return `Critical path: ${g.critical.path.join(' → ')} (about ${trackText(g.critical.sum)})`;
  }

  // ---- The Roadmap: the start page of Plans (P1, P2 and P3 of plans/plans-tab-ux-review-2026-11-19.md) -------------
  // Concept B, owner decision 2026-11-19 "as recommended": the plans read top to bottom in horizons (Now, Next, Later
  // plus Inbox, Waiting on you and Done), each plan a title, one plain sentence and a muted line with the status in
  // words, the area and the next step. On a wide screen the horizons may sit side by side as columns (owner addition:
  // "kanban-ish"), on a narrow one they are one list. Everything here is derived from the data the room already has;
  // no new stored field. The lead from the plan document (P3) is computed on the server (ctx.leadFor in plansData).

  /** The horizons in roadmap order. A plan is in exactly one (horizonFor). */
  const HORIZONS = Object.entries(HORIZON_TEXT).map(([id, text]) => ({ id, text }));
  const HORIZON_IDS = HORIZONS.map((h) => h.id);
  /** The horizons the column layout always shows, also when empty, so the columns do not jump about. */
  const HORIZON_CORE = ['waiting', 'now', 'next', 'later', 'done'];
  /** Sections that never fold: they need the owner, so every row stays in sight. */
  const HORIZON_UNFOLDED = ['inbox', 'waiting'];
  /** plans.roadmapFoldAfter: the default number of rows a long section shows before "Show n more". */
  const ROADMAP_FOLD_AFTER = 8;
  /** The widths for plans.roadmapLayout auto: columns from WIDE, always one list below NARROW (a phone). */
  const ROADMAP_WIDE = 1200;
  const ROADMAP_NARROW = 700;
  const ROADMAP_LAYOUTS = ['auto', 'columns', 'list'];
  /** plans.startView: where "Plans" at the top opens. */
  const START_VIEWS = ['roadmap', 'overview', 'list'];
  /** The views under More views (the overview and the maps are tools for plan work, not for reading). */
  const MORE_VIEWS = [
    { id: 'overview', text: 'Overview', state: { surface: 'overview' } },
    { id: 'map', text: 'Priority map', state: { surface: 'entries', show: 'map' } },
    { id: 'treeMap', text: 'Tree map', state: { surface: 'entries', show: 'treeMap' } },
    { id: 'dep', text: 'Dependencies', state: { surface: 'entries', show: 'dep' } },
  ];
  /** The sentence under the title is clipped near this; the lead from a document near LEAD_MAX (the task panel's 320). */
  const SENTENCE_MAX = 200;
  const LEAD_MAX = 320;

  const openQuestions = (p) => (p?.ownerQuestions ?? []).filter((q) => !q.resolved);

  /**
   * The horizon of a plan, first match wins: dropped, inbox (a finding nobody sorted, later also captured plans), done
   * (built or verified, whatever the priority, so a finished plan never sits in Next), waiting on you (priority owner or
   * an open owner question), now (in the queue, partly built or worked on in a session), next (priority now), later.
   * @returns {'inbox'|'waiting'|'now'|'next'|'later'|'done'|'dropped'}
   */
  function horizonFor(p) {
    if (p?.priority === 'drop') return 'dropped';
    if (p?.inbox) return 'inbox';
    if (p?.maturity === 'built' || p?.maturity === 'verified') return 'done';
    if (p?.priority === 'owner' || openQuestions(p).length) return 'waiting';
    if (p?.maturity === 'in-queue' || p?.maturity === 'partial' || p?.active) return 'now';
    if (p?.priority === 'now') return 'next';
    return 'later';
  }

  /** The words for a maturity before the queue, and the next step for it. */
  const SHAPE = {
    idea: 'Idea, needs shaping',
    investigated: 'Investigated, needs a plan',
    planned: 'Planned, not ready yet',
    ready: 'Ready to become tasks',
  };

  /**
   * The status in words and the next step (null when none is due) for a plan. The words name what a person would ask
   * ("Being built: 3 of 7 tasks done", "Waiting on your answer to Q-SSO"), never a field name.
   * @returns {{ text: string, next: string|null }}
   */
  function planStatus(p) {
    const h = horizonFor(p);
    const queue = p?.queue ?? [];
    if (h === 'dropped') return { text: 'Dropped', next: null };
    if (h === 'inbox')
      return {
        text: p.inbox?.by === 'track' ? 'Reported by a track, not sorted yet' : 'In the inbox, not sorted yet',
        next: 'Sort it',
      };
    if (h === 'done') {
      if (p.maturity === 'verified')
        return p.stale
          ? { text: 'Built; the check against the code is stale', next: 'Verify against the code again' }
          : { text: 'Built and checked against the code', next: null };
      return { text: 'Built, not checked against the code', next: 'Verify against the code' };
    }
    if (h === 'waiting') {
      const q = openQuestions(p)[0];
      return q
        ? { text: `Waiting on your answer to ${q.id}`, next: `Answer ${q.id}` }
        : { text: 'Waiting on your decision', next: 'Decide the priority' };
    }
    if (h === 'now') {
      const running = queue.find((o) => o.column === 'inProgress' || o.column === 'review');
      const waiting = queue.find((o) => o.column === 'queue' || o.column === 'batch');
      // A phrase that reads on its own, both after "Next:" on the plan page and in the card's muted line.
      const next = running ? `${running.id} is running` : waiting ? `${waiting.id} is next in the queue` : null;
      if (p.maturity === 'partial')
        return { text: `Being built: ${p.finished ?? 0} of ${p.total ?? 0} tasks done`, next };
      if (p.maturity === 'in-queue') {
        const n = p.total ?? queue.length;
        return { text: `In the queue: ${n} ${n === 1 ? 'task' : 'tasks'}, none done yet`, next };
      }
      return { text: 'Being worked on in Claude Code now', next };
    }
    const text = SHAPE[p.maturity] ?? MATURITY[p.maturity] ?? 'Not shaped yet';
    // Later is a choice to wait, so it gets no nudge; Next says what moves it forward.
    if (h === 'later') return { text, next: null };
    return { text, next: p.maturity === 'ready' ? 'Turn into queue tasks' : 'Shape it with Claude' };
  }

  /**
   * How far a plan has come: its queue tasks done of the total, as a whole percent and in words, so the bar beside it
   * is never the only carrier. Null when the plan has no tasks yet (no bar then: 0 of 0 says nothing).
   * @returns {{ done: number, total: number, percent: number, text: string }|null}
   */
  function planProgress(p) {
    const total = Number.isInteger(p?.total) ? p.total : 0;
    if (total <= 0) return null;
    const done = Math.max(0, Math.min(total, Number.isInteger(p?.finished) ? p.finished : 0));
    const percent = Math.round((done / total) * 100);
    return { done, total, percent, text: `${percent}% done, ${done} of ${total} ${total === 1 ? 'task' : 'tasks'}` };
  }

  /** Warnings as words for the muted line (never only an icon): the deadline, a stale check, open legal points. */
  function planNotes(p, now = new Date()) {
    const out = [];
    if (typeof p?.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.deadline)) {
      const d = days(osloDate(now), p.deadline);
      out.push(
        d > 1
          ? `deadline in ${d} days`
          : d === 1
            ? 'deadline tomorrow'
            : d === 0
              ? 'deadline today'
              : `deadline passed ${-d} ${d === -1 ? 'day' : 'days'} ago`,
      );
    }
    if (p?.stale && p.maturity !== 'verified') out.push('the check is stale');
    const legal = p?.legal_open ?? 0;
    if (legal) out.push(`${legal} open legal ${legal === 1 ? 'point' : 'points'}`);
    return out;
  }

  /** Clips at a word boundary near `max` characters and ends with "…" (the task panel's clipSummary). */
  function clipWords(text, max) {
    let s = String(text ?? '').trim();
    if (s.length <= max) return s;
    s = s.slice(0, max);
    const space = s.lastIndexOf(' ');
    if (space > max / 2) s = s.slice(0, space);
    return `${s.replace(/[\s,;:.]+$/, '')}…`;
  }

  /**
   * The one plain sentence under the title: the person's summary, else the lead from the plan document (`from:
   * 'document'`, so the view can say where it came from), else nothing ("No summary yet" is the view's text).
   * @returns {{ text: string|null, from: 'summary'|'document'|null }}
   */
  function planSentence(p) {
    if (p?.summary) return { text: clipWords(p.summary, SENTENCE_MAX), from: 'summary' };
    if (p?.lead?.text) return { text: clipWords(p.lead.text, SENTENCE_MAX), from: 'document' };
    return { text: null, from: null };
  }

  const PURPOSE_NAME =
    /^(what\b.*\bwhy|why\b|goal|purpose|background|summary|about\b|hva og hvorfor|hvorfor|mål\b|formål|bakgrunn)/i;
  /** KEY: value metadata and the =====ID===== marker are not prose. */
  const META_LINE = /^(?:[A-ZÆØÅ][A-ZÆØÅ0-9 _-]{1,30}:\s|=+[^=\s]*=+$)/;

  /**
   * The lead of a plan document: the rule the task panel uses for a mission (board/panel.js missionSummary), on the
   * read view's own blocks (markdownBlocks), starting at the source's anchor when it finds one. In order: the block
   * right after a heading that names the purpose (What and why, Goal, Purpose, Background, Summary, ...), the text of a
   * bold label with such a name, the first prose paragraph, the first list point. Code, tables, quotes and KEY: value
   * lines are skipped, the inline markup becomes plain text, and the result is clipped near 320 characters.
   * @param {string} text the markdown
   * @param {string|null} [anchor] the source's anchor ("§ 1", a heading's words or a #slug)
   * @returns {string|null}
   */
  function documentLead(text, anchor = null) {
    let blocks = markdownBlocks(text);
    const at = anchor ? anchorIndex(blocks, anchor) : -1;
    if (at >= 0) {
      const level = blocks[at].level;
      const end = blocks.findIndex((b, i) => i > at && b.type === 'heading' && b.level <= level);
      blocks = blocks.slice(at, end < 0 ? blocks.length : end);
    }
    const prose = (b) => b.type === 'paragraph' && !META_LINE.test(b.text);
    const words = (b) => (b.type === 'list' ? b.points[0]?.text : b.text) ?? '';
    const named = (s) => PURPOSE_NAME.test(cleanText(s).replace(/^\d+(?:\.\d+)*[.)]?\s*/, '').trim());
    const bold = (s) => {
      const m = /^\*\*([^*]+?)\*\*:?\s*(.*)$/.exec(s);
      return m ? { label: m[1].replace(/:$/, '').trim(), rest: m[2].trim() } : null;
    };
    const done = (s) => {
      let plain = cleanText(s).replace(/\s+/g, ' ').trim();
      // A last sentence that only leads into a list ("Every task follows these rules:") says nothing on its own.
      const intro = /^(.*[.!?])\s+[^.!?]*:$/.exec(plain);
      if (intro) plain = intro[1];
      return plain ? clipWords(plain, LEAD_MAX) : null;
    };
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type !== 'heading' || !named(blocks[i].text)) continue;
      const next = blocks[i + 1];
      if (next && (prose(next) || next.type === 'list')) return done(words(next));
    }
    for (const b of blocks) {
      const bl = prose(b) ? bold(b.text) : null;
      if (bl?.rest && named(bl.label)) return done(bl.rest);
    }
    const pick = blocks.find((b) => prose(b) && !bold(b.text)) ?? blocks.find((b) => b.type === 'list');
    return pick ? done(words(pick)) : null;
  }

  /**
   * The source the plan page reads first: the first readable one with role plan, else one without a role, else the
   * first readable one; null when none can be read here (readPathError).
   */
  function planSource(p) {
    const readable = (p?.sources ?? []).filter((k) => k?.path && !readPathError(k.path));
    return (
      readable.find((k) => k.role === 'plan') ?? readable.find((k) => !k.role) ?? readable[0] ?? null
    );
  }

  // ---- Full-text search in the plan documents (P5) ---------------------------------------------------------------
  // The server (lib/queueBoard.js planDocSearcher) reads the plan document through the /api/doc guard, turns it into
  // passages once per file change, and asks documentHit for the snippet. The board gets the hits from
  // /api/plan-search and adds the plans found only in their document after the plans whose own words match
  // (searchWithDocuments). The snippet is plain text in three parts, so the view marks the match with textContent only.

  /** A shorter search finds a match in nearly every document, so it is not sent to the documents. */
  const DOC_SEARCH_MIN = 3;
  /** The most characters a snippet shows on each side of the match (then "…"). */
  const DOC_HIT_SIDE = 90;

  /**
   * A markdown document as plain passages for the search: headings, paragraphs, quotes, each list point and each
   * table row, with the inline markup removed and the whitespace folded. Code blocks and front matter are skipped.
   * `heading` is the heading the passage sits under (null before the first), `level` the heading level when the
   * passage is a heading itself (0 otherwise), so a source's anchor can pick its section.
   * @param {string} text the markdown
   * @returns {{ text: string, heading: string|null, level: number }[]}
   */
  function documentPassages(text) {
    const out = [];
    let heading = null;
    const add = (s, level = 0) => {
      const t = cleanText(s).replace(/\s+/g, ' ').trim();
      if (t) out.push({ text: t, heading, level });
      return t;
    };
    for (const b of markdownBlocks(text)) {
      if (b.type === 'heading') {
        const t = add(b.text, b.level);
        if (t) heading = t;
      } else if (b.type === 'paragraph' || b.type === 'quote') add(b.text);
      else if (b.type === 'list') for (const p of b.points) add(p.text);
      else if (b.type === 'table')
        for (const r of [b.header, ...b.rows]) add((r ?? []).filter(Boolean).join(' · '));
    }
    return out;
  }

  /**
   * The passages of one source: the section its anchor points to (the heading and everything under it, as
   * documentLead reads it), or the whole document when there is no anchor or it is not found.
   */
  function passagesAt(passages, anchor = null) {
    if (!anchor) return passages;
    const at = anchorIndex(
      passages.map((p) => (p.level ? { type: 'heading', text: p.text } : { type: 'text' })),
      anchor,
    );
    if (at < 0) return passages;
    const level = passages[at].level;
    const end = passages.findIndex((p, i) => i > at && p.level && p.level <= level);
    return passages.slice(at, end < 0 ? passages.length : end);
  }

  /** The search as a case-insensitive pattern that matches the text literally (no pattern characters). */
  function docSearchPattern(search) {
    const s = String(search ?? '')
      .trim()
      .slice(0, 120);
    if (s.length < DOC_SEARCH_MIN) return null;
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  }

  /**
   * The first passage that contains the search, as a snippet: the sentence with the match, cut near DOC_HIT_SIDE
   * characters on each side (with "…"), and the match itself in its own casing. null without a match, or when the
   * search is shorter than DOC_SEARCH_MIN.
   * @param {{ text: string, heading: string|null }[]} passages from documentPassages (or passagesAt)
   * @param {string|RegExp} search
   * @returns {{ heading: string|null, before: string, match: string, after: string } | null}
   */
  function documentHit(passages, search) {
    const re = search instanceof RegExp ? search : docSearchPattern(search);
    if (!re) return null;
    for (const p of passages ?? []) {
      const m = re.exec(p.text);
      if (!m) continue;
      const t = p.text;
      const from = m.index;
      const to = from + m[0].length;
      // the sentence: after the last ". " before the match, up to and including the first end mark after it.
      let start = 0;
      const ends = /[.!?]\s+/g;
      let e;
      while ((e = ends.exec(t)) && e.index + e[0].length <= from) start = e.index + e[0].length;
      const after = /[.!?](?=\s|$)/g;
      after.lastIndex = to;
      const close = after.exec(t);
      const stop = close ? close.index + 1 : t.length;
      let before = t.slice(start, from);
      let rest = t.slice(to, stop);
      if (before.length > DOC_HIT_SIDE) {
        before = before.slice(before.length - DOC_HIT_SIDE);
        const space = before.indexOf(' ');
        if (space >= 0 && space < DOC_HIT_SIDE / 2) before = before.slice(space + 1);
        before = `…${before}`;
      }
      if (rest.length > DOC_HIT_SIDE) {
        rest = rest.slice(0, DOC_HIT_SIDE);
        const space = rest.lastIndexOf(' ');
        if (space > DOC_HIT_SIDE / 2) rest = rest.slice(0, space);
        rest = `${rest.replace(/[\s,;:]+$/, '')}…`;
      }
      return { heading: p.heading, before, match: m[0], after: rest };
    }
    return null;
  }

  /**
   * The status line under the search: "Searching the plan documents…" while the first answer is on its way, then how
   * many plans the documents added (null when none), with a note when the server stopped at its limit or time.
   */
  function docSearchText(found, { busy = false, partial = false } = {}) {
    if (busy && !found) return 'Searching the plan documents…';
    if (!found) return null;
    const n = `${found} more ${found === 1 ? 'plan' : 'plans'} found in the plan documents`;
    return partial ? `${n} (the search stopped early; a longer search finds the rest)` : n;
  }

  /**
   * The plans for a search with the document hits: first the plans whose own words match (applyFilter, in the chosen
   * sort), then the plans found only in their plan document that also fit the filters (in the same sort), each a copy
   * with `docHit`. Title and summary matches always rank first. Without a search or hits it is filter plus sort.
   * @param {object[]} entries
   * @param {object} filter
   * @param {string} search
   * @param {Map<string, object>|null} hits plan id -> the hit from /api/plan-search
   * @param {{ sort?: string, now?: Date }} [option]
   */
  function searchWithDocuments(entries, filter, search, hits, { sort = 'roadmap', now = new Date() } = {}) {
    const match = applyFilter(entries, filter, search, { now });
    const own = sortPlans(match, sort);
    if (!String(search ?? '').trim() || !hits?.size) return own;
    const seen = new Set(match.map((p) => p.id));
    const extra = applyFilter(
      (entries ?? []).filter((p) => !seen.has(p.id) && hits.has(p.id)),
      filter,
      '',
      { now },
    ).map((p) => ({ ...p, docHit: hits.get(p.id) }));
    return own.concat(sortPlans(extra, sort));
  }

  /**
   * The sections of the roadmap. group 'horizon': one per horizon in roadmap order (keepEmpty keeps Waiting on you, Now,
   * Next, Later and Done for the columns). group 'area': one per area (the register's order, then "Without area"), the
   * plans in roadmap order, with the built share in words as the note.
   * @returns {{ id: string, title: string, entries: object[], count: number, note?: string }[]}
   */
  function roadmapSections(entries, { group = 'horizon', modules = [], keepEmpty = false, order = 'horizon' } = {}) {
    const list = entries ?? [];
    if (group === 'area') {
      // order 'given' (P4): a sort other than Roadmap order was chosen, so the plans keep the order they came in.
      // P5: a plan found only in its document (docHit) stays below the plans whose own words match.
      const hz = order === 'given' ? () => 0 : (p) => HORIZON_IDS.indexOf(horizonFor(p));
      const rank = (p) => (p.docHit ? HORIZON_IDS.length + 1 : 0) + hz(p);
      const ids = [...modules.map((m) => m.oid), WITHOUT_MODULE];
      return ids
        .map((oid) => {
          const own = list
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => (p.module ?? WITHOUT_MODULE) === oid)
            .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
            .map(({ p }) => p);
          const built = own.filter((p) => horizonFor(p) === 'done').length;
          return {
            id: oid,
            title: oid === WITHOUT_MODULE ? 'Without area' : (modules.find((m) => m.oid === oid)?.title ?? oid),
            entries: own,
            count: own.length,
            note: `${built} of ${own.length} built`,
          };
        })
        .filter((x) => x.count);
    }
    return HORIZONS.map((h) => {
      const own = list.filter((p) => horizonFor(p) === h.id);
      return { id: h.id, title: h.text, entries: own, count: own.length };
    }).filter((x) => x.count || (keepEmpty && HORIZON_CORE.includes(x.id)));
  }

  /**
   * How many rows a section shows (so 300+ plans stay readable): all while a search or filter is active; Inbox and
   * Waiting on you always all; Done and Dropped none until opened; the rest at most foldAfter (0 = never fold) until opened.
   */
  function sectionShown(id, n, { foldAfter = ROADMAP_FOLD_AFTER, expanded = false, active = false } = {}) {
    if (active || expanded || HORIZON_UNFOLDED.includes(id)) return n;
    if (id === 'done' || id === 'dropped') return 0;
    return foldAfter > 0 ? Math.min(n, foldAfter) : n;
  }

  /**
   * The layout of the roadmap: always one list below ROADMAP_NARROW (a phone gets no sideways scroll); else the
   * viewer's remembered choice, else plans.roadmapLayout, else auto (columns from ROADMAP_WIDE px).
   * @returns {'columns'|'list'}
   */
  function roadmapLayout({ width = ROADMAP_WIDE, choice = null, setting = 'auto' } = {}) {
    if (width < ROADMAP_NARROW) return 'list';
    if (choice === 'columns' || choice === 'list') return choice;
    if (setting === 'columns' || setting === 'list') return setting;
    return width >= ROADMAP_WIDE ? 'columns' : 'list';
  }

  /** The area's name for a plan (the module title), or null. */
  function areaTitle(p, modules = []) {
    if (!p?.module) return null;
    return modules.find((m) => m.oid === p.module)?.title ?? p.module;
  }

  /** The Details row on the plan page: "Now · Ready · M · PL-AUTH". */
  function detailsLine(p) {
    return [PRIORITY[p?.priority]?.text, MATURITY[p?.maturity] ?? p?.maturity, p?.size, p?.id]
      .filter(Boolean)
      .join(' · ');
  }

  /** The tasks of a plan in one sentence: "7 tasks: 3 done, 1 running, 3 waiting." (cancelled ones not counted). */
  function tasksSentence(p) {
    const q = (p?.queue ?? []).filter((o) => o.status !== 'cancelled');
    if (!q.length) return 'No tasks yet.';
    const done = q.filter((o) => o.column === 'built').length;
    const running = q.filter((o) => o.column === 'inProgress' || o.column === 'review').length;
    const waiting = q.length - done - running;
    const parts = [
      done ? `${done} done` : null,
      running ? `${running} running` : null,
      waiting ? `${waiting} waiting` : null,
    ].filter(Boolean);
    return `${q.length} ${q.length === 1 ? 'task' : 'tasks'}: ${parts.join(', ')}.`;
  }

  /** The search part Plans opens on for plans.startView (an unknown value opens the roadmap). */
  function startSearch(view) {
    if (view === 'overview') return '?room=plans&surface=overview';
    if (view === 'list') return '?room=plans';
    return '?room=plans&surface=roadmap';
  }

  /** The More views item the state shows (overview or a map), or null. */
  function moreViewNow(state) {
    if (state?.surface === 'overview') return 'overview';
    if (state?.surface === 'entries' && ['map', 'treeMap', 'dep'].includes(state.show)) return state.show;
    return null;
  }

  // In Node (the server and the tests): the document folders from queue.config.json. In the browser there is no require, and
  // plans.js sets the folders from /api/plans.
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    try {
      setReadFolders(require('./queueConfig.js').config().documentFolders);
    } catch {
      // Without configuration the default applies (docs/).
    }
  }

  return {
    PRIORITY,
    PRIORITIES,
    CATEGORY,
    MATURITY,
    SIZE,
    WAITING,
    DEADLINE,
    TABS,
    FACETS,
    WITHOUT_PROJECT,
    WITHOUT_MODULE,
    DONE_VIEWS,
    QUICK_FILTERS,
    PLAN_SORTS,
    cleanSort,
    sortPlans,
    filterButtonText,
    planProgress,
    emptyFilter,
    readUrl,
    writeUrl,
    countFilters,
    deadlineBand,
    legalOpen,
    waitingOn,
    searchMatch,
    filter: applyFilter,
    facetNumber,
    chips,
    progress,
    tree,
    summaryName,
    copyLine,
    breadcrumbs,
    entryLine,
    prepare,
    queueStatusText,
    searchParts,
    cardMatchesSearch,
    planToTasks,
    planFocus,
    sameView,
    cleanOwnView,
    projectInfo,
    plansData,
    planForTask,
    SURFACES,
    DOC_GROUP,
    DOC_STATUS,
    DOC_AUDIENCE,
    DOC_PRI,
    DOC_WARNING,
    DOC_SEVERITY,
    DOC_PUBLISHED,
    DOC_FACETS,
    emptyDocFilter,
    docSearchMatch,
    docFilter,
    docFacetNumber,
    docChips,
    countDocFilters,
    docGroups,
    timelineMonths,
    docLine,
    docBreadcrumbs,
    documentsData,
    MAP_COLUMNS,
    DEADLINE_DAYS,
    DRAFT_MAX,
    REASON_MAX,
    mapColumn,
    mapColumnFor,
    columnWithDraft,
    columnRules,
    mapEntries,
    mapGrid,
    moveInDraft,
    setDraftReason,
    cleanDraft,
    columnNeighbor,
    draftChanges,
    draftGroups,
    prioritizeCall,
    deadlineElements,
    deadlineRows,
    deadlineScale,
    deadlineText,
    // The folders the read view uses now (from the configuration in Node, from /api/plans in the browser).
    get READ_FOLDERS() {
      return readFolders.slice();
    },
    READ_FOLDERS_DEFAULT,
    setReadFolders,
    READ_MAX_BYTE,
    get UNREGISTERED_GROUPS() {
      return unregisteredGroupsDef();
    },
    unregisteredGroupsDef,
    readPathError,
    linkMeasure,
    inlineParts,
    cleanText,
    markdownBlocks,
    slug,
    anchorIndex,
    unregisteredGroups,
    entrySuggestion,
    newEntryFromForm,
    newEntryArgs,
    sourceBonus,
    sourceArgs,
    JB_SURFACES,
    LEGAL_STATUS,
    LEGAL_BLOCK,
    DPIA_TEXT,
    DEC_STATUS,
    DEC_TYPE,
    DEC_AMOUNT,
    DEC_FIRST,
    LEGAL_FACETS,
    DEC_FACETS,
    emptyJbFilter,
    jbFilter,
    jbFacetNumber,
    jbChips,
    countJbFilters,
    jbList,
    jbGroups,
    legalLine,
    ownerLine,
    jbBreadcrumbs,
    jbData,
    surfaceCount,
    resolveBody,
    MATURITY_MANUAL,
    MATURITY_GROUPS,
    PRIORITY_KEY,
    BULK_ACTIONS,
    BULK_MAX,
    PALETTE_ACTIONS,
    moduleSummary,
    areaCardLabel,
    AREA_LEGEND,
    waitingOnYou,
    nowAccess,
    capacityWarning,
    recentChanged,
    recentRegistered,
    workingNow,
    changedEntries,
    keyAction,
    CAPTURE,
    neighborEntry,
    priorityFromKey,
    paletteCandidates,
    paletteMatch,
    addToRecent,
    startLines,
    planBulkCall,
    undoCall,
    bulkText,
    VIEWS,
    DEP_MODE,
    SIZE_WEIGHT,
    WITHOUT_SIZE_WEIGHT,
    DEP_MAX,
    TREE_MAP_SURFACE,
    entryWeight,
    builtShare,
    entryOpen,
    treeMapLevel,
    treeMapFields,
    treeMapCells,
    treeMapSmall,
    trackText,
    treeMapText,
    planGraph,
    planNodeText,
    planGraphText,
    criticalPathText,
    // PLAN-3a-QA1
    roomChildren,
    // The Roadmap (P1 to P3)
    HORIZONS,
    HORIZON_CORE,
    ROADMAP_FOLD_AFTER,
    ROADMAP_WIDE,
    ROADMAP_NARROW,
    ROADMAP_LAYOUTS,
    START_VIEWS,
    MORE_VIEWS,
    horizonFor,
    planStatus,
    planNotes,
    clipWords,
    planSentence,
    documentLead,
    planSource,
    // Full-text search in the plan documents (P5)
    DOC_SEARCH_MIN,
    DOC_HIT_SIDE,
    documentPassages,
    passagesAt,
    docSearchPattern,
    documentHit,
    docSearchText,
    searchWithDocuments,
    roadmapSections,
    sectionShown,
    roadmapLayout,
    areaTitle,
    detailsLine,
    tasksSentence,
    startSearch,
    moreViewNow,
  };
});
