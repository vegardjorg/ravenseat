// =============================================================
// question.js: THE renderer for owner questions and the answer buttons (board step B24).
//
// One owner question used to look and read differently in four places. Now every surface draws it from here, with the
// words from the one word table (lib/queueDecisions.js QUESTION_WORDS) and the item from QueueDecisions.questionItem:
//   - the Decisions room (board/decide.js): the full card, and the answer buttons on every other card too,
//   - Plans > Decisions (plans/legal.js): the recommendation, why it is asked, the same buttons and text field,
//   - the Plans overview (plans/overview.js): one compact row per question.
// So the type names, the order of the choices (as written: the number on a button is the --choice number), the
// recommended one ("As recommended", filled) and the button words are the same wherever the owner answers.
//
// The card reads like a question in a chat (B15): the question, the recommendation as its own block, why it is asked
// and one muted line (what it unlocks, what waits, the source), then the answers.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and share
// the page's global scope; the Plans scripts (IIFEs, loaded later) use window.QueueQuestion.
// =============================================================
'use strict';

const QD = () => window.QueueDecisions ?? null;

/** The words for answering with the recommendation (QueueDecisions.AS_RECOMMENDED). */
const AS_RECOMMENDED = 'As recommended';

/** What a screen reader says for a recommended answer: what is answered, not only "recommended". */
const asRecommendedLabel = (sp, what) => `Answer ${sp} as recommended: ${what}`;

/** The text on a recommended choice: "As recommended: Vendor B" (no "(recommended)" suffix). */
const asRecommendedChoice = (label) => `${AS_RECOMMENDED}: ${label}`;

/** The recommendation as its own block on the tone-info surface, with a label (null without a recommendation). */
function recommendationBlock(text) {
  if (!text) return null;
  return el(
    'div',
    { class: 'sp-recommendation' },
    el('p', { class: 'sp-recommendation-label', text: 'Recommendation' }),
    el('p', { class: 'sp-recommendation-text', text }),
  );
}

/**
 * The source of a question as a link when the board knows it: a task opens its panel, a plan entry opens it in Plans.
 * Anything else (a file path, a note) stays text; the board never opens a web address from queue data.
 */
function sourceLink(source) {
  if (t.perId?.has(source))
    return el('button', { type: 'button', class: 'link-button', text: source, onclick: () => openPanel(source) });
  if (window.QueuePlans?.title?.(source))
    return el('button', {
      type: 'button',
      class: 'link-button',
      text: source,
      title: 'Open the plan entry',
      onclick: () => window.QueuePlans.openEntry(source),
    });
  return el('span', { text: source });
}

/**
 * The context under the recommendation: why it is asked, then one muted line with what the answer unlocks, the waiting
 * tasks (links) and the source. Null when there is nothing to say.
 */
function questionContext({ background, unlocks, waiting, source }) {
  const parts = [];
  if (unlocks) parts.push(el('span', { text: unlocks }));
  if (waiting?.length)
    parts.push(
      el(
        'span',
        null,
        'Waiting: ',
        waiting.map((id) =>
          t.perId?.has(id)
            ? el('button', { type: 'button', class: 'link-button', text: id, onclick: () => openPanel(id) })
            : el('span', { text: `${id} ` }),
        ),
      ),
    );
  if (source) parts.push(el('span', null, 'Source: ', sourceLink(source)));
  const line = parts.flatMap((x, i) => (i ? [el('span', { 'aria-hidden': 'true', text: ' · ' }), x] : [x]));
  if (!background && !line.length) return null;
  return el(
    'div',
    { class: 'sp-context' },
    background ? el('p', { class: 'sp-why', text: background }) : null,
    line.length ? el('p', { class: 'sp-meta' }, line) : null,
  );
}

/**
 * The text and the screen reader name of an option. On an owner question the recommended answer says "As recommended"
 * ("As recommended: Vendor B" for a choice) and its name says what is answered ("Answer Q-SSO as recommended: ...");
 * the other verbs keep "(recommended)" after the label (QA ok, Approve).
 */
function optionWords(item, o) {
  if (!o.recommended) return { text: o.label, name: item.verb === 'decide' ? `Answer ${item.id}: ${o.label}` : o.label };
  if (item.verb !== 'decide') return { text: `${o.label} (recommended)`, name: `${o.label} (recommended)` };
  const asIs = o.label === AS_RECOMMENDED;
  return {
    text: asIs ? AS_RECOMMENDED : asRecommendedChoice(o.label),
    name: asRecommendedLabel(item.id, asIs ? (item.recommendation ?? o.label) : o.label),
  };
}

