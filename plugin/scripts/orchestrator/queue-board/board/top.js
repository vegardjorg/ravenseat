// =============================================================
// top.js: the top: the theme, the sections in the gear, the modules (features in queue.config.json)
// and the view tabs.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- The top ----
// Three options, System, Light and Dark. "System" removes the choice from localStorage and follows
// the operating system. The theme is chosen only in the settings (the gear), as three radio buttons; the button
// at the top is removed to give room to the two rows.
function themeSelected() {
  return window.QueueA11y.themeFromSaved(store.getItem('queue-board-theme'));
}
function setTheme(option) {
  const html = document.documentElement;
  if (option === 'light' || option === 'dark') {
    html.dataset.theme = option;
    store.setItem('queue-board-theme', option);
  } else if (option === 'system') {
    delete html.dataset.theme;
    store.removeItem('queue-board-theme');
  }
  const now = themeSelected();
  // The radio buttons in the settings follow along when the panel is open.
  for (const r of panel.querySelectorAll('input[name="theme-option"]')) r.checked = r.value === now;
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTheme());

/** The help lives in the gear. The button switches the panel's content to "How to use the board". */
function helpSection() {
  return el(
    'section',
    { class: 'setting', 'aria-labelledby': 'setting-help' },
    el('h3', { id: 'setting-help', class: 'setting-title', text: 'Help' }),
    el('button', {
      type: 'button',
      class: 'button button-outline',
      text: 'How to use the board',
      onclick: () => {
        openHelp();
      },
    }),
  );
}

/** Theme in the settings: System, Light and Dark as a radio group. */
function themeSection() {
  const now = themeSelected();
  return el(
    'fieldset',
    { class: 'setting theme-option' },
    el('legend', { class: 'setting-title', text: 'Theme' }),
    window.QueueA11y.THEME_OPTION.map(({ val, text }) =>
      el(
        'label',
        { class: 'theme-row' },
        el('input', {
          type: 'radio',
          name: 'theme-option',
          value: val,
          checked: val === now,
          onchange: () => setTheme(val),
        }),
        val === 'system' ? `${text} (follows the operating system)` : text,
      ),
    ),
  );
}

/**
 * The picture in the top corner and how much it says. A switch picks the Ravenseat logo (the default; the raven on the
 * right talks) or the mascot. The speech choice, Chatty, Events only or Off (stored in localStorage by mascot.js),
 * applies to both. When the server has turned the mascot off (board.mascot "off" in queue.config.json, or
 * --mascot off), the speech choice is locked.
 */
function mascotSection() {
  const m = window.QueueMascotView;
  if (!m) return el('div', { hidden: true });
  const now = m.mode();
  // Hidden completely: the speech choice has no effect until the mascot is shown again.
  const locked = m.locked() || m.isHidden();
  return el(
    'fieldset',
    { class: 'setting theme-option' },
    el('legend', { class: 'setting-title', text: 'Logo and mascot' }),
    figureSwitch(),
    el('p', {
      class: 'setting-explanation',
      text: 'How often the speech bubbles show. Off keeps the picture and turns the bubbles off.',
    }),
    m.MODE_OPTIONS.map(({ val, text }) =>
      el(
        'label',
        { class: 'theme-row' },
        el('input', {
          type: 'radio',
          name: 'mascot-option',
          value: val,
          checked: val === now,
          disabled: locked,
          onchange: () => m.setMode(val),
        }),
        text,
      ),
    ),
    m.locked()
      ? el('p', {
          class: 'empty',
          text: 'Turned off for this board (board.mascot in queue.config.json or --mascot off).',
        })
      : null,
    hideMascotField(m),
  );
}

/** The switch between the Ravenseat logo (off, the default) and the mascot (on). Stored per browser (board/start.js). */
function figureSwitch() {
  return el(
    'label',
    { class: 'figure-switch' },
    el('input', {
      type: 'checkbox',
      class: 'switch',
      role: 'switch',
      id: 'figure-switch',
      checked: figure() === 'mascot',
      onchange: (e) => setFigure(e.target.checked ? 'mascot' : 'logo'),
    }),
    'Show the mascot instead of the logo',
  );
}

