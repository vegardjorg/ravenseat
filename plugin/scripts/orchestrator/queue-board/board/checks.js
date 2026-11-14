// =============================================================
// checks.js: the Checks tab: what the project has for checking its code (cards), and prioritized suggestions (cards), each
// with a button that adds its investigation and planning to the queue.
//
// The data is `ravenseat checks --json` (GET /api/checks, lib/checksCatalog.js buildReport); every write is POST /api/checks, which
// runs `ravenseat checks ...`. The suggestions are files in checks-catalog/, so nothing about a suggestion is written here.
// The tab is opt-out: `ravenseat checks off` or the switch here or in Settings; state.checksPanel says whether it shows.
// state.checksMarker puts a small red dot on the tab while a high suggestion is open (`ravenseat checks marker off` or
// Settings hides it; the suggestions stay).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

const checksTab = $('show-checks');
/** The view's own state. `open` keeps a card's details open across redraws. */
t.checks = { report: null, error: null, fetching: false, time: 0, category: 'all', open: new Set(), asideOpen: false, busy: null };

const CHECKS_WHERE = { ci: 'CI', gate: 'Gate', script: 'Script', hook: 'Git hook', config: 'Config' };
const CHECKS_PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };

/** The tab follows the switch; a view that was switched off goes back to the queue. */
function drawChecksTab() {
  if (!checksTab) return;
  const on = !!t.data?.checksPanel;
  checksTab.hidden = !on;
  const dot = on && t.data?.checksMarker === true;
  checksTab.classList.toggle('has-marker', dot);
  checksTab.setAttribute('aria-label', dot ? 'Checks, an important suggestion is open' : 'Checks');
  if (!on && t.view === 'checks') {
    setView(t.decide.queueView);
    draw();
  }
}

/** Opens the Checks view (from Plans too). */
function openChecks() {
  window.QueuePlans?.showQueue?.();
  if (t.view !== 'checks') setView('checks');
  draw();
  drawRoomTabs();
  getChecks();
}
checksTab?.addEventListener('click', openChecks);

/** Fetches the overview. The server keeps it for a minute unless a write or Rescan asks for a new one. */
async function getChecks(fresh = false) {
  if (t.checks.fetching || !t.key) return;
  if (!fresh && t.checks.report && Date.now() - t.checks.time < 60_000) return;
  t.checks.fetching = true;
  try {
    const answer = await api(`/api/checks${fresh ? '?fresh=1' : ''}`);
    t.checks.report = answer.report ?? null;
    t.checks.error = null;
    t.checks.time = Date.now();
  } catch (e) {
    t.checks.error = e.message;
  } finally {
    t.checks.fetching = false;
    if (t.view === 'checks') draw();
  }
}

/** One write, then a new overview. `done` is the toast. */
async function checksWrite(body, done) {
  t.checks.busy = body.key ?? body.action;
  draw();
  try {
    const answer = await writeWithGuard('/api/checks', body);
    if (answer) messageWithInfo(done, answer);
    t.checks.busy = null;
    await getChecks(true);
  } catch (e) {
    message(e.message, true);
  } finally {
    t.checks.busy = null;
    if (t.view === 'checks') draw();
    update(true);
  }
}

function checksFoundCard(k) {
  const places = k.places.map((p) => {
    const where = CHECKS_WHERE[p.where] ?? p.where;
    const from = [p.file, p.job ? `job ${p.job}` : null].filter(Boolean).join(', ');
    return el(
      'li',
      null,
      el('span', { class: 'checks-where', text: where }),
      ' ',
      p.command ? el('code', { text: p.command }) : null,
      el('span', { class: 'checks-source', text: ` ${from}` }),
    );
  });
  const inCi = k.places.some((p) => p.where === 'ci');
  return el(
    'li',
    { class: 'checks-card' },
    el(
      'div',
      { class: 'checks-card-head' },
      el('h4', { class: 'checks-card-title', text: k.title }),
      el('span', { class: 'badge', text: inCi ? 'In CI' : 'Not in CI' }),
    ),
    el('ul', { class: 'checks-places' }, ...places),
  );
}

