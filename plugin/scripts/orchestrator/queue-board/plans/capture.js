// =============================================================
// plans/capture.js: "+ New plan" in the Plans room, quick capture into the Inbox (P6 of
// plans/plans-tab-ux-review-2026-11-19.md, section 7.3).
// Vanilla JS, no build step, no CDN. All text is set with textContent (via h.el), never innerHTML.
//
// The only step for the owner: a title (required) and, if they like, what and why in their own words. One button,
// "Add to inbox", saves at once (POST /api/plan-capture, no preview: a capture only adds), the form closes, and the
// board's toast says "Added to the inbox ..." with Undo (POST /api/plan-undo with the changelog number). Claude sorts the
// Inbox later; nothing else is asked here (no id, project, priority or category).
//
// `h` is the helpers from plans.js (captureHelp): el, featureOn (features.plans.inbox), capture/setCapture (the form's
// state, kept in plans.js so a live redraw keeps what is typed), message, undoToast and refresh. The POST is here.
// =============================================================
(function () {
  'use strict';
  const V = window.QueuePlanView;
  const LIMIT = V.CAPTURE;
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)

  /** POST with the board key, as work.js does (an error answer becomes an Error with the server's message). */
  async function postJson(filePath, body) {
    const res = await fetch(filePath, {
      method: 'POST',
      headers: { 'X-Queue-Key': sessionStorage.getItem(KEY) ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    if (!res.ok) throw new Error(answer?.message ?? `HTTP ${res.status}`);
    return answer;
  }

  /** The write: `h.post` when the caller gives one (the tests), otherwise the board's own POST above. */
  const post = (h, filePath, body) => (h.post ? h.post(filePath, body) : postJson(filePath, body));

  /** The "+ New plan" button (the Roadmap's toolbar, Plan entries and the empty register), or null when it is off. */
  function button(h, { cls = 'button button-filled' } = {}) {
    if (!h.featureOn()) return null;
    const st = h.capture();
    return h.el('button', {
      type: 'button',
      class: `${cls} plans-capture-open`,
      text: '+ New plan',
      title: 'Write down a plan: a title is enough (key: n)',
      'aria-keyshortcuts': 'n',
      'aria-expanded': st.open ? 'true' : 'false',
      'aria-controls': 'plans-capture',
      'data-focus': 'capture-open',
      onclick: () => open(h),
    });
  }

  /** Opens the form with the focus on Title (the button and the n key). */
  function open(h) {
    if (!h.featureOn()) return;
    if (h.capture().open) {
      h.setCapture({}, { focus: 'capture-title' });
      return;
    }
    h.setCapture({ open: true, error: null }, { focus: 'capture-title' });
  }

  /** Closes the form; what was typed goes with it (Cancel and Escape mean "not now"). */
  function close(h) {
    h.setCapture({ open: false, title: '', text: '', error: null, busy: false }, { focus: 'capture-open' });
  }

  /** The note under the text: the soft limit is a hint, never a stop (the hard limit is the field's maxlength). */
  function countText(n) {
    if (n > LIMIT.TEXT_SOFT)
      return `${n} characters. That is long for an idea; a plan document may fit better, but it is saved as written.`;
    return n ? `${n} of about ${LIMIT.TEXT_SOFT} characters.` : 'Optional. A few sentences are enough.';
  }

  async function submit(h) {
    const st = h.capture();
    if (st.busy) return;
    const title = String(st.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) {
      h.setCapture({ error: 'Write a title first.' }, { focus: 'capture-title' });
      return;
    }
    h.setCapture({ busy: true, error: null });
    let answer;
    try {
      answer = await post(h, '/api/plan-capture', { title, text: String(st.text ?? '') });
    } catch (e) {
      h.setCapture({ busy: false, error: `Could not add it: ${e.message}` }, { focus: 'capture-title' });
      return;
    }
    close(h);
    const text = answer?.message ?? 'Added to the inbox.';
    if (answer?.log != null) h.undoToast(text, () => undo(h, answer.log), 'Takes the new plan out of the register again');
    else h.message(text);
    await h.refresh();
  }

  async function undo(h, nr) {
    try {
      const a = await post(h, '/api/plan-undo', { nr: [nr] });
      h.message(a?.message ?? 'Undone.');
    } catch (e) {
      h.message(`Could not undo: ${e.message}`, true);
    }
    await h.refresh();
  }

  /** The form, right under the toolbar while it is open; null otherwise. */
  function form(h) {
    if (!h.featureOn()) return null;
    const st = h.capture();
    if (!st.open) return null;
    const n = String(st.text ?? '').length;
    const count = h.el('p', { class: 'plans-capture-count', id: 'plans-capture-count', text: countText(n) });
    return h.el(
      'form',
      {
        class: 'plans-capture',
        id: 'plans-capture',
        'aria-labelledby': 'plans-capture-heading',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          submit(h);
        },
        onkeydown: (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          close(h);
        },
      },
      h.el('h2', { class: 'plans-capture-heading', id: 'plans-capture-heading', text: 'New plan' }),
      h.el('p', {
        class: 'plans-capture-hint',
        text: 'It goes into the Inbox. Claude sorts it the next time plans are worked on, and you confirm.',
      }),
      h.el('label', { class: 'plans-capture-label', for: 'plans-capture-title', text: 'Title' }),
      h.el('input', {
        type: 'text',
        id: 'plans-capture-title',
        class: 'plans-capture-title',
        required: true,
        'aria-required': 'true',
        maxlength: String(LIMIT.TITLE_MAX),
        autocomplete: 'off',
        value: st.title ?? '',
        'aria-invalid': st.error && !String(st.title ?? '').trim() ? 'true' : null,
        'aria-describedby': st.error ? 'plans-capture-error' : null,
        'data-focus': 'capture-title',
        // no redraw while typing: the state keeps the value, so a live update draws it again as it was
        oninput: (e) => h.setCapture({ title: e.target.value }, { redraw: false }),
      }),
      h.el('label', {
        class: 'plans-capture-label',
        for: 'plans-capture-text',
        text: 'What and why, in your own words (optional)',
      }),
      h.el('textarea', {
        id: 'plans-capture-text',
        class: 'plans-capture-text',
        rows: '4',
        maxlength: String(LIMIT.TEXT_MAX),
        'aria-describedby': 'plans-capture-count',
        'data-focus': 'capture-text',
        // the value is set below (a textarea's text is its content), and the count follows without a redraw
        oninput: (e) => {
          h.setCapture({ text: e.target.value }, { redraw: false });
          count.textContent = countText(e.target.value.length);
        },
      }),
      count,
      st.error
        ? h.el('p', { class: 'plans-capture-error', id: 'plans-capture-error', role: 'alert', text: st.error })
        : null,
      h.el(
        'div',
        { class: 'plans-capture-actions' },
        h.el('button', {
          type: 'submit',
          class: 'button button-filled',
          text: st.busy ? 'Adding …' : 'Add to inbox',
          disabled: st.busy ? true : null,
          'data-focus': 'capture-add',
        }),
        h.el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Cancel',
          'data-focus': 'capture-cancel',
          onclick: () => close(h),
        }),
      ),
    );
  }

  /** The textarea's value after it is drawn (h.el sets attributes, and a textarea's value is not one). */
  function fill(node, h) {
    const t = node?.querySelector?.('#plans-capture-text');
    if (t) t.value = h.capture().text ?? '';
    return node;
  }

  window.QueuePlanCapture = {
    button,
    form: (h) => fill(form(h), h),
    open,
  };
})();
