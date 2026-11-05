// =============================================================
// draw.js: the empty states, the drawing of the columns, the chain around the chosen card and the strip
// above the columns ("Next up" and the chain).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Empty state ----
// All empty lists say why they are empty and have one action that shows the cards: "Clear search", "Remove filter"
// or "Show all" (selection). The rule is QueueA11y.emptyReason (a11y.js, tested in queueBoardA11y.test.ts).

/** The text and the button for an empty list. `searchHides`: the list has cards, but the search hides all of them. */
function emptyContent(text, searchHides) {
  const g = window.QueueA11y.emptyReason({
    text,
    searchHides,
    search: t.filter.search,
    filters: countFilters(),
    selection: t.viewName ?? null,
  });
  const parts = [el('p', { text: g.text })];
  if (g.action)
    parts.push(
      el('button', {
        type: 'button',
        class: 'link-button',
        text: g.label,
        onclick: (e) => {
          e.stopPropagation();
          emptyAction(g.action);
        },
      }),
    );
  return parts;
}

/** The shared emptyState as an element of its own (batch queue, Project lanes and the graph). */
function emptyState(text, searchHides = !!t.filter.search) {
  return el('div', { class: 'empty empty-state' }, ...emptyContent(text, searchHides));
}
// The graph (graph.js) uses the same empty state.
window.QueueEmpty = (text) => emptyState(text);

/** The action in emptyState. Focus goes to the control that was changed, so the keyboard does not lose its place. */
function emptyAction(action) {
  if (action === 'search') {
    const search = $('search');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    search.focus();
  } else if (action === 'filter') {
    for (const set of Object.values(t.filter.selected)) set.clear();
    changedFilter();
    $('filter-button').focus();
  } else if (action === 'selection') showAll();
}

/** Empty state for a list: shown when none of the cards match the search (also when the list was empty already). */
function emptyText(summary, text) {
  const box = el('div', { class: 'empty empty-state' });
  searchBound(summary, (match) => {
    box.hidden = match.length > 0;
    if (!box.hidden) box.replaceChildren(...emptyContent(text, summary.length > 0));
  });
  return box;
}

/**
 * The content of a column (flat) or a cell (lane) for the given cards. The cards are filtered, but not
 * searched: the search hides cards, and the counters and empty texts follow the search via searchBound.
 */
function columnContent(col, summary, proposed, batch) {
  const parts = [];
  if (col === 'queue') {
    const readyOnes = summary.filter((k) => k.ready);
    const blocked = summary.filter((k) => !k.ready);
    const title = el('h3', { class: 'section-title' });
    searchBound(readyOnes, (match) => (title.textContent = `Ready now (${match.length})`));
    parts.push(title, emptyText(readyOnes, 'Nothing is ready now.'));
    if (readyOnes.length) parts.push(groupedList(readyOnes, 'queue', 'ready'));
    if (blocked.length)
      parts.push(
        section(
          'blocked',
          blocked,
          (n) => `Blocked (${n})`,
          () => groupedList(blocked, 'queue', 'blocked'),
        ),
      );
    if (proposed?.length)
      parts.push(
        section(
          'proposed',
          proposed,
          (n) => `Proposed (${n})`,
          () => groupedList(proposed, 'proposed'),
        ),
      );
    // The batch queue on its own, grouped with the sum toward the target; the cards are not started alone.
    if (batch?.length)
      parts.push(
        section(
          'batch',
          batch,
          (n) => `Batch queue (${n})`,
          () => batchContent(batch),
        ),
      );
    return parts;
  }
  let show = summary;
  let hidden = 0;
  if (col === 'built' && !t.showMore) {
    show = summary.filter((k) => k.recent);
    hidden = summary.length - show.length;
  }
  parts.push(emptyText(show, 'Nothing here.'));
  if (show.length) parts.push(groupedList(show, col));
  if (col === 'built' && (hidden || t.showMore)) {
    const button = el('button', {
      type: 'button',
      class: 'button button-outline show-more',
      text: 'Show only the last 7 days',
      onclick: () => {
        t.showMore = !t.showMore;
        draw();
      },
    });
    if (!t.showMore)
      searchBound(
        summary,
        (match) => (button.textContent = `Show more (${match.filter((k) => !k.recent).length})`),
      );
    parts.push(button);
  }
  return parts;
}

