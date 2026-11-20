// =============================================================
// cli/planInbox.mjs: quick capture into the plan register's Inbox (P6 of the Plans rework).
//
//   ravenseat plan capture "<title>" [--text "..."] [--file <json>] [--dry] [--json]
//        a plan in the Inbox with only a title (the text is optional): id from the title, project general (created on
//        first use, as `ravenseat finding` does), priority later set by the owner, maturity idea, and the tool-owned
//        `inbox` marker. --file reads { title, text } (the board's "+ New plan" uses it, so the text never goes on a
//        command line). The same title again while it still waits in the Inbox writes nothing (`duplicate` in --json).
//        One changelog entry: `ravenseat plan undo` takes it back (the board's Undo sends --nr).
//   ravenseat plan inbox [--json]
//        the captured plans that wait to be sorted, oldest first, with Claude's proposal in words when there is one.
//
// P7, enrichment and confirmation (lib/planProposal.js):
//   ravenseat plan propose <id> --file <json> [--dry] [--json]
//        Claude's suggestion for an Inbox item ({ project, priority, now_category, priority_reason, maturity, size,
//        summary, sources, merge, outline }), stored in the tool-owned `proposal` field. Changes nothing else; the
//        owner confirms on the board. Refused with plans.inboxTriage off. With plans.inboxAutoApply on (off by
//        default) a captured plan's proposal that keeps later and names no merge is applied at once (`applied`).
//   ravenseat plan accept <id> [--file <edits.json>] --set-by owner [--expect-changed <iso>] [--json]
//        the owner's Accept ("Edit then accept" sends the edits): applies the proposal in one change, clears the inbox
//        marker and the proposal.
//   ravenseat plan decline <id> [--reason "..."] --set-by owner [--expect-changed <iso>] [--json]
//        the owner's Decline: drops the plan with the reason.
//   ravenseat plan merge <id> --into <PL-X> --set-by owner [--expect-changed <iso>] [--json]
//        the owner's Merge: the item goes into PL-X (plan combine), its text stays in the archive.
// Accept, decline and merge refuse without --set-by owner: nothing is applied without the owner. Each is one changelog
// entry, so `plan undo` (the board's Undo) takes it back.
//
// The rules are in lib/planInbox.js and lib/planProposal.js. The write goes through cli/planShared.mjs editPlans: the
// same lock, --expect-changed (exit 6), changelog and undo as every plan command.
//
// Used by: cli/plans.mjs (plan capture, inbox, propose, accept, decline, merge), cli/orchestrator.mjs and cli/view.mjs
// (the INBOX line).
// Tested in: lib/__tests__/planInbox.test.ts, lib/__tests__/planProposal.test.ts.
// =============================================================

import fs from 'node:fs';

import {
  a, byName, CLI, CONFIG, cut, die, editLogged, KK, L, readPlans, readQueueForPlan, require, val, WIDTH,
} from './context.mjs';
import { editPlans, existsSource, planAnswer, planError, planRole } from './planShared.mjs';
import { notBuildingLines } from './notBuilding.mjs';

const I = require('./lib/planInbox.js');
const R = require('./lib/planProposal.js');

/** The P7 settings (plans.inboxTriage, plans.inboxAutoApply), checked by queueConfig.plansView. */
const plansSettings = () => KK.plansView(CONFIG);

/** The INBOX line for pulse and show, or null; never throws (an unreadable plans.json is not this view's problem). */
export function inboxLineNow() {
  try {
    return I.inboxLine(I.inboxSummary(readPlans(), readQueueForPlan().tasks ?? []), CLI, {
      triage: plansSettings().inboxTriage,
    });
  } catch {
    return null;
  }
}

/** A JSON file from --file, or `fallback` without one; a file that cannot be read is a clear refusal. */
function jsonFile(fallback) {
  const file = val('--file');
  if (file == null) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return planError([`could not read ${file}: ${e.message}`], 1);
  }
}

/** The id after the sub-command, or the usage. */
function idArg(usage) {
  const id = a[2];
  if (!id || id.startsWith('--')) die(usage);
  return id;
}

/** The context the proposal rules get from queue.json and the flags. */
const ruleCtx = (q) => ({
  role: planRole(),
  by: byName(),
  tasks: q.tasks ?? [],
  projects: q.projects ?? {},
  question: q.question ?? {},
  existsPath: existsSource,
});

/** `ravenseat plan propose <id> --file <json>`. */
export function planPropose(json) {
  const usage = `Use: ${CLI} plan propose <id> --file <json> [--dry] [--json]`;
  const id = idArg(usage);
  if (val('--file') == null) die(usage);
  const raw = jsonFile(null);
  const s = plansSettings();
  const r = editPlans('plan propose', (reg, q) =>
    R.writeProposal(reg, id, raw, { ...ruleCtx(q), triage: s.inboxTriage, autoApply: s.inboxAutoApply }),
  );
  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        dry: Boolean(r.dry),
        applied: r.applied === true,
        changes: r.changes,
        warnings: r.warnings ?? [],
        log: r.log,
        changed: r.version,
      }),
    );
    return;
  }
  planAnswer(
    r,
    r.applied
      ? `Applied the proposal for ${id} at once (plans.inboxAutoApply is on)`
      : `Proposal saved for ${id}; it waits for the owner's Accept on the board (nothing else changed)`,
  );
}

