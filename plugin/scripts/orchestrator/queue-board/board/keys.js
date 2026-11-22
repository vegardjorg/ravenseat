// =============================================================
// keys.js: keyboard shortcuts on the whole board and the ? overview (roadmap 0ø J3, plans/jira-vurdering-2026-11-18.md;
// owner answer 1: on by default, an off button in the overview and in Settings, no keys in text fields).
//
// ? opens the overview, / goes to the search, g and a letter opens a tab (d Decisions, q Queue, c Checks, s Statistics,
// p Plans), j and k move between cards in Flat and Project lanes. Decisions keeps its own keys (board/decide.js) and the
// card keys stay in interact.js and select.js; the overview lists them all from SHORTCUTS, the one list.
//
// Never fired: in a text field, a select or anything editable, in a dialog (the side panel while it is modal, the
// warning and bulk dialogs), while a card is lifted, or with Ctrl, Alt or Cmd held (the browser's own shortcuts are left
// alone). board.shortcuts false (Settings, Board and advice, or the button in the overview) turns them all off; the card
// and Decisions keys work either way, since they only act on what has focus.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

/** Every key the board knows, by where it works. The overview is drawn from this list. */
const SHORTCUTS = [
  {
    title: 'Anywhere on the board',
    keys: [
      ['?', 'This overview'],
      ['/', 'Go to the search'],
      ['Ctrl K', 'Command palette: go to a view, a card or a setting (J7, board.palette)'],
      ['g d', 'Decisions'],
      ['g q', 'Queue (the view you had)'],
      ['g c', 'Checks'],
      ['g s', 'Statistics'],
      ['g p', 'Plans'],
      ['j', 'Next card (Flat and Project lanes)'],
      ['k', 'Previous card'],
      ['Esc', 'Close the panel, this overview or the selection'],
    ],
  },
  {
    title: 'On a card',
    keys: [
      ['Enter', 'Open the card'],
      ['x', 'Select it for bulk actions'],
      ['Shift x', 'Select from the last selected to here'],
      ['Space', 'Lift it; arrows move it, Space drops, Esc cancels'],
      ['Arrows', 'Move between cards and columns'],
      ['Ctrl A', 'Select all shown cards'],
    ],
  },
  {
    title: 'In Decisions',
    keys: [
      ['j k', 'Next or previous decision'],
      ['Enter', 'Take the recommendation'],
      ['1 to 4', 'Pick that option'],
      ['u', 'Undo the last answer'],
    ],
  },
];

/** How long after g the second letter counts (ms). */
const G_WINDOW_MS = 1500;
let gPressedAt = 0;
/** The element that had focus when the overview opened (focus goes back there). */
let keysFrom = null;

const keysBackground = $('keys-background');
const keysBox = $('keys');

const shortcutsOn = () => displayOn('shortcuts');

/** One key as <kbd> parts: 'g d' gives g, a space and d, so it reads as the two keys in turn. */
function keyParts(text) {
  if (text === '1 to 4') return [el('kbd', { text: '1' }), ' to ', el('kbd', { text: '4' })];
  return text.split(' ').flatMap((k, i) => (i ? [' ', el('kbd', { text: k })] : [el('kbd', { text: k })]));
}

/** Turns board.shortcuts on or off through the same writer as Settings (= ravenseat settings set). */
async function switchShortcuts(on) {
  try {
    const answer = await writeWithWeaken('/api/setting', { key: 'board.shortcuts', value: on ? 'on' : 'off' }, null);
    if (!answer) return;
    message(
      on
        ? 'Keyboard shortcuts are on.'
        : 'Keyboard shortcuts are off. Settings, Board and advice turns them on again.',
    );
    await update(true);
  } catch (e) {
    message(`Could not save: ${e.message}`, true);
  }
  if (!keysBackground.hidden) drawKeys();
}

function drawKeys() {
  const on = shortcutsOn();
  keysBox.replaceChildren(
    el('h2', { id: 'keys-title', class: 'guard-title', text: 'Keyboard shortcuts' }),
    el('p', {
      class: 'keys-state',
      text: on
        ? 'One key at a time, never while you type in a field. Ctrl, Alt and Cmd stay with the browser, apart from Ctrl K for the palette.'
        : 'The shortcuts are off. The keys on a focused card and in Decisions still work.',
    }),
    el(
      'div',
      { class: 'keys-groups' },
      SHORTCUTS.map((g, i) =>
        el(
          'section',
          { class: 'keys-group', 'aria-labelledby': `keys-group-${i}` },
          el('h3', { id: `keys-group-${i}`, class: 'keys-group-title', text: g.title }),
          el(
            'dl',
            { class: 'keys-list' },
            g.keys.map(([k, what]) =>
              el('div', { class: 'keys-row' }, el('dt', null, keyParts(k)), el('dd', { text: what })),
            ),
          ),
        ),
      ),
    ),
    el(
      'div',
      { class: 'guard-buttons keys-buttons' },
      // J7: the palette from here too, for whoever reads the list before trying the key (palette.js loads after this).
      on && typeof openPalette === 'function' && displayOn('palette')
        ? el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Open the palette',
            onclick: () => {
              closeKeys();
              openPalette();
            },
          })
        : null,
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: on ? 'Turn shortcuts off' : 'Turn shortcuts on',
        onclick: () => switchShortcuts(!on),
      }),
      el('button', { type: 'button', id: 'keys-close', class: 'button button-filled', text: 'Close', onclick: closeKeys }),
    ),
  );
}

