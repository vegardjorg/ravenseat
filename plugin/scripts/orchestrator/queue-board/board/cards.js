// =============================================================
// cards.js: the filters, the search without a rebuild, the card, the card buffer and the cloud checkbox on
// the cards (the "Suitable for cloud" filter).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Filters ----
function visible(k, col) {
  return visibleWithoutSearch(k, col) && searchMatch(k);
}

/** The search alone (the search hides cards with `hidden`, while the filters decide what is built). */
function searchMatch(k) {
  if (!t.filter.search) return true;
  return `${k.id} ${k.title} ${k.feature ?? ''} ${k.project}`
    .toLowerCase()
    .includes(t.filter.search);
}

/** The filters and views without the search: the cards built in Flat and Project lanes. */
function visibleWithoutSearch(k, col) {
  // A built-in view (t.special) filters the cards in queue, proposed and the batch queue. "New since last"
  // applies to all columns. t.special is null until the views are set up, so SPECIAL is never used before it exists.
  if (t.special && (MARKABLE_COLUMNS.has(col) || t.special === 'newEntry') && !SPECIAL[t.special](k))
    return false;
  for (const s of FILTER_SECTIONS) {
    const selected = t.filter.selected[s.key];
    if (!selected?.size) continue;
    const activeOnes = s.option().filter((v) => selected.has(v.val));
    if (!activeOnes.length) continue; // a saved option that no longer exists (e.g. a removed project)
    const ok =
      s.mode === 'all'
        ? activeOnes.every((v) => v.matches(k, col))
        : activeOnes.some((v) => v.matches(k, col));
    if (!ok) return false;
  }
  return true;
}

// ---- The search without rebuilding ----
/**
 * Registers something that depends on the search: `update(match)` gets the cards in `summary` that match the search, now
 * and every time the search changes. Used for counters, empty texts, groups and lanes; the cards themselves are hidden in useSearch().
 */
function searchBound(summary, update) {
  t.searchDep.push({ summary, update });
  update(t.filter.search ? summary.filter(searchMatch) : summary);
}

/**
 * The search has changed: hide and show the built cards (hidden), and update what is registered with searchBound.
 * No card is rebuilt. `root` limits the cards to a part of the board (a section that was just built).
 */
function useSearch(root = main) {
  for (const li of root.querySelectorAll('.summary[data-id]')) {
    const x = t.perId.get(li.dataset.id);
    li.hidden = !!x && !searchMatch(x.k);
  }
  if (root !== main) return;
  updateSearchDep();
  afterSearch();
}

/** Runs what is registered with searchBound (the search or the selection has changed). */
function updateSearchDep() {
  for (const a of t.searchDep) a.update(t.filter.search ? a.summary.filter(searchMatch) : a.summary);
}

/**
 * After drawing and after the search: an area heading with no visible lanes below it is hidden, the empty text in
 * Project lanes is shown only when no lane is visible, and every column gets its tab stop (rovingSetup).
 */
function afterSearch() {
  let heading = null;
  let visibleUnder = false;
  let visibleLanes = 0;
  let empty = null;
  for (const li of main.querySelectorAll(':scope > .laneList > li')) {
    if (li.classList.contains('lane-empty')) empty = li;
    else if (li.classList.contains('area-heading')) {
      if (heading) heading.hidden = !visibleUnder;
      heading = li;
      visibleUnder = false;
    } else if (!li.hidden) {
      visibleUnder = true;
      visibleLanes++;
    }
  }
  if (heading) heading.hidden = !visibleUnder;
  if (empty) {
    empty.hidden = visibleLanes > 0;
    // The shared emptyState (the reason and the action), built when it is shown.
    if (!empty.hidden) empty.replaceChildren(emptyState('No cards here.'));
  }
  rovingSetup();
}

function project(pid) {
  return t.data?.projects.find((p) => p.pid === pid) ?? null;
}