/**
 * The batch queue grouped (project → class) with the sum of content minutes toward the class target, a bar with
 * the lower target marked, "Ready for packing" from the lower target, and the cards in the group. The groups come from
 * the server (queueLogic.batchGroups); here only those with visible cards after search and filter are shown.
 */
function batchContent(summary) {
  // The sums, the buttons and "hidden by the filter" follow the search, so the batch queue (which is small) is redrawn
  // in its own box when the search or the selection changes; the rest of the board stays.
  const box = el('div', { class: 'batch-box' });
  searchBound(summary, (match) => box.replaceChildren(batchGroups(match)));
  return box;
}

function batchGroups(summary) {
  const visibleOnes = new Map(summary.map((k) => [k.id, k]));
  const groups = (t.data.batchQueue ?? [])
    .map((g) => ({ g, summary: g.tasks.map((o) => visibleOnes.get(o.id)).filter(Boolean) }))
    .filter((x) => x.summary.length);
  if (!groups.length) return emptyState('Nothing here.');
  return el(
    'div',
    { class: 'batch-groups' },
    groups.map(({ g, summary: gk }) => {
      const p = project(g.pid);
      const max = g.measure?.max ?? 0;
      const share = max ? Math.min(g.sum / max, 1) : 0;
      const measureText = g.measure ? `${g.measure.min}–${g.measure.max}` : '?';
      const status = g.invalid
        ? `${g.class} is not packed`
        : g.ready
          ? g.over
            ? 'Ready for packing (becomes several tracks)'
            : 'Ready for packing'
          : `${g.measure.min - g.sum} min short`;
      return el(
        'section',
        {
          class: `batch-group${g.ready ? ' ready' : ''}`,
          'aria-label': `${p?.title ?? g.pid}, class ${g.class}: ${g.sum} of ${measureText} min. ${status}.`,
          '--p': `var(--color-${p?.color ?? 'category-graphite'})`,
        },
        el(
          'div',
          { class: 'batch-header' },
          el('span', { class: 'batch-name', text: g.pid, title: p?.title ?? g.pid }),
          el('span', {
            class: `badge${g.class === 'D+' ? ' class-dplus' : ''}`,
            text: g.class,
            title: window.QueueA11y.classLabel(g.class),
          }),
          g.ready && !g.invalid
            ? el('span', { class: 'badge ready-badge', text: status })
            : el('span', { class: 'batch-missing', text: status }),
        ),
        el(
          'div',
          {
            class: 'batch-bar',
            role: 'img',
            'aria-label': `${g.sum} of ${measureText} content minutes`,
            title: `Target for ${g.class}: ${measureText} min of content. Ready for packing from ${g.measure?.min ?? '?'} min.`,
          },
          el('span', { class: 'batch-fill', '--share': String(share) }),
          g.measure
            ? el('span', {
                class: 'batch-lower',
                '--lower': String(Math.min(g.measure.min / max, 1)),
              })
            : null,
        ),
        el('p', {
          class: 'batch-sum',
          text:
            `${g.sum} / ${measureText} min · ${g.count} ${g.count === 1 ? 'task' : 'tasks'}` +
            (g.common_files.length ? ` · ${g.common_files.length} common file(s)` : ''),
          title: g.common_files.length ? `Common files: ${g.common_files.join(', ')}` : null,
        }),
        batchButtons(g, gk),
        list(gk, 'batch', 'batch'),
      );
    }),
  );
}

/**
 * The buttons in a batch group. "Pack into track" shows the new track before it is created,
 * "Take out of batch queue" makes the tasks their own tracks again, and the box selects the group for the selection bar.
 * They apply to the cards shown (search and filter); the line says so when any in the group are hidden.
 */
