// =============================================================
// bulk.js: the dialog for a bulk action (fields, preview, "Do it"), and "Undo" (30 seconds after a bulk
// action) and "Undo last" (the gear).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- The dialog for a bulk action: fields, preview, "Do it" ----
const bulkBackground = $('bulk-background');
const bulkBox = $('bulk');

/** The action the server gets (the label dialog selects add or remove). */
const bulkAction = (m) =>
  m.type === 'label' ? (m.val.remove ? 'label-remove' : 'label-add') : m.type;

/** What is missing before the preview can be worked out, or null. */
function bulkMissing(m) {
  const v = m.val;
  if (m.type === 'project' && !v.selected) return 'Select the project the tasks go to.';
  if (m.type === 'rank') {
    if (!v.space) return 'Select where the block goes.';
    if ((v.space === 'over' || v.space === 'under') && !v.ref)
      return 'Write the id of the task the block goes next to.';
  }
  if (m.type === 'label' && !v.label) return 'Write the label.';
  return null;
}

/** The fields for the action (null when it has none). If a field changes, the preview must be worked out again. */
function bulkField(type) {
  const set = (field, val) => {
    if (!t.bulk) return;
    t.bulk.val[field] = val;
    t.bulk.preview = null;
    t.bulk.error = null;
    drawPreview();
  };
  const enter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      previewBulk();
    }
  };
  const field = (id, label, control, help) =>
    el(
      'div',
      { class: 'field' },
      el('label', { for: id, text: label }),
      control,
      help ? el('p', { class: 'field-help', text: help }) : null,
    );
  const textField = (id, name, attr = {}) =>
    el('input', {
      id,
      type: 'text',
      autocomplete: 'off',
      oninput: (e) => set(name, e.target.value.trim() || null),
      onkeydown: enter,
      ...attr,
    });
  const datalist = (id, values) =>
    el(
      'datalist',
      { id },
      [...new Set(values)].sort().map((v) => el('option', { value: v })),
    );
  const allSummary = [...t.perId.values()].map((x) => x.k);

  if (type === 'project') {
    const option = el(
      'select',
      {
        id: 'bulk-project',
        onchange: (e) => {
          const v = e.target.value;
          t.bulk.val.selected = v !== '';
          set('pid', v === '' || v === '__none' ? null : v);
          if (v !== '') previewBulk();
        },
      },
      el('option', { value: '', text: 'Select project …' }),
      (t.data.projects ?? [])
        .filter((p) => p.pid !== 'without-project')
        .map((p) =>
          el('option', {
            value: p.pid,
            text: `${p.title ?? p.pid} (${p.pid})${p.pause ? ', paused' : ''}`,
          }),
        ),
      el('option', { value: '__none', text: 'No fixed project (follow the prefix)' }),
    );
    return field(
      'bulk-project',
      'Project',
      option,
      'A new project is created with ravenseat project <pid> --title "…".',
    );
  }
  if (type === 'feature')
    return el(
      'div',
      null,
      field(
        'bulk-feature',
        'Feature',
        textField('bulk-feature', 'name', { list: 'bulk-features' }),
        'An empty field removes the feature. The suggestions are the features that exist in the queue.',
      ),
      datalist('bulk-features', allSummary.map((k) => k.feature).filter(Boolean)),
    );
  if (type === 'park')
    return el(
      'div',
      null,
      field(
        'bulk-reason',
        'Reason (optional)',
        textField('bulk-reason', 'reason', { maxlength: 200 }),
      ),
      field(
        'bulk-to',
        'Through date (optional)',
        el('input', {
          id: 'bulk-to',
          type: 'date',
          min: new Date().toISOString().slice(0, 10),
          onchange: (e) => set('to', e.target.value || null),
        }),
        'Without a date the tasks stay on hold until you take them off.',
      ),
    );
  if (type === 'rank') {
    const ref = el(
      'div',
      { class: 'field', hidden: true },
      el('label', { for: 'bulk-ref', text: 'Task the block goes next to' }),
      textField('bulk-ref', 'ref', { list: 'bulk-ids' }),
      datalist(
        'bulk-ids',
        (t.data.columns.queue ?? []).map((k) => k.id).filter((id) => !t.bulk?.ids.includes(id)),
      ),
    );
    const space = el(
      'select',
      {
        id: 'bulk-space',
        onchange: (e) => {
          const v = e.target.value;
          ref.hidden = !(v === 'over' || v === 'under');
          set('space', v || null);
          if (v === 'top' || v === 'bottom') previewBulk();
        },
      },
      el('option', { value: '', text: 'Select place …' }),
      el('option', { value: 'top', text: 'Top of the step' }),
      el('option', { value: 'bottom', text: 'Bottom of the step' }),
      el('option', { value: 'over', text: 'Right above another task' }),
      el('option', { value: 'under', text: 'Right below another task' }),
    );
    return el('div', null, field('bulk-space', 'Place', space), ref);
  }
  if (type === 'label')
    return el(
      'div',
      null,
      field(
        'bulk-label-option',
        'Action',
        el(
          'select',
          {
            id: 'bulk-label-option',
            onchange: (e) => set('remove', e.target.value === 'remove'),
          },
          el('option', { value: 'add', text: 'Add the label' }),
          el('option', { value: 'remove', text: 'Remove the label' }),
        ),
      ),
      field(
        'bulk-label',
        'Label',
        textField('bulk-label', 'label', { list: 'bulk-labels', maxlength: 31 }),
      ),
      datalist(
        'bulk-labels',
        allSummary.flatMap((k) => k.labels ?? []),
      ),
    );
  if (type === 'batch-pack')
    return el(
      'div',
      null,
      field(
        'bulk-new-id',
        'Id for the new track (optional)',
        textField('bulk-new-id', 'new_id', { maxlength: 41, placeholder: 'proposed automatically' }),
      ),
      field(
        'bulk-title-field',
        'Title (optional)',
        textField('bulk-title-field', 'title', { maxlength: 200 }),
      ),
    );
  return null;
}

