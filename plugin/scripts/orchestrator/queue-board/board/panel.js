// =============================================================
// panel.js: the detail panel for one task.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Detail panel ----
let panelFrom = null;
/**
 * Shows the side panel as a modal dialog: remembers the element that opened it (focus goes back there
 * on close), and makes the rest of the page inert so Tab and the screen reader stay in the panel. The focus trap below catches Tab
 * at the ends. Everything that opens the panel (details, inbox, settings, help) goes here.
 */
const PANEL_INERT = ['header.top', '#focusLine', '#stripe', '#board', '#optionLine'];
function showPanel() {
  if (panel.hidden) panelFrom = document.activeElement;
  panel.hidden = false;
  background.hidden = false;
  window.QueueA11y.setInert(
    PANEL_INERT.map((v) => document.querySelector(v)),
    true,
  );
}
panel.addEventListener('keydown', (e) => window.QueueA11y.trapKey(e, panel));
/** Opens the detail panel and selects the card's chain. `fromInbox`: the panel gets "Back to Waiting on you". */
function openPanel(id, { fromInbox = false } = {}) {
  if (!t.perId.has(id)) return;
  t.setting = null;
  t.inbox = false;
  t.help = false;
  t.fromInbox = fromInbox;
  t.selected = id;
  showPanel();
  selectChain(id);
  drawPanel(true);
  panel.querySelector('.button-icon')?.focus();
  if (!t.details.has(id)) getDetails(id);
}
function closePanel() {
  t.selected = null;
  t.setting = null;
  t.inbox = false;
  t.help = false;
  t.fromInbox = false;
  panel.hidden = true;
  background.hidden = true;
  panel.replaceChildren();
  // Inert off before focus moves back (an inert element cannot get focus).
  window.QueueA11y.setInert(
    PANEL_INERT.map((v) => document.querySelector(v)),
    false,
  );
  drawInboxButton();
  // If the card that opened the panel was redrawn meanwhile, the new card with the same id gets focus.
  // The card may have been rebuilt while the panel was open: find it again by id (on the card it is the button
  // that has focus; the id sits on the card around it).
  const fromId = panelFrom?.isConnected ? null : panelFrom?.closest?.('[data-id]')?.dataset.id;
  if (fromId) {
    const fresh = main.querySelector(`[data-id="${CSS.escape(fromId)}"]`);
    panelFrom = fresh?.querySelector('.summary-button') ?? fresh;
  }
  if (panelFrom?.isConnected) panelFrom.focus();
  panelFrom = null;
}
async function getDetails(id) {
  try {
    const d = await api(`/api/task?id=${encodeURIComponent(id)}`);
    t.details.set(id, d);
  } catch (e) {
    t.details.set(id, { error: e.message });
  }
  if (t.selected === id) drawPanel();
}

function facts(dt, dd) {
  if (dd == null || dd === '' || (Array.isArray(dd) && !dd.length)) return [];
  return [el('dt', { text: dt }), el('dd', null, dd)];
}
const list2 = (values, code) =>
  el(
    'ul',
    null,
    values.map((v) => el('li', null, code ? el('code', { text: v }) : v)),
  );

/** The title of an area (oid) from the board, "Without area" for without-area, or null when the card has no area. */
function areaTitle(oid) {
  if (!oid) return null;
  if (oid === 'without-area') return 'Without area';
  return (t.data?.areas ?? []).find((o) => o.oid === oid)?.title ?? oid;
}

/**
 * "Placement" in the detail panel for a card in the queue: the focus step (or why it is outside), the place
 * among the ready ones in the step, who dragged it along, and the points with the formula (queueLogic.scoreParts, same numbers the
 * queue uses).
 */
