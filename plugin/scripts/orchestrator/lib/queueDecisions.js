// =============================================================
// queueDecisions.js: the decision overview, the one place where the owner meets the queue.
//
// "Waiting on you" (queueBoard.inbox) already knows what waits on the owner: owner questions, QA, proposed tasks and
// stuck work. This file turns that into ONE list of decisions, each with
//   - a verb (Decide, Check, Approve, Unstick) the board groups by,
//   - the impact (what the answer unlocks, in the focus stages first), which the list is sorted by,
//   - the options, the recommended one first, each with the exact write it does: the `cq` arguments (cliArgs, used by
//     `cq decide` and the /cq:decide skill) and the board's API call (boardCall, used by the Decisions view). Both run
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

  /** How long the board waits before it writes a one-click answer, so "Undo" can take it back without a revert. */
  const UNDO_MS = 5000;

  /** The note `cq block` gets when the owner flags stuck work (the orchestrator sees it in pulse and blockers). */
  const FLAG_NOTE = 'owner: looks stuck, please check';

  /** The stops that wait on someone (a task in review with one of these open): what to call it and the next step. */
  const STOP_TEXT = {
    'merge-conflict': {
      name: 'Merge conflict',
      next: (id) => `Next: the orchestrator starts a fix round (cq resume ${id} --reason fix).`,
    },
    'merge-guard': {
      name: 'Stopped by the merge guard',
      next: (id) =>
        `Next: read the diff of the protected paths. Not asked for: a fix round (cq resume ${id} --reason fix). Intended: cq merge ${id} --allow-guard.`,
    },
    'merge-stopped': {
      name: 'Merge stopped',
      next: (id) => `Next: fix the cause named above, then cq merge ${id} again. Nothing was merged by this stop.`,
    },
    'track-question': {
      name: 'The track asks you',
      next: (id) =>
        `Next: answer, and the orchestrator passes it on in a new round (cq resume ${id} --reason context), or cq set ${id} cancelled. ` +
        `If it needs a file the task does not own: cq edit ${id} --files <files> first. A finished delivery that needs no answer can be merged.`,
    },
    'gate-red': {
      name: 'Gates red',
      next: (id) => `Next: the orchestrator starts a fix round (cq resume ${id} --reason fix), or cq merge ${id} --resume once the cause is fixed.`,
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

  // ---- From "Waiting on you" to decisions ----------------------------------------------------------------------

  /** The answer kinds an owner question can have (the field label and the verb on the button). */
  const QUESTION_KIND = {
    question: { name: 'Question', free: 'Answer in your own words' },
    condition: { name: 'Waiting on condition', free: 'How is the condition fulfilled?' },
    lawyer: { name: 'Waiting on lawyer', free: 'What did the lawyer say?' },
    'owner-task': { name: 'Owner task', free: 'What is completed?' },
  };

  /**
   * One list of decisions from the inbox (queueBoard.inbox: question, qa, proposed, stuck). Unsorted; see sortItems.
   * Each item: { key, verb, kind, id, title, text, context, recommendation, impact, options, free, open }.
   *   impact  { count, minutes, perStep: number[], focusCount, focusMinutes } (perStep = minutes per focus stage)
   *   options [{ label, recommended, action, needsText? }] (the recommended one first; needsText = the label for the
   *           text the action needs, e.g. what is wrong in a QA deviation)
   *   free    { label, action } a free text answer (the action has answer: null until the text is given), or null
   *   open    the task to open for more (null for a question)
   */
  function fromInbox(inbox) {
    if (!inbox) return [];
    const out = [];
    for (const s of inbox.question ?? []) out.push(questionItem(s));
    for (const p of inbox.qa ?? [])
      for (const f of p.features ?? [])
        for (const o of f.tasks ?? []) out.push(qaItem(o, p, f));
    for (const f of inbox.proposed ?? []) out.push(proposedItem(f));
    for (const h of inbox.stuck ?? []) out.push(stuckItem(h));
    return out;
  }

  function questionItem(s) {
    const kind = QUESTION_KIND[s.type] ?? QUESTION_KIND.question;
    const focus = s.focus ?? null;
    const choices = Array.isArray(s.choices) ? s.choices : [];
    // The choices as options, the recommended one first (the rest keep their order). The action keeps the 1-based
    // number, which is what `cq resolve --choice` and the board's { choice } take.
    const numbered = choices.map((c, i) => ({
      label: c.label,
      recommended: !!c.recommended,
      action: { type: 'resolve', sp: s.sp, choice: i + 1 },
    }));
    let options = [...numbered.filter((o) => o.recommended), ...numbered.filter((o) => !o.recommended)];
    // Without choices, a recommendation is still a one-click answer: "Use the recommendation" sends its text.
    if (!options.length && s.recommendation)
      options = [
        {
          label: 'Use the recommendation',
          recommended: true,
          action: { type: 'resolve', sp: s.sp, answer: s.recommendation },
        },
      ];
    const waiting = Array.isArray(s.direct) ? s.direct : [];
    return {
      key: `decide:${s.sp}`,
      verb: 'decide',
      kind: s.type ?? 'question',
      kindName: kind.name,
      id: s.sp,
      title: s.text ?? `${s.sp} (no text registered yet)`,
      text: s.text ?? null,
      context: [
        s.recommendation ? `Recommendation: ${s.recommendation}` : null,
        s.source ? `Source: ${s.source}` : null,
        waiting.length ? `Waiting: ${waiting.join(', ')}` : null,
      ].filter(Boolean),
      recommendation: s.recommendation ?? null,
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
      free: { label: kind.free, action: { type: 'resolve', sp: s.sp, answer: null } },
      open: null,
    };
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
      id: f.id,
      title: f.title || f.id,
      text: null,
      context: [
        `${f.class ?? '?'} · ${estimate} min · value ${f.value ?? '?'}${f.added_by ? ` · from ${f.added_by}` : ''}`,
        ...(f.gate_without_place
          ? ['No file and line behind it, and the gate needs a failing example: approving means agent work on a guess. Approve if you know the bug is real.']
          : []),
      ],
      recommendation: f.gate_without_place ? 'Decline' : 'Approve',
      impact: { ...taskImpact(estimate, f), own: estimate },
      options: f.gate_without_place ? [decline, approve] : [approve, decline],
      free: null,
      open: f.id,
    };
  }

  /** A stop in the merge or the gates. "Seen" writes nothing: the card goes when the blocker closes. */
  function stopItem(h) {
    const stop = STOP_TEXT[h.stop.code];
    const options = [{ label: 'Seen', recommended: true, action: { type: 'keep', id: h.id } }];
    return {
      key: `unstick:${h.id}`,
      verb: 'unstick',
      kind: 'stopped',
      kindName: stop.name,
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [h.stop.note, h.stop.file ? `The whole text: ${h.stop.file}` : null, stop.next(h.id)].filter(Boolean),
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
      kind: 'stuck-no-agent',
      kindName: 'Started without an agent',
      id: h.id,
      title: h.title || h.id,
      text: null,
      context: [
        'Marked running, but no worktree has its branch and there is no report: the agent was never started.',
        `Back in the queue, the next fill starts it (cq fill --ids ${h.id}).`,
      ],
      recommendation: options[0].label,
      impact: taskImpact(0, h),
      options,
      free: null,
      open: h.id,
    };
  }

  function stuckItem(h) {
    if (h.stop) return stopItem(h);
    if (h.without_agent) return noAgentItem(h);
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

  /** The groups in VERBS order, each sorted by impact; empty groups are left out. */
  function groupItems(items) {
    const sorted = sortItems(items);
    return VERBS.map((v) => ({ ...v, items: sorted.filter((x) => x.verb === v.verb) })).filter(
      (g) => g.items.length,
    );
  }

  /** The order the board's keyboard walks (j/k): group by group, as drawn. */
  function walkOrder(items) {
    return groupItems(items).flatMap((g) => g.items);
  }

  /** The decisions from the inbox, sorted: what `cq decide` lists and the skill walks. */
  function decisions(inbox) {
    return sortItems(fromInbox(inbox));
  }

  /** One line about what the answer does: "unlocks 3 tasks (4 h) · in focus: 2 (stage 1)". */
  function impactLine(item) {
    const x = item?.impact ?? {};
    const parts = [];
    if (item?.verb === 'approve') {
      parts.push(`queues it (${minutesText(x.own ?? 0)})`);
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
        parts.push(`in focus: ${x.focusCount} (${minutesText(x.focusMinutes)}), stage ${stage + 1} first`);
      else parts.push(`in focus stage ${stage + 1}`);
    }
    return parts.join(' · ');
  }

  // ---- The writes: cq arguments and board calls ------------------------------------------------------------------

  /** The remark `cq cancel` gets when a proposal is declined (the same text as queueTaskEdit.cancelRemark). */
  function declineRemark(reason) {
    const r = String(reason ?? '').replace(/\s+/g, ' ').trim();
    return r ? `declined: ${r}` : 'declined';
  }

  /**
   * The `cq` arguments for an action, or null for one that writes nothing (keep). The owner's actions carry
   * --by owner where the command records who it was (resolve, approve, qa ok, cancel).
   */
  function cliArgs(action) {
    const a = action ?? {};
    switch (a.type) {
      case 'resolve':
        if (a.choice != null) return ['resolve', a.sp, '--choice', String(a.choice), ...(a.answer ? ['--answer', a.answer] : []), '--by', 'owner'];
        return ['resolve', a.sp, '--answer', String(a.answer ?? ''), '--by', 'owner'];
      case 'qa-ok':
        return ['qa', 'ok', a.id, '--by', 'owner'];
      case 'qa-deviation':
        return ['qa', 'deviation', a.id, String(a.text ?? '')];
      case 'approve':
        return ['approve', a.id, '--by', 'owner'];
      case 'decline':
        return ['cancel', a.id, '--remark', declineRemark(a.reason), '--by', 'owner'];
      case 'release':
        return ['release', a.id];
      case 'requeue':
        return ['set', a.id, 'waiting'];
      case 'flag-stuck':
        return ['block', a.id, 'other', '--note', FLAG_NOTE];
      default:
        return null;
    }
  }

  /** The arguments as one command line to show or paste (double quotes where needed). */
  function cliText(args, cq = 'cq') {
    if (!args) return null;
    const quote = (s) => (/^[A-Za-z0-9._:/=@-]+$/.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`);
    return [cq, ...args.map(quote)].join(' ');
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
          body:
            a.choice != null
              ? { type: 'resolve', sp: a.sp, choice: a.choice, ...(a.answer ? { answer: a.answer } : {}) }
              : { type: 'resolve', sp: a.sp, answer: String(a.answer ?? '') },
        };
      case 'qa-ok':
      case 'approve':
      case 'release':
      case 'requeue':
      case 'flag-stuck':
        return { path: '/api/action', body: { type: a.type, id: a.id } };
      case 'qa-deviation':
        return { path: '/api/action', body: { type: 'qa-deviation', id: a.id, text: String(a.text ?? '') } };
      case 'decline':
        return { path: '/api/task-edit', body: { type: 'decline', id: a.id, ...(a.reason ? { reason: a.reason } : {}) } };
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
   * resolutions (time, by), approved (not by the auto-accept), qa_ok (not auto), and the remarks of a decline and a QA deviation.
   * @returns {{ verb: string, id: string, what: string, at: string, by: string|null }[]}
   */
  function decidedToday(queue, { now = Date.now(), max = 50 } = {}) {
    const from = dayStart(now);
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

  return {
    VERBS,
    UNDO_MS,
    FLAG_NOTE,
    STOP_TEXT,
    minutesText,
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
