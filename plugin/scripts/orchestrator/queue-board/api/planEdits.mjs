// =============================================================
// queue-board/api/planEdits.mjs: the Plans room row edits.
//
// The Plans room row edits: POST /api/plan-capture ("+ New plan"), /api/plan-proposal (accept, decline, merge on an
// Inbox row), /api/plan-bulk (multi select and change in the row), /api/plan-undo and /api/lawyerPackage.
//
// Moved out of queue-board.mjs unchanged (SPLIT-1). A handler that needs the server takes its context `ctx` first:
// the live paths and caches as getters (demo mode switches them), the data builders and the write plumbing
// (writeTools.mjs). A POST handler also gets `c`, the per-call tools write() builds (no, run, queueNow, info).
// planEditRoutes(ctx) binds them, so queue-board.mjs calls them with the old arguments.
//
// Used by: queue-board.mjs (write()).
// Tested in: lib/__tests__/queueBoardPlansCapture.test.ts, queueBoardPlansTriage.test.ts, queuePlanWork.test.ts and queuePlanLegal.test.ts.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { errorText } from './writeTools.mjs';
import { planWriteAnswer, expectValid } from './plans.mjs';

const require = createRequire(import.meta.url);
const INBOX = require('../../lib/planInbox.js');
const P = require('../../lib/queuePlan.js');
const PRIVACY = require('../../lib/queuePlanView.js');
const PROPOSALS = require('../../lib/planProposal.js');
const QARCH = require('../../lib/queueArchive.js');

