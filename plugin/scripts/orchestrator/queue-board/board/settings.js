// =============================================================
// settings.js: the settings (the gear) and its tabs, General and Helper agents.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Settings (the gear) ----
async function openSettings() {
  t.selected = null;
  t.inbox = false;
  t.setting = { loading: true };
  showPanel();
  drawSettings();
  panel.querySelector('.button-icon')?.focus();
  await getSettings();
}
async function getSettings() {
  let answer;
  try {
    answer = await api('/api/settings');
  } catch (e) {
    answer = { error: e.message };
  }
  if (t.setting === null) return; // closed meanwhile
  t.setting = answer;
  drawSettings();
}

function drawSettings() {
  const d = t.setting;
  const scroll = panel.scrollTop;
  const header = el(
    'div',
    { class: 'panel-header' },
    el('div', null, el('h2', { id: 'panel-title', text: 'Settings' })),
    el(
      'button',
      { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
      icon('close'),
    ),
  );
  if (!d || d.loading || d.error) {
    panel.replaceChildren(
      header,
      helpSection(),
      themeSection(),
      mascotSection(),
      el('p', {
        class: 'empty',
        text: d?.error ? `Could not read the settings: ${d.error}` : 'Fetching the settings …',
      }),
    );
    return;
  }
  const o = d.setup;
  // Two tabs: General (everything that was here before) and Helper agents (the switches and the measurement).
  const tab = settingsTab();
  if (tab === 'helpers') {
    panel.replaceChildren(header, settingsTabs(tab), helpersPanel(d));
    panel.scrollTop = scroll;
    return;
  }
  panel.replaceChildren(
    header,
    settingsTabs(tab),
    el(
      'div',
      { id: 'settings-panel-general', role: 'tabpanel', 'aria-labelledby': 'settings-tab-general' },
      helpSection(),
      guidanceSection(d),
      checksSwitchSection(d),
      blockedColumnSection(),
      themeSection(),
      mascotSection(),
      el(
        'section',
        { class: 'setting', 'aria-labelledby': 'setting-queue' },
        el('h3', { id: 'setting-queue', class: 'setting-title', text: 'The queue' }),
        d.field.map((f) => settingField(f, d)),
      ),
      autoAcceptSection(d.autoAccept),
      undoSection(),
      el(
        'section',
        { class: 'setting', 'aria-labelledby': 'setting-setup' },
        el('h3', { id: 'setting-setup', class: 'setting-title', text: 'Setup (read only)' }),
        el('dl', { class: 'facts' }, setupFacts(o)),
      ),
      boardSection(),
      modulesSection(),
      el(
        'section',
        { class: 'setting', 'aria-labelledby': 'setting-rules' },
        el('h3', { id: 'setting-rules', class: 'setting-title', text: 'Rules from the skill' }),
        list2(o.rules),
        el('p', { class: 'setting-source', text: `Source: ${o.rulesSource}` }),
      ),
    ),
  );
  panel.scrollTop = scroll;
}

/** The one switch for advice about the project (`ravenseat guidance`, lib/guidance.js). It never stops a guard. */
function guidanceSection(d) {
  const error = el('p', { class: 'setting-error', role: 'alert', hidden: true });
  const box = el('input', {
    id: 'guidance-quiet',
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: d.guidance === 'quiet',
    'aria-describedby': 'guidance-help',
  });
  box.addEventListener('change', async () => {
    error.hidden = true;
    const wanted = box.checked;
    box.disabled = true;
    try {
      const answer = await writeWithGuard('/api/guidance', { mode: wanted ? 'quiet' : 'guided' });
      if (!answer) {
        box.checked = !wanted; // cancelled
        return;
      }
      messageWithInfo(wanted ? 'Advice off' : 'Advice on', answer);
      await getSettings();
      $('guidance-quiet')?.focus();
    } catch (e) {
      box.checked = !wanted;
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      box.disabled = false;
    }
  });
  return el(
    'section',
    { class: 'setting', 'aria-labelledby': 'setting-guidance' },
    el('h3', { id: 'setting-guidance', class: 'setting-title', text: 'Guidance' }),
    el('label', { for: 'guidance-quiet' }, box, ' I run my own setup'),
    el('p', {
      id: 'guidance-help',
      class: 'setting-explanation',
      text: 'Stops advice about CI, gates and lockfiles, the light review, intake triage and gate proposals. The secret check, merge guard, base gate and the limits on agents stay on. If no check is set up, nothing reminds you.',
    }),
    error,
  );
}

/** The opt-out for the Checks tab (`ravenseat checks on|off`). It is not a guard: gates and guards run as before. */
function checksSwitchSection(d) {
  const error = el('p', { class: 'setting-error', role: 'alert', hidden: true });
  const box = el('input', {
    id: 'checks-panel',
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: !!d.checksPanel,
    'aria-describedby': 'checks-panel-help',
  });
  box.addEventListener('change', async () => {
    error.hidden = true;
    const wanted = box.checked;
    box.disabled = true;
    try {
      await writeWithGuard('/api/checks', { action: wanted ? 'on' : 'off' });
      message(wanted ? 'Checks tab on' : 'Checks tab off');
      await update(true);
      await getSettings();
      $('checks-panel')?.focus();
    } catch (e) {
      box.checked = !wanted;
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      box.disabled = false;
    }
  });
  return el(
    'section',
    { class: 'setting', 'aria-labelledby': 'setting-checks' },
    el('h3', { id: 'setting-checks', class: 'setting-title', text: 'Checks' }),
    el('label', { for: 'checks-panel' }, box, ' Show the Checks tab'),
    el('p', {
      id: 'checks-panel-help',
      class: 'setting-explanation',
      text: 'What your project has for checking its code, and suggestions for what to add. Also ravenseat checks on|off in Claude Code. Off changes no gates or guards. Guidance above stops other advice.',
    }),
    error,
  );
}

/**
 * The Blocked column (board.blockedColumn, off by default): `ravenseat board-setting blocked on|off`, the same command
 * Claude Code runs. The server moves the stuck tasks there, so the board redraws from the next state.
 */
function blockedColumnSection() {
  if (!t.data?.boardSwitches) return null;
  const error = el('p', { class: 'setting-error', role: 'alert', hidden: true });
  const box = el('input', {
    id: 'board-blocked-column',
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: boardSwitch('blockedColumn'),
    'aria-describedby': 'board-blocked-column-help',
  });
  box.addEventListener('change', async () => {
    error.hidden = true;
    const wanted = box.checked;
    box.disabled = true;
    try {
      const answer = await writeWithGuard('/api/action', { type: 'board-switch', name: 'blockedColumn', on: wanted });
      if (!answer) {
        box.checked = !wanted; // cancelled
        return;
      }
      message(wanted ? 'The Blocked column is shown.' : 'The Blocked column is hidden.');
      await update(true);
      if (t.setting) drawSettings();
      $('board-blocked-column')?.focus();
    } catch (e) {
      box.checked = !wanted;
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      box.disabled = false;
    }
  });
  return el(
    'section',
    { class: 'setting', 'aria-labelledby': 'setting-blocked-column' },
    el('h3', { id: 'setting-blocked-column', class: 'setting-title', text: 'Columns' }),
    el('div', { class: 'helper-head' }, box, el('label', { for: 'board-blocked-column', text: 'Blocked as its own column' })),
    el('p', {
      id: 'board-blocked-column-help',
      class: 'setting-explanation',
      text:
        'Tasks with an open blocker that needs action (a merge conflict, red gates, a silent agent, an owner question and the like) ' +
        'get a column right after In queue, the ones holding back the most first. Tasks that only wait on another task or are on ' +
        'hold stay in In queue. Saved for everyone. Claude Code: ravenseat board-setting blocked on|off.',
    }),
    error,
  );
}

// ---- The settings tabs: General and Helper agents ----
const SETTINGS_TABS = [
  { id: 'general', text: 'General' },
  { id: 'helpers', text: 'Helper agents' },
];
/** The chosen tab (remembered in this browser; a value that is no tab gives General). */
function settingsTab() {
  const v = store.getItem('queue-board-settings-tab');
  return SETTINGS_TABS.some((x) => x.id === v) ? v : 'general';
}
function chooseSettingsTab(id, focus = false) {
  store.setItem('queue-board-settings-tab', id);
  drawSettings();
  if (focus) $(`settings-tab-${id}`)?.focus();
}
/** Real tabs (role tab, aria-selected, roving tabindex); the arrow keys, Home and End move and select. */
function settingsTabs(now) {
  return el(
    'div',
    {
      class: 'toggles settings-tabs',
      role: 'tablist',
      'aria-label': 'Settings',
      onkeydown: (e) => {
        const i = SETTINGS_TABS.findIndex((x) => `settings-tab-${x.id}` === document.activeElement?.id);
        if (i < 0) return;
        const j = window.QueueA11y.tabMeasure(SETTINGS_TABS.length, i, e.key);
        if (j == null) return;
        e.preventDefault();
        chooseSettingsTab(SETTINGS_TABS[j].id, true);
      },
    },
    SETTINGS_TABS.map((x) =>
      el('button', {
        type: 'button',
        id: `settings-tab-${x.id}`,
        class: 'toggles-button',
        role: 'tab',
        'aria-selected': x.id === now ? 'true' : 'false',
        'aria-controls': `settings-panel-${x.id}`,
        tabindex: x.id === now ? '0' : '-1',
        text: x.text,
        onclick: () => chooseSettingsTab(x.id, true),
      }),
    ),
  );
}

/**
 * The "Helper agents" tab: one row per helper with what it does, when it runs, an on/off switch (a real checkbox
 * with role switch and a label) and what it has cost (runs, minutes, tokens, USD, share of the task cost, findings).
 * The switch goes through /api/helper -> `ravenseat helpers on|off <agent>`; the board never writes the files itself.
 */
function helpersPanel(d) {
  const rows = Array.isArray(d.helpers) ? d.helpers : [];
  return el(
    'div',
    { id: 'settings-panel-helpers', role: 'tabpanel', 'aria-labelledby': 'settings-tab-helpers' },
    el(
      'section',
      { class: 'setting', 'aria-labelledby': 'setting-helpers' },
      el('h3', { id: 'setting-helpers', class: 'setting-title', text: 'Helper agents' }),
      el('p', {
        class: 'setting-explanation',
        text:
          'Optional reviewers on top of the fixed ones for the class (D: reviewer, D+: reviewer and reviewer-security). ' +
          'One runs for a task when it is on and one of its conditions hits. The conditions are in queue.config.json ' +
          '(helpers), or for a custom helper set with ravenseat helpers when; the switch here is saved in the queue. ' +
          'A custom helper (an agent file of the project) can only be switched on after Claude has reviewed it and you have ' +
          'approved it for the file as it is now; a later change to the file turns it off.',
      }),
      rows.length
        ? rows.map((h) => helperRow(h))
        : el('p', { class: 'empty', text: 'No helper agents in the setup (helpers in queue.config.json).' }),
    ),
    helperAddForm(),
  );
}

/** The review state of a custom helper as a badge: the words carry the meaning, the color only repeats it. */
const REVIEW_TONE = { approved: 'ok', 'needs-review': 'warn', changed: 'bad', missing: 'bad', unverified: 'warn' };
const SCAN_TEXT = { red: 'Scan: red', yellow: 'Scan: yellow', green: 'Scan: green' };
const SCAN_TONE = { red: 'bad', yellow: 'warn', green: 'ok' };

/** "2026-10-30 22:59" in the viewer's own time (stored in UTC). */
function localTime(iso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const x = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function helperRow(h) {
  const id = `helper-${h.name}`;
  const custom = h.source === 'custom';
  const error = el('p', { class: 'setting-error', role: 'alert', hidden: true });
  // A custom helper can only be switched on when it is approved for its file as it is now. The board can never
  // approve: that is Claude's review and the owner's yes (ravenseat helpers approve), so the switch is off and disabled
  // until then, with the reason next to it.
  const locked = custom && h.canEnable === false;
  const described = [`${id}-text`, `${id}-when`, `${id}-measure`];
  if (custom) described.splice(1, 0, `${id}-review`);
  const box = el('input', {
    id,
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: h.enabled,
    disabled: locked,
    'aria-describedby': described.join(' '),
  });
  box.addEventListener('change', () => saveHelper(h, box, error));
  const fixed = h.fixedIn?.length
    ? ` Also a fixed reviewer for class ${h.fixedIn.join(', ')} (reviewers), so the switch does not stop it there.`
    : '';
  return el(
    'div',
    { class: `setting-field helper-row${locked ? ' helper-locked' : ''}`, 'data-helper': h.name },
    el(
      'div',
      { class: 'helper-head' },
      box,
      el(
        'label',
        { for: id },
        el('span', { class: 'helper-title', text: h.title }),
        ' ',
        el('code', { text: h.name }),
      ),
      el('span', { class: 'helper-state', 'aria-hidden': 'true', text: h.enabled ? 'On' : 'Off' }),
    ),
    custom ? helperBadges(h) : null,
    el('p', { id: `${id}-text`, class: 'setting-explanation', text: h.text }),
    custom ? helperReview(h, `${id}-review`, locked) : null,
    el('p', { id: `${id}-when`, class: 'setting-meta', text: h.when + fixed }),
    helperMeasure(h, `${id}-measure`),
    error,
  );
}

/** The badges of a custom helper: custom, the scan level and the review state. */
function helperBadges(h) {
  const scan = h.scan?.level ? SCAN_TEXT[h.scan.level] ?? `Scan: ${h.scan.level}` : 'Not scanned';
  return el(
    'div',
    { class: 'helper-badges' },
    el('span', { class: 'badge helper-source', text: 'custom' }),
    el('span', {
      class: `badge helper-scan tone-${h.scan?.level ? SCAN_TONE[h.scan.level] ?? 'warn' : 'warn'}`,
      'data-scan': h.scan?.level ?? 'none',
      text: h.scan && h.scan.current === false ? `${scan} (older file)` : scan,
    }),
    el('span', {
      class: `badge helper-review tone-${REVIEW_TONE[h.review] ?? 'warn'}`,
      'data-review': h.review ?? 'unverified',
      text: h.reviewText ?? 'Not verified',
    }),
  );
}

/** Who approved it and when, or why the switch is locked and how to get it reviewed. */
function helperReview(h, id, locked) {
  const approved = h.approvedBy
    ? `Approved by ${h.approvedBy}${h.approvedAt ? ` on ${localTime(h.approvedAt)}` : ''}${h.review === 'changed' ? ', for an earlier version of the file' : ''}.`
    : 'Not approved yet.';
  const how = locked
    ? h.review === 'missing'
      ? ` The agent file ${h.path ?? ''} is missing, so it cannot be switched on.`
      : ` The switch unlocks after a review: ask Claude to "review the helper agent ${h.name}" (it scans and reads the file, reports to you and asks before approving). Approving is never done from the board.`
    : '';
  return el('p', { id, class: 'setting-meta helper-review-text', text: `${approved}${how} File: ${h.path ?? '(no path)'}.` });
}

/**
 * "Add helper": paste the path of an agent file (.md). The server runs `ravenseat helpers add`, which copies the file to
 * .claude/agents/, hashes and scans it and leaves the helper off and locked until it is reviewed and approved.
 */
function helperAddForm() {
  const error = el('p', { id: 'helper-add-error', class: 'setting-error', role: 'alert', hidden: true });
  const file = el('input', {
    id: 'helper-add-path',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'C:\\agents\\my-check.md',
    'aria-describedby': 'helper-add-help',
  });
  const name = el('input', {
    id: 'helper-add-name',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'helper-add-help',
  });
  const add = el('button', { type: 'button', id: 'helper-add', class: 'button button-muted', text: 'Add helper' });
  add.addEventListener('click', () => addHelper(file, name, add, error));
  for (const input of [file, name])
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add.click();
      }
    });
  return el(
    'section',
    { class: 'setting helper-add-form', 'aria-labelledby': 'setting-helper-add' },
    el('h3', { id: 'setting-helper-add', class: 'setting-title', text: 'Add a custom helper' }),
    el('p', {
      id: 'helper-add-help',
      class: 'setting-explanation',
      text:
        'Paste the path of an agent file (.md) on this machine. It is copied to .claude/agents/, hashed and scanned, ' +
        'and stays off until Claude has reviewed it and you have approved it. Nothing in the file is run.',
    }),
    el(
      'div',
      { class: 'setting-field' },
      el('label', { for: 'helper-add-path', text: 'Path to the agent file' }),
      el('div', { class: 'setting-control' }, file),
      el('label', { for: 'helper-add-name', text: 'Name (optional, otherwise the name in the file)' }),
      el('div', { class: 'setting-control' }, name, add),
      error,
    ),
  );
}

