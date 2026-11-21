// =============================================================
// api.js: the key and the API calls, the banner after a restart, the confirmation on a warning from the
// guard rules (409), the warning dialog with the slide before a guard is weakened (422 with `weaken`) and the
// fetching of the state (every 15 seconds; "unchanged" when nothing is new).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Key and API ----
function getKey() {
  const m = /[#&]key=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem(KEY, m[1]);
    // The key leaves the address at once. The rest of the hash (a deep link, #view=…&task=…, board/route.js) stays.
    history.replaceState(null, '', location.pathname + location.search + hashWithoutKey(location.hash));
  }
  return sessionStorage.getItem(KEY);
}
/** The hash without its key part ('#key=abc&task=X' gives '#task=X'; only a key gives ''). */
function hashWithoutKey(hash) {
  const rest = String(hash ?? '')
    .replace(/^#/, '')
    .split('&')
    .filter((p) => p && !/^key=/.test(p));
  return rest.length ? `#${rest.join('&')}` : '';
}

// ---- The banner after a restart ----
const keyBanner = $('key-banner');
/** Shows the banner and stops polling (t.keyInvalid). Old data stays, but the banner says so. */
function showKeyBanner() {
  t.keyInvalid = true;
  if (!keyBanner.hidden) return;
  keyBanner.hidden = false;
  document.body.classList.add('key-invalid');
}
$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const field = $('key-link');
  const error = $('key-error');
  const fresh = window.QueueA11y.keyFromLink(field.value);
  if (!fresh) {
    error.textContent = 'No key found. The link ends with #key=… .';
    error.hidden = false;
    field.focus();
    return;
  }
  sessionStorage.setItem(KEY, fresh);
  t.key = fresh;
  t.keyInvalid = false;
  t.version = null;
  field.value = '';
  error.hidden = true;
  keyBanner.hidden = true;
  document.body.classList.remove('key-invalid');
  update(true);
  if (t.view === 'statistics') getStatistics();
  if (t.view === 'cloud') getCloudQueue();
});

// The write calls that are the owner's actions (approve, resolve, mark, bulk, move, focus). After a successful call the
// mascot may say something (the night line on an owner action); a dry run or a preview does not count.
const OWNER_ACTIONS = new Set(['/api/action', '/api/bulk', '/api/move', '/api/focus', '/api/task-edit']);
async function api(filePath, body) {
  // B29: no write from a board that shows old data, so nobody acts on it. The reason is the error's text (the toast).
  if (body && t.stale) {
    const e = new Error(window.QueueA11y.STALE_BLOCKED);
    e.status = 0;
    e.blocked = true;
    throw e;
  }
  const init = { headers: { 'X-Queue-Key': t.key ?? '' } };
  if (body) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(filePath, init);
  } catch {
    // No answer at all (the server stopped, or the network is gone): a plain sentence instead of "Failed to fetch".
    const e = new Error(window.QueueA11y.plainError(0));
    e.status = 0;
    throw e;
  }
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  // 401 means the server has been restarted with a new key. The banner asks for the link, and
  // polling stops until the key is in place.
  if (res.status === 401) showKeyBanner();
  if (!res.ok) {
    // The status and the answer come along, so a warning from the guard rules (409 + confirm) can be confirmed.
    // The server's own message is plain text; without one, a plain sentence instead of "HTTP 500".
    const e = new Error(answer?.message ?? window.QueueA11y.plainError(res.status));
    e.status = res.status;
    e.answer = answer;
    throw e;
  }
  if (body && OWNER_ACTIONS.has(filePath) && !body.dry && !body.show)
    window.QueueMascotView?.ownerAction();
  return answer;
}

/**
 * A write call with the guard rules: if the server answers with a warning (409 with `confirm`), the board asks the owner
 * first and sends the call again with `confirm: true` (and the proposal's fields when the owner chose the proposal).
 * Returns the answer, or null when the owner cancelled. A stop (422) and other errors are thrown as before.
 */
async function writeWithGuard(filePath, body) {
  try {
    return await api(filePath, body);
  } catch (e) {
    if (e.status !== 409 || !e.answer?.confirm) throw e;
    const option = await confirmGuard(e.answer.guard ?? []);
    if (!option) return null;
    return api(filePath, { ...body, ...option, confirm: true });
  }
}

