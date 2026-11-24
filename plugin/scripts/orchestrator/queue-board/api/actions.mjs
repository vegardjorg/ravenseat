// =============================================================
// queue-board/api/actions.mjs: the card and inbox actions and the cloud reads.
//
// POST /api/action: the card and inbox actions (pause, continue, resolve, QA ok, approve, pick, release, the batch
// queue, the cloud actions, the board switches, requeue and flag-stuck), and the cloud reads GET /api/cloudPackage
// and /api/cloud-bundles.
//
// Moved out of queue-board.mjs unchanged (SPLIT-1). A handler that needs the server takes its context `ctx` first:
// the live paths and caches as getters (demo mode switches them), the data builders and the write plumbing
// (writeTools.mjs). A POST handler also gets `c`, the per-call tools write() builds (no, run, queueNow, info).
// actionRoutes(ctx) binds them, so queue-board.mjs calls them with the old arguments.
//
// Used by: queue-board.mjs (write() and the GET routes).
// Tested in: lib/__tests__/queueBoardServe.test.ts, __tests__/redteam/rt23-board-guard.test.ts, __tests__/approvalLive.test.ts and the other board tests that start the server.
// =============================================================
import { createRequire } from 'node:module';
import { idOrNull, pidOrNull, cleanText } from './writeTools.mjs';

const require = createRequire(import.meta.url);
const CATALOG = require('../../lib/catalog.js');
const DEC = require('../../lib/queueDecisions.js');
const KK = require('../../lib/queueConfig.js');
const L = require('../../lib/queueLogic.js');
const R = require('../../lib/settingsRegistry.js');
const SV = require('../../lib/settingsView.js');