/**
 * The type badge and the id: the same name on every surface (QUESTION_WORDS). An owner question with a category also
 * shows the category's title (an old post has none and looks as before); a track question left as free text gets the
 * mark "Not filled in by the agent" (section 6.2 of plans/autonomi-nivaa-utredning.md).
 */
function questionHead(item) {
  return el(
    'div',
    { class: 'decide-card-head' },
    el('span', {
      class: `badge sp-type${item.verb === 'decide' ? ` sp-${item.kind}` : ''}`,
      text: item.kindName,
    }),
    item.verb === 'decide' && item.categoryTitle
      ? el('span', { class: 'badge sp-category', title: 'Category', text: item.categoryTitle })
      : null,
    item.notFilled
      ? el('span', { class: 'badge sp-not-filled', text: QD()?.NOT_FILLED ?? 'Not filled in by the agent' })
      : null,
    // A delivery with a one-way door (MS-1): the badge in words on the warn pair, never only a colour.
    item.danger?.badge ? el('span', { class: 'badge tone-warn sp-one-way', text: item.danger.badge }) : null,
    el('span', { class: 'sp-id', text: item.id }),
  );
}

/**
 * What follows from the answer (section 6.1): "If you follow the recommendation" and "If you choose something else",
 * from the question's if_yes and if_no, or from code on a machine card (an approval, a QA check). Null without them.
 */
function consequenceBlock(item) {
  if (!item.ifYes && !item.ifNo) return null;
  const row = (label, text) =>
    text ? [el('dt', { class: 'sp-if-label', text: label }), el('dd', { class: 'sp-if-text', text })] : [];
  return el(
    'dl',
    { class: 'sp-if' },
    row(QD()?.IF_YES_LABEL ?? 'If you follow the recommendation', item.ifYes),
    row(QD()?.IF_NO_LABEL ?? 'If you choose something else', item.ifNo),
  );
}

/**
 * The question's own blocks in the fixed order: the question (unless `title: false`, where the surface has its own
 * heading), the recommendation, what follows from following it or not, why it is asked, and (with `meta`) the muted
 * line: what it unlocks, what waits, the source.
 */
function questionBody(item, { title = true, meta = true } = {}) {
  return [
    title
      ? el('p', { class: `decide-title sp-ask${item.text === null ? ' missing' : ''}`, text: item.title })
      : null,
    recommendationBlock(item.recommendation),
    consequenceBlock(item),
    questionContext({
      background: item.background,
      unlocks: meta ? (QD()?.impactLine(item) ?? null) : null,
      waiting: meta ? item.waiting : null,
      source: meta ? item.source : null,
    }),
  ];
}

/**
 * The answer buttons of a decision: each option (the recommended one filled), then the free text answer ("Other
 * decision", or the type's verb such as "Mark done"). `keys`: show the number (1-4) on each option and name the key,
 * as the Decisions room does (the number is the option's place, which for a question's choice is its --choice number).
 * `extra`: more buttons after these (the Decisions room adds "Open <task>").
 */
function answerButtons(item, { keys = false, onOption, onFree, extra = [], focus = item.key } = {}) {
  const buttons = item.options.map((o, i) => {
    const words = optionWords(item, o);
    return el(
      'button',
      {
        type: 'button',
        class: `button ${o.recommended ? 'button-filled' : 'button-outline'}`,
        'data-focus': `decide:${focus}:${i}`,
        'aria-keyshortcuts': keys ? (o.recommended ? `Enter ${i + 1}` : String(i + 1)) : null,
        title: keys ? (o.recommended ? `The recommendation (key: Enter or ${i + 1})` : `Key: ${i + 1}`) : null,
        // The name a screen reader gives: what the button does. Some read the title above instead of the text.
        'aria-label': words.name,
        onclick: () => onOption?.(i),
      },
      keys ? el('span', { class: 'decide-key', 'aria-hidden': 'true', text: String(i + 1) }) : null,
      words.text,
    );
  });
  const free = item.free
    ? el('button', {
        type: 'button',
        // With options the text answer is the quiet one; alone it is the one thing to do.
        class: item.options.length ? 'link-button' : 'button button-filled',
        'data-focus': `decide:${focus}:free`,
        'aria-keyshortcuts': keys && !item.options.length ? 'Enter' : null,
        'aria-label': `${item.free.label}: ${item.id}`,
        text: item.free.label,
        onclick: () => onFree?.(),
      })
    : null;
  return el(
    'div',
    { class: 'decide-options', role: 'group', 'aria-label': `Answers for ${item.id}` },
    buttons,
    free,
    extra,
  );
}