/** Opens the dialog for a bulk action on the selected (or the given ids, e.g. a batch group). */
function openBulk(type, ids) {
  const list = (ids ?? [...t.marked]).filter(markable);
  if (!list.length)
    return message(
      'None of the cards can be changed together (only those waiting, proposed and in batch queue).',
      true,
    );
  const info = BULK_INFO[type];
  t.bulk = {
    type,
    ids: list,
    val: {},
    preview: null,
    loading: false,
    error: null,
    remark: null,
    from: document.activeElement,
  };
  const field = bulkField(type);
  buildDialog(
    info,
    field,
    `${countText(list.length)}: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ' …' : ''}`,
  );
  if (AUTO_PREVIEW.has(type)) previewBulk();
  else drawPreview();
}

/** "Undo last" (the gear): shows the entry that is rolled back, and whether it is possible now. */
function openUndo() {
  closePanel();
  t.bulk = {
    type: 'undo',
    ids: [],
    val: {},
    preview: null,
    loading: false,
    error: null,
    remark: null,
    from: document.activeElement,
  };
  buildDialog(BULK_INFO.undo, null, null);
  previewBulk();
}

function buildDialog(info, field, count) {
  const m = t.bulk;
  const cancel = el('button', {
    type: 'button',
    class: 'button button-outline',
    text: 'Cancel',
    title: 'Close without changing anything (Esc)',
    onclick: closeBulk,
  });
  const perform = el('button', {
    type: 'button',
    class: 'button button-filled',
    text: m.type === 'undo' ? 'Undo' : 'Do it',
    disabled: true,
    onclick: executeBulk,
  });
  const show = field
    ? el('button', {
        type: 'button',
        class: 'button button-muted',
        text: 'Show the changes',
        title:
          'Works out what changes, without saving anything (Enter in a text field does the same).',
        onclick: previewBulk,
      })
    : null;
  const preview = el('div', { class: 'bulk-preview', 'aria-live': 'polite' });
  m.el = { preview, do: perform };
  // Like the focus line: replaceChildren turns null into the text "null", so empty parts are filtered away.
  bulkBox.replaceChildren(
    ...[
      el('h2', { id: 'bulk-title', text: info.title }),
      el('p', { id: 'bulk-explanation', class: 'bulk-explanation', text: info.explanation }),
      count ? el('p', { class: 'bulk-count', text: count }) : null,
      field,
      show ? el('div', { class: 'bulk-show' }, show) : null,
      preview,
      el('div', { class: 'guard-buttons' }, cancel, perform),
    ].filter(Boolean),
  );
  bulkBackground.hidden = false;
  (bulkBox.querySelector('select, input') ?? cancel).focus();
}

function closeBulk() {
  const from = t.bulk?.from;
  t.bulk = null;
  bulkBackground.hidden = true;
  bulkBox.replaceChildren();
  if (from?.isConnected) from.focus();
}
bulkBox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeBulk();
  } else {
    // Focus stays in the dialog (the common trap in a11y.js).
    window.QueueA11y.trapKey(e, bulkBox);
  }
});
bulkBackground.addEventListener('click', (e) => {
  if (e.target === bulkBackground) closeBulk();
});

