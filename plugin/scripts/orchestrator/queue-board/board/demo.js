// =============================================================
// board/demo.js: demo mode in the browser (docs/board.md "Demo mode"; the rules and texts are lib/demoOffer.js, served
// as /demoOffer.js, and the server side is lib/demoMode.js).
//
// Three pieces:
//   - the offer card on an empty board that has never had a task (state().demo.offer from the server, minus "Not now"
//     for this visit, which is the browser's own sessionStorage);
//   - the banner at the top of every view while demo mode is on ("Demo data: nothing here is real", Back to my board,
//     Reset demo), and the "Demo · " prefix on the tab title (drawTabTitle in board/route.js adds it);
//   - the row at the bottom of Settings ("Show demo board").
// Every switch is POST /api/demo and then a reload, so nothing the browser kept from one queue (open panels, the plan
// views, the timeline) is shown on the other. The key is in sessionStorage (board/api.js getKey), so the reload keeps it.
// The server decides what is allowed in demo mode; a refused click shows its "Not in demo mode" message as a toast.
// =============================================================

/** The texts and the offer rule (lib/demoOffer.js), or null when the script did not load. */
const DEMO_UI = () => window.QueueDemo ?? null;

/** Is demo mode on (the server says so in every state)? */
function demoOn() {
  return t.data?.demo?.on === true;
}

/** "Not now" for this visit: sessionStorage, so the next visit (a new tab or browser session) offers it again. */
function demoNotNow() {
  try {
    return sessionStorage.getItem(DEMO_UI()?.NOT_NOW_KEY ?? 'queue-board-demo-not-now') === '1';
  } catch {
    return false; // storage blocked: the offer just shows (it has its own two other ways out)
  }
}
function setDemoNotNow() {
  try {
    sessionStorage.setItem(DEMO_UI()?.NOT_NOW_KEY ?? 'queue-board-demo-not-now', '1');
  } catch {
    // storage blocked: the card is hidden for this page only (t.demoNotNow below)
  }
  t.demoNotNow = true;
}

/**
 * POST /api/demo { action } and, for enter, reset and leave, a reload once the server has switched. dismiss only
 * redraws. A refusal or an error is a toast; the button is enabled again.
 */
async function demoDo(action, button) {
  if (button) button.disabled = true;
  try {
    const answer = await api('/api/demo', { action });
    if (action === 'dismiss') {
      message(answer?.message ?? DEMO_UI()?.TEXTS.neverDone ?? 'The demo offer is hidden.');
      await update(true);
      return;
    }
    location.reload();
  } catch (e) {
    message(e.message, true);
    if (button) button.disabled = false;
  }
}

/** The offer card above the first-run card, or null when it does not show. */
function demoOfferCard() {
  const D = DEMO_UI();
  if (!D || !t.data?.demo?.offer || t.demoNotNow || demoNotNow()) return null;
  const T = D.TEXTS;
  return el(
    'section',
    { class: 'demo-offer', 'aria-labelledby': 'demo-offer-title' },
    el('h2', { id: 'demo-offer-title', class: 'onboarding-title', text: T.offerTitle }),
    el('p', { text: T.offerBody }),
    el(
      'div',
      { class: 'demo-offer-buttons' },
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: T.show,
        onclick: (e) => demoDo('enter', e.currentTarget),
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: T.notNow,
        onclick: () => {
          setDemoNotNow();
          draw();
          $('onboarding-title')?.closest('section')?.querySelector('button')?.focus();
        },
      }),
      el('button', {
        type: 'button',
        class: 'link-button',
        text: T.never,
        onclick: (e) => demoDo('dismiss', e.currentTarget),
      }),
    ),
  );
}

/** The banner at the top of the page (#demo-banner in index.html), drawn with every new state. */
function drawDemoBanner() {
  const box = $('demo-banner');
  const D = DEMO_UI();
  const on = demoOn() && !!D;
  document.documentElement.classList.toggle('demo-mode', on);
  if (!box) return;
  if (!on) {
    if (!box.hidden) box.replaceChildren();
    box.hidden = true;
    return;
  }
  if (!box.hidden && box.childElementCount) return; // already drawn: keep focus and the buttons where they are
  const T = D.TEXTS;
  box.replaceChildren(
    el(
      'div',
      { class: 'demo-banner-content' },
      el('p', { class: 'demo-banner-title', text: T.banner }),
      el('p', { class: 'demo-banner-info', text: T.bannerInfo }),
    ),
    el(
      'div',
      { class: 'demo-banner-buttons' },
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: T.back,
        onclick: (e) => demoDo('leave', e.currentTarget),
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: T.reset,
        onclick: (e) => demoDo('reset', e.currentTarget),
      }),
    ),
  );
  box.hidden = false;
}

/** The last row in Settings: "Show demo board" (or, in the demo, the way back), with its info line. */
function demoSettingsSection() {
  const D = DEMO_UI();
  if (!D) return null;
  const T = D.TEXTS;
  const on = demoOn();
  return el(
    'section',
    { class: 'setting demo-setting', 'aria-labelledby': 'setting-demo' },
    el('h3', { id: 'setting-demo', class: 'setting-title', text: T.settingsTitle }),
    el('p', { id: 'setting-demo-help', class: 'setting-explanation', text: on ? T.bannerInfo : T.settingsInfo }),
    el('button', {
      id: 'settings-show-demo',
      type: 'button',
      class: 'button button-outline',
      text: on ? T.back : T.settingsTitle,
      'aria-describedby': 'setting-demo-help',
      onclick: (e) => demoDo(on ? 'leave' : 'enter', e.currentTarget),
    }),
  );
}
