// =============================================================
// edit.js: cancel, decline and edit one task (the detail panel), and the simple markdown for the
// mission text.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Cancel, decline and edit one task (the detail panel) ----
// Only waiting (also on hold or in the batch queue) and proposed tasks; the server checks again (lib/queueTaskEdit.js)
// and writes with `queue.mjs cancel` or `queue.mjs edit`, both logged, so "Undo" is ready for 30 seconds afterwards.
// A running, picked or review task is never cancelled from the board: the panel shows the CLI command instead.
// The open form lives in t.taskForm ({ id, mode: edit|cancel|decline, values }), so a redraw (polling) keeps it open.
const TASK_EDIT_STATUSES = new Set(['waiting', 'proposed']);
const TASK_CLASSES = ['K', 'D', 'D+', 'U'];
function taskEditActions(k) {
  if (['running', 'picked', 'review'].includes(k.status))
    return el(
      'p',
      { class: 'none task-cli-hint' },
      'An agent or a person may be working on this task, so it is not cancelled from the board. To cancel it: ',
      el('code', { text: `cq set ${k.id} cancelled --remark "<why>"` }),
    );
  if (!TASK_EDIT_STATUSES.has(k.status)) return null;
  const f = t.taskForm?.id === k.id ? t.taskForm : null;
  const stop = k.status === 'proposed' ? 'decline' : 'cancel';
  const open = (mode) => {
    t.taskForm = f?.mode === mode ? null : { id: k.id, mode, values: {} };
    drawPanel(true);
    panel.querySelector(mode === 'edit' ? '#edit-value' : '#cancel-reason')?.focus();
  };
  const parts = [
    el('button', {
      type: 'button',
      class: 'button button-outline',
      text: 'Edit',
      'aria-expanded': String(f?.mode === 'edit'),
      title: 'Change the value, the content minutes and the class. "Undo" is ready afterwards.',
      onclick: () => open('edit'),
    }),
    el('button', {
      type: 'button',
      class: 'button button-outline',
      text: stop === 'decline' ? 'Decline' : 'Cancel task',
      'aria-expanded': String(f?.mode === stop),
      title:
        stop === 'decline'
          ? 'Decline the proposal: it is cancelled with your reason as a remark. You confirm first.'
          : 'The task is cancelled (status cancelled) with your reason as a remark. You confirm first.',
      onclick: () => open(stop),
    }),
  ];
  if (f?.mode === 'edit') parts.push(editForm(k, f));
  else if (f) parts.push(cancelForm(k, f));
  return parts;
}
/** Closes the open form and puts focus back on the button that opened it. */
function closeTaskForm(text) {
  t.taskForm = null;
  drawPanel(true);
  [...panel.querySelectorAll('.actions button')].find((b) => b.textContent === text)?.focus();
}
/** Escape in an open form closes it (and does not close the panel). */
function escapeCloses(form, text) {
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeTaskForm(text);
  });
}
/** The "Edit" form: value (1-10), content minutes and class, starting from the task as it is. */
function editForm(k, f) {
  const v = f.values;
  const keep = (name) => (e) => (v[name] = e.target.value);
  const value = el('input', {
    id: 'edit-value',
    type: 'number',
    min: '1',
    max: '10',
    step: '1',
    value: v.value ?? String(k.value ?? ''),
  });
  value.addEventListener('input', keep('value'));
  const content = el('input', {
    id: 'edit-content',
    type: 'number',
    min: '1',
    max: '1000',
    step: '1',
    value: v.content_min ?? String(k.content_min ?? ''),
  });
  content.addEventListener('input', keep('content_min'));
  const klass = el(
    'select',
    { id: 'edit-class' },
    TASK_CLASSES.map((c) => el('option', { value: c, text: c })),
  );
  klass.value = v.class ?? k.class ?? 'K';
  klass.addEventListener('change', keep('class'));
  const form = el(
    'form',
    { class: 'task-edit' },
    el(
      'fieldset',
      null,
      el('legend', { text: `Edit ${k.id}` }),
      el('div', { class: 'field' }, el('label', { for: 'edit-value', text: 'Value (1-10)' }), value),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'edit-content', text: 'Content minutes' }),
        content,
      ),
      el('div', { class: 'field' }, el('label', { for: 'edit-class', text: 'Class' }), klass),
      el(
        'div',
        { class: 'task-edit-buttons' },
        el('button', { type: 'submit', class: 'button button-filled', text: 'Save' }),
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: 'Close',
          onclick: () => closeTaskForm('Edit'),
        }),
      ),
    ),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    taskWrite(
      {
        type: 'edit',
        id: k.id,
        form: { value: value.value, content_min: content.value, class: klass.value },
      },
      `${k.id} is changed`,
    );
  });
  escapeCloses(form, 'Edit');
  return form;
}
/** The confirm step for "Cancel task" and "Decline": an optional one-line reason, then yes or keep. */
function cancelForm(k, f) {
  const declined = f.mode === 'decline';
  const opener = declined ? 'Decline' : 'Cancel task';
  const reason = el('input', {
    id: 'cancel-reason',
    type: 'text',
    maxlength: '300',
    autocomplete: 'off',
    value: f.values.reason ?? '',
  });
  reason.addEventListener('input', (e) => (f.values.reason = e.target.value));
  const form = el(
    'form',
    { class: 'task-edit' },
    el(
      'fieldset',
      null,
      el('legend', { text: declined ? `Decline the proposal ${k.id}?` : `Cancel ${k.id}?` }),
      el('p', {
        class: 'task-edit-text',
        text:
          (declined
            ? 'The proposal is cancelled and never started. '
            : 'The task is cancelled and never started. ') +
          'The reason is saved as a remark. "Undo" is ready for 30 seconds afterwards.',
      }),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'cancel-reason', text: 'Reason (optional, one line)' }),
        reason,
      ),
      el(
        'div',
        { class: 'task-edit-buttons' },
        el('button', {
          type: 'submit',
          class: 'button button-fare',
          text: declined ? 'Yes, decline' : 'Yes, cancel the task',
        }),
        el('button', {
          type: 'button',
          class: 'button button-outline',
          text: declined ? 'Keep the proposal' : 'Keep the task',
          onclick: () => closeTaskForm(opener),
        }),
      ),
    ),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    taskWrite(
      { type: f.mode, id: k.id, reason: reason.value.trim() || undefined },
      declined ? `The proposal ${k.id} is declined` : `${k.id} is cancelled`,
    );
  });
  escapeCloses(form, opener);
  return form;
}
/** Sends a cancel, decline or edit and offers "Undo" for exactly that change (the changelog no. in the answer). */
async function taskWrite(body, ok) {
  const release = busyButton(lastButton);
  lastButton = null;
  try {
    const answer = await api('/api/task-edit', body);
    t.taskForm = null;
    t.details.delete(body.id);
    if (answer?.log) undoToast(answer.log, ok);
    else message(ok);
  } catch (e) {
    message(e.message, true);
  }
  release();
  await update(true);
  if (t.selected && t.perId.has(t.selected)) drawPanel(true);
}