// ---- The card ----
/** The tooltip for aging work: over p85 for the class. */
function agingText(k) {
  const a = k.aging;
  if (!a) return null;
  return a.measure === 'work'
    ? `Older than usual: 85 % of ${k.class} tasks in the last 14 days were delivered within ` +
        `${duration(a.limit)} of starting. This one has been running for ${duration(a.age)}.`
    : `Older than usual: 85 % of ${k.class} tasks in the last 14 days were finished within ` +
        `${duration(a.limit)} of starting. This one started ${duration(a.age)} ago.`;
}

/** The tooltip and hidden text for a SILENT track (cq show says the same, with what to do). */
function silentText(k) {
  if (!k.silent) return null;
  return (
    `Silent for ${duration(k.silent.minutes)}: no commit, file change or transcript write. Check the track, then ` +
    `cq resume ${k.id} --reason context, or stop it.`
  );
}

function footerFor(k, col) {
  const footer = [];
  if (col === 'queue') {
    if (k.ready) footer.push(el('span', { class: 'badge ready-badge', text: 'Ready now' }));
    else {
      const h = k.blockers[0] ?? '';
      const more = k.blockers.length > 1 ? ` (+${k.blockers.length - 1})` : '';
      footer.push(
        el('span', { class: 'blocker', text: h + more, title: k.blockers.join('\n') }),
      );
    }
  } else if (col === 'proposed') {
    footer.push(el('span', { text: k.added_by ? `proposed by ${k.added_by}` : 'proposed' }));
  } else if (col === 'batch') {
    // Not started alone; the orchestrator packs the group into a track (queue.mjs batch pack).
    footer.push(
      el('span', {
        text: k.status === 'proposed' ? 'proposed in the batch queue' : 'packed into a track',
      }),
    );
  } else if (col === 'inProgress') {
    // A card in a cloud session gets a small cloud badge instead of "picked by cloud".
    if (k.in_cloud)
      footer.push(
        el('span', {
          class: 'badge cloud-badge',
          text: 'Cloud',
          title: k.cloud_session?.execution ? `Cloud session: ${k.cloud_session.execution}` : 'Running in a cloud session',
        }),
      );
    const who = k.in_cloud
      ? 'in the cloud'
      : k.status === 'picked'
        ? `picked by ${k.picked_by ?? '?'}`
        : k.status === 'external'
          ? `outside the queue: ${k.external_name ?? '?'}`
          : 'running';
    footer.push(el('span', { text: who }));
    if (k.start)
      footer.push(
        el('span', {
          'data-start': k.start,
          class: k.aging ? 'age-over' : null,
          title: k.aging ? 'Running longer than 85 % of finished tasks of this class' : null,
          text: age(k.start),
        }),
      );
    if (k.old) footer.push(el('span', { class: 'badge old', text: 'old', title: 'Picked over 72 hours ago with no commits on its branch' }));
    // SILENT: the agent has a worktree, but no commit, file change or transcript write for a while.
    if (k.silent)
      footer.push(
        el('span', {
          class: 'badge tone-warn silent-badge',
          text: 'silent',
          title: silentText(k),
        }),
      );
  } else if (col === 'review') {
    if (k.delivered)
      footer.push(
        el('span', {
          class: k.aging ? 'age-over' : null,
          title: k.aging ? 'Waiting in review longer than 85 % of finished tasks of this class' : null,
          text: `delivered ${age(k.delivered)} ago`,
        }),
      );
  } else if (col === 'built') {
    if (k.qa_status === 'waiting')
      footer.push(el('span', { class: 'badge qa', text: 'Waiting for QA' }));
    else if (k.qa_status === 'deviation')
      footer.push(el('span', { class: 'badge deviation', text: 'QA deviation' }));
    // A verified task gets no badge: only what the owner should notice stands out on the card.
    if (k.verification === 'unverified')
      footer.push(el('span', { class: 'badge deviation', title: 'No gates, no done command and no agent review ran', text: 'Merged, not verified' }));
    else if (k.verification === 'audited')
      footer.push(el('span', { class: 'badge qa', title: 'An agent reviewed the change, but no check ran', text: 'Audited' }));
    if (k.done) footer.push(el('span', { text: `done ${age(k.done)} ago` }));
  }
  return footer;
}

