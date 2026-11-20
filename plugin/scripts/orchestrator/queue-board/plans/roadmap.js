// =============================================================
// plans/roadmap.js: the Roadmap (the start page of Plans) and the plan page (P1 and P2 of
// plans/plans-tab-ux-review-2026-11-19.md, concept B).
//
// The Roadmap reads top to bottom: one section per horizon (Inbox, Waiting on you, Now, Next, Later, Done), each plan a
// title, one plain sentence and a muted line with the status in words, the area and the next step. On a wide screen the
// horizons sit side by side as columns, with the Queue's column header (.col-header and .counter from board.css); on a
// narrow screen they are one list. The rules (which horizon, which words, how many rows) live in
// lib/queuePlanView.js; this file only draws them.
//
// The plan page puts the plan first: the title, the status sentence with the next step, the summary (or the lead
// from the plan document, marked), the actions, the plan document and the tasks. The technical facts (priority,
// maturity, size, id, sources, history) are last under Details, closed by default and remembered per viewer.
//
// Hooks for the later tracks (P4 to P9): the toolbar is one row a track can add a control to, the plan page's sections
// are separate functions, and the horizons come from V.HORIZONS, so a new one (for example a captured plan in the
// Inbox) needs no change here.
//
// The helpers come from plans.js (h): el, state, use, width, prefs/setPref (the viewer's layout, group and density,
// kept in the browser), isExpanded/toggleExpanded (the folded sections), detailsOpen/setDetailsOpen, activeFilters,
// copyButton, cliChip, tabContent, planDocument, showInQueue, search and date. All text is set with textContent.
// =============================================================
(function () {
  'use strict';
  const V = window.QueuePlanView;

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const filterActive = (t) => Boolean(t.search) || V.countFilters(t.filter) > 0;

  /** A row of toggle buttons in the Queue's .toggles style (aria-pressed shows the choice in use). */
  function toggles(h, label, cls, items) {
    return h.el(
      'div',
      { class: `toggles ${cls}`, role: 'group', 'aria-label': label },
      items.map((x) =>
        h.el('button', {
          type: 'button',
          class: 'toggles-button',
          'data-focus': `roadmap-pref:${label}:${x.text}`,
          'aria-pressed': x.pressed ? 'true' : 'false',
          text: x.text,
          onclick: x.onclick,
        }),
      ),
    );
  }

  /**
   * The toolbar: search, Filter and Sort (P4, plans/filter.js through h.filterControls), group by, layout (not on a
   * phone, see plans.css), density and the count. Below the tray width (600 px) Group by and Compact move into the one
   * "Filter and sort" tray, so the toolbar stays one short row.
   */
  function toolbar(h, d, match, layout, prefs) {
    const t = h.state();
    const narrow = h.width() < (window.QueuePlanFilter?.TRAY_BELOW ?? 600);
    const group = () =>
      toggles(h, 'Group by', 'roadmap-group', [
        { text: 'Horizon', pressed: prefs.group !== 'area', onclick: () => h.setPref({ group: 'horizon' }) },
        { text: 'Area', pressed: prefs.group === 'area', onclick: () => h.setPref({ group: 'area' }) },
      ]);
    const density = () =>
      toggles(h, 'Density', 'roadmap-density', [
        { text: 'Compact', pressed: Boolean(prefs.compact), onclick: () => h.setPref({ compact: !prefs.compact }) },
      ]);
    return h.el(
      'div',
      { class: 'roadmap-toolbar' },
      h.el('input', {
        type: 'search',
        class: 'roadmap-search',
        'aria-label': 'Search plans',
        placeholder: 'Search plans',
        'data-focus': 'search',
        value: t.search ?? '',
        oninput: (e) => h.search(e.target.value),
      }),
      h.filterControls?.({ sort: true, trayExtra: narrow ? [group(), density()] : [] }) ?? null,
      narrow ? null : group(),
      toggles(h, 'Layout', 'roadmap-layout', [
        { text: 'Columns', pressed: layout === 'columns', onclick: () => h.setPref({ layout: 'columns' }) },
        { text: 'List', pressed: layout === 'list', onclick: () => h.setPref({ layout: 'list' }) },
      ]),
      narrow ? null : density(),
      // the count leaves out the dropped ones (as the Roadmap tab does); they are folded at the bottom.
      h.el('span', {
        class: 'roadmap-count',
        text: plural(match.filter((p) => p.priority !== 'drop').length, 'plan', 'plans'),
      }),
    );
  }

  /** The muted line: the status in words, the area, the next step and the warnings, joined with " · ". */
  function cardLine(p, d) {
    const s = V.planStatus(p);
    return [s.text, V.areaTitle(p, d.modules ?? []), s.next, ...V.planNotes(p)].filter(Boolean).join(' · ');
  }

  /**
   * The progress of a plan with tasks: a small bar (decoration, aria-hidden) and the percent in words beside it, so it
   * never rests on color or length alone. `full` gives the whole sentence ("43% done, 3 of 7 tasks"), else "43% done".
   */
  function progress(h, p, { id = null, full = false, cls = '' } = {}) {
    const g = V.planProgress(p);
    if (!g) return null;
    return h.el(
      'p',
      { class: `plans-progress ${cls}`.trim(), id },
      h.el(
        'span',
        { class: 'plans-progress-bar', 'aria-hidden': 'true' },
        h.el('span', { class: 'plans-progress-fill', '--progress': `${g.percent}%` }),
      ),
      h.el('span', { class: 'plans-progress-text', text: full ? g.text : `${g.percent}% done` }),
    );
  }

  /** One plan on the roadmap: the title is the button (opens the plan page), the line describes it. */
  function card(h, d, p, compact) {
    const lineId = `roadmap-line-${p.id}`;
    const progressId = `roadmap-progress-${p.id}`;
    const sentence = V.planSentence(p);
    // the progress row only in the normal density (Compact keeps one line per plan)
    const bar = compact ? null : progress(h, p, { id: progressId, cls: 'roadmap-card-progress' });
    return h.el(
      'li',
      { class: `roadmap-card h-${V.horizonFor(p)}`, 'data-roadmap-entry': p.id },
      h.el('button', {
        type: 'button',
        class: 'roadmap-card-link',
        text: p.title || p.id,
        'data-focus': `roadmap:${p.id}`,
        'aria-describedby': bar ? `${lineId} ${progressId}` : lineId,
        onclick: () => h.use({ entry: p.id }),
      }),
      compact
        ? null
        : h.el('p', {
            class: `roadmap-card-sentence${sentence.from === 'document' ? ' from-document' : ''}${sentence.text ? '' : ' none'}`,
            title: sentence.from === 'document' ? 'From the plan document' : null,
            text: sentence.text ?? 'No summary yet',
          }),
      h.el('p', { class: 'roadmap-card-line', id: lineId, text: cardLine(p, d) }),
      bar,
    );
  }

  /** One section (a horizon or an area): the header with its count, the cards up to the fold, the fold button. */
  function section(h, d, sec, { compact, active, foldAfter }) {
    const expanded = h.isExpanded(sec.id);
    const shown = V.sectionShown(sec.id, sec.count, { foldAfter, expanded, active });
    const hidden = sec.count - shown;
    // Done and Dropped fold as a whole ("Show 3 done"); a long section folds its tail ("Show 4 more").
    const whole = sec.id === 'done' || sec.id === 'dropped' ? sec.id : null;
    let more = null;
    if (hidden > 0 || (expanded && !active && V.sectionShown(sec.id, sec.count, { foldAfter }) < sec.count)) {
      more = h.el('button', {
        type: 'button',
        class: 'roadmap-more',
        'aria-expanded': expanded ? 'true' : 'false',
        'data-focus': `roadmap-more:${sec.id}`,
        text: expanded
          ? whole
            ? `Hide ${whole}`
            : 'Show fewer'
          : whole
            ? `Show ${hidden} ${whole}`
            : `Show ${hidden} more`,
        onclick: () => h.toggleExpanded(sec.id),
      });
    }
    return h.el(
      'section',
      { class: `roadmap-section h-${sec.id}`, 'aria-label': `${sec.title}, ${plural(sec.count, 'plan', 'plans')}` },
      h.el(
        'div',
        { class: 'col-header' },
        h.el('h2', { text: sec.title }),
        h.el('span', { class: 'counter', 'aria-hidden': 'true', text: String(sec.count) }),
        sec.note ? h.el('span', { class: 'roadmap-section-note', text: sec.note }) : null,
      ),
      shown || !sec.count
        ? h.el(
            'ul',
            { class: 'roadmap-cards' },
            sec.entries.slice(0, shown).map((p) => card(h, d, p, compact)),
          )
        : null,
      !sec.count ? h.el('p', { class: 'roadmap-section-empty', text: 'Nothing here' }) : null,
      more,
    );
  }

  /** The empty states: no register, or nothing matches (names the search and offers to clear it). */
  function empty(h, d) {
    const t = h.state();
    if (!d.exists || !(d.entries ?? []).length)
      return h.el(
        'div',
        { class: 'empty' },
        h.el('p', { text: 'No plans yet. Ask Claude to register a plan with /plans, and it shows up here.' }),
      );
    return h.el(
      'div',
      { class: 'empty' },
      h.el('p', { text: t.search ? `No plans match "${t.search}".` : 'No plans match the filters.' }),
      h.el('button', {
        type: 'button',
        class: 'link-button',
        text: 'Clear the search and filters',
        onclick: () => h.use({ search: '', filter: V.emptyFilter() }),
      }),
    );
  }

  /**
   * The Roadmap.
   * @param h helpers from plans.js
   * @param d the /api/plans payload
   * @param match the entries after the filters and the search (V.filter)
   */
  function cells(h, d, match) {
    const t = h.state();
    const prefs = h.prefs();
    const view = d.view ?? {};
    const layout = V.roadmapLayout({ width: h.width(), choice: prefs.layout, setting: view.roadmapLayout });
    const active = filterActive(t);
    const foldAfter = Number.isInteger(view.roadmapFoldAfter) ? view.roadmapFoldAfter : V.ROADMAP_FOLD_AFTER;
    const compact = Boolean(prefs.compact);
    const wrap = h.el('div', { class: 'roadmap' }, toolbar(h, d, match, layout, prefs), h.activeFilters());
    if (!d.exists || !match.length) {
      wrap.append(empty(h, d));
      return wrap;
    }
    const sections = V.roadmapSections(match, {
      group: prefs.group === 'area' ? 'area' : 'horizon',
      modules: d.modules ?? [],
      keepEmpty: layout === 'columns' && !active,
      // P4: with a Sort other than Roadmap order, the plans keep the sorted order inside each section
      order: V.cleanSort(h.sort?.()) === 'roadmap' ? 'horizon' : 'given',
    });
    wrap.append(
      h.el(
        'div',
        { class: `roadmap-body roadmap-${layout}${compact ? ' compact' : ''}` },
        sections.map((sec) => section(h, d, sec, { compact, active, foldAfter })),
      ),
    );
    return wrap;
  }

  // ---- The plan page ---------------------------------------------------------------------------------------------

  function head(h, p) {
    const s = V.planStatus(p);
    const notes = V.planNotes(p);
    return h.el(
      'div',
      { class: 'plans-page-head' },
      h.el('button', {
        type: 'button',
        class: 'link-button plans-page-back',
        text: 'Back to the roadmap',
        'data-focus': 'page-back',
        onclick: () => h.use({ entry: null }),
      }),
      // tabindex -1: plans.js moves focus here when the page opens, so a screen reader starts at the title.
      h.el('h2', { tabindex: '-1', 'data-focus': 'page-title', text: p.title || p.id }),
      h.el('p', { class: 'plans-page-status', text: s.next ? `${s.text}. Next: ${s.next}.` : `${s.text}.` }),
      progress(h, p, { full: true, cls: 'plans-page-progress' }),
      notes.length ? h.el('p', { class: 'plans-page-notes', text: notes.join(' · ') }) : null,
    );
  }

  /** The person's summary in full, else the lead from the plan document with where it came from. */
  function summary(h, p) {
    if (p.summary) return [h.el('p', { class: 'plans-page-summary', text: p.summary })];
    if (p.lead?.text)
      return [
        h.el('p', { class: 'plans-page-summary from-document', text: p.lead.text }),
        h.el('p', {
          class: 'plans-page-from',
          text: `From the plan document${p.lead.path ? `, ${p.lead.path}${p.lead.anchor ? ` ${p.lead.anchor}` : ''}` : ''}`,
        }),
      ];
    return [
      h.el('p', {
        class: 'plans-page-summary none',
        text: 'No summary yet. Claude writes one when the plan is shaped.',
      }),
    ];
  }

  /** The actions: open the entry in the full Plan entries view; the CLI lines are chips under More. */
  function actions(h, d, p) {
    const prep = V.prepare(p, d);
    return h.el(
      'div',
      { class: 'plans-page-actions' },
      h.el('button', {
        type: 'button',
        class: 'toggles-button',
        text: 'Open in Plan entries',
        onclick: () => h.use({ surface: 'entries', entry: p.id }),
      }),
      h.el(
        'details',
        { class: 'plans-page-more' },
        h.el('summary', { text: 'More' }),
        h.el('p', { class: 'plans-page-hint', text: 'Work on the plan in Claude Code:' }),
        h.cliChip(V.entryLine(p, d)),
        h.el('p', { class: 'plans-page-hint', text: 'Turn it into queue tasks:' }),
        h.cliChip(prep.line),
        prep.warnings.length
          ? h.el(
              'ul',
              { class: 'plans-page-warnings' },
              prep.warnings.map((w) => h.el('li', { text: w })),
            )
          : null,
      ),
    );
  }

  function documentSection(h, p) {
    return h.el(
      'section',
      { class: 'plans-page-doc', 'aria-label': 'The plan document' },
      h.el('h3', { text: 'The plan document' }),
      h.planDocument(p),
    );
  }

  function tasks(h, p) {
    const q = (p.queue ?? []).filter((o) => o.status !== 'cancelled');
    return h.el(
      'section',
      { class: 'plans-page-tasks', 'aria-label': 'Tasks' },
      h.el('h3', { text: 'Tasks' }),
      h.el('p', { text: V.tasksSentence(p) }),
      q.length
        ? h.el(
            'ul',
            { class: 'plans-page-task-list' },
            // One row per task: the title on the left, its status on the right in the same row (plans.css), a divider
            // between rows, so a status never reads as a heading for the next task. The status describes its button.
            q.map((o) => {
              const statusId = `plans-page-task-status-${String(o.id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
              return h.el(
                'li',
                { class: 'plans-page-task' },
                h.el('button', {
                  type: 'button',
                  class: 'link-button',
                  text: `${o.id} ${o.title ?? ''}`.trim(),
                  title: 'Show in the Queue',
                  'aria-describedby': statusId,
                  onclick: () => h.showInQueue(o.id),
                }),
                h.el('span', { class: 'plans-page-task-status', id: statusId, text: V.queueStatusText(o) }),
              );
            }),
          )
        : null,
    );
  }

  /** Open owner questions and legal points, only when there are any. */
  function questions(h, d, p) {
    const open = (p.ownerQuestions ?? []).filter((q) => !q.resolved).length;
    if (!open && !p.legal_open) return null;
    return h.el(
      'section',
      { class: 'plans-page-questions', 'aria-label': 'Questions and legal points' },
      h.el('h3', { text: 'Questions and legal points' }),
      open ? h.tabContent('decisions', p, d) : null,
      p.legal_open ? h.tabContent('legal', p, d) : null,
    );
  }

  /** Details: the technical facts, closed by default, the open state remembered (the task panel's .panel-details). */
  function details(h, d, p) {
    const det = h.el(
      'details',
      { class: 'panel-details plans-page-details', open: h.detailsOpen() },
      h.el('summary', null, 'Details', h.el('span', { class: 'panel-details-hint', text: V.detailsLine(p) })),
      h.tabContent('summary', p, d, { withSummary: false }),
      h.tabContent('history', p, d),
    );
    det.addEventListener('toggle', () => h.setDetailsOpen(det.open));
    return det;
  }

  /**
   * The plan page.
   * @param h helpers from plans.js
   * @param d the /api/plans payload
   * @param p the entry
   */
  function page(h, d, p) {
    // The reading order stays the plan first: head, summary, actions, questions, the document, then tasks and Details.
    // On a wide screen (plans.css, from 1200 px) the tasks and Details sit in a side column beside the document, so
    // the document keeps a readable line length and the space beside it is used.
    return h.el(
      'article',
      { class: 'plans-page', 'aria-label': p.title || p.id },
      h.el(
        'div',
        { class: 'plans-page-main' },
        head(h, p),
        summary(h, p),
        actions(h, d, p),
        questions(h, d, p),
        documentSection(h, p),
      ),
      h.el('div', { class: 'plans-page-side' }, tasks(h, p), details(h, d, p)),
    );
  }

  window.QueuePlanRoadmap = { cells, page };
})();