function batchButtons(g, summary) {
  const ids = summary.map((k) => k.id);
  const hidden = g.count - ids.length;
  const allMarked = ids.length > 0 && ids.every((id) => t.marked.has(id));
  const canBePacked = !g.invalid && ids.length >= 2;
  const who = hidden
    ? `the ${ids.length} shown (${hidden} hidden by the filter)`
    : 'the whole group';
  return el(
    'div',
    { class: 'batch-buttons' },
    el(
      'label',
      {
        class: 'mark-group',
        title: `Select ${who} for the selection bar (bulk actions)`,
      },
      el('input', {
        type: 'checkbox',
        checked: allMarked,
        'aria-label': `Select the batch group ${g.pid} ${g.class}`,
        onchange: (e) => markMany(ids, e.target.checked),
      }),
      el('span', { text: 'Select' }),
    ),
    el('button', {
      type: 'button',
      class: 'button button-muted button-small',
      text: 'Pack into track',
      disabled: !canBePacked,
      title: g.invalid
        ? `${g.class} is not packed (D+ is never merged with others)`
        : ids.length < 2
          ? 'Packing requires at least two tasks. Take a single task out of the batch queue instead.'
          : `Merge ${who} into one new track. You see the new track before it is created.`,
      onclick: () => openBulk('batch-pack', ids),
    }),
    el('button', {
      type: 'button',
      class: 'button button-outline button-small',
      text: 'Take out of batch queue',
      title: `Take ${who} out of the batch queue, so they start as their own tracks. You see the change before it is saved.`,
      onclick: () => openBulk('batch-out', ids),
    }),
  );
}

/**
 * A section that can be closed (Blocked, Proposed, Batch queue). The content is built only when
 * the section is open (`build()`), so a closed Blocked costs nothing. The title (`title(count)`) follows the search,
 * and the section is hidden when none of the cards match.
 */
function section(name, summary, title, build) {
  const d = el('details', { class: 'section', 'data-section': name, open: !t.closed.has(name) });
  const sum = el('summary');
  searchBound(summary, (match) => {
    sum.textContent = title(match.length);
    d.hidden = !match.length;
  });
  d.append(sum);
  let built = false;
  const fill = (afterDrawing) => {
    if (built) return;
    built = true;
    d.append(build());
    if (!afterDrawing) return;
    // Opened after drawing: the search, the chain and the tab stop are set on the new cards.
    useSearch(d);
    markChain();
    rovingSetup();
  };
  if (d.open) fill(false);
  d.addEventListener('toggle', () => {
    if (d.open) {
      t.closed.delete(name);
      fill(true);
    } else t.closed.add(name);
  });
  return d;
}

/** The column header. `summary` is the cards the counter counts (filtered, the counter follows the search); null = no counter. */
function columnHeader(col, summary) {
  const w = t.data.wip;
  let counter = null;
  if (summary) {
    counter = el('span', { class: 'counter' });
    searchBound(summary, (match) => (counter.textContent = String(match.length)));
  }
  const header = el(
    'header',
    { class: 'col-header' },
    el('h2', { text: COLUMNS.find((k) => k.key === col).name }),
    counter,
    col === 'queue' ? cloudBundleLine() : null,
  );
  if (col === 'inProgress') {
    const full = w.agents >= w.max;
    header.append(
      el('span', {
        class: `wip${full ? ' full' : ''}`,
        // Readable text ("Agents 3 of 4 · heavy 1 of 2"); the explanation is in the legend.
        text: window.QueueA11y.wipText(w),
        title:
          'Agent slots in use (running and review), with the same rule as queue.mjs. Picked tasks and work ' +
          'outside the queue take no agent slot.',
      }),
    );
    // Night pause (night run off and inside the night window): no new ones start before the window is over.
    if (t.data.night?.stop)
      header.append(
        el('span', {
          class: 'badge old',
          text: `Night pause until ${t.data.night.to}`,
          title: t.data.night.message,
        }),
      );
  }
  return header;
}