/** `ravenseat plan accept <id> [--file <edits.json>] --set-by owner`. */
export function planAccept() {
  const id = idArg(`Use: ${CLI} plan accept <id> [--file <edits.json>] --set-by owner [--expect-changed <iso>] [--json]`);
  const edits = jsonFile({});
  const r = editPlans('plan accept', (reg, q) => R.acceptProposal(reg, id, edits, ruleCtx(q)));
  planAnswer(r, `Accepted ${id}: it has left the inbox`);
}

/** `ravenseat plan decline <id> [--reason "..."] --set-by owner`. */
export function planDecline() {
  const id = idArg(`Use: ${CLI} plan decline <id> [--reason "..."] --set-by owner [--expect-changed <iso>] [--json]`);
  const reason = val('--reason') ?? jsonFile({})?.reason ?? null;
  const r = editPlans('plan decline', (reg, q) => R.declineProposal(reg, id, { reason }, ruleCtx(q)));
  planAnswer(r, `Declined ${id}: it is dropped`);
}

/** `ravenseat plan merge <id> --into <PL-X> --set-by owner`. */
export function planMerge() {
  const usage = `Use: ${CLI} plan merge <id> --into <PL-X> --set-by owner [--expect-changed <iso>] [--json]`;
  const id = idArg(usage);
  const to = val('--into');
  if (!to) die(usage);
  const r = editPlans('plan merge', (reg, q) => R.mergeProposal(reg, id, to, ruleCtx(q)));
  planAnswer(r, `Merged ${id} into ${to} (its text is in the archive)`);
}

/** The title and text from --file (the board) or the arguments. */
function input() {
  const file = val('--file');
  if (file != null) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      planError([`could not read ${file}: ${e.message}`], 1);
    }
    return { title: raw?.title, text: raw?.text ?? null };
  }
  const title = a[2] && !a[2].startsWith('--') ? a[2] : '';
  return { title, text: val('--text') ?? null };
}

/** `ravenseat plan capture`. */
export function planCapture(json) {
  const usage = `Use: ${CLI} plan capture "<title>" [--text "..."] [--file <json>] [--dry] [--json]`;
  const c = I.captureInput(input());
  if (c.error.length) {
    if (json) planError(c.error, 1);
    die(`${c.error.join('\n')}\n${usage}`);
  }
  const dry = a.includes('--dry');
  // The first capture also registers the project general, so a captured plan is valid like any other. A separate
  // write to queue.json (its own changelog), as `ravenseat finding` does; --dry writes nothing.
  const projects = readQueueForPlan().projects ?? {};
  const missing = !Object.hasOwn(projects, I.PROJECT);
  if (missing && !dry)
    editLogged('project', (q) => {
      const made = L.newRegister(q.projects, { [I.PROJECT]: I.PROJECT_FIELDS }, q.areas);
      if (made.error.length) die(`Nothing changed:\n  ${made.error.join('\n  ')}`);
      q.projects = made.register;
    });
  const r = editPlans('plan capture', (reg, q) =>
    I.capturePlan(
      reg,
      c,
      { projects: missing && dry ? { ...(q.projects ?? {}), [I.PROJECT]: I.PROJECT_FIELDS } : (q.projects ?? {}), question: q.question ?? {} },
    ),
  );
  // "Not building" (roadmap 0f, notBuilding.match): a captured plan that reads like an entry the owner chose not to
  // build gets one INFO line. Advice only: the plan is captured either way.
  const notBuilding = r.entry ? notBuildingLines([{ id: r.entry.id, text: [c.title, c.text].filter(Boolean).join(' ') }]) : [];
  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        dry: Boolean(r.dry),
        changes: r.changes,
        warnings: r.warnings ?? [],
        log: r.log,
        changed: r.version,
        entry: r.entry ? { id: r.entry.id, title: r.entry.title } : null,
        ...(r.duplicate ? { duplicate: r.duplicate } : {}),
        ...(notBuilding.length ? { notBuilding } : {}),
      }),
    );
    return;
  }
  if (r.duplicate) {
    console.log(`Already in the inbox as ${r.duplicate}: nothing written.`);
    return;
  }
  console.log(`${r.dry ? 'Preview (nothing written): ' : ''}Added ${r.entry.id} to the inbox: ${r.entry.title}`);
  for (const x of r.warnings ?? []) console.log(`WARNING: ${x}`);
  for (const x of notBuilding) console.log(x);
  if (r.log) console.log(`Changelog no. ${r.log} in plans.json; undo: ${CLI} plan undo`);
}

/** `ravenseat plan inbox [--json]`. */
export function planInbox(json) {
  const q = readQueueForPlan();
  const rows = I.inboxRows(readPlans(), q.tasks ?? [], q.projects ?? {});
  if (json) {
    console.log(JSON.stringify({ ok: true, rows }));
    return;
  }
  if (!rows.length) {
    console.log(`The inbox is empty. Capture a plan with: ${CLI} plan capture "<title>" [--text "..."]`);
    return;
  }
  for (const r of rows) {
    console.log(cut(`${r.id.padEnd(24)} ${String(r.at ?? '').slice(0, 10)}  ${r.title}`, WIDTH));
    if (r.summary) console.log(cut(`${' '.repeat(26)}${r.summary.replace(/\s+/g, ' ')}`, WIDTH));
    console.log(cut(`${' '.repeat(26)}${r.suggests ?? 'No proposal yet.'}`, WIDTH));
  }
  console.log(
    `Sort: Claude writes a proposal with ${CLI} plan propose <id> --file <json> (the /plans skill, "/plans inbox"); ` +
      'the owner confirms each one on the board (Accept, Edit, Decline, Merge).',
  );
}