/**
 * The buttons in the detail panel for multi-select ("Select chain", "Select feature", select this card) and the
 * most common single actions (on hold, batch queue) for a card that can be bulk edited.
 */
function markButtons(k, col) {
  const parts = [];
  const chain = k.chain ? [k.id, ...k.chain.before, ...k.chain.after].filter(markable) : [];
  const feature = k.feature
    ? [...t.perId.values()]
        .filter(
          (x) =>
            MARKABLE_COLUMNS.has(x.col) &&
            x.k.project === k.project &&
            x.k.feature === k.feature,
        )
        .map((x) => x.k.id)
    : [];
  const can = MARKABLE_COLUMNS.has(col);
  if (can)
    parts.push(
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: t.marked.has(k.id) ? 'Remove from selection' : 'Select card',
        title: 'Add the card to the selection (or take it out). Shortcut: x on the card, Ctrl-click.',
        onclick: () => markMany([k.id], !t.marked.has(k.id)),
      }),
    );
  if (chain.length > 1)
    parts.push(
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: `Select chain (${chain.length})`,
        title:
          'Select the card, what it waits on, and what waits on it (only those waiting or proposed), ' +
          'so they can be moved or put on hold together.',
        onclick: () => markMany(chain, true),
      }),
    );
  if (feature.length > 1)
    parts.push(
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: `Select feature (${feature.length})`,
        title: `Select all in queue and batch queue in ${k.project} with feature "${k.feature}".`,
        onclick: () => markMany(feature, true),
      }),
    );
  if (can) {
    parts.push(
      k.parked
        ? el('button', {
            type: 'button',
            class: 'button button-muted',
            text: 'Take off hold',
            title: 'The task can be started and picked again. You see the change before it is saved.',
            onclick: () => openBulk('continue', [k.id]),
          })
        : el('button', {
            type: 'button',
            class: 'button button-muted',
            text: 'Put on hold',
            title:
              'The task stays in the queue, but is not started or picked until you take it off hold (or the date ' +
              'has passed). You see the change before it is saved.',
            onclick: () => openBulk('park', [k.id]),
          }),
      k.batched
        ? el('button', {
            type: 'button',
            class: 'button button-muted',
            text: 'Take out of batch queue',
            title: 'The task is started as its own track again. You see the change before it is saved.',
            onclick: () => openBulk('batch-out', [k.id]),
          })
        : el('button', {
            type: 'button',
            class: 'button button-muted',
            text: 'Add to batch queue',
            title:
              'Small tasks that do not block anything are packed together into a track of the right size instead of being ' +
              'started alone. You see the change before it is saved.',
            onclick: () => openBulk('batch-in', [k.id]),
          }),
    );
  }
  if (!parts.length) return null;
  return el('div', { class: 'mark-actions', 'aria-label': 'Select and combine' }, parts);
}