// ---- Drawing ----
function draw() {
  t.pending = false;
  // The selection bar and "Select all matches" follow the state and the filter in all views.
  drawOptionLine();
  drawMarkMatch();
  const focus = document.activeElement?.closest?.('[data-id], [data-pid]');
  const focusKey = focus ? (focus.dataset.id ?? `lane:${focus.dataset.pid}`) : null;
  const scrolling = new Map(
    [...main.querySelectorAll('[data-scroll]')].map((e) => [e.dataset.scroll, e.scrollTop]),
  );
  const mainScroll = [main.scrollTop, main.scrollLeft];

  // The skeleton (columns, groups, lanes) is rebuilt, but the cards are fetched from the card buffer,
  // so only cards that are new or changed are built. The search and the selection bypass draw() (useSearch, updateMarking).
  t.searchDep = [];
  main.replaceChildren();
  main.className = `board ${t.view}${t.marked.size ? ' has-option' : ''}`;
  // Search and filter apply to the cards, not the statistics (and not the plan, which shows areas and projects).
  $('search-filter').hidden = ['statistics', 'cloud', 'plan', 'decisions', 'checks'].includes(t.view);
  // The grouping applies to Flat and Project lanes.
  $('grouping').hidden = !['flat', 'lanes'].includes(t.view);
  // Decisions (board/decide.js) draws its own list: no focus line, no stripe.
  if (t.view === 'decisions') {
    drawStripe();
    drawDecisions(false);
    return;
  }
  // Checks (board/checks.js) too. A redraw keeps the place on the page.
  if (t.view === 'checks') {
    drawStripe();
    drawChecks();
    main.scrollTop = mainScroll[0];
    return;
  }
  drawFocusLine();
  if (t.view === 'plan') {
    if (t.data) window.QueuePlan.draw(planContext());
    else
      main.append(
        el('p', {
          class: 'empty',
          text: t.error ? `Could not read the queue: ${t.error}` : 'Fetching the queue …',
        }),
      );
    drawStripe();
    [main.scrollTop, main.scrollLeft] = mainScroll;
    return;
  }
  if (t.view === 'cloud') {
    drawCloudQueue();
    drawStripe();
    [main.scrollTop, main.scrollLeft] = mainScroll;
    return;
  }
  if (t.view === 'statistics') {
    drawStatistics();
    drawStripe();
    [main.scrollTop, main.scrollLeft] = mainScroll;
    return;
  }
  if (!t.data) {
    main.append(
      el('p', {
        class: 'empty',
        text: t.error
          ? `Could not read the queue: ${t.error}`
          : t.key
            ? 'Fetching the queue …'
            : 'Missing key: open the link queue-board wrote in the terminal.',
      }),
    );
    return;
  }
  drawFilter();
  // A queue with nothing open (only done and cancelled tasks, or none): the onboarding card instead of empty columns.
  if ((t.view === 'flat' || t.view === 'lanes') && t.data.openTasks === 0) {
    main.append(onboardingCard());
    drawStripe();
    return;
  }
  const k = t.data.columns;
  // The filters decide what is built; the search hides afterward (useSearch). The graph uses visible() with the search itself.
  const filtered = {};
  for (const col of ['queue', 'proposed', 'batch', 'inProgress', 'review', 'built'])
    filtered[col] = (k[col] ?? []).filter((x) => visibleWithoutSearch(x, col));
  // The graph has no card nodes: the buffer is left untouched there, so the cards are ready when Flat or lanes show again.
  const withSummary = t.view !== 'graph';
  if (withSummary) summaryBuffer.start();

  if (t.view === 'graph') {
    // Dependencies: graph.js draws; the search and the filter menu apply here too (visible).
    window.QueueGraphView.draw({
      main,
      data: t.data,
      version: t.version,
      filterKey: JSON.stringify([
        Object.entries(t.filter.selected).map(([n, set]) => [n, [...set].sort()]),
        t.filter.search,
      ]),
      visible,
      el,
      openPanel,
      openInbox,
      drawOnNew: draw,
    });
  } else if (t.view === 'flat') {
    for (const { key } of COLUMNS) {
      const counted =
        key === 'built' && !t.showMore
          ? filtered.built.filter((x) => x.recent)
          : filtered[key];
      main.append(
        el(
          'section',
          {
            class: 'column',
            'data-col': key,
            'aria-label': COLUMNS.find((x) => x.key === key).name,
          },
          columnHeader(key, counted),
          el(
            'div',
            { class: 'col-body', 'data-scroll': key },
            columnContent(
              key,
              filtered[key],
              key === 'queue' ? filtered.proposed : null,
              key === 'queue' ? filtered.batch : null,
            ),
          ),
        ),
      );
    }
  } else {
    main.append(
      el(
        'div',
        { class: 'lane-headers' },
        COLUMNS.map(({ key }) => columnHeader(key, null)),
      ),
    );
    const ol = el('ol', { class: 'laneList', 'aria-label': 'Project lanes' });
    // Grouping "Area → project" sorts lanes by area (the area order, without area
    // last; otherwise the lane order is kept) and inserts a heading where the area changes.
    const areaBy = new Map();
    (t.data.areas ?? []).forEach((o, i) => {
      for (const pid of o.projects ?? []) areaBy.set(pid, { i, title: o.title ?? o.oid });
    });
    const withArea = t.grouping === 'area';
    const lanes = withArea
      ? t.data.projects
          .map((p, j) => ({ p, j, o: areaBy.get(p.pid) ?? { i: 9999, title: 'No area' } }))
          .sort((a, b) => a.o.i - b.o.i || a.j - b.j)
      : t.data.projects.map((p, j) => ({ p, j, o: null }));
    let previousArea = null;
    for (const { p, o } of lanes) {
      const per = {};
      // The batch queue is also shown in lanes (in the queue cell, as in flat view).
      for (const col of ['queue', 'batch', 'inProgress', 'review', 'built'])
        per[col] = filtered[col].filter((x) => x.project === p.pid);
      const visibleBuilt = t.showMore ? per.built : per.built.filter((x) => x.recent);
      const count =
        per.queue.length +
        per.batch.length +
        per.inProgress.length +
        per.review.length +
        visibleBuilt.length;
      if (!count && !t.filter.selected.projects.has(p.pid)) continue;
      if (withArea && o.title !== previousArea) {
        previousArea = o.title;
        ol.append(
          el(
            'li',
            {
              class: 'area-heading',
              role: 'presentation',
              title: `Area ${o.title}: the project lanes below belong to it. Edit areas with "Areas …" in Queue → Focus.`,
            },
            el('h2', { text: o.title }),
          ),
        );
      }
      ol.append(laneEl(p, per));
    }
    // The empty text is always there; afterSearch() shows it when no lane is visible (not even after the search).
    ol.append(el('li', { class: 'empty lane-empty', text: 'No cards with these filters.' }));
    main.append(ol);
  }
  if (withSummary) {
    t.lastDrawing = summaryBuffer.end(); // { reused, built, removed }: for debugging
    afterSearch();
  }

  for (const [key, top] of scrolling) {
    const e = main.querySelector(`[data-scroll="${key}"]`);
    if (e) e.scrollTop = top;
  }
  [main.scrollTop, main.scrollLeft] = mainScroll;
  if (focusKey) {
    const e = focusKey.startsWith('lane:')
      ? main.querySelector(`.lane[data-pid="${CSS.escape(focusKey.slice(5))}"] > .lane-header`)
      : main
          .querySelector(`.summary[data-id="${CSS.escape(focusKey)}"]`)
          ?.querySelector('.summary-button');
    e?.focus({ preventScroll: true });
  }
  markChain();
  drawStripe();
  if (t.selected) drawPanel();
}