// ---- The confirmation on a warning ----
const guardBackground = $('guard-background');
const guardBox = $('guard');
/** Shows the warnings and waits for the owner: {} = do it anyway, the proposal's fields = the proposal, null = cancel. */
function confirmGuard(guard) {
  return new Promise((done) => {
    const from = document.activeElement;
    const warnings = guard.filter((v) => v.level === 'warning');
    const others = guard.filter((v) => v.level === 'info');
    const proposed = warnings.find((v) => v.proposed)?.proposed ?? null;
    const answer = (val) => {
      guardBackground.hidden = true;
      guardBox.replaceChildren();
      guardBox.removeEventListener('keydown', keys);
      if (from?.isConnected) from.focus();
      done(val);
    };
    const keys = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        answer(null);
      } else {
        // Focus stays in the dialog (the shared trap in a11y.js).
        window.QueueA11y.trapKey(e, guardBox);
      }
    };
    const cancel = el('button', {
      type: 'button',
      class: 'button button-outline',
      text: 'Cancel',
      onclick: () => answer(null),
    });
    guardBox.replaceChildren(
      el('h2', { id: 'guard-title', text: 'Are you sure?' }),
      el(
        'ul',
        { id: 'guard-text', class: 'guard-list' },
        warnings.map((v) => el('li', { text: v.text })),
        others.map((v) => el('li', { class: 'guard-info', text: v.text })),
      ),
      el(
        'div',
        { class: 'guard-buttons' },
        cancel,
        proposed
          ? el('button', {
              type: 'button',
              class: 'button button-muted',
              text: proposed.text,
              onclick: () => answer({ ...proposed.field }),
            })
          : null,
        el('button', {
          type: 'button',
          class: 'button button-filled',
          text: 'Do it anyway',
          onclick: () => answer({}),
        }),
      ),
    );
    guardBox.addEventListener('keydown', keys);
    guardBackground.hidden = false;
    cancel.focus();
  });
}
guardBackground.addEventListener('click', (e) => {
  if (e.target === guardBackground) guardBox.querySelector('button')?.click();
});

// ---- The warning before a guard is weakened (plans/innstillinger-vurdering-2026-11-12.md 6b) ----
// One dialog for every registry row with `weakens` (lib/settingsRegistry.js). The control that was tapped does not change:
// the caller puts it back at once and sends the change only when this resolves true, which only a completed slide does.
// Cancel, Close, Escape and a click outside resolve false. The server refuses the same change without confirm: 'weaken'
// (422), so the dialog is the way in, not the guard itself.

/** How long a held key (ArrowRight, Enter or Space) takes to complete the slide, and the step per tick and per press. */
const SLIDE_HOLD_MS = 1000;
const SLIDE_STEP = 10;

/**
 * The slide-to-confirm. A real slider for assistive technology (role slider, aria-valuenow 0-100, aria-valuetext "Not
 * confirmed" or "Confirmed"). Ways to complete it: drag the handle to the end (95 % or more; letting go earlier puts it
 * back), hold ArrowRight, Enter or Space for about a second (key repeats are ignored, the hold is timed), or press
 * ArrowRight ten times (a screen reader's increment). ArrowLeft, Home and Escape-free keys step back. A single click or
 * tap moves nothing, so it can never complete it.
 */
function slideToConfirm(onDone, label) {
  let pct = 0;
  let done = false;
  let timer = null;
  const fill = el('div', { class: 'slide-fill', 'aria-hidden': 'true' });
  const handle = el('div', {
    id: 'slide-handle',
    class: 'slide-handle',
    role: 'slider',
    tabindex: '0',
    'aria-label': label,
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
    'aria-valuetext': 'Not confirmed',
    'aria-describedby': 'slide-help',
  });
  const track = el('div', { class: 'slide-track' }, fill, el('span', { class: 'slide-label', 'aria-hidden': 'true', text: label }), handle);
  const set = (v) => {
    pct = Math.max(0, Math.min(100, Math.round(v)));
    handle.setAttribute('aria-valuenow', String(pct));
    handle.setAttribute('aria-valuetext', pct >= 100 ? 'Confirmed' : 'Not confirmed');
    track.style.setProperty('--slide', `${pct}%`);
    track.style.setProperty('--slide-n', String(pct));
    if (pct >= 100 && !done) {
      done = true;
      stop();
      onDone();
    }
  };
  const stop = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  // A held key: one step at once, then one per tick until SLIDE_HOLD_MS has passed (setTimeout, so a held key is timed
  // and not counted by the keyboard's repeat rate).
  const tick = () => {
    set(pct + SLIDE_STEP);
    if (!done) timer = setTimeout(tick, SLIDE_HOLD_MS / (100 / SLIDE_STEP));
  };
  handle.addEventListener('keydown', (e) => {
    if (done) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.repeat || timer != null) return;
      tick();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      set(pct - SLIDE_STEP);
    } else if (e.key === 'Home') {
      e.preventDefault();
      set(0);
    }
  });
  handle.addEventListener('keyup', stop);
  handle.addEventListener('blur', stop);
  // The pointer: only a drag of the handle moves it; letting go before the end puts it back.
  let from = null;
  handle.addEventListener('pointerdown', (e) => {
    if (done) return;
    from = { x: e.clientX, pct };
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!from || done) return;
    const room = track.clientWidth - handle.offsetWidth;
    if (room > 0) set(from.pct + ((e.clientX - from.x) / room) * 100);
  });
  const release = () => {
    if (!from || done) return;
    from = null;
    if (pct >= 95) set(100);
    else set(0);
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  return { track, handle, stop };
}