async function addHelper(file, name, button, errorEl) {
  errorEl.hidden = true;
  button.disabled = true;
  try {
    const answer = await writeWithGuard('/api/helper-add', { path: file.value.trim(), name: name.value.trim() });
    if (!answer) return;
    messageWithInfo('Helper added (off until reviewed and approved)', answer);
    await getSettings();
    $('helper-add-path')?.focus();
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.hidden = false;
    button.disabled = false;
    file.focus();
  }
}

/** The measurement: "No runs yet", or the numbers as a small list of facts. */
function helperMeasure(h, id) {
  const s = h.stats;
  // The intake triage answers with verdicts (counted from the tasks), also before its cost is measured at set done.
  const v = s?.verdicts;
  const verdicts = v
    ? facts('Verdicts', `ready ${v.ready}, done ${v.done}, stale ${v.stale}, adjust ${v.adjust} (${v.saved} track run(s) stopped)`)
    : [];
  if (v?.total && !s.runs) return el('dl', { id, class: 'facts helper-measure' }, verdicts);
  if (!s || !s.runs) return el('p', { id, class: 'setting-meta helper-empty', text: 'No runs yet' });
  const tok = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const rows = [
    ...facts('Runs', `${s.runs} on ${s.tasks} task(s)`),
    ...facts('Minutes', s.minutes ? `${s.minutes.median} median, ${s.minutes.sum} total` : 'not measured'),
    ...facts('Tokens', s.tokens ? `${tok(s.tokens.median)} median, ${tok(s.tokens.sum)} total` : 'not measured'),
    ...facts('Cost', s.usd ? `${usd(s.usd.median)} median, ${usd(s.usd.sum)} total` : 'not measured'),
    ...facts('Share of the task cost', s.sharePct != null ? `${s.sharePct} %` : 'not measured'),
    ...(v
      ? verdicts
      : facts(
          'Findings',
          s.findings.reviewed
            ? `H=${s.findings.H} M=${s.findings.M} L=${s.findings.L} (${s.findings.perRun} per run)`
            : 'no FINDINGS lines measured',
        )),
  ];
  return el('dl', { id, class: 'facts helper-measure' }, rows);
}

