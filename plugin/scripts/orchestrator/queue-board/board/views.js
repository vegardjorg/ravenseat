// =============================================================
// views.js: the wiring of the Focus view (plan.js), the one-row focus line with "+N more", grouping in Flat and
// Project lanes, and the quick and saved filters (drawn in the Filter menu, board/menus.js).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- The plan view (plan.js), the focus line, grouping, saved views and the help ----
/** What plan.js needs from the board (the same helpers and the same write path). */
function planContext() {
  return {
    main,
    data: t.data,
    el,
    icon,
    api,
    message,
    messageWithInfo,
    update: (force) => update(force),
    drawOnNew: draw,
    status: (text) => ($('status').textContent = text),
    pending: () => t.pending,
    // The "?" for the Focus toolbar (B30).
    help: roomHelp,
    // "How focus works" and "What happens now" at the top of the view (B18).
    howBox: focusHowBox,
    whatNow: () => focusNowLine(),
  };
}

// ---- Focus on the cards (B21) ----
// "Add to focus" and "Remove from focus" in the detail panel, in the selection menu and on an outside-focus card. Every one goes
// through POST /api/focus { change } with the dry preview first (plan.js changeFocus, the same dialog as Save focus).

/**
 * How the saved focus covers a card:
 *   none     no focus, or the task is not ranked now (running, done, ...): no focus action
 *   own      the task is its own step (task:<id>): "Remove from focus" takes that step out
 *   step     a broader step (feature, project, area) holds it: a note names the step, no button (removing the task
 *            alone is not possible, and adding it as its own step would only move it to the end of the list)
 *   dragged  something in focus waits on it, so it comes along: a note, no button
 *   outside  outside every step: "Add to focus" adds it as its own step, last in the list
 * @returns {{ kind: string, index?: number, title?: string, by?: string }}
 */
function focusCover(k) {
  const f = t.data?.focus;
  const order = f?.order ?? [];
  if (!order.length || !k) return { kind: 'none' };
  const own = order.indexOf(`task:${k.id}`);
  if (own >= 0) return { kind: 'own', index: own, title: f.stage?.[own]?.title ?? k.id };
  const pl = k.space;
  if (!pl || k.parked) return { kind: 'none' };
  if (pl.dragged_by) return { kind: 'dragged', index: pl.step, by: pl.dragged_by };
  if (pl.step != null) return { kind: 'step', index: pl.step, title: f.stage?.[pl.step]?.title ?? '' };
  if (pl.outside && !pl.paused) return { kind: 'outside' };
  return { kind: 'none' };
}

/** The outside-focus reason without its CLI hint: on the board the "Add to focus" button stands beside it instead. */
const boardReason = (text) => String(text ?? '').replace(/;\s*ravenseat focus\)$/, ')');

/** Opens the preview of one focus change (plan.js), and saves on confirm. */
function changeFocus(change) {
  window.QueuePlan.changeFocus(planContext(), change);
}

/**
 * QA-1b: "Add to focus at …": the Focus picker with these task steps already chosen, so only the position (First,
 * After a step, Last) is picked; then the same preview as changeFocus.
 */
function pickFocus(steps) {
  window.QueuePlan.pickFocus(planContext(), steps);
}

/**
 * The "Add to focus" / "Remove from focus" button, or the note on what covers the task, for the detail panel. A task
 * outside the focus gets two buttons: the one-click add (last) and "Add to focus at …" (QA-1b), so the return value
 * is an element or an array of them.
 */
function focusActions(k) {
  const c = focusCover(k);
  if (c.kind === 'outside')
    return [
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Add to focus',
        title: 'Adds this task as its own step, last in the focus. You see what changes before it is saved.',
        onclick: () => changeFocus({ action: 'add', steps: [`task:${k.id}`] }),
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Add to focus at …',
        title: 'Choose where the task goes: first, after a step you pick, or last. You see what changes before it is saved.',
        onclick: () => pickFocus([`task:${k.id}`]),
      }),
    ];
  if (c.kind === 'own')
    return el('button', {
      type: 'button',
      class: 'button button-outline',
      text: 'Remove from focus',
      title: `Takes step T${c.index + 1} (this task) out of the focus. You see what changes before it is saved.`,
      onclick: () => changeFocus({ action: 'remove', steps: [`task:${k.id}`] }),
    });
  if (c.kind === 'step')
    return el('p', {
      class: 'sp-meta focus-cover',
      text: `In focus through step T${c.index + 1}: ${c.title}. Change that step on the Focus tab.`,
    });
  if (c.kind === 'dragged')
    return el('p', {
      class: 'sp-meta focus-cover',
      text: `In focus because ${c.by} in step T${c.index + 1} waits on it.`,
    });
  return null;
}

/** The focus line at the top: the steps, the rest, ready in focus, dragged along, and the warning when the focus has nothing ready. */
const focusLine = $('focusLine');
/**
 * The end of the focus on the Focus tab (lib/logic/focus.js focusStatus: finished, halted): FINISHED when every stage is
 * done or the period is over, QUEUE PAUSED when the queue then waits for the owner (the owner question focus-done-<n>).
 */
