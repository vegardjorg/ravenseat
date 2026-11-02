// =============================================================
// inbox.js: "Waiting on you": what is waiting on the owner (owner questions, QA, proposed and what is
// stuck), in the side panel.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- "Waiting on you": what is waiting on the owner, in the side panel ----
const inboxButton = $('inbox');
const QUESTION_TYPE = {
  question: { name: 'Question', button: 'Answer', field: 'Your answer' },
  condition: {
    name: 'Waiting on condition',
    button: 'Mark fulfilled',
    field: 'How is the condition fulfilled?',
  },
  lawyer: {
    name: 'Waiting on lawyer',
    button: 'Mark fulfilled',
    field: 'What did the lawyer say, and what does it mean?',
  },
  'owner-task': { name: 'Owner task', button: 'Answer', field: 'What is completed?' },
};
const spType = (type) => QUESTION_TYPE[type] ?? QUESTION_TYPE.question;

/** The counter on the button at the top: everything waiting on the owner (question, QA, proposed, what is stuck). */
function drawInboxButton() {
  const n = t.data?.inbox?.count ?? 0;
  inboxButton.replaceChildren(
    'Waiting on you',
    ...(n ? [el('span', { class: 'inbox-count', text: String(n) })] : []),
  );
  inboxButton.setAttribute('aria-label', n ? `Waiting on you: ${n}` : 'Waiting on you: nothing');
  inboxButton.classList.toggle('active', n > 0);
  inboxButton.setAttribute('aria-expanded', t.inbox ? 'true' : 'false');
}

/**
 * Whether answers given here are picked up now: `cq wait` runs in the orchestrator session and its heartbeat is fresh
 * (state.listening, lib/ownerWait.js). Only shown when something waits on the owner.
 */
function listeningLine(count) {
  if (!count) return null;
  const on = t.data?.listening === true;
  return el(
    'p',
    { class: `inbox-listening${on ? ' on' : ''}` },
    el('span', { class: 'inbox-listening-dot', 'aria-hidden': 'true' }),
    el('span', {
      text: on ? 'Orchestrator listening' : 'Answers are picked up the next time the orchestrator runs',
    }),
  );
}

function openInbox() {
  t.selected = null;
  t.setting = null;
  t.fromInbox = false;
  t.inbox = true;
  showPanel();
  panel.scrollTop = 0;
  drawInbox(true);
  drawInboxButton();
  panel.querySelector('.button-icon')?.focus();
}
inboxButton.addEventListener('click', () => (t.inbox ? closePanel() : openInbox()));

/** A part of the inbox: title with count, content, and (optional) an action for the checked ones. */
function inboxPart(name, title, count, content, footer) {
  return el(
    'section',
    { class: 'inbox-del', 'aria-labelledby': `inbox-${name}` },
    el('h3', { id: `inbox-${name}`, class: 'setting-title' }, `${title} (${count})`),
    content,
    footer ?? null,
  );
}

/** Check off (QA, proposed): the selected set survives a redraw; focus follows data-focus. */
function checkOff(set, id, label) {
  return el('input', {
    type: 'checkbox',
    'data-focus': `option:${id}`,
    'aria-label': label,
    checked: set.has(id),
    onchange: (e) => {
      if (e.target.checked) set.add(id);
      else set.delete(id);
      drawInbox(true); // an action from the owner: redraw even if an answer field has focus
    },
  });
}

/**
 * The question's answer options as buttons (only when it has `choices`). One click answers the question with that choice
 * through the same POST /api/action { type: 'resolve' } as the free text answer, with { choice: <n> } (1-based); the server
 * looks up the text and runs queue.mjs resolve --choice. `note` gives the free text field, when it is open: its text is
 * stored as a note after the choice. The recommended choice (equal to the recommendation) is the filled button.
 */
