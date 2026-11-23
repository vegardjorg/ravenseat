// =============================================================
// queue-board/api/writeTools.mjs: the write plumbing every POST route shares.
//
// The write plumbing every POST route shares: queueMjs (runs queue.mjs, in demo mode confined to the demo folder),
// tmpDir, oneAtATime (the write chain: writes run one at a time), the input checks (idOrNull, pidOrNull, cleanText),
// editMany, queueJson and editManyJson, spaceArgs and errorText, and the guard rules before a write (guard, and the
// weakening rule needsWeakenConfirm and weakenCheck).
//
// Moved out of queue-board.mjs unchanged (SPLIT-1). A handler that needs the server takes its context `ctx` first:
// the live paths and caches as getters (demo mode switches them), the data builders and the write plumbing
// (writeTools.mjs). A POST handler also gets `c`, the per-call tools write() builds (no, run, queueNow, info).
// writeTools(ctx) binds them, so queue-board.mjs calls them with the old arguments.
//
// Used by: queue-board.mjs (puts the bound tools on ctx for every route module).
// Tested in: lib/__tests__/queueBoardServe.test.ts and the other board tests that start the server.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DEMO = require('../../lib/demoMode.js');
const KK = require('../../lib/queueConfig.js');
const SV = require('../../lib/settingsView.js');
const T = require('../../lib/queueBoard.js');

// ---- queue.mjs (all writing) ---------------------------------------------------------------------------------------
function queueMjs(ctx, args) {
  const { DEMO_PATHS, QUEUE_MJS, REAL, ROOT } = ctx;
  // Demo mode: the run gets the demo folder as its whole world (lib/demoMode.js childEnv: every QUEUE_* path there,
  // git locked out, no tokens) and its cwd there. The folder and every path are checked again first, so a link planted
  // since demo mode started cannot send the write anywhere else.
  let place = { cwd: ROOT, env: process.env };
  if (ctx.demoOn) {
    const safe = DEMO.checkRoot(REAL.FOLDER);
    const loose = DEMO.unconfinedVariables(DEMO_PATHS);
    if (!safe.ok || loose.length)
      return Promise.resolve({ ok: false, code: -1, out: '', error: safe.message ?? `Not in demo mode: ${loose.join(', ')} would point outside the demo folder.` });
    place = { cwd: DEMO_PATHS.root, env: DEMO.childEnv(process.env, DEMO_PATHS) };
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [QUEUE_MJS, ...args],
      // RAVENSEAT_SURFACE: the decision rows in the time log (lib/decisionRows.js) say the answer came from the board.
      { cwd: place.cwd, env: { ...place.env, RAVENSEAT_SURFACE: 'board' }, timeout: 30_000, windowsHide: true, maxBuffer: 4 << 20 },
      (err, out, error) => {
        resolve({
          ok: !err,
          // The exit code: 6 = the queue has changed since the preview (--expect-changed).
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          out: String(out ?? '').trim(),
          error: String(error ?? '').trim(),
        });
      },
    );
  });
}

/**
 * Where the board puts the temporary input files it hands to queue.mjs (--file): the system temp folder, or in demo mode
 * <dataFolder>/demo/tmp, so a demo write leaves nothing outside the demo folder. Throws when that place is not safe.
 */
function tmpDir(ctx) {
  const { DEMO_PATHS } = ctx;
  if (!ctx.demoOn) return os.tmpdir();
  const c = DEMO.confined(DEMO_PATHS.root, path.join(DEMO_PATHS.tmp, 'x'));
  if (!c.ok) throw new Error(`Not in demo mode: the demo folder is not safe (${c.reason})`);
  fs.mkdirSync(DEMO_PATHS.tmp, { recursive: true });
  return DEMO_PATHS.tmp;
}

// Writes run one at a time, so a move is always computed from the queue as it is after the previous write.
let chain = Promise.resolve();
function oneAtATime(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => undefined);
  return p;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const PID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idOrNull = (x) => (x == null ? null : ID.test(String(x)) ? String(x) : undefined);