/** The whole picture (logo or mascot, and the bubbles) can be hidden in this browser, and shown again. */
function hideMascotField(m) {
  if (!m.hideMascot) return null;
  if (m.isHidden()) {
    return el(
      'div',
      { class: 'setting-field' },
      el('p', { class: 'setting-explanation', text: 'The picture is hidden in this browser.' }),
      el(
        'div',
        { class: 'setting-control' },
        el('button', {
          type: 'button',
          class: 'button button-muted',
          text: 'Show the picture again',
          onclick: () => {
            m.showMascot();
            drawSettings();
          },
        }),
      ),
    );
  }
  return el(
    'div',
    { class: 'setting-field' },
    el('p', {
      class: 'setting-explanation',
      text: 'Removes the picture and the bubbles in this browser. You can show it again here.',
    }),
    el(
      'div',
      { class: 'setting-control' },
      el('button', {
        type: 'button',
        class: 'button button-muted',
        text: 'Hide the picture completely',
        onclick: () => {
          m.hideMascot();
          drawSettings();
        },
      }),
    ),
  );
}

// ---- Modules (features in queue.config.json; the server sends them resolved with the state) ----
/** Is the module on? Without the field (a board server older than the switches) everything is on, as before. */
function featureOn(name) {
  const f = t.data?.features;
  return !f || f[name] === true;
}
/** A board switch (state.boardSwitches, lib/queueConfig.js boardSwitches): off until the state says it is on. */
function boardSwitch(name) {
  return t.data?.boardSwitches?.[name] === true;
}
/**
 * Hides the tabs and the Plans button of the modules that are off, and leaves a view (or the Plans room) that was
 * just switched off. Runs on every new state; cheap.
 */
function applyFeatures() {
  for (const [view, name] of Object.entries(VIEW_FEATURE)) $(`show-${view}`).hidden = !featureOn(name);
  // The Cloud tab comes with the module, unless the board switch showCloud is off (`ravenseat board-setting cloud off` or Settings, Cloud). A saved
  // Cloud view still opens without the tab (the view shows a note), so only a module that is off leaves the view.
  if (!boardSwitch('showCloud')) $('show-cloud').hidden = true;
  if (VIEW_FEATURE[t.view] && !featureOn(VIEW_FEATURE[t.view])) setView('flat');
  $('room-plans').hidden = !featureOn('plans');
  // Plans redraws only when the switches themselves changed (not on every poll).
  const key = JSON.stringify(t.data?.features ?? null);
  if (key !== t.featuresKey) {
    t.featuresKey = key;
    window.QueuePlans?.featuresChanged?.();
  }
}
window.QueueFeatures = { on: featureOn };

/** The gear's "Modules" section: each module on or off, read only (the switch is the file). */
function modulesSection() {
  const f = t.data?.features;
  if (!f) return null;
  return el(
    'section',
    { class: 'setting', 'aria-labelledby': 'setting-modules' },
    el('h3', { id: 'setting-modules', class: 'setting-title', text: 'Modules (read only)' }),
    el(
      'dl',
      { class: 'facts' },
      // flatMap: el() flattens only one level, so each dt/dd pair is spread here.
      // The cloud has its own section with a real switch.
      Object.keys(f).filter((name) => name !== 'cloud').flatMap((name) => [
        el('dt', { text: FEATURE_LABEL[name] ?? name }),
        el('dd', {
          text: `${f[name] ? 'On' : 'Off'}: set features.${name} in queue.config.json to change`,
        }),
      ]),
    ),
    el('p', {
      class: 'setting-source',
      text: 'The board reads queue.config.json when it starts: restart it after a change.',
    }),
  );
}

/**
 * One setting in the gear's Cloud section: a switch, a list or a number. Every change is `ravenseat cloud set`, the same command
 * Claude Code runs, and the server re-reads the file for the next state. A value that weakens a guard (collect auto, owner
 * decision 2026-11-12) comes back 422 from the server, and writeWithWeaken opens the warning dialog: only its completed
 * slide sends the change again. Cancelled = null: nothing was written, and the redraw puts the old value back.
 */