/** The project name on the card is redundant in Project lanes and when Flat is grouped by project. */
function showProjectName() {
  if (t.view === 'lanes') return false;
  return !['area', 'feature'].includes(t.grouping);
}

function summaryEl(k, col) {
  const movable = col === 'queue';
  const p = project(k.project);
  const classes = ['summary'];
  if (col === 'queue') classes.push(k.ready ? 'ready' : 'blocked');
  if (col === 'batch') classes.push('batchCard');
  if (k.aging) classes.push('aging');
  // Cards that can be bulk edited (waiting, proposed, batch queue) get a checkbox.
  const canBeMarked = MARKABLE_COLUMNS.has(col);
  if (canBeMarked && t.marked.has(k.id)) classes.push('marked');
  const statusText =
    col === 'queue'
      ? k.ready
        ? 'ready now'
        : `blocked: ${k.blockers.join('; ')}`
      : col === 'batch'
        ? 'in the batch queue, packed into a track'
        : k.status;
  // "Unlocks N": not on Built, where the card itself is done.
  const lockState = col !== 'built' ? k.unlocks : null;
  const lockText = lockState
    ? `Unlocks ${lockState.count} ${lockState.count === 1 ? 'task' : 'tasks'} (${duration(lockState.minutes)} estimated) via the chain`
    : null;
  // The button (the title) is described by the metadata and the footer. What is otherwise only in tooltips
  // (all the blockers, unlocks, older than usual) is added as hidden text among the metadata.
  const metaId = `summary-meta-${col}-${k.id}`;
  const footerId = `summary-footer-${col}-${k.id}`;
  const hiddenText = [
    col === 'queue' && !k.ready && k.blockers.length > 1 ? statusText : null,
    col === 'batch' ? statusText : null,
    lockText,
    k.aging ? 'Older than usual for the class' : null,
    k.silent ? silentText(k) : null,
  ]
    .filter(Boolean)
    .join('. ');
  return el(
    'li',
    {
      // The card itself is not focusable and has no aria-label overriding its content.
      // The title is the button (roving tabindex), and the metadata describes it (aria-describedby).
      class: classes.join(' '),
      draggable: movable ? 'true' : null,
      'data-id': k.id,
      'data-col': col,
      'data-markable': canBeMarked ? '1' : null,
      '--p': `var(--color-${k.color})`,
      title: [
        `${p?.title ?? k.project}${k.feature ? ` · ${k.feature}` : ''}`,
        agingText(k),
      ]
        .filter(Boolean)
        .join('\n'),
    },
    el(
      'div',
      { class: 'summary-header' },
      // The checkbox sits outside the button and outside the metadata (it has its own label).
      canBeMarked ? markBox(k) : null,
      el(
        'span',
        { class: 'summary-meta', id: metaId },
        el('span', { class: 'summary-id', text: k.id }),
        // The project's short name as text (the color stripe alone has too low contrast), but not when
        // the cards are already grouped per project.
        showProjectName()
          ? el('span', {
              class: 'summary-project',
              text: k.project,
              title: p?.title ?? k.project,
            })
          : null,
        // The plan entry the card belongs to. A click switches to Plans with the entry open. The badge is not a
        // tab stop of its own (roving tabindex); with the keyboard the way goes via "Plan entry" in detailPanel.
        k.plan
          ? el('button', {
              type: 'button',
              class: 'badge plan-entry-badge',
              tabindex: '-1',
              text: k.plan,
              title: `Plan entry ${k.plan}: open in Plans`,
              onclick: (e) => {
                e.stopPropagation();
                window.QueuePlans?.openEntry(k.plan);
              },
            })
          : null,
        k.class
          ? el('span', {
              class: `badge${k.class === 'D+' ? ' class-dplus' : ''}`,
              text: k.class,
              title: window.QueueA11y.classLabel(k.class),
              'aria-label': window.QueueA11y.classLabel(k.class),
            })
          : null,
        el('span', { class: 'badge', text: `${k.estimate} min`, title: 'Estimated work minutes for an agent, not wall-clock time' }),
        k.visual ? el('span', { class: 'badge visual', text: 'visual', title: 'Needs a manual visual check after merge (the QA list)' }) : null,
        k.parked
          ? el('span', {
              class: 'badge wait-badge',
              text: 'on hold',
              title: waitText(k.parked),
            })
          : null,
        lockState
          ? el('span', {
              class: 'badge locks',
              text: `unlocks ${lockState.count}`,
              title: lockText,
            })
          : null,
        col === 'queue' && !k.ready ? icon('lock', 'blocked') : null,
        hiddenText ? el('span', { class: 'hidden-for-eye', text: hiddenText }) : null,
      ),
      col === 'queue' && cloudFilterOn() && k.cloud?.suitable ? cloudSelect(k) : null,
    ),
    el(
      'p',
      { class: 'summary-title' },
      el('button', {
        type: 'button',
        class: 'summary-button',
        tabindex: '-1', // rovingSetup() makes one card per column the tab stop
        'aria-describedby': `${metaId} ${footerId}`,
        text: k.title,
      }),
    ),
    el('p', { class: 'summary-footer', id: footerId }, footerFor(k, col)),
  );
}