async function saveHelper(h, box, errorEl) {
  errorEl.hidden = true;
  const wanted = box.checked;
  box.disabled = true;
  try {
    const answer = await writeWithGuard('/api/helper', { name: h.name, enabled: wanted });
    if (!answer) {
      box.checked = !wanted; // cancelled
      return;
    }
    messageWithInfo(`${h.title}: ${wanted ? 'on' : 'off'}`, answer);
    await getSettings();
    $(`helper-${h.name}`)?.focus();
  } catch (e) {
    // Not saved: the switch goes back, and the message from queue.mjs is shown by the row.
    box.checked = !wanted;
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  } finally {
    box.disabled = false;
  }
}

function settingField(f, d) {
  const id = `g-${f.name}`;
  const error = el('p', { class: 'setting-error', role: 'alert', hidden: true });
  const control =
    f.type === 'onoff'
      ? el(
          'select',
          { id, 'aria-describedby': `${id}-help` },
          ['on', 'off'].map((v) =>
            el('option', { value: v, selected: f.val === v, text: v === 'on' ? 'On' : 'Off' }),
          ),
        )
      : el('input', {
          id,
          type: 'text',
          value: f.val,
          inputmode: f.type === 'integer' ? 'numeric' : null,
          autocomplete: 'off',
          'aria-describedby': `${id}-help`,
        });
  const save = el('button', {
    type: 'button',
    class: 'button button-muted',
    text: 'Save',
    'aria-label': `Save ${f.title.toLowerCase()}`,
    onclick: () => saveLimit(f, control.value, error),
  });
  control.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save.click();
    }
  });
  const meta = [
    `now: ${f.val}`,
    `default: ${f.standard}`,
    // SAVER_MODE: the recommended ceiling that keeps the weekly quota from running out early.
    f.saverMode ? `recommended: at most ${f.saverMode}` : null,
    f.name === 'dailyBudget' ? `used today: ${usd(d.usageToday)}` : null,
    f.name === 'nightRun' && d.night?.stop ? 'night pause now' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return el(
    'div',
    { class: 'setting-field' },
    el('label', { for: id, text: f.title }),
    el('p', { id: `${id}-help`, class: 'setting-explanation', text: f.explanation }),
    el('div', { class: 'setting-control' }, control, save),
    el('p', { class: 'setting-meta', text: meta }),
    error,
  );
}