function focusEndBadges(f) {
  if (!f?.finished && !f?.halted && !f?.expired) return [];
  const since = f.finished_at ? ` since ${String(f.finished_at).slice(0, 16).replace('T', ' ')} UTC` : '';
  return [
    el('span', {
      class: 'badge focus-finished',
      text: 'finished',
      title: `The focus has ended${since}.`,
    }),
    f.halted
      ? el('span', {
          class: 'badge old focus-halted',
          text: 'queue paused',
          title:
            'Nothing starts until you choose: set a new focus, or continue the regular queue (Decisions, or the buttons under "What happens now").',
        })
      : null,
  ].filter(Boolean);
}
function drawFocusTab(f) {
  const tab = $('show-plan');
  // The bold-width label (tabLabel in core.js), so choosing Focus does not move the tabs after it.
  tab.replaceChildren(tabLabel('Focus'), ...focusEndBadges(f));
}

/**
 * The button for one "What happens now" action (B18; the actions come from the server, queueBoard.focusNow):
 *   decide     opens that card in Decisions (QA, an owner question, a proposal),
 *   resolve    answers the "focus ended" owner question with that choice (the same body as Decisions sends),
 *   focus-tab  opens the Focus tab (left out on the Focus tab itself, where it would do nothing),
 *   batch-pack opens the board's "Pack into track" dialog for those cards.
 */
function focusNowButton(a) {
  if (a.type === 'focus-tab' && t.view === 'plan') return null;
  const run = {
    decide: () => openDecisions(a.key),
    'focus-tab': () => {
      setView('plan');
      draw();
    },
    'batch-pack': () => openBulk('batch-pack', a.ids ?? []),
    resolve: async () => {
      try {
        const answer = await writeWithGuard('/api/action', { type: 'resolve', sp: a.sp, choice: a.choice });
        if (answer) messageWithInfo(`${a.sp}: ${a.label}`, answer);
      } catch (e) {
        message(`${a.sp}: ${e.message}`, true);
      }
      await update(true);
    },
  }[a.type];
  if (!run) return null;
  return el('button', { type: 'button', class: 'button button-outline button-small', text: a.label, onclick: run });
}

/**
 * "What happens now" (B18): the server's one plain text (queueBoard.focusNow) with the buttons that settle the state,
 * and a copyable CLI chip (B31) only where the board has no action. The same line stands on the Focus tab and, when the
 * focus line warns, in the red band on the other tabs (instead of the old CLI advice). `status`: the band's line is a
 * live status, as the warning row was.
 */
function focusNowLine({ status = false } = {}) {
  const n = t.data?.focusNow;
  if (!n?.text) return null;
  const buttons = (n.actions ?? []).map(focusNowButton).filter(Boolean);
  const chip = n.cli ? cliChip(n.cli) : null;
  return el(
    'div',
    { class: `focus-now focus-now-${n.state}`, 'data-state': n.state },
    el(
      'p',
      { class: 'focus-now-text', role: status ? 'status' : null },
      el('span', { class: 'focus-now-label', text: 'What happens now: ' }),
      n.text,
    ),
    buttons.length || chip
      ? el('div', { class: 'focus-now-actions', role: 'group', 'aria-label': 'What happens now' }, buttons, chip)
      : null,
  );
}

/**
 * "How focus works" (B18), the same collapsible box as "How it works" in Checks (B11, the checks-how classes): a heading
 * with a real button (aria-expanded, aria-controls) that opens and closes a region named by it. Open until the owner
 * closes it; the choice is remembered per browser through `store` (FOCUS_HOW_KEY), never a setting. The four steps say
 * what the code does with this focus's own values (queueBoard.focusNow `how`: rest wait or fill, dependencies dragged
 * along or not, pause and ask or continue when done).
 */