function placementFacts(k, idButton) {
  const pl = k.space;
  const f = t.data.focus;
  let stage;
  if (k.parked) stage = 'On hold (not ranked until the wait is over)';
  else if (!f?.active) stage = 'No focus (the whole queue is ranked by score)';
  else if (pl.step == null)
    stage = pl.out
      ? `Outside focus: ${pl.reason ?? 'waiting until focus is done'}`
      : 'Outside focus (fills available capacity after the focus steps)';
  else stage = `T${pl.step + 1} ${f.stage?.[pl.step]?.title ?? ''}`.trim();
  if (pl.nr && pl.by)
    stage += ` · no. ${pl.nr} of ${pl.by} ready ${f?.active && pl.step != null ? 'in the step' : 'here'}`;
  const sd = k.score_parts;
  const counts = (x) => String(Math.round(x * 100) / 100);
  const formula = sd
    ? `${counts(sd.score)} = value ${sd.value} / ${sd.minutes} min × 100 × unlocks (1 + 0.25 × ${sd.unlocks}) × ` +
      `age (1 + 0.02 × ${counts(Math.min(sd.days, 14))} d)` +
      // Ownership contention (logic/ranking.js scoreParts): other open tasks own the same files.
      (sd.contended && sd.hot_factor !== 1
        ? ` × contended files ${counts(sd.hot_factor)} (${sd.contended} other task(s) own the same files; ` +
          `${sd.hot_factor > 1 ? 'short, frees them sooner' : 'long, holds them'})`
        : '') +
      (sd.bonus
        ? ` ${sd.bonus > 0 ? '+' : '−'} ${Math.abs(sd.bonus)} (the task's bonus)`
        : '') +
      (sd.project_bonus
        ? ` ${sd.project_bonus > 0 ? '+' : '−'} ${Math.abs(sd.project_bonus)} (the project's bonus)`
        : '')
    : String(k.score ?? '?');
  // One flat list of dt/dd: el() flattens only one level, so a list of facts() lists would show up as
  // "[object HTMLElement]" in the panel.
  return [
    ...facts('Placement', stage),
    ...facts('Dragged along by', pl.dragged_by ? idButton(pl.dragged_by) : null),
    ...facts(
      'Score',
      el('span', { text: formula, title: 'Higher score is started first within the same stage.' }),
    ),
  ];
}