/** The preview: what changes, the guard rules and the warnings. Writes nothing. */
async function previewBulk() {
  const m = t.bulk;
  if (!m || m.loading) return;
  const missing = m.type === 'undo' ? null : bulkMissing(m);
  if (missing) {
    m.preview = null;
    m.error = missing;
    return drawPreview();
  }
  m.loading = true;
  m.error = null;
  m.preview = null;
  drawPreview();
  try {
    const answer =
      m.type === 'undo'
        ? await api('/api/undo', { show: true })
        : await api('/api/bulk', {
            action: bulkAction(m),
            ids: m.ids,
            val: m.val,
            dry: true,
          });
    if (t.bulk !== m) return;
    m.preview = answer;
  } catch (e) {
    if (t.bulk !== m) return;
    m.error = e.message;
  }
  m.loading = false;
  drawPreview();
}

/** The new track in the preview of "Pack into track". */
function packageView(p) {
  const n = p.new;
  return el(
    'section',
    { class: 'bulk-package', 'aria-label': 'The new track' },
    el('h3', { class: 'bulk-package-title', text: `New track ${n.id}` }),
    el(
      'dl',
      { class: 'facts' },
      facts('Title', n.title || '(none)'),
      facts(
        'Class',
        `${n.class ?? '?'} · ${n.content_min} min content · value ${n.value}` +
          (n.migr_tens ? ` · ${n.migr_tens} migration tiers` : ''),
      ),
      facts('Project', `${n.project}${n.feature ? ` · ${n.feature}` : ''}`),
      facts(
        'Status',
        n.status === 'waiting' ? 'waiting (can be started)' : `${n.status} (must be approved)`,
      ),
      facts('Depends on', n.depends_on.length ? n.depends_on.join(', ') : null),
      facts('Waiting on', n.waiting_on.length ? n.waiting_on.join(', ') : null),
      facts('Owner files', n.owned_files.length ? list2(n.owned_files.slice(0, 30), true) : null),
      facts('Labels', n.labels.length ? n.labels.join(', ') : null),
      facts('Canceled', p.cancelled.join(', ')),
      facts('Redirected', p.redirected.length ? p.redirected.join(', ') : null),
      facts('Mission', n.mission),
    ),
  );
}

function drawPreview() {
  const m = t.bulk;
  if (!m?.el) return;
  const f = m.preview;
  const parts = [];
  if (m.remark)
    parts.push(el('p', { class: 'bulk-remark', role: 'status', text: m.remark }));
  if (m.loading) parts.push(el('p', { class: 'empty', text: 'Working out the change …' }));
  if (m.error) parts.push(el('p', { class: 'bulk-error', role: 'alert', text: m.error }));
  const list = (texts, cls) =>
    texts.length
      ? el(
          'ul',
          { class: `guard-list ${cls}` },
          texts.map((x) => el('li', { text: x })),
        )
      : null;
  let can = false;
  if (f && m.type === 'undo') {
    can = f.can === true;
    parts.push(
      f.entry
        ? el('p', {
            class: 'bulk-summary',
            text:
              `No. ${f.entry.nr}: ${f.entry.action} by ${f.entry.by}, ${age(f.entry.at)} ago. ` +
              'The fields below are set back to the value before the arrow.',
          })
        : null,
      list(f.error ?? [], 'bulk-stop'),
    );
    if (f.lines?.length) parts.push(lineList(f.lines, f.lines.length));
  } else if (f) {
    const guard = f.guard ?? [];
    const text = (level) => guard.filter((v) => v.level === level).map((v) => v.text);
    can = f.can === true;
    parts.push(
      el('p', { class: 'bulk-summary', text: f.recap }),
      list([...text('stop'), ...(f.error ?? [])], 'bulk-stop'),
      list([...text('warning'), ...(f.warnings ?? [])], 'bulk-warning'),
      list(text('info'), 'bulk-info'),
    );
    if (f.package) parts.push(packageView(f.package));
    if (f.lines?.length) parts.push(lineList(f.lines, f.field));
    else if (!f.package && can)
      parts.push(el('p', { class: 'empty', text: 'Nothing changes: all are already like that.' }));
  }
  m.el.preview.replaceChildren(...parts.filter(Boolean));
  // "Do it" only when the preview is valid and has something to do.
  const empty = f && m.type !== 'undo' && !f.package && !f.lines?.length;
  m.el.do.disabled = !can || m.loading || !!empty;
  m.el.do.title = !f
    ? 'See the changes first'
    : !can
      ? 'Cannot be done: see the reason above'
      : m.type === 'undo'
        ? 'Rolls back the change as shown above'
        : 'Saves the change as the preview shows it. "Undo" is ready afterwards.';
}

