// =============================================================
// queue-board/api/plans.mjs: the Plans room reads and the register writes.
//
// The Plans room reads and the register writes: GET /api/plans (with the wait=1 live update), /api/plan-search,
// /api/doc and /api/plan-check (with its cache); POST /api/plan-prioritize (the priority map), /api/plan-new and
// /api/plan-source (the Unregistered box). planWriteAnswer and expectValid are shared with planEdits.mjs.
//
// Moved out of queue-board.mjs unchanged (SPLIT-1). A handler that needs the server takes its context `ctx` first:
// the live paths and caches as getters (demo mode switches them), the data builders and the write plumbing
// (writeTools.mjs). A POST handler also gets `c`, the per-call tools write() builds (no, run, queueNow, info).
// planRoutes(ctx) binds them, so queue-board.mjs calls them with the old arguments.
//
// Used by: queue-board.mjs (write(), the GET routes, resetCaches) and queue-board/api/planEdits.mjs.
// Tested in: lib/__tests__/queuePlan.test.ts (reads planPrioritize from this file), queuePlanMap.test.ts, queuePlanRead.test.ts and queuePlanView.test.ts.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { errorText } from './writeTools.mjs';

const require = createRequire(import.meta.url);
const P = require('../../lib/queuePlan.js');
const PRIVACY = require('../../lib/queuePlanView.js');
const T = require('../../lib/queueBoard.js');

/**
 * Turns the `queue.mjs plan prioritize` calls from queuePlanView.prioritizeCall (which has checked and cleaned the groups) into
 * the list `plan prioritize-many --file` takes: [{ id, priority, category?, reason? }]. The arguments are
 * ['plan', 'prioritize', ...ids, priority, --category k, --reason g, …flag].
 */
function prioritizeList(call) {
  const out = [];
  for (const args of call) {
    const first = args.findIndex((x, i) => i >= 2 && String(x).startsWith('--'));
    const end = first < 0 ? args.length : first;
    const priority = args[end - 1];
    const after = (flag) => {
      const k = args.indexOf(flag, end);
      return k < 0 ? null : args[k + 1];
    };
    const category = after('--category');
    const reason = after('--reason');
    for (const id of args.slice(2, end - 1))
      out.push({
        id,
        priority,
        ...(category ? { category: [category] } : {}),
        ...(reason ? { reason } : {}),
      });
  }
  return out;
}

/**
 * "Save the priorities" from the priority map. The body: { groups: [{ priority, category[],
 * reason, ids[] }], dry, expect }. queuePlanView.prioritizeCall checks the groups; the whole draft then goes in ONE
 * `queue.mjs plan prioritize-many --file` call (--set-by owner: the owner sits at the board), under one lock and with one
 * changelog entry, so one save is one undo. All or nothing is done by queue.mjs.
 *   dry: true → the call with --dry (writes nothing): the changes, the warnings, the errors and the plan register's version
 *                `changed` (which the preview sends back as `expect`).
 *   otherwise  → the call with --expect-changed <expect>, so another session that has changed the register meanwhile stops
 *                the save (409 outdated).
 */
async function planPrioritize(ctx, b) {
  const { queueJson, tmpDir } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const { error, call } = PRIVACY.prioritizeCall(b.groups);
  if (error.length) return no(error.join('\n'));
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const list = prioritizeList(call);
  const tmp = path.join(tmpDir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(list));
  let r;
  try {
    r = await queueJson([
      'plan',
      'prioritize-many',
      '--file',
      tmp,
      '--set-by',
      'owner',
      '--by',
      'theBoard',
      '--json',
      ...(b.dry === true ? ['--dry'] : expectValue ? ['--expect-changed', expectValue] : []),
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (b.dry === true) {
    const ok = r.data?.ok === true;
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        changed: ok ? (r.data.changed ?? null) : null,
        changes: ok ? (r.data.changes ?? []) : [],
        warnings: ok ? (r.data.warnings ?? []) : (r.data?.warnings ?? []),
        error: ok ? [] : [errorText(r, 'ravenseat plan prioritize-many failed')],
        can: ok,
      },
    };
  }

  const log = (ok) =>
    console.log(`${new Date().toLocaleTimeString('en-GB')} plan prioritize-many (the map): ${ok}`);
  if (!(r.ok && r.data?.ok === true)) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    log('failed');
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The plan register has changed since the preview. Review the draft again.'
          : errorText(r, 'ravenseat plan prioritize-many failed'),
      },
    };
  }
  log(`ok (${list.length} entries)`);
  return {
    status: 200,
    answer: {
      ok: true,
      message: 'The priorities are saved (one change in the changelog).',
      log: r.data.log != null ? [r.data.log] : [],
    },
  };
}

