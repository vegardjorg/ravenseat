// =============================================================
// cli/owner.mjs: the owner's commands: question, resolve, resolutions, approve, proposals and qa.
//
// The owner questions (registered texts and the answers that let waiting tasks go on), approve (proposed -> waiting),
// the auto-accept rules for agent proposals, and the QA list (ok, deviation with a fix task, evidence, auto).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueQuestion.test.ts, queueAnswer.test.ts, queueProposals.test.ts, queueQaEvidence.test.ts.
// =============================================================

import fs from 'node:fs';

import {
  a, autoAcceptContext, autoAcceptRules, autoCleanFocus, CLI, CONFIG, cut, die, edit, FOLDER, focusCleanOut, GIT_ROOT, L, positional,
  PR, queueBranchId, read, require, val, WIDTH,
} from './context.mjs';
import { guardWeakening, logWeakened } from './settings.mjs';
import { captureOn, draftFromAnswer, notFromTrack, writeProposal } from './catalog.mjs';
import { logEvent } from './events.mjs';

// The decision rows in the time log (section 7.1 of plans/autonomi-nivaa-utredning.md): one per answer, fail open.
const DROWS = require('./lib/decisionRows.js');

// catalog.captureAnswers (roadmap 0z Z-A): an answer can become a proposed design choice (resolve --keep).
const CAT = require('./lib/catalog.js');

// The intake triage's owner questions (close, keep, rewrite) are acted on in resolve.
const T = require('./lib/queueTriage.js');
// The checkpoint questions of staged plans (PG-4): Adjust and Stop park the rest.
const CP = require('./lib/checkpoint.js');
// A QA deviation is a defect after merge: a row in the finding log (lib/findingSources.js).
const FSRC = require('./lib/findingSources.js');

/** The values of a repeated flag (`--choice A --choice B`): the argument right after each occurrence. */
const repeated = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1] ?? ''] : []));