function choiceButtons(s, i, note) {
  if (!s.choices?.length) return null;
  const pick = async (n) => {
    const text = note ? note().trim() : '';
    const body = { type: 'resolve', sp: s.sp, choice: n, ...(text ? { answer: text } : {}) };
    const completed = await action(body, `${s.sp}: resolved (${s.choices[n - 1].label})`);
    if (completed) {
      t.answerOpen = null;
      t.answerDraft.delete(s.sp);
      drawInbox(true);
    }
  };
  return el(
    'div',
    { class: 'answer-choices', role: 'group', 'aria-label': `Choices for ${s.sp}` },
    s.choices.map((c, j) =>
      el('button', {
        type: 'button',
        class: `button ${c.recommended ? 'button-filled' : 'button-outline'}`,
        'data-focus': `choice:${i}:${j}`,
        text: c.recommended ? `${c.label} (recommended)` : c.label,
        title: note
          ? `Answer ${s.sp} with "${c.label}", with the text in the field as a note`
          : `Answer ${s.sp} with "${c.label}"`,
        onclick: () => pick(j + 1),
      }),
    ),
  );
}

function questionRow(s, i) {
  const type = spType(s.type);
  const open = t.answerOpen === s.sp;
  const row = el(
    'li',
    { class: 'inbox-row' },
    el(
      'div',
      { class: 'row-header' },
      el('span', { class: `badge sp-type sp-${s.type}`, text: type.name }),
      el('span', { class: 'sp-id', text: s.sp }),
      el('span', {
        class: 'sp-locks',
        text: s.count
          ? `unlocks ${s.count} ${s.count === 1 ? 'task' : 'tasks'} · ${duration(s.minutes)}`
          : 'no task waiting',
      }),
      // What the answer unlocks in focus (the sort basis when focus is set).
      s.focus
        ? el('span', {
            class: `badge sp-focus${s.focus.count ? '' : ' empty-focus'}`,
            text: s.focus.count
              ? `in focus: unlocks ${s.focus.count} (${duration(s.focus.minutes)})`
              : 'nothing in focus',
            title: s.focus.count
              ? 'Tasks in the focus steps waiting on this answer, directly or via the chain. ' +
                s.focus.per_step
                  .map((m, j) => (m ? `T${j + 1}: ${duration(m)}` : null))
                  .filter(Boolean)
                  .join(', ')
              : 'The answer does not unlock anything in the focus steps now. It is therefore sorted after those that do.',
          })
        : null,
    ),
    el('p', {
      class: s.text ? 'sp-text' : 'sp-text missing',
      text: s.text ?? 'No text registered yet (cq question <id> --text …).',
    }),
    s.recommendation ? el('p', { class: 'sp-meta', text: `Recommendation: ${s.recommendation}` }) : null,
    s.source ? el('p', { class: 'sp-meta', text: `Source: ${s.source}` }) : null,
    s.direct.length
      ? el(
          'p',
          { class: 'sp-meta' },
          'Waiting: ',
          s.direct.map((id) =>
            el('button', {
              type: 'button',
              class: 'link-button',
              text: id,
              onclick: () => openPanel(id, { fromInbox: true }),
            }),
          ),
        )
      : null,
  );
  if (!open) {
    row.append(
      ...[choiceButtons(s, i, null)].filter(Boolean),
      el('button', {
        type: 'button',
        class: 'button button-muted',
        'data-focus': `answer:${i}`,
        // With choices the button opens the free text answer (a note or an answer that is not one of the choices).
        text: s.choices?.length ? 'Answer in your own words' : type.button,
        'aria-label': `${type.button}: ${s.sp}`,
        onclick: () => {
          t.answerOpen = s.sp;
          drawInbox(true);
          panel.querySelector(`#answer-${i}`)?.focus();
        },
      }),
    );
    return row;
  }
  const field = el('textarea', {
    id: `answer-${i}`,
    rows: 3,
    'data-focus': `answerText:${i}`,
    oninput: (e) => t.answerDraft.set(s.sp, e.target.value),
  });
  field.value = t.answerDraft.get(s.sp) ?? '';
  const save = async () => {
    const answer = field.value.trim();
    // Guard rule 15: an empty answer stops (the server checks the same).
    if (!answer) return message(`${type.field.replace(/\?$/, '')}: write the answer first.`, true);
    const completed = await action({ type: 'resolve', sp: s.sp, answer }, `${s.sp}: resolved`);
    if (completed) {
      t.answerOpen = null;
      t.answerDraft.delete(s.sp);
      drawInbox(true);
    }
  };
  row.append(
    el(
      'div',
      { class: 'actions answer-form' },
      el('div', { class: 'field' }, el('label', { for: `answer-${i}`, text: type.field }), field),
      choiceButtons(s, i, () => field.value),
      s.recommendation
        ? el('button', {
            type: 'button',
            class: 'button button-outline',
            text: 'Use the recommendation',
            onclick: () => {
              field.value = s.recommendation;
              t.answerDraft.set(s.sp, field.value);
              field.focus();
            },
          })
        : null,
      el('button', {
        type: 'button',
        class: 'button button-outline',
        text: 'Cancel',
        onclick: () => {
          t.answerOpen = null;
          drawInbox(true);
        },
      }),
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: s.type === 'condition' || s.type === 'lawyer' ? 'Mark fulfilled' : 'Save answer',
        onclick: save,
      }),
    ),
  );
  return row;
}