/** POST /api/action. */
function action(ctx, b, c) {
  const { no, queueNow, run } = c;
  const { BRANCH_PATTERN, BRANCH_PREFIX, branchFor, branchInfo, editMany, guard, needsWeakenConfirm, readJson, weakenCheck } = ctx;
  const type = String(b.type ?? '');
  if (type === 'pause' || type === 'continue') {
    const pid = pidOrNull(b.pid);
    if (!pid) return no('invalid project id');
    const v = guard(queueNow(), { type, pid }, {}, b);
    if (v.stop) return v.stop;
    c.info = v.info;
    return run(['project', pid, `--${type}`], `${type} ${pid}`);
  }
  // An answer to an owner question ("Waiting on you"). The answer is required (guard rule 15); the id must exist in
  // the queue (a task waits on it, or it is registered in `question`), so the board never resolves something unknown.
  if (type === 'resolve') {
    const queue = queueNow();
    const sp = String(b.sp ?? '');
    const known =
      L.validQuestionId(sp) &&
      (Object.hasOwn(queue.question ?? {}, sp) ||
        (queue.tasks ?? []).some((o) => (o.waiting_on ?? []).includes(sp)));
    if (!known) return no('unknown question');
    const answer = cleanText(b.answer, 4000);
    // "Keep as design choice" (roadmap 0z Z-A): resolve --keep, only while catalog.captureAnswers is not off (read
    // fresh, as the state is). queue.mjs checks the setting again and writes only a proposed draft.
    const keep = b.keep === true ? ['--keep'] : [];
    if (keep.length && CATALOG.setupOf(KK.config({ fresh: true })).captureAnswers === 'off')
      return no('catalog.captureAnswers is off: the answer is not kept as a design choice');
    // A choice button ({ choice: <1-based number> }): the server checks that the question has that choice, and
    // queue.mjs resolve --choice stores the choice's text (with the free text field as a note, when filled in).
    if (b.choice != null) {
      const n = Number(b.choice);
      const choices = queue.question?.[sp]?.choices;
      if (!Number.isInteger(n) || !Array.isArray(choices) || n < 1 || n > choices.length)
        return no('unknown choice');
      const v = guard(queue, { type, sp, text: choices[n - 1] }, {}, b);
      if (v.stop) return v.stop;
      c.info = v.info;
      return run(
        ['resolve', sp, '--choice', String(n), ...(answer ? ['--answer', answer] : []), ...keep, '--by', 'owner'],
        `resolve ${sp} (choice ${n})`,
      );
    }
    const v = guard(queue, { type, sp, text: answer }, {}, b);
    if (v.stop) return v.stop;
    c.info = v.info;
    return run(['resolve', sp, '--answer', answer, ...keep, '--by', 'owner'], `resolve ${sp}`);
  }
  // QA ok and approve for several at once (queue.mjs takes lists; all or nothing).
  if ((type === 'qa-ok' || type === 'approve') && Array.isArray(b.ids)) {
    const ids = b.ids.map(idOrNull);
    if (!ids.length || ids.length > 500 || ids.some((x) => !x)) return no('invalid id list');
    // --by owner, as resolve: the actor is the same whether the owner answers here or with /ravenseat:decide.
    const args = type === 'qa-ok' ? ['qa', 'ok', ...ids, '--by', 'owner'] : ['approve', ...ids, '--by', 'owner'];
    return run(args, `${type} ${ids.length === 1 ? ids[0] : `${ids.length} tasks`}`);
  }
  // "Started in cloud" for a bundle (the chosen cards) goes in one queue.mjs call (all or nothing).
  if (type === 'cloud-start' && Array.isArray(b.ids)) {
    const ids = b.ids.map(idOrNull);
    if (!ids.length || ids.length > 10 || ids.some((x) => !x)) return no('invalid id list');
    return run(['cloud', 'start', ...ids], `cloud start ${ids.join(' ')}`);
  }
  // The batch queue from the panel. "Add to batch queue" and "Take out of batch queue" go via edit-many (same rules
  // as add/edit, queueLogic.batchedError; all or nothing; the changelog makes them undoable), "Pack" via
  // queue.mjs batch pack (same class, never D+, same owner question). `expect` = the queue's `changed` from the preview:
  // queue.mjs refuses (409) when the queue has changed since.
  if ((type === 'batch-in' || type === 'batch-out') && Array.isArray(b.ids)) {
    const ids = b.ids.map(idOrNull);
    if (!ids.length || ids.length > 500 || ids.some((x) => !x)) return no('invalid id list');
    const expectValue = b.expect == null ? null : String(b.expect);
    if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
    return editMany(
      { tasks: ids.map((x) => ({ id: x, batched: type === 'batch-in' })) },
      run,
      `${type} ${ids.length === 1 ? ids[0] : `${ids.length} tasks`}`,
      ['--by', 'theBoard', ...(expectValue ? ['--expect-changed', expectValue] : [])],
    );
  }
  if (type === 'batch-pack' && Array.isArray(b.ids)) {
    const ids = b.ids.map(idOrNull);
    const newId = idOrNull(b.new_id);
    if (ids.length < 2 || ids.length > 50 || ids.some((x) => !x))
      return no('invalid id list');
    if (!newId) return no('invalid new id');
    const title = cleanText(b.title, 200);
    return run(
      ['batch', 'pack', ...ids, '--id', newId, ...(title ? ['--title', title] : [])],
      `batch pack ${ids.join(' ')} → ${newId}`,
    );
  }
  // The gear's switches: the same `ravenseat board-setting cloud|blocked on|off` Claude Code runs (queue.json board.showCloud
  // and board.blockedColumn).
  // The gear's Cloud section: the same commands Claude Code runs. cloud set checks the value.
  if (type === 'cloud-switch') {
    if (typeof b.on !== 'boolean') return no('invalid cloud switch');
    return run(['cloud', b.on ? 'on' : 'off'], `cloud ${b.on ? 'on' : 'off'}`);
  }
  if (type === 'cloud-setting') {
    const key = cleanText(b.key, 40);
    const value = cleanText(String(b.value ?? ''), 40);
    if (!key || !value) return no('invalid cloud setting');
    // The weakening rule, as in /api/setting: collect auto weakens a guard (owner decision 2026-11-12), so it is refused
    // with 422 and the row's texts until the dialog's yes; then the owner's flags go to the CLI, which logs the row.
    // A key or value the registry does not know goes to cloud set unchanged, which refuses it with its own message.
    const row = R.rowFor(`cloud.${key}`);
    const p = row ? SV.parseValue(row, value, {}) : null;
    if (row && p && !('error' in p)) {
      const queue = queueNow();
      const w = weakenCheck(row, p.value, queue, b);
      if (w) return w;
      if (b.confirm === 'weaken' && needsWeakenConfirm(row, p.value, queue))
        return run(['cloud', 'set', key, value, '--i-understand', '--by', 'owner'], `cloud set ${key} ${value} (weakened, confirmed)`);
    }
    return run(['cloud', 'set', key, value], `cloud set ${key} ${value}`);
  }
  // The board switches the gear can set, and the word `ravenseat board-setting` takes for each. Any other name is refused.
  if (type === 'board-switch') {
    const word = { showCloud: 'cloud', blockedColumn: 'blocked' }[b.name];
    if (typeof b.name !== 'string' || !Object.hasOwn(KK.BOARD_SWITCHES, b.name) || !word || typeof b.on !== 'boolean')
      return no('invalid board switch');
    return run(['board-setting', word, b.on ? 'on' : 'off'], `board-setting ${word} ${b.on ? 'on' : 'off'}`);
  }
  const id = idOrNull(b.id);
  if (!id) return no('invalid id');
  // "Started in cloud", "Completed in cloud" and "Cancel cloud" go via queue.mjs cloud … (the suitability, the git check of
  // the branch and the limit on cloud sessions are there).
  if (type === 'cloud-start') {
    const execution = cleanText(b.execution, 300);
    if (execution && /\s/.test(execution)) return no('the link or session id cannot contain whitespace');
    return run(
      ['cloud', 'start', id, ...(execution ? ['--run', execution] : [])],
      `cloud start ${id}`,
    );
  }
  if (type === 'cloud-done') {
    const branch = cleanText(b.branch, 100);
    if (branch && (!BRANCH_PATTERN.test(branch) || branch.includes('..'))) return no('invalid branch name');
    return run(['cloud', 'done', id, ...(branch ? ['--branch', branch] : [])], `cloud done ${id}`);
  }
  if (type === 'cloud-cancel') return run(['cloud', 'cancel', id], `cloud cancel ${id}`);
  // "Flag for the orchestrator" on stuck work in the Decisions view: a blocker reason (ravenseat block <id> other) with a
  // fixed note, the same command /ravenseat:decide runs (lib/queueDecisions.js cliArgs). Never over an open blocker.
  if (type === 'requeue') return run(['set', id, 'waiting'], `set ${id} waiting (started without an agent)`);
  if (type === 'flag-stuck') {
    const o = (queueNow().tasks ?? []).find((x) => x.id === id);
    if (!o) return no(`unknown task ${id}`);
    if (L.openBlockOf(o)) return no(`${id} already has an open blocker (${L.openBlockOf(o).code})`);
    return run(['block', id, 'other', '--note', DEC.FLAG_NOTE], `block ${id} other (flagged stuck)`);
  }
  // The context the guard rules need: the orchestrator cursor (pick) and commits on the branch (release).
  const queue = queueNow();
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  const context = {};
  if (type === 'pick') context.orchestrator = L.orchestratorStatus(readJson(ctx.CURSOR));
  if (type === 'release' && o) {
    const branch = branchFor(o);
    context.branches = { [branch]: branchInfo(branch) };
    context.branchPrefix = BRANCH_PREFIX;
  }
  const v = guard(queue, { type, id, text: b.text }, context, b);
  if (v.stop) return v.stop;
  c.info = v.info;
  if (type === 'pick') {
    const by = cleanText(b.by, 60);
    if (!by) return no('write who is picking');
    return run(['pick', id, '--by', by], `pick ${id}`);
  }
  if (type === 'release') return run(['release', id], `release ${id}`);
  if (type === 'qa-ok') return run(['qa', 'ok', id, '--by', 'owner'], `qa ok ${id}`);
  if (type === 'approve') return run(['approve', id, '--by', 'owner'], `approve ${id}`);
  if (type === 'track-answer') {
    const text = cleanText(b.text, 2000);
    if (!text) return no('write your answer');
    return run(['resume', id, '--reason', 'context', '--answer', text, '--by', 'owner'], `resume ${id} with the owner's answer`);
  }
  if (type === 'qa-deviation') {
    const text = cleanText(b.text, 2000);
    if (!text) return no('write what is wrong, and where');
    return run(['qa', 'deviation', id, text, '--by', 'owner'], `qa deviation ${id}`);
  }
  return no(`unknown action ${type}`);
}