/**
 * The warning dialog: what the guard protects against, why turning it off is not a good idea, what changes, where it is
 * saved, and the slide. `w` is a registry row from /api/settings (or the 422 answer): title, key, protects, whyNot,
 * changes, storeText. Resolves true only after a completed slide.
 */
function confirmWeaken(w, optionText) {
  return new Promise((resolve) => {
    const from = document.activeElement;
    let slide = null;
    const answer = (val) => {
      slide?.stop();
      guardBackground.hidden = true;
      guardBox.classList.remove('weaken');
      guardBox.replaceChildren();
      guardBox.removeEventListener('keydown', keys);
      if (from?.isConnected) from.focus();
      resolve(val);
    };
    const keys = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        answer(false);
      } else if (e.key === 'Tab') window.QueueA11y.trapKey(e, guardBox);
    };
    slide = slideToConfirm(() => answer(true), 'Slide to weaken the guard');
    const part = (title, text) =>
      text ? el('section', { class: 'weaken-part' }, el('h3', { text: title }), el('p', { text })) : null;
    // The close button is first: a click outside clicks the first button (the shared background handler above).
    guardBox.replaceChildren(
      el(
        'button',
        { type: 'button', class: 'button-icon weaken-close', 'aria-label': 'Close, change nothing', onclick: () => answer(false) },
        icon('close'),
      ),
      el('h2', { id: 'guard-title', text: `Weaken a guard: ${w.title ?? w.key}${optionText ? ` (${optionText})` : ''}?` }),
      el(
        'div',
        { id: 'guard-text', class: 'weaken-text' },
        part('What it protects against', w.protects),
        part('Why turning it off is not a good idea', w.whyNot),
        part('What changes', w.changes),
        w.storeText ? el('p', { class: 'setting-meta', text: w.storeText }) : null,
      ),
      el('p', {
        id: 'slide-help',
        class: 'setting-meta',
        text: 'Nothing changes until the slide is completed. Drag the handle to the end, or focus it and hold the right arrow key or Enter for a second.',
      }),
      slide.track,
      el(
        'div',
        { class: 'guard-buttons' },
        el('button', { type: 'button', class: 'button button-filled', text: 'Cancel', onclick: () => answer(false) }),
      ),
    );
    guardBox.classList.add('weaken');
    guardBox.addEventListener('keydown', keys);
    guardBackground.hidden = false;
    // Cancel (the safe choice) has the focus first; Tab reaches the slide.
    guardBox.querySelector('.guard-buttons button')?.focus();
  });
}

/**
 * A write that may weaken a guard: when the server answers 422 with `weaken` (the page was stale, or a text value), the
 * dialog opens with the server's texts, and only a completed slide sends the call again with confirm: 'weaken'.
 * Returns the answer, or null when nothing was sent (cancelled). Other errors are thrown.
 */
async function writeWithWeaken(filePath, body, row) {
  try {
    return await writeWithGuard(filePath, body);
  } catch (e) {
    if (e.status !== 422 || !e.answer?.weaken) throw e;
    const yes = await confirmWeaken({ ...(row ?? {}), ...e.answer });
    if (!yes) return null;
    return writeWithGuard(filePath, { ...body, confirm: 'weaken' });
  }
}

/** Message after a successful write, with the info texts from the guard rules below. */
function messageWithInfo(ok, answer) {
  const info = Array.isArray(answer?.info) ? answer.info : [];
  message([ok, ...info].join('\n'), false, info.length ? 9000 : null);
}