const FOCUS_HOW_KEY = 'queue-board-focus-how';
let focusHowOpen = store.getItem(FOCUS_HOW_KEY) !== 'closed';
const focusStroke = (d) => [['path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]];
Object.assign(ICONS, {
  'focus-step-pick': focusStroke('M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zM12 8a4 4 0 1 1 0 8a4 4 0 0 1 0-8z'),
  'focus-step-order': focusStroke('M5 6h3M5 12h3M5 18h3M11 6h8M11 12h8M11 18h8'),
  'focus-step-rest': focusStroke('M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zM12 7v5l3 2'),
  'focus-step-done': focusStroke('M5 12l4 4 10-10'),
  'focus-chevron': focusStroke('M6 9l6 6 6-6'),
});
function focusHowBox() {
  const how = t.data?.focusNow?.how ?? { rest: 'wait', drag_with: true, continues: false };
  const steps = [
    [
      'focus-step-pick',
      'Pick what comes first',
      'Drag areas, projects or features into In focus, in the order you want, and press Save focus.',
    ],
    [
      'focus-step-order',
      'Step 1 before step 2',
      'Everything ready in step 1 starts before anything in step 2, whatever its score. ' +
        (how.drag_with
          ? 'Work outside the steps that they wait on comes along into the step.'
          : 'Work outside the steps that they wait on does not come along, so a step can get stuck.'),
    ],
    how.rest === 'fill'
      ? [
          'focus-step-rest',
          'The rest fills free slots',
          'Tasks outside the steps start only when the focus has nothing ready.',
        ]
      : [
          'focus-step-rest',
          'The rest waits',
          'Tasks outside the steps do not start while the focus applies, so free slots can stay empty.',
        ],
    how.continues
      ? [
          'focus-step-done',
          'Then the regular queue',
          'A done step leaves the focus by itself. When every step is done, the queue goes on with the rest by priority.',
        ]
      : [
          'focus-step-done',
          'Then the queue asks you',
          'A done step leaves the focus by itself. When every step is done, the queue pauses and asks you in Decisions: ' +
            'set a new focus or continue the regular queue.',
        ],
  ];
  const toggle = el(
    'button',
    {
      type: 'button',
      id: 'focus-how-toggle',
      class: 'checks-how-toggle',
      'aria-expanded': String(focusHowOpen),
      'aria-controls': 'focus-how-body',
    },
    el('span', { text: 'How focus works' }),
    icon('focus-chevron'),
  );
  const body = el(
    'div',
    { id: 'focus-how-body', class: 'checks-how-body', role: 'region', 'aria-labelledby': 'focus-how-toggle' },
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
          el('p', { class: 'checks-how-step-text', text }),
        ),
      ),
    ),
  );
  body.hidden = !focusHowOpen;
  const box = el(
    'section',
    { class: `checks-how focus-how${focusHowOpen ? '' : ' is-closed'}` },
    el('h3', { class: 'checks-how-title' }, toggle),
    body,
  );
  toggle.addEventListener('click', () => {
    focusHowOpen = !focusHowOpen;
    store.setItem(FOCUS_HOW_KEY, focusHowOpen ? 'open' : 'closed');
    toggle.setAttribute('aria-expanded', String(focusHowOpen));
    body.hidden = !focusHowOpen;
    box.classList.toggle('is-closed', !focusHowOpen);
  });
  return box;
}

// ---- The focus line on one row (QA-1d, Q11) ----
// The line used to wrap: with about 20 long-named steps it filled the screen and pushed the board down. Now it is
// always one row: each step is cut with an ellipsis (the full name in its tooltip), the steps that do not fit go into
// a "+N more" button that opens every step in a popover, and "Edit focus" stays at the right end. What fits is
// measured after each draw and when the line changes size (ResizeObserver, or the window's resize event where there
// is none), and decided by the pure rule QueueA11y.focusFit (a11y.js), which the tests run without a layout engine.

/** Is the "+N more" popover open? Kept across redraws, so a poll does not close it under the owner. */
let focusMoreOpen = false;

/** The counts after the steps (rest, ready in focus, dragged along, the period, end badges). Drawn in the row and again
 *  in the popover, so nothing is lost when the row is narrow. */
function focusCounts(f) {
  return [
    el('span', {
      text: f.rest === 'fill' ? 'rest fills free slots' : 'rest waits',
      title:
        f.rest === 'fill'
          ? 'Tasks outside the steps start only when the focus has nothing ready.'
          : 'Tasks outside the steps do not start until the focus changes (slots may stay empty).',
    }),
    f.active
      ? el('span', {
          text: `${f.readyOnes} ready in focus`,
          title: 'Pending tasks in the steps that can start now (no blockers).',
        })
      : null,
    f.active && f.dragged_with
      ? el('span', {
          text: `${f.dragged_with} dragged along`,
          title:
            'Tasks outside the steps that something in focus waits on. They get the focus task\'s step.',
        })
      : null,
    f.to
      ? el('span', {
          text: `until ${String(f.to).slice(0, 10)}`,
          title: 'The focus period applies up to and including this day.',
        })
      : null,
    f.expired ? el('span', { class: 'badge old', text: 'expired' }) : null,
    ...(f.finished || f.halted ? focusEndBadges({ ...f, expired: false }) : []),
    f.continue_when_empty && (f.finished || f.expired)
      ? el('span', {
          text: f.continue_when_empty.on ? 'continues the regular queue' : 'waits for you',
          title: `Continue when empty: ${f.continue_when_empty.on ? 'on' : 'off'} (${f.continue_when_empty.from}).`,
        })
      : null,
    f.not_started ? el('span', { class: 'badge', text: 'not started' }) : null,
  ].filter(Boolean);
}

/** The tooltip of one step: number, Now or Next, the full title, the type and the counts. */
const focusStepTitle = (f, x, i) =>
  `Step ${i + 1} (${i < f.now_count ? 'Now' : 'Next'}): ${x.title}, ${x.type}. ` +
  `${x.waiting} waiting, ${x.readyOnes} ready, ${duration(x.min_left)} left.`;

/**
 * Hides the steps that do not fit and sets "+N more". Every step is shown once to measure it (one forced layout per
 * call, about 20 small elements), then QueueA11y.focusFit decides; the first (current) step always stays.
 */