// The cloud package ("Copy cloud package"), made by queue.mjs cloud-package (which refuses when the task is not suitable).
// Several ids (?id=A&id=B) = a bundle in one cloud session; the cap (4 tasks, about 120 min) is enforced by queue.mjs.
async function getCloudPackage(ctx, req, res, url) {
  const { json, queueMjs } = ctx;
  const ids = url.searchParams.getAll('id').map(idOrNull);
  if (!ids.length || ids.length > 10 || ids.some((x) => !x))
    return json(res, 400, { ok: false, message: 'invalid id' });
  const r = await queueMjs(['cloud-package', ...ids]);
  if (!r.ok) return json(res, 409, { ok: false, message: r.error || 'ravenseat cloud-package failed' });
  return json(res, 200, { ok: true, text: r.out });
}

// The "Cloud" view: proposed bundles with a ready cloud start command (= `queue.mjs cloud-bundles --json`).
async function getCloudBundles(ctx, req, res, url) {
  const { json, queueMjs } = ctx;
  const r = await queueMjs(['cloud-bundles', '--json']);
  if (!r.ok)
    return json(res, 500, { ok: false, message: r.error || 'ravenseat cloud-bundles failed' });
  try {
    return json(res, 200, { ok: true, data: JSON.parse(r.out) });
  } catch {
    return json(res, 500, { ok: false, message: 'invalid response from ravenseat cloud-bundles' });
  }
}

/** The handlers bound to the server's context (queue-board.mjs builds ctx once and calls them with the old arguments). */
export function actionRoutes(ctx) {
  return {
    action: (...args) => action(ctx, ...args),
    getCloudPackage: (...args) => getCloudPackage(ctx, ...args),
    getCloudBundles: (...args) => getCloudBundles(ctx, ...args),
  };
}