// ---- Fetching (every 15 seconds and when the tab gets focus; the server answers "unchanged" when nothing is new) ----
let fetching = false;
let forceAfter = false; // a forced fetch that came while another was running: runs when that one is done
async function update(force) {
  // Without a valid key polling stops (the banner asks for the link); a forced fetch tries anyway.
  if (fetching && force) forceAfter = true; // otherwise the row would stay until the next poll
  if (fetching || !t.key || (t.keyInvalid && !force)) return;
  fetching = true;
  try {
    const q = t.version && !force ? `?version=${encodeURIComponent(t.version)}` : '';
    const answer = await api(`/api/state${q}`);
    t.error = null;
    t.errorKind = null;
    t.fetched = new Date();
    if (!answer.unchanged) {
      t.data = answer.data;
      t.version = answer.version;
      applyFeatures();
      // board.panelMode may have changed in the gear (QA-1c Q5): an open panel switches between float and beside now.
      if (!panel.hidden) applyPanelMode();
      indexes();
      drawLogo();
      drawUpdateBanner();
      // The mascot sees the change (events between two polls) and may say something.
      window.QueueMascotView?.newState(t.data);
      // The first state picks where the board lands: Decisions when anything waits on the owner (board/decide.js).
      if (typeof landingView === 'function') landingView();
      if (drag || boosted || t.busy || window.QueuePlan?.busy()) t.pending = true;
      else if (t.view === 'cloud')
        getCloudQueue(); // the bundles depend on the queue: fetch again
      else if (t.view !== 'statistics')
        draw(); // the statistics have their own fetching
      else drawFilter();
      // "Waiting on you": the one counter at the top (board/decide.js).
      drawWaitingButton();
      if (typeof drawDecisionsTab === 'function') drawDecisionsTab();
      if (typeof drawChecksTab === 'function') drawChecksTab();
      // The first state applies the deep link that opened the board (J2, board/route.js).
      if (typeof routeFirstState === 'function') routeFirstState();
    }
  } catch (e) {
    t.error = e.message;
    t.errorKind = window.QueueA11y.errorKind(e.status);
    if (!t.data) draw();
  } finally {
    fetching = false;
    drawStale();
    // While a card is lifted, the keyboard help text stays in the status line.
    if (!boosted) drawStatus();
  }
  if (forceAfter) {
    forceAfter = false;
    await update(true);
  }
}

function indexes() {
  t.perId = new Map();
  for (const [col, list] of Object.entries(t.data.columns))
    for (const k of list) t.perId.set(k.id, { k, col });
  // A selected card that has started, is done or is gone drops out of the selection.
  for (const id of t.marked) if (!markable(id)) t.marked.delete(id);
  if (t.anchor && !markable(t.anchor)) t.anchor = null;
}

/** The base gate's verdict after the update time (null = the base gate is off): " · Base main: RED (fix task X)". */
function baseHealthText(b, branch) {
  if (!b) return '';
  const word = { green: 'green', red: 'RED', unknown: 'not checked at this tip' }[b.status] ?? b.status;
  const fix = b.status === 'red' && b.fixTask ? ` (fix task ${b.fixTask}; ravenseat merge refuses other tracks)` : '';
  return ` · Base ${branch ?? ''}: ${word}${fix}`;
}

/** The push batch after the base health (null = no remote ref yet): " · Push: 4 of 10 tasks, NOT YET". */
function pushBatchText(p) {
  if (!p || !p.text) return '';
  return ` · Push: ${p.text}`;
}

/** " · Checks: 2 of 4 in place" while something is missing; nothing when all are in place or the overview is not in yet. */
function checksText(c) {
  if (!c?.steps?.length) return '';
  // A step the owner declined is settled: it does not count as missing.
  const wanted = c.steps.filter((s) => s.state !== 'declined');
  const done = wanted.filter((s) => s.state === 'done').length;
  return done === wanted.length ? '' : ` · Checks: ${done} of ${wanted.length} in place`;
}

// ---- Stale and error states (B29, S-stale; the rules and texts in a11y.js, staleView) ----
const staleBanner = $('stale-banner');
let staleRetrying = false;

/** The stale view now (null while live). */
function staleNow() {
  return window.QueueA11y.staleView({
    keyInvalid: !!t.keyInvalid,
    error: t.error ? (t.errorKind ?? 'server') : null,
    fetched: t.fetched?.getTime() ?? null,
    now: Date.now(),
  });
}

/** "Try again": one forced fetch, with the button busy meanwhile (a failed retry changes nothing else). */
async function retryStale(button) {
  if (staleRetrying) return;
  staleRetrying = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Trying …';
  try {
    await update(true);
  } finally {
    staleRetrying = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Try again';
    // Still stale: focus stays on the button. Back in contact the banner is gone, so focus goes to the board.
    if (button.isConnected && !staleBanner.hidden) button.focus();
    else main.querySelector('[tabindex="0"]')?.focus();
  }
}