/**
 * "Auto-accept proposals": the switch and the rules (classes, max estimate, max value), saved together with
 * /api/proposals (= `ravenseat proposals auto ...`), and the log with an Undo button per row (/api/proposals-undo =
 * `ravenseat proposals undo <id>`). The hard rules (never D or D+, owner questions, legal, protected paths) are not settings.
 */
function autoAcceptSection(a) {
  if (!a?.rules) return null;
  const r = a.rules;
  const error = el('p', { id: 'aa-error', class: 'setting-error', role: 'alert', hidden: true });
  const enabled = el('input', {
    id: 'aa-enabled',
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: r.enabled,
    'aria-describedby': 'aa-help',
  });
  const classes = (a.allowedClasses ?? ['K', 'U']).map((k) =>
    el('input', { id: `aa-class-${k}`, type: 'checkbox', value: k, checked: r.classes.includes(k) }),
  );
  const number = (id, v) =>
    el('input', {
      id,
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      value: v == null ? '' : String(v),
      placeholder: 'no cap',
      'aria-describedby': 'aa-help',
    });
  const maxEstimate = number('aa-max-estimate', r.maxEstimateMin);
  const maxValue = number('aa-max-value', r.maxValue);
  const save = el('button', {
    type: 'button',
    id: 'aa-save',
    class: 'button button-muted',
    text: 'Save',
    'aria-label': 'Save the auto-accept rules',
    onclick: () => saveAutoAccept({ enabled, classes, maxEstimate, maxValue }, error),
  });
  const log = Array.isArray(a.log) ? a.log : [];
  return el(
    'section',
    { class: 'setting auto-accept', 'aria-labelledby': 'setting-auto-accept' },
    el('h3', { id: 'setting-auto-accept', class: 'setting-title', text: 'Auto-accept proposals' }),
    el('p', {
      id: 'aa-help',
      class: 'setting-explanation',
      text:
        'Proposals from agents that fit these rules are approved by the queue itself (when added, and at the ' +
        'orchestrator pulse) and logged below, where you can undo them. Empty max = no cap. Never D or D+, never a ' +
        'task waiting on you, with a legal or owner label, a plan entry with open legal points, or protected paths, ' +
        'whatever is set here.',
    }),
    el(
      'div',
      { class: 'setting-field' },
      el(
        'div',
        { class: 'helper-head' },
        enabled,
        el('label', { for: 'aa-enabled', text: 'Auto-accept proposals' }),
      ),
      el(
        'fieldset',
        { class: 'aa-classes' },
        el('legend', { text: 'Classes' }),
        classes.map((box) => el('label', { for: box.id }, box, ` ${box.value}`)),
      ),
      el('label', { for: 'aa-max-estimate', text: 'Max estimate (minutes)' }),
      el('div', { class: 'setting-control' }, maxEstimate),
      el('label', { for: 'aa-max-value', text: 'Max value (1-10)' }),
      el('div', { class: 'setting-control' }, maxValue, save),
      el('p', {
        class: 'setting-meta',
        text: `now: ${r.enabled ? 'on' : 'off'} · classes ${r.classes.join(', ') || 'none'} · default: off, K, 60 min`,
      }),
      error,
    ),
    el('h4', { class: 'aa-log-title', text: 'Auto-accepted' }),
    log.length
      ? el(
          'ul',
          { class: 'aa-log', 'aria-label': 'Auto-accepted proposals' },
          log.map((x) =>
            el(
              'li',
              { class: 'aa-row', 'data-id': x.id },
              el('span', {
                class: 'aa-row-text',
                text:
                  `${x.id}${x.title ? ` ${x.title}` : ''}: ${x.reason} (${age(x.at)} ago)` +
                  (x.undone ? ', undone' : ''),
              }),
              x.canUndo
                ? el('button', {
                    type: 'button',
                    class: 'button button-outline button-small',
                    text: 'Undo',
                    'aria-label': `Undo the auto-accept of ${x.id}`,
                    onclick: () => undoAutoAccept(x.id, error),
                  })
                : null,
            ),
          ),
        )
      : el('p', { class: 'empty', text: 'Nothing has been auto-accepted.' }),
  );
}