function checksCiCard(c) {
  return el(
    'li',
    { class: 'checks-card' },
    el(
      'div',
      { class: 'checks-card-head' },
      el('h4', { class: 'checks-card-title', text: c.host }),
      el('span', { class: 'badge', text: 'CI config' }),
    ),
    el('p', { class: 'checks-text' }, el('code', { text: c.file })),
    c.triggers.length ? el('p', { class: 'checks-source', text: `Runs on: ${c.triggers.join(', ')}` }) : null,
    c.jobs.length ? el('p', { class: 'checks-source', text: `Jobs: ${c.jobs.join(', ')}` }) : null,
  );
}

/** Copies the text of an `ask` card. Where the clipboard is refused, the text is on the card to select by hand. */
async function copyChecksAsk(s) {
  try {
    await navigator.clipboard.writeText(s.ask);
    message('Copied. Paste it to Claude in your own session.');
  } catch {
    message('Could not copy automatically: select the text on the card and copy it yourself.', true);
  }
}

function checksButton(s) {
  const busy = t.checks.busy === s.key;
  if (s.action === 'ask')
    return el('button', {
      type: 'button',
      class: 'button button-filled',
      text: 'Copy the text for Claude',
      title: 'A queue agent cannot do this step. Paste the text to Claude in your own session.',
      onclick: () => copyChecksAsk(s),
    });
  if (s.action === 'packs')
    return el('button', {
      type: 'button',
      class: 'button button-filled',
      text: busy ? 'Saving …' : 'Turn on',
      disabled: busy,
      title: 'Writes the packs to review.packs in queue.config.json. Your review signals then also know your stack.',
      onclick: () => checksWrite({ action: 'packs', key: s.key }, 'Review signals for your stack on'),
    });
  if (s.action === 'gates')
    return el('button', {
      type: 'button',
      class: 'button button-filled',
      text: busy ? 'Saving …' : 'Use as gates',
      disabled: busy,
      title: 'Writes the checks found to gates.quick and gates.full in queue.config.json',
      onclick: () => checksWrite({ action: 'gates', key: s.key }, 'Gates set'),
    });
  return el('button', {
    type: 'button',
    class: 'button button-filled',
    text: busy ? 'Adding …' : 'Add investigation to queue',
    disabled: busy,
    title: `About ${s.contentMin} min of agent work, and it uses tokens. It delivers a plan and recommended steps, no code.`,
    onclick: () => checksWrite({ action: 'plan', key: s.key }, 'Added to the queue'),
  });
}

function checksSuggestionCard(s, categories) {
  const details = el(
    'details',
    { class: 'checks-details' },
    el('summary', { text: 'What this involves' }),
    el('h5', { text: 'Investigate' }),
    el('p', { class: 'checks-template', text: s.investigate }),
    el('h5', { text: 'Plan and build' }),
    el('p', { class: 'checks-template', text: s.plan }),
  );
  details.open = t.checks.open.has(s.key);
  details.addEventListener('toggle', () => {
    if (details.open) t.checks.open.add(s.key);
    else t.checks.open.delete(s.key);
  });
  const category = categories.find((c) => c.key === s.category)?.title ?? s.category;
  const under = s.state === 'queued' ? `In the queue: ${s.taskId}` : s.state === 'planned' ? `Plan delivered: ${s.taskId}` : null;
  return el(
    'li',
    { class: `checks-card checks-suggestion checks-${s.priority}` },
    el(
      'div',
      { class: 'checks-card-head' },
      el('span', { class: 'checks-priority', text: CHECKS_PRIORITY[s.priority] ?? s.priority }),
      el('span', { class: 'checks-source', text: category }),
    ),
    el('h4', { class: 'checks-card-title', text: s.title }),
    el('p', { class: 'checks-text', text: s.why }),
    s.detail ? el('p', { class: 'checks-source', text: s.detail }) : null,
    s.action === 'ask'
      ? el(
          'div',
          { class: 'checks-ask' },
          el('h5', { text: 'Ask Claude in your session' }),
          el('p', { class: 'checks-template', text: s.ask }),
        )
      : s.action
        ? null
        : details,
    el(
      'div',
      { class: 'checks-actions' },
      under ? el('span', { class: 'checks-state', text: under }) : checksButton(s),
      under
        ? null
        : el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Set aside',
            onclick: () => checksWrite({ action: 'dismiss', key: s.key }, 'Set aside'),
          }),
      s.action || under ? null : el('span', { class: 'checks-source', text: `About ${s.contentMin} min of agent work` }),
    ),
  );
}

