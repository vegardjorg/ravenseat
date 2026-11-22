// =============================================================
// palette.js: the command palette on Ctrl+K (roadmap 0ø J7, plans/jira-vurdering-2026-11-18.md proposal 7; owner
// answer 4: navigate, open and copy the command, nothing that writes).
//
// One field that finds a view (the tabs), a card (id or title) or a setting (the registry rows from /api/settings, with
// their explanation) and goes there: a view opens like its tab, a card opens through the J2 deep link (#view=…&task=…,
// board/route.js), a setting opens Settings on its row. Each item shows the ravenseat command behind it; Shift+Enter or
// "Copy command" copies it. Nothing here changes the queue or a setting: a switch that weakens a guard is only reached
// in Settings, through its own dialog.
//
// Accessible as a modal dialog with a combobox and a listbox: the field keeps focus, the arrows move the active option
// (aria-activedescendant, aria-selected), Enter goes, Esc closes and focus goes back, Tab stays inside (QueueA11y).
// Ctrl+K (or Cmd+K) works only with board.shortcuts and board.palette on, never in a text field, a dialog or while a
// card is lifted (keysBusy, board/keys.js), so a field's own Ctrl+K is never taken.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

/** How many options the list shows at most (the rest: "type more to narrow it"). */
const PALETTE_MAX = 30;

const paletteBackground = $('palette-background');
const paletteBox = $('palette');
/** The element that had focus when the palette opened (focus goes back there). */
let paletteFrom = null;
/** The registry rows for the visit: null = not fetched yet, [] = none or could not be read. */
let paletteSettings = null;
let paletteSettingsError = null;
let paletteItems = [];
let paletteActive = 0;

const paletteOn = () => displayOn('shortcuts') && displayOn('palette');

/**
 * The views: each tab with its ravenseat command (null when the terminal has no single command for it). The label is
 * read from the tab itself, so it never drifts from what the board shows; a hidden tab is left out.
 */
const PALETTE_VIEWS = [
  { tab: 'show-decisions', what: 'What waits on you', cmd: 'ravenseat decide', go: () => openDecisions() },
  { tab: 'show-flat', what: 'The columns In queue, In progress, Review and Built', cmd: 'ravenseat show' },
  { tab: 'show-lanes', what: 'One row per project', cmd: 'ravenseat show --grouped' },
  { tab: 'show-plan', what: 'In focus, not in focus and on pause', cmd: 'ravenseat focus' },
  { tab: 'show-graph', what: 'Which tasks wait on which', cmd: null },
  { tab: 'show-timeline', what: 'What ran, what runs and the rough plan ahead', cmd: 'ravenseat schedule' },
  { tab: 'show-cloud', what: 'Tasks that can run in the cloud', cmd: 'ravenseat cloud-bundles' },
  { tab: 'show-statistics', what: 'Throughput, lead time and usage', cmd: 'ravenseat cost' },
  { tab: 'show-checks', what: 'What the project has for checking its code', cmd: 'ravenseat checks' },
  { tab: 'room-plans', what: 'The plan register', cmd: 'ravenseat plan show' },
];

/** The fixed places that are not tabs. */
const PALETTE_PLACES = [
  { label: 'Settings', what: 'Every setting, by category', cmd: 'ravenseat settings', go: () => openSettings() },
  { label: 'Since you left', what: 'What happened while you were away (in Decisions)', cmd: 'ravenseat since', go: () => openDecisions() },
  { label: 'Keyboard shortcuts', what: 'The overview of every key', cmd: null, go: () => openKeys() },
];

/** Opens a tab as a click on it does, after showing the Queue room when the tab lives there. */
function paletteOpenTab(id) {
  const tab = $(id);
  if (!tab || tab.hidden) return;
  if (id !== 'room-plans') window.QueuePlans?.showQueue?.();
  tab.click();
}