/** `ravenseat resolve` (the usage is at the top of queue.mjs). */
export function cmdResolve() {
  const sp = positional(1, ['--answer', '--by', '--choice']);
  if (!sp.length) die('resolve <question> [...] [--answer "..."] [--choice <n|text>] [--keep] [--early] [--by "..."]');
  // --keep: the answer also becomes a proposed design choice in the main tree's catalog. Checked before anything is
  // resolved, so a refusal (setting off, a track worktree) changes nothing.
  const keep = a.includes('--keep');
  if (keep) {
    captureOn(`${CLI} resolve --keep`);
    notFromTrack('propose (resolve --keep)');
  }
  // With a timestamp (and the answer, when given) in `resolutions`; the ids are in `resolved` as before. --choice picks
  // one of the question's choices (number or text); --answer is then a note after the choice.
  const answer = a.includes('--answer') ? (val('--answer') ?? '') : null;
  const choice = a.includes('--choice') ? (val('--choice') ?? '') : null;
  const r = edit((queue) => {
    const now = new Date().toISOString();
    // --early: answer a checkpoint (PG-4) before its stage is done; without it resolve refuses one that is still hidden.
    const s = L.resolve(queue, sp, { answer, choice, by: val('--by') ?? null, early: a.includes('--early'), now });
    if (s.error.length) die(`Nothing resolved:\n  ${s.error.join('\n  ')}`);
    // The answer (with a choice: the choice's text and the note) is written into the mission of every task that waits
    // on the question (idempotent).
    const added = L.ownerAnswerBonus(queue, sp, s.answer, now);
    // An answer to an intake triage question (lib/queueTriage.js): close, keep or rewrite, as the owner chose.
    const triage = s.answer == null ? [] : sp.map((q) => T.ownerChoice(queue, q, s.answer, { by: val('--by') ?? null, now })).filter(Boolean);
    // An answer to a checkpoint (lib/checkpoint.js): Continue lets the rest start, Adjust and Stop park it.
    const checkpoint =
      s.answer == null ? [] : sp.map((q) => CP.ownerChoice(queue, q, s.answer, { by: val('--by') ?? null, now })).filter(Boolean);
    // One decision row per answered question, and `category` and `followed` on its resolution (section 7.1). A resolve
    // without an answer (a condition marked met) is no decision. The rows are written after the save, below.
    const rows = s.answer == null ? [] : decisionRowsFor(queue, sp, { answer, choice, now });
    return { stored: s.answer, added, triage, checkpoint, rows };
  });
  logEvent(r.rows);
  const added = r.added;
  console.log(
    `Resolved: ${sp.join(', ')}${choice != null ? ` (choice: ${r.stored})` : answer != null ? ' (with answer)' : ''}`,
  );
  if (added.length)
    console.log(
      `The answer is added to the mission (OWNER_ANSWER bonus) for: ${[...new Set(added.map((x) => x.id))].join(', ')}. ` +
        'If a track is already running: send it with SendMessage.',
    );
  for (const t of r.triage) {
    if (t.error) console.log(`Triage ${t.id}: ${t.error}`);
    else if (t.action === 'close') console.log(`Triage ${t.id}: cancelled, as the owner chose (ravenseat undo does not apply; ravenseat set ${t.id} waiting puts it back).`);
    else if (t.action === 'keep') console.log(`Triage ${t.id}: kept; it can start (the next fill).`);
    else if (t.action === 'rewrite')
      console.log(`Triage ${t.id}: parked for a rewrite. Rewrite the mission (ravenseat edit ${t.id} --json '{"mission": "..."}'), then ravenseat continue ${t.id}.`);
    else console.log(`Triage ${t.id}: the answer is not one of the choices; act on it by hand (cancel, edit or continue).`);
  }
  for (const c of r.checkpoint) {
    const list = c.ids.join(', ');
    if (c.error) console.log(`Checkpoint ${c.sp}: ${c.error}`);
    else if (!c.ids.length) console.log(`Checkpoint ${c.sp}: no waiting task holds on it.`);
    else if (c.action === 'continue') console.log(`Checkpoint ${c.sp}: continue; ${list} can start (the next fill).`);
    else if (c.action === 'adjust')
      console.log(`Checkpoint ${c.sp}: parked for a rewrite: ${list}. Rewrite each mission (${CLI} edit <id> --json '{"mission": "..."}'), then ${CLI} continue <id>.`);
    else if (c.action === 'stop')
      console.log(`Checkpoint ${c.sp}: stopped; ${list} parked. Cancel them (${CLI} set <id> cancelled), or ${CLI} continue <id> to go on after all.`);
    else console.log(`Checkpoint ${c.sp}: the answer is not Continue, Adjust or Stop, so ${list} can start; park or cancel them by hand if that was not meant.`);
  }
  keepAnswers(sp, { keep, answered: r.stored != null });
}

/**
 * The decision rows for a machine card (approve, QA): one per id, bulk when there are several. Never throws.
 */
function machineRows(queue, ids, { verb, chosen, note = false, by = null }) {
  try {
    const now = new Date().toISOString();
    const surface = DROWS.surfaceOf(process.env);
    const bulk = ids.length > 1;
    return ids.map((id) =>
      DROWS.taskRow({ verb, task: queue.tasks.find((o) => o.id === id) ?? { id }, chosen, note, by, surface, bulk, now }),
    );
  } catch {
    return []; // error-ignored: measurement only
  }
}

/**
 * The decision rows for a resolve (lib/decisionRows.js), and `category` and `followed` on each resolution. Never throws:
 * a failure here costs the measurement, never the answer.
 */
function decisionRowsFor(queue, sp, { answer, choice, now }) {
  try {
    const by = val('--by') ?? null;
    const surface = DROWS.surfaceOf(process.env);
    const bulk = sp.length > 1;
    return sp.map((id) => {
      const q = queue.question?.[id] ?? null;
      const picked = choice != null ? L.pickChoice(q, choice).choice : null;
      const row = DROWS.resolveRow({
        sp: id,
        q,
        chosen: picked ?? answer,
        free: picked == null,
        note: picked != null && !!String(answer ?? '').trim(),
        by,
        surface,
        bulk,
        now,
      });
      const res = queue.resolutions?.[id];
      if (res) {
        res.category = row.category;
        res.followed = row.followed;
      }
      return row;
    });
  } catch {
    return []; // error-ignored: measurement only
  }
}

/**
 * After resolve: with --keep, each answered question becomes a proposed design choice (never accepted; the owner does
 * that). With catalog.captureAnswers suggest and no --keep, a question that reads like a lasting rule gets the line that
 * keeps it. A failed draft is one line: the answer is stored either way.
 */