function fitFocusLine() {
  const list = focusLine.querySelector('.focus-step-list');
  const more = list?.querySelector('.focus-more-button');
  if (!list || !more) return;
  const items = [...list.querySelectorAll('.focus-item')];
  // Measure at the natural widths: every step shown, none shrunk (is-measuring turns the first step's shrink off).
  list.classList.add('is-measuring');
  for (const item of items) item.hidden = false;
  more.hidden = false;
  more.textContent = `+${items.length} more`;
  const widths = items.map((item) => item.offsetWidth);
  const moreWidth = more.offsetWidth;
  const style = window.getComputedStyle?.(list);
  const gap = parseFloat(style?.columnGap ?? '') || 0;
  const n = window.QueueA11y.focusFit({ widths, available: list.clientWidth, more: moreWidth, gap });
  list.classList.remove('is-measuring');
  items.forEach((item, i) => (item.hidden = i >= n));
  const rest = items.length - n;
  more.hidden = rest <= 0;
  more.textContent = `+${rest} more`;
  more.setAttribute('aria-label', `${rest} more focus steps: show all ${items.length}`);
  if (rest <= 0) closeFocusMore(false);
}

const focusMoreParts = () => ({
  pop: document.getElementById('focus-more'),
  button: focusLine.querySelector('.focus-more-button'),
});
function openFocusMore() {
  const { pop, button } = focusMoreParts();
  if (!pop || !button) return;
  focusMoreOpen = true;
  pop.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  pop.querySelector('.focus-more-row')?.focus();
}
function closeFocusMore(focusBack) {
  const { pop, button } = focusMoreParts();
  const wasOpen = focusMoreOpen;
  focusMoreOpen = false;
  if (pop) pop.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
  if (wasOpen && focusBack) button?.focus();
}

/** The popover with every step in order (number, name, Now, the counts per step) and the line's counts under them. */
function focusMorePopover(f) {
  const rows = (f.stage ?? []).map((x, i) =>
    el(
      'li',
      {
        class: `focus-more-row${i < f.now_count ? ' now' : ''}`,
        tabindex: '-1',
        'data-focus': `focus-row:${i}`,
        title: focusStepTitle(f, x, i),
      },
      el('span', { class: 'focus-more-num', text: `${i + 1}` }),
      el(
        'span',
        { class: 'focus-more-text' },
        el('span', { class: 'focus-more-name', text: x.label ?? x.title }),
        el('span', {
          class: 'focus-more-meta',
          text:
            `${i < f.now_count ? 'Now' : 'Next'} · ${x.waiting} waiting · ${x.readyOnes} ready · ` +
            `${duration(x.min_left)} left`,
        }),
      ),
    ),
  );
  const pop = el(
    'div',
    { id: 'focus-more', class: 'focus-more', role: 'group', 'aria-label': 'All focus steps' },
    el('ol', { class: 'focus-more-list' }, rows),
    el('p', { class: 'focus-more-counts' }, focusCounts(f)),
  );
  pop.hidden = !focusMoreOpen;
  return pop;
}

// The keyboard in the popover: arrow keys, Home and End move between the steps, Esc closes it with focus back on
// "+N more". Delegated on the line, which stays while its content is redrawn. stopPropagation keeps the board's own Esc
// (closing the panel, clearing the selection) from running too.
focusLine.addEventListener('keydown', (e) => {
  const pop = document.getElementById('focus-more');
  if (!pop || pop.hidden || !pop.contains(e.target)) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFocusMore(true);
    return;
  }
  const rows = [...pop.querySelectorAll('.focus-more-row')];
  const i = rows.indexOf(document.activeElement);
  const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 }[e.key];
  if (j === undefined) return;
  e.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
});
// A click outside closes the popover (composedPath: the path when the click happened, also after a redraw).
document.addEventListener('click', (e) => {
  if (!focusMoreOpen) return;
  const { pop, button } = focusMoreParts();
  const path = e.composedPath();
  if (!path.includes(pop) && !path.includes(button)) closeFocusMore(false);
});
// Focus leaving the popover (Tab past the last step) closes it, unless it goes to "+N more" (which toggles it).
focusLine.addEventListener('focusout', (e) => {
  const { pop, button } = focusMoreParts();
  if (!focusMoreOpen || !pop?.contains(e.target)) return;
  const to = e.relatedTarget;
  if (to && (pop.contains(to) || to === button)) return;
  if (to) closeFocusMore(false);
});
// Refit when the line changes width (the window, the panel beside the board, a zoom).
if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitFocusLine()).observe(focusLine);
else window.addEventListener('resize', () => fitFocusLine());