const pidOrNull = (x) => (x == null ? null : PID.test(String(x)) ? String(x) : undefined);
// A text that starts with "-" would be read by queue.mjs as a flag; control characters (except line breaks) are removed.
const cleanText = (x, max) =>
  String(x ?? '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/^-+\s*/, '')
    .slice(0, max);

/** Runs edit-many with the content in a temporary file (all or nothing), and cleans up the file afterwards. */
async function editMany(ctx, content, run, what, extra = []) {
  const tmp = path.join(tmpDir(ctx), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(content));
  try {
    return await run(['edit-many', '--file', tmp, ...extra], what);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Runs a queue.mjs command that answers with one JSON line (--json). `data` is the last line parsed, or
 * null when the response was not JSON (then the error is in `error`/`out`).
 */
async function queueJson(ctx, args) {
  const r = await queueMjs(ctx, args);
  let data = null;
  try {
    data = JSON.parse(r.out.split('\n').filter(Boolean).pop() ?? '');
  } catch {
    data = null;
  }
  return { ...r, data };
}

/** edit-many with the content in a temporary file and the response as JSON (all or nothing); the file is cleaned up afterwards. */
async function editManyJson(ctx, content, extra) {
  const tmp = path.join(tmpDir(ctx), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(content));
  try {
    return await queueJson(ctx, ['edit-many', '--file', tmp, '--json', ...extra]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The arguments to queue.mjs rank for a position from queueBoard.bulkPlan ({ top } | { bottom } | { over: id } | …). */
function spaceArgs(space) {
  if (space.top) return ['--top'];
  if (space.bottom) return ['--bottom'];
  if (space.over) return ['--over', space.over];
  return ['--under', space.under];
}

/** The error text from a failed queue.mjs call (the JSON errors first, otherwise stderr/stdout). */
const errorText = (r, standard) =>
  (Array.isArray(r.data?.error) && r.data.error.length ? r.data.error.join('\n') : '') ||
  r.error ||
  r.out ||
  standard;

/**
 * The guard rules (queueBoard.assess) before a write action. Returns { stop: { status, answer } } when the action is not to
 * be done yet (422 stop, 409 warning without `confirm: true`), otherwise { info: [text] } which is sent with the response.
 */
function guard(queue, action, context, b) {
  const list = T.assess(queue, action, { now: Date.now(), ...context });
  const texts = (level) => list.filter((v) => v.level === level).map((v) => v.text);
  if (texts('stop').length)
    return {
      stop: {
        status: 422,
        answer: { ok: false, guard: list, message: texts('stop').join('\n') },
      },
    };
  if (texts('warning').length && b.confirm !== true)
    return {
      stop: {
        status: 409,
        answer: { ok: false, confirm: true, guard: list, message: texts('warning').join('\n') },
      },
    };
  return { info: texts('info') };
}

/** Does this value weaken the row's guard against both the default and the value now (lib/settingsView.js needsConfirm)? */
function needsWeakenConfirm(row, value, queue) {
  const config = KK.config({ fresh: true }); // the CLI writes the file, so the file is what counts
  const mode = config.mode === 'lite' ? 'lite' : 'full';
  return SV.needsConfirm(row, value, {
    now: SV.valueOf(row, { config, queue }),
    standard: SV.standardOf(row, { config, mode }),
  });
}

/**
 * The server half of the weakening rule: a value that weakens a guard is refused with 422 and the row's warning texts
 * (protects, whyNot, changes) unless the body carries confirm: 'weaken'. The board's dialog shows the same texts and only
 * its completed slide sends that confirm, so a script or a stale page cannot switch a guard off with one request.
 * Returns the refusal { status, answer } or null.
 */
function weakenCheck(row, value, queue, b) {
  if (!row || !needsWeakenConfirm(row, value, queue) || b?.confirm === 'weaken') return null;
  return {
    status: 422,
    answer: {
      ok: false,
      weaken: true,
      key: row.key,
      title: row.title,
      message: `This weakens a guard (${row.key} ${SV.valueText(row, value)}). Nothing was changed.`,
      protects: row.protects,
      whyNot: row.whyNot,
      changes: row.changes,
      storeText: SV.STORE_TEXT[row.store],
    },
  };
}

/** The handlers bound to the server's context (queue-board.mjs builds ctx once and calls them with the old arguments). */
export function writeTools(ctx) {
  return {
    queueMjs: (...args) => queueMjs(ctx, ...args),
    tmpDir: (...args) => tmpDir(ctx, ...args),
    oneAtATime,
    editMany: (...args) => editMany(ctx, ...args),
    queueJson: (...args) => queueJson(ctx, ...args),
    editManyJson: (...args) => editManyJson(ctx, ...args),
    guard,
    needsWeakenConfirm,
    weakenCheck,
  };
}

export { ID, PID, idOrNull, pidOrNull, cleanText, spaceArgs, errorText };