function keepAnswers(sp, { keep, answered }) {
  const mode = CAT.setupOf(CONFIG).captureAnswers;
  if (!answered) {
    if (keep) console.log('KEEP: nothing to keep: resolve was given no answer.');
    return;
  }
  const queue = read();
  for (const q of sp) {
    if (!keep) {
      const words = [queue.question?.[q]?.text, queue.resolutions?.[q]?.answer].join(' ');
      if (mode === 'suggest' && CAT.looksLasting(words))
        console.log(`KEEP?: the answer to ${q} reads like a lasting rule. To keep it as a proposed design choice: ${CLI} catalog propose --from-answer ${q}`);
      continue;
    }
    try {
      const w = writeProposal(draftFromAnswer(queue, q));
      console.log(
        `KEEP: proposed ${w.id} from the answer to ${q} (${w.file}). Sharpen the invariant and the paths, then ` +
          `${CLI} catalog accept ${w.id} --by owner. Commit the file yourself.`,
      );
      for (const e of w.errors) console.log(`  ERROR  ${e}`);
    } catch (e) {
      console.log(`KEEP: the draft for ${q} was not written (${e?.message ?? e}); the answer is stored. ${CLI} catalog propose --from-answer ${q} tries again.`);
    }
  }
}

/** `ravenseat resolutions` (the usage is at the top of queue.mjs). */
export function cmdResolutions() {
  if (a.includes('--mark-logged')) {
    const sp = positional(1);
    const r = edit((queue) => {
      const s = L.markLogged(queue, sp);
      if (s.error.length) die(`Nothing marked:\n  ${s.error.join('\n  ')}`);
      return s;
    });
    console.log(`Entered in the decision log: ${r.marked.join(', ')}`);
  } else {
    const queue = read();
    const onlyUnlogged = a.includes('--unlogged');
    const rows = onlyUnlogged
      ? L.unlogged(queue)
      : Object.entries(queue.resolutions ?? {})
          .map(([sp, x]) => ({ sp, ...x }))
          .sort((x, y) => String(x.time).localeCompare(String(y.time)));
    if (!rows.length)
      console.log(
        onlyUnlogged ? 'No unlogged resolutions.' : 'No resolutions with a timestamp yet.',
      );
    for (const r of rows) {
      const q = queue.question?.[r.sp];
      const badge = r.answer == null ? 'without answer' : r.logged ? 'logged' : 'NOT LOGGED';
      console.log(`${r.sp}  ${r.time ?? '?'}  by ${r.by ?? '?'}  [${badge}]`);
      if (q?.text) console.log(`  ${q.type ?? 'question'}: ${q.text}`);
      for (const line of L.choiceLines(q)) console.log(`    ${line}`);
      if (r.answer != null) console.log(`  answer: ${r.answer}`);
      if (q?.source) console.log(`  source: ${q.source}`);
    }
    if (onlyUnlogged && rows.length)
      console.log(
        `\nEnter the answers in the decision log (and the plan the question is in), commit with --trailer "Queue: orchestrator", ` +
          `then: ravenseat resolutions --mark-logged ${rows.map((r) => r.sp).join(' ')}`,
      );
  }
}

