// =============================================================
// cli/plans.mjs: the plan command: the plan register (plans.json), see docs/plan-register.md.
//
// planCommand dispatches the plan sub-commands (show, get, new, edit, prioritize, prioritize-many, combine, drop,
// verify, undo, capture, inbox, propose, accept, decline, merge, rules, check, modules, backup, active, doc, shape,
// checkpoint, postcheck and challenge); the rules are in lib/queuePlan.js (the plan gate in lib/planGate.js,
// lib/checkpoint.js, lib/planPostCheck.js and lib/devilsAdvocate.js).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queuePlan.test.ts, queuePlanDoc.test.ts, queuePlanMap.test.ts, queuePlanWork.test.ts, queueFeatures.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import {
  a, byName, CLI, cut, die, gitRead, P, readPlans, readQueueForPlan, require, val, values, WIDTH, withLock, writePlans,
} from './context.mjs';
import {
  editPlans, existsSource, forFlag, planAnswer, planDiffLines, planError, planRole, planRow, readDoc, SOURCE_ROOT,
} from './planShared.mjs';
import { planActive, planBackup, planCheck, planModules } from './planCheck.mjs';
import { planDoc } from './planDoc.mjs';
import { planAccept, planCapture, planDecline, planInbox, planMerge, planPropose } from './planInbox.mjs';
import { catalogSetup, decisionIds } from './catalog.mjs';
import { readTimeLog } from './tracks.mjs';

/** The design choice ids for the plan link warning (catalog.planLinks), or undefined: then only the shape is checked. */
const linkIds = () => (catalogSetup().planLinks ? (decisionIds() ?? undefined) : undefined);

// The light plan gate (lib/planGate.js, PG-1..PG-3): the settings, the source reader and the accepted zones, read once.
const G = require('./lib/planGate.js');
function decisionGateNow() {
  const setup = G.gateSetup(require('./lib/queueConfig.js').config());
  let zonesFor = Object.assign(() => [], { empty: true });
  try {
    zonesFor = require('./lib/catalogZones.js').zonesOnDisk();
  } catch {
    // error-ignored: a zone only raises attention; without the catalog the size rule still applies
  }
  const zonesOf = (entry, tasks) => G.planZones(entry, tasks, zonesFor);
  return {
    setup,
    zonesOf,
    state: (entry, tasks) => G.decisionState(entry, { readDoc, zones: zonesOf(entry, tasks), on: setup.decisionNote }),
    forTasks: (tasks) =>
      G.readyGate({ mode: setup.readyCheck, on: setup.decisionNote, readDoc, zonesFor: (e) => zonesOf(e, tasks) }),
  };
}

/**
 * `plan shape --tasks <n> [--zones D-0001,…] [--plan <id>] [--json]` (PG-2): the shape-first question for a request,
 * or "no question". /add-to-queue runs it after estimating the split, so the threshold and the setting live in one
 * place. Read-only.
 */