/** Every item the palette can show now (views, places, cards, settings), each { kind, label, what, cmd, go, hay }. */
function paletteAll() {
  const out = [];
  const add = (x) => out.push({ ...x, hay: `${x.label} ${x.what ?? ''} ${x.key ?? ''} ${x.cmd ?? ''}`.toLowerCase() });
  for (const v of PALETTE_VIEWS) {
    const tab = $(v.tab);
    if (!tab || tab.hidden) continue;
    const label = tab.textContent.replace(/\s+/g, ' ').trim();
    add({ kind: 'View', label, what: v.what, cmd: v.cmd, go: v.go ?? (() => paletteOpenTab(v.tab)) });
  }
  for (const p of PALETTE_PLACES) add({ kind: 'Open', ...p });
  for (const [id, x] of t.perId ?? new Map()) {
    const view = ['flat', 'lanes', 'graph'].includes(t.view) ? t.view : 'flat';
    add({
      kind: 'Task',
      key: id,
      label: `${id} ${x.k?.title ?? ''}`.trim(),
      what: x.k?.project ?? '',
      cmd: `ravenseat info ${id}`,
      // The J2 deep link: the hashchange applies it (board/route.js), the same as a link from the chat.
      go: () => {
        location.hash = routeHash({ view, task: id });
      },
    });
  }
  for (const r of paletteSettings ?? [])
    add({
      kind: 'Setting',
      key: r.key,
      label: r.title,
      what: r.explanation,
      cmd: `ravenseat settings ${r.key}`,
      go: async () => {
        await openSettings();
        focusSetting(settingTarget(r.key));
      },
    });
  return out;
}

/**
 * The items for a query: every word must appear; an id or a label that starts with the query comes first, then a
 * label that holds it, then the rest, each group in its own order (views, places, cards, settings).
 */
function paletteMatch(all, query) {
  const q = query.trim().toLowerCase();
  if (!q) return all.filter((x) => x.kind !== 'Setting');
  const words = q.split(/\s+/);
  const score = (x) => {
    const label = x.label.toLowerCase();
    if ((x.key ?? '').toLowerCase() === q) return 0;
    if (label.startsWith(q)) return 1;
    if (label.includes(q)) return 2;
    return 3;
  };
  return all
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => words.every((w) => x.hay.includes(w)))
    .sort((a, b) => score(a.x) - score(b.x) || a.i - b.i)
    .map(({ x }) => x);
}

/** The registry rows, once per visit (a failure is said in the list, the rest still works). */
async function paletteFetchSettings() {
  if (paletteSettings) return;
  paletteSettings = [];
  try {
    const d = await api('/api/settings');
    paletteSettings = (d?.registry?.categories ?? []).flatMap((c) => c.rows ?? []).filter((r) => r?.key && r.title);
    paletteSettingsError = null;
  } catch (e) {
    paletteSettingsError = e.message;
    paletteSettings = null; // try again on the next open
  }
  if (!paletteBackground.hidden) paletteDrawList();
}

function paletteField() {
  return $('palette-field');
}

/** The list for what is in the field now, and the active option's command in the footer. */
function paletteDrawList() {
  const field = paletteField();
  if (!field) return;
  const found = paletteMatch(paletteAll(), field.value);
  paletteItems = found.slice(0, PALETTE_MAX);
  paletteActive = Math.min(paletteActive, Math.max(0, paletteItems.length - 1));
  const list = $('palette-list');
  list.replaceChildren(
    ...paletteItems.map((x, i) =>
      el(
        'li',
        {
          id: `palette-option-${i}`,
          role: 'option',
          class: 'palette-option',
          'aria-selected': String(i === paletteActive),
          onclick: () => paletteGo(i),
          onmousemove: () => {
            if (paletteActive !== i) paletteSetActive(i);
          },
        },
        el('span', { class: 'palette-kind', text: x.kind }),
        el('span', { class: 'palette-label', text: x.label }),
        x.what ? el('span', { class: 'palette-what', text: x.what }) : null,
        x.cmd ? el('code', { class: 'palette-cmd', text: x.cmd }) : null,
      ),
    ),
  );
  const more = found.length - paletteItems.length;
  $('palette-empty').hidden = paletteItems.length > 0;
  $('palette-more').hidden = more <= 0;
  $('palette-more').textContent = more > 0 ? `${more} more: type more to narrow it.` : '';
  $('palette-note').textContent = paletteSettingsError ? `Settings could not be read (${paletteSettingsError}).` : '';
  $('palette-note').hidden = !paletteSettingsError;
  paletteSetActive(paletteActive);
}

/** Marks option i as active: aria-activedescendant on the field, aria-selected on the option, the footer's command. */
function paletteSetActive(i) {
  const field = paletteField();
  paletteActive = i;
  const opts = [...$('palette-list').children];
  opts.forEach((o, j) => o.setAttribute('aria-selected', String(j === i)));
  const x = paletteItems[i];
  if (x) {
    field.setAttribute('aria-activedescendant', `palette-option-${i}`);
    opts[i]?.scrollIntoView?.({ block: 'nearest' });
  } else field.removeAttribute('aria-activedescendant');
  const copy = $('palette-copy');
  copy.disabled = !x?.cmd;
  $('palette-active-cmd').textContent = x?.cmd ? x.cmd : x ? 'No single command for this one.' : '';
}

