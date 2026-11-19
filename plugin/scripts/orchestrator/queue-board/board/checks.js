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
/**
 * "How it works" (B11) is open until the owner closes it. The choice is remembered per browser through `store` (core.js:
 * every localStorage access in try/catch), so blocked storage only means it is not remembered; t.checks.howOpen holds
 * it for the visit either way.
 */
const CHECKS_HOW_KEY = 'queue-board-checks-how';
/** The view's own state. `open` keeps a card's details open across redraws. */
t.checks = {
  report: null,
  error: null,
  fetching: false,
  time: 0,
  category: 'all',
  open: new Set(),
  asideOpen: false,
  moreOpen: false,
  busy: null,
  howOpen: store.getItem(CHECKS_HOW_KEY) !== 'closed',
};

// The icons of "How it works" and its chevron, in the board's icon set (core.js ICONS): 24 px strokes in the text color.
const checksStroke = (d) => [['path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]];
Object.assign(ICONS, {
  'checks-step-add': checksStroke('M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM12 8v8M8 12h8'),
  'checks-step-look': checksStroke('M11 5a6 6 0 1 1 0 12a6 6 0 0 1 0-12zM20 20l-4.5-4.5'),
  'checks-step-choose': checksStroke('M4 7l2 2 3-3M4 16l2 2 3-3M13 8h7M13 17h7'),
  'checks-step-build': checksStroke('M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9'),
  'checks-chevron': checksStroke('M6 9l6 6 6-6'),
});

const CHECKS_WHERE = { ci: 'CI', gate: 'Gate', script: 'Script', hook: 'Git hook', config: 'Config' };
const CHECKS_PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };
/** The levels, highest first: the order of the tally at the top of the view (QA-1a). */
const CHECKS_LEVELS = ['high', 'medium', 'low'];
/**
 * The classes of a level pill (QA-1a). board.css colors checks-pill-high with the danger tone (red), -medium with
 * caution (orange) and -low with warn (yellow); a level outside the three gets the plain pill shape and no color.
 */
const checksPillClass = (level) => `checks-pill checks-pill-${CHECKS_LEVELS.includes(level) ? level : 'other'}`;

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
  // The card quick-gate-add has one button per guard, on its list (checksQuickGateList), not one for the card.
  if (s.action === 'quick-gate') return null;
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
  if (s.action === 'setting')
    return el('button', {
      type: 'button',
      class: 'button button-filled',
      text: busy ? 'Saving …' : 'Turn on',
      disabled: busy,
      title: `Sets ${s.setting} on in queue.config.json. Off again in Settings.`,
      onclick: () => checksWrite({ action: 'setting', key: s.key }, 'Turned on'),
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

/**
 * "Build as gate" for one due class and area (0i section 3.7 point 3): a button while nothing is proposed for it (state
 * add), a short note while the shared cap of three is full (state full), nothing otherwise (an open one is named on the
 * line). The click posts { action: 'build-gate', item } through the same keyed write as the other buttons; the server
 * checks the key and `ravenseat checks build-gate` adds ONE proposed gate task, which waits for Approve like any proposal.
 */
function checksBuildGate(i) {
  const state = i.proposal?.state;
  if (state === 'full') return el('span', { class: 'checks-source', text: ' Build as gate waits for a free slot.' });
  if (state !== 'add') return null;
  const busy = t.checks.busy === 'build-gate';
  return el('button', {
    type: 'button',
    class: 'button button-outline',
    text: busy ? 'Adding …' : 'Build as gate',
    disabled: busy,
    title: 'Adds one proposed gate task with your gate commands, CI file, test runner, the recipe and the places. Nothing runs before you approve it.',
    onclick: () => checksWrite({ action: 'build-gate', item: i.key }, 'Gate proposed'),
  });
}

/**
 * The due classes on the card ledger-recipes (lib/checksCatalog.js ledgerItems), one line each: where, how often, the
 * places (paths only), the stack and the recipe. Text only, never HTML from the report.
 */
function checksLedgerList(ledger) {
  const items = (ledger?.items ?? []).map((i) => {
    const where = i.scope === 'project' ? 'across the project' : `in ${i.area}`;
    const proposed = i.proposal?.state === 'extend' && i.proposal.task ? ` Proposed as ${i.proposal.task}.` : '';
    const places = i.files?.length ? ` At ${i.files.join(', ')}.` : '';
    const stack = ` Stack: ${i.stacks?.length ? i.stacks.join(', ') : 'not known'}.`;
    const cards = i.recipe?.cards?.length ? ` See: ${i.recipe.cards.map((c) => c.title).join(', ')}.` : '';
    // A database class with the database probe recipes off says how to turn them on (lib/checksCatalog.js DB_HINT).
    const damped = Array.isArray(i.damped) && i.damped.length ? i.damped.map((d) => d.id).join(', ') : '';
    const recipe = i.recipe
      ? ` Recipe: ${i.recipe.text}${cards}`
      : typeof i.hint === 'string' && i.hint
        ? ` ${i.hint}`
        : damped
          ? ''
          : ' No recipe yet for this class in this stack.';
    // A recipe damped by its precision is named, never offered (lib/recipePrecision.js); the list below has its numbers.
    const note = damped ? ` Damped recipe, listed under Recipe precision and not offered here: ${damped}.` : '';
    return el(
      'li',
      {},
      el('span', { class: 'checks-where', text: `${i.title} ${where}: ${i.incidents} incident(s).` }),
      el('span', { text: `${proposed}${places}${stack}${recipe}${note}` }),
      checksBuildGate(i),
    );
  });
  const tail = [];
  if (ledger?.more) tail.push(el('li', { text: `And ${ledger.more} more.` }));
  if (ledger?.capFull) tail.push(el('li', { text: 'The cap of three open proposals is full, so a new gate proposal waits for a free slot.' }));
  return el('ul', { class: 'checks-places' }, ...items, ...tail);
}

/**
 * The gate guards whose command is not in gates.quick, on the card quick-gate-add (lib/quickGate.js items, 0i step 9b):
 * one line each with the exact command, and a button that posts { action: 'quick-add', item: <guard id> }. Only the id
 * is sent; `ravenseat checks quick-add` reads the command from the registry, can only add it, and never runs it.
 */
function checksQuickGateList(items) {
  const busy = t.checks.busy === 'quick-add';
  const lines = items.map((i) =>
    el(
      'li',
      {},
      el('span', { class: 'checks-where', text: `${i.guard} ${i.title}:` }),
      el('code', { text: i.command }),
      el('span', { text: i.inFull ? ' (in gates.full only)' : '' }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: busy ? 'Saving …' : 'Add to gates.quick',
        disabled: busy,
        title: `Adds "${i.command}" at the end of gates.quick in queue.config.json. Nothing runs now, and no command is removed. Commit the file afterwards.`,
        onclick: () => checksWrite({ action: 'quick-add', item: i.guard }, 'Added to gates.quick'),
      }),
    ),
  );
  return el('ul', { class: 'checks-places' }, ...lines);
}

/**
 * One suggestion card. In a category group (B10) the card says nothing about its category (the group heading does) and
 * its headings sit one level under the group's h4: the title h5, its inner headings h6. In the "More ideas" fold, which
 * is not grouped, the card names its category and its title is h4 as before. The card has an id and tabindex -1, so the
 * Important box can scroll to it and put focus on it (checksGoTo).
 */
function checksSuggestionCard(s, categories, { grouped = false } = {}) {
  const title = grouped ? 'h5' : 'h4';
  const inner = grouped ? 'h6' : 'h5';
  const details = el(
    'details',
    { class: 'checks-details' },
    el('summary', { text: 'What this involves' }),
    el(inner, { text: 'Investigate' }),
    el('p', { class: 'checks-template', text: s.investigate }),
    el(inner, { text: 'Plan and build' }),
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
    { class: `checks-card checks-suggestion checks-${s.priority}`, id: checksCardId(s.key), tabindex: '-1' },
    el(
      'div',
      { class: 'checks-card-head' },
      // The level word is a pill in its level's color (QA-1a); the word still carries the meaning without color.
      el('span', { class: `checks-priority ${checksPillClass(s.priority)}`, text: CHECKS_PRIORITY[s.priority] ?? s.priority }),
      grouped ? null : el('span', { class: 'checks-source', text: category }),
    ),
    el(title, { class: 'checks-card-title', text: s.title }),
    el('p', { class: 'checks-text', text: s.why }),
    s.quickGate?.length ? checksQuickGateList(s.quickGate) : s.ledger?.items?.length ? checksLedgerList(s.ledger) : s.detail ? el('p', { class: 'checks-source', text: s.detail }) : null,
    s.action === 'ask'
      ? el(
          'div',
          { class: 'checks-ask' },
          el(inner, { text: 'Ask Claude in your session' }),
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

/** A safe id part from a key (a catalog key is a slug; anything else from an own catalog is made safe). */
const checksIdPart = (key) => String(key).replace(/[^A-Za-z0-9_-]/g, '-');
/** A suggestion card's id, the target of the Important box's buttons. */
const checksCardId = (key) => `checks-card-${checksIdPart(key)}`;

/**
 * The suggestions grouped by category (B10): one section per category that has a card, in the order of
 * checks-catalog/categories.json (report.categories keeps it), with a real h4 heading and the category's one line.
 * A category a card names that the list does not have (an own catalog) comes last, under its key. Inside a group the
 * cards keep the report's order, so the most important come first there too. Empty groups are not drawn.
 */
function checksGroups(list, categories) {
  const known = categories.map((c) => c.key);
  const extra = [...new Set(list.map((s) => s.category))].filter((k) => !known.includes(k));
  return [...known, ...extra]
    .map((key) => {
      const cards = list.filter((s) => s.category === key);
      if (!cards.length) return null;
      const c = categories.find((x) => x.key === key);
      const id = `checks-group-${checksIdPart(key)}`;
      return el(
        'section',
        { class: 'checks-group', 'aria-labelledby': id },
        el('h4', { id, class: 'checks-group-title', text: c?.title ?? key }),
        c?.text ? el('p', { class: 'checks-source', text: c.text }) : null,
        el('ul', { class: 'checks-grid' }, ...cards.map((s) => checksSuggestionCard(s, categories, { grouped: true }))),
      );
    })
    .filter(Boolean);
}

/**
 * Scrolls to a suggestion's card (or, with no key, to the suggestions heading) and puts focus there (B34, UX review C1).
 * A card the category filter hides is shown first: the filter goes back to all categories and the view is drawn again.
 */
function checksGoTo(key) {
  const id = key ? checksCardId(key) : 'checks-suggestions-title';
  if (key && !document.getElementById(id) && t.checks.category !== 'all') {
    t.checks.category = 'all';
    draw();
  }
  const target = document.getElementById(id);
  if (!target) return;
  // A card in a closed fold ("More ideas") is opened first, so the focus lands on something visible.
  const fold = target.closest('details');
  if (fold && !fold.open) fold.open = true;
  // The ring shows where the focus went also after a mouse click (where :focus-visible would not), until it leaves.
  // The class comes first, so its scroll margin keeps the target clear of the top edge.
  target.classList.add('checks-target');
  target.addEventListener('blur', () => target.classList.remove('checks-target'), { once: true });
  target.scrollIntoView({ block: 'start' });
  target.focus({ preventScroll: true });
}

/**
 * "How it works" (B11): how a suggestion becomes work, in four steps with an icon each, as the code runs it:
 * checksButton posts { action: 'plan' }, which queue-board.mjs runs as `ravenseat checks plan <key> --approved` (the
 * click is the yes); lib/checksCatalog.js planTask makes the class U task KS-PLAN-<KEY>, whose mission asks for a plan
 * with recommendation, cost, risks and build steps, says that "not worth doing" is a fine result, and changes no project
 * files; the owner decides which steps become tasks, and those run in the queue like any task. One line covers the
 * cards that need no agent. A real button with aria-expanded and aria-controls opens and closes a region named by it;
 * only the region's own height changes, the view is not drawn again, and the choice is remembered (CHECKS_HOW_KEY).
 */
function checksHow() {
  const steps = [
    [
      'checks-step-add',
      'You ask',
      ['Click "Add investigation to queue". It puts one investigation, ', el('code', { text: 'KS-PLAN-<KEY>' }), ', in the queue, and the click is your yes.'],
    ],
    [
      'checks-step-look',
      'Claude investigates',
      ['An agent looks at how the check fits your project and writes a plan: recommendation, cost, risk and build steps. Saying "not worth it" is a fine answer. It changes no files.'],
    ],
    ['checks-step-choose', 'You choose', ['You read the plan and pick which build steps become tasks.']],
    ['checks-step-build', 'The queue builds', ['The steps you approve are built in the queue, like any other task.']],
  ];
  const toggle = el(
    'button',
    {
      type: 'button',
      id: 'checks-how-toggle',
      class: 'checks-how-toggle',
      'aria-expanded': String(t.checks.howOpen),
      'aria-controls': 'checks-how-body',
    },
    el('span', { text: 'How it works' }),
    icon('checks-chevron'),
  );
  const body = el(
    'div',
    { id: 'checks-how-body', class: 'checks-how-body', role: 'region', 'aria-labelledby': 'checks-how-toggle' },
    el(
      'ol',
      { class: 'checks-how-steps' },
      ...steps.map(([name, head, text], i) =>
        el(
          'li',
          { class: 'checks-how-step' },
          el('span', { class: 'checks-how-icon' }, icon(name)),
          el(
            'span',
            { class: 'checks-how-step-title' },
            el('span', { class: 'checks-how-num', 'aria-hidden': 'true', text: `${i + 1}` }),
            head,
          ),
          el('p', { class: 'checks-how-step-text' }, ...text),
        ),
      ),
    ),
    el('p', { class: 'checks-source', text: '"Turn on" and "Use as gates" need no agent: your click writes the change to queue.config.json right away.' }),
  );
  body.hidden = !t.checks.howOpen;
  const box = el('section', { class: `checks-how${t.checks.howOpen ? '' : ' is-closed'}` }, el('h3', { class: 'checks-how-title' }, toggle), body);
  toggle.addEventListener('click', () => {
    t.checks.howOpen = !t.checks.howOpen;
    store.setItem(CHECKS_HOW_KEY, t.checks.howOpen ? 'open' : 'closed');
    toggle.setAttribute('aria-expanded', String(t.checks.howOpen));
    body.hidden = !t.checks.howOpen;
    box.classList.toggle('is-closed', !t.checks.howOpen);
  });
  return box;
}

/**
 * The placeholders while the first read runs (B34, UX review C3): a summary box, a heading and three cards in the cards'
 * shape, so the view has its form at once and does not jump much when the report comes. Hidden from a screen reader,
 * which gets the one status line instead.
 */
function checksSkeleton() {
  const bars = () => [
    el('span', { class: 'checks-skeleton-bar checks-skeleton-short' }),
    el('span', { class: 'checks-skeleton-bar' }),
    el('span', { class: 'checks-skeleton-bar checks-skeleton-mid' }),
  ];
  return el(
    'div',
    { class: 'checks-skeleton', 'aria-hidden': 'true' },
    el('div', { class: 'checks-card checks-skeleton-box' }, ...bars()),
    el('span', { class: 'checks-skeleton-bar checks-skeleton-heading' }),
    el('ul', { class: 'checks-grid' }, ...[1, 2, 3].map(() => el('li', { class: 'checks-card checks-skeleton-card' }, ...bars()))),
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

/**
 * Recipe precision (report.recipePrecision, lib/recipePrecision.js): per recipe its gate proposals, how many were
 * accepted out of the decided ones, and whether it is damped. Text only. Shown only once a recipe has a proposal or an
 * owner's choice; the choice itself is `ravenseat checks recipe <id> show|damp|auto`.
 */
function checksPrecisionSection(precision) {
  const list = precision?.recipes ?? [];
  if (!list.length) return [];
  const row = (r) => {
    const rate = r.rate == null ? 'none decided yet' : `${r.accepted} accepted (${r.rate}%)`;
    const state = r.damped ? (r.by === 'owner' ? 'damped by you' : 'damped') : r.by === 'owner' ? 'shown by you' : 'shown';
    const pending = r.pending ? `, ${r.pending} waiting` : '';
    return el(
      'li',
      {},
      el('span', { class: 'checks-where', text: `${r.title}${r.db ? ' (database)' : ''}: ` }),
      el('span', { text: `${r.proposals} proposals, ${rate}${pending}, ${state}.` }),
      el('span', { class: 'checks-source', text: ` ${r.id}` }),
    );
  };
  const rule = precision.on
    ? `A recipe below ${precision.floor}% accepted after ${precision.min} decided proposals (${precision.minDb} for a database recipe) is damped: listed here, not offered on the card.`
    : 'Damping is off (learning.recipeDamping): every recipe is offered whatever its numbers.';
  return [
    el('h3', { class: 'decide-group-title', text: 'Recipe precision' }),
    el('p', { class: 'decide-hint', text: `Gate proposals from the finding log per recipe. ${rule} ravenseat checks recipe <id> show|damp|auto changes one.` }),
    el('ul', { class: 'checks-places checks-precision' }, ...list.map(row)),
  ];
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
 * Nothing when there are none of either. Each open one is a button that scrolls to its card and puts focus on it, and
 * "Go to suggestions" goes to the list (B34, UX review C1: the box said two were open and led nowhere, while the cards
 * stood below the fold). The headings are h3, the level of the view's other sections.
 */
function checksSummary(r) {
  // A card set aside that does not apply now (applies: false) is not an important gap: only the "Set aside" list has it.
  const high = r.suggestions.filter((s) => s.priority === 'high' && s.applies !== false);
  const open = high.filter((s) => s.state === 'open');
  const aside = high.filter((s) => s.state === 'dismissed');
  if (!open.length && !aside.length) return null;
  return el(
    'div',
    { class: 'checks-card checks-summary' },
    open.length
      ? el(
          'div',
          { class: 'checks-card-head' },
          el('h3', { class: 'checks-card-title', text: `Important: ${checksPlural(open.length, 'suggestion')} open` }),
          el('button', { type: 'button', class: 'button button-outline', text: 'Go to suggestions', onclick: () => checksGoTo(null) }),
        )
      : null,
    open.length
      ? el(
          'ul',
          { class: 'checks-summary-list' },
          ...open.map((s) =>
            el(
              'li',
              null,
              el('button', {
                type: 'button',
                class: 'link-button checks-summary-go',
                text: s.title,
                title: 'Shows this suggestion in the list below',
                onclick: () => checksGoTo(s.key),
              }),
            ),
          ),
        )
      : null,
    aside.length ? el('h3', { class: 'checks-card-title', text: `Skipped: ${checksPlural(aside.length, 'important suggestion')}` }) : null,
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
    el('p', { class: 'checks-source', text: 'The red dot on the tab follows the open ones. Settings can hide the dot.' }),
  );
}

/**
 * The tally at the top of the view (QA-1a): how many suggestions are open per level, as pills in the level colors
 * (High N, Medium N, Low N). "Open" is what the Important box counts: state open and not marked as not applying now;
 * a card in the queue, planned or set aside is not open. A zero count stays in its place but is muted (the neutral
 * tone), so the three slots never move and "Low 0" still says there are none. A screen reader gets one sentence; the
 * pills themselves are hidden from it, so it does not hear the same numbers twice.
 * Before the first report there is an empty placeholder of the same height, so nothing below moves when it comes.
 */
function checksTally(r) {
  if (!r) return el('div', { class: 'checks-tally checks-tally-pending', 'aria-hidden': 'true' });
  const open = r.suggestions.filter((s) => s.state === 'open' && s.applies !== false);
  const count = Object.fromEntries(CHECKS_LEVELS.map((l) => [l, open.filter((s) => s.priority === l).length]));
  return el(
    'div',
    { class: 'checks-tally' },
    el('span', {
      class: 'hidden-for-eye',
      text: `Open suggestions: ${count.high} high, ${count.medium} medium, ${count.low} low.`,
    }),
    el(
      'ul',
      { class: 'checks-tally-pills', 'aria-hidden': 'true' },
      ...CHECKS_LEVELS.map((l) =>
        el(
          'li',
          {
            class: `${checksPillClass(l)} checks-tally-item${count[l] ? '' : ' checks-pill-zero'}`,
            'data-level': l,
          },
          `${CHECKS_PRIORITY[l]} `,
          el('span', { class: 'checks-tally-count', text: String(count[l]) }),
        ),
      ),
    ),
    // The caption says what the pills count (owner QA 19.11). It holds no numbers, so the screen reader sentence above
    // stays the only place a screen reader hears them.
    el('p', { class: 'checks-tally-caption', text: 'Recommendations for your project' }),
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
      roomHelp('checks', 'Checks'),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: t.checks.fetching ? 'Reading …' : 'Read again',
        disabled: t.checks.fetching,
        onclick: () => getChecks(true),
      }),
      // The severity tally (QA-1a) sits on the heading's line, right-aligned, with its caption under it (owner QA
      // 19.11). Before the report it is a placeholder of the same height, so the heading line never changes height.
      checksTally(r),
      el('p', {
        class: 'decide-hint checks-note',
        text: 'Read from your files. Ravenseat did not run any of it, so this shows what is set up, not that it works.',
      }),
    ),
  );
  // "How it works" needs no report, so it stands from the first frame and nothing above the cards moves when they come.
  wrap.append(checksHow());
  if (!r) {
    if (t.checks.error) wrap.append(el('p', { class: 'empty', text: `Could not read the checks: ${t.checks.error}` }));
    else {
      // The first read: one polite status line, and placeholders in the cards' shape instead of an empty view (C3).
      wrap.setAttribute('aria-busy', 'true');
      wrap.append(el('p', { class: 'checks-source', role: 'status', text: 'Reading the project …' }), checksSkeleton());
    }
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
  const inCategory = open.filter((s) => wanted === 'all' || s.category === wanted);
  // A low idea with no signal in the project (quiet, lib/checksCatalog.js CONTEXT) is folded under "More ideas", so the
  // list starts with what the scan found. A card in the queue or planned stays up. Nothing is removed or lowered.
  const quiet = inCategory.filter((s) => s.quiet === true && s.state === 'open');
  const shown = inCategory.filter((s) => !quiet.includes(s));
  wrap.append(
    // The heading takes focus from "Go to suggestions" in the Important box (tabindex -1: not a tab stop of its own).
    el(
      'div',
      { class: 'checks-head' },
      el('h3', { id: 'checks-suggestions-title', class: 'decide-group-title', tabindex: '-1', text: 'Suggestions by category' }),
      filter,
    ),
    el('p', {
      class: 'decide-hint',
      text: 'Optional, all of them, the most important first in each group. "How it works" at the top shows what a button does. Nothing is built before you approve it.',
    }),
    shown.length
      ? el('div', { class: 'checks-groups' }, ...checksGroups(shown, r.categories))
      : el('p', { class: 'checks-text', text: quiet.length ? 'Nothing found that needs you. Some general ideas are below.' : 'No suggestions right now.' }),
  );
  if (quiet.length) {
    const more = el(
      'details',
      { class: 'checks-details checks-more' },
      // A native details and summary: a keyboard and a screen reader get the button and its open or closed state as
      // is. The hint describes the fold also while it is closed (a description may point at hidden text).
      el('summary', { text: `More ideas (${quiet.length})`, 'aria-describedby': 'checks-more-hint' }),
      el('p', { id: 'checks-more-hint', class: 'decide-hint', text: 'Low ideas that fit most projects with this setup. The scan found no gap behind them, so they wait here. They come up by themselves once something is found.' }),
      el('ul', { class: 'checks-grid' }, ...quiet.map((s) => checksSuggestionCard(s, r.categories))),
    );
    // Closed by default; a fold the owner opened stays open across redraws.
    more.open = t.checks.moreOpen;
    more.addEventListener('toggle', () => {
      t.checks.moreOpen = more.open;
    });
    wrap.append(more);
  }
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
            // Its condition no longer holds: brought back, it shows again once it applies.
            s.applies === false
              ? el('span', { class: 'checks-source', text: '(does not apply now) ', title: 'Brought back, it shows among the suggestions again once it applies to the project.' })
              : null,
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
  // The recipes' numbers under the suggestions: a damped recipe is listed here, not offered on its card.
  wrap.append(...checksPrecisionSection(r.recipePrecision));
  for (const e of r.catalogErrors ?? []) wrap.append(el('p', { class: 'setting-error', text: `A suggestion file has a mistake: ${e}` }));
  wrap.append(checksOffHint());
  main.append(wrap);
}

/**
 * The quiet way to turn the tab off (B28, UX review C2): a line at the end of the view that opens Settings on the
 * existing "Show the Checks tab" switch. It no longer sits in the header next to "Read again" with the same weight,
 * and the view writes nothing itself: the switch in Settings does the write, as before.
 */
function checksOffHint() {
  return el(
    'p',
    { class: 'checks-source checks-off-hint' },
    'Do not need this tab? ',
    el('button', {
      type: 'button',
      class: 'link-button',
      text: 'Turn it off in Settings',
      title: 'Opens Settings at the Checks switch. Guards and gates are not affected.',
      // openSettingsAt chooses the Checks tab first, then focuses the switch there (B8).
      onclick: () => openSettingsAt('checks-panel'),
    }),
  );
}