function drawFocusLine() {
  // Before the first state the line stays in the layout, empty, with its one-row height (B27): hiding it and showing
  // it when the data arrived pushed the board 45 px down after the first paint.
  focusLine.hidden = false;
  if (!t.data) {
    focusLine.replaceChildren();
    return;
  }
  const f = t.data.focus;
  drawFocusTab(f);
  // Where the focus was in the line, so a redraw (every poll) puts it back on the same control.
  const had = focusLine.contains(document.activeElement) ? document.activeElement.dataset?.focus : null;
  // "Set focus" / "Edit focus" opens the Focus tab, so on the Focus tab itself (where the focus is edited) it is
  // hidden (B17): there it only switched to the tab already open. It is last in the row and never shrinks (QA-1d).
  const toPlan = (text, title) => {
    if (t.view === 'plan') return null;
    return el('button', {
      type: 'button',
      class: 'button button-outline button-small focus-edit',
      'data-focus': 'focus-edit',
      text,
      title: title,
      onclick: () => {
        setView('plan');
        draw();
      },
    });
  };
  const draft = window.QueuePlan?.hasDraft()
    ? el('span', {
        class: 'badge old focus-draft',
        text: 'unsaved draft',
        title:
          'The focus view has changes that are not saved. Open Focus and press "Save focus" or "Discard".',
      })
    : null;
  if (!f) {
    closeFocusMore(false);
    focusLine.className = 'focusLine';
    const none = 'No focus: the queue starts the most valuable work per minute first.';
    focusLine.replaceChildren(
      el(
        'div',
        { class: 'focus-row' },
        el('span', { class: 'stripe-name', text: 'Focus' }),
        el('span', {
          class: 'focus-text',
          text: none,
          title:
            `${none} With a focus you decide the order: "Auth first, then Payments" makes everything in Auth start ` +
            'before anything in Payments, regardless of score.',
        }),
        draft,
        toPlan('Set focus', 'Open Focus and drag areas or projects into In focus.'),
      ),
    );
    return;
  }
  // The warning (B18): on the other tabs the red band shows "What happens now" with the buttons that settle it, never
  // the CLI advice in focusStatus's notice (only without focusNow, from an older server, the notice text stands). On
  // the Focus tab the same line stands in the view itself, so the band does not repeat it there.
  const onPlan = t.view === 'plan';
  const notice = onPlan ? null : (f.notice ?? null);
  const warning = notice
    ? (focusNowLine({ status: true }) ?? el('p', { class: 'focus-warning', role: 'status', text: notice }))
    : null;
  focusLine.className = `focusLine${notice ? ' notice' : ''}`;
  // One item per step: the arrow before it (not before the first) and the step, so hiding an item hides both.
  // The short name as the cards write it (B17): a project by its id, a feature as "pid › name"; the title in the tooltip.
  const items = (f.stage ?? []).map((x, i) =>
    el(
      'span',
      { class: 'focus-item' },
      i ? el('span', { class: 'focus-arrow', 'aria-hidden': 'true', text: '→' }) : null,
      el('span', {
        class: `focus-step${i < f.now_count ? ' now' : ''}`,
        text: `${i + 1} ${x.label ?? x.title}`,
        title: focusStepTitle(f, x, i),
      }),
    ),
  );
  const more = el('button', {
    type: 'button',
    class: 'button button-outline button-small focus-more-button',
    'data-focus': 'focus-more',
    'aria-expanded': String(focusMoreOpen),
    'aria-controls': 'focus-more',
    text: '+0 more',
    title: 'Show every focus step, with what waits, what is ready and the time left in each',
    onclick: () => (focusMoreOpen ? closeFocusMore(true) : openFocusMore()),
  });
  more.hidden = true;
  const name = f.name ? `Focus "${f.name}"` : 'Focus';
  // The DOM's replaceChildren turns null into the text "null", so the warning row is included only when it exists.
  focusLine.replaceChildren(
    ...[
      el(
        'div',
        { class: 'focus-row' },
        el('span', { class: 'stripe-name focus-name', text: name, title: name }),
        el('span', { class: 'focus-step-list' }, items, more),
        el('span', { class: 'focus-tall' }, focusCounts(f)),
        draft,
        toPlan(
          'Edit focus',
          'Open Focus: drag areas and projects between In focus, Not in focus and On pause.',
        ),
      ),
      focusMorePopover(f),
      warning,
    ].filter(Boolean),
  );
  fitFocusLine();
  if (had) focusLine.querySelector(`[data-focus="${CSS.escape(had)}"]`)?.focus();
}

// Grouping in Flat and Project lanes. Closed groups are remembered in the browser.
const GROUPINGS = {
  none: 'No grouping',
  area: 'Area → project',
  feature: 'Project → feature',
  stage: 'Focus step',
};
const savedGrouping = store.getItem('queue-board-grouping');
t.grouping = Object.hasOwn(GROUPINGS, savedGrouping ?? '') ? savedGrouping : 'none';
t.closedGroups = new Set(readList('queue-board-closed-groups'));

/** A list of short texts from localStorage (empty on error). */
function readList(key) {
  try {
    const x = JSON.parse(store.getItem(key) ?? '[]');
    return Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.length <= 200) : [];
  } catch {
    return [];
  }
}
function saveLocally(key, val) {
  try {
    store.setItem(key, JSON.stringify(val));
  } catch {
    /* private mode or full storage: applies only to this session */
  }
}

