// =============================================================
// queueDecisions.js: the decision overview, the one place where the owner meets the queue.
//
// "Waiting on you" (queueBoard.inbox) already knows what waits on the owner: owner questions, QA, proposed tasks and
// stuck work. This file turns that into ONE list of decisions, each with
//   - a verb (Decide, Check, Approve, Unstick) the board groups by,
//   - the impact (what the answer unlocks, in the focus stages first), which the list is sorted by,
//   - the options, each with the exact write it does (a question's choices in their written order, the recommended one
//     marked, so the number on a button is the --choice number): the `ravenseat` arguments (cliArgs, used by
//     `ravenseat decide` and the /ravenseat:decide skill) and the board's API call (boardCall, used by the Decisions view). Both run
//     the same queue.mjs command with the same --by, so the log and the actor are the same whichever surface is used.
// It also builds "Decided today" (decidedToday) from the queue's own timestamps.
//
// Pure: no I/O, no DOM. The file is both a CommonJS module (vitest, lib/__tests__/queueDecisions.test.ts, the board
// server and cli/decide.mjs) and a browser script (queue-board.mjs serves it as /queueDecisions.js, and it sets
// window.QueueDecisions), like queueGraph.js, so the board uses exactly the code the tests check.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueDecisions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The groups on the board, in this order, and what each one is. */
  const VERBS = [
    { verb: 'decide', title: 'Decide', hint: 'Owner questions: the answer lets the waiting tasks go on.' },
    { verb: 'check', title: 'Check', hint: 'Finished work that needs your eyes before it counts as done.' },
    { verb: 'approve', title: 'Approve', hint: 'Tasks an agent proposed. Nothing starts before you say yes.' },
    { verb: 'unstick', title: 'Unstick', hint: 'Work that has stopped, run long, or sits picked without commits.' },
  ];
  /** Tie break between verbs with the same impact: a question first, a check (unlocks nothing) last. */
  const VERB_ORDER = { decide: 0, unstick: 1, approve: 2, check: 3 };

  /**
   * The words for answering with the recommendation: the one-click option of a question without choices, and the mark
   * on a choice equal to the recommendation ("As recommended: Vendor B"), never a "(recommended)" suffix after it.
   */
  const AS_RECOMMENDED = 'As recommended';

  /** How long the board waits before it writes a one-click answer, so "Undo" can take it back without a revert. */
  const UNDO_MS = 5000;

  /** The note `ravenseat block` gets when the owner flags stuck work (the orchestrator sees it in pulse and blockers). */
  const FLAG_NOTE = 'owner: looks stuck, please check';

  /** The stops that wait on someone (a task in review with one of these open): what to call it and the next step. */
  const STOP_TEXT = {
    'merge-conflict': {
      name: 'Merge conflict',
      next: (id) => `Next: the orchestrator starts a fix round (ravenseat resume ${id} --reason fix).`,
    },
    'merge-guard': {
      name: 'Stopped by the merge guard',
      next: (id) =>
        `Next: read the diff of the protected paths. Not asked for: a fix round (ravenseat resume ${id} --reason fix). Intended: ravenseat merge ${id} --allow-guard.`,
    },
    'merge-stopped': {
      name: 'Merge stopped',
      next: (id) => `Next: fix the cause named above, then ravenseat merge ${id} again. Nothing was merged by this stop.`,
    },
    'track-question': {
      name: 'The track asks you',
      next: (id) =>
        `Next: answer it, and a new agent gets the answer (ravenseat resume ${id} --reason context --answer "<text>"), or ravenseat set ${id} cancelled. ` +
        `If it needs a file the task does not own: ravenseat edit ${id} --files <files> --by owner first. A finished delivery that needs no answer can be merged.`,
    },
    'gate-red': {
      name: 'Gates red',
      next: (id) => `Next: the orchestrator starts a fix round (ravenseat resume ${id} --reason fix), or ravenseat merge ${id} --resume once the cause is fixed.`,
    },
  };

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** "45 min", "2 h", "2 h 30 min" (the same shape as the board's duration()). */
  function minutesText(min) {
    const m = Math.max(0, Math.round(Number(min) || 0));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  }

  /** How long something has been open, in whole days: "opened today", "open for 1 day", "open for 5 days". */
  function daysOpenText(days) {
    const d = Math.max(0, Math.floor(Number(days) || 0));
    return d === 0 ? 'opened today' : `open for ${plural(d, 'day', 'days')}`;
  }

  /** How long ago, from minutes: "just now", "9 min ago", "2 h 5 min ago", "3 days ago" (from 48 h). */
  function agoText(min) {
    const m = Math.max(0, Math.round(Number(min) || 0));
    if (m < 1) return 'just now';
    if (m < 48 * 60) return `${minutesText(m)} ago`;
    return `${plural(Math.floor(m / (24 * 60)), 'day', 'days')} ago`;
  }

  /** The number keys in Decisions go to 4 (1 to 4 pick that option); the hint never names more than this. */
  const NUMBER_KEYS = 4;

  // ---- From "Waiting on you" to decisions ----------------------------------------------------------------------

  /**
   * THE word table for owner questions (board step B24): every surface that shows one (the Decisions room, Plans >
   * Decisions, the Plans overview, `ravenseat decide`) takes the type name and the button words from here, so the same
   * question reads the same everywhere. Per type (queueLogic.QUESTION_TYPES):
   *   name      the type badge
   *   answer    the verb on the button that answers in text (never a question: the question is the field's label)
   *   field     the label of the text field
   *   optional  the text may be empty; the answer is then `empty` (the server still needs a non-empty answer)
   */
  const QUESTION_WORDS = {
    question: { name: 'Question', answer: 'Answer', field: 'Your answer', optional: false, empty: null },
    condition: {
      name: 'Waiting on condition',
      answer: 'Mark fulfilled',
      field: 'How is the condition fulfilled?',
      optional: false,
      empty: null,
    },
    lawyer: {
      name: 'Waiting on lawyer',
      answer: 'Mark fulfilled',
      field: 'What did the lawyer say, and what does it mean?',
      optional: false,
      empty: null,
    },
    'owner-task': { name: 'Owner task', answer: 'Mark done', field: 'Note (optional)', optional: true, empty: 'Done' },
  };
  /** The free text answer on a plain question that has choices or a recommendation: something to differ from. */
  const OTHER_DECISION = 'Other decision';
  /** In the text field: start from the recommendation's text and change it. */
  const START_FROM_RECOMMENDATION = 'Start from the recommendation';
  /** The words for a question type (an unknown type reads as a plain question). */
  const questionWords = (type) => QUESTION_WORDS[type] ?? QUESTION_WORDS.question;

  // ---- The card fields (section 6.1 of plans/autonomi-nivaa-utredning.md) ---------------------------------------
  // One format for every choice, read by the board, `ravenseat decide` and /ravenseat:decide: category, context, and what
  // follows from the recommendation and from anything else. With 3-4 choices yes and no do not fit, so the card says
  // "if you follow the recommendation" and "if you choose something else".

  /** The titles of ask-catalog/categories.json (lib/askCatalog.js; a test keeps them equal, this file runs in the browser). */
  const CATEGORY_TITLES = Object.freeze({
    legal: 'Legal and privacy',
    security: 'Security and access',
    architecture: 'Big design choices',
    database: 'Database changes',
    dependency: 'New libraries',
    delete: 'Removing data or features',
    product: 'What a feature should do',
    followups: 'Follow-up tasks',
    ui: 'Small UI choices',
    technical: 'Small technical choices',
  });
  const IF_YES_LABEL = 'If you follow the recommendation';
  const IF_NO_LABEL = 'If you choose something else';
  /** The mark on a track question written as free text, without `ravenseat question` (section 6.2). */
  const NOT_FILLED = 'Not filled in by the agent';
  /** A known category key, or "uncategorized" (an old post: shown as today, without a badge). */
  const categoryKey = (key) => (Object.hasOwn(CATEGORY_TITLES, key ?? '') ? key : 'uncategorized');
  /** The card fields of an item: { category, categoryTitle, ifYes, ifNo }. */
  const cardFields = (category, ifYes, ifNo) => {
    const key = categoryKey(category);
    return { category: key, categoryTitle: CATEGORY_TITLES[key] ?? null, ifYes: ifYes || null, ifNo: ifNo || null };
  };

  /**
   * The answer the free text option sends: the trimmed text, or the type's `empty` answer when the text is optional and
   * left empty ("Mark done" without a note sends "Done"). An empty string means "write something first".
   */
  function freeAnswer(item, text) {
    const s = String(text ?? '').trim();
    if (s) return s;
    return item?.free?.optional ? (item.free.empty ?? '') : '';
  }

  /**
   * One list of decisions from the inbox (queueBoard.inbox: question, qa, proposed, stuck). Unsorted; see sortItems.
   * Each item: { key, verb, kind, id, title, text, context, recommendation, background, impact, options, free, open }.
   *   impact  { count, minutes, perStep: number[], focusCount, focusMinutes } (perStep = minutes per focus stage)
   *   options [{ label, recommended, action, needsText? }] (a question's choices in their written order; needsText = the label for the
   *           text the action needs, e.g. what is wrong in a QA deviation)
   *   free    { label, action } a free text answer (the action has answer: null until the text is given), or null
   *   open    the task to open for more (null for a question)
   */
  function fromInbox(inbox) {
    if (!inbox) return [];
    const out = [];
    for (const s of inbox.question ?? []) out.push(questionItem(s));
    // A delivery (a QA check, a task in review) carries the track's door and blast radius (MS-1), null before MS-1.
    for (const p of inbox.qa ?? [])
      for (const f of p.features ?? [])
        for (const o of f.tasks ?? []) out.push({ ...qaItem(o, p, f), danger: dangerView(o.merge_danger) });
    for (const f of inbox.proposed ?? []) out.push(proposedItem(f));
    for (const h of inbox.stuck ?? []) out.push({ ...stuckItem(h), danger: dangerView(h.merge_danger) });
    return out;
  }

  // ---- Door and blast radius (MS-1) --------------------------------------------------------------------------------
  // The track's two lines (lib/mergeDanger.js reads them at receive and stores merge_danger on the task) as the board,
  // `ravenseat decide` and "Decided for you" show them. Written by agents, so never a guard: a one-way door only raises
  // the card's visibility (a badge in words, first within its group). A reviewer who disagrees is shown, never resolved.

  /** The badge on a card with a one-way door. */
  const ONE_WAY_BADGE = 'One-way door: hard to undo';
  /** What a missing or malformed line reads as (lib/mergeDanger.js NOT_STATED). */
  const DANGER_NOT_STATED = 'not stated';

  /**
   * @returns {null | { door: string|null, blast: string|null, oneWay: boolean, badge: string|null, text: string,
   *   disagree: string[] }} null for a task without a record (received before MS-1, or a PARTIAL delivery).
   */
  function dangerView(md) {
    if (!md || typeof md !== 'object') return null;
    const door = md.door === 'one-way' || md.door === 'two-way' ? md.door : null;
    const blast = typeof md.blast === 'string' && md.blast ? md.blast : null;
    const words = { door: 'door', blast: 'blast radius' };
    const disagree = [];
    for (const r of Array.isArray(md.reviewers) ? md.reviewers : [])
      for (const field of ['door', 'blast']) {
        const said = r?.[field] ?? null;
        const own = field === 'door' ? door : blast;
        if (said && said !== own)
          disagree.push(`${r.type ?? 'a reviewer'} says ${words[field]} ${said} (the track says ${own ?? DANGER_NOT_STATED})`);
      }
    return {
      door,
      blast,
      oneWay: door === 'one-way',
      badge: door === 'one-way' ? ONE_WAY_BADGE : null,
      text: `Door: ${door ?? DANGER_NOT_STATED} · Blast radius: ${blast ?? DANGER_NOT_STATED}`,
      disagree,
    };
  }

  function questionItem(s) {
    const kind = questionWords(s.type);
    const focus = s.focus ?? null;
    const choices = Array.isArray(s.choices) ? s.choices : [];
    // The choices as options in the order they were written, so option n is `ravenseat resolve --choice n` and key n on
    // the board: one order on every surface (B24). The recommended one is marked, not moved.
    let options = choices.map((c, i) => ({
      label: c.label,
      recommended: !!c.recommended,
      action: { type: 'resolve', sp: s.sp, choice: i + 1 },
    }));
    // Without choices, a recommendation is still a one-click answer: "As recommended" sends its text.
    if (!options.length && s.recommendation)
      options = [
        {
          label: AS_RECOMMENDED,
          recommended: true,
          action: { type: 'resolve', sp: s.sp, answer: s.recommendation },
        },
      ];
    const waiting = Array.isArray(s.direct) ? s.direct : [];
    return {
      // catalog.captureAnswers suggest (roadmap 0z Z-A): the question reads like a lasting rule, so the board marks its
      // "Keep as design choice" button. Only a plain question; a condition, a lawyer's word or an owner task is no rule.
      keepSuggested: (s.type ?? 'question') === 'question' && s.keep_suggested === true,
      key: `decide:${s.sp}`,
      verb: 'decide',
      kind: s.type ?? 'question',
      kindName: kind.name,
      id: s.sp,
      title: s.text ?? `${s.sp} (no text registered yet)`,
      text: s.text ?? null,
      // The recommendation is not a context line: it has its own field (and its own block on the board).
      context: [
        s.source ? `Source: ${s.source}` : null,
        waiting.length ? `Waiting: ${waiting.join(', ')}` : null,
      ].filter(Boolean),
      recommendation: s.recommendation ?? null,
      // Why it is asked (the question's optional `context` field), or null.
      background: s.context ?? null,
      // The category and the two consequence lines (null on an old post).
      ...cardFields(s.category, s.if_yes, s.if_no),
      // The same two facts as the context lines, kept apart so the board can draw them as links.
      source: s.source ?? null,
      waiting,
      impact: {
        count: s.count ?? 0,
        minutes: s.minutes ?? 0,
        perStep: focus?.per_step ?? [],
        focusCount: focus?.count ?? 0,
        focusMinutes: focus?.minutes ?? 0,
        // "The focus ended" (lib/logic/focus.js syncFocusEnd, id focus-done-<n>): the whole queue waits on it.
        pausesQueue: String(s.sp).startsWith('focus-done-'),
      },
      options,
      // The text answer: "Other decision" on a plain question with something to differ from, otherwise the type's verb
      // ("Answer", "Mark fulfilled", "Mark done"). `field` labels the text field; `optional` lets it stay empty.
      free: {
        label: options.length && kind === QUESTION_WORDS.question ? OTHER_DECISION : kind.answer,
        field: kind.field,
        save: kind.answer,
        optional: kind.optional,
        empty: kind.empty,
        action: { type: 'resolve', sp: s.sp, answer: null },
      },
      open: null,
    };
  }

  /**
   * A row from Plans > Decisions (queuePlan.ownerDecisions) as the same decision item the Decisions room draws, so Plans
   * shows the same order, type name and buttons. The row has the queue's question fields plus what it blocks.
   */
  function fromPlanDecision(row) {
    if (!row) return null;
    return questionItem({
      sp: row.id,
      type: row.type,
      text: row.text,
      recommendation: row.recommendation,
      context: row.context,
      source: row.source,
      choices: row.choices,
      category: row.category,
      if_yes: row.if_yes,
      if_no: row.if_no,
      direct: row.tasks,
      count: (row.tasks ?? []).length,
      minutes: row.minutes,
    });
  }

  /**
   * The landing rule (B24): the board opens in Decisions only when a decision is new since the last visit (a key that
   * was not there when the owner last saw the room). `seen` is null on a first visit (or when the browser keeps no
   * storage): then anything waiting counts as new, as before. Otherwise the board opens the queue view used last.
   */
  function landInDecisions(keys, seen) {
    const now = keys ?? [];
    if (!now.length) return false;
    if (!Array.isArray(seen)) return true;
    const before = new Set(seen);
    return now.some((k) => !before.has(k));
  }

  function qaItem(o, p, f) {
    return {
      key: `check:${o.id}`,
      verb: 'check',
      kind: 'qa',
      kindName: 'QA',
      id: o.id,
      title: o.title || o.id,
      text: null,
      context: [`${p.title ? `${p.title} (${p.pid})` : p.pid} · ${f.feature}`],
      recommendation: 'QA ok',
      // A machine card: the two lines come from code (no category: QA is not a row of the catalog yet).
      ...cardFields(null, 'The task counts as done, and the card goes.', 'You write what is wrong, and a fix task is made from it.'),
      impact: { count: 0, minutes: 0, perStep: [], focusCount: 0, focusMinutes: 0 },
      options: [
        { label: 'QA ok', recommended: true, action: { type: 'qa-ok', id: o.id } },
        {
          label: 'Deviation',
          recommended: false,
          action: { type: 'qa-deviation', id: o.id, text: null },
          needsText: 'What is wrong, and where?',
        },
      ],
      free: null,
      open: o.id,
      done: o.done ?? null,
    };
  }

  /** The impact of a task card: its own minutes in its focus stage plus what waits on it (card.unlocks). */
  function taskImpact(own, x) {
    const unlocks = x.unlocks ?? null;
    const step = Number.isInteger(x.focus_step) ? x.focus_step : null;
    const perStep = [];
    if (step != null) {
      for (let i = 0; i < step; i += 1) perStep.push(0);
      perStep.push(own);
    }
    return {
      count: unlocks?.count ?? 0,
      minutes: unlocks?.minutes ?? 0,
      perStep,
      focusCount: step != null ? 1 : 0,
      focusMinutes: step != null ? own : 0,
    };
  }

  function proposedItem(f) {
    const estimate = Number(f.estimate) || 0;
    const approve = { label: 'Approve', recommended: !f.gate_without_place, action: { type: 'approve', id: f.id } };
    const decline = {
      label: 'Decline',
      recommended: !!f.gate_without_place,
      action: { type: 'decline', id: f.id, reason: null },
      needsText: 'Why (optional)?',
      optionalText: true,
    };
    return {
      key: `approve:${f.id}`,
      verb: 'approve',
      kind: 'proposed',
      kindName: 'Proposed',
      batched: f.batched === true,
      id: f.id,
      title: f.title || f.id,
      text: null,
      context: [
        `${f.class ?? '?'} · ${estimate} min · value ${f.value ?? '?'}${f.added_by ? ` · from ${f.added_by}` : ''}${f.batched === true ? ' · [batch queue]' : ''}`,
        ...(f.gate_without_place
          ? ['No file and line behind it, and the gate needs a failing example: approving means agent work on a guess. Approve if you know the bug is real.']
          : []),
      ],
      recommendation: f.gate_without_place ? 'Decline' : 'Approve',
      // A machine card (section 6.1): yes is the agent work, no is nothing. The lines follow the recommendation, so on a
      // guess (Decline recommended) "if you follow it" is the nothing.
      ...((work, nothing) => cardFields('followups', ...(f.gate_without_place ? [nothing, `${work}, on a guess.`] : [`${work}.`, nothing])))(
        `About ${minutesText(estimate)} of agent work`,
        'Nothing changes, and it stays declined.',
      ),
      impact: { ...taskImpact(estimate, f), own: estimate },
      options: f.gate_without_place ? [decline, approve] : [approve, decline],
      free: null,
      open: f.id,
    };
  }

  /** A stop in the merge or the gates. "Seen" writes nothing: the card goes when the blocker closes. */
  function stopItem(h) {
    const stop = STOP_TEXT[h.stop.code];
    const asks = h.stop.code === 'track-question';
    // Section 6.2: receive compared ownerQuestions=<n> with the questions the track registered. Free text left over is
    // marked, and the registered ones are named (they are their own cards under Decide).
    const unfilled = asks && Number(h.stop.unfilled) > 0;
    const registered = asks && Array.isArray(h.stop.registered) ? h.stop.registered : [];
    const asked = [
      unfilled
        ? `${NOT_FILLED}: the track wrote ${h.stop.unfilled === 1 ? 'this question' : `${h.stop.unfilled} questions`} as free text instead of registering ${h.stop.unfilled === 1 ? 'it' : 'them'} with ravenseat question, so there is no category, context or consequence.`
        : null,
      registered.length ? `Registered as questions: ${registered.join(', ')} (under Decide).` : null,
    ];
    const options = [
      ...(asks
        ? [{ label: 'Answer, and prepare a new round', recommended: true, needsText: 'Your answer to the track', action: { type: 'track-answer', id: h.id, text: null } }]
        : []),
      { label: 'Seen', recommended: !asks, action: { type: 'keep', id: h.id } },
    ];
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      ...(asks ? { heading: 'ANSWER' } : {}),
      kind: 'stopped',
      kindName: stop.name,
      notFilled: unfilled,
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [h.stop.note, ...asked, h.stop.file ? `The whole text: ${h.stop.file}` : null, stop.next(h.id)].filter(Boolean),
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  /** Marked running, and no agent ever started: only a new start helps, so flagging it is the wrong advice. */
  function noAgentItem(h) {
    const options = [
      { label: 'Put it back in the queue', recommended: true, action: { type: 'requeue', id: h.id } },
      { label: 'Leave it running', recommended: false, action: { type: 'keep', id: h.id } },
    ];
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      heading: 'NO AGENT',
      kind: 'stuck-no-agent',
      kindName: 'Started without an agent',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [
        'Marked running, but no worktree has its branch and there is no report: the agent was never started.',
        `Back in the queue, the next fill starts it (ravenseat fill --ids ${h.id}).`,
      ],
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  /** A round was prepared and no agent took it: only the orchestrator can start one, so there is nothing to choose here. */
  function noAgentRoundItem(h) {
    const options = [{ label: 'Seen', recommended: true, action: { type: 'keep', id: h.id } }];
    const { round, reason } = h.no_agent_round;
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      heading: 'NO AGENT',
      kind: 'stuck-no-agent',
      kindName: 'Round without an agent',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [
        `Round ${round} was prepared, but no agent has started it, and the task holds its slot.`,
        `The orchestrator starts it: ravenseat resume ${h.id} --reason ${reason}, then the agent line it prints. If no session is open, open one and run /ravenseat:queue.`,
      ],
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  /** Busy without real work for so long (lib/trackSpin.js): the same choices as SILENT, nothing was stopped. */
  function spinningItem(h) {
    const options = [
      { label: 'Seen', recommended: true, action: { type: 'keep', id: h.id } },
      { label: 'Put it back in the queue', recommended: false, action: { type: 'requeue', id: h.id } },
    ];
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      heading: 'SPINNING',
      kind: 'stuck-spinning',
      kindName: 'Spinning',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [
        `Busy, but no write, command or commit for ${minutesText(h.long_spinning.minutes)}: ${h.long_spinning.calls} call(s) of bookkeeping, waiting or repeated reads. Nothing was stopped.`,
        `The orchestrator checks it: ravenseat explain ${h.id}, and if it is stuck ravenseat resume ${h.id} --reason context.`,
      ],
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  /** Silent for so long that it is no longer a short stop. */
  function silentItem(h) {
    const options = [
      { label: 'Seen', recommended: true, action: { type: 'keep', id: h.id } },
      { label: 'Put it back in the queue', recommended: false, action: { type: 'requeue', id: h.id } },
    ];
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      heading: 'SILENT',
      kind: 'stuck-silent',
      kindName: 'Silent',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [
        `No commit, file change or transcript write for ${minutesText(h.long_silent)}: the agent may have hung or run out of context.`,
        `The orchestrator checks it: ravenseat resume ${h.id} --reason context, then the agent line it prints.`,
      ],
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  /** "14:05" in local time, or null for a time that cannot be read. */
  function clockText(iso) {
    const d = new Date(iso ?? '');
    if (!Number.isFinite(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** The track stands still on a permission prompt (lib/approvalWait.js): only the owner can answer it. */
  function approvalItem(h) {
    const options = [{ label: 'Seen', recommended: true, action: { type: 'keep', id: h.id } }];
    const { tool, since } = h.awaiting_approval;
    const at = clockText(since);
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      heading: 'NEEDS APPROVAL',
      kind: 'stuck-approval',
      kindName: 'Waits on your approval',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [
        `The track's agent waits for you to approve a ${tool} call${at ? ` (since ${at})` : ''}, and does nothing until you answer.`,
        'Answer the prompt in the Claude Code session that started the agent. This card goes away once the agent moves on.',
      ],
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  /** Auto mode refused the track's tool calls, or it fails the same tool again and again (lib/toolTrouble.js). */
  function toolTroubleItem(h) {
    const options = [{ label: 'Seen', recommended: true, action: { type: 'keep', id: h.id } }];
    const { denied, failing } = h.tool_trouble;
    const calls = (n) => (n === 1 ? 'call' : 'calls');
    const lines = [];
    if (denied) {
      const at = clockText(denied.last);
      lines.push(
        `Auto mode refused ${denied.count} ${denied.tool} ${calls(denied.count)}${at ? ` (last ${at})` : ''}. The track may work around ` +
          'it or stand still; look at what it tried in its session, and allow it or change the task.',
      );
    }
    if (failing) {
      const at = clockText(failing.last);
      lines.push(
        `${failing.count} ${failing.tool} ${calls(failing.count)} failed in the last half hour${at ? ` (last ${at})` : ''}. The track ` +
          'may be looping on the same error; look at its session, and stop it or give it what it lacks.',
      );
    }
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      heading: 'TOOL TROUBLE',
      kind: 'stuck-tools',
      kindName: 'Refused or failing tools',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: lines,
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  function stuckItem(h) {
    if (h.awaiting_approval) return approvalItem(h);
    if (h.tool_trouble) return toolTroubleItem(h);
    if (h.stop) return stopItem(h);
    if (h.no_agent_round) return noAgentRoundItem(h);
    if (h.without_agent) return noAgentItem(h);
    if (h.long_silent) return silentItem(h);
    if (h.long_spinning) return spinningItem(h);
    const picked = h.status === 'picked';
    const flagged = !!h.open_block;
    const context = [
      h.aging
        ? `${h.status === 'review' ? 'In review' : 'Running'} for ${minutesText(h.aging.age)}; ` +
          `85 % of ${h.class ?? '?'} tasks are ${h.aging.measure === 'work' ? 'delivered' : 'finished'} within ` +
          `${minutesText(h.aging.limit)}`
        : `Picked by ${h.picked_by ?? '?'}, without commits in the last 72 h`,
      flagged ? `Already blocked: ${h.open_block}` : null,
    ].filter(Boolean);
    let options;
    if (picked)
      options = [
        { label: 'Release to the queue', recommended: true, action: { type: 'release', id: h.id } },
        { label: 'Keep it picked', recommended: false, action: { type: 'keep', id: h.id } },
      ];
    else if (!flagged)
      options = [
        { label: 'Flag for the orchestrator', recommended: true, action: { type: 'flag-stuck', id: h.id } },
        { label: 'Leave it running', recommended: false, action: { type: 'keep', id: h.id } },
      ];
    // A task that already has an open blocker is not flagged again (a new code would close the real one).
    else options = [{ label: 'Leave it', recommended: true, action: { type: 'keep', id: h.id } }];
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      kind: picked ? 'stuck-picked' : 'stuck-aging',
      kindName: picked ? 'Picked, no commits' : 'Running long',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context,
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  // ---- Sorting and grouping ---------------------------------------------------------------------------------------

  /**
   * Most impact first: a question that pauses the whole queue (the focus ended), then minutes unlocked in focus stage 1, then stage 2 and so on (stage 1 weighs most, the same rule
   * as the inbox's own question order), then the tasks unlocked, then the minutes, then the verb (a question before a
   * check) and the key, so the order is stable.
   */
  function compareImpact(a, b) {
    // A question that pauses the whole queue (the focus ended) comes before everything else.
    const qa = a.impact?.pausesQueue ? 1 : 0;
    const qb = b.impact?.pausesQueue ? 1 : 0;
    if (qa !== qb) return qb - qa;
    const pa = a.impact?.perStep ?? [];
    const pb = b.impact?.perStep ?? [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d) return d;
    }
    return (
      (b.impact?.focusCount ?? 0) - (a.impact?.focusCount ?? 0) ||
      (b.impact?.count ?? 0) - (a.impact?.count ?? 0) ||
      (b.impact?.minutes ?? 0) - (a.impact?.minutes ?? 0) ||
      (VERB_ORDER[a.verb] ?? 9) - (VERB_ORDER[b.verb] ?? 9) ||
      String(a.key).localeCompare(String(b.key))
    );
  }

  /** A sorted copy (compareImpact). */
  function sortItems(items) {
    return [...(items ?? [])].sort(compareImpact);
  }

  /**
   * The groups in VERBS order, each sorted by impact; empty groups are left out. Within a group a delivery with a
   * one-way door comes first (MS-1), in impact order among themselves: it raises visibility, never moves a group.
   */
  function groupItems(items) {
    const sorted = sortItems(items);
    const oneWay = (x) => x.danger?.oneWay === true;
    return VERBS.map((v) => {
      const own = sorted.filter((x) => x.verb === v.verb);
      return { ...v, items: [...own.filter(oneWay), ...own.filter((x) => !oneWay(x))] };
    }).filter((g) => g.items.length);
  }

  /** The order the board's keyboard walks (j/k): group by group, as drawn. */
  function walkOrder(items) {
    return groupItems(items).flatMap((g) => g.items);
  }

  /** The decisions from the inbox, sorted: what `ravenseat decide` lists and the skill walks. */
  function decisions(inbox) {
    return sortItems(fromInbox(inbox));
  }

  /** One line about what the answer does: "unlocks 3 tasks (4 h) · in focus: 2 (step 1)". */
  function impactLine(item) {
    const x = item?.impact ?? {};
    const parts = [];
    if (item?.verb === 'approve') {
      parts.push(item?.batched ? `puts it in the batch queue (${minutesText(x.own ?? 0)}), where it does not start alone` : `queues it (${minutesText(x.own ?? 0)})`);
      if (x.count) parts.push(`then unlocks ${plural(x.count, 'task', 'tasks')} (${minutesText(x.minutes)})`);
    } else if (item?.verb === 'unstick') {
      parts.push(x.count ? `${plural(x.count, 'task waits', 'tasks wait')} on it (${minutesText(x.minutes)})` : 'nothing waits on it');
    } else if (item?.verb === 'check') {
      parts.push('closes the QA; nothing waits on it');
    } else if (x.pausesQueue) {
      parts.push('the queue is paused until you answer');
    } else {
      parts.push(x.count ? `unlocks ${plural(x.count, 'task', 'tasks')} (${minutesText(x.minutes)})` : 'no task waiting');
    }
    const stage = (x.perStep ?? []).findIndex((m) => m > 0);
    if (stage >= 0) {
      if (item?.verb === 'decide')
        parts.push(`in focus: ${x.focusCount} (${minutesText(x.focusMinutes)}), step ${stage + 1} first`);
      else parts.push(`in focus step ${stage + 1}`);
    }
    return parts.join(' · ');
  }

  // ---- The writes: ravenseat arguments and board calls ------------------------------------------------------------------

  /** The remark `ravenseat cancel` gets when a proposal is declined (the same text as queueTaskEdit.cancelRemark). */
  function declineRemark(reason) {
    const r = String(reason ?? '').replace(/\s+/g, ' ').trim();
    return r ? `declined: ${r}` : 'declined';
  }

  /**
   * The `ravenseat` arguments for an action, or null for one that writes nothing (keep). The owner's actions carry
   * --by owner where the command records who it was (resolve, approve, qa ok, cancel).
   */
  function cliArgs(action) {
    const a = action ?? {};
    switch (a.type) {
      case 'resolve': {
        // keep (roadmap 0z Z-A): the answer also becomes a proposed design choice (resolve --keep).
        const keep = a.keep === true ? ['--keep'] : [];
        if (a.choice != null) return ['resolve', a.sp, '--choice', String(a.choice), ...(a.answer ? ['--answer', a.answer] : []), ...keep, '--by', 'owner'];
        return ['resolve', a.sp, '--answer', String(a.answer ?? ''), ...keep, '--by', 'owner'];
      }
      case 'qa-ok':
        return ['qa', 'ok', a.id, '--by', 'owner'];
      case 'qa-deviation':
        return ['qa', 'deviation', a.id, String(a.text ?? '')];
      case 'approve':
        return ['approve', a.id, '--by', 'owner'];
      case 'decline':
        // keep (roadmap 0f): the declined proposal also becomes a proposed "Not building" entry (cancel --keep).
        return ['cancel', a.id, '--remark', declineRemark(a.reason), ...(a.keep === true ? ['--keep'] : []), '--by', 'owner'];
      case 'release':
        return ['release', a.id];
      case 'requeue':
        return ['set', a.id, 'waiting'];
      case 'track-answer':
        return ['resume', a.id, '--reason', 'context', '--answer', String(a.text ?? ''), '--by', 'owner'];
      case 'flag-stuck':
        return ['block', a.id, 'other', '--note', FLAG_NOTE];
      default:
        return null;
    }
  }

  /** The arguments as one command line to show or paste (double quotes where needed). */
  function cliText(args, ravenseat = 'ravenseat') {
    if (!args) return null;
    const quote = (s) => (/^[A-Za-z0-9._:/=@-]+$/.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`);
    return [ravenseat, ...args.map(quote)].join(' ');
  }

  /**
   * The board's API call for an action ({ path, body }), or null for keep. The server turns each into the same
   * queue.mjs command as cliArgs (queue-board.mjs write()).
   */
  function boardCall(action) {
    const a = action ?? {};
    switch (a.type) {
      case 'resolve':
        return {
          path: '/api/action',
          body: {
            ...(a.choice != null
              ? { type: 'resolve', sp: a.sp, choice: a.choice, ...(a.answer ? { answer: a.answer } : {}) }
              : { type: 'resolve', sp: a.sp, answer: String(a.answer ?? '') }),
            ...(a.keep === true ? { keep: true } : {}),
          },
        };
      case 'qa-ok':
      case 'approve':
      case 'release':
      case 'requeue':
      case 'flag-stuck':
        return { path: '/api/action', body: { type: a.type, id: a.id } };
      case 'qa-deviation':
        return { path: '/api/action', body: { type: 'qa-deviation', id: a.id, text: String(a.text ?? '') } };
      case 'track-answer':
        return { path: '/api/action', body: { type: 'track-answer', id: a.id, text: String(a.text ?? '') } };
      case 'decline':
        return { path: '/api/task-edit', body: { type: 'decline', id: a.id, ...(a.reason ? { reason: a.reason } : {}), ...(a.keep === true ? { keep: true } : {}) } };
      default:
        return null;
    }
  }

  /** A short past-tense line for the summary and the undo toast: "Q-7: Vendor B", "A-3 approved". */
  function doneText(item, option, text) {
    const a = option?.action ?? {};
    if (a.type === 'resolve') return `${item.id}: ${a.choice != null ? option.label : text ?? a.answer ?? ''}`;
    if (a.type === 'qa-ok') return `${item.id}: QA ok`;
    if (a.type === 'qa-deviation') return `${item.id}: QA deviation`;
    if (a.type === 'approve') return `${item.id} approved`;
    if (a.type === 'decline') return `${item.id} declined`;
    if (a.type === 'release') return `${item.id} released to the queue`;
    if (a.type === 'requeue') return `${item.id} back in the queue`;
    if (a.type === 'track-answer') return `${item.id}: answered. The new round is ready; the orchestrator starts its agent`;
    if (a.type === 'flag-stuck') return `${item.id} flagged for the orchestrator`;
    return `${item.id}: kept as it is`;
  }

  // ---- "Decided today" -------------------------------------------------------------------------------------------

  /** The start of the local day `now` is in (ms). */
  function dayStart(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /**
   * What the owner decided since the start of today (local time), newest first, from the queue's own timestamps:
   * resolutions (time, by), approved (not by the auto-accept), qa_ok (not auto), an answer to what a track asked (the round
   * it made), and the remarks of a decline and a QA deviation.
   * `from` (ms) starts the list at a window instead (the "Since you left" window, roadmap 3e AW-8).
   * @returns {{ verb: string, id: string, what: string, at: string, by: string|null }[]}
   */
  function decidedToday(queue, { now = Date.now(), max = 50, from: start = null } = {}) {
    const from = typeof start === 'number' && Number.isFinite(start) ? start : dayStart(now);
    const today = (iso) => {
      const ms = Date.parse(iso ?? '');
      return Number.isFinite(ms) && ms >= from && ms <= now + 60_000;
    };
    const out = [];
    // The auto-accept approves through the same path; its log tells those apart (as lib/ownerWait.js does).
    const auto = new Set((queue?.auto_accepted ?? []).map((x) => `${x?.id} ${x?.at}`));
    for (const [sp, r] of Object.entries(queue?.resolutions ?? {}))
      if (r && today(r.time))
        out.push({ verb: 'decide', id: sp, what: r.answer == null ? 'resolved' : String(r.answer), at: r.time, by: r.by ?? null });
    for (const o of queue?.tasks ?? []) {
      if (today(o.approved) && !auto.has(`${o.id} ${o.approved}`))
        out.push({ verb: 'approve', id: o.id, what: 'approved', at: o.approved, by: o.approved_by ?? null });
      if (today(o.qa_ok) && o.qa_ok_by !== 'auto')
        out.push({ verb: 'check', id: o.id, what: 'QA ok', at: o.qa_ok, by: o.qa_ok_by ?? null });
      for (const round of o.resumed ?? [])
        if (round?.answer && today(round.time))
          out.push({ verb: 'decide', id: o.id, what: String(round.answer), at: round.time, by: null });
      for (const line of o.remarks ?? []) {
        const m = /^(\S+) (declined(?:: .*)?|QA deviation, fix \S+)$/.exec(String(line));
        if (!m || !today(m[1])) continue;
        out.push({
          verb: m[2].startsWith('declined') ? 'approve' : 'check',
          id: o.id,
          what: m[2],
          at: m[1],
          by: null,
        });
      }
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.id.localeCompare(b.id)).slice(0, max);
  }

  // ---- "Decided for you" -----------------------------------------------------------------------------------------
  // What was decided without the owner (section 5.2 of plans/autonomi-nivaa-utredning.md): proposals the owner's rules
  // approved (auto_accepted, which decidedToday skips on purpose) and the choices receive spotted in a delivery
  // (decision_signals, lib/decisionSignals.js). Shown next to "Decided today", never counted in the Decisions tab: it is
  // there to be seen and undone, not to make work.

  /** The category names of lib/decisionSignals.js LABELS (a test keeps them equal; this file also runs in the browser). */
  const SIGNAL_LABELS = Object.freeze({
    dependency: 'New package',
    migration: 'Migration or schema',
    deletion: 'Deletion',
    unstated: 'Unstated choices',
  });

  /**
   * The honest next step to undo what was decided, from where the task is now (the table in section 5.2): free before
   * the start, a cancel after it, a fix round before the merge, a revert after it.
   */
  function undoParts(o, { rules = false, undone = false, ravenseat = 'ravenseat' } = {}) {
    // when: where the task is (plain words); cli: the command, or null; note: what it costs (plain words), or null.
    const p = (when, cli = null, note = null) => ({ when, cli, note });
    if (undone) return p('undone already, back to proposed');
    if (!o) return p('the task is gone');
    const s = o.status;
    if (s === 'cancelled') return p('cancelled, nothing to undo');
    if (s === 'proposed') return p('back to proposed');
    if (s === 'waiting' && !o.started && !o.picked_by)
      return p(null, rules ? `${ravenseat} proposals undo ${o.id}` : `${ravenseat} set ${o.id} cancelled`);
    if (s === 'running' || s === 'picked' || (s === 'waiting' && (o.started || o.picked_by)))
      return p('started', `${ravenseat} set ${o.id} cancelled`, 'the tokens it used are spent');
    if (s === 'review') return p('not merged', `${ravenseat} resume ${o.id} --reason fix --answer "<what to change>"`);
    if (s === 'done')
      // `undo` finds the merge commit itself (merge_commit, else the merge log), shows the plan and asks y/N.
      return p('merged', `${ravenseat} undo ${o.id}`);
    return p(`status ${s}`, `${ravenseat} show ${o.id}`);
  }

  /** undoParts as one line: "not merged: ravenseat resume ...", "started: ... (the tokens it used are spent)". */
  function undoText(o, opts = {}) {
    const { when, cli, note } = undoParts(o, opts);
    return `${[when, cli].filter(Boolean).join(': ')}${note ? ` (${note})` : ''}`;
  }

  /**
   * "Decided for you" since the start of today (or `from`, the "Since you left" window), newest first.
   * @returns {{ source: 'rules'|'agent', id: string, title: string|null, what: string, category: string, who: string,
   *   why: string, at: string, undo: string, undo_parts: { when: string|null, cli: string|null, note: string|null } }[]}
   */
  function decidedForYou(queue, { now = Date.now(), max = 50, from: start = null, ravenseat = 'ravenseat' } = {}) {
    const from = typeof start === 'number' && Number.isFinite(start) ? start : dayStart(now);
    const inWindow = (iso) => {
      const ms = Date.parse(iso ?? '');
      return Number.isFinite(ms) && ms >= from && ms <= now + 60_000;
    };
    const tasks = new Map((queue?.tasks ?? []).map((o) => [o.id, o]));
    const out = [];
    for (const e of queue?.auto_accepted ?? []) {
      if (!e?.id || !inWindow(e.at)) continue;
      const o = tasks.get(e.id);
      out.push({
        source: 'rules',
        id: e.id,
        title: o?.title ?? null,
        what: o?.title ?? e.id,
        category: 'Follow-up tasks',
        who: 'Approved by your rules',
        why: e.reason ?? 'fits your rules',
        at: e.at,
        undo: undoText(o, { rules: true, undone: !!e.undone, ravenseat }),
        undo_parts: undoParts(o, { rules: true, undone: !!e.undone, ravenseat }),
      });
    }
    for (const o of queue?.tasks ?? []) {
      const rec = o?.decision_signals;
      if (!rec || !inWindow(rec.at)) continue;
      for (const s of rec.signals ?? []) {
        const why =
          s.asked === true ? 'asked you' : s.asked === false ? (s.told ? 'not asked, but said under Assumptions' : 'not asked') : 'not stated';
        out.push({
          source: 'agent',
          id: o.id,
          title: o.title ?? null,
          what: String(s.what ?? ''),
          category: SIGNAL_LABELS[s.category] ?? String(s.category ?? 'Other'),
          who: 'The agent decided',
          why,
          at: rec.at,
          undo: undoText(o, { ravenseat }),
          undo_parts: undoParts(o, { ravenseat }),
          // The delivery's door and blast radius (MS-1), null before MS-1.
          danger: dangerView(o.merge_danger),
        });
      }
    }
    // A stable sort: the signals of one delivery keep their order.
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, max);
  }

  return {
    CATEGORY_TITLES,
    IF_YES_LABEL,
    IF_NO_LABEL,
    NOT_FILLED,
    SIGNAL_LABELS,
    ONE_WAY_BADGE,
    DANGER_NOT_STATED,
    dangerView,
    undoParts,
    undoText,
    decidedForYou,
    VERBS,
    UNDO_MS,
    AS_RECOMMENDED,
    QUESTION_WORDS,
    OTHER_DECISION,
    START_FROM_RECOMMENDATION,
    questionWords,
    freeAnswer,
    questionItem,
    fromPlanDecision,
    landInDecisions,
    FLAG_NOTE,
    STOP_TEXT,
    minutesText,
    daysOpenText,
    agoText,
    NUMBER_KEYS,
    fromInbox,
    compareImpact,
    sortItems,
    groupItems,
    walkOrder,
    decisions,
    impactLine,
    declineRemark,
    cliArgs,
    cliText,
    boardCall,
    doneText,
    dayStart,
    decidedToday,
  };
});