function planShape(json) {
  const setup = G.gateSetup(require('./lib/queueConfig.js').config());
  const n = Number(val('--tasks'));
  if (!Number.isInteger(n) || n < 0) die('plan shape --tasks <n> [--zones D-0001,...] [--plan <PL-id>] [--json]');
  const zones = String(val('--zones') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const q = G.shapeQuestion({ tasks: n, zones, plan: val('--plan') ?? null }, setup);
  if (json) {
    console.log(JSON.stringify({ ok: true, nudge: setup.nudge, threshold: setup.threshold, question: q }));
    return;
  }
  if (!q) {
    console.log(`No question (shape.nudge ${setup.nudge}, threshold ${setup.threshold}): add as asked.`);
    return;
  }
  console.log(q.mode === 'always-shape' ? `Shape it first (shape.nudge always-shape): ${q.why}.` : q.text);
  q.choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}${c.record ? ` (tasks get "shaped": "${c.record}")` : ''}`));
}

/**
 * `plan checkpoint [--plan <id>] [--smallest] [--stage <id,id>] [--success "<measure>"] [--json]` (PG-4,
 * lib/checkpoint.js): whether /add-to-queue should stage the work (a gated plan, or the "smallest version first"
 * answer), and with --stage the CP-<plan> question to put under "question" in the add file. Read-only.
 */
function planCheckpoint(json) {
  const CP = require('./lib/checkpoint.js');
  const { mode } = CP.checkpointSetup(require('./lib/queueConfig.js').config());
  const planId = val('--plan') ?? null;
  let entry = null;
  let zones = [];
  if (planId) {
    entry = (readPlans().entries ?? []).find((p) => p.id === planId) ?? null;
    if (!entry) die(`plan checkpoint: unknown plan entry ${planId} (ravenseat plan show)`);
    zones = decisionGateNow().zonesOf(entry, readQueueForPlan().tasks ?? []);
  }
  const offer = CP.stagingOffer({ mode, entry, zones, smallest: a.includes('--smallest') });
  const stage = String(val('--stage') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const cp = offer.offer && stage.length ? CP.checkpointQuestion({ plan: planId, stage, success: val('--success') ?? null }) : null;
  if (cp?.error.length) die(`plan checkpoint: ${cp.error.join('; ')}`);
  if (json) {
    console.log(JSON.stringify({ ok: true, mode, offer, checkpoint: cp ? { id: cp.id, question: cp.question } : null }));
    return;
  }
  console.log(offer.text);
  offer.choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
  if (!offer.offer) return;
  if (!cp) {
    console.log('Then: ravenseat plan checkpoint --stage <stage-1 ids> [--plan <id>] [--success "..."] --json gives the question.');
    return;
  }
  console.log(`Register under "question" in the add file, and put "${cp.id}" in waiting_on of every task after stage 1:`);
  console.log(JSON.stringify({ [cp.id]: cp.question }, null, 2));
}

/**
 * `plan postcheck [--json]` (PG-6, lib/planPostCheck.js): the built plans with the size estimate against the tasks and
 * fix rounds, the estimate against the measured time and the cost, and the accuracy record per size. Read-only; the
 * success question itself is registered by `set <id> done`.
 */
function planPostcheck(json) {
  const PC = require('./lib/planPostCheck.js');
  if (!PC.postCheckSetup(require('./lib/queueConfig.js').config()).on) {
    if (json) console.log(JSON.stringify({ ok: true, on: false, rows: [], accuracy: [] }));
    else console.log('The plan follow-up is off (plans.postCheck false).');
    return;
  }
  const TK = require('./lib/timeCost.js');
  const queue = readQueueForPlan();
  const s = PC.section({
    entries: readPlans().entries ?? [],
    queue,
    events: TK.usageEvents(readTimeLog()),
    measureFor: (e) => PC.decisionMeasure(e, readDoc),
  });
  if (json) {
    console.log(JSON.stringify({ ok: true, on: true, ...s }));
    return;
  }
  if (!s.rows.length) {
    console.log('No built plan yet: a plan shows here once every queue task of it is done.');
    return;
  }
  const h = (m) => (m == null ? '-' : `${Math.round((m / 60) * 10) / 10} h`);
  console.log(`Built plans (${s.total}), the last finished first:`);
  for (const r of s.rows)
    console.log(
      `  ${r.id} ${r.size ?? 'no size'}: ${r.estimate_tasks == null ? 'no estimate' : `estimated ${r.estimate_tasks} tracks`}, ` +
        `${r.tasks} tasks + ${r.fix_rounds} fix rounds; estimate ${h(r.estimate_min)}, measured ${h(r.measured_min)}; ` +
        `${r.usd == null ? 'no cost measured' : `$${r.usd.toFixed(2)}`}` +
        (r.question ? `; success: ${r.success ?? `not answered (${r.question})`}` : ''),
    );
  console.log('Per size:');
  for (const g of s.accuracy)
    console.log(
      `  ${g.size ?? 'no size'}: ${g.plans} plan(s), ` +
        (g.estimate_tasks == null ? 'no estimate' : `estimated ${g.estimate_tasks}, actual ${g.actual_avg} on average (${g.ratio} x)`) +
        (g.time_ratio == null ? '' : `; time ${g.time_ratio} x the estimate`) +
        (g.asked ? `; success met ${g.met}, partly ${g.partly}, not met ${g.not_met} of ${g.asked}` : ''),
    );
}

/**
 * `plan challenge <id> [--answer <file>] [--json]` (PG-7, lib/devilsAdvocate.js): with plans.devilsAdvocate on and an
 * XL or zone plan, the brief for one reviewer-challenger run (the decision section and the code, not the
 * investigation). With --answer, the agent's answer is checked (three objections, one cheapest test) and appended under
 * the decision section in the plan's document. Off, or a plan that is not XL and meets no zone: nothing.
 */
function planChallenge(json) {
  const DA = require('./lib/devilsAdvocate.js');
  const id = a[2];
  if (!id || id.startsWith('--')) die('plan challenge <id> [--answer <file>] [--json]');
  const { on } = DA.setup(require('./lib/queueConfig.js').config());
  const entry = (readPlans().entries ?? []).find((p) => p.id === id) ?? null;
  if (!entry) die(`plan challenge: unknown plan entry ${id} (ravenseat plan show)`);
  const tasks = readQueueForPlan().tasks ?? [];
  const o = DA.offer({ on, entry, zones: decisionGateNow().zonesOf(entry, tasks) });
  if (!o.offer) {
    if (json) console.log(JSON.stringify({ ok: true, on, offer: o, brief: null }));
    else console.log(o.text);
    return;
  }
  const source = (entry.sources ?? []).find((k) => k?.role === G.ROLE);
  const text = source ? readDoc(source.path) : null;
  const part = typeof text === 'string' ? G.sectionLines(text, source.anchor) : null;
  if (!part)
    die(
      `plan challenge: ${id} has no readable decision section (a source with role decision; ${CLI} plan get ${id}). ` +
        'Write it first (/plans, step 3b).',
    );
  const answerFile = val('--answer');
  if (!answerFile) {
    // The code the plan's tasks change, so the challenger reads the same code the plan would touch.
    const code = [...new Set(P.queueTasksFor(entry, tasks).flatMap((t) => [...(t.owned_files ?? []), ...(t.shared_patch ?? [])]))].slice(0, 30);
    const b = DA.brief({ entry, section: part.lines.join('\n'), code });
    if (json) {
      console.log(JSON.stringify({ ok: true, on, offer: o, agent: DA.AGENT, brief: b }));
      return;
    }
    console.log(o.text);
    console.log(`\nBrief for one ${DA.AGENT} agent (read only). Save its answer to a file, then: ${CLI} plan challenge ${id} --answer <file>\n`);
    console.log(b);
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(answerFile, 'utf8');
  } catch (e) {
    die(`plan challenge: cannot read ${answerFile} (${e.message})`);
  }
  const answer = DA.parseAnswer(raw);
  if (answer.error.length) die(`plan challenge: the answer is not usable: ${answer.error.join('; ')}. Nothing was written.`);
  const r = DA.appendBlock(text, source.anchor ?? null, answer);
  if (r.error) die(`plan challenge: ${r.error}. Nothing was written.`);
  // The same guard as the reading (planShared.readDoc): a source path inside the source root, never a symlink.
  const full = path.resolve(SOURCE_ROOT, source.path);
  if (P.sourcePathError(source.path) || path.relative(SOURCE_ROOT, full).startsWith('..') || fs.lstatSync(full).isSymbolicLink())
    die(`plan challenge: ${source.path} cannot be written. Nothing was written.`);
  fs.writeFileSync(full, r.text);
  if (json) {
    console.log(JSON.stringify({ ok: true, on, written: source.path, objections: answer.objections, test: answer.test }));
    return;
  }
  console.log(`Appended the devil's advocate (3 objections and the cheapest test) under ${source.path}${source.anchor ? ` ${source.anchor}` : ''}.`);
  console.log('It changes nothing by itself: weigh it with the owner before the plan goes to ready.');
}