/** The banner's content for one stale view: title, text, the command with Copy, and "Try again". */
function staleBannerContent(v) {
  const command = v.command
    ? el(
        'div',
        { class: 'cloud-command stale-banner-command' },
        el('code', { text: v.command }),
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Copy',
          'aria-label': `Copy ${v.command}`,
          onclick: () => copyText(v.command, 'The command is copied.'),
        }),
      )
    : null;
  const parts = [
    el(
      'div',
      { class: 'stale-banner-content' },
      el('p', { class: 'stale-banner-title', text: v.title }),
      el('p', { class: 'stale-banner-text', text: v.text }),
      command,
    ),
  ];
  if (v.retry)
    parts.push(
      el('button', {
        type: 'button',
        class: 'button button-outline stale-retry',
        text: 'Try again',
        onclick: (e) => retryStale(e.currentTarget),
      }),
    );
  return parts;
}

/**
 * Draws the stale state: the one banner (the key banner carries the key case), the dimmed board (body.stale), the
 * frozen times (boardNow in core.js reads t.stale) and the paused writes (api). Says each transition once in
 * #stale-live. Coming back hides the banner and draws the board again (fresh times), without a reload.
 */
function drawStale() {
  const before = t.stale;
  const after = staleNow();
  t.stale = after;
  document.body.classList.toggle('stale', !!after);
  // The key case: the key banner with its link field is the banner; it gets the time of the last update.
  const keyTime = $('key-banner-time');
  keyTime.hidden = after?.kind !== 'key';
  keyTime.textContent = after?.kind === 'key' ? after.text : '';
  const show = !!after && after.kind !== 'key';
  // Rebuilt only when the kind changes, so a failed retry neither moves focus nor flickers the banner.
  if (show && before?.kind !== after.kind) {
    staleBanner.replaceChildren(...staleBannerContent(after));
    staleBanner.className = `stale-banner stale-${after.tone}`;
  }
  staleBanner.hidden = !show;
  // The key banner is an alert of its own, so going to the key case is not said twice.
  const said = window.QueueA11y.staleAnnouncement(before, after);
  if (said && after?.kind !== 'key') $('stale-live').textContent = said;
  // Back in contact: the "Changes are paused" toast is no longer true, so it goes too.
  if (before && !after && $('message').textContent === window.QueueA11y.STALE_BLOCKED) hideToast('message');
  if (before && !after && t.data) {
    // Back in contact: the cards are drawn again from now (the ages count on), as after a new state.
    if (drag || boosted || t.busy || window.QueuePlan?.busy()) t.pending = true;
    else if (t.view === 'cloud') getCloudQueue();
    else if (t.view !== 'statistics') draw();
  }
  // The running times are only moved by the clock (a reused card keeps its text): set them when the state changes, so
  // they stop at the last update going stale and count from now coming back.
  if (!!before !== !!after)
    for (const e of main.querySelectorAll('[data-start]')) e.textContent = age(e.dataset.start);
}

/** A move or lift tried while the data is stale: the reason in the toast, and true so the caller stops. */
function staleBlocked() {
  if (!t.stale) return false;
  message(window.QueueA11y.STALE_BLOCKED, true);
  return true;
}

function drawStatus() {
  const s = $('status');
  if (!t.key) {
    s.textContent = 'Missing key: open the link queue-board wrote in the terminal.';
    s.classList.add('error');
    return;
  }
  // B29: while the data is stale the banner under the top says what is wrong; the status line only says how old the
  // data is ("Not updated since 14:05", on the warning surface). It is not live meanwhile (#stale-live says the
  // transitions once), so the 15 second clock and every failed retry stay silent.
  const old = !!t.stale;
  s.classList.remove('error');
  s.classList.toggle('stale', old);
  s.setAttribute('aria-live', old ? 'off' : 'polite');
  if (old) s.textContent = t.fetched ? window.QueueA11y.staleText(t.fetched) : 'Not updated yet';
  else if (t.fetched)
    s.textContent =
      `Updated at ${clock(t.fetched)}` +
      (t.data?.gitError
        ? ' (git status could not be read; uncommitted files are not checked)'
        : '') +
      baseHealthText(t.data?.baseHealth, t.data?.baseBranch) +
      pushBatchText(t.data?.pushBatch) +
      checksText(t.data?.checks);
}