function cloudSettingRow(s) {
  const inputId = `cloud-setting-${s.key}`;
  const save = async (value) => {
    try {
      const answer = await writeWithWeaken('/api/action', { type: 'cloud-setting', key: s.key, value }, null);
      if (answer) message(`${s.label}: ${value}.`);
    } catch (e) {
      message(`Could not save: ${e.message}`, true);
    }
    await update(true);
    if (t.setting) drawSettings();
  };
  const described = { 'aria-describedby': `${inputId}-help` };
  let input;
  if (s.kind === 'switch') {
    input = el('input', { id: inputId, type: 'checkbox', role: 'switch', class: 'switch', checked: s.value === true, ...described });
    input.addEventListener('change', () => save(input.checked ? 'on' : 'off'));
  } else if (s.kind === 'choice') {
    input = el('select', { id: inputId, ...described }, s.choices.map((c) => el('option', { value: c, text: c, selected: c === s.value })));
    input.addEventListener('change', () => save(input.value));
  } else {
    input = el('input', { id: inputId, class: 'cloud-setting-number', type: 'number', min: '1', step: '1', value: String(s.value), ...described });
    input.addEventListener('change', () => save(input.value));
  }
  return el(
    'div',
    null,
    el('div', { class: 'helper-head' }, input, el('label', { for: inputId, text: s.label })),
    el('p', { id: `${inputId}-help`, class: 'setting-explanation', text: s.help }),
  );
}

/**
 * The gear's "Cloud" section. The first switch is all of the cloud part: off, nothing about the cloud shows anywhere. The rest only
 * shows with it on. Changes run `ravenseat cloud on|off`, `cloud set` and `board-setting cloud on|off`, the same commands Claude Code can run.
 */
function boardSection() {
  if (!t.data?.boardSwitches) return null;
  const cloudModule = featureOn('cloud');
  const main = el('input', {
    id: 'cloud-module',
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: cloudModule,
    'aria-describedby': 'cloud-module-help',
  });
  main.addEventListener('change', async () => {
    main.disabled = true;
    try {
      const answer = await writeWithGuard('/api/action', { type: 'cloud-switch', on: main.checked });
      if (answer) message(main.checked ? 'Cloud is on.' : 'Cloud is off, and hidden. Your settings are kept.');
    } catch (e) {
      message(`Could not save: ${e.message}`, true);
    }
    await update(true);
    if (t.setting) drawSettings();
  });
  const box = el('input', {
    id: 'board-show-cloud',
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: boardSwitch('showCloud'),
    disabled: !cloudModule,
    'aria-describedby': 'board-show-cloud-help',
  });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      const answer = await writeWithGuard('/api/action', { type: 'board-switch', name: 'showCloud', on: box.checked });
      if (answer) message(box.checked ? 'The Cloud tab is shown.' : 'The Cloud tab is hidden.');
    } catch (e) {
      message(`Could not save: ${e.message}`, true);
    }
    await update(true);
    if (t.setting) drawSettings();
  });
  return el(
    'section',
    { class: 'setting', 'aria-labelledby': 'setting-board' },
    el('h3', { id: 'setting-board', class: 'setting-title', text: 'Cloud' }),
    el('div', { class: 'helper-head' }, main, el('label', { for: 'cloud-module', text: 'Use cloud sessions' })),
    el('p', {
      id: 'cloud-module-help',
      class: 'setting-explanation',
      text: 'Tracks that run in Claude Code on the web, on your plan. Off hides all of it. What it needs: ravenseat cloud setup.',
    }),
    cloudModule ? el('div', { class: 'helper-head' }, box, el('label', { for: 'board-show-cloud', text: 'Show the Cloud tab' })) : null,
    cloudModule ? (t.data?.cloudSettings ?? []).map(cloudSettingRow) : null,
    cloudModule
      ? el('p', {
          id: 'board-show-cloud-help',
          class: 'setting-explanation',
          text: 'Everything here is saved for everyone. Claude Code: ravenseat cloud settings, ravenseat board-setting cloud on|off.',
        })
      : null,
  );
}