// ---- The card buffer ----
// The board does not rebuild the cards when they are unchanged: the node is reused by column and task id, and only cards
// that changed are built (window.QueuePerformance.makeSummaryBuffer, the diff is tested in vitest). The selection and the
// search are outside the signature; they are set on the node every time (syncSummary), so selecting or searching builds no card.
const summaryBuffer = window.QueuePerformance.makeSummaryBuffer();

/** Everything the card's DOM depends on, except the selection, the search and the chain (those are set on the node afterward). */
function summarySignature(k, col) {
  return JSON.stringify([
    k,
    col,
    project(k.project)?.title ?? null,
    showProjectName(),
    col === 'queue' && cloudFilterOn() && k.cloud?.suitable ? t.cloudSelected.has(k.id) : null,
    // The age in the text (In progress is also updated by the clock, see setInterval at the bottom).
    k.delivered ? age(k.delivered) : null,
    k.done ? age(k.done) : null,
  ]);
}

/** The node for the card: reused when unchanged, otherwise built. Selection and search are set on it here. */
function summaryNode(k, col) {
  const node = summaryBuffer.node(`${col}|${k.id}`, summarySignature(k, col), () => summaryEl(k, col));
  syncSummary(node);
  return node;
}

/** Sets the selection and the search on an existing card node (no rebuild). */
function syncSummary(node) {
  const id = node.dataset.id;
  const x = t.perId.get(id);
  if (x) node.hidden = !searchMatch(x.k);
  if (!node.dataset.markable) return;
  const marked = t.marked.has(id);
  node.classList.toggle('marked', marked);
  const box = node.querySelector('.mark-box input');
  if (box && box.checked !== marked) box.checked = marked;
}

// ---- Cloud ----
const cloudFilterOn = () => featureOn('cloud') && !!t.filter.selected.show?.has('cloud');

/** The checkbox on a cloud-suitable card (only with the "Suitable for cloud" filter). */
function cloudSelect(k) {
  return el(
    'label',
    { class: 'cloud-select', title: 'Include in the cloud bundle' },
    el('input', {
      type: 'checkbox',
      checked: t.cloudSelected.has(k.id),
      'aria-label': `Include ${k.id} in the cloud bundle`,
      tabindex: '-1', // roving tabindex: only the card that is the stop in the column
      onchange: (e) => {
        if (e.target.checked) t.cloudSelected.add(k.id);
        else t.cloudSelected.delete(k.id);
        draw();
      },
    }),
    el('span', { text: 'Cloud' }),
  );
}

/** The checked ones that are still cloud-suitable and in the queue (a card may have moved since). */
function cloudSelected() {
  const out = [];
  for (const id of t.cloudSelected) {
    const x = t.perId.get(id);
    if (x && x.col === 'queue' && x.k.cloud?.suitable) out.push(id);
    else t.cloudSelected.delete(id);
  }
  return out;
}