export function planCommand() {
  const under = a[1];
  const json = a.includes('--json');
  if (under === 'show') {
    const queue = readQueueForPlan();
    const reg = readPlans();
    const filter = {
      module: val('--module') ?? null,
      project: val('--project') ?? null,
      priority: values('--priority'),
      maturity: values('--maturity'),
      search: val('--search') ?? null,
      all: a.includes('--all'),
    };
    for (const p of filter.priority)
      if (!P.PRIORITIES.includes(p)) die(`unknown priority ${p} (${P.PRIORITIES.join(', ')})`);
    for (const m of filter.maturity)
      if (!P.MATURITIES.includes(m)) die(`unknown maturity ${m} (${P.MATURITIES.join(', ')})`);
    const entries = P.filterEntries(reg, queue, filter);
    const hidden =
      filter.all || filter.priority.includes('drop')
        ? 0
        : reg.entries.filter((p) => p.priority === 'drop').length;
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          changed: reg.changed ?? null,
          entries,
          hidden_drop: hidden,
          activeOnes: P.activeEntries(reg),
        }),
      );
      return;
    }
    if (!reg.entries.length) {
      console.log('The plan register is empty. Add entries with: ravenseat plan new --file <json>');
      return;
    }
    let previous = null;
    for (const p of entries) {
      const group = `${p.module ?? '(without area)'} / ${p.project}`;
      if (group !== previous) console.log(`\n${group}`);
      previous = group;
      console.log(`  ${planRow(p)}`);
    }
    console.log(
      `\n${entries.length} of ${reg.entries.length} entries${hidden ? `; ${hidden} dropped are hidden (--all)` : ''}.`,
    );
  } else if (under === 'get') {
    const sortKey = a[2];
    if (!sortKey || sortKey.startsWith('--')) die('plan get <id|project|module> [--json]');
    const queue = readQueueForPlan();
    const r = P.get(readPlans(), queue, sortKey, { existsPath: existsSource });
    if (r.error.length) planError(r.error);
    // The decision section's state (PG-1): only for the plans that expect one (L, XL or a zone).
    const gate = decisionGateNow();
    for (const p of r.entries) {
      const d = gate.state(p, queue.tasks ?? []);
      if (d.state !== 'not-needed') p.decision = d;
    }
    if (json) {
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    console.log(
      `${r.type} ${r.sortKey}${r.title ? `: ${r.title}` : ''} (${r.entries.length} entries)`,
    );
    console.log(`Copy: ${r.copy}`);
    for (const p of r.entries) {
      console.log(`\n${planRow(p)}`);
      if (p.summary) console.log(`  ${p.summary}`);
      if (p.priority_reason)
        console.log(`  Priority (${p.priority_set_by}): ${p.priority_reason}`);
      if (p.drop_reason) console.log(`  Dropped: ${p.drop_reason}`);
      const decision = G.decisionLine(p.decision);
      if (decision) console.log(`  ${decision}`);
      // The GitHub issue (GH-2), the link built from the stored repo and number (lib/issueLink.js).
      const issue = require('./lib/issueLink.js').issueView(p.issue);
      if (issue) console.log(`  ${issue.label} ${issue.url}`);
      if (p.agent_boost)
        console.log(`  Lifted by agent ${p.agent_boost.at} (was ${p.agent_boost.from.priority})`);
      if (p.measured_rule && p.measured_rule.priority !== p.priority)
        console.log(
          `  Rule ${p.measured_rule.nr} (${p.measured_rule.name}) points to ${p.measured_rule.priority}: ${p.measured_rule.reason}`,
        );
      for (const k of p.sources)
        console.log(
          `  source ${k.path}${k.anchor ? ` ${k.anchor}` : ''}${k.role ? ` (${k.role})` : ''}${k.exists === false ? '  DOES NOT EXIST' : ''}`,
        );
      if (p.queue.length)
        console.log(`  queue: ${p.queue.map((o) => `${o.id} ${o.status ?? '?'}`).join(', ')}`);
      for (const s of p.ownerQuestion)
        console.log(
          `  owner question ${s.id}${s.resolved ? ' (resolved)' : ''}${s.text ? `: ${cut(s.text, WIDTH - 20)}` : ''}`,
        );
      if (p.depends_on?.length) console.log(`  depends on: ${p.depends_on.join(', ')}`);
      if (p.decisions?.length) console.log(`  design choices: ${p.decisions.join(', ')} (ravenseat catalog show <id>)`);
      if (p.blocks.length) console.log(`  blocks: ${p.blocks.join(', ')}`);
      if (p.verified)
        console.log(
          `  verified ${p.verified.date} by ${p.verified.by}${p.verified.commit ? ` (${p.verified.commit})` : ''}: ${p.verified.findings}`,
        );
      if (p.legal) console.log(`  legal: ${cut(JSON.stringify(p.legal), WIDTH - 12)}`);
    }
  } else if (under === 'new') {
    const file = val('--file');
    if (!file) die('plan new --file <json> [--dry] [--json] [--set-by agent|owner]');
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(content) ? content : [content];
    const role = planRole();
    const ids = linkIds();
    const r = editPlans('plan new', (reg, queue) => {
      const error = [];
      const warnings = [];
      const newOnes = [];
      for (const input of list) {
        const s = P.newEntry(reg, input, {
          role,
          projects: queue.projects ?? {},
          question: queue.question ?? {},
          existsPath: existsSource,
          decisionIds: ids,
        });
        error.push(...s.error);
        warnings.push(...s.warnings);
        if (s.entry) newOnes.push(s.entry.id);
      }
      return { error, warnings, newOnes };
    });
    planAnswer(r, `${r.newOnes.length} new plan entr(ies): ${r.newOnes.join(', ')}`);
  } else if (under === 'edit') {
    const id = a[2];
    if (!id || id.startsWith('--'))
      die('plan edit <id> [--field name=val ...] [--set \'{"field":...}\'] [--dry] [--json]');
    const t = P.parseFieldArg(values('--field'));
    if (t.error.length) die(t.error.join('\n'));
    let field = t.field;
    if (val('--set') != null) {
      let s;
      try {
        s = JSON.parse(val('--set'));
      } catch (e) {
        die(`--set is not valid JSON: ${e.message}`);
      }
      field = { ...field, ...s };
    }
    const role = planRole();
    // A recorded skip of the decision section (PG-3): who and when come from the tool, the reason from the caller.
    if (a.includes('--skip-decision')) {
      const reason = String(val('--skip-decision') ?? '').trim();
      if (!reason || reason.startsWith('--')) die('--skip-decision needs a reason: --skip-decision "<one sentence>"');
      field = { ...field, decision_skip: { reason, at: new Date().toISOString(), by: role } };
    }
    if (!Object.keys(field).length)
      die("no field to edit (--field name=val, --set '{...}' or --skip-decision \"<reason>\")");
    const ids = linkIds();
    const gate = decisionGateNow();
    const r = editPlans('plan edit', (reg, queue) =>
      P.editEntry(reg, id, field, {
        role,
        by: byName(),
        projects: queue.projects ?? {},
        question: queue.question ?? {},
        existsPath: existsSource,
        decisionIds: ids,
        decisionGate: gate.forTasks(queue.tasks ?? []),
      }),
    );
    planAnswer(
      r,
      `Changed ${id}${r.boost ? ' (lifted to now/security by rule 1; shown in the inbox)' : ''}`,
    );
  } else if (under === 'prioritize') {
    const pos = forFlag(2);
    const priority = pos.pop();
    if (!pos.length || !priority)
      die(
        'plan prioritize <id...> <now|owner|later|drop> [--category security for-prod important] [--reason "..."] [--dry] [--json]',
      );
    const role = planRole();
    const r = editPlans('plan prioritize', (reg, queue) =>
      P.prioritize(
        reg,
        pos,
        { priority, category: values('--category'), reason: val('--reason') ?? null },
        {
          role,
          by: byName(),
          projects: queue.projects ?? {},
          question: queue.question ?? {},
          existsPath: existsSource,
        },
      ),
    );
    planAnswer(
      r,
      `Priority ${priority}: ${r.changed.length} changed${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ''}` +
        `${r.boost.length ? `; lifted by rule 1: ${r.boost.join(', ')}` : ''}`,
    );
  } else if (under === 'prioritize-many') {
    // The whole draft from the priority map in one write (one lock, one changelog entry, one undo).
    const file = val('--file');
    if (!file)
      die(
        'plan prioritize-many --file <json> [--dry] [--expect-changed <iso>] [--set-by agent|owner] [--json]',
      );
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      planError([`could not read ${file}: ${e.message}`], 1);
    }
    const role = planRole();
    const r = editPlans('plan prioritize-many', (reg, queue) =>
      P.prioritizeMany(reg, list, {
        role,
        by: byName(),
        projects: queue.projects ?? {},
        question: queue.question ?? {},
        existsPath: existsSource,
      }),
    );
    planAnswer(
      r,
      `Priorities: ${r.changed.length} changed${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ''}` +
        `${r.boost.length ? `; lifted by rule 1: ${r.boost.join(', ')}` : ''}`,
    );
  } else if (under === 'combine') {
    const pos = forFlag(2);
    const [to, ...from] = pos;
    if (!to || !from.length) die('plan combine <to-id> <from-id...> [--dry] [--json]');
    const r = editPlans('plan combine', (reg) => P.combineTogether(reg, to, from));
    planAnswer(r, `Combined ${from.join(', ')} into ${to} (the others are in the archive)`);
  } else if (under === 'verify') {
    const id = a[2];
    if (!id || id.startsWith('--') || val('--findings') == null)
      die('plan verify <id> --findings "..." [--commit <sha>] [--dry] [--json]');
    const commit =
      val('--commit') ?? (String(gitRead(['rev-parse', '--short', 'HEAD']) ?? '').trim() || null);
    const role = planRole();
    const r = editPlans('plan verify', (reg, queue) =>
      P.verify(
        reg,
        id,
        { findings: val('--findings'), commit, role },
        { projects: queue.projects ?? {}, question: queue.question ?? {}, existsPath: existsSource },
      ),
    );
    planAnswer(r, `Verified ${id}`);
  } else if (under === 'undo') {
    // Like `queue.mjs undo`, but for the plan register's own changelog.
    const textFor = (p) =>
      `no. ${p.nr} ${p.action} by ${p.by} ${p.at} (${p.changes.length} field(s))`;
    const nrError = (reg) => {
      if (val('--nr') == null) return null;
      const last = P.lastUndoable(reg);
      return last && String(last.nr) === String(val('--nr'))
        ? null
        : `the last change that can be undone is ${last ? `no. ${last.nr}` : 'none'}, not no. ${val('--nr')}; nothing undone`;
    };
    if (a.includes('--show')) {
      const reg = readPlans();
      const nf = nrError(reg);
      const s = nf ? { error: [nf], entry: P.lastUndoable(reg) } : P.undo(reg, { show: true });
      if (json)
        console.log(JSON.stringify({ ok: !s.error.length, error: s.error, entry: s.entry ?? null }));
      else {
        if (s.entry) console.log(`Last undoable: ${textFor(s.entry)}`);
        console.log(
          s.error.length
            ? `Can NOT be undone now:\n  ${s.error.join('\n  ')}`
            : 'Can be undone (ravenseat plan undo).',
        );
      }
      return;
    }
    const r = withLock(() => {
      const reg = readPlans();
      const fe = P.expectCheck(reg, val('--expect-changed') ?? null);
      if (fe) planError([fe], fe.startsWith('invalid') ? 1 : 6);
      const nf = nrError(reg);
      const s = nf ? { error: [nf] } : P.undo(reg, { by: byName() });
      if (s.error.length) planError(s.error);
      writePlans(reg);
      return s;
    });
    if (json) console.log(JSON.stringify({ ok: true, entry: r.entry }));
    else {
      console.log(`Undone ${textFor(r.entry)}:`);
      for (const l of planDiffLines(
        r.entry.changes.map((e) => ({ ...e, before: e.after, after: e.before })),
      ))
        console.log(`  ${l}`);
    }
  } else if (under === 'capture') {
    // Quick capture into the Inbox (cli/planInbox.mjs, lib/planInbox.js): only a title is needed.
    planCapture(json);
  } else if (under === 'inbox') {
    planInbox(json);
  } else if (under === 'propose') {
    // P7: Claude's proposal for an Inbox item (lib/planProposal.js); it changes nothing else.
    planPropose(json);
  } else if (under === 'accept') {
    // P7: the owner's Accept, Decline and Merge (refused without --set-by owner).
    planAccept();
  } else if (under === 'decline') {
    planDecline();
  } else if (under === 'merge') {
    planMerge();
  } else if (under === 'active') {
    planActive(json);
  } else if (under === 'rules') {
    if (json) console.log(JSON.stringify({ ok: true, rules: P.PRIORITY_RULES }));
    else
      for (const r of P.PRIORITY_RULES)
        console.log(
          `${r.nr}. ${r.name} → ${r.priority}${r.categories.length ? `/${r.categories.join(' or ')}` : ''}: ${r.matches}`,
        );
  } else if (under === 'check') {
    planCheck(json);
  } else if (under === 'modules') {
    planModules(json);
  } else if (under === 'backup') {
    planBackup();
  } else if (under === 'doc') {
    planDoc(json);
  } else if (under === 'shape') {
    planShape(json);
  } else if (under === 'checkpoint') {
    planCheckpoint(json);
  } else if (under === 'postcheck') {
    planPostcheck(json);
  } else if (under === 'challenge') {
    planChallenge(json);
  } else {
    die(
      'Use: ravenseat plan <show|get|new|edit|prioritize|prioritize-many|combine|verify|undo|capture|inbox|propose|accept|decline|merge|active|rules|check|modules|backup|doc|shape|checkpoint|postcheck|challenge> ...  (see the top of the file)',
      under ? 1 : 0,
    );
  }
}