/** The first-run card: the queue has nothing open, so the columns would only say "Nothing here.". */
function onboardingCard() {
  const code = (text) => el('code', { text });
  return el(
    'section',
    { class: 'onboarding', 'aria-labelledby': 'onboarding-title' },
    el('h2', { id: 'onboarding-title', class: 'onboarding-title', text: 'The queue is empty' }),
    el('p', { text: 'Three steps to get work flowing:' }),
    el(
      'ol',
      { class: 'onboarding-steps' },
      el(
        'li',
        null,
        el('strong', { text: 'Add work: ' }),
        'say "add to the queue" in Claude Code (or ',
        code('ravenseat add --file task.json'),
        ').',
      ),
      el('li', null, el('strong', { text: 'Start the queue: ' }), code('/ravenseat:queue'), '.'),
      el(
        'li',
        null,
        el('strong', { text: 'Answer questions ' }),
        'here under "Waiting on you" when the queue needs you.',
      ),
    ),
    t.data?.checks?.next
      ? el('p', null, 'When you are ready: ', code('/ravenseat:kickstart'), ' adds automatic checks one step at a time. It is optional.')
      : null,
    el('button', {
      type: 'button',
      class: 'link-button',
      text: 'How to use the board',
      onclick: openHelp,
    }),
  );
}

function setView(v) {
  t.view = v;
  // 'decisions' (board/decide.js) and 'checks' (board/checks.js) are not VIEWS tabs and are not saved: the board picks
  // Decisions on load when anything waits on the owner. The queue view the owner had is kept for the way back.
  if (v !== 'decisions' && v !== 'checks') {
    store.setItem('queue-board-view', v);
    if (t.decide) t.decide.queueView = v;
  }
  if (typeof drawRoomTabs === 'function') drawRoomTabs();
  // Real tabs. The selected tab is the only tab stop in the tab list (roving tabindex).
  // In Decisions and Checks no view tab is selected; the one the owner had stays the tab stop.
  const stop = v === 'decisions' || v === 'checks' ? (t.decide?.queueView ?? 'flat') : v;
  for (const x of VIEWS) {
    const tab = $(`show-${x}`);
    tab.setAttribute('aria-selected', x === v ? 'true' : 'false');
    tab.tabIndex = x === stop ? 0 : -1;
  }
  if (v === 'statistics') {
    closeFilter(false);
    getStatistics();
  }
  if (v === 'cloud') {
    closeFilter(false);
    getCloudQueue();
  }
  if (v === 'checks') {
    closeFilter(false);
    closeViews(false);
  }
  // The plan shows areas and projects, not cards: the filter and view menus are closed.
  if (v === 'plan') {
    closeFilter(false);
    closeViews(false);
  }
}
for (const x of VIEWS)
  $(`show-${x}`).addEventListener('click', () => {
    setView(x);
    draw();
  });
// The arrow keys, Home and End move focus between the tabs; Enter or Space selects (manual activation, because a
// drawing of the board can take time).
$('tabs').addEventListener('keydown', (e) => {
  const tabs = VIEWS.map((x) => $(`show-${x}`)).filter((b) => !b.hidden); // a module that is off has no tab
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const j = window.QueueA11y.tabMeasure(tabs.length, i, e.key);
  if (j == null) return;
  e.preventDefault();
  tabs[i].tabIndex = -1;
  tabs[j].tabIndex = 0;
  tabs[j].focus();
});
// If focus leaves the tab list without anything being selected, the selected tab is the tab stop again.
$('tabs').addEventListener('focusout', (e) => {
  if ($('tabs').contains(e.relatedTarget)) return;
  const current = t.view === 'decisions' || t.view === 'checks' ? (t.decide?.queueView ?? 'flat') : t.view;
  for (const x of VIEWS) $(`show-${x}`).tabIndex = x === current ? 0 : -1;
});

// The statistics are fetched when the view is open (the server caches; "unchanged" when nothing is new).
let fetchingStat = false;
async function getStatistics() {
  if (fetchingStat || !t.key) return;
  fetchingStat = true;
  try {
    const q = t.stat.version ? `?version=${encodeURIComponent(t.stat.version)}` : '';
    const answer = await api(`/api/statistics${q}`);
    t.stat.error = null;
    if (!answer.unchanged) {
      t.stat.data = answer.data;
      t.stat.version = answer.version;
      if (t.view === 'statistics') draw();
    }
  } catch (e) {
    t.stat.error = e.message;
    if (t.view === 'statistics' && !t.stat.data) draw();
  } finally {
    fetchingStat = false;
  }
}