async function saveAutoAccept(c, errorEl) {
  errorEl.hidden = true;
  // Empty = no cap (null); anything else goes as a number, and queue.mjs validates it.
  const num = (s) => {
    const v = String(s ?? '').trim();
    return v === '' ? null : Number(v);
  };
  try {
    const answer = await writeWithGuard('/api/proposals', {
      enabled: c.enabled.checked,
      classes: c.classes.filter((b) => b.checked).map((b) => b.value),
      maxEstimateMin: num(c.maxEstimate.value),
      maxValue: num(c.maxValue.value),
    });
    if (!answer) return;
    messageWithInfo('Auto-accept: saved', answer);
    await getSettings();
    $('aa-save')?.focus();
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  }
}

async function undoAutoAccept(id, errorEl) {
  errorEl.hidden = true;
  try {
    const answer = await writeWithGuard('/api/proposals-undo', { id });
    if (!answer) return;
    messageWithInfo(`${id}: back to proposed`, answer);
    await getSettings();
    update(true);
    $('aa-enabled')?.focus();
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  }
}

async function saveLimit(f, val, errorEl) {
  errorEl.hidden = true;
  try {
    const answer = await writeWithGuard('/api/limit', { name: f.name, val: String(val).trim() });
    if (!answer) return; // aborted
    messageWithInfo(`${f.title}: saved`, answer);
    await getSettings();
    update(true);
  } catch (e) {
    // The message from queue.mjs (or the guard rules) is shown by the field.
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  }
}