/**
 * "Sort" in "Waiting on you": tasks without a project, with an uncertain proposal, or where the project conflicts
 * with the files and the plan. Rows with a proposal can be accepted one by one or combined (the bulk action accept-suggestion, with
 * preview). Not counted in the number on the button: it is cleanup, not something that stops the queue.
 */
function sortPart(rows) {
  const ids = new Set(rows.map((r) => r.id));
  for (const id of [...t.selectedSort]) if (!ids.has(id)) t.selectedSort.delete(id);
  const withSuggestion = rows.filter((r) => r.proposed && markable(r.id));
  const chosen = [...t.selectedSort].filter((id) => withSuggestion.some((r) => r.id === id));
  const TYPE = {
    disagree: [
      'conflicts',
      'The current project conflicts with a strong signal (files, plan or prefix).',
    ],
    move: ['without project', 'Without a project today, with a confident proposal.'],
    sort: ['uncertain', 'Without a project or with an uncertain proposal: pick the project yourself.'],
  };
  const row = (r) =>
    el(
      'li',
      { class: 'inbox-row sort-row' },
      el(
        'div',
        { class: 'row-header' },
        r.proposed && markable(r.id)
          ? checkOff(t.selectedSort, r.id, `Select ${r.id} for "Accept all proposals for selected"`)
          : null,
        el('button', {
          type: 'button',
          class: 'link-button',
          text: r.id,
          title: 'Open task',
          onclick: () => openPanel(r.id, { fromInbox: true }),
        }),
        el('span', {
          class: 'badge',
          text: TYPE[r.type]?.[0] ?? r.type,
          title: TYPE[r.type]?.[1] ?? null,
        }),
      ),
      el('p', { class: 'sp-text', text: r.title ?? '' }),
      el('p', {
        class: 'sp-meta',
        text:
          `Now: ${r.now}` +
          (r.proposed ? ` · proposed: ${r.proposed}` : ' · no proposal') +
          (r.reason ? ` · ${r.reason}` : ''),
      }),
      r.proposed && markable(r.id)
        ? el('button', {
            type: 'button',
            class: 'button button-muted button-small',
            text: 'Accept proposal',
            title: `Move ${r.id} to the project ${r.proposed}. You see the change before it is saved.`,
            onclick: () => openBulk('accept-suggestion', [r.id]),
          })
        : null,
    );
  return inboxPart(
    'sort',
    'Sort',
    rows.length,
    [
      el('p', {
        class: 'inbox-info',
        text:
          'Cleanup, not something that stops the queue: the project decides the area and the focus step a task ends up in.',
      }),
      el('ol', { class: 'inbox-list' }, rows.map(row)),
    ],
    withSuggestion.length
      ? el(
          'div',
          { class: 'actions' },
          el('button', {
            type: 'button',
            class: 'link-button',
            'data-focus': 'sort-all',
            text: chosen.length === withSuggestion.length ? 'Select none' : 'Select all with proposal',
            onclick: () => {
              if (chosen.length === withSuggestion.length) t.selectedSort.clear();
              else for (const r of withSuggestion) t.selectedSort.add(r.id);
              drawInbox(true);
            },
          }),
          el('button', {
            type: 'button',
            class: 'button button-muted',
            'data-focus': 'sort-accept',
            text: `Accept all proposals for selected (${chosen.length})`,
            disabled: !chosen.length,
            title:
              'Gives every selected task the project the queue proposes. You see the changes before they are saved.',
            onclick: () => openBulk('accept-suggestion', chosen),
          }),
        )
      : null,
  );
}