function drawPanel(fresh) {
  const found = t.perId.get(t.selected);
  if (!found) return closePanel();
  // Do not redraw the panel while the owner writes in a field there.
  if (
    !fresh &&
    panel.contains(document.activeElement) &&
    /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
  )
    return;
  // A card in the Blocked column keeps the facts and actions of the column it came from (its `home`).
  const { k } = found;
  const col = found.col === 'blocked' ? (k.home ?? 'queue') : found.col;
  const p = project(k.project);
  const d = t.details.get(k.id);
  const scroll = panel.scrollTop;

  const idButton = (id) => {
    const x = t.perId.get(id);
    return x
      ? el('button', {
          type: 'button',
          class: 'link-button',
          text: `${id} (${x.k.status})`,
          onclick: () => openPanel(id, { fromInbox: t.fromInbox }),
        })
      : el('code', { text: id });
  };
  const depends_on = k.depends_on.map(idButton);
  // "Unlocks": the direct successors as clickable ids, and the whole chain as numbers.
  const lockState = col !== 'built' ? k.unlocks : null;
  const unlocksOf = lockState
    ? [
        ...lockState.direct.map(idButton),
        el('span', {
          class: 'facts-remark',
          text: `total ${lockState.count} via the chain (${duration(lockState.minutes)} estimated)`,
        }),
      ]
    : null;
  // The question text (from the inbox) for what the card waits on and that is not resolved.
  const spText = new Map((t.data.inbox?.question ?? []).map((s) => [s.sp, s.text]));
  const branch = d?.branch
    ? d.branch.exists
      ? `${d.branch.name}: ${d.branch.commits} commit(s) ahead ${t.data?.baseBranch ?? 'main'}`
      : `${d.branch.name} does not exist yet`
    : d?.error
      ? `could not read (${d.error})`
      : 'fetching …';
  const status = k.batched
    ? 'In batch queue (not started alone; packed into a track with ravenseat batch pack)'
    : ({
        waiting: k.ready ? 'In queue, ready now' : 'In queue, blocked',
        proposed: 'Proposed (must be approved)',
        running: 'Running',
        picked: `Picked by ${k.picked_by ?? '?'}`,
        external: `Work outside queue (${k.external_name ?? '?'})`,
        review: 'Review',
        done: 'Built',
      }[k.status] ?? k.status);

  panel.replaceChildren(
    el(
      'div',
      { class: 'panel-header' },
      el(
        'div',
        null,
        t.fromInbox
          ? el('button', {
              type: 'button',
              class: 'link-button back',
              text: '← Waiting on you',
              onclick: () => openInbox(),
            })
          : null,
        el('span', { class: 'summary-id', text: k.id }),
        el('h2', { id: 'panel-title', text: k.title }),
      ),
      el(
        'button',
        { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
        icon('close'),
      ),
    ),
    el(
      'dl',
      { class: 'facts' },
      facts(
        'Status',
        `${status}${k.start ? ` · ${age(k.start)}` : ''}${k.old ? ' · old' : ''}` +
          (k.aging ? ' · older than usual for the class' : ''),
      ),
      k.aging ? facts('Age', agingText(k)) : [],
      facts('On hold', k.parked ? waitText(k.parked) : null),
      facts('Project', `${p?.title ?? k.project} (${k.project})`),
      facts('Feature', k.feature),
      // Link to the plan entry (switches to Plans with the entry open).
      facts(
        'Plan entry',
        k.plan
          ? el('button', {
              type: 'button',
              class: 'link-button',
              text: [k.plan, window.QueuePlans?.title(k.plan)].filter(Boolean).join(' '),
              onclick: () => {
                closePanel();
                window.QueuePlans?.openEntry(k.plan);
              },
            })
          : null,
      ),
      facts(
        'Class',
        `${k.class ?? '?'} · value ${k.value} · ${k.estimate} min${k.domain ? ` · ${k.domain}` : ''}`,
      ),
      col === 'queue' && k.space ? placementFacts(k, idButton) : [],
      col === 'queue' && !k.space
        ? facts(
            'Priority',
            `${k.score}${k.priority_bonus ? ` (bonus ${k.priority_bonus > 0 ? '+' : ''}${k.priority_bonus})` : ''}`,
          )
        : [],
      facts('Area', areaTitle(k.area)),
      facts('Depends on', depends_on.length ? depends_on : null),
      facts('Unlocks', unlocksOf),
      facts(
        'Waiting on',
        k.waiting_on.length
          ? list2(
              k.waiting_on.map(
                (v) =>
                  `${v.sp}${v.resolved ? ' (resolved)' : ''}` +
                  (spText.get(v.sp) ? `: ${spText.get(v.sp)}` : ''),
              ),
            )
          : null,
      ),
      col === 'queue' && k.blockers.length ? facts('Blockers', list2(k.blockers)) : [],
      // The finish line, read-only (locked once the task has started; ravenseat edit --accept / --by owner changes it).
      facts('Acceptance', k.acceptance?.length ? list2(k.acceptance) : null),
      facts('Done command', k.done_when ? el('code', { text: k.done_when }) : null),
      // The wiring spec's open items, read-only (ravenseat wiring <id> <item> --commit <sha> or --reject closes one).
      facts('Open wiring', k.wiring_open?.length ? list2(k.wiring_open) : null),
      facts('Owner files', k.owned_files.length ? list2(k.owned_files, true) : null),
      facts('DB', k.owner_db.length ? list2(k.owner_db, true) : null),
      facts('Branch', branch),
      facts('Cloud', cloudFacts(k)),
      facts('Migrations', k.migr_block),
      facts('QA', k.qa_status ? `${k.qa_status}${k.qa_note ? `: ${k.qa_note}` : ''}` : null),
      facts('Verification', k.verification ? `${k.verification}${k.verification_checks?.length ? ` (${k.verification_checks.join(', ')})` : ''}` : null),
      facts(
        'Source',
        [k.source, k.added_by ? `added by ${k.added_by}` : null]
          .filter(Boolean)
          .join(' · '),
      ),
      facts('Remarks', k.remarks.length ? list2(k.remarks) : null),
    ),
    actionsFor(k, col),
    el(
      'section',
      { class: 'mission', 'aria-label': 'The mission' },
      el('h3', {
        class: 'mission-title',
        text: d?.mission?.path ? `The mission (${d.mission.path})` : 'The mission',
      }),
      d?.mission
        ? markdown(d.mission.text)
        : el('p', { class: 'empty', text: d?.error ?? 'Fetching the mission …' }),
    ),
  );
  panel.scrollTop = scroll;
}

function actionsFor(k, col) {
  const box = el('div', { class: 'actions', 'aria-label': 'Actions' });
  if (col === 'queue') {
    const name = el('input', {
      id: 'pick-name',
      type: 'text',
      value: store.getItem('queue-board-name') ?? '',
      autocomplete: 'off',
    });
    box.append(
      el('button', {
        type: 'button',
        class: 'button button-muted',
        text: 'To the top of the queue',
        onclick: () => move({ id: k.id, top: true }, `${k.id} is at the top of the queue`),
      }),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'pick-name', text: 'Who is picking?' }),
        name,
      ),
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: 'Pick',
        onclick: () => {
          const by = name.value.trim();
          if (!by) return message('Write who is picking.', true);
          store.setItem('queue-board-name', by);
          action({ type: 'pick', id: k.id, by }, `${k.id} is picked by ${by}`);
        },
      }),
    );
    // Send the task to a cloud session (paste the package), and register that it is started there.
    if (k.cloud?.suitable) {
      const session = el('input', {
        id: 'cloud-session',
        type: 'text',
        autocomplete: 'off',
        placeholder: 'https://claude.ai/code/…',
      });
      box.append(
        el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Copy cloud package',
          onclick: () => copyCloudPackage([k.id]),
        }),
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'cloud-session', text: 'Link to the cloud session (optional)' }),
          session,
        ),
        el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Started in cloud',
          onclick: () =>
            action(
              { type: 'cloud-start', id: k.id, execution: session.value.trim() || undefined },
              `${k.id} is started in the cloud`,
            ),
        }),
      );
      const field = cloudPackageField([k.id]);
      if (field) box.append(field);
    }
  } else if (k.in_cloud) {
    // The cloud session is done (branch checked with git fetch by queue.mjs cloud done), or is canceled.
    const branch = el('input', {
      id: 'cloud-branch',
      type: 'text',
      autocomplete: 'off',
      placeholder: k.branch,
    });
    box.append(
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'cloud-branch', text: 'Branch the cloud pushed (empty = ' + k.branch + ')' }),
        branch,
      ),
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: 'Completed in cloud',
        onclick: () =>
          action(
            { type: 'cloud-done', id: k.id, branch: branch.value.trim() || undefined },
            `${k.id} is completed in the cloud and waiting for merge`,
          ),
      }),
      el('button', {
        type: 'button',
        class: 'button button-muted',
        text: 'Copy cloud package',
        onclick: () => copyCloudPackage([k.id]),
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Cancel cloud',
        onclick: () =>
          action({ type: 'cloud-cancel', id: k.id }, `${k.id}: the cloud session is aborted, waiting again`),
      }),
    );
    const field = cloudPackageField([k.id]);
    if (field) box.append(field);
  } else if (k.status === 'picked') {
    box.append(
      el('button', {
        type: 'button',
        class: 'button button-muted',
        text: 'Release',
        onclick: () =>
          action({ type: 'release', id: k.id }, `${k.id} is released and waiting again`),
      }),
    );
  } else if (k.status === 'done' && (k.qa_status === 'waiting' || k.qa_status === 'deviation')) {
    box.append(
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: 'QA ok',
        title: 'Mark the visual check as passed; the task leaves the QA list',
        onclick: () => action({ type: 'qa-ok', id: k.id }, `${k.id}: QA ok`),
      }),
    );
    if (k.qa_status === 'waiting') {
      const text = el('textarea', { id: 'qa-text', rows: 3 });
      box.append(
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'qa-text', text: 'What is wrong, and where?' }),
          text,
        ),
        el('button', {
          type: 'button',
          class: 'button button-fare',
          text: 'QA deviation',
          onclick: () => {
            const s = text.value.trim();
            if (!s) return message('Write what is wrong, and where.', true);
            action(
              { type: 'qa-deviation', id: k.id, text: s },
              `${k.id}: QA deviation, fix task added to the queue`,
            );
          },
        }),
      );
    }
  }
  // Cancel, decline and edit (waiting and proposed), or the CLI hint for running and review.
  const edit = taskEditActions(k);
  if (edit) box.append(...[].concat(edit));
  // Select and act (same dialog with preview as the selection bar).
  const mark = markButtons(k, col);
  if (mark) box.append(mark);
  if (!box.children.length)
    box.append(el('p', { class: 'none', text: 'No actions for this status.' }));
  return box;
}