/**
 * The text field for an answer: the free text answer (`option` null: labelled with the type's field, saved with its
 * verb), or an option that needs text (a QA deviation, a reason for declining). An optional text may stay empty; the
 * free answer of an owner task then sends "Done" (QueueDecisions.freeAnswer). `onSave(text)` gets the text to send
 * (null for an option left empty); `onError(message)` when required text is missing. Ctrl+Enter saves, Esc cancels.
 * `onOptionWithText(i, text)`: on a question with choices, the choices under the field send that choice with the text
 * as its note (what the old side panel did).
 */
function answerForm(
  item,
  { option = null, value = '', onInput, onSave, onOptionWithText, onCancel, onError, id = 'decide-text', busy = false } = {},
) {
  const label = option ? option.needsText : item.free.field;
  const optional = option ? !!option.optionalText : !!item.free.optional;
  const field = el('textarea', {
    id,
    rows: 3,
    maxlength: '4000',
    'data-focus': `decide:${item.key}:text`,
    oninput: (e) => onInput?.(e.target.value),
  });
  field.value = value ?? '';
  const save = () => {
    const text = option ? field.value.trim() : (QD()?.freeAnswer(item, field.value) ?? field.value.trim());
    if (!text && !optional) return onError?.(`${label.replace(/\?$/, '')}: write it first.`);
    onSave?.(text || null);
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
    }
  });
  // Start from the recommendation's text and change it (the answer is still saved with the button).
  const fromRecommendation =
    !option && item.verb === 'decide' && item.recommendation
      ? el('button', {
          type: 'button',
          class: 'button button-outline',
          text: QD()?.START_FROM_RECOMMENDATION ?? 'Start from the recommendation',
          onclick: () => {
            field.value = item.recommendation;
            onInput?.(field.value);
            field.focus();
          },
        })
      : null;
  // A question with choices: the text can also go along with a choice as its note (resolve --choice n --answer).
  const withNote =
    !option && onOptionWithText && item.options.some((o) => o.action?.choice != null)
      ? el(
          'div',
          { class: 'decide-options', role: 'group', 'aria-label': `Choose for ${item.id} with this note` },
          el('span', { class: 'decide-hint', text: 'Choose with this note:' }),
          item.options.map((o, i) =>
            o.action?.choice != null
              ? el('button', {
                  type: 'button',
                  class: 'button button-outline button-small',
                  'data-focus': `decide:${item.key}:note:${i}`,
                  'aria-label': `${optionWords(item, o).name}, with the note`,
                  text: optionWords(item, o).text,
                  disabled: busy,
                  onclick: () => onOptionWithText(i, field.value.trim() || null),
                })
              : null,
          ),
        )
      : null;
  return el(
    'div',
    { class: 'decide-form' },
    el('label', { for: id, text: label }),
    field,
    withNote,
    el(
      'div',
      { class: 'decide-form-buttons' },
      fromRecommendation,
      el('button', { type: 'button', class: 'button button-outline', text: 'Cancel', onclick: () => onCancel?.() }),
      el('button', {
        type: 'button',
        class: 'button button-filled',
        text: busy ? 'Saving …' : option ? option.label : item.free.save,
        disabled: busy,
        title: 'Ctrl+Enter',
        onclick: save,
      }),
    ),
  );
}

/**
 * One owner question as a compact row (the Plans overview): the type badge and id, the question, one line led by what
 * the answer unlocks, and one button with the type's verb that opens the full card. `meta`: more for the line.
 */
function questionRow(item, { meta = [], onOpen } = {}) {
  const words = QD()?.questionWords(item.kind) ?? { answer: 'Answer' };
  const text = item.title.length > 160 ? `${item.title.slice(0, 157)} …` : item.title;
  return el(
    'div',
    { class: 'question-row' },
    el(
      'div',
      { class: 'question-row-main' },
      questionHead(item),
      el('p', { class: `question-row-text${item.text === null ? ' missing' : ''}`, text, title: item.title }),
      el('p', { class: 'question-meta', text: [QD()?.impactLine(item), ...meta].filter(Boolean).join(' · ') }),
    ),
    el('button', {
      type: 'button',
      class: 'button button-outline button-small question-row-button',
      text: words.answer,
      'aria-label': `${words.answer} ${item.id}`,
      'data-focus': `answer:owner:${item.id}`,
      onclick: () => onOpen?.(),
    }),
  );
}

// The Plans scripts (plans/legal.js, plans/overview.js) draw owner questions through this.
window.QueueQuestion = {
  /** A Plans > Decisions row (queuePlan.ownerDecisions) as the decision item the Decisions room draws. */
  fromPlan: (row) => QD()?.fromPlanDecision(row) ?? null,
  head: questionHead,
  body: questionBody,
  consequences: consequenceBlock,
  answers: answerButtons,
  form: answerForm,
  compact: questionRow,
};
