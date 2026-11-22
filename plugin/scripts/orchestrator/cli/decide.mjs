// =============================================================
// cli/decide.mjs: `ravenseat decide`, the decision overview in the terminal (the same list as the board's Decisions view).
//
// Everything that waits on the owner (owner questions, QA, proposed tasks, stuck work) as ONE list sorted by impact
// (what each answer unlocks, the focus stages first), each with its options and the exact `ravenseat` command per option.
// The /ravenseat:decide skill reads `ravenseat decide --json` and walks the list with the owner; the commands it runs are the ones
// printed here, the same queue.mjs commands (and --by owner) the board runs, so the log and the actor are the same.
// Read only: this command never writes.
//
// The list is built like the board's state: queueBoard.board (the inbox, the aging limits, the old picks) on the queue
// with done focus stages taken out, then lib/queueDecisions.js (sorting, impact, options, writes).
//
// Used by: queue.mjs (dispatch). Tested in: lib/__tests__/queueDecide.test.ts.
// =============================================================

import { baseRedLine } from './baseHealth.mjs';
import { a, branchFor, branchInfo, CLI, CONFIG, cut, FOLDER, L, PREFIX, read, require, S, uncommittedPaths, val, WIDTH } from './context.mjs';
import { findSilent, findSpinning, findWithoutAgent } from './tracks.mjs';

const T = require('./lib/queueBoard.js');
const DEC = require('./lib/queueDecisions.js');
const OW = require('./lib/ownerWait.js');

/** The board's inbox for the queue as it is now (the same inputs the board server gives queueBoard.board). */
export function currentInbox(queue, { now = Date.now() } = {}) {
  const branches = {};
  for (const o of queue.tasks ?? []) {
    if (o.status !== 'picked') continue;
    const branch = o.branch ?? branchFor(o.id);
    branches[branch] = branchInfo(branch);
  }
  // As the board: the queue is shown as if done focus stages were already taken out (nothing is written).
  let showQueue = queue;
  try {
    const fe = L.focusWithoutDone(queue);
    if (fe.focus) showQueue = { ...queue, focus: fe.focus };
  } catch {
    /* the focus evaluation failed: the queue as it is */
  }
  let ageLimits = {};
  try {
    ageLimits = S.ageBounds(queue, { now });
  } catch {
    /* no time history: no aging */
  }
  return T.board(showQueue, { now, branches, branchPrefix: PREFIX, ageLimits, withoutAgent: findWithoutAgent(queue), ...silentAndSpinning(queue), baseRed: !!baseRedLine() }).inbox;
}

/** SILENT and SPINNING for the board inbox (a SILENT track is never also SPINNING). */
function silentAndSpinning(queue) {
  const silent = findSilent(queue);
  return { silent, spinning: findSpinning(queue, { silent }) };
}

/** The JSON shape for the skill: each item with its impact line and the command per option. */
export function decisionJson(inbox, { listening = false, ravenseat = CLI, baseRed = null, heldBack = [], onCancelled = [], decidedForYou = null } = {}) {
  const items = DEC.decisions(inbox).map((x, i) => ({
    nr: i + 1,
    ...x,
    impact_line: DEC.impactLine(x),
    // An answer that needs text (a QA deviation) shows `<text>` where the text goes, as `free` does.
    options: x.options.map((o) => ({
      ...o,
      cli: DEC.cliText(DEC.cliArgs(o.needsText && !o.optionalText ? { ...o.action, text: '<text>' } : o.action), ravenseat),
    })),
    free: x.free ? { ...x.free, cli: DEC.cliText(DEC.cliArgs({ ...x.free.action, answer: '<text>' }), ravenseat) } : null,
  }));
  return {
    count: items.length,
    listening,
    // A red base stops every merge, so it stands above the list (null when the base is not red).
    base_red: baseRed,
    // Not a decision, but the reason nothing starts (a task that owns an uncommitted file), so it is not hidden behind "nothing waiting".
    ...(heldBack.length ? { held_back: heldBack } : {}),
    // Also not a decision card: tasks that never start, because what they wait on was cancelled.
    ...(onCancelled.length ? { waiting_on_cancelled: onCancelled } : {}),
    items,
    decided: inbox?.decided ?? [],
    // What was decided without the owner (queueDecisions.decidedForYou), with this CLI's name in the undo commands. Not
    // in count: it is there to be seen and undone.
    decided_for_you: decidedForYou ?? inbox?.decided_for_you ?? [],
    // Answers given but not entered in the decision log yet (the orchestrator does that).
    unlogged: (inbox?.unlogged ?? []).map((x) => x.sp),
  };
}