// ---- The Unregistered box -----------------------------------------------------------------------
// Both writes go via queue.mjs (same lock, atomic write, changelog and `plan undo`) with the owner option
// (--set-by owner, --by theBoard). dry = preview (--dry); otherwise --expect-changed <expect> from
// the preview, so a session that has changed the register meanwhile gives 409 with outdated: true.
const expectValid = (x) => x == null || Number.isFinite(Date.parse(String(x)));
function planWriteAnswer(r, what, okText) {
  const clock = new Date().toLocaleTimeString('en-GB');
  if (r.ok && r.data?.ok === true) {
    if (!r.data.dry) console.log(`${clock} ${what}: ok`);
    return {
      status: 200,
      answer: {
        ok: true,
        dry: r.data.dry === true,
        changes: r.data.changes ?? [],
        warnings: r.data.warnings ?? [],
        changed: r.data.changed ?? null,
        log: r.data.log ?? null,
        message: r.data.dry ? null : okText,
      },
    };
  }
  const outdated = r.code === 6 || r.data?.outdated === true;
  console.log(`${clock} ${what}: failed`);
  return {
    status: outdated ? 409 : 400,
    answer: {
      ok: false,
      outdated,
      warnings: r.data?.warnings ?? [],
      message: outdated
        ? 'The plan register has changed since the preview. Review and preview again.'
        : errorText(r, `queue.mjs ${what} failed`),
    },
  };
}