/** The group a card belongs to in the selected grouping: { key, title, orderState }. */
function groupFor(k, g) {
  const projects = t.data.projects ?? [];
  const pIndex = Math.max(
    0,
    projects.findIndex((p) => p.pid === k.project),
  );
  if (g === 'area') {
    const areas = t.data.areas ?? [];
    const oi = areas.findIndex((o) => o.oid === k.area);
    const o = areas[oi];
    const name = o?.title ?? (k.area === 'without-area' ? 'No area' : k.area);
    return {
      key: `o:${k.area}/${k.project}`,
      title: `${name} › ${k.project}`,
      orderState: [oi < 0 ? 9999 : oi, pIndex, ''],
    };
  }
  if (g === 'feature')
    return {
      key: `f:${k.project}/${k.feature ?? ''}`,
      title: `${k.project} › ${k.feature ?? '(no feature)'}`,
      orderState: [pIndex, k.feature ? 0 : 1, k.feature ?? ''],
    };
  // Focus step: the steps in order, then dragged along into the step, outside focus, and on hold last.
  const pl = k.space;
  const f = t.data.focus;
  if (!pl) return { key: 't:other', title: 'Not in the queue', orderState: [9998, 0, ''] };
  if (k.parked) return { key: 't:wait', title: 'On hold', orderState: [9997, 0, ''] };
  if (!f?.active) return { key: 't:none', title: 'No focus', orderState: [0, 0, ''] };
  if (pl.step == null)
    return { key: 't:outside', title: 'Outside focus', orderState: [9990, 0, ''] };
  return {
    key: `t:${pl.step}`,
    title: `T${pl.step + 1} ${f.stage?.[pl.step]?.title ?? ''}`,
    orderState: [pl.step, 0, ''],
  };
}
const compareOrder = (a, b) =>
  a.orderState[0] - b.orderState[0] ||
  a.orderState[1] - b.orderState[1] ||
  a.orderState[2].localeCompare(b.orderState[2], 'en');

/** Like list(), but grouped by the selected grouping (every group can be closed and selected together). */
function groupedList(summary, col, section) {
  const g = t.grouping;
  // Focus step exists only for cards in the queue (in In progress, Review and Built everything would end up in "Not in the queue").
  if (
    g === 'none' ||
    (t.view === 'lanes' && g === 'area') ||
    (g === 'stage' && !MARKABLE_COLUMNS.has(col)) ||
    !summary.length
  )
    return list(summary, col, section);
  const groups = new Map();
  for (const k of summary) {
    const x = groupFor(k, g);
    if (!groups.has(x.key)) groups.set(x.key, { ...x, summary: [] });
    groups.get(x.key).summary.push(k);
  }
  return el(
    'div',
    { class: 'groups' },
    [...groups.values()].sort(compareOrder).map((gr) => {
      const saved = `${section ?? col}|${gr.key}`;
      // The ids, the counter and the box follow the search and the selection (searchBound at the bottom).
      let ids = [];
      const d = el('details', { class: 'group', open: !t.closedGroups.has(saved) });
      d.addEventListener('toggle', () => {
        if (d.open) t.closedGroups.delete(saved);
        else t.closedGroups.add(saved);
        saveLocally('queue-board-closed-groups', [...t.closedGroups].slice(-300));
        rovingSetup(); // the cards in a closed group cannot be the tab stop
      });
      const sum = el('summary', { class: 'group-header' });
      const box = MARKABLE_COLUMNS.has(col)
        ? el('input', {
            type: 'checkbox',
            class: 'mark-group-box',
            'aria-label': `Select the whole group ${gr.title}`,
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => markMany(ids, e.target.checked),
          })
        : null;
      const counter = el('span', { class: 'counter' });
      sum.append(
        ...[box, el('span', { class: 'group-name', text: gr.title }), counter].filter(Boolean),
      );
      d.append(sum, list(gr.summary, col, section));
      searchBound(gr.summary, (match) => {
        ids = match.map((k) => k.id);
        d.hidden = !match.length;
        sum.title = `${gr.title}: ${ids.length} cards. Click to close or open.`;
        counter.textContent = `${ids.length} · ${duration(match.reduce((s2, k) => s2 + (Number(k.estimate) || 0), 0))}`;
        if (box) {
          box.checked = ids.length > 0 && ids.every((id) => t.marked.has(id));
          box.title = `Select all ${ids.length} cards in the group for the selection menu (bulk actions)`;
        }
      });
      return d;
    }),
  );
}

const groupingOption = $('grouping');
groupingOption.replaceChildren(
  ...Object.entries(GROUPINGS).map(([val, text]) =>
    el('option', { value: val, text, selected: val === t.grouping }),
  ),
);
groupingOption.addEventListener('change', () => {
  t.grouping = groupingOption.value;
  store.setItem('queue-board-grouping', t.grouping);
  draw();
});

