// =============================================================
// plans/triage.js: confirming Claude's proposals in the Plans Inbox (P7 of plans/plans-tab-ux-review-2026-11-19.md,
// section 7.3). Vanilla JS, no build step, no CDN. All text is set with textContent (via h.el), never innerHTML.
//
// Claude sorts the Inbox with `/plans inbox` and writes a PROPOSAL per item (`ravenseat plan propose`, lib/planProposal.js);
// nothing is applied by itself. This file draws, on every Inbox row (the Roadmap card and the plan page):
//   - with a proposal: "Claude suggests: App · Now (important) · Investigated · size M", the reason, the new summary,
//     the plan it looks like and the suggested outline (folded), then Accept (1), Edit (2), Decline (3) and, when a
//     duplicate was found, Merge into PL-X (4), Linear-triage style;
//   - without one: how to get one, then Edit (2) and Drop (3) (the owner can always sort by hand).
// Accept and Merge save at once; Edit opens a small form with the proposal's values ("Edit then accept"); Decline opens a
// reason with Drop it, and Merge into any other plan. Every save is POST /api/plan-proposal (the server's write guard:
// origin, JSON only, the key, the size cap, one write at a time, and --expect-changed with the version the owner looked
// at, so a register changed meanwhile gives 409 in words), and the toast offers Undo (POST /api/plan-undo).
//
// `h` is the helpers from plans.js (triageHelp): el, featureOn (features.plans.inbox), data (the /api/plans payload),
// triage/setTriage (the form state, kept in plans.js so a live redraw keeps what is typed), message, undoToast and
// refresh. The writing lives here, as in capture.js and work.js: plans.js itself only reads.
// =============================================================
(function () {
  'use strict';
  const V = window.QueuePlanView;
  const LIMIT = V.PROPOSAL;
  const KEY = 'queue-board-key'; // same as board.js (sessionStorage)

  /** POST with the board key, as capture.js does (an error answer becomes an Error with the server's message). */
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
  const post = (h, filePath, body) => (h.post ? h.post(filePath, body) : postJson(filePath, body));

  const st = (h) => h.triage();
  const shown = (h, p) => Boolean(p?.inbox) && h.featureOn();
  const safeId = (id) => String(id).replace(/[^A-Za-z0-9-]/g, '-');

  // ---- Saving ----

  /** One save: the row is busy, an answer with a changelog number gets Undo, a refusal is said on the row. */
  async function save(h, p, body) {
    if (st(h).busy) return;
    const d = h.data();
    h.setTriage({ busy: p.id, error: null });
    let answer;
    try {
      answer = await post(h, '/api/plan-proposal', { ...body, id: p.id, expect: d?.changed ?? null });
    } catch (e) {
      h.setTriage({ busy: null, error: { id: p.id, text: `Not saved: ${e.message}` } }, { focus: `triage:${p.id}:first` });
      return;
    }
    h.setTriage({ busy: null, edit: null, decline: null, error: null });
    const text = answer?.message ?? 'Saved.';
    if (answer?.log != null) h.undoToast(text, () => undo(h, answer.log), 'Puts the plan back in the inbox as it was');
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

  const accept = (h, p, edits = {}) => save(h, p, { action: 'accept', edits });
  const merge = (h, p, to) => save(h, p, { action: 'merge', to });
  const decline = (h, p, reason) => save(h, p, { action: 'decline', reason: String(reason ?? '').trim() });

  // ---- Edit then accept ----

  /** The form's starting values: the proposal's fields over the plan as it is. */
  function startFields(p) {
    const f = p.proposal?.fields ?? {};
    const pick = (k, now) => (f[k] !== undefined ? f[k] : now);
    return {
      project: pick('project', p.project ?? ''),
      priority: pick('priority', LIMIT.PRIORITIES.includes(p.priority) ? p.priority : 'later'),
      now_category: [...(pick('now_category', p.now_category) ?? [])],
      priority_reason: pick('priority_reason', p.priority_reason) ?? '',
      maturity: pick('maturity', LIMIT.MATURITIES.includes(p.maturity_plan) ? p.maturity_plan : 'idea'),
      size: pick('size', p.size) ?? '',
      summary: pick('summary', p.summary) ?? '',
    };
  }

  function openEdit(h, p) {
    h.setTriage({ edit: { id: p.id, fields: startFields(p) }, decline: null, error: null }, { focus: `triage:${p.id}:project` });
  }
  function openDecline(h, p) {
    const to = otherPlans(h, p)[0]?.id ?? '';
    h.setTriage({ decline: { id: p.id, reason: '', to }, edit: null, error: null }, { focus: `triage:${p.id}:reason` });
  }
  const close = (h, p, what) => h.setTriage({ [what]: null }, { focus: `triage:${p.id}:first` });

  /** The owner's edits from the form: every field as shown; an empty one is null (keep the plan's value). */
  function edits(fields) {
    const text = (v) => (String(v ?? '').trim() ? String(v).trim() : null);
    return {
      project: text(fields.project),
      priority: text(fields.priority),
      now_category: fields.priority === 'now' ? [...fields.now_category] : null,
      priority_reason: text(fields.priority_reason),
      maturity: text(fields.maturity),
      size: text(fields.size),
      summary: text(fields.summary),
    };
  }

  /** A labelled select (id from the row, so labels and focus are unique per plan). */
  function select(h, p, name, label, options, value, onchange) {
    const id = `triage-${safeId(p.id)}-${name}`;
    // label and select in one cell, so the grid never puts a label beside another field's select
    return [
      h.el(
        'div',
        { class: 'plans-triage-field' },
        h.el('label', { class: 'plans-triage-label', for: id, text: label }),
        h.el(
          'select',
          { id, name, class: 'plans-triage-input', 'data-focus': `triage:${p.id}:${name}`, onchange: (e) => onchange(e.target.value) },
          options.map(([v, t]) => h.el('option', { value: v, text: t, selected: v === value ? true : null })),
        ),
      ),
    ];
  }

  function editForm(h, p) {
    const s = st(h).edit;
    const f = s.fields;
    const set = (change, redraw = false) =>
      h.setTriage({ edit: { ...s, fields: { ...f, ...change } } }, { redraw, focus: redraw ? `triage:${p.id}:priority` : null });
    const d = h.data() ?? {};
    const projects = Object.entries(d.projects ?? {})
      .map(([pid, x]) => [pid, x?.title ?? pid])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const reasonId = `triage-${safeId(p.id)}-reason-text`;
    const summaryId = `triage-${safeId(p.id)}-summary`;
    const form = h.el(
      'form',
      {
        class: 'plans-triage-form',
        'aria-label': `Edit then accept: ${p.title || p.id}`,
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          accept(h, p, edits(st(h).edit?.fields ?? f));
        },
        onkeydown: (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          close(h, p, 'edit');
        },
      },
      h.el(
        'div',
        { class: 'plans-triage-grid' },
        ...select(h, p, 'project', 'Project', projects, f.project, (v) => set({ project: v })),
        ...select(
          h,
          p,
          'priority',
          'Priority',
          LIMIT.PRIORITIES.map((k) => [k, V.PRIORITY[k]?.text ?? k]),
          f.priority,
          (v) => set({ priority: v }, true),
        ),
        ...select(h, p, 'maturity', 'Maturity', LIMIT.MATURITIES.map((k) => [k, V.MATURITY[k] ?? k]), f.maturity, (v) =>
          set({ maturity: v }),
        ),
        ...select(h, p, 'size', 'Size', [['', 'No size'], ...LIMIT.SIZES.map((k) => [k, k])], f.size, (v) => set({ size: v })),
      ),
      f.priority === 'now'
        ? h.el(
            'fieldset',
            { class: 'plans-triage-categories' },
            h.el('legend', { text: 'Why now' }),
            LIMIT.CATEGORIES.map((k) => {
              const id = `triage-${safeId(p.id)}-cat-${k}`;
              return h.el(
                'span',
                { class: 'plans-triage-check' },
                h.el('input', {
                  type: 'checkbox',
                  id,
                  name: 'now_category',
                  value: k,
                  checked: f.now_category.includes(k) ? true : null,
                  onchange: (e) =>
                    set({
                      now_category: e.target.checked
                        ? [...new Set([...f.now_category, k])]
                        : f.now_category.filter((x) => x !== k),
                    }),
                }),
                h.el('label', { for: id, text: V.CATEGORY?.[k] ?? k }),
              );
            }),
          )
        : null,
      h.el('label', { class: 'plans-triage-label', for: reasonId, text: 'Why this priority (one sentence)' }),
      h.el('input', {
        type: 'text',
        id: reasonId,
        name: 'priority_reason',
        class: 'plans-triage-input',
        'data-focus': `triage:${p.id}:priority_reason`,
        maxlength: String(LIMIT.REASON_MAX),
        autocomplete: 'off',
        value: f.priority_reason,
        oninput: (e) => set({ priority_reason: e.target.value }),
      }),
      h.el('label', { class: 'plans-triage-label', for: summaryId, text: 'Summary (one sentence; your own text is kept)' }),
      h.el('textarea', {
        id: summaryId,
        name: 'summary',
        class: 'plans-triage-input',
        'data-focus': `triage:${p.id}:summary`,
        rows: '2',
        maxlength: String(LIMIT.SUMMARY_MAX),
        oninput: (e) => set({ summary: e.target.value }),
      }),
      h.el(
        'div',
        { class: 'plans-triage-form-actions' },
        h.el('button', {
          type: 'submit',
          class: 'button button-filled',
          text: st(h).busy === p.id ? 'Saving …' : 'Accept',
          disabled: st(h).busy ? true : null,
        }),
        h.el('button', { type: 'button', class: 'button button-outline', text: 'Cancel', onclick: () => close(h, p, 'edit') }),
      ),
    );
    // a textarea's text is its value, not an attribute
    const t = form.querySelector('textarea');
    if (t) t.value = f.summary;
    return form;
  }

  // ---- Decline and Merge ----

  /** The plans this one can be merged into: the duplicates Claude found first, then the rest by title (not dropped). */
  function otherPlans(h, p) {
    const all = (h.data()?.entries ?? []).filter((q) => q.id !== p.id && q.priority !== 'drop');
    const first = (p.proposal?.merge ?? []).map((id) => all.find((q) => q.id === id)).filter(Boolean);
    const rest = all
      .filter((q) => !first.includes(q))
      .sort((a, b) => String(a.title ?? a.id).localeCompare(String(b.title ?? b.id)));
    return [...first, ...rest];
  }

  function declinePanel(h, p) {
    const s = st(h).decline;
    const reasonId = `triage-${safeId(p.id)}-decline-reason`;
    const toId = `triage-${safeId(p.id)}-merge-to`;
    const others = otherPlans(h, p);
    const busy = st(h).busy ? true : null;
    return h.el(
      'div',
      {
        class: 'plans-triage-decline',
        role: 'group',
        'aria-label': `Decline: ${p.title || p.id}`,
        onkeydown: (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          close(h, p, 'decline');
        },
      },
      h.el('label', { class: 'plans-triage-label', for: reasonId, text: 'Why drop it (optional, one sentence)' }),
      h.el('input', {
        type: 'text',
        id: reasonId,
        name: 'reason',
        class: 'plans-triage-input',
        maxlength: String(LIMIT.REASON_MAX),
        autocomplete: 'off',
        value: s.reason ?? '',
        'data-focus': `triage:${p.id}:reason`,
        oninput: (e) => h.setTriage({ decline: { ...s, reason: e.target.value } }, { redraw: false }),
      }),
      h.el(
        'div',
        { class: 'plans-triage-form-actions' },
        h.el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Drop it',
          disabled: busy,
          onclick: () => decline(h, p, st(h).decline?.reason ?? s.reason),
        }),
      ),
      others.length
        ? h.el(
            'div',
            { class: 'plans-triage-merge-row' },
            h.el('label', { class: 'plans-triage-label', for: toId, text: 'Or merge it into an existing plan' }),
            h.el(
              'select',
              {
                id: toId,
                name: 'merge-to',
                class: 'plans-triage-input',
                onchange: (e) => h.setTriage({ decline: { ...s, to: e.target.value } }, { redraw: false }),
              },
              others.map((q) =>
                h.el('option', { value: q.id, text: `${q.id}, ${q.title ?? q.id}`, selected: q.id === s.to ? true : null }),
              ),
            ),
            h.el('button', {
              type: 'button',
              class: 'button button-outline',
              text: 'Merge',
              disabled: busy,
              onclick: () => merge(h, p, st(h).decline?.to || s.to || others[0].id),
            }),
          )
        : null,
      h.el('button', { type: 'button', class: 'link-button', text: 'Cancel', onclick: () => close(h, p, 'decline') }),
    );
  }

  // ---- The row ----

  /** One action button with its key, visible as a small hint and announced through aria-keyshortcuts. */
  function action(h, p, name, text, key, onclick, first) {
    return h.el(
      'button',
      {
        type: 'button',
        class: `button ${name === 'accept' ? 'button-filled' : 'button-outline'} plans-triage-button`,
        'data-action': name,
        'data-focus': first ? `triage:${p.id}:first` : `triage:${p.id}:${name}`,
        'aria-keyshortcuts': key,
        title: `${text} (key ${key})`,
        disabled: st(h).busy ? true : null,
        onclick,
      },
      text,
      h.el('span', { class: 'plans-triage-key', 'aria-hidden': 'true', text: key }),
    );
  }

  /**
   * The proposal block for an Inbox row, or null (not in the Inbox, or features.plans.inbox off). The words come first
   * ("Claude suggests ..."), so a screen reader hears them before the buttons; the group is labelled by them.
   */
  function block(h, p) {
    if (!shown(h, p)) return null;
    const t = V.proposalText(p, h.data() ?? {});
    const saysId = `triage-${safeId(p.id)}-says`;
    const s = st(h);
    const kids = [];
    if (t) {
      kids.push(h.el('p', { class: 'plans-triage-says', id: saysId, text: t.text }));
      if (t.because) kids.push(h.el('p', { class: 'plans-triage-because', text: `Because: ${t.because}` }));
      if (t.summary) kids.push(h.el('p', { class: 'plans-triage-summary', text: `New summary: ${t.summary}` }));
      if (t.sources.length) kids.push(h.el('p', { class: 'plans-triage-sources', text: `Plan document: ${t.sources.join(', ')}` }));
      for (const m of t.merge.slice(0, 1))
        kids.push(h.el('p', { class: 'plans-triage-merge', text: `Looks like ${m.id}${m.title ? `, ${m.title}` : ''}` }));
      if (t.outline)
        kids.push(
          h.el(
            'details',
            { class: 'plans-triage-outline' },
            h.el('summary', { text: 'Suggested outline' }),
            h.el('p', { class: 'plans-triage-outline-text', text: t.outline }),
          ),
        );
    } else
      kids.push(
        h.el('p', {
          class: 'plans-triage-says none',
          id: saysId,
          text: 'No suggestion yet. Claude suggests a project, priority and summary when you run /plans inbox in Claude Code.',
        }),
      );
    const dup = t?.merge?.[0] ?? null;
    kids.push(
      h.el(
        'div',
        { class: 'plans-triage-actions' },
        t ? action(h, p, 'accept', 'Accept', '1', () => accept(h, p), true) : null,
        action(h, p, 'edit', 'Edit', '2', () => openEdit(h, p), !t),
        action(h, p, 'decline', t ? 'Decline' : 'Drop', '3', () => openDecline(h, p)),
        dup ? action(h, p, 'merge', `Merge into ${dup.id}`, '4', () => merge(h, p, dup.id)) : null,
      ),
    );
    if (s.edit?.id === p.id) kids.push(editForm(h, p));
    if (s.decline?.id === p.id) kids.push(declinePanel(h, p));
    if (s.error?.id === p.id) kids.push(h.el('p', { class: 'plans-triage-error', role: 'alert', text: s.error.text }));
    return h.el(
      'div',
      { class: 'plans-triage', role: 'group', 'aria-labelledby': saysId, 'data-triage': p.id },
      ...kids,
    );
  }

  /**
   * The keys on a row with focus (work.js sends 1 to 4 here on the Roadmap and the plan page): 1 Accept, 2 Edit,
   * 3 Decline (Drop without a proposal), 4 Merge into the duplicate. true when the key did something.
   */
  function key(h, p, k) {
    if (!shown(h, p) || st(h).busy) return false;
    const has = Boolean(V.proposalText(p, h.data() ?? {}));
    if (k === '1' && has) {
      accept(h, p);
      return true;
    }
    if (k === '2') {
      openEdit(h, p);
      return true;
    }
    if (k === '3') {
      openDecline(h, p);
      return true;
    }
    const dup = has ? p.proposal?.merge?.[0] : null;
    if (k === '4' && dup) {
      merge(h, p, dup);
      return true;
    }
    return false;
  }

  window.QueuePlanTriage = { block, key };
})();