/** Fetches the cloud package (one task or a bundle) via the server (queue.mjs cloud-package) and copies it. */
async function copyCloudPackage(ids) {
  try {
    const q = ids.map((x) => `id=${encodeURIComponent(x)}`).join('&');
    const d = await api(`/api/cloudPackage?${q}`);
    t.cloudPackage = { ids: [...ids], text: d.text, copied: false };
    try {
      await navigator.clipboard.writeText(d.text);
      t.cloudPackage.copied = true;
      message(
        `The cloud package for ${ids.join(', ')} is copied. Paste it into a cloud session, and press "Started in cloud".`,
      );
    } catch {
      message('Could not copy automatically: select the text in the field and copy it yourself.', true);
    }
  } catch (e) {
    message(e.message, true);
  }
  draw();
  if (t.selected) drawPanel(true);
}

/** The fallback when the clipboard does not work: the package in a text field, only for the same ids. */
function cloudPackageField(ids) {
  const p = t.cloudPackage;
  if (!p || p.copied || p.ids.join(' ') !== ids.join(' ')) return null;
  return el(
    'div',
    { class: 'field cloud-package-field' },
    el('label', { for: 'cloud-package-text', text: 'Cloud package (select all and copy)' }),
    el('textarea', { id: 'cloud-package-text', rows: 6, readonly: true, text: p.text }),
  );
}

/** The line above In queue with the checked ones: copy the bundle package, register the start, or clear the selection. */
function cloudBundleLine() {
  if (!cloudFilterOn()) return null;
  const ids = cloudSelected();
  if (!ids.length)
    return el('p', {
      class: 'cloud-bundle empty',
      text: 'Check up to 4 cards to send them as one cloud bundle.',
    });
  const sum = ids.reduce((s, id) => s + (t.perId.get(id)?.k.estimate ?? 0), 0);
  return el(
    'div',
    { class: 'cloud-bundle' },
    el('span', { text: `${ids.length} selected for cloud · ${sum} min` }),
    el('button', {
      type: 'button',
      class: 'button button-filled',
      text: 'Copy cloud package',
      onclick: () => copyCloudPackage(ids),
    }),
    el('button', {
      type: 'button',
      class: 'button button-muted',
      text: 'Started in cloud',
      onclick: async () => {
        if (await action({ type: 'cloud-start', ids }, `${ids.join(', ')} started in the cloud`))
          t.cloudSelected.clear();
      },
    }),
    el('button', {
      type: 'button',
      class: 'button button-outline',
      text: 'Clear',
      onclick: () => {
        t.cloudSelected.clear();
        draw();
      },
    }),
    cloudPackageField(ids),
  );
}

/** The cloud part of detailPanel: suitability and the cloud session. */
function cloudFacts(k) {
  // With the cloud module off only a task that really is (or was) in the cloud says so.
  if (!featureOn('cloud') && !k.in_cloud && !k.cloud_session) return null;
  if (k.in_cloud) {
    const s = k.cloud_session ?? {};
    return [
      `In the cloud for ${s.started ? age(s.started) : '?'}`,
      s.execution ? ' · ' : null,
      s.execution ? cloudLink(s.execution) : null,
    ];
  }
  if (k.cloud_session?.done)
    return `Completed in the cloud (branch ${k.cloud_session.branch ?? k.branch}); the orchestrator merges`;
  if (!k.cloud) return null;
  return k.cloud.suitable
    ? 'Suitable for cloud'
    : el('div', null, el('span', { text: 'Not suitable:' }), list2(k.cloud.reasons));
}

/** The session as a link when it is an https address, otherwise as text (never a javascript: link from the queue). */
function cloudLink(execution) {
  return /^https:\/\/[^\s]+$/.test(execution)
    ? el('a', { href: execution, target: '_blank', rel: 'noopener noreferrer', text: execution })
    : el('code', { text: execution });
}

function list(summary, col, section) {
  const ol = el('ol', { class: 'shortlist', 'data-section': section ?? col });
  for (const k of summary) ol.append(summaryNode(k, col));
  return ol;
}