// ---- Simple markdown (headings, lists, code blocks, tables as code, **bold** and `code`) ----
function inline(text) {
  const out = [];
  for (const chunk of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
    if (!chunk) continue;
    if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 1)
      out.push(el('code', { text: chunk.slice(1, -1) }));
    else if (chunk.startsWith('**') && chunk.endsWith('**') && chunk.length > 4)
      out.push(el('strong', { text: chunk.slice(2, -2) }));
    else out.push(chunk.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
  }
  return out;
}
function markdown(text) {
  const root = document.createDocumentFragment();
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let paragraph = [];
  let listEl = null;
  const emptyParagraph = () => {
    if (paragraph.length) root.append(el('p', null, inline(paragraph.join(' '))));
    paragraph = [];
  };
  const closeList = () => {
    listEl = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      emptyParagraph();
      closeList();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      root.append(el('pre', null, el('code', { text: code.join('\n') })));
      continue;
    }
    if (/^\s*\|/.test(l)) {
      emptyParagraph();
      closeList();
      const rows = [l];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(lines[++i]);
      root.append(el('pre', null, el('code', { text: rows.join('\n') })));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      emptyParagraph();
      closeList();
      root.append(el(h[1].length <= 2 ? 'h3' : 'h4', null, inline(h[2])));
      continue;
    }
    const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      emptyParagraph();
      const number = /^\s*\d/.test(l);
      if (!listEl || listEl.tagName !== (number ? 'OL' : 'UL')) {
        listEl = el(number ? 'ol' : 'ul');
        root.append(listEl);
      }
      listEl.append(el('li', null, inline(li[1])));
      continue;
    }
    if (!l.trim()) {
      emptyParagraph();
      closeList();
      continue;
    }
    // Continuation of a list item (indented line right after).
    if (listEl && /^\s+\S/.test(l)) {
      listEl.lastElementChild.append(' ', ...inline(l.trim()));
      continue;
    }
    closeList();
    paragraph.push(l.trim());
  }
  emptyParagraph();
  return root;
}
