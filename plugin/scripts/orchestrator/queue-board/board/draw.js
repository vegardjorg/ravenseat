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

/**
 * Empty state for a list: shown when none of the cards match the search (also when the list was empty already).
 * When the list has cards but the search hides all of them, it is a quiet line without an action (UX review K4): the
 * one "Nothing matches" message with Clear search is above the columns (searchNone), not repeated in every column.
 */
function emptyText(summary, text) {
  const box = el('div', { class: 'empty empty-state' });
  searchBound(summary, (match) => {
    box.hidden = match.length > 0;
    if (box.hidden) return;
    if (summary.length > 0 && t.filter.search) box.replaceChildren(el('p', { text: 'No matches here.' }));
    else box.replaceChildren(...emptyContent(text, false));
  });
  return box;
}

/**
 * What an empty column on the flat board says (board step B7): one calm line about what goes there, not a blank box.
 * A lane cell keeps the short "Nothing here." (a long line in every lane would be noise).
 */
const COLUMN_EMPTY = {
  blocked: 'Nothing is blocked. Tasks with a blocker that needs action show here.',
  inProgress: 'Nothing in progress. Running and picked tasks show here.',
  review: 'Nothing to review. Delivered tasks wait here for review and merge.',
  built: 'Nothing built yet. Merged tasks show here.',
};

/**
 * The one message above the flat columns when the search matches nothing on the board (UX review K4): the reason and
 * Clear search, while the columns only show 0. `all` is every card the columns would show without the search.
 */
function searchNone(all) {
  const box = el('div', { class: 'empty empty-state search-empty', hidden: true });
  searchBound(all, (match) => {
    const none = !!t.filter.search && all.length > 0 && match.length === 0;
    box.hidden = !none;
    main.classList.toggle('search-none', none);
    if (none) box.replaceChildren(...emptyContent('', true));
  });
  return box;
}

/**
 * The content of a column (flat) or a cell (lane) for the given cards. The cards are filtered, but not
 * searched: the search hides cards, and the counters and empty texts follow the search via searchBound.
 * `column`: drawn as a flat column (the longer empty text from COLUMN_EMPTY), else a lane cell.
 */