async function planNew(ctx, b) {
  const { queueJson, tmpDir } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  if (!expectValid(b.expect)) return no('invalid expect');
  const { entry, error } = PRIVACY.newEntryFromForm(b.form, b.path);
  if (error.length) return no(error.join('\n'));
  const tmp = path.join(tmpDir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(entry));
  try {
    const r = await queueJson(PRIVACY.newEntryArgs(tmp, { dry: b.dry === true, expect: b.expect }));
    return planWriteAnswer(r, `plan new ${entry.id}`, `New plan entry ${entry.id} with the source ${b.path}.`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function planSource(ctx, b) {
  const { queueJson } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  if (!expectValid(b.expect)) return no('invalid expect');
  const id = String(b.id ?? '');
  if (!/^PL-[A-Za-z0-9\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5-]{1,60}$/.test(id)) return no('invalid plan entry');
  // The sources are read from plans.json now; queue.mjs refuses (exit 6) if the register has changed after the preview.
  const reg = fs.existsSync(ctx.PLAN_FILE)
    ? P.normalize(JSON.parse(fs.readFileSync(ctx.PLAN_FILE, 'utf8')))
    : P.emptyRegister();
  const entry = (reg.entries ?? []).find((p) => p.id === id);
  if (!entry) return no(`unknown plan entry ${id}`);
  const { sources, error } = PRIVACY.sourceBonus(entry, b.path, b.anchor);
  if (error.length) return no(error.join('\n'));
  const r = await queueJson(PRIVACY.sourceArgs(id, sources, { dry: b.dry === true, expect: b.expect }));
  return planWriteAnswer(r, `plan edit ${id} (source)`, `${b.path} is added as a source on ${id}.`);
}

// Unregistered documents (= `queue.mjs plan check --json`, read only). The check reads documents and git, so the response
// is cached until plans.json changes or two minutes have passed.
let checkCache = null;
async function planCheck(ctx) {
  const { queueJson } = ctx;
  let mt = 0;
  try {
    mt = fs.statSync(ctx.PLAN_FILE).mtimeMs;
  } catch {
    mt = 0;
  }
  const key = `${mt}|${Math.floor(Date.now() / 120_000)}`;
  if (checkCache?.key === key) return checkCache.answer;
  const r = await queueJson(['plan', 'check', '--json']);
  if (!(r.ok && r.data?.ok === true))
    return { ok: false, message: errorText(r, 'ravenseat plan check failed') };
  const unregistered = (r.data.unregistered ?? []).filter((s) => typeof s === 'string');
  const answer = { ok: true, unregistered, groups: PRIVACY.unregisteredGroups(unregistered) };
  checkCache = { key, answer };
  return answer;
}

// The Plans space (read only). "unchanged" when nothing is new since the version the client has.
async function getPlans(ctx, req, res, url) {
  const { json, plans, waitOnPlans } = ctx;
  try {
    let pl = plans();
    // Wait=1 holds the response until something has changed (live update).
    if (
      url.searchParams.get('wait') === '1' &&
      url.searchParams.get('version') === pl.version
    ) {
      await waitOnPlans(res);
      if (res.destroyed || res.writableEnded) return;
      pl = plans();
    }
    if (url.searchParams.get('version') === pl.version)
      return json(res, 200, { version: pl.version, unchanged: true });
    return json(res, 200, { version: pl.version, data: pl.data });
  } catch (e) {
    return json(res, 503, {
      ok: false,
      message: `Could not read the plan register (${e?.code ?? e?.message ?? 'unknown error'}).`,
    });
  }
}

// P5: the plans whose plan document contains the search, with the matching sentence (read only). Only the plan
// source of each entry (the document folders), through the /api/doc guard; nothing is read while the Plans room or
// plans.searchDocuments is off. The search text is never logged and never part of an error message.
function getPlanSearch(ctx, req, res, url) {
  const { FEATURES, json, plans } = ctx;
  try {
    const pl = plans();
    if (!FEATURES.plans || pl.data.view?.searchDocuments === false)
      return json(res, 200, { ok: true, enabled: false, hits: [], partial: false });
    const r = ctx.planSearch(pl.data.entries ?? [], String(url.searchParams.get('q') ?? '').slice(0, 120));
    return json(res, 200, { ok: true, enabled: true, version: pl.version, ...r });
  } catch (e) {
    return json(res, 503, {
      ok: false,
      message: `Could not search the plan documents (${e?.code ?? 'unknown error'}).`,
    });
  }
}

// One markdown document for the reading view (read only; the path guard is queueBoard.readDocument).
function getDoc(ctx, req, res, url) {
  const { json } = ctx;
  const r = T.readDocument(ctx.SOURCE_ROOT, url.searchParams.get('path'), { fs, path });
  if (!r.ok) return json(res, r.status, { ok: false, message: r.message });
  return json(res, 200, r);
}

// The Unregistered box (= queue.mjs plan check --json, only the unregistered documents).
async function getPlanCheck(ctx, req, res, url) {
  const { json } = ctx;
  const r = await planCheck(ctx);
  return json(res, r.ok ? 200 : 503, r);
}

/** resetCaches in queue-board.mjs (demo mode on or off): the plans.json behind the cache has changed. */
function resetPlanCheck() {
  checkCache = null;
}

/** The handlers bound to the server's context (queue-board.mjs builds ctx once and calls them with the old arguments). */
export function planRoutes(ctx) {
  return {
    planPrioritize: (...args) => planPrioritize(ctx, ...args),
    planNew: (...args) => planNew(ctx, ...args),
    planSource: (...args) => planSource(ctx, ...args),
    getPlans: (...args) => getPlans(ctx, ...args),
    getPlanSearch: (...args) => getPlanSearch(ctx, ...args),
    getDoc: (...args) => getDoc(ctx, ...args),
    getPlanCheck: (...args) => getPlanCheck(ctx, ...args),
  };
}

export { planWriteAnswer, expectValid, resetPlanCheck };