/** The change lines ("A-1 project: alpha → beta"), collapsed when there are many. */
function lineList(lines, count) {
  return el(
    'details',
    { class: 'bulk-lines', open: lines.length <= 12 },
    el('summary', { text: `The changes field by field (${count})` }),
    el(
      'ul',
      null,
      lines.map((l) => el('li', null, el('code', { text: l }))),
    ),
  );
}

/** "Do it": writes with the queue version from the preview. If the queue changed meanwhile, it is shown again. */
async function executeBulk() {
  const m = t.bulk;
  const f = m?.preview;
  if (!f?.can || m.loading) return;
  m.loading = true;
  drawPreview();
  if (m.type === 'undo') {
    closeBulk();
    return undoNr(f.entry?.nr ?? null);
  }
  const val =
    m.type === 'batch-pack' && !m.val.new_id && f.package
      ? { ...m.val, new_id: f.package.new.id }
      : m.val;
  let answer;
  try {
    answer = await api('/api/bulk', {
      action: bulkAction(m),
      ids: m.ids,
      val,
      dry: false,
      expect: f.changed ?? undefined,
      confirm: true,
    });
  } catch (e) {
    if (t.bulk !== m) return;
    m.loading = false;
    if (e.answer?.outdated) {
      // The queue has changed since the preview: fetch it, and show the change again before the owner confirms.
      m.remark =
        'The queue was changed while you looked at the preview. Here it is again; look it over before you confirm.';
      await update(true);
      return previewBulk();
    }
    m.error = e.message;
    return drawPreview();
  }
  const info = BULK_INFO[m.type];
  closeBulk();
  const text =
    m.type === 'batch-pack'
      ? `Packed ${countText(m.ids.length)} into ${answer.new_id}.`
      : `${info.title}: ${countText(m.ids.length)}.`;
  if (answer.log) undoToast(answer.log, text, answer.info);
  else messageWithInfo(text, answer);
  await update(true);
}

// ---- "Undo" (30 seconds after a bulk action) and "Undo last" (the gear) ----
let undoTime = null;
function undoToast(nr, text, info) {
  const box = $('undo-message');
  const lines = [text, ...(Array.isArray(info) ? info : [])].join('\n');
  box.replaceChildren(
    el('span', { class: 'undo-text', text: lines }),
    el('button', {
      type: 'button',
      class: 'button button-muted button-small',
      text: 'Undo',
      title:
        `Rolls back exactly this change (no. ${nr} in the change log). It is refused when someone has changed ` +
        'the same fields since.',
      onclick: () => undoNr(nr),
    }),
    el(
      'button',
      {
        type: 'button',
        class: 'button-icon',
        'aria-label': 'Close the message',
        title: 'Close the message ("Undo last" is also in the gear)',
        onclick: closeUndoToast,
      },
      icon('close'),
    ),
  );
  showToast('undo');
  clearTimeout(undoTime);
  undoTime = setTimeout(closeUndoToast, 30_000);
}
function closeUndoToast() {
  clearTimeout(undoTime);
  const box = $('undo-message');
  hideToast('undo');
  box.replaceChildren();
}
async function undoNr(nr) {
  closeUndoToast();
  try {
    const answer = await api('/api/undo', nr ? { nr } : {});
    message(answer.message ?? 'Undone.');
  } catch (e) {
    message(`Could not undo: ${e.message}`, true);
  }
  await update(true);
}

/** The part in the gear: the last change that can be undone. */
function undoSection() {
  const a = t.data?.undo;
  return el(
    'section',
    { class: 'setting', 'aria-labelledby': 'setting-undo' },
    el('h3', { id: 'setting-undo', class: 'setting-title', text: 'Undo last' }),
    a
      ? el('p', {
          text:
            `No. ${a.nr}: ${a.action} by ${a.by}, ${age(a.at)} ago ` +
            `(${a.field} fields in ${countText(a.tasks)}).`,
        })
      : el('p', {
          class: 'empty',
          text: 'Nothing to undo: the change log is empty, or everything in it is undone.',
        }),
    a
      ? el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Undo last …',
          title:
            'Shows what is rolled back before anything changes. It is refused when someone has changed the same fields since.',
          onclick: openUndo,
        })
      : null,
  );
}