function columnContent(col, summary, proposed, batch, column = false) {
  const parts = [];
  if (col === 'queue') {
    const readyOnes = summary.filter((k) => k.ready);
    const blocked = summary.filter((k) => !k.ready);
    const title = el('h3', { class: 'section-title' });
    // With the Blocked column on, what only waits here (depends_on, ownership, parking) is called Waiting, so the two
    // are not both called Blocked.
    const waitName = shownColumns().includes(BLOCKED_COLUMN) ? 'Waiting' : 'Blocked';
    searchBound(readyOnes, (match) => headingText(title, 'Ready now', match.length));
    parts.push(title, emptyText(readyOnes, 'Nothing is ready now.'));
    if (readyOnes.length) parts.push(groupedList(readyOnes, 'queue', 'ready'));
    if (blocked.length)
      parts.push(
        section(
          'blocked',
          blocked,
          waitName,
          () => groupedList(blocked, 'queue', 'blocked'),
        ),
      );
    if (proposed?.length)
      parts.push(
        section(
          'proposed',
          proposed,
          'Proposed',
          () => groupedList(proposed, 'proposed'),
        ),
      );
    // The batch queue on its own, grouped with the sum toward the target; the cards are not started alone.
    if (batch?.length)
      parts.push(
        section(
          'batch',
          batch,
          'Batch queue',
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
  const emptyLine = !column
    ? 'Nothing here.'
    : col === 'built' && hidden
      ? 'Nothing built in the last 7 days.'
      : (COLUMN_EMPTY[col] ?? 'Nothing here.');
  parts.push(emptyText(show, emptyLine));
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
 * "Take out of batch queue" makes the tasks their own tracks again, and the box selects the group for the selection menu.
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
        title: `Select ${who} for the selection menu (bulk actions)`,
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

/** Blocked is open from the start up to this many cards (UX review K1); above it, it starts closed (400+ cards). */
const FOLD_OPEN_LIMIT = 20;

/** Whether a fold starts open when the viewer has made no choice: Blocked up to FOLD_OPEN_LIMIT cards, Proposed never, the batch queue always. */
function foldOpenByDefault(name, count) {
  if (name === 'blocked') return count <= FOLD_OPEN_LIMIT;
  return name !== 'proposed';
}

/** Is the fold open: the viewer's own choice for the visit (t.folds), otherwise the default for this many cards. */
function foldIsOpen(name, count) {
  return t.folds.has(name) ? t.folds.get(name) : foldOpenByDefault(name, count);
}

/** "Ready now (4)": the name in the heading weight and the count in normal weight (the text reads the same). */
function headingText(e, label, n) {
  e.replaceChildren(`${label} `, el('span', { class: 'section-count', text: `(${n})` }));
}

let foldSeq = 0;

/**
 * A fold in a column (Blocked, Proposed, Batch queue), drawn as a disclosure (board step B25): a heading with a real
 * button that carries aria-expanded and aria-controls, a chevron, and the name with the count ("Blocked (5)"). Enter and
 * Space work because it is a button. The content is built only when the fold is open (`build()`), so a closed Blocked
 * with hundreds of cards costs nothing. The count follows the search, and the fold is hidden when none of the cards
 * match. `label` is the shown name; the chain line uses it too (data-label).
 */
function section(name, summary, label, build) {
  const id = `fold-${name}-${++foldSeq}`;
  let open = foldIsOpen(name, summary.length);
  const wrap = el('section', { class: 'section fold', 'data-section': name, 'data-label': label });
  const button = el('button', {
    type: 'button',
    class: 'fold-button',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': id,
  });
  const chevron = el('span', { class: 'fold-chevron', 'aria-hidden': 'true' });
  const count = el('span', { class: 'section-count' });
  button.append(chevron, `${label} `, count);
  const body = el('div', { class: 'fold-body', id, hidden: !open });
  wrap.append(el('h3', { class: 'section-title fold-title' }, button), body);
  searchBound(summary, (match) => {
    count.textContent = `(${match.length})`;
    wrap.hidden = !match.length;
  });
  let built = false;
  const fill = (afterDrawing) => {
    if (built) return;
    built = true;
    body.append(build());
    if (!afterDrawing) return;
    // Opened after drawing: the search, the chain and the tab stop are set on the new cards.
    useSearch(body);
    markChain();
  };
  if (open) fill(false);
  button.addEventListener('click', () => {
    open = !open;
    // The viewer's own choice: it holds for this fold name across redraws for the rest of the visit.
    t.folds.set(name, open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    if (open) fill(true);
    // The cards in a closed fold cannot be the tab stop, and the chain line names the fold as the cause.
    rovingSetup();
    drawStripe();
  });
  return wrap;
}

/** Opens every fold with this name on the board (the "Show" action in the chain line), and keeps it open for the visit. */
function openFold(name) {
  t.folds.set(name, true);
  const buttons = [...main.querySelectorAll(`[data-section="${CSS.escape(name)}"] > h3 > .fold-button`)];
  for (const b of buttons) if (b.getAttribute('aria-expanded') !== 'true') b.click();
  buttons[0]?.focus({ preventScroll: true });
  drawStripe();
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
    el('h2', { text: shownColumns().find((k) => k.key === col).name }),
    counter,
    // B30: the queue room has no header of its own, so its "?" sits in the In queue column header.
    col === 'queue' ? roomHelp('work', 'the queue') : null,
    col === 'queue' ? cloudBundleLine() : null,
  );
  if (col === 'inProgress') {
    const full = w.agents >= w.max;
    const wipText = window.QueueA11y.wipText(w);
    header.append(
      el('span', {
        class: `wip${full ? ' full' : ''}`,
        // Readable text ("Agents 3 of 4 · heavy 1 of 2"); the explanation is in the legend. In a narrow column the badge
        // ends in an ellipsis (board.css), so the title starts with the full text.
        text: wipText,
        title:
          `${wipText}. Agent slots in use (running and review), with the same rule as queue.mjs. Picked tasks and work ` +
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
  // The selection menu and "Select all matches" follow the state and the filter in all views.
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
  for (const col of ['queue', 'proposed', 'batch', 'blocked', 'inProgress', 'review', 'built'])
    filtered[col] = (k[col] ?? []).filter((x) => visibleWithoutSearch(x, col));
  // Four or five columns (the Blocked column); the grid in board.css reads the count.
  const columns = shownColumns();
  main.style.setProperty('--columns', String(columns.length));
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
      openDecisions,
      drawOnNew: draw,
      // The chain status line in the graph's top area (QA-1e Q6): its "Clear selection" and the hidden members.
      resetChain,
      chainCauses: () => {
        const selected = t.chain ? t.perId.get(t.chain)?.k : null;
        return selected?.chain ? chainCauseParts(selected) : [];
      },
    });
  } else if (t.view === 'flat') {
    const countedFor = (key) =>
      key === 'built' && !t.showMore ? filtered.built.filter((x) => x.recent) : filtered[key];
    // Every card the columns can show (In queue also holds Proposed and the batch queue): the search message reads it.
    const all = columns.flatMap(({ key }) =>
      key === 'queue' ? [...filtered.queue, ...filtered.proposed, ...filtered.batch] : countedFor(key),
    );
    main.append(searchNone(all));
    for (const { key, name } of columns) {
      const counted = countedFor(key);
      main.append(
        el(
          'section',
          {
            class: 'column',
            'data-col': key,
            'aria-label': name,
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
              true,
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
        columns.map(({ key }) => columnHeader(key, null)),
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
      for (const col of ['queue', 'batch', 'blocked', 'inProgress', 'review', 'built'])
        per[col] = filtered[col].filter((x) => x.project === p.pid);
      const visibleBuilt = t.showMore ? per.built : per.built.filter((x) => x.recent);
      const count =
        per.queue.length +
        per.batch.length +
        per.blocked.length +
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
      ol.append(laneEl(p, per, columns));
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
  // The selection menu was drawn before the board was rebuilt: place it next to its box on the new board.
  placeOptionMenu();
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

/**
 * Why each card in the chain is not visible (UX review K2): grouped as [{ cause, n, name?, key? }] for
 * QueueA11y.chainHidden. The order is the order a viewer undoes them in: the selection and the filter decide what is
 * built, then the search hides, then a closed fold, then Built's 7-day limit. Anything else is "not shown in this view"
 * (a proposal in Project lanes, or a task that is not on the board at all).
 */
function chainCauses(ids) {
  const groups = new Map();
  const add = (cause, extra = {}) => {
    const key = `${cause}|${extra.key ?? ''}`;
    if (!groups.has(key)) groups.set(key, { cause, n: 0, ...extra });
    groups.get(key).n++;
  };
  for (const id of ids) {
    const x = t.perId.get(id);
    if (!x) {
      add('elsewhere');
      continue;
    }
    const { k, col } = x;
    if (t.special && (MARKABLE_COLUMNS.has(col) || t.special === 'newEntry') && !SPECIAL[t.special](k))
      add('selection', { name: t.viewName ?? 'selection' });
    else if (!visibleWithoutSearch(k, col)) add('filter');
    else if (!searchMatch(k)) add('search');
    else {
      const f = closedFoldFor(k, col);
      if (f) add('fold', { key: f.dataset.section, name: f.dataset.label });
      else if (col === 'built' && !k.recent && !t.showMore) add('older');
      else add('elsewhere');
    }
  }
  return [...groups.values()];
}

/** The closed fold the card would be drawn in (Blocked, Proposed or Batch queue, in its lane in Project lanes), or null. */
function closedFoldFor(k, col) {
  const name = col === 'queue' && !k.ready ? 'blocked' : col === 'proposed' || col === 'batch' ? col : null;
  if (!name) return null;
  const scope = t.view === 'lanes' ? main.querySelector(`.lane[data-pid="${CSS.escape(k.project)}"]`) : main;
  const f = scope?.querySelector(`.section[data-section="${name}"]`);
  return f && f.querySelector('.fold-button')?.getAttribute('aria-expanded') === 'false' ? f : null;
}

/** The action next to a cause in the chain line. */
function chainReveal(action) {
  if (action.startsWith('fold:')) openFold(action.slice(5));
  else if (action === 'older') {
    t.showMore = true;
    draw();
  } else emptyAction(action);
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
  // One row (B27): "Next up" on the left (.stripe-next, which gives way) and the chain line on the right of the same
  // row, so choosing a card does not add a row and push the board down.
  const row = el('div', { class: 'stripe-row' });
  const next = el('div', { class: 'stripe-next' });
  const name = (text) => el('span', { class: 'stripe-name', text });
  // The search hides cards in Flat, Project lanes and Dependencies, so "Next up" there shows only the cards the search
  // keeps (UX review K4: it showed a card the empty search had hidden everywhere else), and says how many it hides.
  // The list itself is the server's (queueLogic), unchanged; only what is drawn follows the search.
  const searched = !!t.filter.search && ['flat', 'lanes', 'graph'].includes(t.view);
  const kept = (list) =>
    searched
      ? list.filter((v) => {
          const x = t.perId.get(v.id);
          return !x || searchMatch(x.k);
        })
      : list;
  const hiddenNote = (list, keptList) =>
    list.length > keptList.length
      ? el('span', {
          class: 'stripe-empty',
          text: `${list.length - keptList.length} hidden by the search`,
        })
      : null;
  if (!n) next.append(name('Next up'));
  else if (n.stop)
    next.append(
      name('Next up'),
      el('span', { class: 'badge old', text: n.text, title: n.message ?? n.text }),
    );
  else if (n.startable.length) {
    const shown = kept(n.startable);
    next.append(
      name(`Next up (${n.available} ${n.available === 1 ? 'free slot' : 'free slots'})`),
      ...shown.map(nextButton),
    );
    const note = hiddenNote(n.startable, shown);
    if (note) next.append(note);
  } else if (n.whenAvailable.length) {
    const shown = kept(n.whenAvailable);
    next.append(name('When a slot frees up'), ...shown.map(nextButton));
    const note = hiddenNote(n.whenAvailable, shown);
    if (note) next.append(note);
  } else
    next.append(
      name('Next up'),
      el('span', {
        class: 'stripe-empty',
        text: n.available ? 'Nothing is ready to start.' : 'Nothing is waiting for a slot.',
      }),
    );
  row.append(next);
  const selected = t.chain ? t.perId.get(t.chain)?.k : null;
  // Dependencies has its own chain status line in the graph's top area (graph.js, QA-1e Q6), with the same lead and
  // the same causes (chainCauseParts), so the strip leaves it out there: the chain is never explained twice.
  if (selected?.chain && t.view !== 'graph') {
    row.append(
      el(
        'div',
        { class: 'chain-line', role: 'status' },
        el('span', {
          class: 'stripe-name',
          text: `${window.QueueA11y.chainLead(selected.id, chainSize(selected))}: ${selected.chain.before.length} before, ${selected.chain.after.length} after`,
        }),
        // Why the other cards look gray (QA-1e Q6): .board.chain-active dims every card outside the chain.
        el('span', { class: 'stripe-name', text: '· the rest is faded' }),
        ...chainCauseParts(selected),
        el('span', { class: 'stripe-name', text: '· Esc clears' }),
        el('span', { class: 'draw-chain chain-for-draw', 'aria-hidden': 'true' }),
        el('span', { class: 'chain-explanation', text: 'before' }),
        el('span', { class: 'draw-chain chain-after-draw', 'aria-hidden': 'true' }),
        el('span', { class: 'chain-explanation', text: 'after' }),
        el('button', {
          type: 'button',
          class: 'link-button',
          text: 'Clear selection',
          onclick: resetChain,
        }),
      ),
    );
  }
  stripe.replaceChildren(row);
}

/** How many tasks the chain status line counts: the selected one with every task before and after it. */
function chainSize(selected) {
  return 1 + new Set([...selected.chain.before, ...selected.chain.after]).size;
}

/**
 * The chain members that are not visible right now, as the parts of a chain status line: one "· <cause>" span per
 * cause, each with its action right after it where there is one (Show opens the fold, Clear search, Remove filter,
 * Show all, Show more). Used by the strip in the card views and by graph.js in Dependencies (ctx.chainCauses).
 */
function chainCauseParts(selected) {
  const ids = [...selected.chain.before, ...selected.chain.after];
  // Drawn and visible: not hidden by the search and not inside a closed fold (a fold opened and closed again keeps
  // its cards in the DOM, under a hidden body). In Dependencies a node counts as drawn, a small gray neighbor too.
  const drawn = new Set(
    [...main.querySelectorAll('.summary:not([hidden]), .graph-svg .node')]
      .filter((e) => !e.closest('[hidden]'))
      .map((e) => e.dataset.id),
  );
  const causes = window.QueueA11y.chainHidden(chainCauses(ids.filter((id) => !drawn.has(id))));
  return causes.flatMap((c) => [
    el('span', { class: 'stripe-name', text: `· ${c.text}` }),
    c.action
      ? el('button', {
          type: 'button',
          class: 'link-button chain-reveal',
          text: c.label,
          'aria-label': c.aria,
          onclick: () => chainReveal(c.action),
        })
      : null,
  ]).filter(Boolean);
}