/** The category filter: only the categories that have a suggestion now. */
function checksFilter(report, open) {
  const used = report.categories.filter((c) => open.some((s) => s.category === c.key));
  if (used.length < 2) return null;
  const box = el('select', {
    id: 'checks-category',
    class: 'checks-select',
    onchange: () => {
      t.checks.category = box.value;
      draw();
    },
  });
  for (const c of [{ key: 'all', title: 'All categories' }, ...used]) box.append(el('option', { value: c.key, text: c.title }));
  box.value = used.some((c) => c.key === t.checks.category) ? t.checks.category : 'all';
  return el('label', { class: 'checks-filter', for: 'checks-category' }, 'Show ', box);
}

const GUARD_KIND = { gate: 'Gate', instruction: 'Instruction', review: 'Review point', none: 'No guard' };
const INSPECTION_STATUS = {
  watching: 'Watching',
  due: 'Due for a proposal',
  proposed: 'Proposed',
  approved: 'Approved',
  built: 'Built',
  rejected: 'Rejected',
  snoozed: 'Snoozed',
};
const checksPlural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One guard from the registry (report.guards, cli/inspection.mjs guardsBoard). */
function checksGuardCard(g) {
  const m = g.measures ?? {};
  const against = [g.against?.lesson, g.against?.signature ? `signature ${g.against.signature}` : null].filter(Boolean).join('; ');
  return el(
    'li',
    { class: 'checks-card' },
    el(
      'div',
      { class: 'checks-card-head' },
      el('h4', { class: 'checks-card-title', text: g.title }),
      el('span', { class: 'badge', text: GUARD_KIND[g.kind] ?? g.kind }),
      g.status === 'retired' ? el('span', { class: 'badge', text: 'Retired' }) : null,
    ),
    el('p', { class: 'checks-text', text: g.explain }),
    against ? el('p', { class: 'checks-source', text: `Against: ${against}` }) : null,
    g.command ? el('p', { class: 'checks-text' }, el('code', { text: g.command })) : null,
    m.runs != null
      ? el('p', {
          class: 'checks-source',
          text:
            `Caught ${checksPlural(m.caughtSince ?? 0, 'time')} since built (${checksPlural(m.runs, 'run')})` +
            `${m.lastRed ? `, last red ${String(m.lastRed).slice(0, 10)}` : ''}.`,
        })
      : null,
    el('p', { class: 'checks-source', text: `${g.id}, built ${g.built}${g.task ? ` by ${g.task}` : ''}` }),
  );
}

/** The Guards section: the tracked guard registry. */
function checksGuardsSection(guards) {
  if (!guards) return [];
  const list = guards.guards ?? [];
  return [
    el('h3', { class: 'decide-group-title', text: 'Guards' }),
    el('p', { class: 'decide-hint', text: `The guards this project has built and what each one guards against (${guards.file}, tracked in git).` }),
    guards.error ? el('p', { class: 'setting-error', text: `The guard registry has a mistake: ${guards.error}` }) : null,
    list.length
      ? el('ul', { class: 'checks-grid' }, ...list.map(checksGuardCard))
      : el('p', { class: 'checks-text', text: 'No guards in the registry yet. A built inspection proposal adds one.' }),
  ].filter(Boolean);
}