// Quick filters (built in) and saved filters (your own, in the browser's localStorage), both in the Filter menu.
const VIEWS_STORAGE = 'queue-board-views';
const LAST_VISIT = 'queue-board-last-visit';
t.lastVisit = Date.parse(store.getItem(LAST_VISIT) ?? '') || null;
const rememberVisit = () => {
  try {
    store.setItem(LAST_VISIT, new Date().toISOString());
  } catch {
    /* no storage */
  }
};
window.addEventListener('pagehide', rememberVisit);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) rememberVisit();
});

/**
 * The quick filters: the built-in views, shown under "Quick filters" in the Filter menu (QA-1d), which cannot be
 * deleted. `special` is a filter on the cards in queue, proposed and the batch queue. `explain` is the short line shown
 * under the name in the menu (B28, UX review M3: not only in a tooltip); `title` is the longer tooltip. "Waiting on me"
 * is gone from here: it opened Decisions, which the "Waiting on you" button at the top already does, and a quick
 * filter only filters (X3).
 */
const BUILT_IN = [
  {
    name: 'Focus now',
    special: 'focus1',
    explain: 'The first focus step, ready ones first.',
    title: 'Only tasks in the first focus step, ready ones first.',
  },
  {
    name: 'Ready in focus',
    special: 'readyFocus',
    explain: 'Ready tasks in any focus step.',
    title: 'Ready tasks in the focus steps, including those dragged along.',
  },
  {
    name: 'Outside focus, ready',
    special: 'outsideReady',
    explain: 'Only the focus holds them back.',
    title: 'Tasks stopped only by the focus: they can start if you give them a step.',
  },
  {
    name: 'On hold',
    special: 'onWait',
    explain: 'Tasks put on hold. They do not start.',
    title: 'Tasks that are put on hold.',
  },
  {
    name: 'Sort',
    special: 'sort',
    explain: 'No project, or the project is uncertain.',
    title:
      'Tasks without a project, with an uncertain proposal, or where the project conflicts with the files and the plan they come from.',
  },
  {
    name: 'New since last visit',
    special: 'newEntry',
    explain: 'Added since your last visit here.',
    title: 'Tasks added after the previous time the board was open in this browser.',
  },
];
const SPECIAL = {
  focus1: (k) => k.space?.step === 0,
  readyFocus: (k) => k.ready && k.space?.step != null,
  outsideReady: (k) =>
    !!k.space?.outside && !k.parked && k.blockers.every((h) => h === k.space.reason),
  onWait: (k) => !!k.parked,
  sort: (k) => (t.data?.inbox?.sort ?? []).some((r) => r.id === k.id),
  newEntry: (k) => !!t.lastVisit && !!k.added_at && Date.parse(k.added_at) > t.lastVisit,
};
t.special = null;
t.viewName = null;

function ownViews() {
  try {
    const x = JSON.parse(store.getItem(VIEWS_STORAGE) ?? '[]');
    return Array.isArray(x)
      ? x.filter((v) => v && typeof v.name === 'string' && v.name.length <= 60).slice(0, 30)
      : [];
  } catch {
    return [];
  }
}

/**
 * Applies a quick filter (built in) or a saved filter (your own) from the Filter menu (QA-1d, Q10: they lived in a
 * "Selection" menu of their own, a word that also meant the ticked cards). The menu closes with focus back on the
 * Filter button, whose label then names what is in use.
 */
function useView(v) {
  closeFilter(true);
  t.special = v.special && SPECIAL[v.special] ? v.special : null;
  t.viewName = v.name;
  // Your own saved filters include search, filter, grouping and view; the quick filters reset search and filter.
  t.filter.search = typeof v.search === 'string' ? v.search.slice(0, 100) : '';
  $('search').value = t.filter.search;
  for (const [n, set] of Object.entries(t.filter.selected)) {
    set.clear();
    for (const x of v.filter?.[n] ?? []) if (typeof x === 'string') set.add(x);
  }
  saveFilter();
  if (v.grouping && Object.hasOwn(GROUPINGS, v.grouping)) {
    t.grouping = v.grouping;
    groupingOption.value = v.grouping;
    store.setItem('queue-board-grouping', v.grouping);
  }
  const show = VIEWS.includes(v.view) ? v.view : null;
  if (show && ['flat', 'lanes', 'graph'].includes(show)) setView(show);
  else if (!['flat', 'lanes', 'graph'].includes(t.view)) setView('flat');
  drawFilter();
  draw();
}

/** Is the "Save current as…" name field open in the Filter menu? Closed again each time the menu opens. */
let saveAsOpen = false;

/**
 * Saves the search, filter, grouping and view under `name` in this browser, under the same storage key as before
 * (VIEWS_STORAGE), so filters saved from the old Selection menu keep working.
 */