/** `ravenseat question` (the usage is at the top of queue.mjs). */
export function cmdQuestion() {
  const file = val('--file');
  // The card fields (section 6.1 of plans/autonomi-nivaa-utredning.md): the flag and the field it sets.
  const card = [['--category', 'category'], ['--if-yes', 'if_yes'], ['--if-no', 'if_no']];
  const [id] = positional(1, ['--file', '--text', '--type', '--recommendation', '--context', '--source', '--choice', ...card.map((c) => c[0])]);
  const fields = ['--text', '--type', '--recommendation', '--context', '--source', '--choice', '--no-choices', ...card.map((c) => c[0])].some((f) =>
    a.includes(f),
  );
  if (file || id || fields) {
    if (!file && !id)
      die(
        'question <id> --text "..." --category <key> --context "..." --if-yes "..." --if-no "..." --recommendation "..." ' +
          '[--choice "..." (2-4 times) | --no-choices] [--type ...] [--source "..."]',
      );
    let input;
    if (file) input = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      // Only the fields that are given are passed on; the rest are kept.
      const field = {};
      for (const k of ['text', 'type', 'recommendation', 'context', 'source'])
        if (a.includes(`--${k}`)) field[k] = val(`--${k}`) ?? '';
      for (const [flag, k] of card) if (a.includes(flag)) field[k] = val(flag) ?? '';
      // Each --choice is one answer option (setQuestion checks 2-4, length and duplicates); --no-choices removes them.
      if (a.includes('--choice')) field.choices = repeated('--choice');
      else if (a.includes('--no-choices')) field.choices = null;
      input = { [id]: field };
    }
    // strict: a new plain question must carry the card (owner question 7); the branch says which track asked.
    const track = queueBranchId();
    const r = edit((queue) => {
      const s = L.setQuestion(queue, input, undefined, { strict: true, track });
      if (s.error.length) die(`Nothing changed (${s.error.length} error(s)):\n  ${s.error.join('\n  ')}`);
      return s;
    });
    if (!r.set.length) console.log('Nothing to set (empty object).');
    else console.log(`Question set (${r.set.length}): ${r.set.join(', ')}`);
  } else {
    const queue = read();
    const rows = L.questionOverview(queue);
    if (!rows.length) console.log('No owner questions in the queue.');
    for (const r of rows) {
      const waitingText = `${r.tasks.length} ${r.tasks.length === 1 ? 'task waiting' : 'tasks waiting'}`;
      // A checkpoint whose stage is not done (PG-4) is not shown to the owner yet.
      const status = r.resolved
        ? 'resolved'
        : r.hidden
          ? `checkpoint, opens when ${r.opens_after.join(', ')} ${r.opens_after.length === 1 ? 'is' : 'are'} done; ${waitingText}`
          : `open, ${waitingText}`;
      console.log(cut(`${r.sp}  [${r.type}; ${status}]`, WIDTH));
      console.log(
        `  ${cut(r.text ?? '(missing text: ravenseat question <id> --text "...")', WIDTH - 2)}`,
      );
      for (const line of L.choiceLines(r)) console.log(`    ${cut(line, WIDTH - 4)}`);
      if (r.category !== 'uncategorized') console.log(`  category: ${r.category}`);
      if (r.recommendation) console.log(`  ${cut(`recommendation: ${r.recommendation}`, WIDTH - 2)}`);
      if (r.context) console.log(`  ${cut(`context: ${r.context}`, WIDTH - 2)}`);
      if (r.if_yes) console.log(`  ${cut(`if you follow the recommendation: ${r.if_yes}`, WIDTH - 2)}`);
      if (r.if_no) console.log(`  ${cut(`if you choose something else: ${r.if_no}`, WIDTH - 2)}`);
      if (r.choices.length && !r.resolved)
        console.log(`  answer: ravenseat resolve ${r.sp} --choice <1-${r.choices.length}> [--answer "note"]`);
    }
  }
}

/** `ravenseat approve` (the usage is at the top of queue.mjs). */
export function cmdApprove() {
  const ids = positional(1, ['--by']);
  if (!ids.length) die('approve <id> [...] [--by "<who>"]');
  const by = val('--by') ?? null;
  const r = edit((queue) => {
    const answer = L.approve(queue, ids);
    // All or nothing: a write error in one id must not approve half the list.
    if (answer.error.length) die(`Nothing approved:\n  ${answer.error.join('\n  ')}`);
    // Who approved (the board and /ravenseat:decide pass --by owner), next to the time in `approved`.
    if (by) for (const o of queue.tasks) if (answer.approved.includes(o.id)) o.approved_by = by;
    return {
      ...answer,
      rows: machineRows(queue, answer.approved, { verb: 'approve', chosen: 'Approve', by }),
      batched: queue.tasks.filter((o) => answer.approved.includes(o.id) && L.isBatched(o)).map((o) => o.id),
      unsized: queue.tasks.filter((o) => answer.approved.includes(o.id) && PR.sizeNotSet(o)).map((o) => o.id),
    };
  });
  logEvent(r.rows);
  console.log(`Approved (waiting now): ${r.approved.join(', ')}`);
  // An imported issue has no size (lib/githubIssues.js taskFor): say so, with the command that sets one.
  for (const line of PR.sizeHint(r.unsized ?? [], CLI)) console.log(line);
  for (const id of r.batched)
    console.log(`${id} is in the batch queue, so it does not start alone: ravenseat batch packs it, ravenseat edit ${id} --json '{"batched":false}' lets it start by itself.`);
}