/** The list as text lines (what `ravenseat decide` prints). */
export function decisionLines(j, { width = WIDTH, max = Infinity, ravenseat = CLI } = {}) {
  const out = [];
  if (j.base_red) out.push(j.base_red, '');
  if (j.held_back) out.push(...L.heldBackLines(j.held_back), '');
  if (j.waiting_on_cancelled) out.push(...L.waitingOnCancelledLines(j.waiting_on_cancelled), '');
  if (!j.count) {
    out.push('Nothing waiting on you.');
  } else {
    out.push(
      `Waiting on you: ${j.count} ${j.count === 1 ? 'decision' : 'decisions'}, most impact first ` +
        `(${j.listening ? 'the orchestrator is listening' : 'answers are picked up the next time the orchestrator runs'}).`,
    );
    for (const x of j.items.slice(0, max)) {
      out.push('');
      out.push(cut(`${x.nr}. ${x.heading ?? x.verb.toUpperCase()}  ${x.id}  ${x.title}`, width));
      // The card fields (section 6.1 of plans/autonomi-nivaa-utredning.md), in the board's order: the category, the
      // recommendation, what each answer leads to, then why it is asked. An old post has none of the new lines.
      if (x.verb === 'decide' && x.categoryTitle) out.push(`   Category: ${x.categoryTitle}`);
      if (x.notFilled) out.push(`   ${DEC.NOT_FILLED}`);
      // A delivery's door and blast radius (MS-1): the track's call, a reviewer who disagrees beside it. Never a guard.
      if (x.danger) {
        out.push(cut(`   ${x.danger.badge ? `${x.danger.badge}. ` : ''}${x.danger.text}`, width));
        for (const d of x.danger.disagree) out.push(cut(`   ${d}`, width));
      }
      if (x.verb === 'decide' && x.recommendation) out.push(cut(`   Recommendation: ${x.recommendation}`, width));
      if (x.ifYes) out.push(cut(`   ${DEC.IF_YES_LABEL}: ${x.ifYes}`, width));
      if (x.ifNo) out.push(cut(`   ${DEC.IF_NO_LABEL}: ${x.ifNo}`, width));
      if (x.background) out.push(cut(`   Why: ${x.background}`, width));
      out.push(`   ${x.impact_line}`);
      for (const c of x.context) out.push(`   ${c}`);
      x.options.forEach((o, i) => {
        // "As recommended" already says it; a recommended choice of a question reads "As recommended: <choice>".
        const text =
          o.label === DEC.AS_RECOMMENDED
            ? o.label
            : o.recommended && x.verb === 'decide'
              ? `${DEC.AS_RECOMMENDED}: ${o.label}`
              : `${o.label}${o.recommended ? ' (recommended)' : ''}`;
        const label = `${i + 1}) ${text}`;
        out.push(`   ${label.padEnd(34)} ${o.cli ?? '(writes nothing)'}`);
      });
      // The same word as the board (QUESTION_WORDS): a question in your own words, an owner task "mark done".
      if (x.free) {
        const freeWord = x.kind === 'question' || !x.free.label ? 'or in your own words:' : `or ${x.free.label.toLowerCase()}:`;
        out.push(`   ${freeWord.padEnd(34)} ${x.free.cli}`);
      }
    }
    if (j.items.length > max) out.push('', `... and ${j.items.length - max} more (${ravenseat} decide --json for all).`);
  }
  if (j.decided.length) out.push('', `Decided today: ${j.decided.length} (${ravenseat} decide --today).`);
  if (j.decided_for_you?.length) {
    if (!j.decided.length) out.push('');
    out.push(`Decided for you: ${j.decided_for_you.length} (${ravenseat} decide --today).`);
  }
  if (j.unlogged.length)
    out.push(`Not in the decision log yet: ${j.unlogged.join(', ')} (${ravenseat} resolutions --unlogged).`);
  return out;
}

/** "Decided today" as text lines. */
export function decidedLines(decided, { width = WIDTH } = {}) {
  if (!decided.length) return ['Nothing decided today yet.'];
  const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return [
    `Decided today: ${decided.length}`,
    ...decided.map((d) => cut(`  ${time(d.at)}  ${d.verb.padEnd(8)} ${d.id}: ${d.what}${d.by ? ` (by ${d.by})` : ''}`, width)),
  ];
}

/**
 * "Decided for you" as text lines: what was decided without the owner (the owner's rules, an agent's choice receive
 * spotted), with who, why and the honest next step to undo it. Nothing when there is none.
 */
export function decidedForYouLines(list, { width = WIDTH } = {}) {
  if (!list?.length) return [];
  const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const out = ['', `Decided for you: ${list.length} (not counted as waiting on you)`];
  for (const d of list) {
    out.push(cut(`  ${time(d.at)}  ${d.id}: ${d.category}: ${d.what} (${d.who}, ${d.why})`, width));
    // The delivery's door and blast radius (MS-1), when receive stored them.
    if (d.danger) out.push(cut(`         ${d.danger.badge ? `${d.danger.badge}. ` : ''}${d.danger.text}`, width));
    out.push(cut(`         undo: ${d.undo}`, width));
  }
  return out;
}

/** `ravenseat decide [--json] [--max N] [--today]` (the usage is at the top of queue.mjs). */
export function cmdDecide() {
  // mergeDanger.show off (lib/doorShow.js): a door and blast radius stored before is not shown.
  const queue = require('./lib/doorShow.js').hideStored(read(), CONFIG);
  const inbox = currentInbox(queue);
  let listening = false;
  try {
    listening = OW.heartbeatState(FOLDER).listening === true;
  } catch {
    listening = false;
  }
  const j = decisionJson(inbox, { listening, baseRed: baseRedLine(), heldBack: L.uncommittedSkipped(queue, uncommittedPaths()), onCancelled: L.waitingOnCancelled(queue), decidedForYou: DEC.decidedForYou(queue, { ravenseat: CLI }) });
  if (a.includes('--json')) {
    console.log(JSON.stringify(j, null, 2));
    return;
  }
  if (a.includes('--today')) {
    console.log([...decidedLines(j.decided), ...decidedForYouLines(j.decided_for_you)].join('\n'));
    return;
  }
  const max = Number(val('--max'));
  console.log(decisionLines(j, { max: Number.isInteger(max) && max > 0 ? max : Infinity }).join('\n'));
}
