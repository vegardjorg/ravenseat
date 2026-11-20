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
//        the captured plans that wait to be sorted, oldest first.
// The rules are in lib/planInbox.js. The write goes through cli/planShared.mjs editPlans: the same lock, changelog and
// undo as every plan command.
//
// Used by: cli/plans.mjs (plan capture, plan inbox), cli/orchestrator.mjs and cli/view.mjs (the INBOX line).
// Tested in: lib/__tests__/planInbox.test.ts.
// =============================================================

import fs from 'node:fs';

import { a, CLI, cut, die, editLogged, L, readPlans, readQueueForPlan, require, val, WIDTH } from './context.mjs';
import { editPlans, planError } from './planShared.mjs';

const I = require('./lib/planInbox.js');

/** The INBOX line for pulse and show, or null; never throws (an unreadable plans.json is not this view's problem). */
export function inboxLineNow() {
  try {
    return I.inboxLine(I.inboxSummary(readPlans(), readQueueForPlan().tasks ?? []), CLI);
  } catch {
    return null;
  }
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
  if (r.log) console.log(`Changelog no. ${r.log} in plans.json; undo: ${CLI} plan undo`);
}

/** `ravenseat plan inbox [--json]`. */
export function planInbox(json) {
  const rows = I.inboxRows(readPlans(), readQueueForPlan().tasks ?? []);
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
  }
  console.log(
    `Sort: ${CLI} plan prioritize <id> now|owner|drop, ${CLI} plan edit <id> --field maturity=investigated, ` +
      `or --field inbox=null to keep it as it is.`,
  );
}