/** `ravenseat proposals` (the usage is at the top of queue.mjs). */
export function cmdProposals() {
  // ---- Auto-accept of agent proposals by the owner's rules (lib/queueProposals.js) ----
  const [under, arg] = positional(1, ['--classes', '--max-estimate', '--max-value', '--max', '--by']);
  const showRules = (queue) => {
    const rules = autoAcceptRules(queue);
    const ctx = { ...autoAcceptContext(queue), undone: PR.undoneIds(queue) };
    // Every proposal, also those the auto-accept rules would never take.
    const open = (queue.tasks ?? []).filter((o) => o.status === 'proposed');
    if (open.length) {
      console.log(`Proposals waiting (${open.length}; ravenseat approve <id> lets one start, ravenseat set <id> cancelled declines it):`);
      for (const o of open)
        console.log(
          `  ${o.id.padEnd(14)} ${o.added_by ? `from ${o.added_by}  ` : ''}${L.isBatched(o) ? '[batch queue]  ' : ''}` +
            `${PR.sizeNotSet(o) ? `[${PR.SIZE_NOT_SET}]  ` : ''}${o.title ?? ''}`,
        );
    }
    const fit = (queue.tasks ?? []).filter(
      (o) => o.status === 'proposed' && PR.autoAcceptDecision(o, { ...rules, enabled: true }, ctx).accept,
    );
    console.log(`Auto-accept of proposals: ${PR.rulesText(rules)}.`);
    console.log(
      `${fit.length} proposal(s) fit the rules now${fit.length ? `: ${fit.map((o) => o.id).join(', ')}` : ''}` +
        (rules.enabled ? ' (accepted at the next orchestrator pulse).' : ' (nothing is accepted while it is off).'),
    );
    console.log(
      'Never D or D+, never with waiting_on, legal/owner labels, a plan entry with open legal points or protected paths.',
    );
  };
  if (!under || (under === 'auto' && !arg && !['--classes', '--max-estimate', '--max-value'].some((f) => a.includes(f)))) {
    showRules(read());
  } else if (under === 'auto') {
    const change = {};
    if (arg) {
      if (arg !== 'on' && arg !== 'off') die('proposals auto [on|off] [--classes K,U] [--max-estimate <min|none>] [--max-value <1-10|none>] [--i-understand --by owner]');
      change.enabled = arg === 'on';
    }
    if (a.includes('--classes')) {
      const v = String(val('--classes') ?? '');
      change.classes = v === 'none' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
    }
    for (const [flag, field] of [
      ['--max-estimate', 'maxEstimateMin'],
      ['--max-value', 'maxValue'],
    ])
      if (a.includes(flag)) {
        const v = String(val(flag) ?? '');
        change[field] = v === 'none' || v === 'off' ? null : /^\d+$/.test(v) ? Number(v) : v;
      }
    const error = PR.rulesError(change);
    if (error.length) die(`Nothing changed:\n  ${error.join('\n  ')}`);
    edit((queue) => {
      // Turning auto-accept on weakens a guard: the same rule as `settings set proposals.autoAccept.enabled on`
      // (cli/settings.mjs guardWeakening), checked under the lock against the value now.
      if (change.enabled !== undefined) {
        const g = guardWeakening('proposals.autoAccept.enabled', change.enabled, {
          now: autoAcceptRules(queue).enabled,
          raw: arg,
          confirmWith: `${CLI} proposals auto ${arg}`,
        });
        if (g.weak) logWeakened(g.row, g.now, change.enabled, g.by);
      }
      const own = queue.proposals?.autoAccept ?? {};
      queue.proposals = { ...(queue.proposals ?? {}), autoAccept: { ...own, ...change } };
    });
    showRules(read());
  } else if (under === 'log') {
    const queue = read();
    if (a.includes('--json')) console.log(JSON.stringify(queue.auto_accepted ?? [], null, 2));
    else {
      const lines = PR.logLines(queue, { max: Number(val('--max')) || 50 });
      console.log(lines.length ? lines.join('\n') : 'Nothing has been auto-accepted.');
    }
  } else if (under === 'undo') {
    if (!arg) die('proposals undo <id>');
    edit((queue) => {
      const f = PR.undoAutoAccept(queue, arg);
      if (f) die(`Nothing changed: ${f}.`);
    });
    console.log(`${arg} is back to proposed (ravenseat approve ${arg} approves it by hand). It is never auto-accepted again.`);
  } else {
    die('proposals [auto [on|off] [--classes K,U] [--max-estimate <min|none>] [--max-value <1-10|none>] | log [--json] | undo <id>]');
  }
}