// ---- The chain around the chosen card: predecessors and successors are highlighted, the rest is dimmed ----
/** Selects the card's chain (click or Enter). A card without a chain resets an earlier chain. */
function selectChain(id) {
  t.chain = t.perId.get(id)?.k.chain ? id : null;
  markChain();
  drawStripe();
}
function resetChain() {
  t.chain = null;
  markChain();
  drawStripe();
}
/** Sets the classes on the drawn cards. Is the card gone (done, removed)? Then the chain is reset. */
function markChain() {
  const k = t.chain ? t.perId.get(t.chain)?.k : null;
  if (!k?.chain) t.chain = null;
  const kj = t.chain ? k.chain : { before: [], after: [] };
  const forSet = new Set(kj.before);
  const afterSet = new Set(kj.after);
  main.classList.toggle('chain-active', !!t.chain);
  for (const e of main.querySelectorAll('.summary')) {
    const id = e.dataset.id;
    e.classList.toggle('chain-selected', id === t.chain);
    e.classList.toggle('chain-for', forSet.has(id));
    e.classList.toggle('chain-after', afterSet.has(id));
  }
  if (t.view === 'graph') window.QueueGraphView.mark(t.chain, t.chain ? kj : null);
}

// ---- The strip above the columns: "Next up" and the chain ----
const stripe = $('stripe');
function nextButton(v) {
  return el(
    'button',
    {
      type: 'button',
      class: 'next-summary',
      title: `${v.id}: ${v.title}`,
      onclick: () => openPanel(v.id),
    },
    el('span', { class: 'next-id', text: v.id }),
    el('span', { class: 'next-title', text: v.title }),
  );
}
function drawStripe() {
  stripe.hidden = t.view === 'statistics' || t.view === 'decisions' || t.view === 'checks' || !t.data;
  if (stripe.hidden) return;
  const n = t.data.next;
  const row = el('div', { class: 'stripe-row' });
  const name = (text) => el('span', { class: 'stripe-name', text });
  if (!n) row.append(name('Next up'));
  else if (n.stop)
    row.append(
      name('Next up'),
      el('span', { class: 'badge old', text: n.text, title: n.message ?? n.text }),
    );
  else if (n.startable.length)
    row.append(
      name(`Next up (${n.available} ${n.available === 1 ? 'free slot' : 'free slots'})`),
      ...n.startable.map(nextButton),
    );
  else if (n.whenAvailable.length)
    row.append(name('When a slot frees up'), ...n.whenAvailable.map(nextButton));
  else
    row.append(
      name('Next up'),
      el('span', {
        class: 'stripe-empty',
        text: n.available ? 'Nothing is ready to start.' : 'Nothing is waiting for a slot.',
      }),
    );
  const parts = [row];
  const selected = t.chain ? t.perId.get(t.chain)?.k : null;
  if (selected?.chain) {
    const ids = [...selected.chain.before, ...selected.chain.after];
    const drawn = new Set(
      [...main.querySelectorAll('.summary:not([hidden]), .graph-svg .node')].map((e) => e.dataset.id),
    );
    const hidden = ids.filter((id) => !drawn.has(id)).length;
    parts.push(
      el(
        'div',
        { class: 'stripe-row chain-line', role: 'status' },
        el('span', {
          class: 'stripe-name',
          text:
            `Chain for ${selected.id}: ${selected.chain.before.length} before, ${selected.chain.after.length} after` +
            (hidden ? ` · ${hidden} hidden by the filter` : '') +
            ' · Esc resets',
        }),
        el('span', { class: 'draw-chain chain-for-draw', 'aria-hidden': 'true' }),
        el('span', { class: 'chain-explanation', text: 'before' }),
        el('span', { class: 'draw-chain chain-after-draw', 'aria-hidden': 'true' }),
        el('span', { class: 'chain-explanation', text: 'after' }),
        el('button', {
          type: 'button',
          class: 'link-button',
          text: 'Reset',
          onclick: resetChain,
        }),
      ),
    );
  }
  stripe.replaceChildren(...parts);
}
