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
import { spawnSync } from 'node:child_process';

import {
  a, autoAcceptContext, autoAcceptRules, CLI, cut, die, edit, FOLDER, GIT_ROOT, L, positional, PR, read, require, val, WIDTH,
} from './context.mjs';

// The intake triage's owner questions (close, keep, rewrite) are acted on in resolve.
const T = require('./lib/queueTriage.js');

/** The values of a repeated flag (`--choice A --choice B`): the argument right after each occurrence. */
const repeated = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1] ?? ''] : []));

/** `ravenseat resolve` (the usage is at the top of queue.mjs). */
export function cmdResolve() {
  const sp = positional(1, ['--answer', '--by', '--choice']);
  if (!sp.length) die('resolve <question> [...] [--answer "..."] [--choice <n|text>] [--by "..."]');
  // With a timestamp (and the answer, when given) in `resolutions`; the ids are in `resolved` as before. --choice picks
  // one of the question's choices (number or text); --answer is then a note after the choice.
  const answer = a.includes('--answer') ? (val('--answer') ?? '') : null;
  const choice = a.includes('--choice') ? (val('--choice') ?? '') : null;
  const r = edit((queue) => {
    const now = new Date().toISOString();
    const s = L.resolve(queue, sp, { answer, choice, by: val('--by') ?? null, now });
    if (s.error.length) die(`Nothing resolved:\n  ${s.error.join('\n  ')}`);
    // The answer (with a choice: the choice's text and the note) is written into the mission of every task that waits
    // on the question (idempotent).
    const added = L.ownerAnswerBonus(queue, sp, s.answer, now);
    // An answer to an intake triage question (lib/queueTriage.js): close, keep or rewrite, as the owner chose.
    const triage = s.answer == null ? [] : sp.map((q) => T.ownerChoice(queue, q, s.answer, { by: val('--by') ?? null, now })).filter(Boolean);
    return { stored: s.answer, added, triage };
  });
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
  const [id] = positional(1, ['--file', '--text', '--type', '--recommendation', '--source', '--choice']);
  const fields = ['--text', '--type', '--recommendation', '--source', '--choice', '--no-choices'].some((f) =>
    a.includes(f),
  );
  if (file || id || fields) {
    if (!file && !id)
      die(
        'question <id> --text "..." [--type ...] [--recommendation "..."] [--source "..."] ' +
          '[--choice "..." (2-4 times) | --no-choices]',
      );
    let input;
    if (file) input = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      // Only the fields that are given are passed on; the rest are kept.
      const field = {};
      for (const k of ['text', 'type', 'recommendation', 'source'])
        if (a.includes(`--${k}`)) field[k] = val(`--${k}`) ?? '';
      // Each --choice is one answer option (setQuestion checks 2-4, length and duplicates); --no-choices removes them.
      if (a.includes('--choice')) field.choices = repeated('--choice');
      else if (a.includes('--no-choices')) field.choices = null;
      input = { [id]: field };
    }
    const r = edit((queue) => {
      const s = L.setQuestion(queue, input);
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
      const status = r.resolved
        ? 'resolved'
        : `open, ${r.tasks.length} ${r.tasks.length === 1 ? 'task waiting' : 'tasks waiting'}`;
      console.log(cut(`${r.sp}  [${r.type}; ${status}]`, WIDTH));
      console.log(
        `  ${cut(r.text ?? '(missing text: ravenseat question <id> --text "...")', WIDTH - 2)}`,
      );
      for (const line of L.choiceLines(r)) console.log(`    ${cut(line, WIDTH - 4)}`);
      if (r.recommendation) console.log(`  ${cut(`recommendation: ${r.recommendation}`, WIDTH - 2)}`);
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
    return answer;
  });
  console.log(`Approved (waiting now): ${r.approved.join(', ')}`);
}

/** `ravenseat proposals` (the usage is at the top of queue.mjs). */
export function cmdProposals() {
  // ---- Auto-accept of agent proposals by the owner's rules (lib/queueProposals.js) ----
  const [under, arg] = positional(1, ['--classes', '--max-estimate', '--max-value', '--max']);
  const showRules = (queue) => {
    const rules = autoAcceptRules(queue);
    const ctx = { ...autoAcceptContext(queue), undone: PR.undoneIds(queue) };
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
      if (arg !== 'on' && arg !== 'off') die('proposals auto [on|off] [--classes K,U] [--max-estimate <min|none>] [--max-value <1-10|none>]');
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
      // The evidence command runs what the track delivered: the same scrubbed environment as the gates (lib/gateEnv.js).
      const s = spawnSync(k.command, {
        cwd: GIT_ROOT,
        env: require('./lib/gateEnv.js').trackCodeEnv(process.env, { storeFile: require('./lib/gateEvidence.js').storeFile(FOLDER), root: GIT_ROOT }).env,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        windowsHide: true,
      });
      const green = s.status === 0;
      edit((queue) => {
        const u = L.qaAutoOutcome(queue, o.id, green);
        if (u.error) die(u.error);
        return u;
      });
      console.log(
        `${o.id.padEnd(12)} ${green ? 'green, QA ok (auto)' : `red (exit ${s.status ?? '?'}), stays in the QA list`} · ${L.evidenceText(o.evidence)}`,
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
      return s;
    });
    console.log(`QA ok: ${r.ok.join(', ')}`);
  } else if (under === 'deviation') {
    const [id, text] = positional(2);
    if (!id || !text) die('qa deviation <id> "<what is wrong, and where>"');
    const r = edit((queue) => {
      const s = L.qaDeviation(queue, id, text);
      if (s.error) die(s.error);
      return s;
    });
    console.log(
      `${id}: QA deviation. Fix task ${r.fix.id} is added to the queue (${r.fix.status}, class K, ${r.fix.project ?? L.WITHOUT_PROJECT}${r.fix.feature ? ` / ${r.fix.feature}` : ''}).`,
    );
  } else {
    die(
      'qa [ok <id...> | deviation <id> "<text>" | evidence <id> <type>[=<ref>] | auto [--run] [<id...>]]',
    );
  }
}