/** `ravenseat qa` (the usage is at the top of queue.mjs). */
export function cmdQa() {
  // ---- Visual QA: only the owner sets qa ok / qa deviation (qa auto --run closes green auto evidence) ----
  const under = a[1];
  if (!under) {
    const queue = read();
    // Split by evidence (config().qa): what the owner looks at (also entries without evidence) grouped as before, the
    // manual types in one manual round, and the auto types that qa auto --run closes.
    const split = L.qaSplit(queue);
    const groups = split.look;
    const count = groups.reduce(
      (n, p) => n + p.features.reduce((m, f) => m + f.tasks.length, 0),
      0,
    );
    const total = count + split.manual.length + split.auto.length;
    if (!total) console.log('The QA list is empty.');
    else console.log(`QA list: ${total} finished task(s) waiting on QA.\n`);
    const ageFor = (o) => (o.done ? `done ${L.ageText(Date.now() - Date.parse(o.done))} ago` : '');
    for (const p of groups) {
      console.log(cut(`${p.pid}${p.title ? `  ${p.title}` : ''}`, WIDTH));
      for (const f of p.features) {
        console.log(`  ${cut(f.feature, WIDTH - 2)}`);
        for (const o of f.tasks) {
          console.log(`    ${o.id.padEnd(12)} ${ageFor(o)} · ${L.evidenceText(o.evidence)}`);
          console.log(`      ${cut(`look for: ${o.title}`, WIDTH - 6)}`);
        }
      }
    }
    if (split.manual.length) {
      console.log(`\nManual round (${split.manual.length}): check them together, by hand.`);
      for (const o of split.manual)
        console.log(`  ${o.id.padEnd(12)} ${cut(L.evidenceText(o.evidence), WIDTH - 15)}`);
    }
    if (split.auto.length) {
      console.log(
        `\nClosed automatically when the command is green (${split.auto.length}): ${CLI} qa auto --run`,
      );
      for (const o of split.auto)
        console.log(`  ${o.id.padEnd(12)} ${cut(L.evidenceText(o.evidence), WIDTH - 15)}`);
    }
    if (total)
      console.log(
        '\nApprove: ravenseat qa ok <id...> · deviation: ravenseat qa deviation <id> "<what is wrong, and where>"',
      );
  } else if (under === 'evidence') {
    // Sets the evidence on a task by hand (receive otherwise reads it from the EVIDENCE line in track-result.md).
    const [id, spec] = positional(2);
    const qa = L.qaConfig();
    if (!id || !spec)
      die(`qa evidence <id> <type>[=<ref>[,<ref>...]] (type: ${qa.evidenceTypes.join(', ')})`);
    const p = L.parseEvidence(`EVIDENCE ${spec}`);
    if (!p || p.error) die(p?.error ?? 'invalid evidence');
    const r = edit((queue) => {
      const o = queue.tasks.find((x) => x.id === id);
      if (!o) die(`Unknown task ${id}`);
      o.evidence = p.evidence;
      return o;
    });
    console.log(`${id}: evidence ${L.evidenceText(r.evidence)}`);
  } else if (under === 'auto') {
    // QA entries with an auto evidence type (config().qa.autoTypes). Without --run only the list; with --run the
    // configured command (qa.autoCommand) runs from the project root per entry, and the green ones are closed
    // (qa_ok_by "auto"). Red stays in the QA list with a remark.
    const chosen = positional(2);
    const run = a.includes('--run');
    const candidates = L.qaSplit(read()).auto.filter((o) => !chosen.length || chosen.includes(o.id));
    if (!candidates.length) console.log('No QA entries with auto evidence are waiting.');
    for (const o of candidates) {
      if (!run) {
        console.log(`${o.id.padEnd(12)} ${L.evidenceText(o.evidence)}`);
        continue;
      }
      const k = L.evidenceCommand(o);
      if (k.error) die(k.error);
      // The evidence command runs what the track delivered: the same scrubbed environment as the gates (lib/gateEnv.js),
      // and the same budget as a track's own gate run (gates.timeoutSec, null = baseGate.timeoutSec, 900 s), through
      // lib/treeRun.js, which ends the whole process tree at the budget (ARK-1 T3). A run over it is red.
      const budgetSec = Number(CONFIG.gates?.timeoutSec) || Number(CONFIG.baseGate?.timeoutSec) || 900;
      const s = require('./lib/treeRun.js').runBounded(k.command, {
        cwd: GIT_ROOT,
        timeoutMs: budgetSec * 1000,
        spawn: require('./lib/gateEnv.js').trackCodeSpawn(process.env, { storeFile: require('./lib/gateEvidence.js').storeFile(FOLDER), root: GIT_ROOT }),
      });
      const green = s.status === 0 && !s.timedOut;
      const redText = s.timedOut ? `timed out after ${budgetSec} s` : `exit ${s.status ?? '?'}`;
      edit((queue) => {
        const u = L.qaAutoOutcome(queue, o.id, green);
        if (u.error) die(u.error);
        return u;
      });
      console.log(
        `${o.id.padEnd(12)} ${green ? 'green, QA ok (auto)' : `red (${redText}), stays in the QA list`} · ${L.evidenceText(o.evidence)}`,
      );
    }
    if (candidates.length && !run) console.log(`\nRun and close the green ones: ${CLI} qa auto --run [<id...>]`);
  } else if (under === 'ok') {
    const ids = positional(2, ['--by']);
    if (!ids.length) die('qa ok <id> [...] [--by "<who>"]');
    const by = val('--by') ?? null;
    const r = edit((queue) => {
      const s = L.qaOk(queue, ids);
      // All or nothing, like approve.
      if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
      // Who said QA ok (qa auto --run sets "auto"; the board and /ravenseat:decide pass --by owner).
      if (by && by !== 'auto') for (const o of queue.tasks) if (s.ok.includes(o.id)) o.qa_ok_by = by;
      // B18: QA on the last done task in a focus step was the step's last rest, so the focus is cleaned in the SAME
      // write (queueLogic.cleanFocus, as receive, set and fill do): a step with nothing left leaves the focus, and a
      // focus with nothing left gets its owner question now, not at the next fill. An error here never stops qa ok.
      autoCleanFocus(queue, `qa ok ${s.ok.join(' ')}`);
      return { ...s, rows: machineRows(queue, s.ok, { verb: 'check', chosen: 'QA ok', by }) };
    });
    logEvent(r.rows);
    console.log(`QA ok: ${r.ok.join(', ')}`);
    focusCleanOut();
  } else if (under === 'deviation') {
    const [id, text] = positional(2, ['--by']);
    if (!id || !text) die('qa deviation <id> "<what is wrong, and where>"');
    const r = edit((queue) => {
      const s = L.qaDeviation(queue, id, text);
      if (s.error) die(s.error);
      // The deviation's text stays out of the row (it can name people); `note` says there was one.
      return { ...s, rows: machineRows(queue, [id], { verb: 'check', chosen: 'Deviation', note: true, by: val('--by') ?? null }) };
    });
    logEvent(r.rows);
    // The ids only: the owner's text can name people or customers, and the fix task's mission already holds it.
    FSRC.record(() => FSRC.qaDeviation({ id, fixId: r.fix.id }));
    console.log(
      `${id}: QA deviation. Fix task ${r.fix.id} is added to the queue (${r.fix.status}, class K, ${r.fix.project ?? L.WITHOUT_PROJECT}${r.fix.feature ? ` / ${r.fix.feature}` : ''}).`,
    );
  } else {
    die(
      'qa [ok <id...> | deviation <id> "<text>" | evidence <id> <type>[=<ref>] | auto [--run] [<id...>]]',
    );
  }
}
