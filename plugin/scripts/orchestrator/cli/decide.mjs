// =============================================================
// cli/decide.mjs: `cq decide`, the decision overview in the terminal (the same list as the board's Decisions view).
//
// Everything that waits on the owner (owner questions, QA, proposed tasks, stuck work) as ONE list sorted by impact
// (what each answer unlocks, the focus stages first), each with its options and the exact `cq` command per option.
// The /cq:decide skill reads `cq decide --json` and walks the list with the owner; the commands it runs are the ones
// printed here, the same queue.mjs commands (and --by owner) the board runs, so the log and the actor are the same.
// Read only: this command never writes.
//
// The list is built like the board's state: queueBoard.board (the inbox, the aging limits, the old picks) on the queue
// with done focus stages taken out, then lib/queueDecisions.js (sorting, impact, options, writes).
//
// Used by: queue.mjs (dispatch). Tested in: lib/__tests__/queueDecide.test.ts.
// =============================================================

import { a, branchFor, branchInfo, CQ, cut, FOLDER, L, PREFIX, read, require, S, val, WIDTH } from './context.mjs';

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
  return T.board(showQueue, { now, branches, branchPrefix: PREFIX, ageLimits }).inbox;
}

/** The JSON shape for the skill: each item with its impact line and the command per option. */
export function decisionJson(inbox, { listening = false, cq = CQ } = {}) {
  const items = DEC.decisions(inbox).map((x, i) => ({
    nr: i + 1,
    ...x,
    impact_line: DEC.impactLine(x),
    // An answer that needs text (a QA deviation) shows `<text>` where the text goes, as `free` does.
    options: x.options.map((o) => ({
      ...o,
      cli: DEC.cliText(DEC.cliArgs(o.needsText && !o.optionalText ? { ...o.action, text: '<text>' } : o.action), cq),
    })),
    free: x.free ? { ...x.free, cli: DEC.cliText(DEC.cliArgs({ ...x.free.action, answer: '<text>' }), cq) } : null,
  }));
  return {
    count: items.length,
    listening,
    items,
    decided: inbox?.decided ?? [],
    // Answers given but not entered in the decision log yet (the orchestrator does that).
    unlogged: (inbox?.unlogged ?? []).map((x) => x.sp),
  };
}

/** The list as text lines (what `cq decide` prints). */
export function decisionLines(j, { width = WIDTH, max = Infinity, cq = CQ } = {}) {
  const out = [];
  if (!j.count) {
    out.push('Nothing waiting on you.');
  } else {
    out.push(
      `Waiting on you: ${j.count} ${j.count === 1 ? 'decision' : 'decisions'}, most impact first ` +
        `(${j.listening ? 'the orchestrator is listening' : 'answers are picked up the next time the orchestrator runs'}).`,
    );
    for (const x of j.items.slice(0, max)) {
      out.push('');
      out.push(cut(`${x.nr}. ${x.verb.toUpperCase()}  ${x.id}  ${x.title}`, width));
      out.push(cut(`   ${x.impact_line}`, width));
      for (const c of x.context) out.push(cut(`   ${c}`, width));
      x.options.forEach((o, i) => {
        const label = `${i + 1}) ${o.label}${o.recommended ? ' (recommended)' : ''}`;
        out.push(cut(`   ${label.padEnd(34)} ${o.cli ?? '(writes nothing)'}`, width));
      });
      if (x.free) out.push(cut(`   ${'or in your own words:'.padEnd(34)} ${x.free.cli}`, width));
    }
    if (j.items.length > max) out.push('', `... and ${j.items.length - max} more (${cq} decide --json for all).`);
  }
  if (j.decided.length) out.push('', `Decided today: ${j.decided.length} (${cq} decide --today).`);
  if (j.unlogged.length)
    out.push(`Not in the decision log yet: ${j.unlogged.join(', ')} (${cq} resolutions --unlogged).`);
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

/** `cq decide [--json] [--max N] [--today]` (the usage is at the top of queue.mjs). */
export function cmdDecide() {
  const queue = read();
  const inbox = currentInbox(queue);
  let listening = false;
  try {
    listening = OW.heartbeatState(FOLDER).listening === true;
  } catch {
    listening = false;
  }
  const j = decisionJson(inbox, { listening });
  if (a.includes('--json')) {
    console.log(JSON.stringify(j, null, 2));
    return;
  }
  if (a.includes('--today')) {
    console.log(decidedLines(j.decided).join('\n'));
    return;
  }
  const max = Number(val('--max'));
  console.log(decisionLines(j, { max: Number.isInteger(max) && max > 0 ? max : Infinity }).join('\n'));
}
