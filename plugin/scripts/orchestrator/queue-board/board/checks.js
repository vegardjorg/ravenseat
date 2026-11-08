// =============================================================
// checks.js: the Checks tab: what the project has for checking its code (cards), and prioritized suggestions (cards), each
// with a button that adds its investigation and planning to the queue.
//
// The data is `ravenseat checks --json` (GET /api/checks, lib/checksCatalog.js buildReport); every write is POST /api/checks, which
// runs `ravenseat checks ...`. The suggestions are files in checks-catalog/, so nothing about a suggestion is written here.
// The tab is opt-out: `ravenseat checks off` or the switch here or in Settings; state.checksPanel says whether it shows.
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
  wrap.append(
    el('h3', { class: 'decide-group-title', text: 'What you have' }),
    kinds.length || r.found.ci.length
      ? el('ul', { class: 'checks-grid' }, ...r.found.ci.map(checksCiCard), ...kinds.map(checksFoundCard))
      : el('p', { class: 'checks-text', text: 'No checks and no CI found yet. That is a normal place to start.' }),
  );
  const known = r.knownBugs ?? {};
  if (known.open || known.done)
    wrap.append(el('p', { class: 'checks-source', text: `Gates from known bugs: ${known.proposed} waiting for your yes, ${known.open - known.proposed} approved, ${known.done} done.` }));
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
