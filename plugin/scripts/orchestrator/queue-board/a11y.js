// =============================================================
// a11y.js: shared accessibility logic for queueBoard.
//
// The file is both a CommonJS module (vitest, lib/__tests__/queueBoardA11y.test.ts) and a browser script
// (queue-board.mjs serves it as /a11y.js, and it sets window.QueueA11y), so the board uses exactly the code the tests
// check. The pure parts (no DOM) are tested; the DOM helpers below are thin wrappers around them.
//
//   - Focus trap: one shared feature for all the dialogs (the side panel, the guard dialog, the bulk actions and the
//     plan dialog), instead of three copies. `nextInTrap` is the rule, `trapKey` applies it on a Tab press.
//   - Inert: the rest of the page (the top, the board, the strips) is made inert while the side panel is open as a
//     modal sheet (below 1200 px; from 1200 px it floats over or sits beside the board and nothing is inert,
//     board/panel.js).
//   - Toast queue: one stack for the message and "Undo", so they never sit on top of each other.
//   - Contrast: the WCAG 2 ratio between two colors (K1 is computed from the palette in the test).
//   - Tabs: which tab the arrow keys go to.
//   - Legend: the classes K, D, D+ and U, and the WIP text in In progress.
//   - The key from a link pasted in after a server restart.
//   - Theme choice (System, Light, Dark).
//   - Empty state and stale data, and the stale and error states: the banner, its live announcement, plain error text.
//   - The focus line fit: how many focus steps fit on the one-row focus line beside "+N more" (focusFit, QA-1d).
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueA11y = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Focus trap ----

  /** The elements that can get focus with Tab inside a dialog. */
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  /**
   * Where focus goes when Tab is pressed in a dialog with `count` focusable elements, where the focused element has
   * index `i` (-1 = focus is outside the list, e.g. on the dialog itself). Tab wraps from last to first,
   * Shift+Tab from first to last. Returns -1 when there is nothing to focus.
   */
  function nextInTrap(count, i, backward) {
    if (!(count > 0)) return -1;
    if (backward) return i <= 0 ? count - 1 : Math.min(i, count) - 1;
    return i < 0 || i >= count - 1 ? 0 : i + 1;
  }

  /** The focusable elements in `box`, except those inside something hidden or inert. */
  function focusable(box) {
    return [...box.querySelectorAll(FOCUSABLE)].filter(
      (x) => !x.closest('[hidden]') && !x.closest('[inert]'),
    );
  }

  /**
   * Focus trap: called from the dialog's keydown. On Tab, focus stays in `box` (wraps at the ends). Returns true when
   * the key was handled. Each dialog handles Esc and other keys itself.
   */
  function trapKey(e, box) {
    if (e.key !== 'Tab' || !box) return false;
    const list = focusable(box);
    const j = nextInTrap(list.length, list.indexOf(document.activeElement), e.shiftKey);
    e.preventDefault();
    if (j >= 0) list[j].focus();
    return true;
  }

  /** Sets or removes `inert` on the elements (those that exist). Used while the side panel is open. */
  function setInert(elements, on) {
    for (const x of elements) {
      if (!x) continue;
      if (on) x.setAttribute('inert', '');
      else x.removeAttribute('inert');
    }
  }

  // ---- Toast queue ----

  /**
   * One stack for the messages at the bottom. The queue is a list of keys (e.g. 'message' and 'undo'),
   * oldest first. A key shown again moves to the bottom (newest), so the stack never holds the same one twice.
   * If the list grows longer than `max`, the oldest drop out, but never a key in `kept` (Undo must stay for 30 s).
   */
  function toastAdd(queue, key, { max = 3, kept = [] } = {}) {
    const fresh = [...queue.filter((x) => x !== key), key];
    while (fresh.length > max) {
      const i = fresh.findIndex((x) => x !== key && !kept.includes(x));
      if (i < 0) break;
      fresh.splice(i, 1);
    }
    return fresh;
  }
  function toastRemove(queue, key) {
    return queue.filter((x) => x !== key);
  }

  // ---- Contrast (WCAG 2) ----

  /** Relative luminance for a color in the form #rrggbb. */
  function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
    if (!m) return NaN;
    const channel = (i) => {
      const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  }

  /** The contrast ratio between two colors (1 to 21), rounded down to two decimals so 4.499 never becomes "4.5". */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) return NaN;
    const r = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    return Math.floor(r * 100) / 100;
  }

  // ---- Tabs (View) ----

  /**
   * The tab the arrow keys move focus to: left and right wrap around, Home and End go to the ends. Returns null for
   * other keys. Activation is manual (Enter or Space), because redrawing the board can take time.
   */
  function tabMeasure(count, i, keyPress) {
    if (!(count > 0)) return null;
    switch (keyPress) {
      case 'ArrowRight':
        return (i + 1) % count;
      case 'ArrowLeft':
        return (i - 1 + count) % count;
      case 'Home':
        return 0;
      case 'End':
        return count - 1;
      default:
        return null;
    }
  }

  // ---- Legend ----

  /** The risk classes, with short name and explanation (same split as the add-to-queue skill). */
  const CLASSES = [
    {
      class: 'K',
      name: 'ordinary code',
      explanation: 'Code in the application or the tools, and read-only database calls.',
    },
    {
      class: 'D',
      name: 'database',
      explanation: 'Database migrations and changes to database functions or access rules.',
    },
    {
      class: 'D+',
      name: 'database with new table or privacy',
      explanation:
        'New table, retention or anonymization, edge without login, or a change in a shared feature. ' +
        'At most a fixed number at once.',
    },
    { class: 'U', name: 'investigation', explanation: 'Investigation and proposals without code.' },
  ];

  /** Readable label for the class badge, e.g. "Risk class D+: database with new table or privacy". */
  function classLabel(cls) {
    const k = CLASSES.find((x) => x.class === cls);
    return k ? `Risk class ${k.class}: ${k.name}` : `Risk class ${cls}`;
  }

  /** The WIP chip in In progress as plain text: "Agents 3 of 4 · heavy 1 of 2 · 2 picked". */
  function wipText(w) {
    if (!w) return '';
    return (
      `Agents ${w.agents} of ${w.max} · heavy ${w.dPlus} of ${w.maxDPlus}` +
      (w.picked ? ` · ${w.picked} picked` : '')
    );
  }

  // ---- The key after a restart ----

  /**
   * The key from a link with the key (the board opens one itself; board.hideKey false prints it) (`…/#key=abc`), pasted into the banner. Reads only the #
   * part (or &key= in it). A bare key without a link is also accepted. Returns null when the text has no key.
   */
  function keyFromLink(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    const hash = s.includes('#') ? s.slice(s.indexOf('#')) : null;
    if (hash) {
      const m = /[#&]key=([A-Za-z0-9_-]+)/.exec(hash);
      return m ? m[1] : null;
    }
    return /^[A-Za-z0-9_-]{16,}$/.test(s) ? s : null;
  }

  // ---- Theme ----

  const THEME_OPTION = [
    { val: 'system', text: 'System' },
    { val: 'light', text: 'Light' },
    { val: 'dark', text: 'Dark' },
  ];
  /** The saved choice from localStorage: 'light', 'dark' or 'system' (no value or an unknown one). */
  function themeFromSaved(v) {
    return v === 'light' || v === 'dark' ? v : 'system';
  }
  /** The next option when the theme button at the top is pressed: System → Light → Dark → System. */
  function nextTheme(v) {
    const i = THEME_OPTION.findIndex((x) => x.val === themeFromSaved(v));
    return THEME_OPTION[(i + 1) % THEME_OPTION.length].val;
  }

  // ---- Empty state ----

  /**
   * Why a list is empty, and which action shows the cards again. One rule for all the empty states.
   *   text:        the base text for the list ("Nothing here.")
   *   searchHides: the list has cards, but the search hides all of them
   *   search:      the search text (empty string when search is off)
   *   filters:     number of options in the Filter menu
   *   selection:   the name of the quick filter or saved filter in use (Filter menu), or null. The key keeps its old
   *                name for the callers; on screen it is called a filter, since "selection" means ticked cards (QA-1d).
   * Answer: { text, action: 'search' | 'filter' | 'selection' | null, label }. Search comes before the filter, and the
   * filter before the quick or saved filter: one action at a time, and whatever hides the cards here is named first.
   */
  function emptyReason({ text, searchHides = false, search = '', filters = 0, selection = null }) {
    if (searchHides && search)
      return { text: `Nothing matches "${search}".`, action: 'search', label: 'Clear search' };
    if (filters > 0)
      return {
        text: `${text} The filter is on (${filters} selected).`,
        action: 'filter',
        label: 'Remove filter',
      };
    if (selection)
      return {
        text: `${text} Filter "${selection}" is in use.`,
        action: 'selection',
        label: 'Show all',
      };
    return { text, action: null, label: null };
  }

  /**
   * The chain line's text for cards in the chain that are not visible, one part per cause (UX review K2: the line said
   * "hidden by the filter" also when the cards were in a closed fold). `causes` is [{ cause, n, name?, key? }]:
   *   fold      n cards in the closed fold `name` (key = the fold's name on the board), action "fold:<key>" (Show)
   *   filter    the Filter menu hides them, action "filter" (Remove filter)
   *   search    the search hides them, action "search" (Clear search)
   *   selection outside the quick or saved filter `name` (the Filter menu), action "selection" (Show all)
   *   older     in Built but older than the 7 days shown, action "older" (Show more)
   *   elsewhere not shown in this view (no action)
   * Answer: [{ text, action, label, aria }] in the given order; a cause with n 0 is left out. `aria` names the action
   * on its own ("Show the Blocked group"), since a bare "Show" is ambiguous out of context.
   */
  function chainHidden(causes) {
    const out = [];
    for (const c of causes ?? []) {
      const n = Number(c?.n) || 0;
      if (n <= 0) continue;
      if (c.cause === 'fold')
        out.push({
          text: `${n} in the closed ${c.name} group`,
          action: `fold:${c.key}`,
          label: 'Show',
          aria: `Show the ${c.name} group`,
        });
      else if (c.cause === 'filter')
        out.push({ text: `${n} hidden by the filter`, action: 'filter', label: 'Remove filter', aria: null });
      else if (c.cause === 'search')
        out.push({ text: `${n} hidden by the search`, action: 'search', label: 'Clear search', aria: null });
      else if (c.cause === 'selection')
        out.push({
          text: `${n} outside the filter "${c.name}"`,
          action: 'selection',
          label: 'Show all',
          aria: null,
        });
      else if (c.cause === 'older')
        out.push({
          text: `${n} older than 7 days in Built`,
          action: 'older',
          label: 'Show more',
          aria: 'Show more in Built',
        });
      else out.push({ text: `${n} not shown in this view`, action: null, label: null, aria: null });
    }
    return out;
  }

  // ---- The focus line on one row (QA-1d, Q11) ----

  /**
   * How many focus steps fit on the one-row focus line. The board measures each step once (its width with the arrow
   * before it), the space the step list has, and the "+N more" button, and asks this rule; the steps after the answer
   * are hidden and counted in "+N more". Pure, so it is tested without a layout engine.
   *   widths:    the width of each step, in order (bad numbers count as 0)
   *   available: the width the step list has
   *   more:      the width of the "+N more" button
   *   gap:       the gap between two items in the list (default 0)
   * Answer: a count from 0 to widths.length. When every step fits, no room is kept for "+N more" (it is not shown).
   * Otherwise as many as fit beside the button, but always at least 1: the first step is the current one, and it
   * stays visible (cut short with an ellipsis when even it does not fit).
   */
  function focusFit({ widths, available, more, gap = 0 }) {
    const w = (widths ?? []).map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
    const n = w.length;
    if (!n) return 0;
    const g = Number.isFinite(gap) && gap > 0 ? gap : 0;
    const room = Number.isFinite(available) ? available : 0;
    const total = w.reduce((s, x) => s + x, 0) + g * (n - 1);
    if (total <= room) return n;
    const button = (Number.isFinite(more) && more > 0 ? more : 0) + g;
    let used = 0;
    let fit = 0;
    for (let i = 0; i < n; i++) {
      used += w[i] + (i ? g : 0);
      if (used + button > room) break;
      fit = i + 1;
    }
    return Math.max(1, fit);
  }

  // ---- Stale data ----

  /** Limit for when the data counts as stale: the last successful fetch is older than one minute. */
  const STALE_MS = 60_000;

  /** Is the last fetch (ms since epoch, or null) older than the limit at `now`? Without a fetch: not stale. */
  function stale(fetchedMs, nowMs, limit = STALE_MS) {
    return Number.isFinite(fetchedMs) && nowMs - fetchedMs > limit;
  }

  /** "Not updated since 14:05" (local time, hours and minutes). */
  function staleText(fetched) {
    const t = String(fetched.getHours()).padStart(2, '0');
    const m = String(fetched.getMinutes()).padStart(2, '0');
    return `Not updated since ${t}:${m}`;
  }

  // ---- Stale and error states (B29, S-stale) ----
  // When the board's data is old it must not look live: one banner says in plain words what is wrong and what to do,
  // the cards are dimmed, the times on them stop at the last update and writes are paused. The rules are here (pure,
  // tested in queueBoardStale.test.ts); board/api.js draws them.

  /** "14:05" in local time (hours and minutes) for a fetch time in ms, or null without one. */
  function hhmm(ms) {
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * What kind of failure an HTTP status is: 0 or none = the server did not answer (stopped, or the network is gone),
   * 401 = the key changed (the server was restarted), 503 = the server could not read the queue file, anything else = a
   * server error.
   */
  function errorKind(status) {
    if (!status) return 'offline';
    if (status === 401) return 'key';
    if (status === 503) return 'queue';
    return 'server';
  }

  /** A plain sentence for a failed call without its own message from the server: never a code, a stack or the key. */
  function plainError(status) {
    const kind = errorKind(status);
    if (kind === 'offline')
      return 'The board cannot reach its server. It may have stopped: start it again with ravenseat board.';
    if (kind === 'key') return 'The key changed because the board was restarted. Run ravenseat board open.';
    if (kind === 'queue') return 'The server could not read the queue file. The board tries again by itself.';
    return 'The server could not do this. Try again; if it keeps happening, restart the board.';
  }

  /** The reason a write is refused while the data is stale (the toast when a change is tried). */
  const STALE_BLOCKED =
    'Changes are paused: the board is showing old data. They work again as soon as the board is back in contact.';

  /**
   * Is the board stale, and what does the banner say? Returns null while the data is live, otherwise
   * { kind, tone, title, text, command, retry }:
   *   - kind: 'key' (the key banner with its link field carries it), 'offline', 'queue', 'server' or 'old' (no error,
   *     but no fetch for over a minute, for example after the computer slept).
   *   - tone: 'danger' when something is broken and needs the owner (no server, an unreadable queue file, a server
   *     error), 'warn' for data that is just old (the warn tone means stale data, PALETTE in lib/queueBoard.js).
   *   - command: a command to show with a Copy button, or null. retry: whether "Try again" makes sense.
   * Input: { keyInvalid, error (the kind from errorKind, or null), fetched (ms of the last successful fetch, or null),
   * now (ms) }.
   */
  function staleView(o) {
    const at = hhmm(o.fetched);
    const last = at
      ? `Showing the state from ${at}; times on the cards are as of then. Changes are paused until it is back.`
      : 'Nothing has been read yet. Changes are paused until it is back.';
    if (o.keyInvalid)
      return {
        kind: 'key',
        tone: 'danger',
        title: 'The key changed because the board was restarted.',
        text: last,
        command: 'ravenseat board open',
        retry: false,
      };
    if (o.error === 'offline')
      return {
        kind: 'offline',
        tone: 'danger',
        title: at ? `The board lost contact with its server at ${at}.` : 'The board cannot reach its server.',
        text: `${last} If the server stopped, start it again. The board keeps trying by itself.`,
        command: 'ravenseat board',
        retry: true,
      };
    if (o.error === 'queue')
      return {
        kind: 'queue',
        tone: 'danger',
        title: 'The board cannot read the queue file.',
        text: `${last} The file may be half written or broken; the board tries again by itself.`,
        command: null,
        retry: true,
      };
    if (o.error)
      return {
        kind: 'server',
        tone: 'danger',
        title: "The board's server answered with an error.",
        text: `${last} The board tries again by itself; if it keeps happening, restart the board.`,
        command: 'ravenseat board',
        retry: true,
      };
    if (stale(o.fetched, o.now))
      return {
        kind: 'old',
        tone: 'warn',
        title: `The board has not been updated since ${at}.`,
        text: `${last} It updates again when the tab is in front, or try now.`,
        command: null,
        retry: true,
      };
    return null;
  }

  /**
   * The one sentence a screen reader hears when the stale state changes (a polite live region), or null when nothing
   * changed: going stale, a different kind of stale, and coming back are said once each; a retry that fails again is
   * silent. `before` and `after` are staleView results (or null).
   */
  function staleAnnouncement(before, after) {
    const a = before?.kind ?? null;
    const b = after?.kind ?? null;
    if (a === b) return null;
    if (!b) return 'The board is back in contact and up to date.';
    return `${after.title} Showing the last state; changes are paused.`;
  }

  return {
    emptyReason,
    chainHidden,
    focusFit,
    STALE_MS,
    stale,
    staleText,
    hhmm,
    errorKind,
    plainError,
    STALE_BLOCKED,
    staleView,
    staleAnnouncement,
    FOCUSABLE,
    nextInTrap,
    focusable,
    trapKey,
    setInert,
    toastAdd,
    toastRemove,
    luminance,
    contrast,
    tabMeasure,
    CLASSES,
    classLabel,
    wipText,
    keyFromLink,
    THEME_OPTION,
    themeFromSaved,
    nextTheme,
  };
});