/** Goes to item i and closes the palette (focus moves to where the item leads, not back). */
function paletteGo(i) {
  const x = paletteItems[i];
  if (!x) return;
  closePalette({ keepFocus: true });
  x.go();
}

async function paletteCopy() {
  const x = paletteItems[paletteActive];
  if (!x?.cmd) return;
  await copyText(x.cmd, `Copied: ${x.cmd}`);
}

function drawPalette() {
  const field = el('input', {
    id: 'palette-field',
    class: 'palette-field',
    type: 'text',
    role: 'combobox',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-autocomplete': 'list',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    'aria-describedby': 'palette-hint',
    placeholder: 'A view, a card (id or title) or a setting',
  });
  field.addEventListener('input', () => {
    paletteActive = 0;
    paletteDrawList();
  });
  field.addEventListener('keydown', (e) => {
    const n = paletteItems.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) paletteSetActive((paletteActive + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) paletteCopy();
      else paletteGo(paletteActive);
    }
  });
  paletteBox.replaceChildren(
    el('h2', { id: 'palette-title', class: 'guard-title palette-title', text: 'Go to' }),
    el('label', { class: 'hidden-for-eye', for: 'palette-field', text: 'Find a view, a card or a setting' }),
    field,
    el('p', {
      id: 'palette-hint',
      class: 'palette-hint',
      text: 'Arrows move, Enter goes there, Shift+Enter copies the command, Esc closes. Nothing here changes the queue.',
    }),
    el('ul', { id: 'palette-list', class: 'palette-list', role: 'listbox', 'aria-label': 'Matches' }),
    el('p', { id: 'palette-empty', class: 'empty palette-empty', text: 'Nothing matches. Try an id, a word of a title or a tab name.', hidden: true }),
    el('p', { id: 'palette-more', class: 'palette-more', hidden: true }),
    el('p', { id: 'palette-note', class: 'palette-more', hidden: true }),
    el(
      'div',
      { class: 'guard-buttons palette-buttons' },
      el('code', { id: 'palette-active-cmd', class: 'palette-active-cmd', 'aria-live': 'polite' }),
      el('button', { type: 'button', id: 'palette-copy', class: 'button button-outline', text: 'Copy command', onclick: paletteCopy }),
      el('button', { type: 'button', class: 'button button-filled', text: 'Close', onclick: () => closePalette() }),
    ),
  );
}

/** Opens the palette (Ctrl+K, or the button in the shortcut overview). */
function openPalette() {
  if (!paletteBackground.hidden) return;
  paletteFrom = document.activeElement;
  paletteActive = 0;
  drawPalette();
  paletteBackground.hidden = false;
  paletteDrawList();
  paletteField().focus();
  paletteFetchSettings();
}

/** Closes it; focus goes back where it was unless `keepFocus` (an item leads somewhere). */
function closePalette({ keepFocus = false } = {}) {
  if (paletteBackground.hidden) return;
  paletteBackground.hidden = true;
  paletteBox.replaceChildren();
  paletteItems = [];
  const back = paletteFrom?.isConnected ? paletteFrom : null;
  paletteFrom = null;
  if (!keepFocus) back?.focus?.();
}

paletteBox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
    return;
  }
  window.QueueA11y.trapKey(e, paletteBox);
});
paletteBackground.addEventListener('click', (e) => {
  if (e.target === paletteBackground) closePalette();
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.altKey || e.shiftKey) return;
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'k') return;
  if (!paletteOn() || !paletteBackground.hidden || !keysBackground.hidden) return;
  // In the Plans room Ctrl+K stays the Plans command line (plans/work.js); the board palette is for the queue rooms.
  if (window.QueuePlans?.isPlans?.()) return;
  const active = document.activeElement;
  // Never in a text field (its own Ctrl+K, such as a link shortcut in an editor, stays its own).
  if (inputField(active) || active?.isContentEditable) return;
  if (keysBusy()) return;
  e.preventDefault();
  openPalette();
});

window.QueuePalette = { open: openPalette, close: closePalette, match: paletteMatch };