// ---- Quick capture ("+ New plan", P6 of the Plans rework) ----------------------------------------------------
// POST /api/plan-capture { title, text? }. Saved at once, without a preview: a capture only adds an entry to the Inbox
// (lib/planInbox.js), and the answer's `log` is what "Undo" sends to POST /api/plan-undo { nr }. The write goes via
// queue.mjs plan capture (same lock, changelog and undo), with the text in a temporary file so it never goes on a
// command line. The same title again while it waits in the Inbox writes nothing (`duplicate`). No --expect-changed:
// adding never conflicts with a change made meanwhile, and the CLI picks a free id under the lock; a refusal still
// comes back as 409 (planWriteAnswer). Off with features.plans.inbox.
async function planCapture(ctx, b) {
  const { FEATURES, queueJson, tmpDir } = ctx;
  const no = (message, status = 400) => ({ status, answer: { ok: false, message } });
  if (!FEATURES.plans || !FEATURES['plans.inbox'])
    return no('Quick capture is off (features.plans.inbox in queue.config.json).', 403);
  const c = INBOX.captureInput(b);
  if (c.error.length) return no(c.error.join('\n'));
  const tmp = path.join(tmpDir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ title: c.title, text: c.text }));
  try {
    const r = await queueJson(['plan', 'capture', '--file', tmp, '--json', '--by', 'theBoard']);
    const id = r.data?.entry?.id ?? null;
    const dup = r.data?.duplicate ?? null;
    const out = planWriteAnswer(
      r,
      `plan capture ${id ?? ''}`.trim(),
      dup ? `Already in the inbox as ${dup}.` : 'Added to the inbox. Claude sorts it the next time plans are worked on.',
    );
    if (out.answer.ok) Object.assign(out.answer, { id, duplicate: dup });
    return out;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---- Confirming Claude's proposals (P7 of the Plans rework) ------------------------------------------------------
// POST /api/plan-proposal { action: accept|decline|merge, id, edits?, reason?, to?, expect }. The owner's click on an
// Inbox row: lib/planProposal.js boardCall checks the body and gives the call (queue.mjs plan accept|decline|merge with
// --set-by owner and --by theBoard, so nothing is applied without the owner's click). Saved at once (one changelog
// entry; the answer's `log` is what Undo sends to POST /api/plan-undo), with --expect-changed from the register the
// owner looked at, so a session that changed it meanwhile gives 409 with outdated: true (planWriteAnswer). The edits
// and the reason go in a temporary file, never on a command line. Off with features.plans.inbox.
async function planProposal(ctx, b) {
  const { FEATURES, queueJson, tmpDir } = ctx;
  const no = (message, status = 400) => ({ status, answer: { ok: false, message } });
  if (!FEATURES.plans || !FEATURES['plans.inbox'])
    return no('The Inbox is off (features.plans.inbox in queue.config.json).', 403);
  const c = PROPOSALS.boardCall(b);
  if (c.error.length) return no(c.error.join('\n'));
  const tmp = c.file ? path.join(tmpDir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`) : null;
  if (tmp) fs.writeFileSync(tmp, JSON.stringify(c.file));
  const done = {
    accept: `Accepted: ${c.id} has left the inbox.`,
    decline: `Declined: ${c.id} is dropped.`,
    merge: `Merged ${c.id} into ${b.to}.`,
  };
  try {
    const r = await queueJson(c.args(tmp));
    const out = planWriteAnswer(r, `plan ${c.action} ${c.id}`, done[c.action]);
    // there is no preview here: the owner looked at the row, so the 409 says that
    if (out.answer.outdated)
      out.answer.message = 'The plan register has changed since you looked. The board shows it again; check the row and try once more.';
    return out;
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

// ---- Multi select and change in the row -----------------------------------------------------------
// POST /api/plan-bulk { action, ids, priority?, category?, reason?, project?, maturity?, to?, dry, expect }.
// The calls are made and checked by queuePlanView.planBulkCall (always queue.mjs, with the owner option and --by theBoard). dry =
// preview (--dry on every call). Otherwise the calls are written one after the other with --expect-changed from
// the preview (and then from the previous call); if one fails, the written ones are undone newest first (`plan undo --nr`), so
// the save becomes all or nothing. The response has the changelog numbers (`log`), which POST /api/plan-undo { nr } undoes.
async function planBulk(ctx, b) {
  const { queueJson } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const { error, call } = PRIVACY.planBulkCall(b);
  if (error.length) return no(error.join('\n'));
  if (!expectValid(b.expect)) return no('invalid expect');
  const what = `plan ${b.action} (theBoard, ${call.length} call)`;
  const log = (ok) => console.log(`${new Date().toLocaleTimeString('en-GB')} ${what}: ${ok}`);
  if (b.dry === true) {
    const changes = [];
    const warnings = [];
    const errorOut = [];
    let changed = null;
    for (const args of call) {
      const r = await queueJson([...args, '--dry']);
      if (r.data?.ok === true) {
        changes.push(...(r.data.changes ?? []));
        warnings.push(...(r.data.warnings ?? []));
        if (changed == null) changed = r.data.changed ?? null;
      } else errorOut.push(errorText(r, `queue.mjs ${args[1]} failed`));
    }
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        changed,
        changes,
        warnings,
        error: errorOut,
        can: !errorOut.length,
      },
    };
  }
  const written = [];
  let version = b.expect == null ? null : String(b.expect);
  for (const args of call) {
    const r = await queueJson([...args, ...(version ? ['--expect-changed', version] : [])]);
    if (r.ok && r.data?.ok === true) {
      if (r.data.log != null) written.push(r.data.log);
      version = r.data.changed ?? version;
      continue;
    }
    const outdated = r.code === 6 || r.data?.outdated === true;
    const notUndone = [];
    for (const nr of [...written].reverse()) {
      const a = await queueJson(['plan', 'undo', '--nr', String(nr), '--json', '--by', 'theBoard']);
      if (!(a.ok && a.data?.ok === true)) {
        notUndone.push(nr);
        break;
      }
    }
    log(`failed${written.length ? `, undone ${written.length - notUndone.length}` : ''}`);
    const reason = outdated
      ? 'The plan register has changed since the preview. Review and preview again.'
      : errorText(r, `queue.mjs ${args[1]} failed`);
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: notUndone.length
          ? `${reason}\nSomething was saved and could not be undone automatically (changelog no. ${written.join(', ')}). Use ravenseat plan undo.`
          : reason,
      },
    };
  }
  log('ok');
  return {
    status: 200,
    answer: {
      ok: true,
      log: written,
      message: `Saved: ${PRIVACY.bulkText(b, { projects: ctx.planCache?.data?.projects ?? {} })}.`,
    },
  };
}

async function planUndo(ctx, b) {
  const { queueJson } = ctx;
  const { error, call } = PRIVACY.undoCall(b.nr);
  if (error.length) return { status: 400, answer: { ok: false, message: error.join('\n') } };
  let undone = 0;
  for (const args of call) {
    const r = await queueJson(args);
    if (!(r.ok && r.data?.ok === true)) {
      console.log(
        `${new Date().toLocaleTimeString('en-GB')} plan undo (board): failed after ${undone}`,
      );
      return {
        status: 409,
        answer: {
          ok: false,
          undone,
          message: `${errorText(r, 'ravenseat plan undo failed')}${undone ? ` (${undone} of ${call.length} are undone)` : ''}`,
        },
      };
    }
    undone += 1;
  }
  console.log(`${new Date().toLocaleTimeString('en-GB')} plan undo (board): ${undone}`);
  return {
    status: 200,
    answer: {
      ok: true,
      undone,
      message: `Undone (${undone === 1 ? 'one change' : `${undone} changes`}).`,
    },
  };
}

// The lawyer package. dry = preview (the text, and whether the file already exists); otherwise the draft is written
// atomically to the path queuePlan.lawyerPackage gives (relative to the main tree). A file that exists with other content
// is replaced only with `replace: true`. The file is a draft from the plan register: nothing is sent anywhere, and
// the plan register does not change (it is written only via queue.mjs).
function lawyerPackageWrite(ctx, b) {
  if (typeof P.lawyerPackage !== 'function')
    return { status: 404, answer: { ok: false, message: 'The lawyer package does not exist in this version.' } };
  const reg = fs.existsSync(ctx.PLAN_FILE)
    ? P.normalize(JSON.parse(fs.readFileSync(ctx.PLAN_FILE, 'utf8')))
    : P.emptyRegister();
  const queue = fs.existsSync(ctx.FILE) ? QARCH.withArchive(JSON.parse(fs.readFileSync(ctx.FILE, 'utf8')), ctx.FOLDER) : {};
  const pk = P.lawyerPackage(reg, queue, { now: new Date() });
  const file = path.join(ctx.SOURCE_ROOT, ...pk.path.split('/'));
  const folder = path.dirname(file);
  // Path guard: the path must lie inside the main tree, and neither the folder nor the file can be a symlink (then the write could
  // end up somewhere else).
  if (!path.resolve(file).startsWith(path.resolve(ctx.SOURCE_ROOT) + path.sep))
    return { status: 400, answer: { ok: false, message: `${pk.path}: outside the project.` } };
  for (const x of [folder, file])
    if (fs.existsSync(x) && fs.lstatSync(x).isSymbolicLink())
      return {
        status: 400,
        answer: { ok: false, message: `${pk.path}: symlinks are not written to.` },
      };
  const exists = fs.existsSync(file);
  const equal = exists && fs.readFileSync(file, 'utf8') === pk.text;
  if (b.dry === true)
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        path: pk.path,
        text: pk.text,
        points: pk.points,
        exists,
        equal,
      },
    };
  if (exists && !equal && b.replace !== true)
    return {
      status: 409,
      answer: {
        ok: false,
        confirm: true,
        message: `${pk.path} already exists with other content (maybe edited by hand). Replace it?`,
      },
    };
  fs.mkdirSync(folder, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, pk.text);
  require('../../lib/stateFile.js').renameWithRetry(tmp, file);
  const n = pk.points.length;
  console.log(`${new Date().toLocaleTimeString('en-GB')} lawyerPackage ${pk.path}: ${n} points`);
  return {
    status: 200,
    answer: {
      ok: true,
      path: pk.path,
      points: pk.points,
      message: `The lawyer package is saved in ${pk.path} (${n} ${n === 1 ? 'point' : 'points'}). It has not been sent.`,
    },
  };
}

/** The handlers bound to the server's context (queue-board.mjs builds ctx once and calls them with the old arguments). */
export function planEditRoutes(ctx) {
  return {
    planCapture: (...args) => planCapture(ctx, ...args),
    planProposal: (...args) => planProposal(ctx, ...args),
    planBulk: (...args) => planBulk(ctx, ...args),
    planUndo: (...args) => planUndo(ctx, ...args),
    lawyerPackageWrite: (...args) => lawyerPackageWrite(ctx, ...args),
  };
}
