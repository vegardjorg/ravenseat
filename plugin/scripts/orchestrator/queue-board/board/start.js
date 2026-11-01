// =============================================================
// start.js: the update banner, the logo, the search box, the link for the Plans room
// (window.QueueBoard) and the start (first fetch and the 15 second polling). Last of the board's scripts.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- The update banner (the rules and texts in lib/queueUpdate.js; the server sends `update` in the state) ----
/** The version whose banner was closed (localStorage through `store`, so blocked storage only means not remembered). */
const dismissedUpdate = () => store.getItem(window.QueueUpdate?.DISMISS_KEY ?? 'queue-board-update-dismissed');

/** One step: the text, and the command with a "Copy" button (the same look as the cloud commands). */
function updateStep(s) {
  return el(
    'li',
    { class: 'update-step' },
    s.text ? el('span', { text: s.text }) : null,
    s.command
      ? el(
          'div',
          { class: 'cloud-command' },
          el('code', { text: s.command }),
          el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Copy',
            'aria-label': `Copy ${s.command}`,
            onclick: () => copyText(s.command, 'The command is copied.'),
          }),
        )
      : null,
  );
}

function drawUpdateBanner() {
  const box = $('update-banner');
  const U = window.QueueUpdate;
  const n = t.data?.update ?? null;
  if (!box || !U || !n) {
    if (box) box.hidden = true;
    return;
  }
  const show = U.visible(n, dismissedUpdate());
  const parts = [];
  if (show.newVersion) {
    const v = n.newVersion;
    parts.push(
      el(
        'p',
        { class: 'update-banner-title' },
        `cq ${v.latest} is out (you have ${n.installed}). `,
        el('a', {
          href: v.changelog,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'What is new (CHANGELOG)',
        }),
      ),
      el('ol', { class: 'update-steps' }, ...v.steps.map(updateStep)),
    );
  }
  // The update steps already end with setup, so the setup notice shows on its own only without them.
  if (show.setup && !(show.newVersion && n.setup === 'run')) {
    if (n.setup === 'restart')
      parts.push(
        el('p', {
          class: 'update-banner-title',
          text:
            `Setup was run for cq ${n.setupVersion}, but this board still runs cq ${n.installed}. ` +
            'Stop the board and start it again to load the new version.',
        }),
      );
    else
      parts.push(
        el('p', {
          class: 'update-banner-title',
          text: n.setupVersion
            ? `cq ${n.installed} is installed, but the project was last set up for cq ${n.setupVersion}. Run setup again in Claude Code:`
            : `cq ${n.installed} is installed, but setup has not been recorded for it. Run setup again in Claude Code:`,
        }),
        el('ol', { class: 'update-steps' }, updateStep({ text: '', command: 'cq setup --settings' })),
      );
  }
  if (!parts.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const content = el('div', { class: 'update-banner-content' }, ...parts);
  // Only the new-version part can be closed (per version); the setup notice goes away when setup has been run.
  const close = show.newVersion
    ? el(
        'button',
        {
          type: 'button',
          class: 'button-icon update-banner-close',
          'aria-label': `Close the notice about cq ${n.newVersion.latest}`,
          title: 'Close until a newer version is out',
          onclick: () => {
            store.setItem(U.DISMISS_KEY, n.newVersion.latest);
            drawUpdateBanner();
          },
        },
        icon('close'),
      )
    : null;
  box.replaceChildren(content, ...(close ? [close] : []));
  box.hidden = false;
}

/**
 * The logo (optional file in the queue folder, served at /logo) sits in the fixed mascot zone in the left corner of the top.
 * Without a logo the zone is empty, but keeps its space, so the top does not jump when the file comes or goes.
 */
function drawLogo() {
  const zone = $('mascot');
  const exists = zone.querySelector('.logo');
  if (t.data?.logo && !exists) zone.append(el('img', { class: 'logo', src: '/logo', alt: '' }));
  else if (!t.data?.logo && exists) exists.remove();
  zone.classList.toggle('empty', !t.data?.logo);
}

// The speech bubble by the mascot: the logic lives in mascot.js and lib/queueMascot.js. The board reports new
// states (update) and owner actions (api) there, and has the choice Chatty / Events only / Off in the gear.

let searchTime = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTime);
  searchTime = setTimeout(() => {
    t.filter.search = $('search').value.trim().toLowerCase();
    // Flat and Project lanes hide the cards that do not match (hidden); no rebuild.
    if (t.data && (t.view === 'flat' || t.view === 'lanes')) {
      useSearch();
      drawMarkMatch();
      drawOptionLine();
      drawStripe();
    } else draw();
  }, 150);
});

// The Plans room (plans/plans.js) shows a queue task in Queue and uses the message from here.
window.QueueBoard = {
  showTask(id) {
    if (!t.perId.has(id)) {
      message(`${id} is not on the board (canceled or unknown).`, true);
      return;
    }
    if (!['flat', 'lanes'].includes(t.view)) setView('flat');
    draw();
    openPanel(id);
    main
      .querySelector(`.summary[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  },
  message: (text, error) => message(text, error),
};

// ---- Start ----
setTheme(themeSelected());
setView(t.view);
drawViewButton();
t.key = getKey();
if (!t.key) showKeyBanner();
drawStatus();
draw();
update(true);
const getAll = () => {
  if (t.keyInvalid) return; // the polling stops until the link is pasted
  update();
  if (t.view === 'statistics') getStatistics();
  if (t.view === 'cloud') getCloudQueue();
};
setInterval(() => {
  if (!document.hidden) getAll();
  // The age on the cards in In progress moves on without the queue changing.
  for (const e of main.querySelectorAll('[data-start]')) e.textContent = age(e.dataset.start);
  // The status becomes "Not updated since …" when fetching stops (closed tab, server down).
  if (!boosted) drawStatus();
}, 15_000);
window.addEventListener('focus', getAll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) getAll();
});