/** One repeated failure (report.inspection.entries, lib/inspection.js boardData). */
function checksInspectionCard(e) {
  const status = INSPECTION_STATUS[e.status] ?? e.status;
  const label = e.proposal && ['proposed', 'approved', 'built'].includes(e.status) ? `${status}: ${e.proposal}` : status;
  const where = (e.sources ?? []).map((x) => (x === 'ci' ? 'CI' : 'gates')).join(', ');
  return el(
    'li',
    { class: 'checks-card' },
    el(
      'div',
      { class: 'checks-card-head' },
      el('h4', { class: 'checks-card-title', text: e.name }),
      el('span', { class: 'badge', text: label }),
    ),
    e.excerpt ? el('p', { class: 'checks-text' }, el('code', { text: e.excerpt })) : null,
    el('p', {
      class: 'checks-source',
      text:
        `${checksPlural(e.count, 'red run')}, ${checksPlural(e.incidents, 'incident')} (${where}), ` +
        `last ${String(e.lastSeen ?? '?').slice(0, 10)}${e.snoozedUntil ? `, snoozed until ${String(e.snoozedUntil).slice(0, 10)}` : ''}.`,
    }),
    e.unregistered
      ? el('p', { class: 'checks-source' }, 'Not in the guard registry yet: ', el('code', { text: `ravenseat guards add --from-task ${e.proposal} --kind ...` }))
      : null,
  );
}

/** The Repeated failures section: the inspection queue's entries from the last scan (ravenseat inspection, the pulse). */
function checksInspectionSection(insp) {
  if (!insp) return [];
  const title = el('h3', { class: 'decide-group-title', text: 'Repeated failures' });
  if (insp.mode === 'off')
    return [title, el('p', { class: 'checks-text', text: 'The inspection queue is off (inspection.mode). Settings turns it on.' })];
  const list = (insp.entries ?? []).filter((e) => e.status !== 'watching');
  return [
    title,
    el('p', {
      class: 'decide-hint',
      text:
        `A failure that goes red the same way ${insp.minRepeats} or more times (separate tasks or commits) within ` +
        `${insp.windowDays} days becomes one proposal: add a guard, or nothing. You decide.`,
    }),
    list.length
      ? el('ul', { class: 'checks-grid' }, ...list.map(checksInspectionCard))
      : el('p', { class: 'checks-text', text: 'Nothing has gone red the same way more than once.' }),
  ];
}

/**
 * The summary at the top: important (high) suggestions that are open, and those set aside, each with one click back.
 * Nothing when there are none of either.
 */
function checksSummary(r) {
  const high = r.suggestions.filter((s) => s.priority === 'high');
  const open = high.filter((s) => s.state === 'open');
  const aside = high.filter((s) => s.state === 'dismissed');
  if (!open.length && !aside.length) return null;
  return el(
    'div',
    { class: 'checks-card checks-summary' },
    open.length ? el('h4', { class: 'checks-card-title', text: `Important: ${checksPlural(open.length, 'suggestion')} open` }) : null,
    open.length ? el('p', { class: 'checks-text', text: open.map((s) => s.title).join(', ') }) : null,
    aside.length ? el('h4', { class: 'checks-card-title', text: `Skipped: ${checksPlural(aside.length, 'important suggestion')}` }) : null,
    aside.length
      ? el(
          'ul',
          { class: 'checks-aside' },
          ...aside.map((s) =>
            el(
              'li',
              null,
              `${s.title} `,
              el('button', { type: 'button', class: 'link-button', text: 'Bring back', onclick: () => checksWrite({ action: 'restore', key: s.key }, 'Brought back') }),
            ),
          ),
        )
      : null,
    el('p', { class: 'checks-source', text: 'The red dot on the tab follows the open ones. Settings, or ravenseat checks marker off, hides the dot.' }),
  );
}