/** Opens the overview (also from the help in the gear, with the shortcuts off). */
function openKeys() {
  keysFrom = document.activeElement;
  drawKeys();
  keysBackground.hidden = false;
  $('keys-close')?.focus();
}

function closeKeys() {
  if (keysBackground.hidden) return;
  keysBackground.hidden = true;
  keysBox.replaceChildren();
  const back = keysFrom?.isConnected ? keysFrom : null;
  keysFrom = null;
  back?.focus?.();
}

keysBox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeKeys();
    return;
  }
  window.QueueA11y.trapKey(e, keysBox);
});
keysBackground.addEventListener('click', (e) => {
  if (e.target === keysBackground) closeKeys();
});

/** The cards a j or k can reach: the title buttons in the queue view, without those the search or a fold hides. */
function reachableCards() {
  return [...main.querySelectorAll('.summary-button')].filter((b) => !b.closest('[hidden]'));
}

function moveCard(step) {
  const cards = reachableCards();
  if (!cards.length) return false;
  const i = cards.indexOf(document.activeElement);
  const j = i < 0 ? (step > 0 ? 0 : cards.length - 1) : Math.max(0, Math.min(cards.length - 1, i + step));
  cards[j].focus();
  cards[j].scrollIntoView?.({ block: 'nearest' });
  return true;
}

/** The search: in a view that has none (Decisions, Checks, Statistics ...) the board goes back to a queue view first. */
function goToSearch() {
  if (document.body.classList.contains('room-plans')) return false;
  if ($('search-filter').hidden || !['flat', 'lanes', 'graph'].includes(t.view)) {
    const back = t.decide?.queueView;
    setView(['flat', 'lanes', 'graph'].includes(back) ? back : 'flat');
    draw();
  }
  $('search').focus();
  return true;
}

/** g and a letter: the tab, when it is shown. Returns true when the letter named one. */
function goToTab(letter) {
  const showQueue = () => window.QueuePlans?.showQueue?.();
  const open = (id) => {
    const tab = $(id);
    if (!tab || tab.hidden) return false;
    tab.click();
    return true;
  };
  switch (letter) {
    case 'd':
      openDecisions();
      return true;
    case 'q':
      return open('room-queue');
    case 'c':
      if ($('show-checks')?.hidden) return false;
      showQueue();
      return open('show-checks');
    case 's':
      if ($('show-statistics')?.hidden) return false;
      showQueue();
      return open('show-statistics');
    case 'p':
      return open('room-plans');
    default:
      return false;
  }
}

/** Is there a dialog, a lifted card or an open modal panel that owns the keys now? */
function keysBusy() {
  if (t.bulk || !$('guard-background').hidden || !$('bulk-background').hidden || boosted) return true;
  const panelOpen = t.selected || t.setting || t.help;
  return !!panelOpen && (panelModal() || panel.contains(document.activeElement));
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (!shortcutsOn() || !keysBackground.hidden) return;
  const active = document.activeElement;
  if (inputField(active) || active?.isContentEditable) return;
  if (keysBusy()) return;
  const plans = document.body.classList.contains('room-plans');
  // The second key after g.
  if (gPressedAt && Date.now() - gPressedAt < G_WINDOW_MS) {
    gPressedAt = 0;
    if (!e.shiftKey && goToTab(e.key.toLowerCase())) e.preventDefault();
    return;
  }
  gPressedAt = 0;
  if (e.key === '?') {
    e.preventDefault();
    openKeys();
    return;
  }
  if (e.shiftKey) return;
  if (e.key === 'g') {
    gPressedAt = Date.now();
    return;
  }
  if (e.key === '/') {
    if (goToSearch()) e.preventDefault();
    return;
  }
  // j and k in the queue views; Decisions has its own (board/decide.js).
  if ((e.key === 'j' || e.key === 'k') && !plans && ['flat', 'lanes'].includes(t.view)) {
    if (moveCard(e.key === 'j' ? 1 : -1)) e.preventDefault();
  }
});

window.QueueKeys = { SHORTCUTS, open: openKeys, close: closeKeys };