function saveView(name) {
  const n = name.trim().slice(0, 60);
  if (!n) return message('Write a name for the saved filter.', true);
  if (BUILT_IN.some((v) => v.name === n))
    return message(`"${n}" is a quick filter. Choose another name.`, true);
  const fresh = {
    name: n,
    view: t.view,
    search: t.filter.search,
    filter: Object.fromEntries(Object.entries(t.filter.selected).map(([k, set]) => [k, [...set]])),
    grouping: t.grouping,
    special: t.special,
  };
  const list = ownViews().filter((v) => v.name !== n);
  saveLocally(VIEWS_STORAGE, [...list, fresh].slice(-30));
  t.viewName = n;
  saveAsOpen = false;
  message(`Filter "${n}" is saved in this browser.`);
  drawFilter();
  filterMenu.querySelector('[data-focus="save-as"]')?.focus();
}

/** Deletes one saved filter from this browser (the queue does not change). */
function deleteView(v) {
  saveLocally(
    VIEWS_STORAGE,
    ownViews().filter((x) => x.name !== v.name),
  );
  if (t.viewName === v.name) t.viewName = null;
  drawFilter();
  filterMenu.querySelector('[data-focus="save-as"]')?.focus();
}

/**
 * "Show all" at the top of the Filter menu (and the empty state's and chain line's Show all): removes the quick or
 * saved filter, the checked filters and the search, so every card shows again. Focus goes to the Filter button, the
 * control that changed.
 */
function showAll() {
  closeFilter(false);
  t.special = null;
  t.viewName = null;
  for (const set of Object.values(t.filter.selected)) set.clear();
  saveFilter();
  t.filter.search = '';
  $('search').value = '';
  drawFilter();
  draw();
  filterButton.focus();
}

/**
 * The Quick filters and Saved sections at the top of the Filter menu (drawFilterMenu in board/menus.js puts them
 * before the filter sections). A row is the B23 menu style: the name, and under it a short explanation in muted text
 * that is the row's description (aria-describedby), so the name stays the row's accessible name. Each control has a
 * data-focus key, so a redraw of the open menu keeps the focus where it was.
 */
function presetSections() {
  const ownOnes = ownViews();
  const row = (v, own, i) => {
    const explainId = `view-explain-${own ? 'own' : 'built'}-${i}`;
    const explain = own ? 'Your search, filter, grouping and view.' : v.explain;
    return el(
      'li',
      { class: 'filter-row view-row' },
      el(
        'button',
        {
          type: 'button',
          class: 'view-option',
          'data-focus': `view:${own ? 'own' : 'built'}:${i}`,
          'aria-label': v.name,
          'aria-describedby': explainId,
          title: v.title ?? 'Your saved filter: search, filter, grouping and view.',
          'aria-current': t.viewName === v.name ? 'true' : null,
          onclick: () => useView(v),
        },
        el('span', { class: 'view-name', text: v.name }),
        el('span', { class: 'view-explain', id: explainId, text: explain }),
      ),
      own
        ? el('button', {
            type: 'button',
            class: 'pause-button',
            'data-focus': `delete:${i}`,
            text: 'Delete',
            title: `Delete the saved filter "${v.name}" from this browser. The queue does not change.`,
            onclick: () => deleteView(v),
          })
        : null,
    );
  };
  // "Save current as…" first opens a name field (Enter saves, Esc closes the field and not the menu).
  const save = saveAsOpen
    ? el(
        'div',
        { class: 'filter-footer view-save' },
        el('input', {
          id: 'view-name',
          type: 'text',
          maxlength: 60,
          'data-focus': 'view-name',
          placeholder: 'Name of the saved filter',
          'aria-label': 'Name of the saved filter',
          onkeydown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveView(e.target.value);
            }
          },
        }),
        el('button', {
          type: 'button',
          class: 'button button-outline button-small',
          'data-focus': 'save',
          text: 'Save',
          title:
            'Saves the search, the filter, the grouping and the view you see now under the name, in this browser. The queue does not change.',
          onclick: () => saveView(filterMenu.querySelector('#view-name')?.value ?? ''),
        }),
      )
    : el(
        'div',
        { class: 'filter-footer view-save' },
        el('button', {
          type: 'button',
          class: 'link-button',
          'data-focus': 'save-as',
          text: 'Save current as…',
          title: 'Save the search, the filter, the grouping and the view you see now under a name, in this browser.',
          onclick: () => {
            saveAsOpen = true;
            drawFilterMenu();
            filterMenu.querySelector('#view-name')?.focus();
          },
        }),
      );
  return [
    el(
      'section',
      { class: 'filter-section', 'aria-labelledby': 'filter-quick' },
      el('div', { class: 'filter-section-header' }, el('h3', { id: 'filter-quick', text: 'Quick filters' })),
      el(
        'ul',
        { class: 'filter-list' },
        BUILT_IN.map((v, i) => row(v, false, i)),
      ),
    ),
    el(
      'section',
      { class: 'filter-section', 'aria-labelledby': 'filter-saved' },
      el('div', { class: 'filter-section-header' }, el('h3', { id: 'filter-saved', text: 'Saved' })),
      ownOnes.length
        ? el(
            'ul',
            { class: 'filter-list' },
            ownOnes.map((v, i) => row(v, true, i)),
          )
        : el('p', { class: 'empty', text: 'No saved filters yet.' }),
      save,
    ),
  ];
}