function setupFacts(o) {
  const orch = o.orchestrator ?? {};
  const orchestrator = orch.updated
    ? `${orch.session ?? '?'}: ${orch.active ? 'active' : (orch.reason ?? 'not active')}, last pulse ${age(orch.updated)} ago` +
      (orch.event ? ` (${orch.event})` : '')
    : 'no marker (no orchestrator has reported in)';
  const model = o.models?.length
    ? o.models.map((m) => `${m.model} (${m.count})`).join(', ')
    : 'not logged yet';
  // Plugin install: the hooks are in the plugin's hooks/hooks.json and the skills in its skills/ folder.
  // Vendored install: they are in the project's .claude/settings.json and .claude/skills/<name>/SKILL.md.
  const plugin = o.install?.mode === 'plugin';
  const from = plugin ? ' (from the plugin)' : '';
  const hooks = !o.hooks
    ? plugin
      ? "could not read the plugin's hooks/hooks.json"
      : 'could not find .claude/settings.json'
    : o.hooks.all
      ? `yes, all the queue system hooks are in place${from}`
      : el('strong', { class: 'fare', text: `missing: ${o.hooks.missing.join(', ')}` });
  const skills = !o.skills
    ? 'unknown'
    : o.skills.all
      ? `yes, all (${o.skills.exists.join(', ')})${from}`
      : el('strong', { class: 'fare', text: `missing: ${o.skills.missing.join(', ')}` });
  const install = plugin
    ? `plugin${o.install.name ? ` ${o.install.name}` : ''}${o.install.version ? ` ${o.install.version}` : ''}`
    : 'vendored (scripts and skills copied into the project)';
  const rows = [
    ...facts('Installed as', o.install ? install : null),
    ...facts('Base branch', o.baseBranch ?? 'main'),
  ];
  // The migrations are shown only when the project has turned them on (migrations.folder in queue.config.json).
  const m = o.migrations;
  if (m) {
    const highest = m.highest ? `${m.highest.number} (${m.highest.file})` : 'none';
    rows.push(
      ...facts(
        'Migrations',
        m.error
          ? `could not read ${m.folder} (${m.error})`
          : `next available block ${m.next ?? '?'}; highest in ${m.folder}: ${highest}`,
      ),
    );
  }
  rows.push(
    ...facts('Orchestrator', orchestrator),
    ...facts('Model in the last tracks', model),
    ...facts('Queue system hooks', hooks),
    ...facts('Queue system skills', skills),
  );
  return rows;
}