/** The whole view, into main. */
function drawChecks() {
  const r = t.checks.report;
  const wrap = el('div', { class: 'checks-view' });
  wrap.append(
    el(
      'div',
      { class: 'checks-head' },
      el('h2', { class: 'decide-heading', text: 'Checks' }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: t.checks.fetching ? 'Reading …' : 'Read again',
        disabled: t.checks.fetching,
        onclick: () => getChecks(true),
      }),
      el('button', {
        type: 'button',
        class: 'link-button',
        text: 'Turn this tab off',
        title: 'Same as ravenseat checks off. Settings or ravenseat checks on brings it back. Guards and gates are not affected.',
        onclick: () => checksWrite({ action: 'off' }, 'Checks tab off'),
      }),
      el('p', {
        class: 'decide-hint checks-note',
        text: 'Read from your files. Ravenseat did not run any of it, so this shows what is set up, not that it works.',
      }),
    ),
  );
  if (!r) {
    wrap.append(el('p', { class: 'empty', text: t.checks.error ? `Could not read the checks: ${t.checks.error}` : 'Reading the project …' }));
    main.append(wrap);
    return;
  }
  const kinds = r.found.kinds;
  const summary = checksSummary(r);
  if (summary) wrap.append(summary);
  wrap.append(
    el('h3', { class: 'decide-group-title', text: 'What you have' }),
    kinds.length || r.found.ci.length
      ? el('ul', { class: 'checks-grid' }, ...r.found.ci.map(checksCiCard), ...kinds.map(checksFoundCard))
      : el('p', { class: 'checks-text', text: 'No checks and no CI found yet. That is a normal place to start.' }),
  );
  const known = r.knownBugs ?? {};
  if (known.open || known.done)
    wrap.append(el('p', { class: 'checks-source', text: `Gates from known bugs: ${known.proposed} waiting for your yes, ${known.open - known.proposed} approved, ${known.done} done.` }));
  wrap.append(...checksGuardsSection(r.guards), ...checksInspectionSection(r.inspection));
  const open = r.suggestions.filter((s) => s.state !== 'dismissed');
  const aside = r.suggestions.filter((s) => s.state === 'dismissed');
  const filter = checksFilter(r, open);
  const wanted = filter ? filter.querySelector('select').value : 'all';
  const shown = open.filter((s) => wanted === 'all' || s.category === wanted);
  wrap.append(
    el('div', { class: 'checks-head' }, el('h3', { class: 'decide-group-title', text: 'Suggestions, most important first' }), filter),
    el('p', { class: 'decide-hint', text: 'Optional, all of them. The button adds an investigation that ends in a plan with recommended steps. Nothing is built before you approve it.' }),
    shown.length
      ? el('ul', { class: 'checks-grid' }, ...shown.map((s) => checksSuggestionCard(s, r.categories)))
      : el('p', { class: 'checks-text', text: 'No suggestions right now.' }),
  );
  if (aside.length) {
    const box = el(
      'details',
      { class: 'checks-details' },
      el('summary', { text: `Set aside (${aside.length})` }),
      el(
        'ul',
        { class: 'checks-aside' },
        ...aside.map((s) =>
          el(
            'li',
            null,
            `${s.title} `,
            el('button', { type: 'button', class: 'link-button', text: 'Bring back', onclick: () => checksWrite({ action: 'restore', key: s.key }, 'Brought back') }),
          ),
        ),
      ),
    );
    box.open = t.checks.asideOpen;
    box.addEventListener('toggle', () => {
      t.checks.asideOpen = box.open;
    });
    wrap.append(box);
  }
  for (const e of r.catalogErrors ?? []) wrap.append(el('p', { class: 'setting-error', text: `A suggestion file has a mistake: ${e}` }));
  main.append(wrap);
}