function drawInbox(fresh) {
  if (!t.inbox) return;
  // Do not redraw while the owner writes an answer (the text field would lose the cursor).
  if (
    !fresh &&
    panel.contains(document.activeElement) &&
    document.activeElement.tagName === 'TEXTAREA'
  )
    return;
  const focus = panel.contains(document.activeElement)
    ? document.activeElement.dataset?.focus
    : null;
  const scroll = panel.scrollTop;
  const d = t.data?.inbox;
  const header = el(
    'div',
    { class: 'panel-header' },
    el('div', null, el('h2', { id: 'panel-title', text: 'Waiting on you' })),
    el(
      'button',
      { type: 'button', class: 'button-icon', 'aria-label': 'Close', onclick: closePanel },
      icon('close'),
    ),
  );
  if (!d) {
    panel.replaceChildren(header, el('p', { class: 'empty', text: 'Fetching the queue …' }));
    return;
  }
  // Checked items no longer waiting (approved, QA ok, gone) are removed from the selection.
  const qaIds = new Set(
    d.qa.flatMap((p) => p.features.flatMap((f) => f.tasks.map((o) => o.id))),
  );
  for (const id of [...t.selectedQa]) if (!qaIds.has(id)) t.selectedQa.delete(id);
  const suggestionIds = new Set(d.proposed.map((f) => f.id));
  for (const id of [...t.selectedSuggestion]) if (!suggestionIds.has(id)) t.selectedSuggestion.delete(id);
  if (t.answerOpen && !d.question.some((s) => s.sp === t.answerOpen)) t.answerOpen = null;

  const parts = [header, listeningLine(d.count)];
  if (!d.count)
    parts.push(
      el(
        'p',
        { class: 'inbox-empty' },
        icon('checkmark'),
        el('span', { text: 'Nothing waiting on you' }),
      ),
    );

  if (d.question.length)
    parts.push(
      inboxPart('question', 'Question', d.question.length, [
        d.focus_sorted
          ? el('p', {
              class: 'inbox-info',
              text:
                'Sorted by how much the answer unlocks in focus: stage 1 first, then the minutes. Questions that ' +
                'do not touch focus come last.',
            })
          : null,
        el('ol', { class: 'inbox-list' }, d.question.map(questionRow)),
      ]),
    );

  if (d.sort?.length) parts.push(sortPart(d.sort));

  if (d.qaCount) {
    const allSelected = qaIds.size > 0 && [...qaIds].every((id) => t.selectedQa.has(id));
    const n = t.selectedQa.size;
    parts.push(
      inboxPart(
        'qa',
        'QA',
        d.qaCount,
        [
          el('button', {
            type: 'button',
            class: 'link-button',
            'data-focus': 'qa-all',
            text: allSelected ? 'Select none' : 'Select all',
            onclick: () => {
              if (allSelected) t.selectedQa.clear();
              else for (const id of qaIds) t.selectedQa.add(id);
              drawInbox(true);
            },
          }),
          ...d.qa.map((p) =>
            el(
              'div',
              { class: 'qa-project' },
              el('h4', { class: 'qa-name', text: p.title ? `${p.title} (${p.pid})` : p.pid }),
              p.features.map((f) =>
                el(
                  'div',
                  { class: 'qa-feature' },
                  el('p', { class: 'qa-feature-name', text: f.feature }),
                  el(
                    'ul',
                    { class: 'inbox-list' },
                    f.tasks.map((o) =>
                      el(
                        'li',
                        { class: 'inbox-row row-summary' },
                        el(
                          'label',
                          { class: 'row-option' },
                          checkOff(t.selectedQa, o.id, `Select ${o.id} for QA ok`),
                          el('span', { class: 'sp-id', text: o.id }),
                          el('span', { class: 'row-title', text: o.title }),
                          o.done
                            ? el('span', {
                                class: 'sp-meta',
                                text: `done ${age(o.done)} ago`,
                              })
                            : null,
                        ),
                        el('button', {
                          type: 'button',
                          class: 'button button-outline',
                          text: 'Deviation',
                          'aria-label': `Report deviation on ${o.id}`,
                          onclick: () => {
                            openPanel(o.id, { fromInbox: true });
                            panel.querySelector('#qa-text')?.focus();
                          },
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
        el(
          'div',
          { class: 'inbox-footer' },
          el('button', {
            type: 'button',
            class: 'button button-filled',
            'data-focus': 'qa-ok',
            text: n ? `QA ok for selected (${n})` : 'QA ok for selected',
            disabled: n === 0,
            onclick: async () => {
              const ids = [...t.selectedQa];
              if (await action({ type: 'qa-ok', ids }, `QA ok: ${ids.join(', ')}`))
                t.selectedQa.clear();
              drawInbox(true);
            },
          }),
        ),
      ),
    );
  }

  if (d.proposed.length) {
    const n = t.selectedSuggestion.size;
    parts.push(
      inboxPart(
        'proposed',
        'Proposed',
        d.proposed.length,
        el(
          'ul',
          { class: 'inbox-list' },
          d.proposed.map((f) =>
            el(
              'li',
              { class: 'inbox-row row-summary' },
              el(
                'label',
                { class: 'row-option' },
                checkOff(t.selectedSuggestion, f.id, `Select ${f.id} for approval`),
                el('span', { class: 'sp-id', text: f.id }),
                el('span', { class: 'row-title', text: f.title }),
                el('span', {
                  class: 'sp-meta',
                  // Who proposed it, only when known (no "from ?").
                  text: `${f.class ?? '?'} · ${f.estimate} min · value ${f.value}${f.added_by ? ` · from ${f.added_by}` : ''}`,
                }),
              ),
              el('button', {
                type: 'button',
                class: 'button button-muted',
                text: 'Approve',
                'aria-label': `Approve ${f.id}`,
                onclick: async () => {
                  await action(
                    { type: 'approve', id: f.id },
                    `${f.id} is approved and waiting in the queue`,
                  );
                  drawInbox(true);
                },
              }),
              // "Decline" opens the task with the confirm step (an optional reason); "Undo" afterwards.
              el('button', {
                type: 'button',
                class: 'button button-outline',
                text: 'Decline',
                'aria-label': `Decline ${f.id}`,
                onclick: () => {
                  t.taskForm = { id: f.id, mode: 'decline', values: {} };
                  openPanel(f.id, { fromInbox: true });
                  panel.querySelector('#cancel-reason')?.focus();
                },
              }),
            ),
          ),
        ),
        el(
          'div',
          { class: 'inbox-footer' },
          el('button', {
            type: 'button',
            class: 'button button-filled',
            'data-focus': 'approve-selected',
            text: n ? `Approve selected (${n})` : 'Approve selected',
            disabled: n === 0,
            onclick: async () => {
              const ids = [...t.selectedSuggestion];
              if (await action({ type: 'approve', ids }, `Approved: ${ids.join(', ')}`))
                t.selectedSuggestion.clear();
              drawInbox(true);
            },
          }),
        ),
      ),
    );
  }

  if (d.stuck.length)
    parts.push(
      inboxPart(
        'stuck',
        'Stuck',
        d.stuck.length,
        el(
          'ul',
          { class: 'inbox-list' },
          d.stuck.map((h) =>
            el(
              'li',
              { class: 'inbox-row row-summary' },
              el(
                'div',
                { class: 'row-option' },
                el('span', { class: 'sp-id', text: h.id }),
                el('span', { class: 'row-title', text: h.title }),
                el('span', {
                  class: 'sp-meta',
                  text: h.aging
                    ? `${h.status === 'review' ? 'in review' : 'running'}, started ${duration(h.aging.age)} ago; ` +
                      `85 % of ${h.class ?? '?'} tasks are ${h.aging.measure === 'work' ? 'delivered' : 'finished'} within ${duration(h.aging.limit)}`
                    : `picked by ${h.picked_by ?? '?'} ${h.start ? age(h.start) : '?'} ago, without commits in the last 72 h`,
                }),
              ),
              el('button', {
                type: 'button',
                class: 'button button-outline',
                text: 'Open',
                'aria-label': `Open ${h.id}`,
                onclick: () => openPanel(h.id, { fromInbox: true }),
              }),
            ),
          ),
        ),
      ),
    );

  if (d.unlogged.length)
    parts.push(
      el('p', {
        class: 'inbox-info',
        text:
          `${d.unlogged.length} ${d.unlogged.length === 1 ? 'answer is' : 'answers are'} not entered in the decision log yet ` +
          `(${d.unlogged.map((x) => x.sp).join(', ')}). The orchestrator enters them (cq resolutions --unlogged).`,
      }),
    );

  panel.replaceChildren(...parts);
  panel.scrollTop = scroll;
  if (focus) panel.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
}
